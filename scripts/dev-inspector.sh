#!/usr/bin/env bash
# =============================================================================
# dev-inspector.sh — one-command local dev for the Grafana MCP server.
#
# Prerequisites:
#   - Node.js 22+ (includes npm) — https://nodejs.org
#   - kubectl, configured to point at the dev cluster
#   - .env with GRAFANA_SERVICE_ACCOUNT_TOKEN set
#
# What it does (in order):
#   1. Loads .env (errors out if missing).
#   2. Verifies GRAFANA_SERVICE_ACCOUNT_TOKEN is set in .env.
#   3. Validates Node.js / npm versions.
#   4. Installs npm dependencies and builds the TypeScript sources.
#   5. Opens a kubectl port-forward to the in-cluster Grafana so the MCP
#      can reach it at http://localhost:${GRAFANA_LOCAL_PORT}.
#   6. Overrides GRAFANA_URL to that local tunnel for this run.
#   7. Starts the MCP server (HTTP transport) on ${PORT} in the background.
#   8. Launches the MCP Inspector pointed at the running server.
#
# Cleanup: kills the MCP server and port-forward on exit / Ctrl-C.
#
#
# Usage (from repo root): ./scripts/dev-inspector.sh
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
# Minimum supported Node.js major version.
MIN_NODE_MAJOR=22

# Local port the MCP server (HTTP transport) listens on.
PORT="${PORT:-3001}"
MCP_URL="http://localhost:${PORT}/mcp"

# Grafana tunnel config. This script always tunnels to the in-cluster Grafana
# and overrides GRAFANA_URL to point at the local tunnel — these defaults
# target the dev cluster but can be overridden via environment variables.
GRAFANA_NAMESPACE="${GRAFANA_NAMESPACE:-savannah-system}"
GRAFANA_SERVICE="${GRAFANA_SERVICE:-svc/monitoring-v2-grafana}"
GRAFANA_LOCAL_PORT="${GRAFANA_LOCAL_PORT:-3000}"
GRAFANA_REMOTE_PORT="${GRAFANA_REMOTE_PORT:-80}"

# Path to the locally installed MCP Inspector CLI (populated by `npm install`).
INSPECTOR="${ROOT}/node_modules/.bin/mcp-inspector"

# -----------------------------------------------------------------------------
# Runtime state (PIDs of background processes, used by cleanup trap)
# -----------------------------------------------------------------------------
MCP_PID=""
PF_PID=""

# -----------------------------------------------------------------------------
# Functions
# -----------------------------------------------------------------------------

# Verify Node.js and npm are installed and meet the minimum version.
require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed." >&2
    echo "Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org (npm is included)." >&2
    echo "  macOS:  brew install node" >&2
    echo "  Linux:  see https://nodejs.org/en/download/package-manager" >&2
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed (it normally ships with Node.js)." >&2
    echo "Reinstall Node.js from https://nodejs.org" >&2
    exit 1
  fi
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])")"
  if [[ "${major}" -lt "${MIN_NODE_MAJOR}" ]]; then
    echo "Node.js ${MIN_NODE_MAJOR}+ is required (found $(node -v))." >&2
    echo "Upgrade from https://nodejs.org" >&2
    exit 1
  fi
}

# Ensure a .env file exists. Bail out with a helpful message if not.
ensure_env_file() {
  if [[ -f .env ]]; then
    return
  fi
  echo "Missing .env. Create one with GRAFANA_SERVICE_ACCOUNT_TOKEN (see README.md)." >&2
  exit 1
}

# Export every variable defined in .env into the current shell environment.
load_env() {
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
}

# Install npm packages if node_modules / the boilerplate / the inspector
# binary are missing. Uses `npm ci` when a lockfile is present.
ensure_dependencies() {
  if [[ -d node_modules ]] && [[ -d node_modules/@tigerdata/mcp-boilerplate ]] \
    && [[ -x node_modules/.bin/mcp-inspector ]]; then
    return
  fi
  echo "Installing dependencies (first run may take a minute)..."
  if [[ -f package-lock.json ]]; then
    npm ci --no-fund --no-audit
  else
    npm install --no-fund --no-audit
  fi
}

# Build the TypeScript sources if dist/index.js is missing or older than
# the build inputs.
ensure_build() {
  if [[ -f dist/index.js ]] \
    && [[ dist/index.js -nt package.json ]] \
    && [[ dist/index.js -nt tsconfig.json ]]; then
    return
  fi
  echo "Building..."
  npm run build
}

# -----------------------------------------------------------------------------
# Main flow
# -----------------------------------------------------------------------------

# Load env first so we fail fast on missing config before doing anything else.
ensure_env_file
load_env

# Required secret must be present in .env.
if [[ -z "${GRAFANA_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  echo "GRAFANA_SERVICE_ACCOUNT_TOKEN is not set in .env" >&2
  exit 1
fi

# Preflight tooling.
require_node

# Install deps and (re)build the MCP server.
ensure_dependencies
ensure_build

# Sanity check that the inspector landed in node_modules.
if [[ ! -x "${INSPECTOR}" ]]; then
  echo "MCP Inspector binary not found after install." >&2
  exit 1
fi

# Stop background processes (MCP server, kubectl port-forward) cleanly.
# Wired to EXIT/INT/TERM so Ctrl-C also tears everything down.
cleanup() {
  if [[ -n "${MCP_PID}" ]] && kill -0 "${MCP_PID}" 2>/dev/null; then
    echo "Stopping MCP server (pid ${MCP_PID})..."
    kill "${MCP_PID}" 2>/dev/null || true
    wait "${MCP_PID}" 2>/dev/null || true
  fi
  if [[ -n "${PF_PID}" ]] && kill -0 "${PF_PID}" 2>/dev/null; then
    echo "Stopping kubectl port-forward (pid ${PF_PID})..."
    kill "${PF_PID}" 2>/dev/null || true
    wait "${PF_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Open a kubectl port-forward to the in-cluster Grafana so the MCP server
# can reach it via http://localhost:${GRAFANA_LOCAL_PORT}. Waits until the
# tunnel is accepting connections (or fails fast if kubectl exits early).
start_grafana_tunnel() {
  if nc -z localhost "${GRAFANA_LOCAL_PORT}" 2>/dev/null; then
    echo "Port ${GRAFANA_LOCAL_PORT} already in use; reusing existing tunnel."
    return
  fi
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl is required to tunnel to Grafana." >&2
    echo "Install kubectl and point your kubecontext at the dev cluster." >&2
    exit 1
  fi
  echo "Starting kubectl port-forward ${GRAFANA_SERVICE} -n ${GRAFANA_NAMESPACE} (${GRAFANA_LOCAL_PORT}:${GRAFANA_REMOTE_PORT})..."
  kubectl -n "${GRAFANA_NAMESPACE}" port-forward "${GRAFANA_SERVICE}" \
    "${GRAFANA_LOCAL_PORT}:${GRAFANA_REMOTE_PORT}" >/dev/null 2>&1 &
  PF_PID=$!
  for _ in $(seq 1 60); do
    if nc -z localhost "${GRAFANA_LOCAL_PORT}" 2>/dev/null; then
      echo "Grafana tunnel ready at http://localhost:${GRAFANA_LOCAL_PORT}"
      return
    fi
    if ! kill -0 "${PF_PID}" 2>/dev/null; then
      echo "kubectl port-forward exited unexpectedly. Is your kubecontext set to the right cluster?" >&2
      wait "${PF_PID}" 2>/dev/null || true
      PF_PID=""
      exit 1
    fi
    sleep 0.25
  done
  echo "kubectl port-forward did not become ready on port ${GRAFANA_LOCAL_PORT}." >&2
  exit 1
}

# Open the Grafana tunnel and force the MCP to use it, regardless of what
# .env says — this script is for local dev only.
start_grafana_tunnel
export GRAFANA_URL="http://localhost:${GRAFANA_LOCAL_PORT}"
echo "Overriding GRAFANA_URL=${GRAFANA_URL} for this run."

# Launch the MCP server in the background and wait until it's listening
# (or fail fast if it crashes during startup).
echo "Starting MCP server on port ${PORT}..."
node dist/index.js http &
MCP_PID=$!

echo "Waiting for MCP server..."
ready=false
for _ in $(seq 1 60); do
  if nc -z localhost "${PORT}" 2>/dev/null; then
    ready=true
    break
  fi
  if ! kill -0 "${MCP_PID}" 2>/dev/null; then
    echo "MCP server exited unexpectedly." >&2
    wait "${MCP_PID}" 2>/dev/null || true
    MCP_PID=""
    exit 1
  fi
  sleep 0.25
done

if [[ "${ready}" != true ]]; then
  echo "MCP server did not become ready on port ${PORT}." >&2
  exit 1
fi

# Hand off to the MCP Inspector. This blocks in the foreground; the cleanup
# trap shuts down the MCP server and tunnel when the user exits.
echo "MCP server running at ${MCP_URL}"
echo "Launching MCP Inspector..."

"${INSPECTOR}" --transport http --server-url "${MCP_URL}"
