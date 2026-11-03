# Toolchain image for the local Linux packaged smoke
# (scripts/packaging/smoke_packaged_linux_docker.py). It mirrors the
# ci-linux-package.yml job environment: Ubuntu 22.04 (the glibc 2.35 floor),
# the same apt packages, Node from .nvmrc, uv 0.11.19 and Python 3.11.15.
# The checkout is NOT baked in: each run streams it in on stdin.
FROM ubuntu:22.04

ARG NODE_VERSION
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      ca-certificates curl git build-essential xz-utils zstd binutils file sudo \
      libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
      libatspi2.0-0 libuuid1 libsecret-1-0 libasound2 libgbm1 libdrm2 \
      libxkbcommon0 libatk-bridge2.0-0 libcups2 libsqlite3-0 xvfb dbus dbus-x11 \
 && rm -rf /var/lib/apt/lists/*

# Node from the official tarball, checked against the release's SHASUMS256.txt.
RUN test -n "$NODE_VERSION" \
 && cd /tmp \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
 && grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c - \
 && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
 && rm -f "node-v${NODE_VERSION}-linux-x64.tar.xz" SHASUMS256.txt \
 && node --version

COPY --from=ghcr.io/astral-sh/uv:0.11.19 /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv python install 3.11.15

# The packaged app runs as an unprivileged user, as in CI.
RUN useradd --create-home smoke

COPY run-in-container.sh /usr/local/bin/jenny-linux-smoke
RUN chmod 0755 /usr/local/bin/jenny-linux-smoke

ENTRYPOINT ["/usr/local/bin/jenny-linux-smoke"]
