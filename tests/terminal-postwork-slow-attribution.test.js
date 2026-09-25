'use strict';

// 2026-09-22: stream.terminal_postwork_slow named refreshSnapshots (~2.5 s)
// and refreshSessionMetadata (~1.3 s) but not the IPC call behind them, and
// main logged nothing. Sub-steps now land in the WARN's stages, and main logs
// every invoke handler slower than a second with its synchronous share.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTerminalPostworkUtils } = require('../renderer/chat/renderer-stream-handler-terminal-postwork-utils');
const { createSnapshotRefresh } = require('../renderer/shell/renderer-snapshot-refresh');
const { installIpcHandlerTiming } = require('../services/main/ipc-handler-timing');

test('a slow refresh names its slow IPC call in the postwork WARN', async () => {
  const logs = [];
  const utils = createTerminalPostworkUtils({
    state: { sessions: [{ id: 'session-1' }], messagesBySession: new Map() },
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
  });
  const refresher = createSnapshotRefresh({
    state: { backend: { phase: 'ready' }, auth: { authenticated: true } },
    getShell: () => ({
      engines: { getSettings: async () => ({}) },
      status: { get: async () => ({ model: 'm' }) },
    }),
  });

  await utils.runDeadlineStage('refreshSnapshots', 'session-1', 'stream-1',
    (stage) => refresher.refreshSnapshots({ ...stage, includeModels: false }), 5000);
  utils.reportSlowPostwork({ streamId: 'stream-1', sessionId: 'session-1' }, 2500);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'stream.terminal_postwork_slow');
  const stages = Object.keys(logs[0].details.stages).sort();
  assert.deepEqual(stages, ['refreshSnapshots', 'refreshSnapshots.getSettings', 'refreshSnapshots.statusGet']);
});

function makeIpcMain() {
  const handlers = new Map();
  return { handlers, handle(channel, listener) { handlers.set(channel, listener); } };
}

test('main logs an invoke handler slower than the threshold with its sync share', async () => {
  const ipcMain = makeIpcMain();
  const logs = [];
  let clock = 0;
  installIpcHandlerTiming(ipcMain, { log: (...entry) => logs.push(entry), now: () => clock });
  let release;
  ipcMain.handle('status:get', () => { clock += 300; return new Promise((resolve) => { release = resolve; }); });
  ipcMain.handle('engines:get-settings', () => { clock += 10; return { ok: true }; });

  const pending = ipcMain.handlers.get('status:get')({});
  clock += 1200;
  release('done');
  assert.equal(await pending, 'done');
  await Promise.resolve();
  assert.deepEqual(logs, [['WARN', 'ipc.handler_slow', { channel: 'status:get', durationMs: 1500, syncMs: 300 }]]);

  assert.deepEqual(ipcMain.handlers.get('engines:get-settings')({}), { ok: true }, 'sync results pass through');
  assert.equal(logs.length, 1);
  assert.equal(installIpcHandlerTiming(ipcMain, { log: () => {} }), false, 'installs once');
});

test('a slow synchronous failure is still reported', () => {
  const ipcMain = makeIpcMain();
  const logs = [];
  let clock = 0;
  installIpcHandlerTiming(ipcMain, { log: (...entry) => logs.push(entry), now: () => clock });
  ipcMain.handle('sessions:list', () => { clock += 2000; throw new Error('blocked then failed'); });
  assert.throws(() => ipcMain.handlers.get('sessions:list')({}), /blocked then failed/);
  assert.deepEqual(logs, [['WARN', 'ipc.handler_slow', { channel: 'sessions:list', durationMs: 2000, syncMs: 2000 }]]);
});

test('a rejected or throwing handler keeps its outcome under timing', async () => {
  const ipcMain = makeIpcMain();
  installIpcHandlerTiming(ipcMain, { log: () => { throw new Error('log sink down'); }, now: () => 0 });
  ipcMain.handle('a', async () => { throw new Error('rejected'); });
  ipcMain.handle('b', () => { throw new Error('thrown'); });
  await assert.rejects(ipcMain.handlers.get('a')({}), /rejected/);
  assert.throws(() => ipcMain.handlers.get('b')({}), /thrown/);
});
