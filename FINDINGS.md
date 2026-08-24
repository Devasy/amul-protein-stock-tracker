# Reverse-Engineering Amul Shop (StoreHippo) Pincode & Stock API

This document details the reverse-engineering analysis, technical architecture, network requests, authentication mechanism, standalone verification, and the final script integration for checking per-pincode product stock on [shop.amul.com](https://shop.amul.com).

---

## 1. Executive Summary & Architecture Overview

`shop.amul.com` is an e-commerce platform built on **StoreHippo**. StoreHippo operates as a multi-seller / multi-substore architecture where inventory is segregated by regional fulfillment substores (e.g., `gujarat`, `delhi`, `karnataka`, `mumbai-br`).

On initial load without a pincode selected:
- The web frontend displays "No products found" because the session has no substore context assigned.
- Checking static HTML product pages without a session cookie or substore preference only checks default/national fallback availability, not actual per-pincode inventory.

### The Real Flow:
1. **Initial Handshake**: Fetch initial HTML page (`https://shop.amul.com/en/browse/protein`) to receive a session cookie (`jsessionid`), an embedded server timestamp (`serverTimestamp`), and a session token (`token`).
2. **Dynamic Request Signing (`tid` header)**: StoreHippo validates all frontend API requests (`/api/1.1/*`) using a custom hash header called `tid`.
3. **Pincode Lookup**: Query StoreHippo's `pincode` entity to resolve the 6-digit delivery pincode into a `substore` identifier (e.g., `380013` $\rightarrow$ `gujarat`, `110001` $\rightarrow$ `delhi`).
4. **Session Substore Context**: Issue a `PUT` request to `/api/1.1/entity/ms.settings/_/setPreferences` with `{"store": "<substore_name>"}`. This binds the server-side session associated with the `jsessionid` cookie to that regional substore.
5. **Per-Pincode Stock Check**: Query `/api/1.1/entity/ms.products?q={"alias":"<product-slug>"}` with the session cookie and signed `tid` header.
6. **Real Availability Evaluation (`available` vs `inventory_quantity`)**:
   - `inventory_quantity`: The master catalog's pre-allocation inventory counter.
   - `available`: The **actual live storefront availability flag** (`1` = In Stock & purchasable, `0` = Sold Out / Notify Me). StoreHippo determines whether regional linked sellers in that substore are active and permitted to sell the item.

---

## 2. Reverse-Engineered Request Details

### Request 1: Initial Page Load (Session & Seed Extraction)
- **URL**: `GET https://shop.amul.com/en/browse/protein`
- **Method**: `GET`
- **Headers**:
  - `User-Agent: Mozilla/5.0 ...`
- **Response**:
  - Sets Cookie: `jsessionid=...`
  - Inline JS variables in HTML:
    - `<script>serverTimestamp = "<timestamp_ms>"</script>`
    - `<script>token = "<session_token>"</script>`

---

### Request 2: StoreHippo Dynamic Request Signing (`tid` Algorithm)
StoreHippo's frontend client (`mystore_vue.js`) signs every API call with the `tid` header:
- **Store ID**: Fixed identifier for Amul: `62fa94df8c13af2e242eba16`
- **Formula**:
  ```text
  rand_t = RandomInteger(100, 999)
  raw_string = STORE_ID + ":" + serverTimestamp + ":" + rand_t + ":" + token
  hash = SHA256(raw_string)
  tid_header = serverTimestamp + ":" + rand_t + ":" + hash
  ```
- **Required Headers on all `/api/1.1/*` calls**:
  - `tid: <serverTimestamp>:<rand_t>:<sha256_hex>`
  - `frontend: 1`
  - `base_url: https://shop.amul.com/en/browse/protein`
  - `Referer: https://shop.amul.com/en/browse/protein`
  - `Origin: https://shop.amul.com`
  - `Cookie: jsessionid=<session_id>`

---

### Request 3: Pincode -> Substore Resolution
- **URL**: `https://shop.amul.com/api/1.1/entity/pincode?filters=%5B%7B%22field%22%3A%22pincode%22%2C%22value%22%3A%22380013%22%2C%22operator%22%3A%22regex%22%7D%5D&limit=10`
  - Encoded query: `filters=[{"field":"pincode","value":"<PINCODE>","operator":"regex"}]&limit=10`
- **Method**: `GET`
- **Headers**: Same as Request 2.
- **Response Body Shape**:
  ```json
  {
    "messages": [
      { "name": "ms.entity.pincode.list", "level": "success" }
    ],
    "fileBaseUrl": "https://shop.amul.com/s/62fa94df8c13af2e242eba16/",
    "data": [
      {
        "_id": "664f309d615a647f3cf04d4e",
        "pincode": "380013",
        "substore": "gujarat",
        "created_on": "2024-05-23T12:03:41.518Z",
        "updated_on": "2024-09-06T13:00:36.362Z"
      }
    ],
    "paging": { "limit": 10, "start": 0, "count": 1, "total": 1 }
  }
  ```
- **Extracted Field**: `data[0].substore` (e.g. `gujarat`, `delhi`, `karnataka`, `mumbai-br`).

---

### Request 4: Setting Substore Context in Session
- **URL**: `https://shop.amul.com/api/1.1/entity/ms.settings/_/setPreferences`
- **Method**: `PUT`
- **Headers**:
  - `Content-Type: application/json;charset=UTF-8`
  - Plus standard StoreHippo signed headers (`tid`, `frontend`, `Cookie`, etc.)
- **Request Body**:
  ```json
  {
    "store": "gujarat"
  }
  ```
- **Response Body Shape**:
  ```json
  {
    "fileBaseUrl": "https://shop.amul.com/s/62fa94df8c13af2e242eba16/",
    "data": "Updated successfully",
    "messages": [
      { "name": "ms.entity.settings.setPreferences", "level": "success" }
    ]
  }
  ```

---

### Request 5: Fetching Product Stock under Selected Substore
- **URL**: `https://shop.amul.com/api/1.1/entity/ms.products?q=%7B%22alias%22%3A%22amul-whey-protein-32-g-or-pack-of-30-sachets%22%7D`
  - Encoded query: `q={"alias":"<PRODUCT_SLUG>"}`
- **Method**: `GET`
- **Headers**: Same as Request 2 with the updated session cookie.
- **Response Body Shape**:
  ```json
  {
    "messages": [
      { "name": "ms.entity.products.list", "level": "success" }
    ],
    "fileBaseUrl": "https://shop.amul.com/s/62fa94df8c13af2e242eba16/",
    "data": [
      {
        "_id": "6408226065561a0f8231364d",
        "name": "Amul Whey Protein, 32 g | Pack of 30 Sachets",
        "alias": "amul-whey-protein-32-g-or-pack-of-30-sachets",
        "price": 2400,
        "inventory_quantity": 7,
        "available": 0,
        "substore": ["all"]
      }
    ],
    "paging": { "limit": 50, "start": 0, "count": 1, "total": 1 }
  }
  ```
- **Critical Finding: Stock Availability Condition**:
  - In StoreHippo UI templates (`themeinfo.js` and `mystore_vue.js`), the "Add to Cart" button is rendered **strictly when `available == 1`**.
  - When `available == 0`, the UI displays **Sold Out / Out of Stock** and swaps the button to `Notify Me`.
  - While `inventory_quantity` may show internal warehouse numbers, `available: 0` means the product cannot be purchased for that delivery pincode.

---

## 3. Real Status Verification for `380013` & `380060`

| Product | `available` Flag | Website Status |
| :--- | :---: | :---: |
| **Whey Protein Unflavoured, 960 g (30 sachets)** | `0` | ❌ **OUT OF STOCK (Sold Out)** |
| **Whey Protein Unflavoured, 1.92 kg (60 sachets)** | `0` | ❌ **OUT OF STOCK (Sold Out)** |
| **Chocolate Whey Protein, 1.02 kg (30 sachets)** | `0` | ❌ **OUT OF STOCK (Sold Out)** |
| **Chocolate Whey Protein, 2.04 kg (60 sachets)** | `0` | ❌ **OUT OF STOCK (Sold Out)** |
| *(Contrast item)* **Chocolate Whey Gift Pack (10 sachets)** | `1` |  **IN STOCK** |

---

## 4. Stability & GitHub Actions Integration

1. **Session Tokens**: Freshly created per execution from the initial HTML handshake (never expires or goes stale).
2. **Environment Variables**:
   - `AMUL_PINCODE`: Set to your desired pincode (e.g. `380013` or `380060`).
   - `NTFY_TOPIC`: Set to your ntfy.sh notification topic.

---

## 5. User-Agent Content Negotiation (why a relay is needed)

Discovered while porting this tracker to Google Apps Script. `shop.amul.com`
serves **two entirely different HTML documents for the same URL**, selected by
`User-Agent`.

### Evidence

Same URL (`/en/browse/protein`), same moment, only the UA differs:

| User-Agent | HTTP | Bytes | `<script>` tags | `serverTimestamp` |
| :--- | :---: | ---: | :---: | :---: |
| `Mozilla/5.0 … Chrome/124.0 …` | 200 | 4,376 | many | ✅ present |
| *(curl default / absent)* | 200 | 4,376 | many | ✅ present |
| `Mozilla/5.0 (compatible; Google-Apps-Script; beanserver; …)` | 200 | 157,765 | 1 (a Cloudflare email decoder) | ❌ **absent** |

The bot-shaped UA receives a **prerendered SEO variant**: fully populated
product markup, but no inline JS bootstrap and therefore **no `serverTimestamp`
and no `token`**. Critically it still returns **HTTP 200**, so naive error
handling reports success and then fails at the parse step.

### Why this is fatal for a pure Apps Script implementation

- `tid` is strictly enforced. Omitting it returns `401 Unauthorized`; a
  malformed one returns `503`.
- `tid` requires `token`, which exists only in the browser variant.
- **Google Apps Script cannot set `User-Agent`** — `UrlFetchApp` silently
  strips the header and always sends its own
  `Mozilla/5.0 (compatible; Google-Apps-Script; beanserver; +https://script.google.com; id: …)`.
- Every candidate URL (`/`, `/en/cart`, `/en/checkout`, a product page,
  a cache-busted browse URL) returns the token-less variant to that UA.

### Two properties that make a minimal relay sufficient

1. **The API ignores `User-Agent`.** A token and cookie obtained by a
   browser-UA client work perfectly on API calls issued by a
   `Google-Apps-Script` client. Only the *bootstrap page fetch* is UA-gated.
2. **The session cookie is mandatory, and the substore must be set on it:**

   | Request | Result |
   | :--- | :--- |
   | `tid`, no cookie | `data: []` |
   | `tid` + cookie, no `setPreferences` | `data: []` |
   | `tid` + cookie + `setPreferences: gujarat` | `available: 1` ✅ |

   An empty `data` array therefore means *"session/substore not applied"* — a
   broken check — and must **not** be treated as out-of-stock.

### Why the prerendered page is not a usable fallback

Parsing `Sold Out` / `Add to Cart` out of the 157 KB variant was tested against
API ground truth for substore `gujarat`:

| Product | Prerendered HTML | API truth | Match |
| :--- | :---: | :---: | :---: |
| Whey 960 g (30) | out | out | ✅ |
| Whey 1.92 kg (60) | out | out | ✅ |
| **Chocolate 1.02 kg (30)** | **out** | **in** | ❌ |
| Chocolate 2.04 kg (60) | out | out | ✅ |

It reports the one genuinely in-stock item as out — a **false negative on
exactly the event the tracker exists to catch**. This confirms §1: HTML-only
checking reflects national/fallback state, not per-pincode availability.

### Resolution

`worker/amul-relay.js` performs the UA-gated handshake with a real browser UA.
See the README for deployment.
