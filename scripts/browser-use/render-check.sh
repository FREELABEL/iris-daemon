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

# browser-use: prefer an installed binary, else uvx. The daemon's PATH is often minimal.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if command -v browser-use >/dev/null 2>&1; then BU=(browser-use)
elif command -v uvx >/dev/null 2>&1; then BU=(uvx browser-use)
else cant "browser-use not installed (install uv, then: uv tool install browser-use)"; fi

CHROME="${CHROME_BIN:-}"
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium" \
         google-chrome google-chrome-stable chromium chromium-browser; do
  [ -n "$CHROME" ] && break
  if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then CHROME="$c"; fi
done
[ -n "$CHROME" ] || cant "no Chrome/Chromium found (set CHROME_BIN)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/render-check.XXXXXX")"
OUT="${OUT:-${TMPDIR:-/tmp}/render-check-shots/$(date +%Y%m%d-%H%M%S)-$$}"; mkdir -p "$OUT"   # outside $WORK: cleanup deletes $WORK
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
export BU_NAME="rc$$" BU_CDP_URL="http://127.0.0.1:$PORT" BH_TAB_MARKER=0 BH_TELEMETRY=0 BH_RECORD=0 BH_OPEN_LIVE_URL=0

CHROME_ARGS=(--headless=new --user-data-dir="$WORK/profile" --remote-debugging-port="$PORT"
  --no-first-run --no-default-browser-check --disable-extensions --hide-scrollbars about:blank)
case "$CHROME" in
  /Applications/*.app/Contents/MacOS/*)
    # Through LaunchServices, not as our child. The Hive daemon is a launchd Background job and
    # a child inherits PRIO_DARWIN_BG, which it cannot shed (taskpolicy -B returns 0 and changes
    # nothing): Chrome ran 34s under it vs 6.5s from a shell. `open -n` starts a fresh instance
    # at app priority; it is found again for cleanup by its unique profile path.
    open -na "${CHROME%%/Contents/MacOS/*}" --args "${CHROME_ARGS[@]}" >"$WORK/chrome.log" 2>&1
    CHROME_PID="" ;;
  *)
    "$CHROME" "${CHROME_ARGS[@]}" >"$WORK/chrome.log" 2>&1 &
    CHROME_PID=$! ;;
esac
cleanup() {
  "${BU[@]}" --reload >/dev/null 2>&1
  if [ -n "$CHROME_PID" ]; then kill "$CHROME_PID" 2>/dev/null; wait "$CHROME_PID" 2>/dev/null
  else pkill -f -- "--user-data-dir=$WORK/profile" 2>/dev/null; fi
  sleep 0.5
  # Chrome writes component-extension storage dirs with no owner-write bit, so a plain rm -rf
  # fails with "Permission denied" and the work dir (with the profile inside) leaks.
  chmod -R u+rwX "$WORK" 2>/dev/null
  rm -rf "$WORK" 2>/dev/null || { sleep 1; chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK" 2>/dev/null; }
}
trap cleanup EXIT

for _ in $(seq 1 40); do curl -sf "$BU_CDP_URL/json/version" >/dev/null && break; sleep 0.25; done
curl -sf "$BU_CDP_URL/json/version" >/dev/null || cant "headless Chrome did not open CDP on $PORT"

RAW="$(RC_URL="$URL" RC_OUT="$OUT" RC_VIEWPORTS="$VIEWPORTS" RC_SCHEMES="$SCHEMES" \
  "${BU[@]}" < "$HERE/render-check.py" 2>"$WORK/bu.err")"
LINE="$(printf '%s\n' "$RAW" | grep '^RC_RESULT=' | tail -1)"
if [ -z "$LINE" ]; then
  # The LAST stderr line, not 600 characters of traceback tail: a caller needs the reason, and
  # the reason is on the last line.
  cant "browser-use failed: $(grep -v "^\s" "$WORK/bu.err" | tail -2 | tr "\n" " " | tail -c 300)"
fi
JSON="${LINE#RC_RESULT=}"
echo "$JSON"
printf '%s' "$JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["ok"] else (2 if d.get("measured") is False else 1))'
