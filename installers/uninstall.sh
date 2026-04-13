#!/bin/bash
# ─────────────────────────────────────────────────────────────
# IRIS Compute Node — Uninstaller (macOS)
#
# Usage:
#   bash uninstall.sh           Interactive (asks before removing data)
#   bash uninstall.sh --purge   Remove everything including ~/.iris/
# ─────────────────────────────────────────────────────────────

set -euo pipefail

IRIS_DIR="${HOME}/.iris"
PLIST_NAME="io.heyiris.daemon.plist"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_NAME}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PURGE=false
if [[ "${1:-}" == "--purge" ]]; then
  PURGE=true
fi

echo ""
echo -e "${BOLD}IRIS Compute Node — Uninstaller${NC}"
echo ""

# ─── Stop LaunchAgent ─────────────────────────────────────────

if launchctl list 2>/dev/null | grep -q "io.heyiris.daemon"; then
  echo -e "${YELLOW}Stopping daemon...${NC}"
  launchctl unload "${PLIST_PATH}" 2>/dev/null || true
  echo -e "${GREEN}  Daemon stopped${NC}"
else
  echo "  Daemon is not running"
fi

# ─── Remove plist ─────────────────────────────────────────────

if [ -f "${PLIST_PATH}" ]; then
  rm -f "${PLIST_PATH}"
  echo -e "${GREEN}  LaunchAgent removed${NC}"
else
  echo "  LaunchAgent not found (already removed)"
fi

# ─── Remove CLI symlink ──────────────────────────────────────

if [ -L "/usr/local/bin/iris-daemon" ]; then
  rm -f "/usr/local/bin/iris-daemon" 2>/dev/null || true
  echo -e "${GREEN}  CLI symlink removed (/usr/local/bin/iris-daemon)${NC}"
fi

if [ -L "${HOME}/.local/bin/iris-daemon" ]; then
  rm -f "${HOME}/.local/bin/iris-daemon" 2>/dev/null || true
  echo -e "${GREEN}  CLI symlink removed (~/.local/bin/iris-daemon)${NC}"
fi

# ─── Remove PID + status files ────────────────────────────────

rm -f "${IRIS_DIR}/daemon.pid" 2>/dev/null || true
rm -f "${IRIS_DIR}/status.json" 2>/dev/null || true

# ─── Remove data ──────────────────────────────────────────────

if [ "${PURGE}" = true ]; then
  REMOVE_DATA=true
else
  echo ""
  echo -e "${YELLOW}Remove all IRIS data (~/.iris/)?${NC}"
  echo "  This includes config, logs, hardware profile, and daemon code."
  echo -n "  Remove? [y/N]: "
  read -r ANSWER
  REMOVE_DATA=false
  if [[ "${ANSWER}" =~ ^[Yy]$ ]]; then
    REMOVE_DATA=true
  fi
fi

if [ "${REMOVE_DATA}" = true ]; then
  rm -rf "${IRIS_DIR}"
  echo -e "${GREEN}  ~/.iris/ removed${NC}"
else
  echo "  ~/.iris/ preserved (config and logs kept)"
  echo "  To remove later: rm -rf ~/.iris/"
fi

# ─── Done ─────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}IRIS Compute Node uninstalled.${NC}"
echo ""
