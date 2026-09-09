# syntax=docker/dockerfile:1.7
# Hosted image target: Linux amd64, with the Node engine range pinned by the
# repository contract (24.19.0 is the first supported 24.x patch).
FROM --platform=linux/amd64 node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS browser-builder

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# The browser build intentionally receives only its explicit source allowlist.
COPY renderer/browser ./renderer/browser
COPY renderer/shared ./renderer/shared
COPY renderer/chat ./renderer/chat
COPY renderer/features/renderer-plan-document.js ./renderer/features/renderer-plan-document.js
COPY renderer/inventory ./renderer/inventory
COPY scripts/build-browser.js ./scripts/build-browser.js
COPY locales/*.json ./locales/
RUN node scripts/build-browser.js \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM --platform=linux/amd64 node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp/jenny-host-runtime \
    XDG_CACHE_HOME=/tmp/jenny-host-runtime/.cache \
    XDG_CONFIG_HOME=/tmp/jenny-host-runtime/.config \
    XDG_DATA_HOME=/tmp/jenny-host-runtime/.local/share \
    XDG_STATE_HOME=/tmp/jenny-host-runtime/.local/state
WORKDIR /app

# Bookworm's supported Python runtime is 3.11. The image has no compiler,
# model weights, plugin bundle, Docker client, or Docker socket access.
RUN apt-get update \
    && apt-get install --no-install-recommends -y python3.11 python3.11-venv \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10003 jenny-control \
    && groupadd --gid 10001 jenny \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin jenny \
    && install -d -m 0700 -o 10001 -g 10001 /data \
      /workspaces/default /run/jenny-secrets /etc/jenny /tmp \
    && install -d -m 0770 -o 0 -g 10003 /run/jenny-worker \
    && install -d -m 0700 -o 10001 -g 10001 /inputs /workspace

# Stable runtime allowlist. Tests, source-control metadata, plugins, and user
# data are excluded by .dockerignore and are never copied into this stage.
COPY package.json ./package.json
COPY server ./server
COPY services ./services
COPY reasoning-effort-profiles.js ./reasoning-effort-profiles.js
COPY --from=browser-builder /src/node_modules ./node_modules
COPY renderer/shared ./renderer/shared
COPY renderer/chat ./renderer/chat
COPY renderer/features/renderer-plan-document.js ./renderer/features/renderer-plan-document.js
COPY sidecar ./sidecar
COPY --from=browser-builder /src/build/browser ./build/browser
COPY config ./config
RUN python3.11 -m venv /opt/jenny-venv \
    && /opt/jenny-venv/bin/python -m pip install --no-cache-dir --require-hashes \
      --only-binary=:all: -r server/requirements-lock.txt \
    && node -e "require('./server/main')" \
    && /opt/jenny-venv/bin/python -c "import sidecar.ai.container"

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "server/main.js"]
