#!/usr/bin/env bash
# Starts the Worker in the local Workers runtime (workerd), posts a synthetic XLSX, prints which parsers work.
set -u
cd "$(dirname "$0")"
TMP="$(mktemp -d)"
node make-xlsx.mjs "$TMP/t.xlsx"
WRANGLER_SEND_METRICS=false CI=1 npx wrangler dev --local --port 8799 >"$TMP/wr.log" 2>&1 &
PID=$!
trap 'pkill -P $PID 2>/dev/null; kill $PID 2>/dev/null; true' EXIT
for i in $(seq 1 60); do
  sleep 2
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8799/)" = "200" ] && break
done
curl -s -m 30 -X POST --data-binary @"$TMP/t.xlsx" http://127.0.0.1:8799/ | tee "$TMP/out.json"; echo
grep -q '"exceljs":{"ok":true' "$TMP/out.json" && grep -q '"readExcelFile":{"ok":true' "$TMP/out.json" && grep -q '"papaparse":{"ok":true' "$TMP/out.json"
