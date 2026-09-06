'use strict';

/* W9 WorkspaceTerminalService: spawn shape (cwd, scrubbed env), single
 * session policy, write/signal/kill semantics, byte-capped onData
 * emission, and the ROOT_MISSING / NO_SESSION error codes. Uses a fake
 * spawn - no real PowerShell is launched. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { WorkspaceTerminalService } = require('../services/workspace-terminal-service');
const { TERMINAL_ERROR_CODES } = require('../services/backend/error-codes');

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.written = [];
  child.stdin.write = function write(text) { this.written.push(text); return true; };
  return child;
}

function createFixture({
  root = 'G:/fake-root', childFactory = createFakeChild, scheduleOutputFlush,
  setTimeoutImpl, clearTimeoutImpl, killTreeImpl,
} = {}) {
  const spawns = [];
  const kills = [];
  const events = [];
  const logs = [];
  let child = null;
  const service = new WorkspaceTerminalService({
    configService: { getToolsWorkspaceRoot: () => root },
    sendBridgeEvent: (key, payload) => events.push({ key, payload }),
    spawnImpl: (command, args, options) => {
      spawns.push({ command, args, options });
      child = childFactory();
      return child;
    },
    killTreeImpl: killTreeImpl || (async (pid) => {
      kills.push(pid);
      return { terminated: true };
    }),
    env: {
      PATH: 'C:/windows',
      JENNY_ENABLE_SECRET_FLAG: '1',
      MY_API_KEY: 'sk-leakme',
      EDITOR: 'vim',
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    scheduleOutputFlush,
    setTimeoutImpl,
    clearTimeoutImpl,
  });
  return { service, spawns, kills, events, logs, getChild: () => child };
}

test('terminal start spawns the shell with workspace cwd and scrubbed env', async () => {
  const { service, spawns } = createFixture();
  const result = await service.start();
  assert.match(result.sessionId, /^term-\d+$/);
  assert.equal(result.cwd, 'G:/fake-root');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.cwd, 'G:/fake-root');
  const env = spawns[0].options.env;
  assert.equal(env.PATH, 'C:/windows', 'system keys kept');
  assert.equal(env.EDITOR, 'vim', 'benign keys kept');
  assert.equal(env.JENNY_ENABLE_SECRET_FLAG, undefined, 'JENNY_* scrubbed');
  assert.equal(env.MY_API_KEY, undefined, 'credential-shaped keys scrubbed');

  // Single-session policy: a second start reuses the live session.
  const again = await service.start();
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.sessionId, result.sessionId);
  assert.equal(spawns.length, 1);
});

test('terminal requires a configured workspace root', async () => {
  const { service } = createFixture({ root: '' });
  await assert.rejects(service.start(), (error) => {
    assert.equal(error.code, TERMINAL_ERROR_CODES.ROOT_MISSING);
    return true;
  });
});

test('terminal forwards capped output and exit over the bridge', async () => {
  const { service, events, getChild } = createFixture();
  const { sessionId } = await service.start();
  const child = getChild();

  child.stdout.emit('data', 'hello\n');
  child.stderr.emit('data', 'oops\n');
  const big = 'x'.repeat(100 * 1024);
  child.stdout.emit('data', big);
  await Promise.resolve();

  // JCA-009: arrival order is the contract — stdout, stderr, stdout deliver as
  // three events in run order (whole-batch stream grouping used to misstate
  // compiler/test output order), and the oversized chunk is still capped.
  const dataEvents = events.filter((entry) => entry.key === 'workspaceTerminal.onData');
  assert.equal(dataEvents.length, 3, 'interleaved chunks deliver in arrival order');
  assert.equal(dataEvents[0].payload.sessionId, sessionId);
  assert.equal(dataEvents[0].payload.stream, 'stdout');
  assert.equal(dataEvents[0].payload.chunk, 'hello\n');
  assert.ok(dataEvents[0].payload.droppedBytes > 0, 'flush-level truncation is counted on the first event');
  assert.deepEqual(dataEvents[1].payload, { sessionId, stream: 'stderr', chunk: 'oops\n' });
  assert.equal(dataEvents[2].payload.stream, 'stdout');
  assert.equal(dataEvents[2].payload.chunk.length, 64 * 1024, 'per-event chunk cap');

  child.emit('exit', 0, null);
  const exitEvents = events.filter((entry) => entry.key === 'workspaceTerminal.onExit');
  assert.deepEqual(exitEvents[0].payload, { sessionId, code: 0, signal: '' });
  assert.equal(service.hasSession(), false, 'exit clears the session');
});

test('wide-036: async spawn error settles once, clears ownership, and permits restart', async () => {
  const { service, events, getChild, spawns, kills } = createFixture();
  const first = await service.start();
  const child = getChild();
  child.emit('error', Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' }));
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(kills, [child.pid], 'a post-spawn error confirms tree termination before settlement');
  assert.equal(service.hasSession(), false, 'an async spawn failure cannot strand the singleton');
  const exits = events.filter((entry) => entry.key === 'workspaceTerminal.onExit');
  assert.equal(exits.length, 1, 'error followed by exit settles exactly once');
  assert.equal(exits[0].payload.sessionId, first.sessionId);
  assert.equal(exits[0].payload.reason, 'child_error');

  const restarted = await service.start();
  assert.notEqual(restarted.sessionId, first.sessionId);
  assert.equal(spawns.length, 2, 'restart spawns a fresh owned child');
});

test('wide-036: an unconfirmed post-spawn error retains ownership and emits no terminal exit', async () => {
  const { service, events, getChild, logs } = createFixture({
    killTreeImpl: async () => ({ terminated: false }),
  });
  await service.start();
  getChild().emit('error', Object.assign(new Error('late stream failure'), { code: 'EIO' }));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(service.hasSession(), true, 'ownership cannot be dropped while child death is unconfirmed');
  assert.equal(events.filter((entry) => entry.key === 'workspaceTerminal.onExit').length, 0);
  assert.ok(logs.some((entry) => entry.event === 'workspace_terminal.kill_failed'));
});

test('wide-036: dispose latches shutdown and refuses a later terminal start', async () => {
  const { service, spawns } = createFixture();
  assert.deepEqual(await service.dispose(), { disposed: true, terminationConfirmed: true });
  await assert.rejects(service.start(), (error) => error.code === TERMINAL_ERROR_CODES.NO_SESSION);
  assert.equal(spawns.length, 0);
});

test('wide-036: sustained output is coalesced behind a bounded scheduled flush', async () => {
  let flush = null;
  const { service, events, getChild, logs } = createFixture({
    scheduleOutputFlush: (callback) => { flush = callback; return callback; },
  });
  const { sessionId } = await service.start();
  for (let index = 0; index < 200; index += 1) {
    getChild().stdout.emit('data', `row-${index}\n`);
  }
  assert.equal(events.filter((entry) => entry.key === 'workspaceTerminal.onData').length, 0,
    'producer chunks are not bridged one-for-one');
  assert.equal(typeof flush, 'function');
  flush();
  const data = events.filter((entry) => entry.key === 'workspaceTerminal.onData');
  assert.equal(data.length, 1, 'one scheduled flush coalesces the burst');
  assert.equal(data[0].payload.sessionId, sessionId);
  assert.match(data[0].payload.chunk, /row-199/);
  assert.ok(data[0].payload.chunk.length <= 64 * 1024, 'the flush remains byte bounded');
  assert.equal(logs.some((entry) => entry.event === 'workspace_terminal.output_dropped'), false);
});

test('wide-036: stdin backpressure waits for drain and maps EPIPE to a typed refusal', async () => {
  const childFactory = () => {
    const child = createFakeChild();
    child.stdin.write = function write(text) { this.written.push(text); return false; };
    return child;
  };
  const { service, getChild, logs } = createFixture({ childFactory });
  const { sessionId } = await service.start();
  const pending = service.write({ sessionId, data: 'blocked\r\n' });
  let settled = false;
  pending.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve();
  assert.equal(settled, false, 'write stays pending while stdin reports backpressure');
  getChild().stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  await assert.rejects(pending, (error) => error.code === TERMINAL_ERROR_CODES.NO_SESSION);
  assert.ok(logs.some((entry) => entry.event === 'workspace_terminal.stdin_error'));
});

test('wide-036: stalled stdin backpressure has a bounded observable deadline', async () => {
  const childFactory = () => {
    const child = createFakeChild();
    child.stdin.write = function write(text) { this.written.push(text); return false; };
    return child;
  };
  let fireDeadline = null;
  const { service, logs } = createFixture({
    childFactory,
    setTimeoutImpl: (callback) => { fireDeadline = callback; return 1; },
    clearTimeoutImpl: () => {},
  });
  const { sessionId } = await service.start();
  const pending = service.write({ sessionId, data: 'blocked\r\n' });
  await Promise.resolve();
  assert.equal(typeof fireDeadline, 'function');
  fireDeadline();
  await assert.rejects(pending, (error) => error.code === TERMINAL_ERROR_CODES.NO_SESSION);
  assert.ok(logs.some((entry) => entry.event === 'workspace_terminal.stdin_backpressure_timeout'));
});

test('terminal write reaches stdin; write/signal without a session rejects', async () => {
  const { service, getChild } = createFixture();
  const { sessionId } = await service.start();
  await service.write({ sessionId, data: 'dir\r\n' });
  assert.deepEqual(getChild().stdin.written, ['dir\r\n']);

  getChild().emit('exit', 0, null);
  await assert.rejects(service.write({ sessionId, data: 'dir\r\n' }), (error) => {
    assert.equal(error.code, TERMINAL_ERROR_CODES.NO_SESSION);
    return true;
  });
  await assert.rejects(service.signal({ sessionId }), (error) => {
    assert.equal(error.code, TERMINAL_ERROR_CODES.NO_SESSION);
    return true;
  });
});

test('signal, kill, and dispose all kill the process tree', async () => {
  const { service, kills, getChild } = createFixture();
  const { sessionId } = await service.start();
  await service.signal({ sessionId });
  assert.deepEqual(kills, [4242]);

  // Simulate the taskkill landing.
  getChild().emit('exit', null, 'SIGTERM');
  assert.equal(service.hasSession(), false);

  await service.start();
  await service.kill({});
  assert.equal(kills.length, 2);
  assert.equal(service.hasSession(), false);

  await service.start();
  await service.dispose();
  assert.equal(kills.length, 3);
  assert.equal(service.hasSession(), false);
});
