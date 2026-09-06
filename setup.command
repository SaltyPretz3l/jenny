#!/usr/bin/env bash
# Jenny setup — macOS double-clickable entry point.
#
# Finder runs this when double-clicked (you may need to `chmod +x setup.command`
# once, or right-click → Open the first time). It simply delegates to setup.sh.
cd "$(dirname "$0")"
exec bash ./setup.sh "$@"
