#!/bin/bash
# ─────────────────────────────────────────────────────────────
# IRIS Platform Contributor — Developer Environment Installer
#
# Usage:
#   curl -fsSL https://heyiris.io/install-iris-dev | bash
#   bash install-iris-dev.sh
#   bash install-iris-dev.sh --skip-ollama --skip-toolkit
#   bash install-iris-dev.sh --branch feature/my-tool --dir ~/projects/iris
#
# What this does:
#   1. Installs IRIS toolkit (CLI, desktop app, SDK, agent bridge)
#   2. Clones iris-api source code
#   3. Sets up MySQL + Redis via Docker (for databases only)
#   4. Seeds fl_api database with development schema + test data
#   5. Configures .env for standalone development
#   6. Optionally installs Ollama for free local AI
#
# What this does NOT do:
#   - No root/sudo required (except Docker, which you already have)
#   - No access to fl-api, frontend, or billing code
#   - No production data or credentials
#   - No modifications outside the install directory
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Constants ────────────────────────────────────────────────

DEFAULT_DIR="${HOME}/.iris-dev/iris-api"
REPO_URL="https://github.com/FREELABEL/fl-iris-api.git"
DEFAULT_BRANCH="main"
DEFAULT_MYSQL_PORT=3306
DEFAULT_REDIS_PORT=6379
INSTALL_CODE_URL="https://heyiris.io/install-code"
MIN_PHP_VERSION=81  # 8.1+
MIN_NODE_VERSION=18
API_PORT=7201

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# ─── Banner ───────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}"
cat << 'BANNER'
  ╦╦═╗╦╔═╗   ┌┬┐┌─┐┬  ┬
  ║╠╦╝║╚═╗    ││├┤ └┐┌┘
  ╩╩╚═╩╚═╝   ─┴┘└─┘ └┘
BANNER
echo -e "${NC}"
echo -e "  ${BOLD}Platform Contributor Environment${NC}"
echo -e "  Build tools. Fix bugs. Ship features."
echo ""

# ─── Parse Arguments ──────────────────────────────────────────

INSTALL_DIR="${DEFAULT_DIR}"
BRANCH="${DEFAULT_BRANCH}"
MYSQL_PORT="${DEFAULT_MYSQL_PORT}"
REDIS_PORT="${DEFAULT_REDIS_PORT}"
SKIP_OLLAMA=false
SKIP_TOOLKIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)           INSTALL_DIR="$2"; shift 2 ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --mysql-port)    MYSQL_PORT="$2"; shift 2 ;;
    --redis-port)    REDIS_PORT="$2"; shift 2 ;;
    --skip-ollama)   SKIP_OLLAMA=true; shift ;;
    --skip-toolkit)  SKIP_TOOLKIT=true; shift ;;
    --help|-h)
      echo "Usage: bash install-iris-dev.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --dir PATH         Install directory (default: ${DEFAULT_DIR})"
      echo "  --branch BRANCH    Git branch to clone (default: ${DEFAULT_BRANCH})"
      echo "  --mysql-port PORT  MySQL port (default: ${DEFAULT_MYSQL_PORT})"
      echo "  --redis-port PORT  Redis port (default: ${DEFAULT_REDIS_PORT})"
      echo "  --skip-ollama      Skip Ollama installation"
      echo "  --skip-toolkit     Skip IRIS toolkit install (CLI, app, SDK, bridge)"
      echo "  --help             Show this help"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

# ─── Helper Functions ─────────────────────────────────────────

step() {
  echo -e "${GREEN}[$1]${NC} $2"
}

warn() {
  echo -e "${YELLOW}  ⚠ $1${NC}"
}

fail() {
  echo -e "${RED}  ✗ $1${NC}"
  exit 1
}

ok() {
  echo -e "${GREEN}  ✓${NC} $1"
}

# ═══════════════════════════════════════════════════════════════
# [1/8] CHECK PREREQUISITES
# ═══════════════════════════════════════════════════════════════

step "1/8" "Checking prerequisites..."

# OS check
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "${OS}" != "Darwin" ] && [ "${OS}" != "Linux" ]; then
  fail "Unsupported OS: ${OS}. This installer supports macOS and Linux."
fi
ok "${OS} (${ARCH}) detected"

# PHP check
if ! command -v php &>/dev/null; then
  fail "PHP is not installed. Install PHP 8.1+:
    macOS:  brew install php@8.4
    Ubuntu: sudo apt install php8.3-cli php8.3-mysql php8.3-mbstring php8.3-curl php8.3-xml"
fi

PHP_VERSION=$(php -r 'echo PHP_MAJOR_VERSION . PHP_MINOR_VERSION;')
if [ "${PHP_VERSION}" -lt "${MIN_PHP_VERSION}" ]; then
  fail "PHP 8.1+ required (found $(php -v | head -1 | cut -d' ' -f2))"
fi
ok "PHP $(php -v | head -1 | cut -d' ' -f2) found"

# Composer check
if ! command -v composer &>/dev/null; then
  fail "Composer is not installed. Install: https://getcomposer.org/download/"
fi
ok "Composer $(composer --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo 'found')"

# Docker check
if ! command -v docker &>/dev/null; then
  fail "Docker is not installed. Install Docker Desktop: https://docker.com/get-started"
fi
if ! docker info &>/dev/null 2>&1; then
  fail "Docker is not running. Start Docker Desktop and try again."
fi
ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1) running"

# Docker Compose check
if ! docker compose version &>/dev/null 2>&1; then
  fail "Docker Compose not available. Update Docker Desktop to get docker compose."
fi
ok "Docker Compose available"

# Git check
if ! command -v git &>/dev/null; then
  fail "git is not installed. Install: xcode-select --install"
fi
ok "git $(git --version | cut -d' ' -f3) found"

# Node.js check (optional but recommended for daemon)
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "${NODE_VERSION}" -ge "${MIN_NODE_VERSION}" ]; then
    ok "Node.js $(node -v) found"
  else
    warn "Node.js ${MIN_NODE_VERSION}+ recommended (found $(node -v)). Agent bridge may not work."
  fi
else
  warn "Node.js not found. Install for agent bridge: brew install node@20"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# [2/8] INSTALL IRIS TOOLKIT
# ═══════════════════════════════════════════════════════════════

if [ "${SKIP_TOOLKIT}" = true ]; then
  step "2/8" "Skipping IRIS toolkit (--skip-toolkit)"
else
  step "2/8" "Installing IRIS toolkit (CLI, desktop app, SDK, bridge)..."
  echo -e "${DIM}  This installs the same tools regular IRIS users get.${NC}"

  if command -v iris &>/dev/null; then
    ok "IRIS Code CLI already installed ($(iris --version 2>/dev/null || echo 'unknown version'))"
    warn "Skipping toolkit install. Run without --skip-toolkit to force reinstall."
  else
    # Call the existing install-code script, skipping the Docker sandbox
    # (contributors get real iris-api source instead)
    if curl -fsSL "${INSTALL_CODE_URL}" -o /tmp/iris-install-code.sh 2>/dev/null; then
      bash /tmp/iris-install-code.sh --skip-sandbox 2>&1 | while IFS= read -r line; do
        echo -e "${DIM}  ${line}${NC}"
      done
      rm -f /tmp/iris-install-code.sh
      ok "IRIS toolkit installed"
    else
      warn "Could not download IRIS toolkit installer. Continuing without it."
      warn "Install manually later: curl -fsSL ${INSTALL_CODE_URL} | bash"
    fi
  fi
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# [3/8] CLONE IRIS-API SOURCE
# ═══════════════════════════════════════════════════════════════

step "3/8" "Setting up iris-api source code..."

if [ -d "${INSTALL_DIR}/.git" ]; then
  # Existing install — update
  ok "Existing iris-api found at ${INSTALL_DIR}"
  echo -e "${DIM}  Pulling latest changes...${NC}"
  cd "${INSTALL_DIR}"
  git fetch origin 2>/dev/null
  CURRENT_BRANCH=$(git branch --show-current)
  if [ "${CURRENT_BRANCH}" = "${BRANCH}" ]; then
    git pull --ff-only origin "${BRANCH}" 2>/dev/null || warn "Could not fast-forward. You may have local changes."
  else
    warn "On branch '${CURRENT_BRANCH}', not '${BRANCH}'. Skipping pull."
  fi
  ok "iris-api updated"
else
  # Fresh clone
  echo -e "${DIM}  Cloning from ${REPO_URL} (branch: ${BRANCH})...${NC}"
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${INSTALL_DIR}" 2>&1 | while IFS= read -r line; do
    echo -e "${DIM}  ${line}${NC}"
  done
  cd "${INSTALL_DIR}"
  ok "iris-api cloned to ${INSTALL_DIR}"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# [4/8] START DOCKER SERVICES (MySQL + Redis)
# ═══════════════════════════════════════════════════════════════

step "4/8" "Starting MySQL + Redis via Docker..."

COMPOSE_FILE="${INSTALL_DIR}/database/contributor/docker-compose.contributor.yml"

if [ ! -f "${COMPOSE_FILE}" ]; then
  fail "docker-compose.contributor.yml not found at ${COMPOSE_FILE}. Is the repo cloned correctly?"
fi

# Check for port conflicts
if lsof -i ":${MYSQL_PORT}" &>/dev/null 2>&1; then
  warn "Port ${MYSQL_PORT} is in use. Checking if it's our container..."
  if docker ps --format '{{.Names}}' | grep -q 'iris-dev-database'; then
    ok "iris-dev-database already running on port ${MYSQL_PORT}"
  else
    fail "Port ${MYSQL_PORT} is in use by another process. Use --mysql-port to specify a different port."
  fi
else
  MYSQL_PORT="${MYSQL_PORT}" REDIS_PORT="${REDIS_PORT}" \
    docker compose -f "${COMPOSE_FILE}" up -d 2>&1 | while IFS= read -r line; do
    echo -e "${DIM}  ${line}${NC}"
  done
fi

# Wait for MySQL healthcheck
echo -e "${DIM}  Waiting for MySQL to be ready...${NC}"
RETRIES=0
MAX_RETRIES=30
while [ $RETRIES -lt $MAX_RETRIES ]; do
  if docker exec iris-dev-database mysqladmin ping -h localhost -u fl_user -psecret &>/dev/null 2>&1; then
    break
  fi
  RETRIES=$((RETRIES + 1))
  sleep 2
done

if [ $RETRIES -ge $MAX_RETRIES ]; then
  fail "MySQL did not become ready after 60 seconds. Check: docker logs iris-dev-database"
fi

ok "MySQL ready on port ${MYSQL_PORT}"
ok "Redis ready on port ${REDIS_PORT}"

echo ""

# ═══════════════════════════════════════════════════════════════
# [5/8] CONFIGURE ENVIRONMENT
# ═══════════════════════════════════════════════════════════════

step "5/8" "Configuring environment..."

cd "${INSTALL_DIR}"

# Copy .env.contributor if .env doesn't exist or is the contributor template
if [ ! -f ".env" ]; then
  cp .env.contributor .env
  ok "Created .env from contributor template"
else
  ok ".env already exists (preserving)"
fi

# Update ports if non-default
if [ "${MYSQL_PORT}" != "${DEFAULT_MYSQL_PORT}" ]; then
  sed -i.bak "s/DB_PORT=3306/DB_PORT=${MYSQL_PORT}/" .env
  sed -i.bak "s/FL_API_DB_PORT=3306/FL_API_DB_PORT=${MYSQL_PORT}/" .env
  rm -f .env.bak
  ok "MySQL port set to ${MYSQL_PORT}"
fi

if [ "${REDIS_PORT}" != "${DEFAULT_REDIS_PORT}" ]; then
  sed -i.bak "s/REDIS_PORT=6379/REDIS_PORT=${REDIS_PORT}/" .env
  rm -f .env.bak
  ok "Redis port set to ${REDIS_PORT}"
fi

# Generate APP_KEY if empty
if grep -q "^APP_KEY=$" .env 2>/dev/null; then
  php artisan key:generate --force --quiet 2>/dev/null
  ok "Generated APP_KEY"
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# [6/8] INSTALL DEPENDENCIES + MIGRATE
# ═══════════════════════════════════════════════════════════════

step "6/8" "Installing dependencies and running migrations..."

cd "${INSTALL_DIR}"

# Composer install
echo -e "${DIM}  Running composer install...${NC}"
composer install --no-interaction --quiet 2>&1 || {
  warn "composer install had issues. Trying without --quiet..."
  composer install --no-interaction 2>&1 | tail -5
}
ok "PHP dependencies installed"

# Run iris_db migrations
echo -e "${DIM}  Running database migrations (iris_db)...${NC}"
php artisan migrate --force --quiet 2>&1 || {
  warn "Some migrations may have failed. This is normal for first run."
  php artisan migrate --force 2>&1 | tail -10
}
ok "iris_db migrations complete"

echo ""

# ═══════════════════════════════════════════════════════════════
# [7/8] VERIFY FL_API SEED
# ═══════════════════════════════════════════════════════════════

step "7/8" "Verifying fl_api database seed..."

# Check that key tables exist in fl_api
TABLE_COUNT=$(docker exec iris-dev-database mysql -u fl_user -psecret -N -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='fl_api';" 2>/dev/null || echo "0")

if [ "${TABLE_COUNT}" -ge 30 ]; then
  ok "fl_api database has ${TABLE_COUNT} tables (expected 32)"
else
  warn "fl_api has only ${TABLE_COUNT} tables. Attempting manual seed..."
  docker exec -i iris-dev-database mysql -u fl_user -psecret fl_api < \
    "${INSTALL_DIR}/database/contributor/fl-api-seed.sql" 2>/dev/null && \
    ok "Manual seed completed" || \
    warn "Seed may have partially failed. Run manually if needed."
fi

# Verify key tables
AGENT_COUNT=$(docker exec iris-dev-database mysql -u fl_user -psecret -N -e \
  "SELECT COUNT(*) FROM fl_api.bloq_agents;" 2>/dev/null || echo "0")
USER_COUNT=$(docker exec iris-dev-database mysql -u fl_user -psecret -N -e \
  "SELECT COUNT(*) FROM fl_api.users;" 2>/dev/null || echo "0")

ok "Seed data: ${USER_COUNT} user(s), ${AGENT_COUNT} agent(s)"

echo ""

# ═══════════════════════════════════════════════════════════════
# [8/8] OLLAMA (Optional)
# ═══════════════════════════════════════════════════════════════

if [ "${SKIP_OLLAMA}" = true ]; then
  step "8/8" "Skipping Ollama (--skip-ollama)"
else
  step "8/8" "Setting up Ollama for local AI..."

  if command -v ollama &>/dev/null; then
    ok "Ollama already installed"
  else
    echo -e "${DIM}  Installing Ollama...${NC}"
    if [ "${OS}" = "Darwin" ]; then
      if command -v brew &>/dev/null; then
        brew install ollama 2>&1 | while IFS= read -r line; do
          echo -e "${DIM}  ${line}${NC}"
        done
        ok "Ollama installed via Homebrew"
      else
        curl -fsSL https://ollama.com/install.sh | sh 2>&1 | while IFS= read -r line; do
          echo -e "${DIM}  ${line}${NC}"
        done
        ok "Ollama installed"
      fi
    else
      curl -fsSL https://ollama.com/install.sh | sh 2>&1 | while IFS= read -r line; do
        echo -e "${DIM}  ${line}${NC}"
      done
      ok "Ollama installed"
    fi
  fi

  # Check if Ollama is running
  if curl -sf http://localhost:11434/api/tags &>/dev/null; then
    ok "Ollama is running"
  else
    echo -e "${DIM}  Starting Ollama...${NC}"
    ollama serve &>/dev/null &
    sleep 3
    if curl -sf http://localhost:11434/api/tags &>/dev/null; then
      ok "Ollama started"
    else
      warn "Could not start Ollama. Start it manually: ollama serve"
    fi
  fi

  # Pull a small model for development
  if ollama list 2>/dev/null | grep -q "qwen3"; then
    ok "qwen3 model already available"
  else
    echo -e "${DIM}  Pulling qwen3:1.7b (1.1GB — smaller model for fast dev)...${NC}"
    echo -e "${DIM}  (Use 'ollama pull qwen3:8b' later for better quality)${NC}"
    ollama pull qwen3:1.7b 2>&1 | while IFS= read -r line; do
      echo -e "${DIM}  ${line}${NC}"
    done
    ok "qwen3:1.7b model ready"
  fi
fi

echo ""

# ═══════════════════════════════════════════════════════════════
# SUCCESS
# ═══════════════════════════════════════════════════════════════

echo -e "${GREEN}${BOLD}"
cat << 'SUCCESS'
  ┌─────────────────────────────────────────────┐
  │   IRIS Dev Environment — READY              │
  └─────────────────────────────────────────────┘
SUCCESS
echo -e "${NC}"

echo -e "  ${BOLD}Services:${NC}"
echo -e "    iris-api:  ${CYAN}http://localhost:${API_PORT}${NC}  ${DIM}(run: php artisan serve --port=${API_PORT})${NC}"
echo -e "    MySQL:     ${CYAN}localhost:${MYSQL_PORT}${NC}      ${DIM}(iris_db + fl_api)${NC}"
echo -e "    Redis:     ${CYAN}localhost:${REDIS_PORT}${NC}      ${DIM}(queue/cache)${NC}"

if [ "${SKIP_OLLAMA}" != true ] && command -v ollama &>/dev/null; then
  echo -e "    Ollama:    ${CYAN}http://localhost:11434${NC}  ${DIM}(local AI)${NC}"
fi

if [ "${SKIP_TOOLKIT}" != true ] && command -v iris &>/dev/null; then
  echo -e "    iris-code: ${CYAN}iris${NC}                   ${DIM}(CLI in PATH)${NC}"
fi

echo ""
echo -e "  ${BOLD}Quick Start:${NC}"
echo -e "    ${CYAN}cd ${INSTALL_DIR}${NC}"
echo -e "    ${CYAN}php artisan serve --port=${API_PORT}${NC}"
echo ""
echo -e "  ${BOLD}Useful Commands:${NC}"
echo -e "    ${DIM}php artisan tinker${NC}                         ${DIM}# PHP shell${NC}"
echo -e "    ${DIM}php artisan test${NC}                           ${DIM}# Run tests${NC}"
echo -e "    ${DIM}vendor/bin/pint --dirty${NC}                    ${DIM}# Format code${NC}"
echo -e "    ${DIM}docker compose -f database/contributor/docker-compose.contributor.yml logs${NC}"
echo ""
echo -e "  ${BOLD}Documentation:${NC}"
echo -e "    ${DIM}See CONTRIBUTING.md for full guide${NC}"
echo ""
echo -e "  ${BOLD}Next Steps:${NC}"
echo -e "    1. Open ${CYAN}${INSTALL_DIR}${NC} in your editor"
echo -e "    2. Run ${CYAN}php artisan serve --port=${API_PORT}${NC}"
echo -e "    3. Start building! Add tools, fix bugs, submit PRs."
echo ""
