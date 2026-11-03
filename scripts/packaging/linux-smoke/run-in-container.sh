#!/usr/bin/env bash
# Entry point of the jenny-linux-smoke image. stdin is a tar of the checkout
# (tracked plus untracked, non-ignored files). The steps mirror
# .github/workflows/ci-linux-package.yml through its "Smoke packaged Linux app"
# step; keep the two in lockstep. The SBOM, glibc-floor and .deb/AppImage steps
# are release checks and stay in CI.
set -euo pipefail

copy_log() {
  if [ -f /work/artifacts/logs/packaging-smoke-phase4.log ]; then
    cp /work/artifacts/logs/packaging-smoke-phase4.log /out/packaging-smoke-docker-linux.log
  fi
}
trap copy_log EXIT

step() {
  printf '\n[linux-smoke] %s\n' "$*"
}

mkdir -p /work
cd /work
step "unpacking the checkout"
tar -xf -

# The packaged sidecar manifest records HEAD and the smoke compares it with the
# checkout, so the streamed files become their own snapshot commit.
git init -q
git add -A
git -c user.name=linux-smoke -c user.email=linux-smoke@localhost commit -q -m "linux smoke snapshot"
git config --system --add safe.directory /work

step "Python 3.11.15 venv"
uv venv --seed --python 3.11.15 .venv
export PATH="/work/.venv/bin:$PATH"

step "npm ci"
npm ci

step "preload bundle"
npm run build:preload

step "Python dependencies"
python -m pip install --require-hashes --only-binary=:all: -r requirements-build-lock.txt
python -m pip install --require-hashes -r requirements-lock.txt
python -m pip install --no-build-isolation --no-deps -e .
python -m pip check

step "offline managed-Python runtime"
python scripts/build-python-runtime-bundle.py --contract config/python-runtime-bundle-lock.linux-x64.json
python scripts/checks/check_python_runtime_bundle.py

step "sidecar artifact"
python scripts/packaging/build_sidecar_artifact.py

step "unpacked Linux app"
npm exec -- electron-builder --linux --dir --config electron-builder.yml --publish never

# Electron runs as an unprivileged user beside the root-owned SUID sandbox helper.
step "packaged app smoke"
install -d -o smoke -g smoke artifacts/logs
chown -R smoke:smoke dist/linux-unpacked artifacts
chown root:root dist/linux-unpacked/chrome-sandbox
chmod 4755 dist/linux-unpacked/chrome-sandbox
sudo -u smoke -H env PATH="$PATH" HOME=/home/smoke \
  xvfb-run -a dbus-run-session -- "$(command -v python)" \
  scripts/packaging/smoke_packaged_flow.py \
  --existing-artifacts --composition release
