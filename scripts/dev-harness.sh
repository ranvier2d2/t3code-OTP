#!/usr/bin/env bash
set -euo pipefail

# ─── dev-harness.sh — Start the full T3Code harness stack ───────────
# Starts: Elixir harness (4321) + Node server (3773) + Vite (5733)
# Usage:  ./scripts/dev-harness.sh
# ────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

PORT_HARNESS="${T3CODE_HARNESS_PORT:-4321}"
PORT_SERVER="${T3CODE_PORT:-3780}"
PORT_VITE="${PORT:-5734}"
SECRET="${T3CODE_HARNESS_SECRET:-dev-harness-secret}"
STATE_DIR="${T3CODE_HOME:-/tmp/t3code-harness-dev}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${BLUE}[harness]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*"; exit 1; }

cleanup() {
  log "Shutting down..."
  kill $(jobs -p) 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

# ─── Raise FD limit for concurrent provider sessions ──────────────
# Each Erlang Port (provider session) uses ~3 FDs (stdin/stdout/stderr).
# macOS launchd soft limit is 256 — too low for 100+ sessions.
ulimit -n 10240 2>/dev/null || true

# ─── Kill stale processes ──────────────────────────────────────────
log "Killing stale processes on ports $PORT_HARNESS, $PORT_SERVER, $PORT_VITE..."
kill $(lsof -ti:$PORT_HARNESS) 2>/dev/null || true
kill $(lsof -ti:$PORT_SERVER) 2>/dev/null || true
kill $(lsof -ti:$PORT_VITE) 2>/dev/null || true
sleep 1

# ─── 1. Start Elixir harness ──────────────────────────────────────
log "Starting Elixir harness on port $PORT_HARNESS..."
(
  cd apps/harness
  T3CODE_HARNESS_PORT=$PORT_HARNESS \
  T3CODE_HARNESS_SECRET=$SECRET \
  MIX_ENV=dev elixir -S mix phx.server 2>&1 | sed 's/^/  [elixir] /'
) &

# Wait for harness health
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:$PORT_HARNESS > /dev/null 2>&1; then
    ok "Elixir harness ready on port $PORT_HARNESS"
    break
  fi
  if [ "$i" -eq 30 ]; then
    fail "Elixir harness failed to start after 30s"
  fi
  sleep 1
done

# ─── 2. Start Node server ─────────────────────────────────────────
log "Starting Node server on port $PORT_SERVER..."
T3CODE_HARNESS_PORT=$PORT_HARNESS \
T3CODE_HARNESS_SECRET=$SECRET \
T3CODE_MODE=web \
T3CODE_PORT=$PORT_SERVER \
T3CODE_HOME=$STATE_DIR \
T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1 \
VITE_DEV_SERVER_URL=http://localhost:$PORT_VITE \
bun run apps/server/src/index.ts 2>&1 | sed 's/^/  [node] /' &

sleep 3

# Wait for Node server
for i in $(seq 1 15); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT_SERVER 2>/dev/null | grep -q "302\|200"; then
    ok "Node server ready on port $PORT_SERVER"
    break
  fi
  if [ "$i" -eq 15 ]; then
    fail "Node server failed to start after 15s"
  fi
  sleep 1
done

# ─── 3. Start Vite dev server ─────────────────────────────────────
log "Starting Vite on port $PORT_VITE..."
(
  cd apps/web
  VITE_WS_URL=ws://localhost:$PORT_SERVER PORT=$PORT_VITE bun run vite --port $PORT_VITE 2>&1 | sed 's/^/  [vite] /'
) &

sleep 3
ok "Vite ready on port $PORT_VITE"

# ─── Ready ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${BOLD}  T3Code Harness Stack Ready${NC}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo -e "  Browser:  ${BOLD}http://localhost:$PORT_VITE${NC}"
echo -e "  Harness:  http://127.0.0.1:$PORT_HARNESS"
echo -e "  Server:   http://localhost:$PORT_SERVER"
echo ""
echo -e "  Press ${BOLD}Ctrl+C${NC} to stop all processes"
echo ""

# Wait for any child to exit
wait
