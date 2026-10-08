const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectDataInventory, countSessionAttachments } = require('../services/data-lifecycle/data-inventory');
const { CheckpointStore } = require('../services/session-runtime/checkpoint-store');
const { RootRunBudgetStore } = require('../services/session-runtime/budgets');
const { RuntimeLineageStore } = require('../services/session-runtime/lineage-store');

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
    fs.mkdirSync(path.join(userDataPath, 'project-notes'), { recursive: true });
    fs.writeFileSync(path.join(userDataPath, 'project-notes', 'project_alpha.json'), '{"version":1}');
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
    assert.equal(paths.includes('notes/project_alpha.json'), true);
    assert.equal(result.entries.find((entry) => entry.logicalPath === 'notes/project_alpha.json').category, 'memory');
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
    const { entries } = collectDataInventory({
      userDataPath: root,
      sessionStore,
      maxFileBytes: 4,
    });
    assert.throws(() => entries[0].produce(root), /supported archive size/);
    assert.deepEqual(fs.readdirSync(root), []);
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
    const { entries } = collectDataInventory({
      userDataPath: root,
      sessionStore,
      attachmentStore: { resolveSafePath: () => '' },
    });
    assert.throws(() => entries[0].produce(root), {
      code: 'CMP-DATA-0004',
      reason: 'source_unreadable',
      message: 'Managed session media could not be archived.',
    });
    assert.deepEqual(fs.readdirSync(root), []);
  }));

  it('counts attachment records without exposing their names in the envelope', () => {
    const sessionStore = {
      listSessions: () => [{ id: 'one' }],
      getSession: () => ({ messages: [{ attachments: [{ id: 'a' }, { id: 'b' }] }] }),
    };
    assert.equal(countSessionAttachments(sessionStore), 2);
  });

  it('archives a profile whose runtime coordination roots were never kept', () => withTempDir((root) => {
    const checkpoints = new CheckpointStore(path.join(root, 'session-runtime-checkpoints'), {
      validateCanonical: () => null,
    });
    const budgets = new RootRunBudgetStore(path.join(root, 'session-runtime-budgets'));
    const lineage = new RuntimeLineageStore(path.join(root, 'session-runtime-lineage'));
    for (const name of ['session-runtime-checkpoints', 'session-runtime-budgets', 'session-runtime-lineage']) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
    const runtimeArchivePort = {
      capturePortableState: () => ({
        checkpoints: checkpoints.exportPortableSnapshot(),
        root_run_budgets: budgets.exportPortableSnapshot(),
        lineage: lineage.exportPortableSnapshot(),
        canonical_sessions: { schema_version: 1, sessions: [] },
      }),
    };
    const result = collectDataInventory({ userDataPath: root, runtimeArchivePort });
    assert.equal(result.entries.some((entry) => entry.logicalPath.includes('coordination')), false);
  }));
});
