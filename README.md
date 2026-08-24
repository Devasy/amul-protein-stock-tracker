# Amul Protein Stock Tracker (StoreHippo Pincode API)

Automated stock checker for Amul Whey Protein products on [shop.amul.com](https://shop.amul.com).

Unlike simple HTML scraping (which only checks global/fallback inventory), this tracker dynamically interacts with Amul's StoreHippo multi-substore API to query **real, per-pincode live stock levels** and sends instant alerts via Google Chat Webhooks, ntfy.sh, or email.

Two interchangeable runtimes are included: a bash script driven by GitHub Actions, and a
[Google Apps Script port](#-google-apps-script--cloudflare-worker-email-alerts) that emails you,
paired with a small Cloudflare Worker that performs the one request Apps Script is not permitted to make.

---

## 🥛 Tracked Products
- Amul Whey Protein Unflavoured, 960 g (30 sachets)
- Amul Whey Protein Unflavoured, 1.92 kg (60 sachets)
- Amul Chocolate Whey Protein, 1.02 kg (30 sachets)
- Amul Chocolate Whey Protein, 2.04 kg (60 sachets)

---

## ⚡ How It Works
1. **Dynamic Session Handshake**: Fetches the initial page to extract live server timestamp and security tokens.
2. **Request Signing (`tid` header)**: Generates StoreHippo's SHA-256 cryptographic request signatures for authentication.
3. **Pincode $\rightarrow$ Substore Resolution**: Maps delivery pincodes (e.g. `380060`, `380013`) to fulfillment centers (`gujarat`, `delhi`, etc.).
4. **Per-Substore Session Context**: Binds the session cookie to the regional warehouse context via `ms.settings/_/setPreferences`.
5. **Direct Availability Evaluation**: Reads the live client-facing `available` flag (`1` = In Stock, `0` = Sold Out).
6. **State Tracking & Alerts**: Tracks previous state in `state.json` and only triggers alerts on `out` $\rightarrow$ `in` transitions.

---

## 🚀 Setup & Automation (GitHub Actions)

### 1. Configure GitHub Secrets / Variables
Go to **Settings $\rightarrow$ Secrets and variables $\rightarrow$ Actions** and add:
- `GOOGLE_CHAT_WEBHOOK`: *(Secret)* Your Google Chat Space incoming webhook URL.
- `AMUL_PINCODES`: *(Optional Secret or Variable)* Comma-separated pincodes to check (default: `380060,380013`).
- `NTFY_TOPIC`: *(Optional Secret)* Your [ntfy.sh](https://ntfy.sh) topic name.

### 2. Automatic Hourly Execution
The included workflow `.github/workflows/check_stock.yml` runs automatically every hour, checks inventory for all configured pincodes, and updates `state.json` via automated Git commits.

---

## 💻 Running Locally

### Prerequisites
- `bash`, `curl`, `jq`, and `openssl` (available by default on Linux/macOS and in Git Bash on Windows).

### Usage
```bash
# Check with default pincodes
GOOGLE_CHAT_WEBHOOK="https://chat.googleapis.com/..." ./check_stock.sh

# Check with custom pincodes
AMUL_PINCODES="380060,380013" GOOGLE_CHAT_WEBHOOK="https://chat.googleapis.com/..." ./check_stock.sh
```

---

## ✉️ Google Apps Script + Cloudflare Worker (email alerts)

Runs the tracker on Google's infrastructure and emails you on restock — no
GitHub Actions, no `state.json` commits.

### Why there are two pieces

`shop.amul.com` serves the JS bootstrap page (which carries the `token` needed to
sign StoreHippo's mandatory `tid` header) **only to browser User-Agents**. Apps
Script silently strips custom `User-Agent` headers and always identifies itself
as `Google-Apps-Script`, so it receives a prerendered variant with no token — and
the API answers `401` without a valid `tid`.

[`worker/amul-relay.js`](worker/amul-relay.js) makes that one request with a real
browser UA. The API itself ignores User-Agent, so everything after the handshake
runs in Apps Script. Full evidence is in [FINDINGS.md §5](FINDINGS.md).

```
Apps Script trigger (15 min)
      │
      ├─ GET relay /session ......... Cloudflare Worker ───► shop.amul.com (browser UA)
      │     ◄─ { serverTimestamp, token, cookie }
      │
      ├─ pincode → substore ........ shop.amul.com/api/1.1/*  (signed with tid)
      ├─ setPreferences
      ├─ per-product availability
      │
      └─ diff vs Script Properties → MailApp.sendEmail on out→in
```

### 1. Deploy the Worker

Needs a free Cloudflare account.

```bash
npm install -g wrangler
cd worker
wrangler login
wrangler secret put RELAY_KEY     # paste any long random string; keep a copy
wrangler deploy
```

Note the deployed URL (e.g. `https://amul-relay.<your-subdomain>.workers.dev`).
Verify it before moving on — this should return JSON with a `token`:

```bash
curl "https://amul-relay.<your-subdomain>.workers.dev/session?key=<RELAY_KEY>"
```

Both endpoints require the secret, so the Worker is not an open proxy.

### 2. Set up the Apps Script project

1. [script.google.com](https://script.google.com) → **New project**.
2. Replace the placeholder `myFunction` with all of
   [`apps-script/Code.gs`](apps-script/Code.gs).
3. ⚙️ **Project Settings** → set time zone to India Standard Time.
4. Run **`setup`** and approve the OAuth prompt. At the
   "Google hasn't verified this app" screen choose **Advanced → Go to … (unsafe)**
   — expected for your own unpublished script.
5. Add the two Worker properties under **Project Settings → Script Properties**:
   - `RELAY_URL` = your `https://…workers.dev` URL
   - `RELAY_KEY` = the same secret you gave `wrangler secret put`
6. Run **`testRelay`** — confirms the Worker is reachable and returning a token.
7. Run **`dryRun`** — full live check that emails nobody and writes nothing.
   The log should show real per-product availability.

You do **not** press "Deploy" — that is for web apps. The time-based trigger
installed by `setup` is what runs the job.

### Script Properties

| Property | Purpose |
| :--- | :--- |
| `AMUL_PINCODES` | Comma-separated pincodes. Default `380060,380013`. |
| `ALERT_EMAIL` | Recipient. Defaults to the account that ran `setup`. |
| `RELAY_URL` | Your Worker's URL. **Required.** |
| `RELAY_KEY` | The Worker's shared secret. **Required.** |
| `RELAY_MODE` | `session` (default) or `stock` — see below. |

### `RELAY_MODE`

- **`session`** — the Worker returns only the handshake; Apps Script makes the
  pincode/substore/product calls itself.
- **`stock`** — the Worker performs the entire check and returns results.

Use `stock` if `session` mode logs `401`s or *"session/substore not applied"*,
which would mean StoreHippo binds the session to the IP that created it. Both
modes are implemented and tested; switching is a one-property change.

### Functions

| Function | What it does |
| :--- | :--- |
| `setup` | Seeds properties + installs the 15-minute trigger. Run once. |
| `testRelay` | Checks the Worker is reachable and returning a token. |
| `checkStock` | The scheduled job. Emails on `out` → `in`, then records state. |
| `dryRun` | Live check that emails nobody and writes nothing. |
| `showState` | Logs the recorded status of every product/pincode. |
| `resetState` | Clears state so the next run re-alerts on anything in stock. |
| `removeTrigger` | Stops the schedule without losing state. |

[`apps-script/Diagnose.gs`](apps-script/Diagnose.gs) is an optional standalone
probe that reports exactly what Amul serves to Google's egress IPs — useful if
the handshake ever breaks again.

### Behaviour notes

- **State** lives in Script Properties (`state_<pincode>_<slug>`), not `state.json`.
- **One email per run**, batching every item that just came back in stock.
- **A failed check never overwrites stored status**, so a blip cannot swallow the
  next restock alert. An empty API `data` array is treated as a broken check,
  not as out-of-stock.
- **Errors go to the execution log, not your inbox.** For failure emails, use
  ⏰ **Triggers → ⋮ → Notifications**.
- **Quota**: at 15-minute intervals, roughly 960 UrlFetch calls/day against a
  20,000/day limit. The Worker's free tier allows 100,000 requests/day.


## 📖 Reverse-Engineering Documentation
Detailed technical breakdown of StoreHippo's API endpoints, cryptographic signature algorithm, and payload formats is documented in [FINDINGS.md](FINDINGS.md).
