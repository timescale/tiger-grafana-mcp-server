#!/usr/bin/env bash
# One-command local dev: install deps, build, start MCP (HTTP), open MCP Inspector.
#
# Prerequisites: Node.js 22+ (includes npm) — https://nodejs.org
# Usage (from repo root): ./scripts/dev-inspector.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIN_NODE_MAJOR=22

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

ensure_env_file() {
  if [[ -f .env ]]; then
    return
  fi
  if [[ -f .env.sample ]]; then
    cp .env.sample .env
    echo "Created .env from .env.sample."
    echo "Edit .env and set GRAFANA_SERVICE_ACCOUNT_TOKEN (and GRAFANA_URL if needed), then run this script again."
    exit 0
  fi
  echo "Missing .env. Create one with GRAFANA_URL and GRAFANA_SERVICE_ACCOUNT_TOKEN (see README.md)." >&2
  exit 1
}

load_env() {
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
}

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

ensure_build() {
  if [[ -f dist/index.js ]] \
    && [[ dist/index.js -nt package.json ]] \
    && [[ dist/index.js -nt tsconfig.json ]]; then
    return
  fi
  echo "Building..."
  npm run build
}

require_node
ensure_env_file
load_env

if [[ -z "${GRAFANA_URL:-}" ]]; then
  echo "GRAFANA_URL is not set in .env" >&2
  exit 1
fi
if [[ -z "${GRAFANA_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  echo "GRAFANA_SERVICE_ACCOUNT_TOKEN is not set in .env" >&2
  exit 1
fi

ensure_dependencies
ensure_build

INSPECTOR="${ROOT}/node_modules/.bin/mcp-inspector"
if [[ ! -x "${INSPECTOR}" ]]; then
  echo "MCP Inspector binary not found after install." >&2
  exit 1
fi

PORT="${PORT:-3001}"
MCP_URL="http://localhost:${PORT}/mcp"

MCP_PID=""
cleanup() {
  if [[ -n "${MCP_PID}" ]] && kill -0 "${MCP_PID}" 2>/dev/null; then
    echo "Stopping MCP server (pid ${MCP_PID})..."
    kill "${MCP_PID}" 2>/dev/null || true
    wait "${MCP_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

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

echo "MCP server running at ${MCP_URL}"
echo "Launching MCP Inspector..."

"${INSPECTOR}" --transport http --server-url "${MCP_URL}"
