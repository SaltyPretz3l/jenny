const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DataLifecycleService,
  REMOVAL_CHOICES,
} = require('../services/data-lifecycle/data-lifecycle-service');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-data-lifecycle-service-'));
}

function createSessionStore() {
  const session = {
    id: 'sess_test',
    title: 'Test',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    messages: [{ id: 'msg_1', role: 'user', content: 'Hello', attachments: [] }],
  };
  return {
    listSessions: () => [{ id: session.id }],
    getSession: (id) => id === session.id ? session : null,
    flushAsync: async () => {},
  };
}

describe('DataLifecycleService', () => {
  it('creates a verified archive from the canonical inventory and emits bounded progress', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      const documentsPath = path.join(root, 'Documents');
      fs.mkdirSync(userDataPath, { recursive: true });
      const service = new DataLifecycleService({
        userDataPath,
        documentsPath,
        sessionStore: createSessionStore(),
      });
      service.syncPortablePreferences({ appearance: { paletteId: 'obsidian' } });
      const progress = [];
      service.on('progress', (event) => progress.push(event));

      const result = await service.createArchive({ encrypted: false });
      assert.equal(result.ok, true);
      assert.equal(result.status, 'archive_verified');
      assert.equal(fs.existsSync(path.join(result.archivePath, 'COMPLETE')), true);
      assert.equal(progress.at(-1).phase, 'complete');
      assert.equal(progress.every((event) => event.operationId === result.operationId), true);

      // "from the canonical inventory": an archive built with no sessionStore
      // still verifies and still writes COMPLETE, so the manifest has to be read.
      const manifest = JSON.parse(fs.readFileSync(path.join(result.archivePath, 'manifest.json'), 'utf8'));
      const logicalPaths = manifest.entries.map((entry) => entry.logical_path);
      assert.equal(
        logicalPaths.some((logicalPath) => logicalPath.startsWith('sessions/')),
        true,
        'the archive must carry the canonical session records'
      );
      assert.equal(logicalPaths.includes('preferences/portable-preferences.json'), true);

      // "bounded progress": nothing checked the bounds the title promises.
      for (const event of progress) {
        assert.equal(Number.isInteger(event.percent) && event.percent >= 0 && event.percent <= 100,
          true, `percent out of bounds: ${event.percent}`);
        assert.equal(Number.isFinite(event.completedBytes) && event.completedBytes >= 0, true);
        assert.equal(Number.isFinite(event.totalBytes) && event.totalBytes >= 0, true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not authorize permanent cleanup without the exact confirmation', async () => {
    const root = makeTempRoot();
    try {
      let handoffCount = 0;
      const service = new DataLifecycleService({
        userDataPath: path.join(root, 'profile'),
        documentsPath: path.join(root, 'Documents'),
        prepareForRemoval: async () => { handoffCount += 1; },
      });
      const rejected = await service.prepareRemoval({
        choice: REMOVAL_CHOICES.PERMANENT,
        confirmation: 'remove jenny',
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.reason, 'confirmation_required');
      assert.equal(handoffCount, 0);

      const accepted = await service.prepareRemoval({
        choice: REMOVAL_CHOICES.PERMANENT,
        confirmation: 'REMOVE JENNY',
      });
      assert.equal(accepted.ok, true);
      assert.equal(accepted.status, 'cleanup_authorized');
      assert.equal(handoffCount, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves data for app-only removal and reports a fresh overview', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath, { recursive: true });
      const service = new DataLifecycleService({
        userDataPath,
        documentsPath: path.join(root, 'Documents'),
      });
      const overview = await service.getOverview();
      assert.equal(overview.ok, true);
      assert.equal(overview.freshProfile, true);
      const removal = await service.prepareRemoval({ choice: REMOVAL_CHOICES.APP_ONLY });
      assert.equal(removal.removalMode, REMOVAL_CHOICES.APP_ONLY);
      assert.equal(fs.existsSync(userDataPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a truthful incomplete cleanup receipt instead of success', async () => {
    const root = makeTempRoot();
    try {
      const service = new DataLifecycleService({
        userDataPath: path.join(root, 'profile'),
        documentsPath: path.join(root, 'Documents'),
        prepareForRemoval: async () => ({
          ok: false,
          status: 'incomplete',
          results: [{ kind: 'runtime_child', status: 'retained', reason: 'EPERM' }],
          warnings: ['One item was retained.'],
        }),
      });
      const result = await service.prepareRemoval({
        choice: REMOVAL_CHOICES.PERMANENT,
        confirmation: 'REMOVE JENNY',
      });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'CMP-DATA-0010');
      assert.deepEqual(result.cleanupResults, [{ kind: 'runtime_child', status: 'retained', reason: 'EPERM' }]);
      assert.deepEqual(result.warnings, ['One item was retained.']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors cancellation before archive verification and leaves no complete archive', async () => {
    const root = makeTempRoot();
    try {
      const service = new DataLifecycleService({
        userDataPath: path.join(root, 'profile'),
        documentsPath: path.join(root, 'Documents'),
        sessionStore: createSessionStore(),
      });
      service.on('progress', (progress) => {
        if (progress.phase === 'preparing') service.cancel(progress.operationId);
      });
      const result = await service.createArchive({ encrypted: false });
      assert.equal(result.ok, false);
      assert.equal(result.error.reason, 'operation_cancelled');
      const archiveRoot = path.join(root, 'Documents', 'Jenny Archives');
      const complete = fs.existsSync(archiveRoot)
        ? fs.readdirSync(archiveRoot).filter((name) => name.endsWith('.jenny-archive'))
        : [];
      assert.deepEqual(complete, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects archive-and-remove when the archive destination would be deleted', async () => {
    const root = makeTempRoot();
    try {
      const userDataPath = path.join(root, 'profile');
      fs.mkdirSync(userDataPath, { recursive: true });
      let handoffCount = 0;
      const service = new DataLifecycleService({
        userDataPath,
        documentsPath: path.join(root, 'Documents'),
        prepareForRemoval: async () => { handoffCount += 1; },
      });
      const result = await service.prepareRemoval({
        choice: REMOVAL_CHOICES.ARCHIVE_AND_REMOVE,
        archive: {
          encrypted: false,
          destinationRoot: path.join(userDataPath, 'unsafe-archive-folder'),
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'CMP-DATA-0003');
      assert.equal(result.error.reason, 'archive_destination_removed_by_cleanup');
      assert.equal(handoffCount, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never removes workspace data that was not included in the verified archive', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      fs.mkdirSync(workspaceRoot, { recursive: true });
      let preparation = null;
      const service = new DataLifecycleService({
        userDataPath: path.join(root, 'profile'),
        documentsPath: path.join(root, 'Documents'),
        shellConfigService: { getState: () => ({ toolsWorkspaceRoot: workspaceRoot }) },
        prepareForRemoval: async (value) => { preparation = value; },
      });
      const result = await service.prepareRemoval({
        choice: REMOVAL_CHOICES.ARCHIVE_AND_REMOVE,
        archive: { encrypted: false, includeWorkspace: false },
        removeWorkspaceData: true,
      });
      assert.equal(result.ok, true);
      assert.equal(result.removeWorkspaceData, false);
      assert.equal(preparation.removeWorkspaceData, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires an exact one-time workspace archive review and rejects drift', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      fs.mkdirSync(path.join(workspaceRoot, '.jenny', 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, '.jenny', 'artifacts', 'one.txt'), 'one');
      const service = new DataLifecycleService({
        userDataPath: path.join(root, 'profile'),
        documentsPath: path.join(root, 'Documents'),
        shellConfigService: { getState: () => ({ toolsWorkspaceRoot: workspaceRoot }) },
      });

      const missing = await service.createArchive({ encrypted: false, includeWorkspace: true });
      assert.equal(missing.error.reason, 'workspace_review_required');
      const preview = await service.previewWorkspaceArchive();
      assert.equal(preview.itemCount, 1);
      assert.equal(preview.scope, '.jenny portable data only');
      fs.writeFileSync(path.join(workspaceRoot, '.jenny', 'artifacts', 'two.txt'), 'two');
      const stale = await service.createArchive({
        encrypted: false,
        includeWorkspace: true,
        workspaceReviewId: preview.reviewId,
      });
      assert.equal(stale.error.reason, 'workspace_review_required');

      const refreshed = await service.previewWorkspaceArchive();
      assert.equal(refreshed.itemCount, 2);
      fs.writeFileSync(path.join(workspaceRoot, '.jenny', 'artifacts', 'one.txt'), 'ONE');
      const sameSizeDrift = await service.createArchive({
        encrypted: false,
        includeWorkspace: true,
        workspaceReviewId: refreshed.reviewId,
      });
      assert.equal(sameSizeDrift.error.reason, 'workspace_review_required');

      const finalReview = await service.previewWorkspaceArchive();
      const accepted = await service.createArchive({
        encrypted: false,
        includeWorkspace: true,
        workspaceReviewId: finalReview.reviewId,
      });
      assert.equal(accepted.ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts unchanged workspace inventory when enumeration order changes', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      const artifactsRoot = path.join(workspaceRoot, '.jenny', 'artifacts');
      fs.mkdirSync(artifactsRoot, { recursive: true });
      fs.writeFileSync(path.join(artifactsRoot, 'one.txt'), 'one');
      fs.writeFileSync(path.join(artifactsRoot, 'two.txt'), 'two');
      const service = new DataLifecycleService({
        userDataPath: path.join(root, 'profile'),
        documentsPath: path.join(root, 'Documents'),
        shellConfigService: { getState: () => ({ toolsWorkspaceRoot: workspaceRoot }) },
      });
      const collectInventory = service._collectInventory.bind(service);
      let collectionCount = 0;
      service._collectInventory = (...args) => {
        const inventory = collectInventory(...args);
        collectionCount += 1;
        return collectionCount === 2
          ? { ...inventory, entries: [...inventory.entries].reverse() }
          : inventory;
      };

      const preview = await service.previewWorkspaceArchive();
      const archived = await service.createArchive({
        encrypted: false,
        includeWorkspace: true,
        workspaceReviewId: preview.reviewId,
      });

      assert.equal(preview.itemCount, 2);
      assert.equal(archived.ok, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rescans workspace recovery stages after an earlier scan has settled', async () => {
    const root = makeTempRoot();
    try {
      const workspaceRoot = path.join(root, 'workspace');
      fs.mkdirSync(workspaceRoot, { recursive: true });
      const service = new DataLifecycleService({
        userDataPath: path.join(root, 'profile'),
        documentsPath: path.join(root, 'Documents'),
        shellConfigService: { getState: () => ({ toolsWorkspaceRoot: workspaceRoot }) },
      });

      await service._ensureWorkspaceRecovery();
      fs.mkdirSync(
        path.join(workspaceRoot, '.jenny', '.restore-staging', 'unexpected-stage'),
        { recursive: true }
      );

      await assert.rejects(
        service._ensureWorkspaceRecovery(),
        { reason: 'workspace_restore_recovery_incomplete' }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
