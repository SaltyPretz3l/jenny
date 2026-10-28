'use strict';

// Fault injection for three smaller JSON stores (matrix rows T1, T3, I1, X1-X6 in
// docs/plans/PERSISTENCE_FAULTS_2026-10-26.md). Crash rows run a child that SIGKILLs itself
// around a real rename; IO-fault rows monkeypatch fs.renameSync for one call. Fixtures at the
// current schema are written by the real stores; only damage or a re-stamp is applied by
// hand. No sleeps.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { McpConfigStore, configurationDigest, defaultDocument } = require('../services/mcp-config-store');
const {
  readScheduledTasksFile,
  readScheduledTasksJsonPayload,
  writeScheduledTasksFile,
} = require('../services/scheduler-tasks-store');
const { normalizeDiffInputText, sha256Text } = require('../services/tools/structured-diff');
const { createWorkspaceIdeSnapshotStore } = require('../services/workspace-ide-snapshot-store');
const {
  FIXED_NOW,
  mcpAddServer,
  payloadFor,
  snapshotContentFor,
} = require('./helpers/scheduler-snapshot-mcp-fault-child');
const { cleanupTrackedResources, createTrackedTempDir, trackProcess } = require('./helpers/resource-cleanup');

const CHILD = path.join(__dirname, 'helpers', 'scheduler-snapshot-mcp-fault-child.js');
const TASKS_NAME = 'scheduled_tasks.json';
const MCP_NAME = 'mcp-servers.json';
const TASKS_TMP = /^scheduled_tasks\.json\.\d{10,16}\.[0-9a-f]{12}\.tmp$/;
const SNAP_TMP = /^[0-9a-f]{64}\.snap\.tmp-\d+-[0-9a-f]{8}$/;
const MCP_TMP = /^mcp-servers\.json\.\d+\.[0-9a-f]{12}\.tmp$/;

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const newDir = () => createTrackedTempDir('jenny-sched-snap-mcp-faults-');
const listDir = (dir) => fs.readdirSync(dir).sort();
const lastAcks = (count) => Array.from({ length: count }, (_, index) => String(index + 1));

function runCrashChild(scenario, dir, mode, killAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, scenario, dir, mode, String(killAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackProcess(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr, acks: stdout.split('\n').filter(Boolean) });
    });
  });
}

function assertKilled(run) {
  assert.notEqual(run.code, 0, `child must not exit cleanly (signal=${run.signal}, stderr=${run.stderr})`);
  assert.equal(run.stderr, '', 'the child died by the kill, not by an error');
}

const CRASH_MATRIX = [['kill-before', 1], ['kill-before', 3], ['kill-after', 1], ['kill-after', 3]];

// ---------------------------------------------------------------- T1 scheduler tasks

for (const [mode, killAt] of CRASH_MATRIX) {
  test(`T1 ${mode} at write ${killAt}: the task list loads whole (acked or in-flight)`, { timeout: 60000 }, async () => {
    const dir = newDir();
    const tasksPath = path.join(dir, TASKS_NAME);
    const run = await runCrashChild('scheduler', dir, mode, killAt);
    assertKilled(run);
    assert.deepEqual(run.acks, lastAcks(killAt - 1));

    const surviving = mode === 'kill-before' ? killAt - 1 : killAt;
    if (surviving === 0) {
      assert.equal(readScheduledTasksJsonPayload(tasksPath), null, 'no write completed, so no task file');
    } else {
      assert.deepEqual(readScheduledTasksJsonPayload(tasksPath), payloadFor(surviving));
      assert.deepEqual(readScheduledTasksFile(tasksPath, { nowProvider: () => FIXED_NOW }), payloadFor(surviving));
    }

    const orphans = listDir(dir).filter((name) => name.endsWith('.tmp'));
    if (mode === 'kill-before') {
      // Recorded finding: the in-flight temp was fully written, is whole, and nothing reaps it.
      assert.equal(orphans.length, 1, `exactly the in-flight temp is left: ${orphans}`);
      assert.match(orphans[0], TASKS_TMP);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, orphans[0]), 'utf8')), payloadFor(killAt));
    } else {
      assert.deepEqual(orphans, [], 'the rename consumed the temp file');
    }

    // The store is writable after the crash; the orphan is neither reused nor removed.
    writeScheduledTasksFile(tasksPath, payloadFor(99));
    assert.deepEqual(readScheduledTasksJsonPayload(tasksPath), payloadFor(99));
    assert.deepEqual(listDir(dir).filter((name) => name.endsWith('.tmp')), orphans);
  });
}

// ---------------------------------------------------------------- T3 scheduler round trip

test('T3 a normalized task list round-trips deep-equal and a read writes nothing', () => {
  const dir = newDir();
  const tasksPath = path.join(dir, TASKS_NAME);
  const payload = payloadFor(7);
  writeScheduledTasksFile(tasksPath, payload);
  const bytes = fs.readFileSync(tasksPath);
  const listing = listDir(dir);

  assert.deepEqual(readScheduledTasksJsonPayload(tasksPath), payload);
  assert.deepEqual(readScheduledTasksFile(tasksPath, { nowProvider: () => FIXED_NOW }), payload);
  assert.deepEqual(readScheduledTasksJsonPayload(tasksPath), payload);

  assert.ok(bytes.equals(fs.readFileSync(tasksPath)), 'reads left the bytes identical');
  assert.deepEqual(listDir(dir), listing, 'reads created no file');
  assert.deepEqual(listing, [TASKS_NAME]);
});

// ---------------------------------------------------------------- I1 IDE snapshots

const snapshotHash = (seq) => sha256Text(normalizeDiffInputText(snapshotContentFor(seq)));

for (const [mode, killAt] of [['kill-before', 1], ['kill-before', 3], ['kill-after', 3]]) {
  test(`I1 ${mode} at capture ${killAt}: acked snapshots read back, an unrenamed one is a miss`, { timeout: 60000 }, async () => {
    const dir = newDir();
    const run = await runCrashChild('snapshot', dir, mode, killAt);
    assertKilled(run);
    assert.deepEqual(run.acks, Array.from({ length: killAt - 1 }, (_, index) => `${index + 1} ${snapshotHash(index + 1)}`));
    const store = createWorkspaceIdeSnapshotStore({ rootDir: dir });
    for (let seq = 1; seq < killAt; seq += 1) {
      assert.deepEqual(await store.read(snapshotHash(seq)), { found: true, content: snapshotContentFor(seq) });
    }

    const orphans = listDir(dir).filter((name) => name.includes('.tmp-'));
    if (mode === 'kill-before') {
      assert.deepEqual(await store.read(snapshotHash(killAt)), { found: false, reason: 'missing' });
      assert.equal(orphans.length, 1, `exactly the in-flight temp is left: ${orphans}`);
      assert.match(orphans[0], SNAP_TMP);
      assert.equal(orphans[0].slice(0, 64), snapshotHash(killAt).slice('sha256:'.length));
      assert.equal(fs.readFileSync(path.join(dir, orphans[0]), 'utf8'), normalizeDiffInputText(snapshotContentFor(killAt)));

      // Recorded finding: prune() only counts *.snap and capture only cleans its own failed
      // temp, so a killed capture's `.snap.tmp-*` file is never removed by later captures.
      assert.equal((await store.capture({ content: snapshotContentFor(90) })).stored, true);
      assert.equal((await store.capture({ content: snapshotContentFor(killAt) })).stored, true);
      assert.deepEqual(await store.read(snapshotHash(killAt)), { found: true, content: snapshotContentFor(killAt) });
      assert.ok(listDir(dir).includes(orphans[0]), 'the orphan survives later captures and their prune');
    } else {
      assert.deepEqual(orphans, [], 'the rename consumed the temp file');
      assert.deepEqual(await store.read(snapshotHash(killAt)), { found: true, content: snapshotContentFor(killAt) });
    }
  });
}

// ---------------------------------------------------------------- X MCP config

const mcpPath = (dir) => path.join(dir, MCP_NAME);
const readMcp = (dir) => fs.readFileSync(mcpPath(dir), 'utf8');
const serverNames = (document) => document.mcp_servers.map((server) => server.name);

function writeMcpDoc(dir, seqs = [1, 2]) {
  const store = new McpConfigStore({ userDataPath: dir });
  for (const seq of seqs) assert.equal(store.update(mcpAddServer(seq)).ok, true);
  return { store, bytes: readMcp(dir), document: store.getState().document };
}

function replayMcp(lastSeq) {
  const store = new McpConfigStore({ userDataPath: newDir() });
  for (let seq = 1; seq <= lastSeq; seq += 1) store.update(mcpAddServer(seq));
  return store.getState().document;
}

// X1
for (const [mode, killAt] of CRASH_MATRIX) {
  test(`X1 ${mode} at update ${killAt}: reopening loads a writable acked-or-in-flight document`, { timeout: 60000 }, async () => {
    const dir = newDir();
    const run = await runCrashChild('mcp-update', dir, mode, killAt);
    assertKilled(run);
    assert.deepEqual(run.acks, lastAcks(killAt - 1));
    const surviving = mode === 'kill-before' ? killAt - 1 : killAt;

    const orphans = listDir(dir).filter((name) => name.endsWith('.tmp'));
    if (mode === 'kill-before') {
      // Recorded finding: the in-flight temp is left behind; the store never reaps it.
      assert.equal(orphans.length, 1, `exactly the in-flight temp is left: ${orphans}`);
      assert.match(orphans[0], MCP_TMP);
    } else {
      assert.deepEqual(orphans, [], 'the rename consumed the temp file');
    }

    const store = new McpConfigStore({ userDataPath: dir });
    const state = store.getState();
    assert.equal(state.readOnly, false);
    assert.equal(state.reason, '');
    assert.deepEqual(state.document, surviving ? replayMcp(surviving) : defaultDocument());
    assert.deepEqual(serverNames(state.document), Array.from({ length: surviving }, (_, index) => `srv${index + 1}`));

    assert.equal(store.update(mcpAddServer(99)).ok, true);
    assert.equal(serverNames(new McpConfigStore({ userDataPath: dir }).getState().document).pop(), 'srv99');
    assert.deepEqual(listDir(dir).filter((name) => name.endsWith('.tmp')), orphans);
  });
}

// X2
function withBadRow(text) {
  const parsed = JSON.parse(text);
  parsed.mcp_servers[0].name = '../bad';
  return JSON.stringify(parsed, null, 2);
}
for (const [label, damage, reason] of [
  ['truncated JSON', (text) => text.slice(0, Math.floor(text.length / 2)), 'malformed_json'],
  ['empty file', () => '', 'malformed_json'],
  ['top-level array', () => '[]', 'unknown_top_level_fields'],
  ['object with a bad server row', withBadRow, 'server_identity_invalid'],
  ['servers as an object', (text) => text.replace('"mcp_servers": [', '"mcp_servers": {"x": ['), 'malformed_json'],
]) {
  test(`X2 ${label}: read-only with ${reason}, update refused, bytes intact`, () => {
    const dir = newDir();
    writeMcpDoc(dir);
    const damaged = damage(readMcp(dir));
    fs.writeFileSync(mcpPath(dir), damaged, 'utf8');
    const listing = listDir(dir);

    const store = new McpConfigStore({ userDataPath: dir });
    const state = store.getState();
    assert.equal(state.readOnly, true);
    assert.equal(state.reason, reason);
    assert.deepEqual(state.document.mcp_servers, []);
    let called = 0;
    assert.deepEqual(store.update((document) => { called += 1; return document; }),
      { ok: false, reason, read_only: true });
    assert.equal(called, 0, 'the mutator never ran');
    assert.equal(readMcp(dir), damaged);
    assert.deepEqual(listDir(dir), listing);
  });
}

// X3
for (const [version, reason] of [[3, 'future_schema'], [0, 'unsupported_schema'], [1.5, 'future_schema']]) {
  test(`X3 schema version ${version}: read-only with ${reason}, update refused, bytes intact`, () => {
    const dir = newDir();
    writeMcpDoc(dir);
    const restamped = `${JSON.stringify({ ...JSON.parse(readMcp(dir)), mcp_config_schema_version: version }, null, 2)}\n`;
    fs.writeFileSync(mcpPath(dir), restamped, 'utf8');

    const store = new McpConfigStore({ userDataPath: dir });
    const state = store.getState();
    assert.equal(state.readOnly, true);
    assert.equal(state.reason, reason);
    assert.equal(state.schemaVersion, version);
    assert.deepEqual(state.document.mcp_servers, []);
    assert.deepEqual(store.update(mcpAddServer(5)), { ok: false, reason, read_only: true });
    assert.equal(readMcp(dir), restamped);
    assert.deepEqual(listDir(dir), [MCP_NAME]);
  });
}

// X4
test('X4 kill before the legacy migration rename: the legacy file survives and migrates on the next start', { timeout: 60000 }, async () => {
  const dir = newDir();
  const legacy = {
    mcp_sse_enabled: true,
    mcp_servers: [
      { name: 'remote', transport: 'sse', url: 'https://mcp.example.test/sse',
        auth: { kind: 'bearer', secret_ref: 'mcp:remote' } },
      { name: 'docs', transport: 'stdio', command: 'node', args: ['server.js'] },
    ],
  };
  const legacyBytes = `${JSON.stringify(legacy, null, 2)}\n`;
  fs.writeFileSync(mcpPath(dir), legacyBytes, 'utf8');

  const run = await runCrashChild('mcp-migrate', dir, 'kill-before', 1);
  assertKilled(run);
  assert.equal(readMcp(dir), legacyBytes, 'the legacy file is untouched');
  const orphans = listDir(dir).filter((name) => name.endsWith('.tmp'));
  assert.equal(orphans.length, 1, `the migration temp is left behind: ${orphans}`);
  assert.match(orphans[0], MCP_TMP);

  const state = new McpConfigStore({ userDataPath: dir }).getState();
  assert.equal(state.readOnly, false);
  assert.equal(state.migrated, true);
  assert.equal(state.document.mcp_sse_enabled, true);
  assert.deepEqual(serverNames(state.document), ['remote', 'docs']);
  for (const server of state.document.mcp_servers) {
    assert.equal(server.enabled, false);
    assert.equal(server.trust.status, 'pending');
    assert.equal(server.trust.configuration_digest, configurationDigest(server));
  }
  assert.equal(state.document.mcp_servers[0].auth.secret_ref, 'mcp:remote');
  assert.equal(JSON.parse(readMcp(dir)).mcp_config_schema_version, state.document.mcp_config_schema_version);
  assert.deepEqual(new McpConfigStore({ userDataPath: dir }).getState().document, state.document);
});

// X5
test('X5 a store-written document loads without writing and deep-equals', () => {
  const dir = newDir();
  const written = writeMcpDoc(dir, [1, 2, 3]);
  const listing = listDir(dir);

  const state = new McpConfigStore({ userDataPath: dir }).getState();
  assert.equal(state.readOnly, false);
  assert.equal(state.migrated, false);
  assert.deepEqual(state.document, written.document);
  assert.equal(readMcp(dir), written.bytes);
  assert.deepEqual(listDir(dir), listing);
});

// X6
test('X6 EPERM from the rename of an update: write_failed, bytes and document kept, next update works', (t) => {
  const dir = newDir();
  const logs = [];
  const { bytes } = writeMcpDoc(dir, [1]);
  const store = new McpConfigStore({ userDataPath: dir, log: (level, event) => logs.push(`${level} ${event}`) });
  const before = store.getState().document;

  const realRename = fs.renameSync;
  let injected = 0;
  fs.renameSync = function renameEperm(from, to, ...rest) {
    if (path.basename(String(to)) === MCP_NAME && injected === 0) {
      injected += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return realRename.call(this, from, to, ...rest);
  };
  t.after(() => { fs.renameSync = realRename; });

  assert.deepEqual(store.update(mcpAddServer(2)), { ok: false, reason: 'write_failed' });
  assert.equal(injected, 1);
  assert.equal(readMcp(dir), bytes);
  assert.deepEqual(store.getState().document, before);
  assert.deepEqual(listDir(dir), [MCP_NAME], 'no temp or rollback file left');
  assert.deepEqual(logs, ['WARN mcp.config.write_failed']);

  assert.equal(store.update(mcpAddServer(2)).ok, true);
  assert.deepEqual(serverNames(new McpConfigStore({ userDataPath: dir }).getState().document), ['srv1', 'srv2']);
  assert.deepEqual(listDir(dir), [MCP_NAME]);
});
