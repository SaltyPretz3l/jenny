'use strict';

/* WorkspacePtyService slots: up to MAX_SESSIONS (4) concurrent sessions, one
 * per renderer terminal-tab slot. Covers slot defaults/clamping, same-slot
 * reattach, the 4-session cap, sessionId routing of write/resize/kill, slot on
 * onData/onExit, slot reuse after exit, parallel dispose, kill-all on the
 * workspace root switch (kill with no sessionId), and the rootless pin.
 * Uses a fake pty module - no native ConPTY is launched. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { WorkspacePtyService, MAX_SESSIONS } = require('../services/workspace-pty-service');
const { TERMINAL_ERROR_CODES } = require('../services/backend/error-codes');

function createFakePty({ autoExit = true } = {}) {
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
    kill() {
      this.killed += 1;
      if (autoExit) this._fireExit({ exitCode: 0, signal: null });
    },
    _fireData(data) { this._dataCb && this._dataCb(data); },
    _fireExit(payload) { this._exitCb && this._exitCb(payload); },
  };
}

function createFixture({ root = 'G:/fake-root', loader, autoExit = true, terminationTimeoutMs } = {}) {
  const events = [];
  const ptys = [];
  let loads = 0;
  const service = new WorkspacePtyService({
    configService: { getToolsWorkspaceRoot: () => root },
    sendBridgeEvent: (key, payload) => events.push({ key, payload }),
    ptyModuleLoader: loader || (() => {
      loads += 1;
      return {
        spawn: () => {
          const pty = createFakePty({ autoExit });
          ptys.push(pty);
          return pty;
        },
      };
    }),
    env: { PATH: 'C:/windows' },
    terminationTimeoutMs,
  });
  return { service, events, ptys, loads: () => loads };
}

test('MAX_SESSIONS is 4', () => {
  assert.equal(MAX_SESSIONS, 4);
});

test('two slots spawn two distinct sessions and ptys', async () => {
  const { service, ptys } = createFixture();
  const a = await service.spawn({ cols: 80, rows: 24, slot: 1 });
  const b = await service.spawn({ cols: 80, rows: 24, slot: 2 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.alreadyRunning, false);
  assert.equal(b.alreadyRunning, false);
  assert.equal(a.slot, 1);
  assert.equal(b.slot, 2);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(ptys.length, 2);
  assert.equal(service.hasSession(), true);
});

test('the same slot returns alreadyRunning with the same session id', async () => {
  const { service, ptys } = createFixture();
  const first = await service.spawn({ cols: 80, rows: 24, slot: 3 });
  const again = await service.spawn({ cols: 80, rows: 24, slot: 3 });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(again.slot, 3);
  assert.equal(again.shell, first.shell);
  assert.equal(again.cwd, first.cwd);
  assert.equal(ptys.length, 1);
});

test('slot defaults and clamping: 0, 5, "x", undefined, 1.5 and "2" all mean slot 1', async () => {
  for (const slot of [0, 5, -1, 'x', undefined, null, 1.5, '2', NaN]) {
    const { service, ptys } = createFixture();
    const first = await service.spawn({ cols: 80, rows: 24, slot });
    assert.equal(first.slot, 1, `slot ${String(slot)} maps to 1`);
    const again = await service.spawn({ cols: 80, rows: 24 });
    assert.equal(again.alreadyRunning, true, `slot ${String(slot)} shares slot 1 with no-slot spawns`);
    assert.equal(again.sessionId, first.sessionId);
    assert.equal(ptys.length, 1);
  }
  const { service } = createFixture();
  assert.equal((await service.spawn()).slot, 1, 'no payload at all means slot 1');
});

test('the cap: slots 1-4 are all usable and the session map never exceeds 4', async () => {
  const { service, ptys } = createFixture();
  const ids = new Set();
  for (const slot of [1, 2, 3, 4]) {
    const result = await service.spawn({ cols: 80, rows: 24, slot });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyRunning, false);
    assert.equal(result.slot, slot);
    ids.add(result.sessionId);
  }
  assert.equal(ids.size, 4);
  assert.equal(service._sessions.size, MAX_SESSIONS);
  // Out-of-range slots fold into slot 1 (occupied), so nothing new is created.
  for (const slot of [5, 6, 99, 0]) {
    const extra = await service.spawn({ cols: 80, rows: 24, slot });
    assert.equal(extra.alreadyRunning, true);
    assert.equal(extra.slot, 1);
  }
  assert.equal(service._sessions.size, MAX_SESSIONS);
  assert.equal(ptys.length, 4);
});

test('write, resize and kill route by sessionId to the right pty', async () => {
  const { service, ptys } = createFixture();
  const a = await service.spawn({ cols: 80, rows: 24, slot: 1 });
  const b = await service.spawn({ cols: 80, rows: 24, slot: 2 });

  assert.deepEqual(await service.write({ sessionId: b.sessionId, data: 'bb' }), { ok: true, written: 2 });
  assert.deepEqual(await service.write({ sessionId: a.sessionId, data: 'a' }), { ok: true, written: 1 });
  assert.deepEqual(ptys[0].writes, ['a']);
  assert.deepEqual(ptys[1].writes, ['bb']);

  assert.deepEqual(await service.resize({ sessionId: b.sessionId, cols: 100, rows: 30 }), { ok: true });
  assert.deepEqual(ptys[0].resizes, []);
  assert.deepEqual(ptys[1].resizes, [{ cols: 100, rows: 30 }]);

  assert.deepEqual(await service.kill({ sessionId: b.sessionId }), { ok: true, killed: true, terminationConfirmed: true });
  assert.equal(ptys[0].killed, 0);
  assert.equal(ptys[1].killed, 1);
  assert.equal(service._sessions.size, 1, 'only the killed slot is freed');
  assert.equal(service._sessions.get(1)?.id, a.sessionId);

  assert.deepEqual(await service.write({ sessionId: 'pty-999', data: 'x' }), { ok: false, code: TERMINAL_ERROR_CODES.NO_SESSION });
  assert.deepEqual(await service.resize({ sessionId: 'pty-999', cols: 80, rows: 24 }), { ok: false, code: TERMINAL_ERROR_CODES.NO_SESSION });
  assert.deepEqual(await service.kill({ sessionId: 'pty-999' }), { ok: true, killed: false });
  assert.deepEqual(await service.write({ sessionId: b.sessionId, data: 'x' }), { ok: false, code: TERMINAL_ERROR_CODES.NO_SESSION }, 'a killed id is gone');
});

test('onData and onExit carry the slot and the session id', async () => {
  const { service, events, ptys } = createFixture();
  const a = await service.spawn({ cols: 80, rows: 24, slot: 2 });
  const b = await service.spawn({ cols: 80, rows: 24, slot: 4 });
  ptys[0]._fireData('hello');
  ptys[1]._fireData('world');
  await Promise.resolve();
  const data = events.filter((e) => e.key === 'workspacePty.onData').map((e) => e.payload);
  assert.deepEqual(data.find((p) => p.sessionId === a.sessionId), { sessionId: a.sessionId, slot: 2, data: 'hello' });
  assert.deepEqual(data.find((p) => p.sessionId === b.sessionId), { sessionId: b.sessionId, slot: 4, data: 'world' });

  ptys[1]._fireExit({ exitCode: 3, signal: null });
  const exits = events.filter((e) => e.key === 'workspacePty.onExit').map((e) => e.payload);
  assert.deepEqual(exits, [{ sessionId: b.sessionId, slot: 4, exitCode: 3, signal: '' }]);
});

test('an exited slot respawns fresh while other slots keep their sessions', async () => {
  const { service, ptys } = createFixture();
  const a = await service.spawn({ cols: 80, rows: 24, slot: 1 });
  const b = await service.spawn({ cols: 80, rows: 24, slot: 2 });
  ptys[0]._fireExit({ exitCode: 0, signal: null });
  assert.equal(service._sessions.has(1), false, 'exit frees the slot');
  assert.equal(service.hasSession(), true, 'slot 2 is still live');

  const fresh = await service.spawn({ cols: 80, rows: 24, slot: 1 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.alreadyRunning, false);
  assert.equal(fresh.slot, 1);
  assert.notEqual(fresh.sessionId, a.sessionId);
  assert.equal(ptys.length, 3);

  const stillB = await service.spawn({ cols: 80, rows: 24, slot: 2 });
  assert.equal(stillB.alreadyRunning, true);
  assert.equal(stillB.sessionId, b.sessionId);
});

test('dispose kills every session in parallel', async () => {
  const { service, ptys } = createFixture({ autoExit: false, terminationTimeoutMs: 5_000 });
  for (const slot of [1, 2, 3]) await service.spawn({ cols: 80, rows: 24, slot });
  const pending = service.dispose();
  // Parallel: every kill() was issued before any session exited.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(ptys.map((p) => p.killed), [1, 1, 1], 'all kills issued before any confirmation');
  for (const pty of ptys) pty._fireExit({ exitCode: 0, signal: null });
  assert.deepEqual(await pending, { disposed: true, terminationConfirmed: true });
  assert.equal(service.hasSession(), false);
});

test('dispose reports unconfirmed sessions and retains their ownership', async () => {
  const { service, ptys } = createFixture();
  const a = await service.spawn({ cols: 80, rows: 24, slot: 1 });
  const b = await service.spawn({ cols: 80, rows: 24, slot: 2 });
  ptys[1].kill = () => { throw new Error('kill boom'); };
  const result = await service.dispose();
  assert.deepEqual(result, {
    disposed: false,
    sessionId: b.sessionId,
    terminationConfirmed: false,
    code: TERMINAL_ERROR_CODES.SPAWN_FAILED,
  });
  assert.equal(ptys[0].killed, 1, 'the healthy session was still killed');
  assert.equal(service._sessions.has(1), false);
  assert.equal(service._sessions.get(2)?.id, b.sessionId);
  assert.notEqual(a.sessionId, b.sessionId);
});

test('a root switch (kill with no sessionId) kills every session', async () => {
  const { service, ptys } = createFixture();
  for (const slot of [1, 2, 4]) await service.spawn({ cols: 80, rows: 24, slot });
  const result = await service.kill({});
  assert.deepEqual(result, { ok: true, killed: true, terminationConfirmed: true });
  assert.deepEqual(ptys.map((p) => p.killed), [1, 1, 1]);
  assert.equal(service.hasSession(), false);
  assert.equal(service.isRunning(), false);
  assert.deepEqual(await service.kill({}), { ok: true, killed: false }, 'no sessions: a structured no-op');
});

test('kill-all reports failure when any session cannot be confirmed', async () => {
  const { service, ptys } = createFixture();
  await service.spawn({ cols: 80, rows: 24, slot: 1 });
  await service.spawn({ cols: 80, rows: 24, slot: 2 });
  ptys[0].kill = () => { throw new Error('kill boom'); };
  const result = await service.kill({});
  assert.deepEqual(result, {
    ok: false,
    killed: false,
    terminationConfirmed: false,
    code: TERMINAL_ERROR_CODES.SPAWN_FAILED,
  });
  assert.equal(ptys[1].killed, 1);
  assert.equal(service.hasSession(), true, 'the unconfirmed session stays owned');
});

test('a rootless spawn never calls the loader, even with a slot', async () => {
  let loaderCalls = 0;
  const { service } = createFixture({
    root: '',
    loader: () => { loaderCalls += 1; throw new Error('loader must not be invoked'); },
  });
  for (const slot of [1, 2, 4, 9, undefined]) {
    const result = await service.spawn({ cols: 80, rows: 24, slot });
    assert.equal(result.ok, false);
    assert.equal(result.code, TERMINAL_ERROR_CODES.ROOT_MISSING);
  }
  assert.equal(loaderCalls, 0);
});

test('disposed refuses a spawn on any slot', async () => {
  const { service, ptys } = createFixture();
  await service.dispose();
  const refused = await service.spawn({ cols: 80, rows: 24, slot: 2 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'disposed');
  assert.equal(ptys.length, 0);
});

test('a spawn into a slot whose session is being killed waits it out and starts a fresh shell', async () => {
  const { service, ptys } = createFixture({ autoExit: false });
  const first = await service.spawn({ cols: 80, rows: 24, slot: 2 });
  const killing = service.kill({ sessionId: first.sessionId });
  const respawn = service.spawn({ cols: 80, rows: 24, slot: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ptys.length, 1, 'no second shell while the first is still dying');
  ptys[0]._fireExit({ exitCode: 0, signal: null });
  await killing;
  const second = await respawn;
  assert.equal(second.ok, true);
  assert.equal(second.alreadyRunning, false, 'not reattached to the dead session');
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(ptys.length, 2);
});