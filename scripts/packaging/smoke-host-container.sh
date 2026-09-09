#!/usr/bin/env bash
set -euo pipefail

image="${1:-jenny-host:ci}"
if [[ ! "$image" =~ ^[A-Za-z0-9._:/@-]{1,256}$ ]]; then
  echo "Invalid image reference." >&2
  exit 2
fi

smoke_id="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"
container="jenny-host-smoke-${smoke_id}"
model="jenny-host-model-${smoke_id}"
network="jenny-host-network-${smoke_id}"
volume="jenny-host-profile-${smoke_id}"
scratch="$(mktemp -d)"
password='hosted-ci-password-123!'

cleanup() {
  local result=$?
  if [[ "$result" -ne 0 ]]; then
    docker logs --tail 30 "$container" >&2 || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker rm -f "$model" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT

mkdir -p "$scratch/secrets"
cat >"$scratch/host.json" <<'JSON'
{
  "schema_version": 1,
  "host_mode": "server",
  "host_execution_policy_version": 1,
  "canonical_origin": "https://jenny.test",
  "listen_host": "0.0.0.0",
  "port": 8080,
  "user_data_path": "/data",
  "workspace_root": null,
  "secrets_dir": "/run/jenny-secrets",
  "runtime_home": "/tmp/jenny-host-runtime",
  "python_executable": "/opt/jenny-venv/bin/python",
  "model_endpoint": {
    "engine": "openai-compatible",
    "model": "sandbox-fixture",
    "api_url": "http://model:8000/v1"
  }
}
JSON
chmod 0444 "$scratch/host.json"
docker volume create "$volume" >/dev/null
docker network create "$network" >/dev/null
# Readiness requires the configured engine to initialize. Reuse the bounded
# model fixture rather than depending on an absent Ollama server or a real model.
docker run -d --name "$model" --network "$network" --network-alias model \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 32 --memory 128m --cpus 1 \
  --mount "type=bind,src=$PWD/scripts/packaging/fixture-sandbox-model.js,dst=/tmp/model.js,readonly" \
  --entrypoint node "$image" /tmp/model.js >/dev/null

python3 scripts/packaging/owner-init-container.py \
  "$image" "$volume" "$scratch/host.json" "$scratch/secrets"

docker run -d --name "$container" --network "$network" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 256 --memory 2g --cpus 2 \
  --tmpfs /tmp:size=268435456,mode=1777 \
  --mount "type=volume,src=$volume,dst=/data" \
  --mount "type=bind,src=$scratch/host.json,dst=/etc/jenny/host.json,readonly" \
  --mount "type=bind,src=$scratch/secrets,dst=/run/jenny-secrets,readonly" \
  -p 127.0.0.1::8080 "$image" --config /etc/jenny/host.json >/dev/null

published="$(docker port "$container" 8080/tcp)"
port="${published##*:}"
node scripts/packaging/probe-host-container.js "$port" "$password"
docker exec "$container" node -e \
  "process.exit(require('node:fs').existsSync('/data/runtime-home') ? 1 : 0)"
