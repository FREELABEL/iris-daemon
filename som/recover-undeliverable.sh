#!/usr/bin/env bash
# Find leads already burned by "this account can't receive your message" and reclassify them (#192164).
# Reads each account's inbox the way capture-replies does: read-only, never opens a thread.
#
#   ./recover-undeliverable.sh            report, writes nothing
#   ./recover-undeliverable.sh --apply    write
#
# RECOVER_ACCOUNTS  "heyiris.io:38,thediscoverpage_:80" (account:boardId)
# RECOVER_LIMIT     threads per tab, default 500
set -euo pipefail
cd "$(dirname "$0")"
for env_file in "$HOME/.iris/bridge/.env" "$HOME/.iris/sdk/.env" .env; do
  if [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi
done
export HEYIRIS_TOKEN="${HEYIRIS_TOKEN:-${IRIS_API_KEY:-}}"
[ -n "$HEYIRIS_TOKEN" ] || { echo "recover-undeliverable: HEYIRIS_TOKEN is not set" >&2; exit 1; }
RECOVER_APPLY=0
for a in "$@"; do
  case "$a" in
    --apply) RECOVER_APPLY=1 ;;
    *) echo "recover-undeliverable: unknown argument $a" >&2; exit 2 ;;
  esac
done
export RECOVER_APPLY
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a npx playwright test recover-undeliverable.spec.ts --config playwright.config.ts --retries=0
fi
exec npx playwright test recover-undeliverable.spec.ts --config playwright.config.ts --retries=0
