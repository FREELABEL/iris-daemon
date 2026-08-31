#!/bin/bash
# ─────────────────────────────────────────────────────────────
# IRIS Daemon Wrapper — Loads config and execs Node.js daemon
#
# macOS LaunchAgent plists can't read JSON config files or
# resolve complex PATH setups (nvm, homebrew, etc.). This
# wrapper bridges the gap:
#   1. Resolves PATH to find node (homebrew, nvm, system)
#   2. Reads ~/.iris/config.json for API key + hub URL
#   3. Exports env vars
#   4. exec's the daemon (replaces this process)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

IRIS_DIR="${HOME}/.iris"
CONFIG_FILE="${IRIS_DIR}/config.json"
DAEMON_DIR="${IRIS_DIR}/daemon"

# Say WHERE this aborted. `set -e` plus launchd's bare environment means any unexpected
# failure kills the wrapper with no output at all — the daemon simply never appears, and
# launchd reports nothing useful. A client spent 2026-08-31 chasing exactly this: "the wrapper
# is running but not reaching the echo", diagnosed only by adding debug lines by hand.
# One trap turns a silent death into a line naming the command and the line number.
trap 'echo "iris-daemon-wrapper: aborted at line $LINENO: $BASH_COMMAND" >&2' ERR

# ─── Resolve PATH ─────────────────────────────────────────────
# LaunchAgents get a minimal PATH. We need to find node.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

# The installer's own Node, which lives in $HOME and is NOT on any system path.
# Added 2026-08-31 together with the installer step that puts it there: without this the
# wrapper cannot see the very Node the installer just provided, and under `set -e` that is a
# silent abort — the daemon looks broken on a machine where Node is definitely installed.
# Glob rather than a pinned version so a Node upgrade does not orphan the daemon.
for _iris_node in "${IRIS_DIR}"/runtime/node-*/bin; do
  [ -d "$_iris_node" ] && export PATH="$_iris_node:${PATH}"
done

# nvm (common Node.js version manager)
if [ -s "${HOME}/.nvm/nvm.sh" ]; then
  export NVM_DIR="${HOME}/.nvm"
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh" --no-use 2>/dev/null || true
  # Use default nvm node if available
  if [ -d "${NVM_DIR}/versions/node" ]; then
    NVM_NODE=$(ls -1 "${NVM_DIR}/versions/node/" 2>/dev/null | sort -V | tail -1)
    if [ -n "${NVM_NODE}" ]; then
      export PATH="${NVM_DIR}/versions/node/${NVM_NODE}/bin:${PATH}"
    fi
  fi
fi

# fnm (another popular Node.js version manager)
if [ -d "${HOME}/.fnm" ]; then
  export PATH="${HOME}/.fnm:${PATH}"
  eval "$(fnm env --shell bash 2>/dev/null)" || true
fi

# Volta
if [ -d "${HOME}/.volta" ]; then
  export PATH="${HOME}/.volta/bin:${PATH}"
fi

# Verify node is available
if ! command -v node &>/dev/null; then
  echo "[iris-daemon] ERROR: Node.js not found in PATH" >&2
  echo "[iris-daemon] Install via: brew install node@20" >&2
  exit 1
fi

# ─── Read Config ──────────────────────────────────────────────
if [ ! -f "${CONFIG_FILE}" ]; then
  echo "[iris-daemon] ERROR: Config file not found: ${CONFIG_FILE}" >&2
  echo "[iris-daemon] Run the installer first: bash ~/.iris/daemon/installers/install.sh" >&2
  exit 1
fi

# Parse config.json using node (guaranteed available at this point)
eval "$(node -e "
  const c = require('${CONFIG_FILE}');
  if (c.node_api_key) console.log('export NODE_API_KEY=' + JSON.stringify(c.node_api_key));
  if (c.iris_api_url) console.log('export IRIS_API_URL=' + JSON.stringify(c.iris_api_url));
  if (c.pusher_key) console.log('export PUSHER_KEY=' + JSON.stringify(c.pusher_key));
  if (c.pusher_cluster) console.log('export PUSHER_CLUSTER=' + JSON.stringify(c.pusher_cluster));
" 2>/dev/null)"

# Data directory
export DAEMON_DATA_DIR="${IRIS_DIR}/data"

# Freelabel project root (needed for som/leadgen/discover task types)
# Auto-detect: config.json > symlink resolution > env var
if [ -z "${FREELABEL_PATH:-}" ]; then
  # Check config.json first
  FL_PATH=$(node -e "try { const c = require('${CONFIG_FILE}'); if (c.freelabel_path) console.log(c.freelabel_path); } catch {}" 2>/dev/null || true)

  # Fallback: if ~/.iris/daemon is a symlink, resolve it (e.g. -> /Users/x/Sites/freelabel/fl-docker-dev/coding-agent-bridge)
  if [ -z "${FL_PATH}" ] && [ -L "${DAEMON_DIR}" ]; then
    REAL_DAEMON=$(readlink -f "${DAEMON_DIR}" 2>/dev/null || python3 -c "import os; print(os.path.realpath('${DAEMON_DIR}'))" 2>/dev/null || true)
    # Walk up from coding-agent-bridge -> fl-docker-dev -> freelabel
    if [ -n "${REAL_DAEMON}" ]; then
      CANDIDATE=$(dirname "$(dirname "${REAL_DAEMON}")")
      if [ -f "${CANDIDATE}/package.json" ]; then
        FL_PATH="${CANDIDATE}"
      fi
    fi
  fi

  if [ -n "${FL_PATH}" ]; then
    export FREELABEL_PATH="${FL_PATH}"
  fi
fi

# ─── Launch Daemon ────────────────────────────────────────────
cd "${DAEMON_DIR}"
exec node daemon.js
