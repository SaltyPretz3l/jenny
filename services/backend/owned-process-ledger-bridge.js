"use strict";
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { sanitizeSpawnEnv } = require('./sanitize-spawn-env');
const { readLedger, recover } = require('./owned-process-recovery');

function createLedgerBridge({ file, command, args, cwd, platform = process.platform,
  spawnSyncImpl = spawnSync, logger = () => {} }) {
  function run(operation, remainingMs = 3500) {
    if (remainingMs <= 0) return { ok: false };
    if (platform === 'win32') return { ok: true, count: 0 };
    try {
      const result = spawnSyncImpl(command, [...args, '--owned-process-ledger-helper'], {
        env: sanitizeSpawnEnv(process.env, { allowOnly: true, allow: [/^PYTHON/i, /^VIRTUAL_ENV$/i] }),
        cwd, input: JSON.stringify({ ...operation, path: file }), encoding: 'utf8',
        timeout: Math.max(1, Math.min(3500, Math.floor(remainingMs))), maxBuffer: 1024 * 1024, windowsHide: true,
      });
      const value = result.status === 0 && !result.error ? JSON.parse(result.stdout) : null;
      if (value?.ok) return value;
    } catch (_) { /* A failed best-effort ledger never blocks spawning. */ }
    logger('WARN', 'runtime.owned_ledger.write_failed', {});
    return { ok: false };
  }
  return {
    run,
    prepare(ownerPid) {
      if (platform === 'win32') return null;
      const token = randomBytes(32).toString('hex');
      const result = run({ operation: 'prepare', owner_pid: ownerPid, guardian_pid: process.pid, token });
      return result.ok && result.count >= 0 ? { token, guardian: result.guardian } : null;
    },
    recover() {
      if (platform === 'win32') return null;
      return recover({ snapshot: () => readLedger(file, logger), logger,
        mutate: (operation, key, expected, remainingMs) => run({ operation, key, expected }, remainingMs) });
    },
  };
}
function attachLedgerBridge(manager, command, args) {
  manager.ownedProcessLedger = createLedgerBridge({
    file: path.join(manager.userDataPath, 'owned-processes.json'), command, args,
    cwd: manager.repoRoot, logger: manager.logger || (() => {}),
  });
  manager.ownedProcessLedger.recover();
}
module.exports = { createLedgerBridge, attachLedgerBridge };
