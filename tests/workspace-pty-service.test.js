'use strict';

/* WorkspacePtyService: real ConPTY terminal behind the default-OFF
 * `workspace_pty_terminal` flag. Structured-result contracts (never throws
 * across the IPC seam), the never-load-native-code-when-gated pin (flag OFF
 * or rootless spawn must not call the pty module loader), spawn shape (cwd,
 * scrubbed env, clamped cols/rows), single-session policy, write/resize/kill
 * plumbing to the IPty handle, byte-capped onData / onExit bridge events,
 * MODULE_LOAD_FAILED fail-soft, and the powershell->cmd fixture fallback.
 * Uses a fake pty module - no native ConPTY is launched. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { WorkspacePtyService } = require('../services/workspace-pty-service');
const { TERMINAL_ERROR_CODES } = require('../services/backend/error-codes');

function createFakePty() {
  return {
    writes: [],
    resizes: [],
    killed: 0,
    _dataCb: null,
    _exitCb: null,
    onData(cb) { this._dataCb = cb; },
    onExit(cb) { this._exitCb = cb; },
    write(text) { this.writes.push(text); },
    resize(cols, rows) { this.resizes.push({ cols, rows }); },
    kill() { this.killed += 1; this._fireExit({ exitCode: 0, signal: null }); },
    // Test-only trigger helpers.
    _fireData(data) { this._dataCb && this._dataCb(data); },
    _fireExit(payload) { this._exitCb && this._exitCb(payload); },
  };
}

function createFixture({
  root = 'G:/fake-root',
  flag = true,
  ptyModuleLoader,
  scheduleOutputFlush,
  setTimeoutImpl,
  clearTimeoutImpl,
  terminationTimeoutMs,
} = {}) {
  const spawns = [];
  const events = [];
  const logs = [];
  const ptys = [];
  let enabled = flag;
  const loader = ptyModuleLoader || (() => ({
    spawn: (shell, args, opts) => {
      spawns.push({ shell, args, opts });
      const pty = createFakePty();
      ptys.push(pty);
      return pty;
    },
  }));
  const service = new WorkspacePtyService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_pty_terminal: enabled }),
    sendBridgeEvent: (key, payload) => events.push({ key, payload }),
    ptyModuleLoader: loader,
    env: {
      PATH: 'C:/windows',
      JENNY_ENABLE_FOO: '1',
      MY_API_KEY: 'sk-leakme',
      EDITOR: 'vim',
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    scheduleOutputFlush,
    setTimeoutImpl,
    clearTimeoutImpl,
    terminationTimeoutMs,
  });
  return {
    service, spawns, events, logs, ptys,
    lastPty: () => ptys[ptys.length - 1],
    setFlag: (value) => { enabled = value; },
  };
}

const THROWING_LOADER = () => {
  throw new Error('loader must not be invoked');
};

// 1. flag-off spawn -> {available:false} and loader never invoked.
test('spawn is gated: flag off returns available:false without loading native code', async () => {
  const { service, spawns } = createFixture({ flag: false, ptyModuleLoader: THROWING_LOADER });
  const result = await service.spawn({ cols: 80, rows: 24 });
  assert.deepEqual(result, { available: false });
  assert.equal(spawns.length, 0);
});

// 2. flag-off write/resize/kill -> {available:false}, loader never invoked.
test('write/resize/kill are gated when flag off', async () => {
  const { service } = createFixture({ flag: false, ptyModuleLoader: THROWING_LOADER });
  assert.deepEqual(await service.write({ sessionId: 'pty-1', data: 'x' }), { available: false });
  assert.deepEqual(await service.resize({ sessionId: 'pty-1', cols: 80, rows: 24 }), { available: false });
  assert.deepEqual(await service.kill({ sessionId: 'pty-1' }), { available: false });
});

// 3. flag-on, null root -> ok:false ROOT_MISSING, loader never invoked (root before load).
test('spawn with no workspace root returns ROOT_MISSING before loading native code', async () => {
  const { service } = createFixture({ root: '', ptyModuleLoader: THROWING_LOADER });
  const result = await service.spawn({ cols: 80, rows: 24 });
  assert.equal(result.ok, false);
  assert.equal(result.available, true);
  assert.equal(result.code, TERMINAL_ERROR_CODES.ROOT_MISSING);
  assert.match(result.message, /workspace root/i);
});

// 4. spawn shape: cwd, scrubbed env, clamped cols/rows.
test('spawn shape: cwd is root, env scrubbed, cols/rows forwarded and clamped', async () => {
  const { service, spawns } = createFixture();
  const result = await service.spawn({ cols: 99999, rows: 40 });
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.cwd, 'G:/fake-root');
  assert.equal(spawns.length, 1);
  const { opts } = spawns[0];
  assert.equal(opts.cwd, 'G:/fake-root');
  assert.equal(opts.env.PATH, 'C:/windows', 'system keys kept');
  assert.equal(opts.env.EDITOR, 'vim', 'benign keys kept');
  assert.equal(opts.env.JENNY_ENABLE_FOO, undefined, 'JENNY_* scrubbed');
  assert.equal(opts.env.MY_API_KEY, undefined, 'credential-shaped keys scrubbed');
  assert.equal(opts.cols, 500, 'cols clamped to max 500');
  assert.equal(opts.rows, 40);
});

// 5. single-session: second spawn -> alreadyRunning, same id, no re-spawn.
test('single-session policy: second spawn reuses the live session', async () => {
  const { service, spawns } = createFixture();
  const first = await service.spawn({ cols: 80, rows: 24 });
  const again = await service.spawn({ cols: 80, rows: 24 });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(spawns.length, 1);
});

// 6. write/resize/kill plumbing; wrong id -> NO_SESSION; write cap.
test('write/resize/kill reach the handle; wrong id rejects; write is capped', async () => {
  const { service, lastPty } = createFixture();
  const { sessionId } = await service.spawn({ cols: 80, rows: 24 });
  const pty = lastPty();

  const w = await service.write({ sessionId, data: 'dir\r\n' });
  assert.deepEqual(w, { ok: true, written: 5 });
  assert.deepEqual(pty.writes, ['dir\r\n']);

  const r = await service.resize({ sessionId, cols: 120, rows: 30 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(pty.resizes, [{ cols: 120, rows: 30 }]);

  const bad = await service.write({ sessionId: 'pty-999', data: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, TERMINAL_ERROR_CODES.NO_SESSION);

  const badResize = await service.resize({ sessionId: 'pty-999', cols: 80, rows: 24 });
  assert.equal(badResize.ok, false);
  assert.equal(badResize.code, TERMINAL_ERROR_CODES.NO_SESSION);

  const big = 'y'.repeat(100 * 1024);
  const capped = await service.write({ sessionId, data: big });
  assert.equal(capped.written, 16 * 1024, 'write capped to 16KiB');
  assert.equal(pty.writes[pty.writes.length - 1].length, 16 * 1024);

  const k = await service.kill({ sessionId });
  assert.deepEqual(k, { ok: true, killed: true, terminationConfirmed: true });
  assert.equal(pty.killed, 1);
  assert.equal(service.hasSession(), false);
});

test('multibyte terminal input is capped to 16 KiB of complete UTF-8 code points', async () => {
  const { service, lastPty } = createFixture();
  const { sessionId } = await service.spawn({ cols: 80, rows: 24 });
  const result = await service.write({ sessionId, data: '😀'.repeat(16 * 1024) });
  const written = lastPty().writes[0];

  assert.equal(result.written, 16 * 1024);
  assert.equal(Buffer.byteLength(written, 'utf8'), 16 * 1024);
  assert.equal(written, '😀'.repeat(4096));
});

test('wide-036: wiring failure kills and confirms the spawned PTY before returning a typed failure', async () => {
  const pty = createFakePty();
  pty.onData = () => { throw new Error('listener registration failed'); };
  const { service, logs } = createFixture({
    ptyModuleLoader: () => ({ spawn: () => pty }),
  });
  const result = await service.spawn({ cols: 80, rows: 24 });
  assert.equal(result.ok, false);
  assert.equal(result.code, TERMINAL_ERROR_CODES.SPAWN_FAILED);
  assert.equal(result.terminationConfirmed, true);
  assert.equal(pty.killed, 1);
  assert.equal(service.hasSession(), false);
  assert.ok(logs.some((entry) => entry.event === 'workspace_pty.wire_failed'));
});

test('wide-036: unobservable PTY wiring failure is bounded and retains ownership', async () => {
  let fireDeadline = null;
  const pty = createFakePty();
  pty.onExit = () => { throw new Error('exit registration failed'); };
  pty.kill = function kill() { this.killed += 1; };
  const { service } = createFixture({
    ptyModuleLoader: () => ({ spawn: () => pty }),
    setTimeoutImpl: (callback) => { fireDeadline = callback; return 1; },
    clearTimeoutImpl: () => {},
    terminationTimeoutMs: 50,
  });
  const pending = service.spawn({ cols: 80, rows: 24 });
  await Promise.resolve();
  assert.equal(typeof fireDeadline, 'function');
  fireDeadline();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.terminationConfirmed, false);
  assert.equal(pty.killed, 1);
  assert.equal(service.hasSession(), true, 'the service retains an unconfirmed native handle');
});

test('wide-036: dispose latches shutdown and refuses a later PTY spawn', async () => {
  const { service, spawns } = createFixture();
  assert.deepEqual(await service.dispose(), { disposed: true, terminationConfirmed: true });
  const refused = await service.spawn({ cols: 80, rows: 24 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, TERMINAL_ERROR_CODES.NO_SESSION);
  assert.equal(refused.reason, 'disposed');
  assert.equal(spawns.length, 0);
});

test('wide-036: a live session remains writable and killable after the feature flag flips off', async () => {
  const { service, lastPty, setFlag } = createFixture();
  const { sessionId } = await service.spawn({ cols: 80, rows: 24 });
  setFlag(false);
  assert.deepEqual(await service.write({ sessionId, data: 'x' }), { ok: true, written: 1 });
  assert.deepEqual(await service.resize({ sessionId, cols: 90, rows: 30 }), { ok: true });
  assert.deepEqual(await service.kill({ sessionId }), {
    ok: true, killed: true, terminationConfirmed: true,
  });
  assert.equal(lastPty().killed, 1);
  assert.equal(service.hasSession(), false);
  assert.deepEqual(await service.spawn({}), { available: false }, 'the flag still gates creation');
});

test('wide-036: a native kill throw retains ownership and reports observable failure', async () => {
  const { service, lastPty, logs } = createFixture();
  const { sessionId } = await service.spawn({ cols: 80, rows: 24 });
  lastPty().kill = () => { throw new Error('native kill failed'); };
  const result = await service.kill({ sessionId });
  assert.equal(result.ok, false);
  assert.equal(result.killed, false);
  assert.equal(result.terminationConfirmed, false);
  assert.equal(result.code, TERMINAL_ERROR_CODES.SPAWN_FAILED);
  assert.equal(service.hasSession(), true, 'ownership remains until exit or confirmed termination');
  assert.ok(logs.some((entry) => entry.event === 'workspace_pty.kill_failed'));
});

// 7. MODULE_LOAD_FAILED: throwing loader -> ok:false 0004, WARN logged, no throw.
test('module load failure fails soft with MODULE_LOAD_FAILED and a WARN log', async () => {
  const { service, logs } = createFixture({
    ptyModuleLoader: () => { throw new Error('electron abi mismatch'); },
  });
  const result = await service.spawn({ cols: 80, rows: 24 });
  assert.equal(result.ok, false);
  assert.equal(result.available, true);
  assert.equal(result.code, TERMINAL_ERROR_CODES.MODULE_LOAD_FAILED);
  assert.equal(result.code, 'CMP-TERMINAL-0004');
  const warn = logs.find((l) => l.level === 'WARN' && /module_load_failed/.test(l.event));
  assert.ok(warn, 'a WARN module_load_failed log was emitted');
});

// 8. data events byte-capped, event name + payload shape.
test('onData is byte-capped to a 64KiB tail and forwarded over the bridge', async () => {
  const { service, events, lastPty } = createFixture();
  const { sessionId } = await service.spawn({ cols: 80, rows: 24 });
  lastPty()._fireData('x'.repeat(100 * 1024));
  await Promise.resolve();
  const dataEvents = events.filter((e) => e.key === 'workspacePty.onData');
  assert.equal(dataEvents.length, 1);
  assert.equal(dataEvents[0].payload.sessionId, sessionId);
  assert.equal(dataEvents[0].payload.data.length, 64 * 1024, 'per-event tail cap');
});

// 9. exit event -> payload shape, registry cleared, next spawn is a new session.
test('onExit forwards payload, clears the registry, and lets a new session start', async () => {
  const { service, events, lastPty } = createFixture();
  const first = await service.spawn({ cols: 80, rows: 24 });
  lastPty()._fireExit({ exitCode: 0, signal: null });
  const exitEvents = events.filter((e) => e.key === 'workspacePty.onExit');
  assert.deepEqual(exitEvents[0].payload, { sessionId: first.sessionId, exitCode: 0, signal: '' });
  assert.equal(service.hasSession(), false);

  const second = await service.spawn({ cols: 80, rows: 24 });
  assert.notEqual(second.sessionId, first.sessionId, 'a fresh session id after exit');
});

// 10. dispose(): kills the handle, clears state, never throws.
test('dispose reports unconfirmed termination and retains ownership when native kill throws', async () => {
  const { service, lastPty } = createFixture();
  const { sessionId } = await service.spawn({ cols: 80, rows: 24 });
  const pty = lastPty();
  pty.kill = () => { throw new Error('kill boom'); };
  const result = await service.dispose();
  assert.deepEqual(result, {
    disposed: false,
    sessionId,
    terminationConfirmed: false,
    code: TERMINAL_ERROR_CODES.SPAWN_FAILED,
  });
  assert.equal(service.hasSession(), true);
});

test('wide-036: PTY output bursts coalesce into one bounded bridge delivery', async () => {
  let flush = null;
  const { service, events, lastPty } = createFixture({
    scheduleOutputFlush: (callback) => { flush = callback; return callback; },
  });
  await service.spawn({ cols: 80, rows: 24 });
  for (let index = 0; index < 200; index += 1) lastPty()._fireData(`row-${index}\n`);
  assert.equal(events.filter((entry) => entry.key === 'workspacePty.onData').length, 0);
  flush();
  const data = events.filter((entry) => entry.key === 'workspacePty.onData');
  assert.equal(data.length, 1);
  assert.match(data[0].payload.data, /row-199/);
  assert.ok(data[0].payload.data.length <= 64 * 1024);
});

// 11. powershell throws -> cmd.exe fallback attempted.
test('spawn falls back to cmd.exe when powershell.exe throws (win32 path)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('win32-only shell fallback');
    return;
  }
  const spawns = [];
  const service = new WorkspacePtyService({
    configService: { getToolsWorkspaceRoot: () => 'G:/fake-root' },
    featureFlagProvider: () => ({ workspace_pty_terminal: true }),
    sendBridgeEvent: () => {},
    ptyModuleLoader: () => ({
      spawn: (shell, args, opts) => {
        spawns.push({ shell, args });
        if (shell === 'powershell.exe') {
          throw new Error('powershell not found');
        }
        return createFakePty();
      },
    }),
    env: { PATH: 'C:/windows' },
  });
  const result = await service.spawn({ cols: 80, rows: 24 });
  assert.equal(result.ok, true);
  assert.equal(result.shell, 'cmd.exe');
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0].shell, 'powershell.exe');
  assert.equal(spawns[1].shell, 'cmd.exe');
});

// Bonus: both shells throw -> SPAWN_FAILED, WARN logged, no throw.
test('spawn returns SPAWN_FAILED when every shell candidate throws', async () => {
  const { service, logs } = createFixture({
    ptyModuleLoader: () => ({ spawn: () => { throw new Error('no shell'); } }),
  });
  const result = await service.spawn({ cols: 80, rows: 24 });
  assert.equal(result.ok, false);
  assert.equal(result.available, true);
  assert.equal(result.code, TERMINAL_ERROR_CODES.SPAWN_FAILED);
  const warn = logs.find((l) => l.level === 'WARN');
  assert.ok(warn, 'a WARN spawn-failure log was emitted');
});
