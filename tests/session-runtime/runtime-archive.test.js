'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createArchive } = require('../../services/data-lifecycle/archive-service');
const {
  collectRuntimeArchiveEntries,
  RUNTIME_ARCHIVE_ENTRIES,
} = require('../../services/data-lifecycle/runtime-archive');
const {
  collectRuntimeLedgerPayload,
  projectRuntimeLedgerPayload,
  publishRuntimeLedgerProjection,
} = require('../../services/data-lifecycle/runtime-ledger-archive');
const {
  promotePendingRestore,
  restorePointerPath,
  stageRestore,
} = require('../../services/data-lifecycle/restore-service');
const { stableJson, validateIndexDocument, validateWorkRecord } = require('../../services/session-runtime/contracts');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function tempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  trackDirectory(root);
  return root;
}

function authority() {
  return {
    project_id: 'project_alpha',
    root_path: 'G:\\workspace',
    root_id: 'root_alpha',
    root_revision: 4,
    device_id: 'device_1',
    inode: 'inode_1',
  };
}

function submit(store, suffix) {
  return store.submit({
    idempotencyKey: `idempotency_${suffix}`,
    projectId: 'project_alpha',
    sessionId: `session_${suffix}`,
    purpose: `Purpose ${suffix}`,
    input: { prompt: `Prompt ${suffix}` },
    authority: authority(),
    workId: `work_${suffix}`,
    turnId: `turn_${suffix}`,
  }).record;
}

function snapshotDirectory(root) {
  const snapshot = new Map();
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) visit(absolute);
      else snapshot.set(relative, fs.readFileSync(absolute));
    }
  }
  visit(root);
  return snapshot;
}

function assertSnapshot(root, expected) {
  const actual = snapshotDirectory(root);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [name, bytes] of expected) assert.deepEqual(actual.get(name), bytes, name);
}

test('ledger export validates a stable per-work snapshot without performing recovery writes', () => {
  const profile = tempRoot('jenny-runtime-ledger-export');
  const storeRoot = path.join(profile, 'session-runtime');
  const store = new RuntimeStore(storeRoot);
  const pending = submit(store, 'running');
  const attempt = {
    attempt_id: 'attempt_1',
    stream_id: 'stream_1',
    incarnation: 'incarnation_1',
    authority_revision: 'authority_1',
  };
  store.transition(pending.work_id, {
    expectedRevision: pending.revision,
    to: 'running',
    reason: 'Started.',
    transitionId: 'transition_running',
    attempt,
  });
  const before = snapshotDirectory(storeRoot);

  const payload = collectRuntimeLedgerPayload(profile);

  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].status, 'running');
  assert.deepEqual(payload.records[0].attempt, attempt);
  assertSnapshot(storeRoot, before);
  const archiveEntry = collectRuntimeArchiveEntries(profile).find((entry) => (
    entry.logicalPath === RUNTIME_ARCHIVE_ENTRIES.runtimeLedger.logicalPath
  ));
  assert.equal(archiveEntry.category, 'runtime_state');
});

test('ledger import pauses every nonterminal record, invalidates authority, and preserves terminal receipts', () => {
  const profile = tempRoot('jenny-runtime-ledger-project');
  const store = new RuntimeStore(path.join(profile, 'session-runtime'));
  const running = submit(store, 'running');
  const attempt = {
    attempt_id: 'attempt_2',
    stream_id: 'stream_2',
    incarnation: 'incarnation_2',
    authority_revision: 'authority_2',
  };
  store.transition(running.work_id, {
    expectedRevision: running.revision,
    to: 'running',
    reason: 'Started.',
    transitionId: 'transition_running_2',
    attempt,
  });
  const cancelled = submit(store, 'cancelled');
  const terminal = store.transition(cancelled.work_id, {
    expectedRevision: cancelled.revision,
    to: 'cancelled',
    reason: 'Cancelled.',
    transitionId: 'transition_cancelled',
  }).record;
  const source = collectRuntimeLedgerPayload(profile);

  const projection = projectRuntimeLedgerPayload(source, { now: '2026-09-09T14:00:00.000Z' });
  const documents = new Map(projection.files.map((file) => [file.relativePath, JSON.parse(file.bytes)]));
  const imported = documents.get(path.join('work', 'work_running.json'));
  const importedTerminal = documents.get(path.join('work', 'work_cancelled.json'));
  const index = documents.get('index.json');

  assert.equal(imported.status, 'paused');
  assert.deepEqual(imported.attempt, attempt);
  assert.deepEqual(imported.authority, {
    project_id: 'project_alpha',
    root_path: null,
    root_id: null,
    root_revision: 5,
    device_id: null,
    inode: null,
  });
  assert.equal(imported.recovery.kind, 'restart_paused');
  assert.equal(validateWorkRecord(imported).ok, true);
  assert.equal(stableJson(importedTerminal), stableJson(terminal));
  assert.equal(validateIndexDocument(index).ok, true);
  assert.deepEqual(index.summaries.map((entry) => entry.status), ['paused', 'cancelled']);
});

test('restore accepts an untouched runtime bootstrap and rolls its exact bytes back after publish failure', async () => {
  const root = tempRoot('jenny-runtime-ledger-rollback');
  const sourceProfile = path.join(root, 'source');
  const destinationProfile = path.join(root, 'destination');
  fs.mkdirSync(sourceProfile);
  fs.mkdirSync(destinationProfile);
  const sourceStore = new RuntimeStore(path.join(sourceProfile, 'session-runtime'));
  submit(sourceStore, 'portable');
  const ledgerEntry = collectRuntimeArchiveEntries(sourceProfile).find((entry) => (
    entry.logicalPath === RUNTIME_ARCHIVE_ENTRIES.runtimeLedger.logicalPath
  ));
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Runtime-ledger.jenny-archive',
    encrypted: false,
    entries: [ledgerEntry, {
      logicalPath: 'memory/sidecar-memory.db',
      category: 'memory',
      data: Buffer.from('force a later copy'),
    }],
  });
  new RuntimeStore(path.join(destinationProfile, 'session-runtime'));
  const before = snapshotDirectory(path.join(destinationProfile, 'session-runtime'));

  await stageRestore({ archivePath: result.archivePath, userDataPath: destinationProfile });
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = () => { throw new Error('publish failure'); };
  try {
    await assert.rejects(promotePendingRestore({ userDataPath: destinationProfile }), /publish failure/);
  } finally {
    fs.copyFileSync = originalCopy;
  }

  assertSnapshot(path.join(destinationProfile, 'session-runtime'), before);
  assert.equal(fs.existsSync(restorePointerPath(destinationProfile)), true);
});

test('promoted ledger opens as paused work without replaying its captured attempt', async () => {
  const root = tempRoot('jenny-runtime-ledger-roundtrip');
  const sourceProfile = path.join(root, 'source');
  const destinationProfile = path.join(root, 'destination');
  fs.mkdirSync(sourceProfile);
  fs.mkdirSync(destinationProfile);
  const sourceStore = new RuntimeStore(path.join(sourceProfile, 'session-runtime'));
  const pending = submit(sourceStore, 'resume');
  const attempt = {
    attempt_id: 'attempt_resume',
    stream_id: 'stream_resume',
    incarnation: 'incarnation_resume',
    authority_revision: 'authority_resume',
  };
  sourceStore.transition(pending.work_id, {
    expectedRevision: pending.revision,
    to: 'running',
    reason: 'Started.',
    transitionId: 'transition_resume',
    attempt,
  });
  const ledgerEntry = collectRuntimeArchiveEntries(sourceProfile).find((entry) => (
    entry.logicalPath === RUNTIME_ARCHIVE_ENTRIES.runtimeLedger.logicalPath
  ));
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Runtime-ledger-roundtrip.jenny-archive',
    encrypted: false,
    entries: [ledgerEntry],
  });
  new RuntimeStore(path.join(destinationProfile, 'session-runtime'));

  await stageRestore({ archivePath: result.archivePath, userDataPath: destinationProfile });
  assert.equal((await promotePendingRestore({ userDataPath: destinationProfile })).status, 'promoted');
  const restored = new RuntimeStore(path.join(destinationProfile, 'session-runtime'));
  const record = restored.get('work_resume');

  assert.equal(record.status, 'paused');
  assert.deepEqual(record.attempt, attempt);
  assert.equal(record.authority.root_path, null);
  assert.equal(record.authority.root_revision, 5);
  assert.equal(restored.listReadyCandidates().length, 0);
});

test('promotion projects the exact runtime bytes held by checksum verification', async () => {
  const root = tempRoot('jenny-runtime-ledger-verified-bytes');
  const sourceProfile = path.join(root, 'source');
  const destinationProfile = path.join(root, 'destination');
  fs.mkdirSync(sourceProfile);
  fs.mkdirSync(destinationProfile);
  const sourceStore = new RuntimeStore(path.join(sourceProfile, 'session-runtime'));
  submit(sourceStore, 'verified');
  const ledgerEntry = collectRuntimeArchiveEntries(sourceProfile).find((entry) => (
    entry.logicalPath === RUNTIME_ARCHIVE_ENTRIES.runtimeLedger.logicalPath
  ));
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Verified-runtime-ledger.jenny-archive',
    encrypted: false,
    entries: [ledgerEntry],
  });
  new RuntimeStore(path.join(destinationProfile, 'session-runtime'));
  await stageRestore({ archivePath: result.archivePath, userDataPath: destinationProfile });
  const pointer = JSON.parse(fs.readFileSync(restorePointerPath(destinationProfile), 'utf8'));
  const stagedLedger = path.join(pointer.stage_path, 'data', 'runtime', 'runtime-ledger.json');
  const originalCreateReadStream = fs.createReadStream;
  let replaced = false;
  fs.createReadStream = function replaceAfterRead(filePath, options) {
    const stream = originalCreateReadStream.call(fs, filePath, options);
    if (path.resolve(filePath) === path.resolve(stagedLedger)) {
      stream.once('end', () => {
        fs.renameSync(stagedLedger, `${stagedLedger}.verified`);
        fs.writeFileSync(stagedLedger, '{}');
        replaced = true;
      });
    }
    return stream;
  };
  try {
    assert.equal((await promotePendingRestore({ userDataPath: destinationProfile })).status, 'promoted');
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }

  assert.equal(replaced, true);
  const restored = new RuntimeStore(path.join(destinationProfile, 'session-runtime'));
  assert.equal(restored.get('work_verified').status, 'paused');
});

test('ledger publication refuses a replaced work parent before writing through it', () => {
  const root = tempRoot('jenny-runtime-ledger-publish-race');
  const sourceProfile = path.join(root, 'source');
  const ownerRoot = path.join(root, 'owner');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(sourceProfile);
  fs.mkdirSync(ownerRoot);
  fs.mkdirSync(outside);
  const sourceStore = new RuntimeStore(path.join(sourceProfile, 'session-runtime'));
  submit(sourceStore, 'junction');
  const projection = projectRuntimeLedgerPayload(collectRuntimeLedgerPayload(sourceProfile), {
    now: '2026-09-09T15:00:00.000Z',
  });
  const targetRoot = path.join(ownerRoot, 'session-runtime');
  const workRoot = path.join(targetRoot, 'work');
  const originalMkdir = fs.mkdirSync;
  let replaced = false;
  fs.mkdirSync = function replaceCreatedWork(directory, options) {
    const result = originalMkdir.call(fs, directory, options);
    if (!replaced && path.resolve(directory) === path.resolve(workRoot)) {
      fs.rmSync(workRoot, { recursive: true });
      fs.symlinkSync(outside, workRoot, process.platform === 'win32' ? 'junction' : 'dir');
      replaced = true;
    }
    return result;
  };
  try {
    assert.throws(
      () => publishRuntimeLedgerProjection(targetRoot, projection, { ownerRoot }),
      { code: 'CMP-DATA-0003', reason: 'unsafe_restore_path' }
    );
  } finally {
    fs.mkdirSync = originalMkdir;
  }

  assert.equal(replaced, true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('corrupt ledger input is rejected before a staged restore can mutate the profile', async () => {
  const root = tempRoot('jenny-runtime-ledger-corrupt');
  const destinationProfile = path.join(root, 'destination');
  fs.mkdirSync(destinationProfile);
  new RuntimeStore(path.join(destinationProfile, 'session-runtime'));
  const before = snapshotDirectory(path.join(destinationProfile, 'session-runtime'));
  const data = JSON.stringify({
    payload_schema_version: 1,
    payload_kind: 'runtime_state',
    payload: {
      schema_version: 1,
      index: { schema_version: 99 },
      records: [],
    },
  });
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Corrupt-runtime-ledger.jenny-archive',
    encrypted: false,
    entries: [{ logicalPath: 'runtime/runtime-ledger.json', category: 'runtime_state', data }],
  });

  await assert.rejects(stageRestore({ archivePath: result.archivePath, userDataPath: destinationProfile }), {
    reason: 'unsupported_runtime_ledger_version',
  });
  assertSnapshot(path.join(destinationProfile, 'session-runtime'), before);
  assert.equal(fs.existsSync(restorePointerPath(destinationProfile)), false);
});
