'use strict';

// Team slice 1c-1a: the readiness marker a team host leaves in its profile, and
// the health check's team variant that reads it without any network request.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { checkTeam, main } = require('../../server/healthcheck');
const {
  READY_MARKER_FILE, isReadyMarkerLive, readReadyMarker, removeReadyMarker, writeReadyMarker,
} = require('../../server/team/ready-marker');

function profile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ready-marker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const markerFile = (userDataPath) => path.join(userDataPath, READY_MARKER_FILE);

test('the marker is team-ready.json holding the schema, boot epoch and pid', (t) => {
  const userDataPath = profile(t);
  assert.equal(READY_MARKER_FILE, 'team-ready.json');
  writeReadyMarker({ userDataPath, bootEpoch: 'boot_1-A', pid: 4242 });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile(userDataPath), 'utf8')),
    { schema_version: 1, boot_epoch: 'boot_1-A', pid: 4242 });
  assert.deepEqual(readReadyMarker({ userDataPath }), { bootEpoch: 'boot_1-A', pid: 4242 });
  writeReadyMarker({ userDataPath, bootEpoch: 'second', startTime: null });
  assert.deepEqual(readReadyMarker({ userDataPath }), { bootEpoch: 'second', pid: process.pid });
  assert.deepEqual(fs.readdirSync(userDataPath), [READY_MARKER_FILE]);
});

test('writing refuses an invalid epoch or pid', (t) => {
  const userDataPath = profile(t);
  assert.throws(() => writeReadyMarker({ userDataPath, bootEpoch: 'bad epoch' }), /invalid_boot_epoch/);
  assert.throws(() => writeReadyMarker({ userDataPath, bootEpoch: 'a'.repeat(129) }), /invalid_boot_epoch/);
  assert.throws(() => writeReadyMarker({ userDataPath, bootEpoch: 'ok', pid: 0 }), /invalid_pid/);
  assert.throws(() => writeReadyMarker({ userDataPath, bootEpoch: 'ok', pid: 1.5 }), /invalid_pid/);
  assert.deepEqual(fs.readdirSync(userDataPath), []);
});

test('a marker written then removed reads null and removal never throws', (t) => {
  const userDataPath = profile(t);
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 7 });
  removeReadyMarker({ userDataPath });
  assert.equal(readReadyMarker({ userDataPath }), null);
  assert.equal(fs.existsSync(markerFile(userDataPath)), false);
  assert.equal(removeReadyMarker({ userDataPath }), undefined);
  assert.equal(removeReadyMarker({ userDataPath: path.join(userDataPath, 'missing', 'deeper') }), undefined);
  // A directory where the marker belongs cannot be removed as a file; still no throw.
  fs.mkdirSync(markerFile(userDataPath));
  fs.writeFileSync(path.join(markerFile(userDataPath), 'x'), 'x');
  assert.equal(removeReadyMarker({ userDataPath }), undefined);
  assert.equal(readReadyMarker({ userDataPath }), null);
});

test('reading returns null for every malformed marker and never throws', (t) => {
  const userDataPath = profile(t);
  assert.equal(readReadyMarker({ userDataPath }), null);
  const good = { schema_version: 1, boot_epoch: 'boot', pid: 10 };
  const bad = [
    '{not json',
    '[]',
    'null',
    '7',
    JSON.stringify({ ...good, extra: true }),
    JSON.stringify({ schema_version: 1, boot_epoch: 'boot' }),
    JSON.stringify({ schema_version: 1, pid: 10 }),
    JSON.stringify({ boot_epoch: 'boot', pid: 10 }),
    JSON.stringify({ ...good, schema_version: 2 }),
    JSON.stringify({ ...good, schema_version: 3 }),
    JSON.stringify({ ...good, schema_version: '1' }),
    JSON.stringify({ ...good, boot_epoch: 'bad epoch' }),
    JSON.stringify({ ...good, boot_epoch: '' }),
    JSON.stringify({ ...good, boot_epoch: 'a'.repeat(129) }),
    JSON.stringify({ ...good, boot_epoch: 5 }),
    JSON.stringify({ ...good, pid: 0 }),
    JSON.stringify({ ...good, pid: -3 }),
    JSON.stringify({ ...good, pid: 1.5 }),
    JSON.stringify({ ...good, pid: '10' }),
    JSON.stringify({ ...good, pid: 2 ** 60 }),
    JSON.stringify({ ...good, padding: 'x'.repeat(5000) }),
  ];
  for (const text of bad) {
    fs.writeFileSync(markerFile(userDataPath), text);
    assert.equal(readReadyMarker({ userDataPath }), null, text.slice(0, 60));
  }
  fs.writeFileSync(markerFile(userDataPath), JSON.stringify(good));
  assert.deepEqual(readReadyMarker({ userDataPath }), { bootEpoch: 'boot', pid: 10 });
  assert.equal(readReadyMarker({ userDataPath: path.join(userDataPath, 'nope') }), null);
});

test('a marker is live only while its process is alive', (t) => {
  const userDataPath = profile(t);
  const asked = [];
  const isProcessAlive = (pid) => { asked.push(pid); return pid === 4242; };
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive }), false);
  assert.deepEqual(asked, []);
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 4242 });
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive }), true);
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 4243 });
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive }), false);
  assert.deepEqual(asked, [4242, 4243]);
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive: () => { throw new Error('boom'); } }), false);
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive: () => 'yes' }), false);
});

test('the default liveness check sees this process and rejects a dead pid', (t) => {
  const userDataPath = profile(t);
  writeReadyMarker({ userDataPath, bootEpoch: 'boot' });
  assert.equal(isReadyMarkerLive({ userDataPath }), true);
  // Node's own pid space tops out below 2^31; this pid names no process.
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 2 ** 31 - 2 });
  assert.equal(isReadyMarkerLive({ userDataPath }), false);
});

test('the team health check resolves for a live marker and makes no network request', async (t) => {
  const userDataPath = profile(t);
  const config = { userDataPath, team: { name: 'Core', keySource: 'secret_file', directPort: null } };
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 99 });
  assert.equal(await checkTeam(config, { isProcessAlive: (pid) => pid === 99 }), undefined);
  await assert.rejects(checkTeam(config, { isProcessAlive: () => false }), /host_unhealthy/);
  removeReadyMarker({ userDataPath });
  await assert.rejects(checkTeam(config, { isProcessAlive: () => true }), /host_unhealthy/);
});

function teamConfigFile(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-team-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => path.join(root, 'home'));
  const userDataPath = path.join(root, 'profile');
  fs.mkdirSync(userDataPath);
  const configPath = path.join(root, 'host.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schema_version: 3, host_mode: 'server', host_execution_policy_version: 1, listen_host: '127.0.0.1', port: 0,
    user_data_path: userDataPath, workspace_root: null, secrets_dir: path.join(root, 'secrets'),
    model_endpoint: { engine: 'ollama', model: 'm', api_url: 'http://ollama:11434' },
    team: { name: 'Core', key_source: 'parent_channel', direct_port: null },
  }));
  return { configPath, userDataPath: fs.realpathSync.native(userDataPath) };
}

test('main takes the team path from the config and never makes a network request', async (t) => {
  const { configPath, userDataPath } = teamConfigFile(t);
  const requestImpl = () => { assert.fail('a team host must make no network request'); };
  const dead = { isProcessAlive: () => false, requestImpl };
  const live = { isProcessAlive: (pid) => pid === 31337, requestImpl };
  await assert.rejects(main(['--config', configPath], dead), /host_unhealthy/);
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 31337 });
  assert.equal(await main(['--config', configPath], live), undefined);
  assert.equal(await main(['--config', configPath, '--ready'], live), undefined);
  await assert.rejects(main(['--config', configPath, '--ready'], dead), /host_unhealthy/);
  removeReadyMarker({ userDataPath });
  await assert.rejects(main(['--config', configPath], live), /host_unhealthy/);
});

// Slice 3-11: in a container the host is pid 1 on every run, so a marker a killed container left
// would name a live pid. On Linux the marker also records the process's start time (field 22 of
// /proc/<pid>/stat) and the check compares it. Every case injects the reader: no real /proc.
const { processStartTime } = require('../../server/team/ready-marker');

const statLine = (start, comm = 'node') => `1 (${comm}) S ${Array.from({ length: 18 }, (_, i) => i + 2).join(' ')} ${start} 4096 77\n`;

test('the start time is field 22 of the stat line, read only on Linux, any surprise null', () => {
  const linux = (text) => processStartTime(1, { platform: 'linux', readStat: () => text });
  assert.equal(linux(statLine('123456')), '123456');
  // A command name may hold spaces and parentheses: the fields start after the last `)`.
  assert.equal(linux(statLine('987', 'a) b (c')), '987');
  for (const text of [null, '', 'garbage', '1 (node S 2 3', statLine('12a'), statLine('-5'), statLine('1'.repeat(21)),
    `${statLine('42').trimEnd()} ${'9 '.repeat(600)}`, 7]) {
    assert.equal(linux(text), null, String(text).slice(0, 40));
  }
  assert.equal(linux(() => { throw new Error('boom'); }), null);
  const asked = [];
  for (const platform of ['win32', 'darwin']) {
    assert.equal(processStartTime(1, { platform, readStat: (pid) => { asked.push(pid); return statLine('5'); } }), null);
  }
  assert.deepEqual(asked, [], 'off Linux nothing is read');
  assert.equal(processStartTime(0, { platform: 'linux', readStat: () => statLine('5') }), null);
});

test('a marker with a start time is schema 2; without one it is exactly the schema 1 marker', (t) => {
  const userDataPath = profile(t);
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 1, startTime: '5551' });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile(userDataPath), 'utf8')),
    { schema_version: 2, boot_epoch: 'boot', pid: 1, start_time: '5551' });
  assert.deepEqual(readReadyMarker({ userDataPath }), { bootEpoch: 'boot', pid: 1, startTime: '5551' });
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 1, startTime: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile(userDataPath), 'utf8')), { schema_version: 1, boot_epoch: 'boot', pid: 1 });
  assert.throws(() => writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 1, startTime: '12x' }), /invalid_start_time/);
  for (const value of [{ schema_version: 2, boot_epoch: 'b', pid: 1 }, { schema_version: 1, boot_epoch: 'b', pid: 1, start_time: '5' },
    { schema_version: 2, boot_epoch: 'b', pid: 1, start_time: 5 }, { schema_version: 2, boot_epoch: 'b', pid: 1, start_time: '' },
    { schema_version: 2, boot_epoch: 'b', pid: 1, start_time: '5', extra: 1 }, { schema_version: 3, boot_epoch: 'b', pid: 1, start_time: '5' },
    // A schema is the number 1 or 2, never a string or an array that a key lookup would coerce.
    { schema_version: '2', boot_epoch: 'b', pid: 1, start_time: '5' }, { schema_version: [2], boot_epoch: 'b', pid: 1, start_time: '5' },
    { schema_version: '2.0', boot_epoch: 'b', pid: 1, start_time: '5' }, { schema_version: '1', boot_epoch: 'b', pid: 1 },
    { schema_version: '1', boot_epoch: 'b', pid: 1, start_time: '5' }, { schema_version: [1], boot_epoch: 'b', pid: 1 }]) {
    fs.writeFileSync(markerFile(userDataPath), JSON.stringify(value));
    assert.equal(readReadyMarker({ userDataPath }), null, JSON.stringify(value));
  }
});

test('a live pid with a different start time is a stale marker; the same start time is live', (t) => {
  const userDataPath = profile(t);
  const isProcessAlive = (pid) => pid === 1;
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 1, startTime: '1000' });
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive, readStartTime: () => '1000' }), true);
  // The container restarted: pid 1 again, a later start.
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive, readStartTime: () => '2000' }), false);
  // Unreadable or oversized /proc data reads as null: not live.
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive, readStartTime: () => null }), false);
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive, readStartTime: () => { throw new Error('x'); } }), false);
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive: () => false, readStartTime: () => '1000' }), false);
  // An older marker without the field behaves as before: the pid alone, the start time never asked.
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 1, startTime: null });
  const asked = [];
  assert.equal(isReadyMarkerLive({ userDataPath, isProcessAlive, readStartTime: (pid) => { asked.push(pid); return '9'; } }), true);
  assert.deepEqual(asked, []);
});

test('the writer records its own start time and the health check compares it', async (t) => {
  const userDataPath = profile(t);
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', startTime: '77' });
  const config = { userDataPath, team: { name: 'Core', keySource: 'secret_file', directPort: null } };
  const live = (pid) => pid === process.pid;
  assert.equal(await checkTeam(config, { isProcessAlive: live, readStartTime: () => '77' }), undefined);
  await assert.rejects(checkTeam(config, { isProcessAlive: live, readStartTime: () => '78' }), /host_unhealthy/);
  // An explicit other pid records no start time unless one is given.
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', pid: 4242 });
  assert.equal(readReadyMarker({ userDataPath }).startTime, undefined);
});

test('the default writer reads its own start time: schema 2 on Linux with a value, schema 1 without one', (t) => {
  const userDataPath = profile(t);
  const asked = [];
  const linuxReader = (text) => (pid) => { asked.push(pid); return processStartTime(pid, { platform: 'linux', readStat: () => text }); };
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', readStartTime: linuxReader(statLine('4321')) });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile(userDataPath), 'utf8')),
    { schema_version: 2, boot_epoch: 'boot', pid: process.pid, start_time: '4321' });
  writeReadyMarker({ userDataPath, bootEpoch: 'boot', readStartTime: linuxReader(null) });
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile(userDataPath), 'utf8')),
    { schema_version: 1, boot_epoch: 'boot', pid: process.pid });
  assert.deepEqual(asked, [process.pid, process.pid]);
  // Off Linux the same default reads nothing and writes schema 1.
  writeReadyMarker({ userDataPath, bootEpoch: 'boot',
    readStartTime: (pid) => processStartTime(pid, { platform: 'win32', readStat: () => statLine('9') }) });
  assert.equal(JSON.parse(fs.readFileSync(markerFile(userDataPath), 'utf8')).schema_version, 1);
});
