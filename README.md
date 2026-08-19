# Amul Protein Stock Tracker (StoreHippo Pincode API)

Automated stock checker for Amul Whey Protein products on [shop.amul.com](https://shop.amul.com).

Unlike simple HTML scraping (which only checks global/fallback inventory), this tracker dynamically interacts with Amul's StoreHippo multi-substore API to query **real, per-pincode live stock levels** and sends instant push alerts via Google Chat Webhooks and/or ntfy.sh.

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

## 📖 Reverse-Engineering Documentation
Detailed technical breakdown of StoreHippo's API endpoints, cryptographic signature algorithm, and payload formats is documented in [FINDINGS.md](FINDINGS.md).
