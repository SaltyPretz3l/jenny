'use strict';

// One-time sweep for the retired privileged (full-host / session-provider)
// plugin tier. The tier never shipped (flag off by default) and its code is
// gone, so any state it left under the plugin store is unreachable dead
// weight. Leftover process receipts are dropped WITHOUT native proof (owner,
// 2026-10-02): Windows job objects are KILL_ON_JOB_CLOSE and the supervisor
// kept its sessions in memory, so no host process outlives the app.
//
// Never throws, is idempotent, and logs counts only (no paths, no user data).

const { joinPath } = require('../store/fs-facade');

const RETIRED_RUNTIME_FILES = Object.freeze([
  'full-host-cleanup-v6.json',
  'full-host-crash-quarantine-v6.json',
  'secret-delivery-grants-v6.json',
  'hook-outbox-v6.json',
]);
const RETIRED_STAGING_DIR = 'session-provider-staging';

async function retirePrivilegedTierState({ facade, baseDir = '', safeMode = null,
  log = () => {} } = {}) {
  if (safeMode?.active === true) return { ok: true, skipped: 'safe_mode', removed: 0, failed: 0 };
  if (!facade || typeof facade.stat !== 'function') {
    return { ok: false, reason: 'facade_unavailable', removed: 0, failed: 0 };
  }
  let removed = 0;
  let failed = 0;
  const targets = [
    ...RETIRED_RUNTIME_FILES.map((name) => ({ path: joinPath(baseDir, 'runtime', name), tree: false })),
    { path: joinPath(baseDir, RETIRED_STAGING_DIR), tree: true },
  ];
  for (const target of targets) {
    try {
      const stat = await facade.stat(target.path);
      if (!stat?.exists) continue;
      if (target.tree) await facade.removeTree(target.path);
      else await facade.remove(target.path);
      removed += 1;
    } catch (_error) {
      failed += 1;
    }
  }
  if (removed || failed) {
    try {
      log(failed ? 'WARN' : 'INFO', 'plugins.privileged_tier_retired',
        { removed_count: removed, failed_count: failed });
    } catch (_error) { /* logging never fails the sweep */ }
  }
  return { ok: failed === 0, removed, failed };
}

module.exports = { RETIRED_RUNTIME_FILES, RETIRED_STAGING_DIR, retirePrivilegedTierState };
