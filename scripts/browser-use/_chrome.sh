# shellcheck shell=bash
# Shared launcher for the browser-use scripts (render-check.sh, scrape-leads.sh). SOURCE it.
#
# Gives the caller a THROWAWAY headless Chrome — its own empty profile, its own CDP port, its own
# browser-use daemon, telemetry off — and tears all of it down on exit. It never attaches to the
# user's everyday Chrome, so no logged-in session (Servis, Atlas, Gmail) is ever in reach.
#
# The caller defines `cant <reason>` (prints its own unmeasured JSON, exits 2) BEFORE sourcing,
# then calls `bu_start <label>`. After that: "${BU[@]}" runs browser-use, $WORK is scratch space
# that is deleted on exit, and our agent_helpers.py (safe_click, elements, click_text) is loaded
# into every script through BH_AGENT_WORKSPACE — no global install needed.

BU_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# browser-use: prefer an installed binary, else uvx. The daemon's PATH is often minimal.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

bu_start () {
  local label="${1:-bu}"
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

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/$label.XXXXXX")"
  PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
  mkdir -p "$WORK/ws" && ln -sf "$BU_HERE/agent_helpers.py" "$WORK/ws/agent_helpers.py"
  export BU_NAME="$label$$" BU_CDP_URL="http://127.0.0.1:$PORT" BH_AGENT_WORKSPACE="$WORK/ws" \
         BH_TAB_MARKER=0 BH_TELEMETRY=0 BH_RECORD=0 BH_OPEN_LIVE_URL=0

  local args=(--headless=new --user-data-dir="$WORK/profile" --remote-debugging-port="$PORT"
    --no-first-run --no-default-browser-check --disable-extensions --hide-scrollbars about:blank)
  case "$CHROME" in
    /Applications/*.app/Contents/MacOS/*)
      # Through LaunchServices, not as our child. The Hive daemon is a launchd Background job and
      # a child inherits PRIO_DARWIN_BG, which it cannot shed (taskpolicy -B returns 0 and changes
      # nothing): Chrome ran 34s under it vs 6.5s from a shell. `open -n` starts a fresh instance
      # at app priority; it is found again for cleanup by its unique profile path.
      open -na "${CHROME%%/Contents/MacOS/*}" --args "${args[@]}" >"$WORK/chrome.log" 2>&1
      CHROME_PID="" ;;
    *)
      "$CHROME" "${args[@]}" >"$WORK/chrome.log" 2>&1 &
      CHROME_PID=$! ;;
  esac
  trap bu_cleanup EXIT

  for _ in $(seq 1 40); do curl -sf "$BU_CDP_URL/json/version" >/dev/null && break; sleep 0.25; done
  curl -sf "$BU_CDP_URL/json/version" >/dev/null || cant "headless Chrome did not open CDP on $PORT"
}

bu_cleanup () {
  "${BU[@]}" --reload >/dev/null 2>&1
  if [ -n "${CHROME_PID:-}" ]; then kill "$CHROME_PID" 2>/dev/null; wait "$CHROME_PID" 2>/dev/null
  else pkill -f -- "--user-data-dir=$WORK/profile" 2>/dev/null; fi
  sleep 0.5
  # Chrome writes component-extension storage dirs with no owner-write bit, so a plain rm -rf
  # fails with "Permission denied" and the work dir (with the profile inside) leaks.
  chmod -R u+rwX "$WORK" 2>/dev/null
  rm -rf "$WORK" 2>/dev/null || { sleep 1; chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK" 2>/dev/null; }
}

# The LAST stderr line, not a traceback tail: a caller needs the reason, and it is on the last line.
bu_last_error () {
  grep -v "^\s" "$WORK/bu.err" 2>/dev/null | tail -2 | tr "\n" " " | tail -c 300
}
