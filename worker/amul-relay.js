/**
 * Amul stock relay — Cloudflare Worker.
 *
 * WHY THIS EXISTS
 * ---------------
 * shop.amul.com serves different HTML depending on User-Agent. A browser UA
 * gets a ~4 KB bootstrap page carrying the inline `serverTimestamp` and
 * `token` needed to sign StoreHippo's mandatory `tid` header. A bot-shaped UA
 * gets a ~157 KB prerendered SEO page with no inline JS and no token.
 *
 * Google Apps Script hard-strips custom User-Agent headers and always sends
 * "Mozilla/5.0 (compatible; Google-Apps-Script; beanserver; ...)", so it can
 * only ever receive the token-less variant — and the API returns 401 without
 * a valid tid. This Worker makes that one request with a real browser UA.
 *
 * ENDPOINTS
 * ---------
 *   GET /session
 *       -> { serverTimestamp, token, cookie }
 *       Apps Script then makes the pincode/substore/product calls itself.
 *
 *   GET /stock?pincodes=380060,380013
 *       -> { results: [...], errors: [...] }
 *       Performs the entire check here instead. Use this if /session fails
 *       from Apps Script because StoreHippo binds the session to the IP that
 *       created it.
 *
 * AUTH
 * ----
 * Both endpoints require the shared secret, sent as an `x-relay-key` header
 * or a `?key=` query param, so this is not left open as a public proxy.
 * Set it with:  wrangler secret put RELAY_KEY
 */

const ORIGIN = 'https://shop.amul.com';
const BROWSE = ORIGIN + '/en/browse/protein';
const STORE_ID = '62fa94df8c13af2e242eba16';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const PRODUCTS = [
  { slug: 'amul-whey-protein-32-g-or-pack-of-30-sachets',
    name: 'Whey Protein Unflavoured, 960 g (30 sachets)' },
  { slug: 'amul-whey-protein-32-g-or-pack-of-60-sachets',
    name: 'Whey Protein Unflavoured, 1.92 kg (60 sachets)' },
  { slug: 'amul-chocolate-whey-protein-34-g-or-pack-of-30-sachets',
    name: 'Chocolate Whey Protein, 1.02 kg (30 sachets)' },
  { slug: 'amul-chocolate-whey-protein-34-g-or-pack-of-60-sachets',
    name: 'Chocolate Whey Protein, 2.04 kg (60 sachets)' }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.RELAY_KEY) {
      return json({ error: 'RELAY_KEY secret is not configured on this Worker' }, 500);
    }
    const supplied = request.headers.get('x-relay-key') || url.searchParams.get('key') || '';
    if (!safeEqual(supplied, env.RELAY_KEY)) {
      return json({ error: 'unauthorized' }, 401);
    }

    try {
      if (url.pathname === '/session') {
        return json(await openSession());
      }
      if (url.pathname === '/stock') {
        const pincodes = (url.searchParams.get('pincodes') || '')
          .split(/[,\s]+/).filter(Boolean);
        if (!pincodes.length) {
          return json({ error: 'pincodes query param required' }, 400);
        }
        return json(await checkStock(pincodes));
      }
      return json({ error: 'not found', endpoints: ['/session', '/stock'] }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 502);
    }
  }
};

/** Step 1: the whole reason this Worker exists. */
async function openSession() {
  const res = await fetch(BROWSE, {
    headers: {
      'User-Agent': CHROME_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    },
    redirect: 'follow',
    // Tokens are per-session and short-lived; never serve a cached one.
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  const html = await res.text();
  const ts = html.match(/serverTimestamp\s*=\s*"([^"]*)"/);
  const token = html.match(/token\s*=\s*"([^"]*)"/);

  if (!ts || !token) {
    throw new Error(
      `bootstrap parse failed (HTTP ${res.status}, ${html.length} bytes) — ` +
      `Amul likely changed the page or served the prerendered variant`);
  }

  return {
    serverTimestamp: ts[1],
    token: token[1],
    cookie: cookieHeader(collectCookies(res))
  };
}

/** Full per-pincode check, run entirely here. Mirrors check_stock.sh. */
async function checkStock(pincodes) {
  const results = [];
  const errors = [];

  for (const pincode of pincodes) {
    try {
      // A fresh session per pincode: the substore is bound to the session,
      // so reusing one would cross-contaminate results.
      const session = await openSession();
      const substore = await resolveSubstore(session, pincode);
      await setSubstore(session, substore);

      const products = [];
      for (const product of PRODUCTS) {
        try {
          products.push({
            slug: product.slug,
            name: product.name,
            available: await productAvailable(session, product.slug)
          });
        } catch (e) {
          errors.push(`${product.name} @ ${pincode}: ${e.message}`);
        }
      }
      results.push({ pincode, substore, products });
    } catch (e) {
      errors.push(`pincode ${pincode}: ${e.message}`);
    }
  }

  return { results, errors, checkedAt: new Date().toISOString() };
}

async function resolveSubstore(session, pincode) {
  const filters = JSON.stringify([
    { field: 'pincode', value: pincode, operator: 'regex' }
  ]);
  const body = await apiJson(session,
    `${ORIGIN}/api/1.1/entity/pincode?filters=${encodeURIComponent(filters)}&limit=10`,
    {}, 'pincode lookup');

  const substore = body.data && body.data[0] && body.data[0].substore;
  if (!substore) throw new Error(`pincode ${pincode} maps to no active substore`);
  return substore;
}

async function setSubstore(session, substore) {
  await apiJson(session, `${ORIGIN}/api/1.1/entity/ms.settings/_/setPreferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ store: substore })
  }, 'setPreferences');
}

async function productAvailable(session, slug) {
  const body = await apiJson(session,
    `${ORIGIN}/api/1.1/entity/ms.products?q=${encodeURIComponent(JSON.stringify({ alias: slug }))}`,
    {}, 'product lookup');

  // An empty data array means the session has no substore context — that is a
  // broken check, not an out-of-stock signal, so surface it rather than
  // reporting a false "out".
  if (!body.data || !body.data.length) {
    throw new Error(`no product record for ${slug} (session/substore not applied?)`);
  }
  const available = body.data[0].available;
  return available === 1 || available === true || available === '1';
}

/** Signed StoreHippo API call. */
async function apiJson(session, url, init, label) {
  const res = await fetch(url, {
    method: init.method || 'GET',
    headers: {
      ...(init.headers || {}),
      'User-Agent': CHROME_UA,
      'Cookie': session.cookie,
      'tid': await generateTid(session),
      'frontend': '1',
      'base_url': BROWSE,
      'Referer': BROWSE,
      'Origin': ORIGIN,
      'Accept': 'application/json, text/plain, */*'
    },
    body: init.body,
    redirect: 'follow',
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`${label} returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * tid = serverTimestamp:rand:sha256hex(STORE_ID:serverTimestamp:rand:token)
 * Matches the algorithm documented in FINDINGS.md.
 */
async function generateTid(session) {
  const rand = Math.floor(Math.random() * 900) + 100;
  const raw = `${STORE_ID}:${session.serverTimestamp}:${rand}:${session.token}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `${session.serverTimestamp}:${rand}:${hex}`;
}

/** Collects Set-Cookie regardless of how the runtime exposes duplicates. */
function collectCookies(res) {
  const jar = {};
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);

  for (const entry of raw) {
    const pair = String(entry).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.keys(jar).map(n => `${n}=${jar[n]}`).join('; ');
}

/** Length-safe comparison so the secret isn't trivially probed by timing. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
