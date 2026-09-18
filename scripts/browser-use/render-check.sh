#!/usr/bin/env bash
# render-check.sh <url> [--out DIR] [--viewports desktop:1280x900,mobile:390x844] [--schemes light,dark]
#
# Render-verifies a page in a THROWAWAY headless Chrome: its own empty profile, its own CDP
# port, its own browser-use daemon, browser-use telemetry off. It never attaches to the
# user's everyday Chrome, so no logged-in session (Servis, Atlas, Gmail) is ever in reach.
#
# Exit codes — three states, never two:
#   0  rendered, no failures
#   1  rendered, failures found (listed in the JSON)
#   2  could not measure (no Chrome, no browser-use, page never loaded) — NOT a pass
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="" OUT="" VIEWPORTS="desktop:1280x900,mobile:390x844" SCHEMES="light"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --viewports) VIEWPORTS="$2"; shift 2 ;;
    --schemes) SCHEMES="$2"; shift 2 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) URL="$1"; shift ;;
  esac
done
[ -n "$URL" ] || { echo "usage: render-check.sh <url> [--out DIR]" >&2; exit 2; }
case "$URL" in http://*|https://*) ;; *) echo "render-check: url must be http(s): $URL" >&2; exit 2 ;; esac

cant() {
  python3 -c 'import json,sys; print(json.dumps({"ok": False, "measured": False, "url": sys.argv[1], "error": sys.argv[2]}))' "$URL" "$1"
  exit 2
}

# shellcheck source=_chrome.sh
. "$HERE/_chrome.sh"
bu_start render-check

OUT="${OUT:-${TMPDIR:-/tmp}/render-check-shots/$(date +%Y%m%d-%H%M%S)-$$}"; mkdir -p "$OUT"   # outside $WORK: cleanup deletes $WORK

RAW="$(RC_URL="$URL" RC_OUT="$OUT" RC_VIEWPORTS="$VIEWPORTS" RC_SCHEMES="$SCHEMES" \
  "${BU[@]}" < "$HERE/render-check.py" 2>"$WORK/bu.err")"
LINE="$(printf '%s\n' "$RAW" | grep '^RC_RESULT=' | tail -1)"
[ -n "$LINE" ] || cant "browser-use failed: $(bu_last_error)"
JSON="${LINE#RC_RESULT=}"
echo "$JSON"
printf '%s' "$JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["ok"] else (2 if d.get("measured") is False else 1))'
