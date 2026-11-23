#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXEC_IMAGE="${SANDBOX_EXEC_IMAGE:-mirror.gcr.io/library/node:22-bookworm-slim}"
BROWSER_IMAGE="${SANDBOX_BROWSER_IMAGE:-mcr.microsoft.com/playwright:v1.49.1-noble}"
BROWSER_NETWORK="${SANDBOX_BROWSER_NETWORK:-nexus-browser}"

echo "[nexus] Checking Docker availability..."
if ! docker info >/dev/null 2>&1; then
  echo "[nexus] ERROR: Docker daemon is not reachable. Start Docker and try again." >&2
  exit 1
fi

echo "[nexus] Pulling exec sandbox image: ${EXEC_IMAGE}"
docker pull "${EXEC_IMAGE}"

echo "[nexus] Pulling browser sandbox image: ${BROWSER_IMAGE}"
docker pull "${BROWSER_IMAGE}"

echo "[nexus] Installing browser-worker dependencies (separate from npm workspaces)..."
npm install --prefix "${ROOT_DIR}/sandbox/browser-worker"

echo "[nexus] Ensuring Docker network: ${BROWSER_NETWORK}"
if ! docker network inspect "${BROWSER_NETWORK}" >/dev/null 2>&1; then
  docker network create --driver bridge --label nexus=1 "${BROWSER_NETWORK}"
else
  echo "[nexus] Network ${BROWSER_NETWORK} already exists."
fi

echo "[nexus] Sandbox setup complete."
