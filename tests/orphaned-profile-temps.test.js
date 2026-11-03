const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pruneOrphanedProfileTemps } = require('../services/data-lifecycle/orphaned-profile-temps');
const { scheduleStartupRetentionTasks } = require('../services/main/startup-retention-tasks');
const { EventEmitter } = require('events');

// Persistence faults O1 and O5: crash-orphaned atomic-write temps of the
// profile JSON stores are removed once a day old; everything else stays.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.now();
const OLD = NOW - 2 * DAY_MS;

function makeProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-profile-temps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(root, relPath, { mtimeMs = NOW } = {}) {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}');
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

const stamped = (live, stampMs) => `${live}.${stampMs}.0123456789ab.tmp`;

test('O1/O5: day-old temps of each profile store are removed and logged', async (t) => {
  const root = makeProfile(t);
  const orphans = [
    stamped('shell-config.json', OLD),
    stamped('home-ai-journal.json', OLD),
    'mcp-servers.json.4242.0123456789ab.tmp',
    path.join('background-memory', stamped('scheduled_tasks.json', OLD)),
    path.join('project-notes', stamped('proj_abc.json', OLD)),
  ];
  for (const name of orphans) writeFile(root, name, { mtimeMs: OLD });
  const logs = [];

  const result = await pruneOrphanedProfileTemps({ profileRoot: root, now: NOW, log: (...entry) => logs.push(entry) });

  for (const name of orphans) assert.equal(fs.existsSync(path.join(root, name)), false, `${name} removed`);
  assert.equal(result.deleted.length, orphans.length);
  assert.deepEqual(result.failed, []);
  assert.ok(logs.every(([level, event]) => level === 'INFO' && event === 'profile_store.orphaned_temp_pruned'));
  assert.ok(result.deleted.every((record) => record.bytes === 2 && record.ageMs >= DAY_MS));
});

test('a temp younger than a day by its name or by its mtime stays (an in-flight write)', async (t) => {
  const root = makeProfile(t);
  const youngByName = writeFile(root, stamped('shell-config.json', NOW - HOUR_MS), { mtimeMs: OLD });
  const youngByMtime = writeFile(root, stamped('home-ai-journal.json', OLD), { mtimeMs: NOW - HOUR_MS });
  const youngPid = writeFile(root, 'mcp-servers.json.4242.0123456789ab.tmp', { mtimeMs: NOW - HOUR_MS });

  const result = await pruneOrphanedProfileTemps({ profileRoot: root, now: NOW });

  assert.deepEqual(result.deleted, []);
  for (const filePath of [youngByName, youngByMtime, youngPid]) assert.ok(fs.existsSync(filePath));
});

test('live files, other stores\' names, the MCP rollback and look-alikes are never candidates', async (t) => {
  const root = makeProfile(t);
  const kept = [
    'shell-config.json',
    'mcp-servers.json',
    'mcp-servers.json.4242.0123456789ab.rollback',
    stamped('sessions.json', OLD), // the session store's own prune owns this one
    stamped('unrelated.json', OLD),
    'shell-config.json.1700000000000.xyz.tmp',
    stamped('shell-config.json', OLD).replace('.tmp', '.tmp.bak'),
    path.join('project-notes', stamped('notes.md', OLD)),
    path.join('project-notes', 'nested', stamped('proj_abc.json', OLD)),
    path.join('background-memory', stamped('other.json', OLD)),
  ];
  for (const name of kept) writeFile(root, name, { mtimeMs: OLD });
  fs.mkdirSync(path.join(root, stamped('home-ai-journal.json', OLD)));

  const result = await pruneOrphanedProfileTemps({ profileRoot: root, now: NOW });

  assert.deepEqual(result.deleted, []);
  for (const name of kept) assert.ok(fs.existsSync(path.join(root, name)), `${name} kept`);
  assert.ok(fs.statSync(path.join(root, stamped('home-ai-journal.json', OLD))).isDirectory(), 'a directory is never removed');
});

test('missing store directories and a missing profile root are not failures', async (t) => {
  const root = makeProfile(t);
  assert.deepEqual(await pruneOrphanedProfileTemps({ profileRoot: root, now: NOW }), { deleted: [], failed: [] });
  assert.deepEqual(await pruneOrphanedProfileTemps({ profileRoot: path.join(root, 'gone'), now: NOW }), { deleted: [], failed: [] });
  assert.deepEqual(await pruneOrphanedProfileTemps({}), { deleted: [], failed: [] });
});

test('an unlink failure is recorded and logged, and the sweep goes on', async (t) => {
  const root = makeProfile(t);
  writeFile(root, stamped('shell-config.json', OLD), { mtimeMs: OLD });
  writeFile(root, stamped('home-ai-journal.json', OLD), { mtimeMs: OLD });
  const fsImpl = {
    promises: {
      ...fs.promises,
      unlink: async (filePath) => {
        if (filePath.includes('shell-config')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return fs.promises.unlink(filePath);
      },
    },
  };
  const logs = [];

  const result = await pruneOrphanedProfileTemps({ profileRoot: root, now: NOW, fsImpl, log: (...entry) => logs.push(entry) });

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].file, stamped('shell-config.json', OLD));
  assert.equal(result.deleted.length, 1, 'the next candidate is still removed');
  assert.ok(logs.some(([level, event]) => level === 'WARN' && event === 'profile_store.orphaned_temp_prune_failed'));
});

test('startup retention runs the sweep once, from the session store profile root', async (t) => {
  const root = makeProfile(t);
  const orphan = writeFile(root, stamped('shell-config.json', OLD), { mtimeMs: OLD });
  const backend = new EventEmitter();
  backend.getBackendStatus = () => ({ phase: 'ready' });
  backend.sessionStore = { filePath: path.join(root, 'sessions.json'), listSessions: () => [] };
  const timers = [];
  let resolvePruned;
  const pruned = new Promise((resolve) => { resolvePruned = resolve; });

  scheduleStartupRetentionTasks({
    backendService: backend,
    setTimeoutRef: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    setIntervalRef: () => { throw new Error('no interval expected'); },
    log: (level, event, data) => {
      if (event === 'profile_store.orphaned_temp_pruned') resolvePruned(data);
    },
  });

  const staggered = timers.filter((timer) => timer.ms === 12000);
  assert.equal(staggered.length, 1);
  staggered[0].fn();
  assert.equal((await pruned).file, path.basename(orphan));
  assert.equal(fs.existsSync(orphan), false);
});
