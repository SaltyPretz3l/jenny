const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  classifyLegacyFile,
  pruneLegacySessionFiles,
} = require('../services/backend/session-legacy-file-prune');
const { scheduleStartupRetentionTasks } = require('../services/main/startup-retention-tasks');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.now();

function makeProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-legacy-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(root, name, body, { mtimeMs = NOW } = {}) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, body);
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
  return filePath;
}

function writeSplitStore(root, index = { schema_version: 22, sessions: { s1: { id: 's1' } } }) {
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, '_index.json'), typeof index === 'string' ? index : JSON.stringify(index));
  fs.writeFileSync(path.join(sessionsDir, 's1.json'), JSON.stringify({ schema_version: 22, session: { id: 's1' } }));
  return sessionsDir;
}

function tmpName(stampMs) {
  return `sessions.json.${stampMs}.c6a7721ad7f6.tmp`;
}

function createLog() {
  const entries = [];
  const log = (level, event, data) => entries.push({ level, event, data });
  return { entries, log };
}

test('classifyLegacyFile matches only the atomic-write temp and migration backup name contracts', () => {
  assert.equal(classifyLegacyFile('sessions.json.1778525182749.c6a7721ad7f6.tmp', 'sessions.json').kind, 'orphaned_tmp');
  assert.equal(classifyLegacyFile('sessions.json.migrated-1778542222022', 'sessions.json').kind, 'migration_backup');
  for (const name of [
    'sessions.json',
    'sessions',
    'sessions.json.tmp',
    'sessions.json.bak',
    'sessions.json.migrated-',
    'sessions.json.migrated-abc',
    'sessions.json.1778525182749.C6A7721AD7F6.tmp',
    'sessions.json.1778525182749.c6a7.tmp',
    'sessionsXjson.1778525182749.c6a7721ad7f6.tmp',
    'session-shadow.json.migrated-1778542222028',
    'other.json.1778525182749.c6a7721ad7f6.tmp',
  ]) {
    assert.equal(classifyLegacyFile(name, 'sessions.json'), null, name);
  }
});

test('prunes exactly the stale temps and the stale backup and leaves the live store untouched', async (t) => {
  const root = makeProfile(t);
  const sessionsDir = writeSplitStore(root);
  const live = writeFile(root, 'sessions.json', '{"schema_version":9}');
  const staleTmp = writeFile(root, tmpName(NOW - 3 * DAY_MS), 'x'.repeat(4096), { mtimeMs: NOW - 3 * DAY_MS });
  const freshTmp = writeFile(root, tmpName(NOW - HOUR_MS), 'fresh', { mtimeMs: NOW - HOUR_MS });
  // Old name stamp but written moments ago: the younger age wins, so it stays.
  const touchedTmp = writeFile(root, tmpName(NOW - 3 * DAY_MS).replace('c6a7721ad7f6', 'ebc1bb19ee35'), 'live');
  const staleBackup = writeFile(root, `sessions.json.migrated-${NOW - 40 * DAY_MS}`, 'b'.repeat(8192), {
    mtimeMs: NOW - 41 * DAY_MS,
  });
  const recentBackup = writeFile(root, `sessions.json.migrated-${NOW - 5 * DAY_MS}`, 'recent', {
    mtimeMs: NOW - 6 * DAY_MS,
  });
  const unrelated = writeFile(root, 'sessions.json.bak', 'keep', { mtimeMs: NOW - 90 * DAY_MS });
  const shadowBackup = writeFile(root, `session-shadow.json.migrated-${NOW - 90 * DAY_MS}`, 'keep', {
    mtimeMs: NOW - 90 * DAY_MS,
  });
  fs.mkdirSync(path.join(root, tmpName(NOW - 9 * DAY_MS)));

  const { entries, log } = createLog();
  const result = await pruneLegacySessionFiles({ legacyFilePath: live, now: NOW, log });

  assert.equal(fs.existsSync(staleTmp), false);
  assert.equal(fs.existsSync(staleBackup), false);
  for (const kept of [live, freshTmp, touchedTmp, recentBackup, unrelated, shadowBackup]) {
    assert.equal(fs.existsSync(kept), true, `${path.basename(kept)} must survive`);
  }
  assert.equal(fs.statSync(path.join(root, tmpName(NOW - 9 * DAY_MS))).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(sessionsDir).sort(), ['_index.json', 's1.json']);
  assert.equal(fs.readFileSync(live, 'utf8'), '{"schema_version":9}');

  assert.deepEqual(result.deleted.map(({ file, kind, bytes }) => ({ file, kind, bytes })).sort((a, b) => a.bytes - b.bytes), [
    { file: path.basename(staleTmp), kind: 'orphaned_tmp', bytes: 4096 },
    { file: path.basename(staleBackup), kind: 'migration_backup', bytes: 8192 },
  ]);
  assert.deepEqual(result.failed, []);
  const pruned = entries.filter((entry) => entry.event === 'session_store.legacy_file_pruned');
  assert.equal(pruned.length, 2, 'one structured entry per deletion');
  for (const entry of pruned) {
    assert.equal(entry.level, 'INFO');
    assert.equal(typeof entry.data.bytes, 'number');
    assert.ok(entry.data.ageMs >= DAY_MS);
  }
});

test('keeps the migration backup while the split store is missing, unreadable or pre-split', async (t) => {
  const cases = {
    missing: null,
    corrupt: '{"schema_version": 22, "sessions": {',
    'pre-split schema': { schema_version: 9, sessions: {} },
    'no sessions map': { schema_version: 22 },
  };
  for (const [label, index] of Object.entries(cases)) {
    const root = makeProfile(t);
    if (index !== null) {
      writeSplitStore(root, index);
    }
    const backup = writeFile(root, `sessions.json.migrated-${NOW - 60 * DAY_MS}`, 'b', { mtimeMs: NOW - 60 * DAY_MS });
    const staleTmp = writeFile(root, tmpName(NOW - 2 * DAY_MS), 't', { mtimeMs: NOW - 2 * DAY_MS });
    const { entries, log } = createLog();

    const result = await pruneLegacySessionFiles({
      legacyFilePath: path.join(root, 'sessions.json'),
      now: NOW,
      log,
    });

    assert.equal(fs.existsSync(backup), true, `${label}: backup must be kept`);
    assert.equal(fs.existsSync(staleTmp), false, `${label}: temps do not depend on the store`);
    assert.equal(result.skippedBackups, 1, label);
    assert.ok(entries.some((entry) => entry.level === 'WARN' && entry.event === 'session_store.legacy_backup_kept'), label);
  }
});

test('reports an unreadable profile directory instead of a silent empty pass', async (t) => {
  const root = makeProfile(t);
  const notADirectory = writeFile(root, 'plain-file', 'x');
  const { entries, log } = createLog();

  const result = await pruneLegacySessionFiles({ legacyFilePath: path.join(notADirectory, 'sessions.json'), now: NOW, log });

  assert.deepEqual(result.deleted, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].kind, 'scan');
  assert.ok(entries.some((entry) => entry.level === 'WARN' && entry.event === 'session_store.legacy_file_prune_failed'));

  const missing = await pruneLegacySessionFiles({ legacyFilePath: path.join(root, 'gone', 'sessions.json'), now: NOW, log });
  assert.deepEqual(missing.failed, [], 'a missing profile directory is not a failure');
});

test('never follows or deletes a link that carries a prunable name', async (t) => {
  const root = makeProfile(t);
  writeSplitStore(root);
  const outside = makeProfile(t);
  const target = writeFile(outside, 'precious.json', 'do not delete', { mtimeMs: NOW - 90 * DAY_MS });
  const linkPath = path.join(root, `sessions.json.migrated-${NOW - 90 * DAY_MS}`);
  try {
    fs.symlinkSync(target, linkPath, 'file');
  } catch (error) {
    t.skip(`file symlinks unavailable here (${error.code})`);
    return;
  }

  const result = await pruneLegacySessionFiles({ legacyFilePath: path.join(root, 'sessions.json'), now: NOW });

  assert.deepEqual(result.deleted, []);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not delete');
});

test('never follows or deletes a junction that carries a prunable name', async (t) => {
  const root = makeProfile(t);
  writeSplitStore(root);
  const outside = makeProfile(t);
  const target = writeFile(outside, 'precious.json', 'do not delete', { mtimeMs: NOW - 90 * DAY_MS });
  const linkPath = path.join(root, tmpName(NOW - 90 * DAY_MS));
  fs.symlinkSync(outside, linkPath, 'junction');

  const result = await pruneLegacySessionFiles({ legacyFilePath: path.join(root, 'sessions.json'), now: NOW });

  assert.deepEqual(result.deleted, []);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not delete');
});

test('scheduleStartupRetentionTasks runs the prune once after backend-ready from the session store path', async (t) => {
  const root = makeProfile(t);
  writeSplitStore(root);
  const staleTmp = writeFile(root, tmpName(NOW - 3 * DAY_MS), 't', { mtimeMs: NOW - 3 * DAY_MS });
  const backend = new EventEmitter();
  backend.getBackendStatus = () => ({ phase: 'ready' });
  backend.sessionStore = { filePath: path.join(root, 'sessions.json'), listSessions: () => [] };
  const timers = [];
  const intervals = [];
  let resolvePruned;
  const pruned = new Promise((resolve) => { resolvePruned = resolve; });

  scheduleStartupRetentionTasks({
    backendService: backend,
    setTimeoutRef: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    setIntervalRef: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    log: (level, event, data) => {
      if (event === 'session_store.legacy_file_pruned') {
        resolvePruned(data);
      }
    },
  });

  const staggered = timers.filter((timer) => timer.ms === 12000);
  assert.equal(staggered.length, 1);
  assert.deepEqual(intervals, [], 'the legacy prune has no periodic interval');
  staggered[0].fn();
  const entry = await pruned;
  assert.equal(entry.file, path.basename(staleTmp));
  assert.equal(fs.existsSync(staleTmp), false);
});

test('prunes stale atomic-write temps inside the split sessions directory and nothing else there', async (t) => {
  const root = makeProfile(t);
  const sessionsDir = writeSplitStore(root);
  const quarantineDir = path.join(sessionsDir, 'corrupt');
  fs.mkdirSync(quarantineDir);
  const old = NOW - 2 * DAY_MS;
  const staleChatTmp = writeFile(sessionsDir, `s1.json.${old}.0123456789ab.tmp`, 'private transcript', { mtimeMs: old });
  const staleIndexTmp = writeFile(sessionsDir, `_index.json.${old}.ba9876543210.tmp`, '{}', { mtimeMs: old });
  const freshTmp = writeFile(sessionsDir, `s1.json.${NOW - HOUR_MS}.0123456789ab.tmp`, 'fresh', { mtimeMs: NOW - HOUR_MS });
  const touchedTmp = writeFile(sessionsDir, `s1.json.${old}.aaaaaaaaaaaa.tmp`, 'in flight');
  const quarantined = writeFile(quarantineDir, `s1.${old}.json`, 'damaged original', { mtimeMs: old });
  const quarantinedTmp = writeFile(quarantineDir, `s1.json.${old}.0123456789ab.tmp`, 'nested', { mtimeMs: old });
  const live = path.join(root, 'sessions.json');
  const { entries, log } = createLog();

  const result = await pruneLegacySessionFiles({ legacyFilePath: live, now: NOW, log });

  assert.deepEqual(result.deleted.map(({ file, kind }) => ({ file, kind })).sort((a, b) => a.file.localeCompare(b.file)), [
    { file: path.basename(staleIndexTmp), kind: 'orphaned_tmp' },
    { file: path.basename(staleChatTmp), kind: 'orphaned_tmp' },
  ].sort((a, b) => a.file.localeCompare(b.file)));
  assert.deepEqual(result.failed, []);
  assert.equal(fs.existsSync(staleChatTmp), false);
  assert.equal(fs.existsSync(staleIndexTmp), false);
  for (const kept of [freshTmp, touchedTmp, quarantined, quarantinedTmp, path.join(sessionsDir, 's1.json'), path.join(sessionsDir, '_index.json')]) {
    assert.equal(fs.existsSync(kept), true, `${path.basename(kept)} must survive`);
  }
  assert.equal(entries.filter((entry) => entry.event === 'session_store.legacy_file_pruned').length, 2);
});

test('a missing sessions directory is not a prune failure', async (t) => {
  const root = makeProfile(t);
  writeFile(root, 'sessions.json', '{}');
  const { entries, log } = createLog();

  const result = await pruneLegacySessionFiles({ legacyFilePath: path.join(root, 'sessions.json'), now: NOW, log });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(entries, []);
});
