#!/usr/bin/env bash
# Standalone Instagram reply capture (#191269).
#
# Read-only: it opens each account's DM inbox, reads every thread it can reach, and writes
# the replies to the CRM. It never sends a message and never runs the outreach batch.
#
# Run it from cron / systemd / a Hive schedule, not from a send run:
#
#   17 * * * *  cd /path/to/coding-agent-bridge/som && ./capture-replies.sh >> ../test-results/capture-replies.log 2>&1
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

if [ -z "${HEYIRIS_TOKEN:-}" ]; then
  echo "capture-replies: HEYIRIS_TOKEN is not set" >&2
  exit 1
fi

mkdir -p ../test-results

exec npx playwright test capture-replies.spec.ts "${@}"
