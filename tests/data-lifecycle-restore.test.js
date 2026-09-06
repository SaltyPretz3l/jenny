const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createArchive } = require('../services/data-lifecycle/archive-service');
const {
  finalizeRestoredBoot,
  findRestoreCandidates,
  isMeaningfullyFresh,
  promotePendingRestore,
  recoverWorkspaceRestoreStages,
  inspectWorkspaceRestore,
  restoreWorkspace,
  restorePointerPath,
  stageRestore,
  workspaceRootIdentity,
} = require('../services/data-lifecycle/restore-service');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-restore-'));
}

function sessionExport(title = 'Archived Chat') {
  return JSON.stringify({
    format: 'jenny-session-export',
    format_version: 1,
    exported_at: '2026-08-03T00:00:00.000Z',
    session: {
      title,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-02T00:00:00.000Z',
      messages: [{ id: 'msg_1', role: 'user', content: 'Keep me' }],
    },
  });
}

async function createPlainArchive(root, createdAt = new Date('2026-08-03T00:00:00.000Z')) {
  const destinationRoot = path.join(root, 'Jenny Archives');
  const result = await createArchive({
    destinationRoot,
    encrypted: false,
    createdAt,
    entries: [
      {
        logicalPath: 'sessions/session.json',
        category: 'chats',
        data: Buffer.from(sessionExport()),
        restoreMetadata: { session_id: 'sess_preserved' },
      },
      {
        logicalPath: 'preferences/portable-preferences.json',
        category: 'preferences',
        data: Buffer.from(JSON.stringify({ schema_version: 1, appearance: { paletteId: 'luma' } })),
      },
      {
        logicalPath: 'preferences/shell-config.json',
        category: 'preferences',
        data: Buffer.from(JSON.stringify({ chatUi: { zoomPercent: 115 } })),
      },
    ],
  });
  return { destinationRoot, archivePath: result.archivePath };
}

describe('restore service', () => {
  it('stages, promotes, and finalizes a fresh-profile archive restore', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath);
      const { archivePath } = await createPlainArchive(root);

      const staged = await stageRestore({ archivePath, userDataPath });
      assert.equal(staged.status, 'restart_required');
      assert.equal(fs.existsSync(restorePointerPath(userDataPath)), true);

      const promoted = await promotePendingRestore({ userDataPath });
      assert.equal(promoted.status, 'promoted');
      const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
      const restored = store.getSession('sess_preserved');
      assert.equal(restored.title, 'Archived Chat');
      assert.equal(restored.messages[0].content, 'Keep me');
      const preferences = JSON.parse(fs.readFileSync(
        path.join(userDataPath, 'data-lifecycle', 'portable-preferences.json'),
        'utf8'
      ));
      assert.equal(preferences.appearance.paletteId, 'luma');
      const shellConfig = JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));
      assert.equal(shellConfig.chatUi.zoomPercent, 115);

      assert.equal(await finalizeRestoredBoot(userDataPath), true);
      assert.equal(await finalizeRestoredBoot(userDataPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-projects restored preferences so edited archives cannot add machine authority or secrets', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath);
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [
          {
            logicalPath: 'preferences/portable-preferences.json',
            category: 'preferences',
            data: JSON.stringify({
              appearance: { paletteId: 'paper', injected: 'drop' },
              preferredModel: 'qwen3',
              authToken: 'drop',
            }),
          },
          {
            logicalPath: 'preferences/shell-config.json',
            category: 'preferences',
            data: JSON.stringify({
              preferredEngineType: 'vllm',
              chatUi: { zoomPercent: 115 },
              toolsWorkspaceRoot: 'C:\\untrusted',
              featureOverrides: { plugins: true },
              secureState: { token: 'drop' },
            }),
          },
        ],
      });
      await stageRestore({ archivePath: result.archivePath, userDataPath });
      await promotePendingRestore({ userDataPath });

      const portable = JSON.parse(fs.readFileSync(
        path.join(userDataPath, 'data-lifecycle', 'portable-preferences.json'),
        'utf8'
      ));
      assert.deepEqual(portable.appearance, { paletteId: 'paper' });
      assert.equal(portable.preferredModel, 'qwen3');
      assert.equal(Object.hasOwn(portable, 'authToken'), false);

      const shellConfig = JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));
      assert.equal(shellConfig.preferredEngineType, 'vllm');
      assert.equal(shellConfig.chatUi.zoomPercent, 115);
      assert.equal(Object.hasOwn(shellConfig, 'toolsWorkspaceRoot'), false);
      assert.equal(Object.hasOwn(shellConfig, 'featureOverrides'), false);
      assert.equal(Object.hasOwn(shellConfig, 'secureState'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('offers newest complete compatible archives and ignores partial directories', async () => {
    const root = makeTempRoot();
    try {
      const first = await createPlainArchive(path.join(root, 'first'), new Date('2026-08-01T00:00:00.000Z'));
      const second = await createPlainArchive(path.join(root, 'second'), new Date('2026-08-02T00:00:00.000Z'));
      const combined = path.join(root, 'archives');
      fs.mkdirSync(combined);
      fs.renameSync(first.archivePath, path.join(combined, path.basename(first.archivePath)));
      fs.renameSync(second.archivePath, path.join(combined, path.basename(second.archivePath)));
      fs.mkdirSync(path.join(combined, 'Broken.jenny-archive'));

      const candidates = findRestoreCandidates(combined);
      assert.equal(candidates.length, 2);
      assert.equal(candidates[0].createdAt, '2026-08-02T00:00:00.000Z');
      assert.match(candidates[0].fingerprint, /^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps default-folder discovery even when a larger limit is requested', () => {
    const root = makeTempRoot();
    try {
      for (let index = 0; index < 55; index += 1) {
        const archivePath = path.join(root, `Archive ${String(index).padStart(2, '0')}.jenny-archive`);
        fs.mkdirSync(archivePath);
        const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        fs.writeFileSync(path.join(archivePath, 'COMPLETE'), createdAt);
        fs.writeFileSync(path.join(archivePath, 'archive.json'), JSON.stringify({
          format: 'jenny-data-archive',
          format_version: 1,
          created_at: createdAt,
          source_app_version: '0.9.1',
          encrypted: false,
          entry_count: 0,
          total_bytes: 0,
        }));
      }
      assert.equal(findRestoreCandidates(root, { limit: 1000 }).length, 50);
      assert.equal(findRestoreCandidates(root, { limit: -1 }).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a populated profile before staging or promotion', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(path.join(userDataPath, 'personality', 'default-workspace'), { recursive: true });
      fs.writeFileSync(path.join(userDataPath, 'personality', 'default-workspace', 'profile.md'), 'mine');
      const { archivePath } = await createPlainArchive(root);
      assert.equal(isMeaningfullyFresh({ userDataPath }), false);
      await assert.rejects(
        stageRestore({ archivePath, userDataPath }),
        (error) => error.code === 'CMP-DATA-0009' && error.reason === 'profile_not_fresh'
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects staged data that changes before promotion without mutating the profile', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath);
      const { archivePath } = await createPlainArchive(root);
      await stageRestore({ archivePath, userDataPath });
      const pointer = JSON.parse(fs.readFileSync(restorePointerPath(userDataPath), 'utf8'));
      fs.writeFileSync(
        path.join(pointer.stage_path, 'data', 'preferences', 'shell-config.json'),
        JSON.stringify({ chatUi: { zoomPercent: 999 } })
      );

      await assert.rejects(promotePendingRestore({ userDataPath }), {
        code: 'CMP-DATA-0007',
        reason: 'archive_checksum_failed',
      });
      assert.equal(fs.existsSync(path.join(userDataPath, 'shell-config.json')), false);
      assert.equal(fs.existsSync(restorePointerPath(userDataPath)), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects duplicate restored session identities before staging data', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath);
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: ['one', 'two'].map((name) => ({
          logicalPath: `sessions/${name}.json`,
          category: 'chats',
          data: Buffer.from(sessionExport(name)),
          restoreMetadata: { session_id: name === 'one' ? 'Session_A' : 'session_a' },
        })),
      });
      await assert.rejects(stageRestore({ archivePath: result.archivePath, userDataPath }), {
        code: 'CMP-DATA-0007',
        reason: 'restore_identity_collision',
      });
      assert.equal(fs.existsSync(restorePointerPath(userDataPath)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects archive entries that map to one restore destination', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const runtimePath = path.join(root, '.companion');
      fs.mkdirSync(userDataPath);
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: ['one', 'two'].map((name) => ({
          logicalPath: `memory/${name}/jenny_memory.db`,
          category: 'memory',
          data: name,
        })),
      });
      await assert.rejects(stageRestore({ archivePath: result.archivePath, userDataPath, runtimePath }), {
        code: 'CMP-DATA-0007',
        reason: 'restore_path_collision',
      });
      assert.equal(fs.existsSync(restorePointerPath(userDataPath)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a restore pointer symlink before reading it', async (t) => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath);
      const { archivePath } = await createPlainArchive(root);
      await stageRestore({ archivePath, userDataPath });
      const pointerPath = restorePointerPath(userDataPath);
      const externalPointer = path.join(root, 'external-pointer.json');
      fs.renameSync(pointerPath, externalPointer);
      try {
        fs.symlinkSync(externalPointer, pointerPath, 'file');
      } catch (error) {
        t.skip(`file symlink creation unavailable: ${error.code || 'unknown'}`);
        return;
      }
      await assert.rejects(promotePendingRestore({ userDataPath }), {
        code: 'CMP-DATA-0007',
        reason: 'restore_state_invalid',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a legacy canonical sessions file as a non-fresh profile before stores open', () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath);
      fs.writeFileSync(path.join(userDataPath, 'sessions.json'), JSON.stringify({ sessions: { sess_existing: {} } }));
      assert.equal(isMeaningfullyFresh({ userDataPath }), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back a write-ahead copying phase and retries promotion idempotently', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath);
      fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify({ chatUi: { zoomPercent: 95 } }));
      const { archivePath } = await createPlainArchive(root);
      await stageRestore({ archivePath, userDataPath });

      const pointer = JSON.parse(fs.readFileSync(restorePointerPath(userDataPath), 'utf8'));
      const journalPath = path.join(pointer.stage_path, 'restore-journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      const rollbackRoot = path.join(
        path.dirname(userDataPath),
        `${path.basename(userDataPath)}.jenny-restore-rollback-${journal.operation_id}`
      );
      fs.mkdirSync(path.join(rollbackRoot, 'user'), { recursive: true });
      fs.renameSync(
        path.join(userDataPath, 'shell-config.json'),
        path.join(rollbackRoot, 'user', 'shell-config.json')
      );
      fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify({ partial: true }));
      journal.status = 'copying';
      fs.writeFileSync(journalPath, JSON.stringify(journal));

      const promoted = await promotePendingRestore({ userDataPath });
      assert.equal(promoted.status, 'promoted');
      const shellConfig = JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));
      assert.equal(shellConfig.chatUi.zoomPercent, 115);
      assert.equal(Object.hasOwn(shellConfig, 'partial'), false);
      await finalizeRestoredBoot(userDataPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores a profile from an archive containing workspace rows without mutating a workspace', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const workspaceRoot = path.join(root, 'workspace');
      fs.mkdirSync(userDataPath);
      fs.mkdirSync(path.join(workspaceRoot, '.jenny', 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, '.jenny', 'artifacts', 'existing.txt'), 'keep');
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [
          { logicalPath: 'preferences/shell-config.json', category: 'preferences', data: '{}' },
          { logicalPath: 'workspace/artifacts/from-archive.txt', category: 'workspace', data: 'archive' },
        ],
      });
      await stageRestore({ archivePath: result.archivePath, userDataPath });
      await promotePendingRestore({ userDataPath });
      assert.equal(fs.readFileSync(path.join(workspaceRoot, '.jenny', 'artifacts', 'existing.txt'), 'utf8'), 'keep');
      assert.equal(fs.existsSync(path.join(workspaceRoot, '.jenny', 'artifacts', 'from-archive.txt')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reviews and restores workspace-only data with stale-conflict rejection', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'artifacts', 'shared.txt');
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'current');
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [{ logicalPath: 'workspace/artifacts/shared.txt', category: 'workspace', data: 'restored' }],
      });
      const first = await inspectWorkspaceRestore({ archivePath: result.archivePath, workspaceRoot });
      assert.equal(first.conflictCount, 1);
      fs.writeFileSync(target, 'changed-after-review');
      await assert.rejects(restoreWorkspace({
        archivePath: result.archivePath,
        userDataPath,
        workspaceRoot,
        expectedDigest: first.digest,
      }), { reason: 'workspace_review_stale' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'changed-after-review');

      const refreshed = await inspectWorkspaceRestore({ archivePath: result.archivePath, workspaceRoot });
      const restored = await restoreWorkspace({
        archivePath: result.archivePath,
        userDataPath,
        workspaceRoot,
        expectedDigest: refreshed.digest,
      });
      assert.equal(restored.status, 'workspace_restored');
      assert.equal(fs.readFileSync(target, 'utf8'), 'restored');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates workspace approval when a conflict changes without changing size or timestamp', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'shared.txt');
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'before!');
      const fixedTime = new Date('2026-08-01T00:00:00.000Z');
      fs.utimesSync(target, fixedTime, fixedTime);
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [{ logicalPath: 'workspace/shared.txt', category: 'workspace', data: 'archive' }],
      });
      const review = await inspectWorkspaceRestore({ archivePath: result.archivePath, workspaceRoot });
      fs.writeFileSync(target, 'after!!');
      fs.utimesSync(target, fixedTime, fixedTime);

      await assert.rejects(restoreWorkspace({
        archivePath: result.archivePath,
        userDataPath,
        workspaceRoot,
        expectedDigest: review.digest,
      }), { reason: 'workspace_review_stale' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'after!!');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('revalidates approved conflicts after archive extraction before mutation', async () => {
    const root = makeTempRoot();
    const originalMkdtemp = fs.mkdtempSync;
    try {
      const userDataPath = path.join(root, 'profile');
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'shared.txt');
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'approved');
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [{ logicalPath: 'workspace/shared.txt', category: 'workspace', data: 'archive' }],
      });
      const review = await inspectWorkspaceRestore({ archivePath: result.archivePath, workspaceRoot });
      fs.mkdtempSync = function mutateAfterInspection(prefix) {
        fs.writeFileSync(target, 'external');
        return originalMkdtemp.call(this, prefix);
      };

      await assert.rejects(restoreWorkspace({
        archivePath: result.archivePath,
        userDataPath,
        workspaceRoot,
        expectedDigest: review.digest,
      }), { reason: 'workspace_review_stale' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'external');
    } finally {
      fs.mkdtempSync = originalMkdtemp;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the original conflict when creating its rollback backup fails', async () => {
    const root = makeTempRoot();
    const originalCopyFile = fs.promises.copyFile;
    try {
      const userDataPath = path.join(root, 'profile');
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'shared.txt');
      fs.mkdirSync(userDataPath, { recursive: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'original');
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [{ logicalPath: 'workspace/shared.txt', category: 'workspace', data: 'archive' }],
      });
      const review = await inspectWorkspaceRestore({ archivePath: result.archivePath, workspaceRoot });
      fs.promises.copyFile = async function failBackup(sourcePath, destinationPath) {
        if (path.resolve(sourcePath) === path.resolve(target) && String(destinationPath).includes(`${path.sep}rollback${path.sep}`)) {
          throw Object.assign(new Error('cross-device backup blocked'), { code: 'EXDEV' });
        }
        return originalCopyFile.apply(this, arguments);
      };

      await assert.rejects(restoreWorkspace({
        archivePath: result.archivePath,
        userDataPath,
        workspaceRoot,
        expectedDigest: review.digest,
      }), { code: 'EXDEV' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    } finally {
      fs.promises.copyFile = originalCopyFile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers an interrupted workspace restore from its same-volume journal', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'shared.txt');
      const stagePath = path.join(workspaceRoot, '.jenny', '.restore-staging', 'stage-crash1');
      const backupPath = path.join(stagePath, 'rollback', 'workspace', 'shared.txt');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(target, 'restored');
      fs.writeFileSync(backupPath, 'original');
      const identity = workspaceRootIdentity(workspaceRoot);
      const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
      fs.writeFileSync(path.join(stagePath, 'workspace-restore-journal.json'), JSON.stringify({
        schema_version: 1,
        status: 'mutating',
        stage_path: stagePath,
        workspace: { real_path: identity.realPath, dev: identity.dev, ino: identity.ino },
        entries: [{
          logical_path: 'workspace/shared.txt',
          sha256: hash('restored'),
          size: Buffer.byteLength('restored'),
          approved_signature: `${Buffer.byteLength('original')}:${hash('original')}`,
        }],
        completed_paths: ['workspace/shared.txt'],
      }));

      const recovered = await recoverWorkspaceRestoreStages({ workspaceRoot });

      assert.deepEqual(recovered, { ok: true, recoveredCount: 1 });
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
      assert.equal(fs.existsSync(stagePath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('completes recovery without a rollback backup when the target remains approved', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'shared.txt');
      const stagePath = path.join(workspaceRoot, '.jenny', '.restore-staging', 'stage-crash2');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.mkdirSync(stagePath, { recursive: true });
      fs.writeFileSync(target, 'original');
      const identity = workspaceRootIdentity(workspaceRoot);
      const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
      fs.writeFileSync(path.join(stagePath, 'workspace-restore-journal.json'), JSON.stringify({
        schema_version: 1,
        status: 'mutating',
        stage_path: stagePath,
        workspace: { real_path: identity.realPath, dev: identity.dev, ino: identity.ino },
        entries: [{
          logical_path: 'workspace/shared.txt',
          sha256: hash('restored'),
          size: Buffer.byteLength('restored'),
          approved_signature: `${Buffer.byteLength('original')}:${hash('original')}`,
        }],
        completed_paths: ['workspace/shared.txt'],
      }));
      assert.equal(fs.existsSync(path.join(stagePath, 'rollback', 'workspace', 'shared.txt')), false);

      const recovered = await recoverWorkspaceRestoreStages({ workspaceRoot });

      assert.deepEqual(recovered, { ok: true, recoveredCount: 1 });
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
      assert.equal(fs.existsSync(stagePath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves recovery evidence when the rollback backup and approved target are absent', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'shared.txt');
      const stagePath = path.join(workspaceRoot, '.jenny', '.restore-staging', 'stage-crash3');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.mkdirSync(stagePath, { recursive: true });
      fs.writeFileSync(target, 'restored');
      const identity = workspaceRootIdentity(workspaceRoot);
      const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
      fs.writeFileSync(path.join(stagePath, 'workspace-restore-journal.json'), JSON.stringify({
        schema_version: 1,
        status: 'mutating',
        stage_path: stagePath,
        workspace: { real_path: identity.realPath, dev: identity.dev, ino: identity.ino },
        entries: [{
          logical_path: 'workspace/shared.txt',
          sha256: hash('restored'),
          size: Buffer.byteLength('restored'),
          approved_signature: `${Buffer.byteLength('original')}:${hash('original')}`,
        }],
        completed_paths: ['workspace/shared.txt'],
      }));
      assert.equal(fs.existsSync(path.join(stagePath, 'rollback', 'workspace', 'shared.txt')), false);

      await assert.rejects(
        recoverWorkspaceRestoreStages({ workspaceRoot }),
        { code: 'CMP-DATA-0009', reason: 'workspace_restore_recovery_incomplete' }
      );
      assert.equal(fs.readFileSync(target, 'utf8'), 'restored');
      assert.equal(fs.existsSync(stagePath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the original target when the rollback backup durability barrier fails', async () => {
    const root = makeTempRoot();
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const originalFsync = fs.fsyncSync;
    const openedPaths = new Map();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'shared.txt');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'original');
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [{ logicalPath: 'workspace/shared.txt', category: 'workspace', data: 'archive' }],
      });
      const review = await inspectWorkspaceRestore({ archivePath: result.archivePath, workspaceRoot });
      fs.openSync = function trackOpen(filePath) {
        const descriptor = originalOpen.apply(this, arguments);
        openedPaths.set(descriptor, path.resolve(filePath));
        return descriptor;
      };
      fs.closeSync = function trackClose(descriptor) {
        openedPaths.delete(descriptor);
        return originalClose.apply(this, arguments);
      };
      fs.fsyncSync = function failBackupBarrier(descriptor) {
        const openedPath = openedPaths.get(descriptor) || '';
        if (openedPath.endsWith(`${path.sep}rollback${path.sep}workspace${path.sep}shared.txt`)) {
          throw Object.assign(new Error('backup flush failed'), { code: 'EIO' });
        }
        return originalFsync.apply(this, arguments);
      };

      await assert.rejects(restoreWorkspace({
        archivePath: result.archivePath,
        workspaceRoot,
        expectedDigest: review.digest,
      }), { code: 'EIO' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    } finally {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
      fs.fsyncSync = originalFsync;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back when the restored-target durability barrier fails before commit', async () => {
    const root = makeTempRoot();
    const originalOpen = fs.openSync;
    const originalClose = fs.closeSync;
    const originalFsync = fs.fsyncSync;
    const openedPaths = new Map();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const target = path.join(workspaceRoot, '.jenny', 'shared.txt');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'original');
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [{ logicalPath: 'workspace/shared.txt', category: 'workspace', data: 'archive' }],
      });
      const review = await inspectWorkspaceRestore({ archivePath: result.archivePath, workspaceRoot });
      fs.openSync = function trackOpen(filePath) {
        const descriptor = originalOpen.apply(this, arguments);
        openedPaths.set(descriptor, path.resolve(filePath));
        return descriptor;
      };
      fs.closeSync = function trackClose(descriptor) {
        openedPaths.delete(descriptor);
        return originalClose.apply(this, arguments);
      };
      fs.fsyncSync = function failRestoredTargetBarrier(descriptor) {
        if (openedPaths.get(descriptor) === path.resolve(target)) {
          throw Object.assign(new Error('target flush failed'), { code: 'EIO' });
        }
        return originalFsync.apply(this, arguments);
      };

      await assert.rejects(restoreWorkspace({
        archivePath: result.archivePath,
        workspaceRoot,
        expectedDigest: review.digest,
      }), { code: 'EIO' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    } finally {
      fs.openSync = originalOpen;
      fs.closeSync = originalClose;
      fs.fsyncSync = originalFsync;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed after the bounded dedicated restore-stage limit', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const stagingRoot = path.join(workspaceRoot, '.jenny', '.restore-staging');
      for (let index = 0; index < 21; index += 1) {
        fs.mkdirSync(path.join(stagingRoot, `stage-${String(index).padStart(6, '0')}`), { recursive: true });
      }
      await assert.rejects(
        recoverWorkspaceRestoreStages({ workspaceRoot }),
        { reason: 'workspace_restore_recovery_incomplete' }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a workspace restore target whose parent escapes through a junction', async (t) => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const outsideRoot = path.join(root, 'outside');
      const linkPath = path.join(workspaceRoot, '.jenny', 'artifacts');
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.mkdirSync(outsideRoot, { recursive: true });
      try {
        fs.symlinkSync(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        t.skip(`directory link creation unavailable: ${error.code || 'unknown'}`);
        return;
      }
      const result = await createArchive({
        destinationRoot: path.join(root, 'archives'),
        encrypted: false,
        entries: [{ logicalPath: 'workspace/artifacts/escaped.txt', category: 'workspace', data: 'blocked' }],
      });
      await assert.rejects(
        inspectWorkspaceRestore({ archivePath: result.archivePath, workspaceRoot }),
        { code: 'CMP-DATA-0003', reason: 'unsafe_restore_path' }
      );
      assert.equal(fs.existsSync(path.join(outsideRoot, 'escaped.txt')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
