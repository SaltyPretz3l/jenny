const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  KNOWN_RUNTIME_CHILDREN,
  KNOWN_USER_DATA_CHILDREN,
  cleanupJennyData,
} = require('../services/data-lifecycle/cleanup-service');

// Uninstall removes only names the registry lists; a store a later feature
// writes into the profile has to be listed or it is retained as "unknown".
describe('cleanup registry covers the stores later features write', () => {
  it('removes them (and keeps SQLite look-alikes) from the profile and runtime root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cleanup-registry-'));
    try {
      const userDataPath = path.join(root, 'profile');
      const runtimePath = path.join(root, '.companion');
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(path.join(runtimePath, 'operation-ledger'), { recursive: true });
      fs.writeFileSync(path.join(runtimePath, 'operation-ledger', 'ledger.json'), '{}');
      const dirs = ['operation-ledger', 'workspace-recovery', 'session-shadow', 'exports', 'turn-event-journal.json.journal'];
      for (const name of dirs) {
        fs.mkdirSync(path.join(userDataPath, name));
        fs.writeFileSync(path.join(userDataPath, name, 'record.json'), '{}');
      }
      const files = [
        'workspace-active-use.json', 'model-fit-observations.json', 'model-load-durations.json',
        'chatgpt-plan-usage.json', 'profile-owner.json', 'ninfer-serve.pid',
        'sidecar-memory.db', 'sidecar-memory.db-wal', 'sidecar-memory.db-shm',
      ];
      for (const name of files) fs.writeFileSync(path.join(userDataPath, name), 'data');
      for (const name of [...dirs, ...files]) assert.equal(KNOWN_USER_DATA_CHILDREN.includes(name), true, name);
      assert.equal(KNOWN_RUNTIME_CHILDREN.includes('operation-ledger'), true);
      fs.writeFileSync(path.join(userDataPath, 'sidecar-memory.db-journal'), 'keep');

      const result = await cleanupJennyData({ userDataPath, runtimePath });

      assert.equal(result.status, 'complete');
      for (const name of [...dirs, ...files]) assert.equal(fs.existsSync(path.join(userDataPath, name)), false, name);
      assert.equal(fs.existsSync(path.join(runtimePath, 'operation-ledger')), false);
      assert.deepEqual(result.unknownUserDataChildren, ['sidecar-memory.db-journal']);
      assert.equal(result.unknownRuntimeChildren.includes('operation-ledger'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the skills directory out of the runtime registry (user-authored)', () => {
    assert.equal(KNOWN_RUNTIME_CHILDREN.includes('skills'), false);
  });
});
