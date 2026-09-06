#!/usr/bin/env bash
# Jenny setup — macOS / Linux entry point.
#
# Run from the repo root:
#     bash ./setup.sh
#
# Verifies prerequisites (offers Homebrew installs with consent), runs
# `npm install`, then hands off to the cross-platform orchestrator
# (scripts/setup/setup.js) which creates the Python venv, ensures Ollama,
# pulls the default model, and launches Jenny.

set -uo pipefail
cd "$(dirname "$0")"

have() { command -v "$1" >/dev/null 2>&1; }

YES=0
HELP=0
USER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1; USER_ARGS+=("--yes") ;;
    -h|--help) HELP=1; USER_ARGS+=("$arg") ;;
    *) USER_ARGS+=("$arg") ;;
  esac
done

confirm() { # prompt
  if [ "$YES" = "1" ]; then return 0; fi
  printf '%s [y/N] ' "$1"
  read -r reply
  case "$reply" in [Yy]|[Yy][Ee][Ss]) return 0 ;; *) return 1 ;; esac
}

brew_install() { # formula label
  if have brew && confirm "Install $2 with Homebrew?"; then
    brew install "$1" || true
  fi
}

echo "Jenny setup (macOS/Linux)"

if ! have node; then
  echo "Node.js 22.23.2+ (22.x) or 24.19.0+ (24.x) is required."
  brew_install node "Node.js"
fi
if ! have node; then
  echo "Node.js not found. Install it from https://nodejs.org then re-run ./setup.sh"
  exit 10
fi
node_supported() {
  node -e 'const [M,m,p]=process.versions.node.split(".").map(Number); process.exit((M===22&&(m>23||(m===23&&p>=2)))||(M===24&&(m>19||(m===19&&p>=0)))?0:1)'
}
if ! node_supported; then
  echo "Unsupported Node.js $(node --version). Use 22.23.2+ (22.x) or 24.19.0+ (24.x)."
  exit 10
fi
npm_supported() {
  local npm_major
  npm_major="$(npm --version 2>/dev/null | cut -d. -f1)"
  case "$npm_major" in
    ''|*[!0-9]*) return 1 ;;
    *) [ "$npm_major" -ge 10 ] ;;
  esac
}
if ! have npm || ! npm_supported; then
  echo "npm 10 or newer is required."
  exit 10
fi
if ! node -e 'const {parseArgs}=require("./scripts/setup/setup"); const parsed=parseArgs(process.argv.slice(1)); if(parsed.errors.length){console.error(parsed.errors.join(" "));process.exit(10)}' -- "${USER_ARGS[@]}"; then
  exit 10
fi
if [ "$HELP" = "1" ]; then
  exec node scripts/setup/setup.js "${USER_ARGS[@]}"
fi
# True when a Python >= 3.11 interpreter is on PATH. Presence alone is not enough: macOS
# (and older Linux) ship a python3 below 3.11, which would otherwise skip the install offer
# and only fail later inside setup.js. Mirrors the launcher order setup.js itself probes.
have_python311() {
  local py
  for py in python3.11 python3 python; do
    if have "$py" && "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

if ! have_python311; then
  echo "Python 3.11+ is required."
  brew_install python@3.11 "Python 3.11"
fi
# Mirror the Node guard: stop here with a clear hint rather than running a multi-minute
# `npm install` and only failing the Python check afterward inside setup.js.
if ! have_python311; then
  echo "Python 3.11+ not found. Install it, then re-run ./setup.sh"
  echo "  Linux (Debian/Ubuntu): sudo apt install python3.11 python3.11-venv"
  echo "  macOS:                 brew install python@3.11"
  exit 10
fi

if ! have git; then
  echo "git is recommended (updates + pre-commit hook)."
  brew_install git "Git"
fi

echo "Installing Node dependencies (npm install)..."
if ! npm install; then
  echo "npm install failed."
  exit 1
fi

exec node scripts/setup/setup.js --bootstrapped-npm "${USER_ARGS[@]}"
