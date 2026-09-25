'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createArchive, readManifest } = require('../../services/data-lifecycle/archive-service');
const { collectDataInventory } = require('../../services/data-lifecycle/data-inventory');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const {
  RUNTIME_ARCHIVE_ENTRIES,
  sanitizeProjectsForImport,
} = require('../../services/data-lifecycle/runtime-archive');
const {
  finalizeRestoredBoot,
  promotePendingRestore,
  restorePointerPath,
  stageRestore,
} = require('../../services/data-lifecycle/restore-service');
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');
const { ProjectService } = require('../../services/projects/project-service');
const { ProjectStore } = require('../../services/projects/project-store');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');

const CAPTURED_AUTHORITY = Object.freeze({
  project_id: 'project_alpha',
  root_path: 'G:\\shared-workspace',
  root_id: 'root_shared',
  root_revision: 1,
  device_id: '11',
  inode: '101',
});

test.afterEach(async () => cleanupTrackedResources());

function tempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  trackDirectory(root);
  return root;
}

function createProjectState(userDataPath, rootPath) {
  const store = new ProjectStore(path.join(userDataPath, 'projects.json'), {
    now: () => '2026-09-09T12:00:00.000Z',
  });
  const service = new ProjectService({
    store,
    idFactory: () => 'project_alpha',
    now: () => '2026-09-09T12:01:00.000Z',
  });
  assert.equal(service.create({ name: 'Alpha' }).ok, true);
  assert.equal(service.bindRoot('project_alpha', rootPath, { expectedRevision: 0 }).ok, true);
  return store.getSnapshot();
}

function createPermissionState(userDataPath) {
  const store = new ToolPermissionStore(path.join(userDataPath, 'tool-permissions.json'));
  store.setPolicy('run_command', 'deny');
  store.setPolicy('write_file', 'ask');
  store.grantAlwaysAllow('read_file', {}, CAPTURED_AUTHORITY);
  const permissionPath = path.join(userDataPath, 'tool-permissions.json');
  const document = JSON.parse(fs.readFileSync(permissionPath, 'utf8'));
  document.review_history.push({
    pending_id: 'review_prior',
    decision: 'deny',
    reviewed_at: '2026-09-09T11:00:00.000Z',
    scoped_grant_id: null,
    original_record: { source: 'local' },
  });
  fs.writeFileSync(permissionPath, JSON.stringify(document, null, 2));
  return document;
}

function wrapper(payloadKind, payload, version = 1) {
  return JSON.stringify({
    payload_schema_version: version,
    payload_kind: payloadKind,
    payload,
  });
}

function activeSessionExport() {
  return JSON.stringify({
    format: 'jenny-session-export',
    format_version: 1,
    exported_at: '2026-09-09T12:05:00.000Z',
    session: {
      title: 'Interrupted import',
      project_id: 'project_alpha',
      created_at: '2026-09-09T12:00:00.000Z',
      updated_at: '2026-09-09T12:04:00.000Z',
      active_turn: {
        request_id: 'request_old',
        stream_id: 'stream_old',
        user_message_id: 'message_user',
        started_at: '2026-09-09T12:03:00.000Z',
        last_event_at: '2026-09-09T12:04:00.000Z',
        status: 'streaming',
      },
      messages: [{ id: 'message_user', role: 'user', content: 'Continue this' }],
    },
  });
}

async function archiveRuntimeEntries(root, entries, name = 'Runtime.jenny-archive') {
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: name,
    encrypted: false,
    entries,
  });
  return result.archivePath;
}

test('project and permission state round-trip through archive v1 with authority stripped', async () => {
  const root = tempRoot('jenny-portable-roundtrip');
  const sourceProfile = path.join(root, 'source-profile');
  const destinationProfile = path.join(root, 'destination-profile');
  const sourceWorkspace = path.join(root, 'shared-workspace');
  fs.mkdirSync(sourceProfile, { recursive: true });
  fs.mkdirSync(destinationProfile, { recursive: true });
  fs.mkdirSync(sourceWorkspace, { recursive: true });
  const sourceProjects = createProjectState(sourceProfile, sourceWorkspace);
  createPermissionState(sourceProfile);

  const inventory = collectDataInventory({ userDataPath: sourceProfile });
  assert.deepEqual(
    inventory.entries
      .filter((entry) => entry.logicalPath.startsWith('runtime/'))
      .map((entry) => [entry.logicalPath, entry.category]),
    [
      ['runtime/projects.json', 'project_state'],
      ['runtime/tool-permissions.json', 'tool_permissions'],
    ]
  );
  assert.equal(inventory.counts.projects, 1);
  assert.equal(inventory.counts.permissions, 1);
  inventory.entries.push({
    logicalPath: 'sessions/interrupted.json',
    category: 'chats',
    data: Buffer.from(activeSessionExport()),
    restoreMetadata: { session_id: 'sess_imported_active' },
  });

  const archivePath = await archiveRuntimeEntries(root, inventory.entries);
  const archive = await readManifest(archivePath);
  assert.equal(archive.envelope.format_version, 1);
  assert.deepEqual(archive.manifest.category_counts, {
    chats: 1,
    project_state: 1,
    tool_permissions: 1,
  });

  const destinationProjects = new ProjectStore(path.join(destinationProfile, 'projects.json'));
  const destinationPermissions = new ToolPermissionStore(
    path.join(destinationProfile, 'tool-permissions.json')
  );
  assert.equal(destinationProjects.getSnapshot().projects[GENERAL_PROJECT_ID].root_path, null);
  assert.equal(destinationPermissions.getReviewState().pending_count, 0);

  await stageRestore({ archivePath, userDataPath: destinationProfile });
  const promoted = await promotePendingRestore({ userDataPath: destinationProfile });
  assert.equal(promoted.status, 'promoted');

  const restoredProjects = JSON.parse(
    fs.readFileSync(path.join(destinationProfile, 'projects.json'), 'utf8')
  );
  assert.deepEqual(Object.keys(restoredProjects.projects).sort(), [
    'project_alpha',
    GENERAL_PROJECT_ID,
  ]);
  assert.equal(restoredProjects.projects[GENERAL_PROJECT_ID].root_path, null);
  assert.equal(
    restoredProjects.projects[GENERAL_PROJECT_ID].root_revision,
    sourceProjects.projects[GENERAL_PROJECT_ID].root_revision + 1
  );
  assert.equal(restoredProjects.projects.project_alpha.root_path, null);
  assert.equal(restoredProjects.projects.project_alpha.root_id, null);
  assert.equal(
    restoredProjects.projects.project_alpha.root_revision,
    sourceProjects.projects.project_alpha.root_revision + 1
  );

  const restoredPermissions = JSON.parse(
    fs.readFileSync(path.join(destinationProfile, 'tool-permissions.json'), 'utf8')
  );
  assert.equal(restoredPermissions.legacy_policies.run_command, 'deny');
  assert.equal(restoredPermissions.legacy_policies.write_file, 'ask');
  assert.deepEqual(restoredPermissions.scoped_grants, []);
  assert.equal(restoredPermissions.pending_review.length, 1);
  assert.equal(restoredPermissions.pending_review[0].source, 'import');
  assert.equal(restoredPermissions.pending_review[0].original_kind, 'scoped_grant');
  assert.deepEqual(restoredPermissions.review_history, [{
    pending_id: 'review_prior',
    decision: 'deny',
    reviewed_at: '2026-09-09T11:00:00.000Z',
    scoped_grant_id: null,
    original_record: { source: 'local' },
  }]);
  const restoredSessions = new ElectronSessionStore(path.join(destinationProfile, 'sessions.json'));
  assert.equal(restoredSessions.getSession('sess_imported_active').active_turn, null);
  restoredSessions.dispose();
  assert.equal(await finalizeRestoredBoot(destinationProfile), true);
});

test('every runtime payload is validated before a restore transaction can mutate the profile', async () => {
  const root = tempRoot('jenny-portable-prevalidation');
  const sourceProfile = path.join(root, 'source');
  const destinationProfile = path.join(root, 'destination');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(sourceProfile, { recursive: true });
  fs.mkdirSync(destinationProfile, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const projects = createProjectState(sourceProfile, workspace);
  const destinationProjectStore = new ProjectStore(path.join(destinationProfile, 'projects.json'));
  const destinationPermissionStore = new ToolPermissionStore(
    path.join(destinationProfile, 'tool-permissions.json')
  );
  const projectsBefore = fs.readFileSync(path.join(destinationProfile, 'projects.json'));
  const permissionsBefore = fs.readFileSync(path.join(destinationProfile, 'tool-permissions.json'));
  void destinationProjectStore;
  void destinationPermissionStore;

  const archivePath = await archiveRuntimeEntries(root, [
    {
      logicalPath: RUNTIME_ARCHIVE_ENTRIES.projects.logicalPath,
      category: RUNTIME_ARCHIVE_ENTRIES.projects.category,
      data: wrapper('project_state', projects),
    },
    {
      logicalPath: RUNTIME_ARCHIVE_ENTRIES.toolPermissions.logicalPath,
      category: RUNTIME_ARCHIVE_ENTRIES.toolPermissions.category,
      data: wrapper('tool_permissions', { schema_version: 2, invalid: true }),
    },
  ], 'Invalid-permissions.jenny-archive');

  await assert.rejects(stageRestore({ archivePath, userDataPath: destinationProfile }), {
    code: 'CMP-DATA-0007',
    reason: 'permission_payload_invalid',
  });
  assert.deepEqual(fs.readFileSync(path.join(destinationProfile, 'projects.json')), projectsBefore);
  assert.deepEqual(
    fs.readFileSync(path.join(destinationProfile, 'tool-permissions.json')),
    permissionsBefore
  );
  assert.equal(fs.existsSync(restorePointerPath(destinationProfile)), false);
});

test('calendar aliases cannot bypass runtime payload validation or mutate reserved stores', async () => {
  const root = tempRoot('jenny-portable-calendar-alias');
  for (const fileName of ['projects.json', 'tool-permissions.json', 'runtime-ledger.json']) {
    const destinationProfile = path.join(root, `destination-${fileName}`);
    fs.mkdirSync(destinationProfile);
    new ProjectStore(path.join(destinationProfile, 'projects.json'));
    new ToolPermissionStore(path.join(destinationProfile, 'tool-permissions.json'));
    const projectBytes = fs.readFileSync(path.join(destinationProfile, 'projects.json'));
    const permissionBytes = fs.readFileSync(path.join(destinationProfile, 'tool-permissions.json'));
    const archivePath = await archiveRuntimeEntries(path.join(root, fileName), [{
      logicalPath: `calendar/${fileName}`,
      category: 'memory',
      data: Buffer.from('{"attacker":true}'),
    }], `Alias-${fileName}.jenny-archive`);

    await assert.rejects(stageRestore({ archivePath, userDataPath: destinationProfile }), {
      code: 'CMP-DATA-0007',
      reason: 'restore_entry_disallowed',
    });
    assert.deepEqual(fs.readFileSync(path.join(destinationProfile, 'projects.json')), projectBytes);
    assert.deepEqual(
      fs.readFileSync(path.join(destinationProfile, 'tool-permissions.json')),
      permissionBytes
    );
    assert.equal(fs.existsSync(restorePointerPath(destinationProfile)), false);
  }
});

test('authored project state makes a profile non-fresh at stage and promotion', async () => {
  const root = tempRoot('jenny-portable-project-freshness');
  const sourceProfile = path.join(root, 'source');
  const authoredAtStage = path.join(root, 'authored-at-stage');
  const authoredAtPromotion = path.join(root, 'authored-at-promotion');
  const workspace = path.join(root, 'workspace');
  for (const directory of [sourceProfile, authoredAtStage, authoredAtPromotion, workspace]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  createProjectState(sourceProfile, workspace);
  const archivePath = await archiveRuntimeEntries(
    root,
    collectDataInventory({ userDataPath: sourceProfile }).entries
  );

  const stageStore = new ProjectStore(path.join(authoredAtStage, 'projects.json'));
  const stageProjects = new ProjectService({ store: stageStore, idFactory: () => 'project_existing' });
  assert.equal(stageProjects.create({ name: 'Existing' }).ok, true);
  const stageBytes = fs.readFileSync(path.join(authoredAtStage, 'projects.json'));
  await assert.rejects(stageRestore({ archivePath, userDataPath: authoredAtStage }), {
    code: 'CMP-DATA-0009', reason: 'profile_not_fresh',
  });
  assert.deepEqual(fs.readFileSync(path.join(authoredAtStage, 'projects.json')), stageBytes);
  assert.equal(fs.existsSync(restorePointerPath(authoredAtStage)), false);

  const promotionStore = new ProjectStore(path.join(authoredAtPromotion, 'projects.json'));
  await stageRestore({ archivePath, userDataPath: authoredAtPromotion });
  const promotionProjects = new ProjectService({
    store: promotionStore,
    idFactory: () => 'project_created_after_stage',
  });
  assert.equal(promotionProjects.create({ name: 'Created after stage' }).ok, true);
  const promotionBytes = fs.readFileSync(path.join(authoredAtPromotion, 'projects.json'));
  await assert.rejects(promotePendingRestore({ userDataPath: authoredAtPromotion }), {
    code: 'CMP-DATA-0009', reason: 'profile_not_fresh',
  });
  assert.deepEqual(
    fs.readFileSync(path.join(authoredAtPromotion, 'projects.json')),
    promotionBytes
  );
  assert.equal(fs.existsSync(restorePointerPath(authoredAtPromotion)), true);
});

test('future payload versions and a malformed runtime ledger reject the whole restore', async () => {
  const root = tempRoot('jenny-portable-future');
  const sourceProfile = path.join(root, 'source');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(sourceProfile, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const projects = createProjectState(sourceProfile, workspace);
  const cases = [
    {
      name: 'future-project-payload',
      entry: {
        logicalPath: RUNTIME_ARCHIVE_ENTRIES.projects.logicalPath,
        category: RUNTIME_ARCHIVE_ENTRIES.projects.category,
        data: wrapper('project_state', projects, 99),
      },
      reason: 'unsupported_runtime_payload_version',
    },
    {
      name: 'future-project-document',
      entry: {
        logicalPath: RUNTIME_ARCHIVE_ENTRIES.projects.logicalPath,
        category: RUNTIME_ARCHIVE_ENTRIES.projects.category,
        data: wrapper('project_state', { ...projects, schema_version: 99 }),
      },
      reason: 'unsupported_project_payload_version',
    },
    {
      name: 'future-permission-document',
      entry: {
        logicalPath: RUNTIME_ARCHIVE_ENTRIES.toolPermissions.logicalPath,
        category: RUNTIME_ARCHIVE_ENTRIES.toolPermissions.category,
        data: wrapper('tool_permissions', { schema_version: 99 }),
      },
      reason: 'unsupported_permission_payload_version',
    },
    {
      name: 'malformed-runtime-ledger',
      entry: {
        logicalPath: RUNTIME_ARCHIVE_ENTRIES.runtimeLedger.logicalPath,
        category: RUNTIME_ARCHIVE_ENTRIES.runtimeLedger.category,
        data: wrapper('runtime_state', { schema_version: 1 }),
      },
      code: 'CMP-DATA-0007',
      reason: 'runtime_ledger_payload_invalid',
    },
  ];

  for (const entry of cases) {
    const destinationProfile = path.join(root, `destination-${entry.name}`);
    fs.mkdirSync(destinationProfile);
    const baseline = new ProjectStore(path.join(destinationProfile, 'projects.json'));
    const before = fs.readFileSync(path.join(destinationProfile, 'projects.json'));
    void baseline;
    const archivePath = await archiveRuntimeEntries(
      path.join(root, entry.name),
      [entry.entry],
      `${entry.name}.jenny-archive`
    );
    await assert.rejects(stageRestore({ archivePath, userDataPath: destinationProfile }), {
      code: entry.code || 'CMP-DATA-0008',
      reason: entry.reason,
    });
    assert.deepEqual(fs.readFileSync(path.join(destinationProfile, 'projects.json')), before);
    assert.equal(fs.existsSync(restorePointerPath(destinationProfile)), false);
  }
});

test('promotion failure rolls both runtime stores back to their exact prior bytes', async () => {
  const root = tempRoot('jenny-portable-rollback');
  const sourceProfile = path.join(root, 'source');
  const destinationProfile = path.join(root, 'destination');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(sourceProfile, { recursive: true });
  fs.mkdirSync(destinationProfile, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  createProjectState(sourceProfile, workspace);
  createPermissionState(sourceProfile);
  const inventory = collectDataInventory({ userDataPath: sourceProfile });
  const archivePath = await archiveRuntimeEntries(root, inventory.entries);

  new ProjectStore(path.join(destinationProfile, 'projects.json'));
  new ToolPermissionStore(path.join(destinationProfile, 'tool-permissions.json'));
  const projectPath = path.join(destinationProfile, 'projects.json');
  const permissionPath = path.join(destinationProfile, 'tool-permissions.json');
  const projectsBefore = fs.readFileSync(projectPath);
  const permissionsBefore = fs.readFileSync(permissionPath);
  await stageRestore({ archivePath, userDataPath: destinationProfile });

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function failPermissionPublish(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(permissionPath)) {
      throw Object.assign(new Error('simulated permission publish failure'), { code: 'ENOSPC' });
    }
    return originalWriteFileSync.call(fs, filePath, ...args);
  };
  try {
    await assert.rejects(promotePendingRestore({ userDataPath: destinationProfile }), /publish failure/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.deepEqual(fs.readFileSync(projectPath), projectsBefore);
  assert.deepEqual(fs.readFileSync(permissionPath), permissionsBefore);
  assert.equal(fs.existsSync(restorePointerPath(destinationProfile)), true);
});

test('project root invalidation refuses revision overflow', () => {
  const root = tempRoot('jenny-portable-revision');
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const projects = createProjectState(profile, workspace);
  projects.projects.project_alpha.root_revision = Number.MAX_SAFE_INTEGER;

  assert.throws(
    () => sanitizeProjectsForImport(projects, '2026-09-09T12:02:00.000Z'),
    { code: 'CMP-DATA-0007', reason: 'project_root_revision_exhausted' }
  );
});
