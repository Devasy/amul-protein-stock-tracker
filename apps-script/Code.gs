/**
 * Amul Protein Stock Tracker — Google Apps Script edition.
 *
 * Polls shop.amul.com (StoreHippo) for per-pincode availability of Amul whey
 * protein products and emails you the moment something flips to in-stock.
 *
 * WHY A RELAY IS REQUIRED
 * -----------------------
 * StoreHippo signs every /api/1.1/* call with a `tid` header derived from a
 * `serverTimestamp` and `token` that appear only in the browser bootstrap
 * HTML. shop.amul.com serves that bootstrap only to browser User-Agents; a
 * bot-shaped UA gets a prerendered SEO page with no token, and the API
 * answers 401 without a valid tid.
 *
 * Apps Script silently strips custom User-Agent headers and always identifies
 * itself as "Google-Apps-Script", so it can never obtain the token directly.
 * A small Cloudflare Worker (see worker/amul-relay.js) makes that one request
 * with a real browser UA. Everything else runs here.
 *
 * The API itself does NOT care about User-Agent — only the tid signature and
 * session cookie — which is why relaying just the handshake is enough.
 *
 * SETUP
 * -----
 *   1. Deploy worker/amul-relay.js and note its URL + RELAY_KEY secret.
 *   2. Run setup() here, approve the OAuth prompt.
 *   3. Put the Worker URL and key into Script Properties (setup() prints the
 *      exact names if they are missing).
 *   4. Run testRelay(), then dryRun(), then let the trigger take over.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var PRODUCTS = [
  {
    slug: 'amul-whey-protein-32-g-or-pack-of-30-sachets',
    name: 'Whey Protein Unflavoured, 960 g (30 sachets)'
  },
  {
    slug: 'amul-whey-protein-32-g-or-pack-of-60-sachets',
    name: 'Whey Protein Unflavoured, 1.92 kg (60 sachets)'
  },
  {
    slug: 'amul-chocolate-whey-protein-34-g-or-pack-of-30-sachets',
    name: 'Chocolate Whey Protein, 1.02 kg (30 sachets)'
  },
  {
    slug: 'amul-chocolate-whey-protein-34-g-or-pack-of-60-sachets',
    name: 'Chocolate Whey Protein, 2.04 kg (60 sachets)'
  }
];

var STORE_ID = '62fa94df8c13af2e242eba16';
var ORIGIN = 'https://shop.amul.com';
var BASE_URL = ORIGIN + '/en/browse/protein';
var PRODUCT_URL_PREFIX = ORIGIN + '/en/product/';

var TRIGGER_MINUTES = 15;
var MAX_REDIRECTS = 5;
var DEFAULT_PINCODES = '380060,380013';

// Script Property keys. Edit under Project Settings > Script Properties.
var PROP_PINCODES = 'AMUL_PINCODES';
var PROP_EMAIL = 'ALERT_EMAIL';
var PROP_RELAY_URL = 'RELAY_URL';
var PROP_RELAY_KEY = 'RELAY_KEY';
var PROP_RELAY_MODE = 'RELAY_MODE';
var STATE_PREFIX = 'state_';

/**
 * RELAY_MODE decides how much work the Worker does:
 *
 *   'session' (default) — Worker returns only the handshake; this script makes
 *                         the pincode, substore and product calls itself.
 *   'stock'             — Worker performs the whole check and returns results.
 *
 * Switch to 'stock' if 'session' fails with 401s or empty product data, which
 * would mean StoreHippo binds the session to the IP that created it.
 */
var DEFAULT_RELAY_MODE = 'session';

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Seeds Script Properties and installs the recurring trigger. Run once. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperties();

  if (!existing[PROP_PINCODES]) {
    props.setProperty(PROP_PINCODES, DEFAULT_PINCODES);
    console.log('Seeded %s = %s', PROP_PINCODES, DEFAULT_PINCODES);
  }
  if (!existing[PROP_RELAY_MODE]) {
    props.setProperty(PROP_RELAY_MODE, DEFAULT_RELAY_MODE);
    console.log('Seeded %s = %s', PROP_RELAY_MODE, DEFAULT_RELAY_MODE);
  }
  if (!existing[PROP_EMAIL]) {
    var me = Session.getActiveUser().getEmail();
    if (!me) {
      throw new Error('Could not determine your email. Set the ' + PROP_EMAIL +
                      ' script property manually.');
    }
    props.setProperty(PROP_EMAIL, me);
    console.log('Seeded %s = %s', PROP_EMAIL, me);
  }

  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkStock') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  ScriptApp.newTrigger('checkStock').timeBased()
    .everyMinutes(TRIGGER_MINUTES).create();

  console.log('Replaced %s old trigger(s); checkStock now runs every %s minutes.',
              removed, TRIGGER_MINUTES);

  if (!existing[PROP_RELAY_URL] || !existing[PROP_RELAY_KEY]) {
    console.warn('STILL REQUIRED: add these Script Properties before the first run:\n' +
                 '  %s = https://<your-worker>.workers.dev\n' +
                 '  %s = <the RELAY_KEY secret you set on the Worker>',
                 PROP_RELAY_URL, PROP_RELAY_KEY);
  }
}

/** The scheduled job. Emails on out -> in transitions, then records state. */
function checkStock() {
  run_(false);
}

/** Full live check that writes nothing and emails nobody. Safe to run anytime. */
function dryRun() {
  run_(true);
}

/** Confirms the Worker is reachable and returning a usable handshake. */
function testRelay() {
  var cfg = relayConfig_();
  var session = relaySession_(cfg);

  console.log('Relay OK.');
  console.log('  serverTimestamp: %s', session.serverTimestamp);
  console.log('  token: %s…', String(session.token).slice(0, 12));
  console.log('  cookies: %s', Object.keys(session.jar).join(', ') || '(none)');
  console.log('  sample tid: %s', generateTid_(session));
}

/** Forgets every recorded status, so the next run re-alerts on anything in stock. */
function resetState() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var cleared = 0;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(STATE_PREFIX) === 0) {
      props.deleteProperty(k);
      cleared++;
    }
  });
  console.log('Cleared %s stored status value(s).', cleared);
}

/** Logs what the tracker currently believes about each product. */
function showState() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var keys = Object.keys(all).filter(function (k) {
    return k.indexOf(STATE_PREFIX) === 0;
  }).sort();

  if (!keys.length) {
    console.log('No stored state yet.');
    return;
  }
  keys.forEach(function (k) {
    console.log('%s = %s', k.slice(STATE_PREFIX.length), all[k]);
  });
}

/** Removes the recurring trigger without touching stored state. */
function removeTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkStock') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  console.log('Removed %s trigger(s).', removed);
}

// ---------------------------------------------------------------------------
// Main routine
// ---------------------------------------------------------------------------

function run_(dry) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();

  var recipients = parseRecipients_(all[PROP_EMAIL]);
  if (!dry && !recipients.length) {
    throw new Error('Script property ' + PROP_EMAIL + ' is not set. Run setup() first.');
  }

  var pincodes = parsePincodes_(all[PROP_PINCODES]);
  if (!pincodes.length) {
    throw new Error('Script property ' + PROP_PINCODES + ' is empty.');
  }

  var cfg = relayConfig_(all);
  var reading = cfg.mode === 'stock'
    ? readViaStockRelay_(cfg, pincodes)
    : readViaSessionRelay_(cfg, pincodes);

  var restocked = [];
  var stateUpdates = {};

  reading.rows.forEach(function (row) {
    var key = STATE_PREFIX + row.pincode + '_' + row.slug;
    var prev = all[key] || 'unknown';

    console.log('%s @ %s -> %s (was %s)', row.name, row.pincode, row.status, prev);

    if (row.status === 'in' && prev !== 'in') {
      restocked.push({
        name: row.name,
        pincode: row.pincode,
        url: PRODUCT_URL_PREFIX + row.slug
      });
    }
    // Only successful checks produce rows, so a failed call can never
    // overwrite "in" with "out" and swallow the next alert.
    stateUpdates[key] = row.status;
  });

  if (dry) {
    console.log('--- dry run: no email sent, no state written ---');
    console.log('%s product/pincode pair(s) checked, %s newly in stock, %s error(s).',
                reading.rows.length, restocked.length, reading.errors.length);
    if (reading.errors.length) {
      console.error(reading.errors.join('\n'));
    }
    return;
  }

  if (restocked.length) {
    sendRestockEmail_(recipients.join(','), restocked);
    console.log('Emailed %s about %s restocked item(s).',
                recipients.join(', '), restocked.length);
  }

  if (Object.keys(stateUpdates).length) {
    props.setProperties(stateUpdates, false);
  }

  if (reading.errors.length) {
    console.error('Completed with %s error(s):\n%s',
                  reading.errors.length, reading.errors.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Reading availability
// ---------------------------------------------------------------------------

/** Default mode: relay supplies the handshake, this script does the API work. */
function readViaSessionRelay_(cfg, pincodes) {
  var rows = [];
  var errors = [];

  pincodes.forEach(function (pincode) {
    console.log('=== Checking pincode %s ===', pincode);
    var session;

    try {
      // Fresh session per pincode: the substore is bound to the session, so
      // reusing one across pincodes would cross-contaminate results.
      session = relaySession_(cfg);
      var substore = resolveSubstore_(session, pincode);
      setSubstore_(session, substore);
      console.log('Resolved pincode %s to substore "%s"', pincode, substore);
    } catch (e) {
      errors.push('pincode ' + pincode + ': ' + e.message);
      console.error('Pincode %s failed: %s', pincode, e.message);
      return;
    }

    PRODUCTS.forEach(function (product) {
      try {
        rows.push({
          pincode: pincode,
          slug: product.slug,
          name: product.name,
          status: checkProduct_(session, product.slug) ? 'in' : 'out'
        });
      } catch (e) {
        errors.push(product.name + ' @ ' + pincode + ': ' + e.message);
        console.error('%s @ %s failed: %s', product.name, pincode, e.message);
      }
    });
  });

  return { rows: rows, errors: errors };
}

/** Fallback mode: the Worker performs the whole check and returns results. */
function readViaStockRelay_(cfg, pincodes) {
  var body = relayCall_(cfg, '/stock?pincodes=' + encodeURIComponent(pincodes.join(',')));
  var rows = [];

  (body.results || []).forEach(function (result) {
    console.log('=== pincode %s -> substore %s ===', result.pincode, result.substore);
    (result.products || []).forEach(function (p) {
      rows.push({
        pincode: result.pincode,
        slug: p.slug,
        name: p.name,
        status: p.available ? 'in' : 'out'
      });
    });
  });

  return { rows: rows, errors: body.errors || [] };
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

function relayConfig_(all) {
  all = all || PropertiesService.getScriptProperties().getProperties();

  var url = (all[PROP_RELAY_URL] || '').trim().replace(/\/+$/, '');
  var key = (all[PROP_RELAY_KEY] || '').trim();

  if (!url || !key) {
    throw new Error('Script properties ' + PROP_RELAY_URL + ' and ' + PROP_RELAY_KEY +
                    ' must be set. Deploy worker/amul-relay.js first, then add its ' +
                    'URL and secret under Project Settings > Script Properties.');
  }

  var mode = (all[PROP_RELAY_MODE] || DEFAULT_RELAY_MODE).trim();
  if (mode !== 'session' && mode !== 'stock') {
    throw new Error(PROP_RELAY_MODE + ' must be "session" or "stock", got "' + mode + '"');
  }

  return { url: url, key: key, mode: mode };
}

/** Fetches the browser-only handshake the Worker obtained on our behalf. */
function relaySession_(cfg) {
  var body = relayCall_(cfg, '/session');

  if (!body.serverTimestamp || !body.token || !body.cookie) {
    throw new Error('Relay returned an incomplete session: ' +
                    truncate_(JSON.stringify(body), 200));
  }

  // Rehydrate the cookie string the Worker collected into our own jar.
  var jar = {};
  String(body.cookie).split(';').forEach(function (part) {
    var pair = part.trim();
    var eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  });

  return { jar: jar, serverTimestamp: body.serverTimestamp, token: body.token };
}

function relayCall_(cfg, path) {
  var res = UrlFetchApp.fetch(cfg.url + path, {
    method: 'get',
    headers: { 'x-relay-key': cfg.key },
    muteHttpExceptions: true,
    followRedirects: true
  });

  var code = res.getResponseCode();
  var text = res.getContentText();

  if (code !== 200) {
    throw new Error('Relay ' + path + ' returned HTTP ' + code + ': ' + truncate_(text, 300));
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Relay ' + path + ' returned non-JSON: ' + truncate_(text, 300));
  }
}

// ---------------------------------------------------------------------------
// StoreHippo API steps (session mode)
// ---------------------------------------------------------------------------

/** Resolve a 6-digit pincode to its regional substore. */
function resolveSubstore_(session, pincode) {
  var filters = JSON.stringify([
    { field: 'pincode', value: pincode, operator: 'regex' }
  ]);
  var url = ORIGIN + '/api/1.1/entity/pincode?filters=' +
            encodeURIComponent(filters) + '&limit=10';

  var body = apiJson_(session, url, { method: 'get' }, 'pincode lookup');
  var substore = body.data && body.data[0] && body.data[0].substore;

  if (!substore) {
    throw new Error('Pincode ' + pincode + ' does not map to an active substore.');
  }
  return substore;
}

/** Bind the session to that substore. Without this, products come back empty. */
function setSubstore_(session, substore) {
  apiJson_(session, ORIGIN + '/api/1.1/entity/ms.settings/_/setPreferences', {
    method: 'put',
    contentType: 'application/json;charset=UTF-8',
    payload: JSON.stringify({ store: substore })
  }, 'setPreferences');
}

/** Read the live availability flag for one product slug. */
function checkProduct_(session, slug) {
  var url = ORIGIN + '/api/1.1/entity/ms.products?q=' +
            encodeURIComponent(JSON.stringify({ alias: slug }));

  var body = apiJson_(session, url, { method: 'get' }, 'product lookup');

  // An empty data array means the session carries no substore context. That is
  // a broken check, not an out-of-stock signal — raise it so the caller skips
  // the row instead of recording a false "out".
  if (!body.data || !body.data.length) {
    throw new Error('No product record for ' + slug +
                    ' — session/substore not applied (relay session may be IP-bound; ' +
                    'try setting ' + PROP_RELAY_MODE + ' = "stock").');
  }

  // `available` is the storefront flag: 1 = Add to Cart, 0 = Sold Out.
  // inventory_quantity is a catalog counter and does NOT mean purchasable.
  var available = body.data[0].available;
  return available === 1 || available === true || available === '1';
}

// ---------------------------------------------------------------------------
// Signed request plumbing
// ---------------------------------------------------------------------------

/** Performs a signed /api/1.1/* call and parses the JSON response. */
function apiJson_(session, url, options, label) {
  var opts = shallowCopy_(options);
  opts.headers = shallowCopy_(opts.headers);
  opts.headers['tid'] = generateTid_(session);
  opts.headers['frontend'] = '1';
  opts.headers['base_url'] = BASE_URL;
  opts.headers['Referer'] = BASE_URL;
  opts.headers['Origin'] = ORIGIN;
  opts.headers['Accept'] = 'application/json, text/plain, */*';

  var res = fetchFollowingRedirects_(url, opts, session.jar);
  var code = res.getResponseCode();
  var text = res.getContentText();

  if (code !== 200) {
    throw new Error(label + ' returned HTTP ' + code + ': ' + truncate_(text, 300));
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(label + ' returned non-JSON body: ' + truncate_(text, 300));
  }
}

/**
 * Builds the StoreHippo `tid` signature:
 *   raw = STORE_ID:serverTimestamp:rand:token
 *   tid = serverTimestamp:rand:sha256hex(raw)
 */
function generateTid_(session) {
  var rand = Math.floor(Math.random() * 900) + 100;
  var raw = [STORE_ID, session.serverTimestamp, rand, session.token].join(':');
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return [session.serverTimestamp, rand, toHex_(digest)].join(':');
}

/**
 * UrlFetchApp has no cookie jar, and its built-in redirect following drops
 * cookies set on intermediate hops. We walk the chain ourselves, merging every
 * Set-Cookie into `jar`.
 *
 * Note: User-Agent is deliberately NOT set here — Apps Script strips custom
 * User-Agent headers, which is the entire reason the relay exists. The API
 * endpoints do not check it.
 */
function fetchFollowingRedirects_(url, options, jar) {
  var opts = shallowCopy_(options);
  opts.headers = shallowCopy_(opts.headers);
  opts.followRedirects = false;
  opts.muteHttpExceptions = true;

  var current = url;

  for (var hop = 0; hop <= MAX_REDIRECTS; hop++) {
    var cookie = cookieHeader_(jar);
    if (cookie) {
      opts.headers['Cookie'] = cookie;
    } else {
      delete opts.headers['Cookie'];
    }

    var res = UrlFetchApp.fetch(current, opts);
    absorbCookies_(res, jar);

    var code = res.getResponseCode();
    if (code < 300 || code >= 400) {
      return res;
    }

    var location = headerValue_(res.getAllHeaders(), 'Location');
    if (!location) {
      return res;
    }
    current = resolveUrl_(current, location);

    // 301/302/303 downgrade the follow-up request to GET, as browsers do.
    if (code === 301 || code === 302 || code === 303) {
      opts.method = 'get';
      delete opts.payload;
      delete opts.contentType;
    }
  }

  throw new Error('Exceeded ' + MAX_REDIRECTS + ' redirects starting at ' + url);
}

/**
 * Merges every Set-Cookie on a response into the jar.
 *
 * shop.amul.com returns cookies under BOTH "Set-Cookie" (jsessionid) and
 * "set-cookie" (Cloudflare's __cf_bm / _cfuvid), and getAllHeaders() only
 * merges duplicates that match exactly — so differing case yields two
 * separate keys. Reading just the first would drop the Cloudflare cookies.
 */
function absorbCookies_(res, jar) {
  var headers = res.getAllHeaders();

  Object.keys(headers).forEach(function (key) {
    if (key.toLowerCase() !== 'set-cookie') return;

    var raw = headers[key];
    var list = Array.isArray(raw) ? raw : [raw];

    list.forEach(function (entry) {
      // Value is kept verbatim: jsessionid is percent-encoded and must not
      // be decoded. Split on the FIRST "=" so base64 padding survives.
      var pair = String(entry).split(';')[0];
      var eq = pair.indexOf('=');
      if (eq > 0) {
        jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    });
  });
}

function cookieHeader_(jar) {
  return Object.keys(jar).map(function (name) {
    return name + '=' + jar[name];
  }).join('; ');
}

/** Header lookup that ignores case, since Apps Script preserves server casing. */
function headerValue_(headers, name) {
  var wanted = name.toLowerCase();
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === wanted) {
      return headers[keys[i]];
    }
  }
  return null;
}

function resolveUrl_(base, location) {
  if (/^https?:\/\//i.test(location)) return location;
  if (location.charAt(0) === '/') {
    return base.match(/^https?:\/\/[^\/]+/)[0] + location;
  }
  return base.replace(/[^\/]*$/, '') + location;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** One email per run, listing every item that just came back in stock. */
function sendRestockEmail_(recipient, items) {
  var subject = '🚨 Amul protein back in stock — ' + items.length +
                (items.length === 1 ? ' item' : ' items');

  var plain = items.map(function (item) {
    return item.name + '\n  Pincode: ' + item.pincode + '\n  Buy: ' + item.url;
  }).join('\n\n');

  var rows = items.map(function (item) {
    return '<tr>' +
      '<td style="padding:10px 14px;border-bottom:1px solid #eee;">' +
        '<strong>' + escapeHtml_(item.name) + '</strong>' +
      '</td>' +
      '<td style="padding:10px 14px;border-bottom:1px solid #eee;">' +
        escapeHtml_(item.pincode) +
      '</td>' +
      '<td style="padding:10px 14px;border-bottom:1px solid #eee;">' +
        '<a href="' + escapeHtml_(item.url) + '">Buy now</a>' +
      '</td>' +
    '</tr>';
  }).join('');

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
      '<h2 style="margin:0 0 12px;">Amul protein is back in stock</h2>' +
      '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' +
        '<thead><tr>' +
          '<th align="left" style="padding:8px 14px;border-bottom:2px solid #333;">Product</th>' +
          '<th align="left" style="padding:8px 14px;border-bottom:2px solid #333;">Pincode</th>' +
          '<th align="left" style="padding:8px 14px;border-bottom:2px solid #333;">Link</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '<p style="color:#777;font-size:12px;margin-top:16px;">' +
        'Stock moves fast — this alert fires once per restock.' +
      '</p>' +
    '</div>';

  MailApp.sendEmail({
    to: recipient,
    subject: subject,
    body: plain,
    htmlBody: html
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * ALERT_EMAIL may hold several addresses separated by commas, semicolons or
 * whitespace — MailApp's `to` field takes a comma-separated list. Addresses are
 * trimmed and de-duplicated, and anything obviously malformed is rejected up
 * front: MailApp throws on a bad address, which would abort the whole send and
 * lose the alert for the valid recipients too.
 */
function parseRecipients_(raw) {
  var seen = {};
  var out = [];

  String(raw || '').split(/[,;\s]+/).forEach(function (addr) {
    var a = addr.trim();
    if (!a) return;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) {
      throw new Error('Invalid address in ' + PROP_EMAIL + ': "' + a + '"');
    }
    var lower = a.toLowerCase();
    if (!seen[lower]) {
      seen[lower] = true;
      out.push(a);
    }
  });

  return out;
}

function parsePincodes_(raw) {
  return String(raw || DEFAULT_PINCODES)
    .split(/[,\s]+/)
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length > 0; });
}

function toHex_(bytes) {
  return bytes.map(function (b) {
    return ((b & 0xFF) + 0x100).toString(16).slice(1);
  }).join('');
}

function shallowCopy_(obj) {
  var copy = {};
  Object.keys(obj || {}).forEach(function (k) { copy[k] = obj[k]; });
  return copy;
}

function truncate_(text, max) {
  var s = String(text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
