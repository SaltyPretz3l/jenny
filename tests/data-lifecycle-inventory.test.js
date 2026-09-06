const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectDataInventory, countSessionAttachments } = require('../services/data-lifecycle/data-inventory');

function withTempDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-inventory-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('collectDataInventory', () => {
  it('collects only allowlisted profile and workspace data', () => withTempDir((root) => {
    const userDataPath = path.join(root, 'profile');
    const workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(path.join(userDataPath, 'personality', 'default-workspace'), { recursive: true });
    fs.writeFileSync(path.join(userDataPath, 'personality', 'default-workspace', 'profile.md'), 'hello');
    fs.writeFileSync(path.join(userDataPath, 'home-calendar.json'), '{}');
    fs.writeFileSync(path.join(userDataPath, 'secure-state.json'), 'secret');
    fs.mkdirSync(path.join(workspaceRoot, '.jenny', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.jenny', 'artifacts', 'chart.json'), '{}');
    fs.writeFileSync(path.join(workspaceRoot, 'ordinary.txt'), 'keep');

    const sessionStore = {
      listSessions: () => [{ id: 'sess_1' }],
      getSession: () => ({
        id: 'sess_1', title: 'Test', created_at: '', updated_at: '', messages: [],
      }),
    };
    const result = collectDataInventory({
      userDataPath,
      workspaceRoot,
      includeWorkspace: true,
      sessionStore,
      portablePreferences: { schema_version: 1, appearance: { paletteId: 'obsidian' } },
      portableShellConfig: { chatUi: { zoomPercent: 110 } },
    });
    const paths = result.entries.map((entry) => entry.logicalPath);

    assert.equal(paths.some((value) => value.startsWith('sessions/')), true);
    assert.equal(paths.includes('personality/profile.md'), true);
    assert.equal(paths.includes('calendar/home-calendar.json'), true);
    assert.equal(paths.includes('workspace/artifacts/chart.json'), true);
    assert.equal(paths.includes('preferences/shell-config.json'), true);
    assert.equal(paths.some((value) => value.includes('secure-state')), false);
    assert.equal(paths.some((value) => value.includes('ordinary')), false);
    assert.deepEqual(result.entries[0].restoreMetadata, { session_id: 'sess_1' });
  }));

  it('fails when a virtual session exceeds the per-file bound', () => withTempDir((root) => {
    const sessionStore = {
      listSessions: () => [{ id: 'sess_large' }],
      getSession: () => ({ id: 'sess_large', title: 'Large', messages: [{ role: 'user', content: 'too long' }] }),
    };
    assert.throws(() => collectDataInventory({
      userDataPath: root,
      sessionStore,
      maxFileBytes: 4,
    }), /supported archive size/);
  }));

  it('fails instead of deleting an allowlisted file that could not be archived', () => withTempDir((root) => {
    const personalityRoot = path.join(root, 'personality', 'default-workspace');
    fs.mkdirSync(personalityRoot, { recursive: true });
    fs.writeFileSync(path.join(personalityRoot, 'large.md'), 'too large');
    assert.throws(() => collectDataInventory({ userDataPath: root, maxFileBytes: 4 }), {
      code: 'CMP-DATA-0004',
      reason: 'source_too_large',
    });
  }));

  it('fails closed when managed session media cannot be read', () => withTempDir((root) => {
    const sessionStore = {
      listSessions: () => [{ id: 'sess_media' }],
      getSession: () => ({
        id: 'sess_media',
        title: 'Media',
        messages: [{
          role: 'user',
          content: 'image',
          attachments: [{ kind: 'image', assetPath: path.join(root, 'missing.png') }],
        }],
      }),
    };
    assert.throws(() => collectDataInventory({
      userDataPath: root,
      sessionStore,
      attachmentStore: { resolveSafePath: () => '' },
    }), {
      code: 'CMP-DATA-0004',
      reason: 'source_unreadable',
    });
  }));

  it('counts attachment records without exposing their names in the envelope', () => {
    const sessionStore = {
      listSessions: () => [{ id: 'one' }],
      getSession: () => ({ messages: [{ attachments: [{ id: 'a' }, { id: 'b' }] }] }),
    };
    assert.equal(countSessionAttachments(sessionStore), 2);
  });
});
