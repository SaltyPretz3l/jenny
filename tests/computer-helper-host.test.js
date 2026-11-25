'use strict';

// new-test-file: the jenny-computer helper host (services/computer-helper/host.js and helper-binary.js)
// is a new surface; protocol-level cases stay in computer-helper-protocol.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { removeTreeSync } = require('../services/fs-remove-no-follow');
const { createComputerHelperHost, resolveHelperBinary, BINARY_NAME } = require('../services/computer-helper');

const FAKE = path.join(__dirname, 'fixtures', 'fake-computer-helper.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-helper-host-'));
const hosts = [];

test.after(async () => {
  await Promise.all(hosts.map((host) => host.stop()));
  removeTreeSync(TMP);
});

function fakeEnv(options = {}, extra = {}) {
  return { ...process.env, FAKE_COMPUTER_HELPER: JSON.stringify(options), ...extra };
}

function makeHost(options = {}, fakeOptions = {}) {
  const host = createComputerHelperHost({
    command: process.execPath,
    args: [FAKE, '--serve'],
    env: fakeEnv(fakeOptions),
    ...options,
  });
  hosts.push(host);
  return host;
}

// A tiny stand-in written to a temp file: `body` runs with `send(obj)` and the request lines.
function scriptHost(name, body, options = {}) {
  const file = path.join(TMP, `${name}.js`);
  const source = `
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const hello = (id, extra) => send({ id, ok: true, result: { protocol: 1, version: 'x', platform: 'windows', available: true, built: {}, ...extra } });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.op === 'shutdown' && !globalThis.IGNORE_SHUTDOWN) { send({ id: m.id, ok: true, result: {} }); process.exit(0); } onLine(m); } });
process.stdin.on('end', () => process.exit(0));
${body}
`;
  fs.writeFileSync(file, source);
  const host = createComputerHelperHost({ command: process.execPath, args: [file, '--serve'], ...options });
  hosts.push(host);
  return host;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function once(emitter, name) {
  return new Promise((resolve) => emitter.once(name, (...args) => resolve(args)));
}

test('resolveHelperBinary tries resources then build/sidecar and answers empty when neither exists', () => {
  const seen = [];
  const found = resolveHelperBinary({
    resourcesPath: path.join(path.sep, 'res'),
    root: path.join(path.sep, 'repo'),
    exists: (candidate) => { seen.push(candidate); return candidate.startsWith(path.join(path.sep, 'repo')); },
  });
  assert.deepEqual(seen, [
    path.join(path.sep, 'res', 'sidecar', BINARY_NAME),
    path.join(path.sep, 'repo', 'build', 'sidecar', BINARY_NAME),
  ]);
  assert.equal(found, path.join(path.sep, 'repo', 'build', 'sidecar', BINARY_NAME));
  assert.equal(resolveHelperBinary({ resourcesPath: '', root: path.join(path.sep, 'repo'), exists: () => false }), '');
  const noResources = [];
  resolveHelperBinary({ resourcesPath: undefined, root: path.join(path.sep, 'repo'), exists: (c) => { noResources.push(c); return false; } });
  assert.equal(noResources.length, 1);
  assert.equal(BINARY_NAME, process.platform === 'win32' ? 'jenny-computer.exe' : 'jenny-computer');
});

test('start spawns the helper, checks hello and is idempotent', async () => {
  const host = makeHost();
  assert.equal(host.state(), 'stopped');
  assert.equal(host.pid(), null);
  const first = host.start();
  assert.equal(host.state(), 'starting');
  assert.equal(host.start(), first);
  const result = await first;
  assert.equal(result.available, true);
  assert.equal(result.hello.protocol, 1);
  assert.equal(host.state(), 'ready');
  assert.ok(Number.isInteger(host.pid()));
  assert.equal(await host.start(), result);
});

test('start with no command is not_installed and spawns nothing', async () => {
  let spawned = 0;
  const host = makeHost({ command: '', spawn: () => { spawned += 1; } });
  assert.deepEqual(await host.start(), { available: false, reason: 'not_installed' });
  assert.equal(spawned, 0);
  assert.equal(host.state(), 'unavailable');
  await assert.rejects(host.request('windows.list'), { code: 'helper_unavailable' });
});

test('a helper speaking another protocol is ended and reported as protocol_mismatch', async () => {
  const host = scriptHost('mismatch', "function onLine(m) { if (m.op === 'hello') hello(m.id, { protocol: 2 }); }");
  const result = await host.start();
  assert.deepEqual(result, { available: false, reason: 'protocol_mismatch' });
  assert.equal(host.state(), 'unavailable');
  assert.equal(host.pid(), null);
});

test('a helper that is not available is ended and reported as not_available with its hello', async () => {
  const host = makeHost({}, { available: false });
  const result = await host.start();
  assert.equal(result.available, false);
  assert.equal(result.reason, 'not_available');
  assert.equal(result.hello.available, false);
  assert.equal(host.state(), 'unavailable');
  assert.equal(host.pid(), null);
  await assert.rejects(host.request('windows.list'), { code: 'helper_unavailable' });
});

test('a helper that never answers hello is ended and reported as no_answer', async () => {
  const host = scriptHost('silent', 'function onLine() {}', { helloTimeoutMs: 150 });
  assert.deepEqual(await host.start(), { available: false, reason: 'no_answer' });
  assert.equal(host.state(), 'unavailable');
  assert.equal(host.pid(), null);
});

test('a command that cannot be spawned is start_failed', async () => {
  const host = makeHost({ command: path.join(TMP, 'no-such-helper'), args: ['--serve'] });
  assert.deepEqual(await host.start(), { available: false, reason: 'start_failed' });
  assert.equal(host.state(), 'unavailable');
});

test('request round trip: windows.list answers its result and ids increase', async () => {
  const log = path.join(TMP, 'requests.log');
  const host = makeHost({ env: fakeEnv({}, { FAKE_COMPUTER_HELPER_LOG: log }) });
  const result = await host.request('windows.list');
  assert.deepEqual(result, { windows: [] });
  await host.request('run.list');
  const ids = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).id);
  assert.equal(ids.length, 3);
  assert.ok(ids.every((id, i) => Number.isSafeInteger(id) && (i === 0 || id > ids[i - 1])));
});

test('a protocol error code surfaces on the rejected Error', async () => {
  const host = makeHost();
  await assert.rejects(host.request('run.output', { run_id: 'nope' }), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'no_such_run');
    return true;
  });
  await assert.rejects(host.request('run.start', { run_id: '!' }), { code: 'bad_request' });
  await assert.rejects(host.request('input.click'), { code: 'not_built' });
});

test('an op the protocol does not name is bad_request without reaching the helper', async () => {
  const host = makeHost();
  await assert.rejects(host.request('format.disk'), { code: 'bad_request' });
  await assert.rejects(host.request('windows.list', { id: 5 }), { code: 'bad_request' });
  assert.equal(host.state(), 'stopped');
});

test('a request the helper never answers times out, and a late reply is dropped', async () => {
  const dropped = [];
  const host = scriptHost('slow', `
function onLine(m) {
  if (m.op === 'hello') return hello(m.id);
  setTimeout(() => send({ id: m.id, ok: true, result: { late: true } }), 250);
}`, { logger: { debug: (m) => dropped.push(m), info() {}, warn() {}, error() {} } });
  await assert.rejects(host.request('windows.list', {}, { timeoutMs: 80 }), { code: 'timeout' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(host.state(), 'ready');
  assert.equal((await host.request('hello')).protocol, 1);
  assert.equal(dropped.filter((m) => m.includes('unknown id')).length, 1);
});

test('run.stop without a caller timeout waits close_timeout_ms plus 8 s', async () => {
  const delays = [];
  const host = makeHost({ setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, ms); } });
  await host.request('run.start', { run_id: 'r1', program: path.resolve('x.exe'), args: [], cwd: path.resolve('.'), env: {} });
  delays.length = 0;
  await host.request('run.stop', { run_id: 'r1' });
  assert.ok(delays.includes(10000), `delays ${delays}`);
  delays.length = 0;
  await host.request('run.start', { run_id: 'r3', program: path.resolve('x.exe'), args: [], cwd: path.resolve('.'), env: {} });
  await host.request('run.stop', { run_id: 'r3', close_timeout_ms: 5000 });
  assert.ok(delays.includes(13000), `delays ${delays}`);
});

test('run.start then run.window and run.exited reach listeners and the active run set', async () => {
  const host = makeHost();
  const all = [];
  host.on('event', (name, fields) => all.push([name, fields.run_id]));
  const windowFields = once(host, 'run.window');
  const started = await host.request('run.start', {
    run_id: 'r1', program: path.resolve('x.exe'), args: [], cwd: path.resolve('.'), env: {},
  });
  assert.equal(started.run_id, 'r1');
  assert.deepEqual(host.activeRunIds(), ['r1']);
  const [fields] = await windowFields;
  assert.equal(fields.run_id, 'r1');
  assert.equal(fields.source_id, `window:${fields.hwnd}:0`);
  const exited = once(host, 'run.exited');
  const stopped = await host.request('run.stop', { run_id: 'r1' });
  assert.equal(stopped.how, 'closed');
  const [exitFields] = await exited;
  assert.equal(exitFields.exit_code, 0);
  assert.deepEqual(host.activeRunIds(), []);
  assert.deepEqual(all, [['run.window', 'r1'], ['run.exited', 'r1']]);
});

test('a run that exits on its own leaves the active set', async () => {
  const host = makeHost({}, { exitOnStart: true, exitCode: 7 });
  const exited = once(host, 'run.exited');
  await host.request('run.start', { run_id: 'r2', program: path.resolve('x.exe'), args: [], cwd: path.resolve('.'), env: {} });
  const [fields] = await exited;
  assert.equal(fields.exit_code, 7);
  assert.deepEqual(host.activeRunIds(), []);
});

test('a run that exits before its start reply lands never joins the active set, and a later run still does', async () => {
  const host = scriptHost('early-exit', `
function onLine(m) {
  if (m.op === 'hello') return hello(m.id);
  if (m.op === 'run.start') {
    if (m.run_id === 'quick') send({ event: 'run.exited', run_id: 'quick', exit_code: 3 });
    return send({ id: m.id, ok: true, result: { run_id: m.run_id, pid: 77 } });
  }
  send({ id: m.id, ok: true, result: {} });
}`);
  const exits = [];
  host.on('run.exited', (fields) => exits.push(fields.run_id));
  const reply = await host.request('run.start', { run_id: 'quick', program: path.resolve('x.exe'), args: [], cwd: path.resolve('.'), env: {} });
  assert.equal(reply.run_id, 'quick');
  assert.deepEqual(exits, ['quick']);
  assert.deepEqual(host.activeRunIds(), [], 'the program was already gone when the reply landed');
  await host.request('run.start', { run_id: 'slow', program: path.resolve('x.exe'), args: [], cwd: path.resolve('.'), env: {} });
  assert.deepEqual(host.activeRunIds(), ['slow']);
});

test('a crash mid-request rejects pending, names the runs, and the next request restarts', async () => {
  const host = makeHost({}, { crashOnOp: 'run.list', noWindow: true });
  await host.request('run.start', { run_id: 'r1', program: path.resolve('x.exe'), args: [], cwd: path.resolve('.'), env: {} });
  const firstPid = host.pid();
  const crashed = once(host, 'helper_exited');
  const pending = host.request('run.list');
  await assert.rejects(pending, { code: 'helper_exited' });
  const [info] = await crashed;
  assert.equal(info.code, 3);
  assert.deepEqual(info.runIds, ['r1']);
  assert.equal(host.state(), 'crashed');
  assert.deepEqual(host.activeRunIds(), []);
  assert.equal(host.pid(), null);
  const result = await host.request('windows.list');
  assert.deepEqual(result, { windows: [] });
  assert.equal(host.state(), 'ready');
  assert.notEqual(host.pid(), firstPid);
  assert.equal(host.stats().restarts, 1);
});

test('more crashes than maxRestarts in the window make the host unavailable until reset', async () => {
  const host = makeHost({ maxRestarts: 1 }, { crashOnOp: 'run.list' });
  await assert.rejects(host.request('run.list'), { code: 'helper_exited' });
  await assert.rejects(host.request('run.list'), { code: 'helper_exited' });
  assert.equal(host.state(), 'crashed');
  await assert.rejects(host.request('windows.list'), { code: 'helper_unavailable' });
  assert.equal(host.state(), 'unavailable');
  await assert.rejects(host.request('windows.list'), { code: 'helper_unavailable' });
  host.reset();
  assert.equal(host.state(), 'stopped');
  assert.deepEqual(await host.request('windows.list'), { windows: [] });
});

test('restarts older than the window do not count', async () => {
  let clock = 1000;
  const host = makeHost({ maxRestarts: 1, restartWindowMs: 500, now: () => clock }, { crashOnOp: 'run.list' });
  await assert.rejects(host.request('run.list'), { code: 'helper_exited' });
  await assert.rejects(host.request('run.list'), { code: 'helper_exited' });
  clock += 1000;
  assert.deepEqual(await host.request('windows.list'), { windows: [] });
  assert.equal(host.state(), 'ready');
});

test('stop sends shutdown, the child is gone, and the host can start again', async () => {
  const log = path.join(TMP, 'stop.log');
  const host = makeHost({ env: fakeEnv({}, { FAKE_COMPUTER_HELPER_LOG: log }) });
  await host.start();
  const pid = host.pid();
  const crashes = [];
  host.on('helper_exited', (info) => crashes.push(info));
  await host.stop();
  assert.equal(host.state(), 'stopped');
  assert.equal(host.pid(), null);
  await until(() => !alive(pid), 'the child to be gone');
  const ops = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).op);
  assert.deepEqual(ops, ['hello', 'shutdown']);
  assert.deepEqual(crashes, []);
  assert.equal((await host.start()).available, true);
  await host.stop();
  await host.stop();
});

test('stop ends a helper that ignores shutdown after shutdownTimeoutMs, by its own handle', async () => {
  const host = scriptHost('stubborn', `
globalThis.IGNORE_SHUTDOWN = true;
function onLine(m) { if (m.op === 'hello') hello(m.id); }
process.stdin.removeAllListeners('end');
setInterval(() => {}, 1000);`, { shutdownTimeoutMs: 150 });
  await host.start();
  const pid = host.pid();
  await host.stop();
  assert.equal(host.state(), 'stopped');
  await until(() => !alive(pid), 'the stubborn child to be killed');
});

test('stderr is kept as a bounded tail, bad lines are counted and helper logs reach the logger', async () => {
  const lines = { debug: [], warn: [], info: [], error: [] };
  const logger = {};
  for (const level of Object.keys(lines)) logger[level] = (message) => lines[level].push(String(message));
  const host = scriptHost('noisy', `
function onLine(m) {
  if (m.op !== 'hello') return;
  process.stderr.write('first stderr line\\n');
  process.stderr.write('x'.repeat(100000) + '\\n');
  process.stdout.write('this is not json\\n');
  send({ event: 'log', level: 'warn', message: 'y'.repeat(900) });
  hello(m.id);
}`, { logger });
  const events = [];
  host.on('event', (name, fields) => events.push([name, fields.level]));
  await host.start();
  await until(() => events.length === 1, 'the log event');
  assert.deepEqual(events, [['log', 'warn']]);
  assert.equal(host.stats().badLines, 1);
  assert.equal(lines.warn.filter((m) => m.includes('yyyy')).length, 1);
  assert.ok(lines.warn.every((m) => m.length <= 600));
  const tail = host.stderrTail();
  assert.ok(tail.length <= 64 * 1024);
  assert.ok(tail.endsWith('x\n'));
  assert.ok(lines.debug.length >= 2);
  assert.ok(lines.debug.every((m) => m.length <= 600));
});
