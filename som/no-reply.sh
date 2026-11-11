#!/usr/bin/env bash
# Gone-quiet list (#192438). Read-only: writes ~/.iris/data/no-reply-latest.json for the daily digest.
set -euo pipefail
cd "$(dirname "$0")"
for env_file in "$HOME/.iris/bridge/.env" "$HOME/.iris/sdk/.env" "$HOME/.iris/env" .env; do
  if [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi
done
exec node no-reply.js "$@"
