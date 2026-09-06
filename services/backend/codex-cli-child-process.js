'use strict';
// Backend composition-seam lane: shared helper (dev Codex CLI product engine).
// Composed only via backend-service; not a directly-importable product module.
// See docs/architecture/BACKEND_SEAM_LANE.md.

function getCodexCliChildSpawnOptions({ platform = process.platform } = {}) {
  return {
    shell: false,
    windowsHide: true,
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

module.exports = {
  getCodexCliChildSpawnOptions,
};
