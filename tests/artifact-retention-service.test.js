'use strict';

// WIDE-010: reference-aware artifact-session retention (Electron authority).
// Real temp directories throughout; determinism via injected nowFn and
// fs.utimes-set mtimes — no sleeps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  createArtifactRetentionService,
  isRetentionQuarantineEntry,
  quarantineEntryName,
} = require('../services/artifact-retention-service');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-12T12:00:00Z');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

async function makeArtifactDir(root, name, { ageMs, files = { 'artifact.md': 'body' }, fileAges = {} } = {}) {
  const dir = path.join(root, '.jenny', 'artifacts', name);
  await fs.mkdir(dir, { recursive: true });
  const stampMs = NOW - (ageMs ?? 60 * MINUTE_MS);
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, content, 'utf8');
    const fileStamp = (NOW - (fileAges[fileName] ?? (ageMs ?? 60 * MINUTE_MS))) / 1000;
    await fs.utimes(filePath, fileStamp, fileStamp);
  }
  await fs.utimes(dir, stampMs / 1000, stampMs / 1000);
  return dir;
}

function artifactMessage(root, dirName, fileName, { redacted = false, artifactId } = {}) {
  return {
    tool_result: {
      generated_artifacts: [{
        artifact_id: artifactId || `artifact_file_${dirName}_${fileName}`,
        absolute_path: redacted
          ? '[redacted:path]'
          : path.join(root, '.jenny', 'artifacts', dirName, fileName),
        display_path: `.jenny/artifacts/${dirName}/${fileName}`,
      }],
    },
  };
}

function fakeSessionStore(sessions) {
  return {
    listSessions: () => sessions.map(({ id }) => ({ id })),
    peekSession: (sessionId) => {
      const session = sessions.find((entry) => entry.id === sessionId);
      return session ? { id: session.id, messages: session.messages } : null;
    },
  };
}

function service(root, sessions, { caps = {}, logger = () => {}, fsOverrides = null } = {}) {
  const fsImpl = fsOverrides ? { ...fs, ...fsOverrides } : fs;
  return createArtifactRetentionService({
    getWorkspaceRoot: () => root,
    getSessionStore: () => fakeSessionStore(sessions),
    fsImpl,
    logger,
    nowFn: () => NOW,
    caps: {
      recentUseFloorMs: 30 * MINUTE_MS,
      maxUnreferencedAgeMs: 14 * DAY_MS,
      maxUnreferencedDirs: 20,
      maxUnreferencedTotalBytes: 512 * 1024 * 1024,
      quarantineMaxAgeMs: 7 * DAY_MS,
      ...caps,
    },
  });
}

async function listDirs(root, ...segments) {
  const target = path.join(root, ...segments);
  try {
    return (await fs.readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

test('referenced oldest+newest survive while unreferenced middle dirs prune by count quota', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  // 22 dirs: dir-00 oldest ... dir-21 newest (all past the recency floor).
  for (let index = 0; index < 22; index += 1) {
    await makeArtifactDir(root, `dir-${String(index).padStart(2, '0')}`, {
      ageMs: (22 - index) * DAY_MS / 2, // 11 days .. 0.5 day
    });
  }
  const sessions = [
    { id: 'old-session', messages: [artifactMessage(root, 'dir-00', 'artifact.md')] },
    { id: 'new-session', messages: [artifactMessage(root, 'dir-21', 'artifact.md')] },
  ];
  const result = await service(root, sessions, { caps: { maxUnreferencedDirs: 5 } }).sweep();

  assert.equal(result.ok, true);
  assert.equal(result.referencedDirs, 2);
  assert.equal(result.keptUnreferenced, 5);
  assert.equal(result.quarantined, 15);
  const survivors = await listDirs(root, '.jenny', 'artifacts');
  assert.ok(survivors.includes('dir-00'), 'the OLDEST dir survives because an older session references it');
  assert.ok(survivors.includes('dir-21'), 'the newest referenced dir survives');
  // Kept unreferenced = the 5 newest unreferenced (dir-16..dir-20).
  for (const name of ['dir-16', 'dir-17', 'dir-18', 'dir-19', 'dir-20']) {
    assert.ok(survivors.includes(name), `${name} kept within quota`);
  }
  assert.equal(survivors.length, 7);
});

test('a later file edit updates last-use ranking beyond bare dir mtime', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  // dir mtime says "stale-dir" is newer, but "fresh-file" holds a recently
  // edited artifact — real last use must rank fresh-file above stale-dir.
  await makeArtifactDir(root, 'fresh-file', {
    ageMs: 10 * DAY_MS,
    fileAges: { 'artifact.md': 2 * DAY_MS },
  });
  await makeArtifactDir(root, 'stale-dir', { ageMs: 5 * DAY_MS });
  const result = await service(root, [], { caps: { maxUnreferencedDirs: 1 } }).sweep();

  assert.equal(result.quarantined, 1);
  const survivors = await listDirs(root, '.jenny', 'artifacts');
  assert.deepEqual(survivors, ['fresh-file'],
    'the dir with the recently edited FILE outranks the dir with the newer bare mtime');
});

test('references across MULTIPLE sessions are all honored, including redacted-path entries', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  await makeArtifactDir(root, 'dir-a', { ageMs: 20 * DAY_MS });
  await makeArtifactDir(root, 'dir-b', { ageMs: 21 * DAY_MS });
  await makeArtifactDir(root, 'dir-c', { ageMs: 22 * DAY_MS });
  const sessions = [
    { id: 'session-a', messages: [artifactMessage(root, 'dir-a', 'artifact.md')] },
    // Renderer-safe (redacted absolute_path) references resolve via display_path.
    { id: 'session-b', messages: [artifactMessage(root, 'dir-b', 'artifact.md', { redacted: true })] },
  ];
  // Age cap of 14 days would doom all three if unreferenced.
  const result = await service(root, sessions).sweep();

  assert.equal(result.referencedDirs, 2);
  assert.equal(result.quarantined, 1);
  assert.deepEqual(await listDirs(root, '.jenny', 'artifacts'), ['dir-a', 'dir-b']);
});

test('broken references are surfaced explicitly and their dir still counts referenced', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  await makeArtifactDir(root, 'dir-broken', { ageMs: 20 * DAY_MS });
  const logs = [];
  const sessions = [{
    id: 'session-x',
    messages: [artifactMessage(root, 'dir-broken', 'gone.md', { artifactId: 'artifact_file_gone' })],
  }];
  const result = await service(root, sessions, {
    logger: (level, event, data) => logs.push({ level, event, data }),
  }).sweep();

  assert.equal(result.brokenReferenceCount, 1);
  assert.deepEqual(result.brokenReferences, [{ session_id: 'session-x', artifact_id: 'artifact_file_gone' }]);
  assert.equal(result.quarantined, 0, 'a dir named by a broken reference is conservatively kept');
  const log = logs.find((entry) => entry.event === 'artifacts.retention_swept');
  assert.equal(log.data.brokenReferenceCount, 1);
  assert.doesNotMatch(JSON.stringify(log), /\.jenny[\\/]/, 'no filesystem paths in the log');
});

test('a per-directory move failure is isolated and reported; other candidates still quarantine', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  await makeArtifactDir(root, 'dir-locked', { ageMs: 20 * DAY_MS });
  await makeArtifactDir(root, 'dir-free', { ageMs: 21 * DAY_MS });
  const rename = (from, to) => {
    if (String(from).includes('dir-locked')) {
      return Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }));
    }
    return fs.rename(from, to);
  };
  const result = await service(root, [], { fsOverrides: { rename } }).sweep();

  assert.equal(result.errors, 1);
  assert.equal(result.quarantined, 1);
  assert.deepEqual(result.quarantinedNames, ['dir-free']);
  assert.deepEqual(await listDirs(root, '.jenny', 'artifacts'), ['dir-locked'],
    'the locked dir stays in place; the sweep continues past the failure');
});

test('quarantine is a recoverable soft delete: contents intact, restore works', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  await makeArtifactDir(root, 'dir-victim', {
    ageMs: 20 * DAY_MS,
    files: { 'artifact.md': 'precious content', 'nested.txt': 'more' },
  });
  const sweeper = service(root, []);
  const result = await sweeper.sweep();
  assert.equal(result.quarantined, 1);

  const quarantineEntries = await listDirs(root, '.jenny', 'quarantine');
  assert.equal(quarantineEntries.length, 1);
  const entryName = quarantineEntries[0];
  assert.ok(isRetentionQuarantineEntry(entryName), 'entry follows the guarded-store naming convention');
  assert.match(entryName, /^artifacts-dir-victim-retention-\d{8}T\d{6}-[0-9a-f]{16}$/);
  const entryPath = path.join(root, '.jenny', 'quarantine', entryName);
  assert.equal(await fs.readFile(path.join(entryPath, 'artifact.md'), 'utf8'), 'precious content');
  assert.equal(await fs.readFile(path.join(entryPath, 'nested.txt'), 'utf8'), 'more');

  // Recovery: move the directory back and reference it — the next sweep keeps it.
  const restored = path.join(root, '.jenny', 'artifacts', 'dir-victim');
  await fs.rename(entryPath, restored);
  const again = await service(root, [
    { id: 'session-r', messages: [artifactMessage(root, 'dir-victim', 'artifact.md')] },
  ]).sweep();
  assert.equal(again.quarantined, 0);
  assert.deepEqual(await listDirs(root, '.jenny', 'artifacts'), ['dir-victim']);
});

test('recently used dirs are never touched even when unreferenced and over quota', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  await makeArtifactDir(root, 'dir-active', { ageMs: 5 * MINUTE_MS });
  await makeArtifactDir(root, 'dir-idle', { ageMs: 20 * DAY_MS });
  const result = await service(root, [], { caps: { maxUnreferencedDirs: 0 } }).sweep();

  assert.equal(result.skippedRecent, 1);
  assert.equal(result.quarantined, 1);
  assert.deepEqual(await listDirs(root, '.jenny', 'artifacts'), ['dir-active'],
    'the write-time recency floor protects an actively used dir from any quota');
});

test('aggregate byte quota prunes the oldest unreferenced dirs first', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  await makeArtifactDir(root, 'dir-new', { ageMs: 1 * DAY_MS, files: { 'a.md': 'x'.repeat(600) } });
  await makeArtifactDir(root, 'dir-mid', { ageMs: 2 * DAY_MS, files: { 'a.md': 'x'.repeat(600) } });
  await makeArtifactDir(root, 'dir-old', { ageMs: 3 * DAY_MS, files: { 'a.md': 'x'.repeat(600) } });
  const result = await service(root, [], { caps: { maxUnreferencedTotalBytes: 1300 } }).sweep();

  assert.equal(result.keptUnreferenced, 2);
  assert.equal(result.quarantined, 1);
  assert.equal(result.quarantinedBytes, 600);
  assert.deepEqual(await listDirs(root, '.jenny', 'artifacts'), ['dir-mid', 'dir-new']);
});

test('quarantine entries have their own bounded retention; sidecar entries are untouched', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  const quarantineRoot = path.join(root, '.jenny', 'quarantine');
  const expired = path.join(quarantineRoot, quarantineEntryName('old-dir', NOW - 8 * DAY_MS));
  const fresh = path.join(quarantineRoot, quarantineEntryName('new-dir', NOW - 1 * DAY_MS));
  const sidecar = path.join(quarantineRoot, 'tool-results-old-job-deleted-20260101T000000-abcdef');
  for (const dir of [expired, fresh, sidecar]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'f.txt'), 'x', 'utf8');
  }
  await fs.utimes(expired, (NOW - 8 * DAY_MS) / 1000, (NOW - 8 * DAY_MS) / 1000);
  await fs.utimes(fresh, (NOW - 1 * DAY_MS) / 1000, (NOW - 1 * DAY_MS) / 1000);
  await fs.utimes(sidecar, (NOW - 30 * DAY_MS) / 1000, (NOW - 30 * DAY_MS) / 1000);

  const result = await service(root, []).sweep();

  assert.equal(result.purgedQuarantine, 1);
  const remaining = await listDirs(root, '.jenny', 'quarantine');
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes(path.basename(fresh)), 'entries inside the quarantine window survive');
  assert.ok(remaining.includes(path.basename(sidecar)),
    'sidecar guarded-store quarantine entries are never purged by the Electron sweep');
});

test('retention predicate rejects sidecar artifact quarantines with retention in the source name', () => {
  assert.equal(
    isRetentionQuarantineEntry('artifacts-old-retention-file-deleted-20260101T000000-deadbeef'),
    false
  );
});

test('fail closed: an unreadable session suppresses ALL quarantining on that pass', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  await makeArtifactDir(root, 'dir-doomed', { ageMs: 30 * DAY_MS });
  const store = {
    listSessions: () => [{ id: 'session-broken' }],
    peekSession: () => { throw new Error('corrupt session file'); },
  };
  const sweeper = createArtifactRetentionService({
    getWorkspaceRoot: () => root,
    getSessionStore: () => store,
    nowFn: () => NOW,
  });
  const result = await sweeper.sweep();

  assert.equal(result.referencesComplete, false);
  assert.equal(result.quarantined, 0);
  assert.deepEqual(await listDirs(root, '.jenny', 'artifacts'), ['dir-doomed'],
    'an incomplete reference reconciliation never authorizes deletion');
});

test('active-session ids are skipped as an additional guard', async () => {
  const root = createTrackedTempDir('jenny-artifact-retention-');
  await makeArtifactDir(root, 'dir-live', { ageMs: 20 * DAY_MS });
  const result = await service(root, []).sweep({ activeSessionIds: ['dir-live'] });

  assert.equal(result.skippedActive, 1);
  assert.equal(result.quarantined, 0);
  assert.deepEqual(await listDirs(root, '.jenny', 'artifacts'), ['dir-live']);
});

test('missing root or artifacts dir degrades cleanly', async () => {
  const noRoot = createArtifactRetentionService({
    getWorkspaceRoot: () => '',
    getSessionStore: () => fakeSessionStore([]),
    nowFn: () => NOW,
  });
  assert.equal((await noRoot.sweep()).skippedReason, 'no_root');

  const root = createTrackedTempDir('jenny-artifact-retention-');
  const empty = await service(root, []).sweep();
  assert.equal(empty.ok, true);
  assert.equal(empty.scannedDirs, 0);
  assert.equal(empty.quarantined, 0);
});
