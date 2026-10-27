#!/usr/bin/env bash
# Standalone Instagram reply capture (#191269).
#
# Read-only: it opens each account's DM inbox, reads every thread it can reach, and writes
# the replies to the CRM. It never sends a message and never runs the outreach batch.
#
# Run it from cron / systemd / a Hive schedule, not from a send run:
#
#   7 * * * *  flock -n /tmp/iris-reply-capture.lock ~/.iris/bridge/som/capture-replies.sh >> ~/.iris/data/reply-capture.log 2>&1
#   Daily email: 45 13 * * *  ~/.iris/bridge/som/reply-digest.sh >> ~/.iris/data/reply-digest.log 2>&1
#
# Configuration (env or ~/.iris/bridge/.env):
#   HEYIRIS_TOKEN        required
#   CAPTURE_ACCOUNTS     "heyiris.io:38,thediscoverpage_:80"
#                        (or IG_ACCOUNT + BOARD_ID for one account)
#   CAPTURE_LIMIT        max conversations per account (default 500)
#   CAPTURE_SCROLLS      scroll attempts per account (default 60)
#   IRIS_FL_API_URL      default https://raichu.heyiris.io
#   DRY_RUN=1            match and report, write nothing
set -euo pipefail

cd "$(dirname "$0")"

for env_file in "$HOME/.iris/bridge/.env" "$HOME/.iris/sdk/.env" .env; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
done

# The SDK login writes IRIS_API_KEY; the specs read HEYIRIS_TOKEN.
export HEYIRIS_TOKEN="${HEYIRIS_TOKEN:-${IRIS_API_KEY:-}}"

if [ -z "${HEYIRIS_TOKEN:-}" ]; then
  echo "capture-replies: HEYIRIS_TOKEN is not set" >&2
  exit 1
fi

mkdir -p ../test-results

# playwright.config.ts runs headed; a server with no display needs a virtual one.
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a npx playwright test capture-replies.spec.ts --config playwright.config.ts "${@}"
fi
exec npx playwright test capture-replies.spec.ts --config playwright.config.ts "${@}"
