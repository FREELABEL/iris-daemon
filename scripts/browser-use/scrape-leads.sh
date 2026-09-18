#!/usr/bin/env bash
# scrape-leads.sh <url> [<url> ...] [--follow team,about,...] [--no-follow] [--max-pages N]
#                                  [--next "Next"] [--delay SECONDS]
#
# Reads PUBLIC pages in a throwaway headless Chrome and extracts people and company contacts:
# schema.org Person data, team-card blocks, loose mailto:/tel: links. Deterministic — no model.
# Obeys robots.txt, waits between pages, follows only same-site links, pages directories with
# safe_click (refuses a covered or ambiguous "Next"). No login, so no logged-in session.
#
# Prints one JSON object. Exit codes — three states, never two:
#   0  read pages, found leads or company contacts
#   1  read pages, found nothing (a real answer)
#   2  could not read any page (unreachable, robots.txt, no Chrome) — NOT "no leads"
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URLS=() FOLLOW="team,about,people,leadership,staff,our-team,who-we-are,contact,speakers,members,directory,partners,attorneys,doctors,faculty"
MAX=6 NEXT="" DELAY=1.5
while [ $# -gt 0 ]; do
  case "$1" in
    --follow) FOLLOW="$2"; shift 2 ;;
    --no-follow) FOLLOW=""; shift ;;
    --max-pages) MAX="$2"; shift 2 ;;
    --next) NEXT="$2"; shift 2 ;;
    --delay) DELAY="$2"; shift 2 ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    *) URLS+=("$1"); shift ;;
  esac
done
FIRST="${URLS[0]:-}"
cant() {
  python3 -c 'import json,sys; print(json.dumps({"ok": False, "measured": False, "url": sys.argv[1], "error": sys.argv[2]}))' "$FIRST" "$1"
  exit 2
}
[ ${#URLS[@]} -gt 0 ] || { echo "usage: scrape-leads.sh <url> [<url> ...]" >&2; exit 2; }
for u in "${URLS[@]}"; do case "$u" in http://*|https://*) ;; *) cant "url must be http(s): $u" ;; esac; done
case "$MAX" in ''|*[!0-9]*) cant "--max-pages must be a number" ;; esac
[ "$MAX" -le 50 ] || cant "--max-pages is capped at 50 — this reads someone else's site"

# shellcheck source=_chrome.sh
. "$HERE/_chrome.sh"
bu_start scrape-leads

RAW="$(SL_URLS="$(printf '%s\n' "${URLS[@]}")" SL_FOLLOW="$FOLLOW" SL_MAX_PAGES="$MAX" SL_NEXT="$NEXT" \
  SL_DELAY="$DELAY" "${BU[@]}" < "$HERE/scrape-leads.py" 2>"$WORK/bu.err")"
LINE="$(printf '%s\n' "$RAW" | grep '^SL_RESULT=' | tail -1)"
[ -n "$LINE" ] || cant "browser-use failed: $(bu_last_error)"
JSON="${LINE#SL_RESULT=}"
echo "$JSON"
printf '%s' "$JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(2 if not d.get("measured") else (0 if d["ok"] else 1))'
