'use strict';

// Row 82 cleanup H4 (owner D3): the hot-exit backup store (<userData>/workspace-backups,
// workspace-backup-service.js) is a known profile child, so "remove my data" and the
// uninstall helpers delete it instead of reporting it as unknown and keeping the profile.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanupJennyData, KNOWN_USER_DATA_CHILDREN } = require('../services/data-lifecycle/cleanup-service');

test('cleanup removes the hot-exit backup store and does not report it as unknown', async () => {
  assert.ok(KNOWN_USER_DATA_CHILDREN.includes('workspace-backups'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-backups-cleanup-'));
  try {
    const userDataPath = path.join(root, 'profile');
    const backupRoot = path.join(userDataPath, 'workspace-backups', 'root_0123456789abcdef01234567');
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.writeFileSync(path.join(backupRoot, `${'a'.repeat(64)}.json`), '{}');

    const result = await cleanupJennyData({ userDataPath });

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(userDataPath, 'workspace-backups')), false);
    assert.deepEqual(result.unknownUserDataChildren, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
