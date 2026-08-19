#!/usr/bin/env bash
set -euo pipefail

PRODUCTS=(
  "amul-whey-protein-32-g-or-pack-of-30-sachets|Whey Protein Unflavoured, 960 g (30 sachets)"
  "amul-whey-protein-32-g-or-pack-of-60-sachets|Whey Protein Unflavoured, 1.92 kg (60 sachets)"
  "amul-chocolate-whey-protein-34-g-or-pack-of-30-sachets|Chocolate Whey Protein, 1.02 kg (30 sachets)"
  "amul-chocolate-whey-protein-34-g-or-pack-of-60-sachets|Chocolate Whey Protein, 2.04 kg (60 sachets)"
)

STATE_FILE="state.json"
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
STORE_ID="62fa94df8c13af2e242eba16"
BASE_URL="https://shop.amul.com/en/browse/protein"

# Notification targets (provided via environment variables / GitHub Secrets)
GOOGLE_CHAT_WEBHOOK="${GOOGLE_CHAT_WEBHOOK:-}"
NTFY_TOPIC="${NTFY_TOPIC:-}"

if [ -z "$GOOGLE_CHAT_WEBHOOK" ] && [ -z "$NTFY_TOPIC" ]; then
  echo "WARN: Neither GOOGLE_CHAT_WEBHOOK nor NTFY_TOPIC is set. Stock alerts will not be delivered externally." >&2
fi

# Supports AMUL_PINCODES or AMUL_PINCODE (comma or space separated, e.g. "380060,380013")
RAW_PINCODES="${AMUL_PINCODES:-${AMUL_PINCODE:-380060,380013}}"

# Split comma or space separated pincodes into an array
IFS=', ' read -r -a PINCODES <<< "$RAW_PINCODES"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
COOKIE_JAR="$TMP_DIR/cookies.txt"

any_error=0

# Helper to compute SHA256 across platforms (openssl, sha256sum, shasum, python3)
sha256_hash() {
  local input="$1"
  if command -v openssl >/dev/null 2>&1; then
    printf "%s" "$input" | openssl dgst -sha256 | awk '{print $NF}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf "%s" "$input" | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    printf "%s" "$input" | shasum -a 256 | awk '{print $1}'
  else
    python3 -c "import hashlib, sys; sys.stdout.write(hashlib.sha256(sys.argv[1].encode('utf-8')).hexdigest())" "$input"
  fi
}

for pincode in "${PINCODES[@]}"; do
  # Trim whitespace
  pincode=$(echo "$pincode" | xargs)
  [ -z "$pincode" ] && continue

  echo "======================================================="
  echo "[$(date -u +%FT%TZ)] Checking stock for Pincode: $pincode"
  echo "======================================================="

  # Reset cookie jar for fresh session per pincode
  rm -f "$COOKIE_JAR"

  # 1. Fetch initial page to establish session & extract serverTimestamp and token
  if ! init_html=$(curl -sSL --max-time 20 --retry 2 -c "$COOKIE_JAR" -b "$COOKIE_JAR" -A "$UA" "$BASE_URL"); then
    echo "ERROR: Failed to fetch initial browse page for session context (pincode $pincode)." >&2
    any_error=1
    continue
  fi

  server_ts=$(printf "%s" "$init_html" | grep -o 'serverTimestamp\s*=\s*"[^"]*"' | head -n1 | cut -d'"' -f2 || true)
  token=$(printf "%s" "$init_html" | grep -o 'token\s*=\s*"[^"]*"' | head -n1 | cut -d'"' -f2 || true)

  if [ -z "$server_ts" ] || [ -z "$token" ]; then
    echo "ERROR: Failed to parse serverTimestamp or token from initial page HTML." >&2
    any_error=1
    continue
  fi

  # Function to generate dynamic TID header for StoreHippo API calls
  generate_tid() {
    local rand_t=$(( RANDOM % 900 + 100 ))
    local raw="${STORE_ID}:${server_ts}:${rand_t}:${token}"
    local h
    h=$(sha256_hash "$raw")
    echo "${server_ts}:${rand_t}:${h}"
  }

  # 2. Resolve Pincode -> Substore
  pin_filter=$(jq -nc --arg p "$pincode" '[{"field":"pincode","value":$p,"operator":"regex"}]')
  pin_url="https://shop.amul.com/api/1.1/entity/pincode?filters=$(printf '%s' "$pin_filter" | jq -sRr @uri)&limit=10"
  tid_hdr=$(generate_tid)

  if ! pin_raw=$(curl -sSL --max-time 20 --retry 2 \
    -w "\n%{http_code}" \
    -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -A "$UA" \
    -H "Referer: $BASE_URL" \
    -H "Origin: https://shop.amul.com" \
    -H "tid: $tid_hdr" \
    -H "frontend: 1" \
    -H "base_url: $BASE_URL" \
    -H "Accept: application/json, text/plain, */*" \
    "$pin_url"); then
    echo "ERROR: Network failure resolving pincode $pincode" >&2
    any_error=1
    continue
  fi

  pin_code=$(printf "%s" "$pin_raw" | tail -n1)
  pin_res=$(printf "%s" "$pin_raw" | sed '$d')

  if [ "$pin_code" != "200" ]; then
    echo "ERROR: Pincode API returned HTTP status $pin_code. Response: $pin_res" >&2
    any_error=1
    continue
  fi

  substore=$(printf "%s" "$pin_res" | jq -r '.data[0].substore // empty' 2>/dev/null || true)
  if [ -z "$substore" ]; then
    echo "ERROR: Pincode $pincode does not map to any active substore. API response: $pin_res" >&2
    any_error=1
    continue
  fi

  echo "Resolved pincode $pincode to substore '$substore'"

  # 3. Set Substore in Session Preferences
  tid_hdr=$(generate_tid)
  if ! pref_raw=$(curl -sSL --max-time 20 --retry 2 -X PUT \
    -w "\n%{http_code}" \
    -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -A "$UA" \
    -H "Content-Type: application/json;charset=UTF-8" \
    -H "Referer: $BASE_URL" \
    -H "Origin: https://shop.amul.com" \
    -H "tid: $tid_hdr" \
    -H "frontend: 1" \
    -H "base_url: $BASE_URL" \
    -H "Accept: application/json, text/plain, */*" \
    -d "{\"store\":\"$substore\"}" \
    "https://shop.amul.com/api/1.1/entity/ms.settings/_/setPreferences"); then
    echo "ERROR: Network failure setting substore preference for $substore" >&2
    any_error=1
    continue
  fi

  pref_code=$(printf "%s" "$pref_raw" | tail -n1)
  pref_res=$(printf "%s" "$pref_raw" | sed '$d')

  if [ "$pref_code" != "200" ]; then
    echo "ERROR: setPreferences returned HTTP status $pref_code. Response: $pref_res" >&2
    any_error=1
    continue
  fi

  # 4. Check Stock for each product under the resolved substore
  for entry in "${PRODUCTS[@]}"; do
    slug="${entry%%|*}"
    name="${entry##*|}"
    url="https://shop.amul.com/en/product/${slug}"
    state_key="${pincode}_${slug}"

    q_json=$(jq -nc --arg s "$slug" '{"alias":$s}')
    prod_url="https://shop.amul.com/api/1.1/entity/ms.products?q=$(printf '%s' "$q_json" | jq -sRr @uri)"
    tid_hdr=$(generate_tid)

    if ! prod_raw=$(curl -sSL --max-time 20 --retry 2 \
      -w "\n%{http_code}" \
      -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
      -A "$UA" \
      -H "Referer: $BASE_URL" \
      -H "Origin: https://shop.amul.com" \
      -H "tid: $tid_hdr" \
      -H "frontend: 1" \
      -H "base_url: $BASE_URL" \
      -H "Accept: application/json, text/plain, */*" \
      "$prod_url"); then
      echo "ERROR: Fetch failed for $name ($url)" >&2
      any_error=1
      continue
    fi

    http_status=$(printf "%s" "$prod_raw" | tail -n1)
    resp=$(printf "%s" "$prod_raw" | sed '$d')

    if [ "$http_status" != "200" ]; then
      echo "ERROR: Product API returned HTTP status $http_status for $name ($slug). Body: $resp" >&2
      any_error=1
      continue
    fi

    # Validate response structure
    records_count=$(printf "%s" "$resp" | jq -r '.data | length' 2>/dev/null || echo "-1")
    if [ "$records_count" -le 0 ]; then
      echo "ERROR: Product record not found for $name ($slug). API response: $resp" >&2
      any_error=1
      continue
    fi

    available=$(printf "%s" "$resp" | jq -r '.data[0].available // 0')

    if [ "$available" = "1" ] || [ "$available" = "true" ]; then
      status="in"
    else
      status="out"
    fi

    prev=$(jq -r --arg k "$state_key" '.[$k] // "unknown"' "$STATE_FILE")
    echo "$name -> $status (was $prev)"

    if [ "$status" = "in" ] && [ "$prev" != "in" ]; then
      # 1. Send notification to Google Chat Space Webhook
      if [ -n "$GOOGLE_CHAT_WEBHOOK" ]; then
        gchat_msg=$(jq -nc \
          --arg text "🚨 *Amul Protein Back in Stock!*

*Product:* $name
*Pincode:* $pincode
*Status:* Available (In Stock)
*Link:* $url" \
          '{"text": $text}')

        curl -sS -X POST \
          -H "Content-Type: application/json; charset=UTF-8" \
          -d "$gchat_msg" \
          "$GOOGLE_CHAT_WEBHOOK" || echo "WARN: Google Chat notification failed for $name" >&2
      fi

      # 2. Send notification to NTFY if configured
      if [ -n "$NTFY_TOPIC" ]; then
        curl -sS \
          -H "Title: Amul protein back in stock!" \
          -H "Priority: urgent" \
          -H "Tags: tada" \
          -H "Click: $url" \
          -d "$name is back in stock for pincode $pincode! Buy now: $url" \
          "https://ntfy.sh/${NTFY_TOPIC}" || echo "WARN: NTFY notify failed for $name" >&2
      fi
    fi

    tmp=$(mktemp)
    jq --arg k "$state_key" --arg v "$status" '.[$k] = $v' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
  done
done

exit $any_error
