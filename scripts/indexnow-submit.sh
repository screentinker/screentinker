#!/bin/bash
# Submit the sitemap URLs to IndexNow — instant "this changed, re-crawl it" pings to Bing,
# Yandex, Seznam, Naver (and anyone else on the shared IndexNow endpoint). Google doesn't use
# IndexNow but honors the same sitemap. Run after a content deploy, or from CI/cron.
#
# Prereq: the IndexNow key file (frontend/<KEY>.txt) must be DEPLOYED and reachable at
# https://<host>/<KEY>.txt — that's how IndexNow verifies ownership.
#
#   scripts/indexnow-submit.sh [host]        (default host: screentinker.com)
#   DRY_RUN=1 scripts/indexnow-submit.sh     (print the payload, don't POST)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${1:-screentinker.com}"

KEY_FILE="$(find frontend -maxdepth 1 -type f -name '*.txt' | grep -E '/[0-9a-f]{16,}\.txt$' | head -1 || true)"
[ -n "$KEY_FILE" ] || { echo "ERROR: no IndexNow key file (frontend/<hex>.txt) found." >&2; exit 1; }
KEY="$(basename "$KEY_FILE" .txt)"

mapfile -t URLS < <(grep -oE '<loc>[^<]+</loc>' frontend/sitemap.xml | sed -E 's#</?loc>##g')
[ "${#URLS[@]}" -gt 0 ] || { echo "ERROR: no <loc> URLs in frontend/sitemap.xml." >&2; exit 1; }

PAYLOAD="$(node -e '
  const [host, key] = [process.argv[1], process.argv[2]];
  const urlList = process.argv.slice(3);
  process.stdout.write(JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList }));
' "$HOST" "$KEY" "${URLS[@]}")"

echo "IndexNow: ${#URLS[@]} URLs, host=$HOST, key=$KEY"
if [ "${DRY_RUN:-0}" = "1" ]; then echo "$PAYLOAD"; echo "(DRY_RUN — not submitted)"; exit 0; fi
curl -sS -w '\nHTTP %{http_code}\n' -X POST 'https://api.indexnow.org/indexnow' \
  -H 'Content-Type: application/json; charset=utf-8' --data "$PAYLOAD"
