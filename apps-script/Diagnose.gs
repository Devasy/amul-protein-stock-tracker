/**
 * Diagnostic probe — self-contained, depends on nothing else in the project.
 *
 * Paste as a SEPARATE script file in the Apps Script editor and run
 * diagnose(). It reports exactly what shop.amul.com serves to Google's
 * egress IPs, so we can see why serverTimestamp/token parsing fails there
 * while an identical curl from a home connection succeeds.
 *
 * Read-only: fetches pages, sends no email, writes no state.
 */
function diagnose() {
  var BROWSE = 'https://shop.amul.com/en/browse/protein';
  var CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  // Probe A: exactly what Code.gs sends today.
  probe_('A: with custom User-Agent', BROWSE, {
    method: 'get',
    headers: { 'User-Agent': CHROME_UA },
    followRedirects: false,
    muteHttpExceptions: true
  });

  // Probe B: no UA override. UrlFetchApp may refuse to let us set User-Agent,
  // in which case A and B are the same request and will look identical.
  probe_('B: no User-Agent override', BROWSE, {
    method: 'get',
    followRedirects: false,
    muteHttpExceptions: true
  });

  // Probe C: browser-like Accept headers, redirects followed by the platform.
  probe_('C: browser-ish headers, followRedirects true', BROWSE, {
    method: 'get',
    headers: {
      'User-Agent': CHROME_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    },
    followRedirects: true,
    muteHttpExceptions: true
  });

  // Probe D: does the site answer AT ALL from here? Homepage as a control.
  probe_('D: homepage control', 'https://shop.amul.com/', {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true
  });

  // Probe E: what does the outside world think our IP is?
  try {
    var ip = UrlFetchApp.fetch('https://api.ipify.org?format=json',
                               { muteHttpExceptions: true });
    console.log('E: egress IP = %s', ip.getContentText());
  } catch (e) {
    console.log('E: egress IP lookup failed: %s', e.message);
  }
}

function probe_(label, url, options) {
  console.log('---------- %s ----------', label);

  var res;
  try {
    res = UrlFetchApp.fetch(url, options);
  } catch (e) {
    console.log('THREW: %s', e.message);
    return;
  }

  var code = res.getResponseCode();
  var text = res.getContentText();
  var headers = res.getAllHeaders();

  console.log('status: %s   body length: %s', code, text.length);

  // Which headers matter for a Cloudflare verdict.
  ['Content-Type', 'content-type', 'Server', 'server', 'cf-ray', 'CF-RAY',
   'cf-mitigated', 'Location', 'location'].forEach(function (h) {
    if (headers[h] !== undefined) {
      console.log('header %s: %s', h, headers[h]);
    }
  });

  var cookieKeys = Object.keys(headers).filter(function (k) {
    return k.toLowerCase() === 'set-cookie';
  });
  console.log('set-cookie header keys seen: %s',
              cookieKeys.length ? cookieKeys.join(' | ') : '(none)');

  // The actual question: is the payload the real storefront?
  console.log('contains serverTimestamp: %s', text.indexOf('serverTimestamp') !== -1);
  console.log('contains token=: %s', /token\s*=\s*"/.test(text));

  // Signatures of a Cloudflare interstitial served with HTTP 200.
  var markers = ['Just a moment', 'cf-browser-verification', 'cf_chl',
                 'challenge-platform', 'Attention Required', 'Enable JavaScript',
                 'Access denied', 'Sorry, you have been blocked', 'captcha'];
  var hits = markers.filter(function (m) {
    return text.toLowerCase().indexOf(m.toLowerCase()) !== -1;
  });
  console.log('challenge markers: %s', hits.length ? hits.join(', ') : '(none)');

  console.log('first 400 chars >>> %s', text.slice(0, 400).replace(/\s+/g, ' '));
}
