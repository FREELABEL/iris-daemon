#!/usr/bin/env bash
# Daily reply triage email (#191273). Reads the capture log, drafts the top five, emails it.
# Nothing is sent to anyone on Instagram. DRY_RUN=1 writes a preview instead of emailing.
set -euo pipefail
cd "$(dirname "$0")"
for env_file in "$HOME/.iris/bridge/.env" "$HOME/.iris/sdk/.env" "$HOME/.iris/env" .env; do
  if [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; fi
done
exec node reply-digest.js "$@"
