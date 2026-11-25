'use strict';
// new-test-file: the computer tool's owner controls in main (row 196 C4/C6): the bridge, the frame and pill, the block reason

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerComputerUseIpc, nameFromPath } = require('../services/main/computer-use-ipc-registration');
const { computerBlockReason } = require('../services/backend/computer-use-tool-gate');
const { createTurnOverlay, pillView, PILL_RESUME, PILL_STOP, PILL_SIZE, PILL_STATE } = require('../services/computer-use/turn-overlay');
const { PILL_DIR, createLazyComputerUse, createPillAuthorizer, createPillSpots } = require('../services/main/computer-use-composition');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getBridgeChannel } = require('../services/ipc-contract');
const pill = require('../renderer/computer-pill/pill');

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => { if (handlers.has(channel)) throw new Error(`twice ${channel}`); handlers.set(channel, fn); },
    removeHandler: (channel) => handlers.delete(channel),
    call: (method, payload, event = {}) => handlers.get(getBridgeChannel(method, 'invoke'))(event, payload),
  };
}

function backend({ flag = true, safetyMode = 'normal', sandbox = false, engine = 'ollama', computer, sessions = ['chat'], hostMode } = {}) {
  return {
    hostMode,
    featureFlags: { tools_computer_use_enabled: flag },
    currentEngineType: engine,
    sessionStore: { peekSession: (id) => (sessions.includes(id) ? { id } : null) },
    configService: {
      getChatUiState: () => ({ safetyMode }),
      getState: () => ({ commandSandbox: { enabled: sandbox }, tools: computer === undefined ? {} : { computer } }),
    },
  };
}

function setup({ service = null, programs = null, platform = 'win32', backendOptions = {}, dialog = null } = {}) {
  const ipc = fakeIpc();
  const pushes = [];
  let listener = null;
  const store = programs || memoryPrograms();
  const holder = {
    peek: () => service,
    ownerPrograms: () => store,
    subscribeTurnState: (fn) => { listener = fn; return () => { listener = null; }; },
  };
  const service_ = backend(backendOptions);
  const result = registerComputerUseIpc(ipc, {
    getHolder: () => holder, getBackendService: () => service_, dialog, platform,
    sendBridgeEvent: (method, payload) => pushes.push([method, payload]),
    authorization: { authorize: () => true },
    isHostedServer: () => service_.hostMode === 'server',
  });
  return { ipc, pushes, store, result, emit: (state) => listener?.(state) };
}

function memoryPrograms(initial = []) {
  const items = [...initial];
  return {
    items,
    list: async () => items.map((item) => ({ ...item })),
    add: async (entry) => {
      if (!entry?.name || !/\.exe$/i.test(entry.program)) return { ok: false, reason: 'invalid' };
      const index = items.findIndex((item) => item.program.toLowerCase() === entry.program.toLowerCase());
      if (index >= 0) items[index] = { ...entry }; else items.push({ ...entry });
      return { ok: true };
    },
    remove: async (program) => {
      const index = items.findIndex((item) => item.program.toLowerCase() === String(program).toLowerCase());
      if (index < 0) return false;
      items.splice(index, 1);
      return true;
    },
  };
}

function fakeService() {
  const grants = new Map([['chat', [{ program: 'C:\\Games\\game.exe', name: 'Game', kind: 'grantable' }, { program: 'C:\\Apps\\view.exe', name: 'Viewer', kind: 'view_only' }]]]);
  const calls = [];
  return {
    calls,
    grants: (id) => grants.get(id) || [],
    revoke: (id, program) => { calls.push(['revoke', id, program]); return true; },
    resume: async (id) => { calls.push(['resume', id]); return { ok: true, held: true }; },
    stop: (id) => { calls.push(['stop', id]); return { ok: true, held: false }; },
    stopChordRegistered: () => true,
  };
}

test('the block reason follows the turn gate: platform, switch, safety, sandbox, engine', () => {
  assert.equal(computerBlockReason(backend(), { platform: 'win32' }), null);
  assert.equal(computerBlockReason(backend(), { platform: 'darwin' }), 'not_windows');
  assert.equal(computerBlockReason(backend({ flag: false }), { platform: 'win32' }), 'disabled');
  assert.equal(computerBlockReason(backend({ computer: false }), { platform: 'win32' }), 'disabled', 'the Settings switch');
  assert.equal(computerBlockReason(backend({ computer: true }), { platform: 'win32' }), null);
  assert.equal(computerBlockReason(backend({ safetyMode: 'strict' }), { platform: 'win32' }), 'strict_safety');
  assert.equal(computerBlockReason(backend({ sandbox: true }), { platform: 'win32' }), 'sandbox');
  assert.equal(computerBlockReason(backend({ engine: 'chatgpt' }), { platform: 'win32' }), 'engine_not_local');
  assert.equal(computerBlockReason({}, { platform: 'win32' }), 'disabled', 'nothing readable fails closed');
});

test('status reads the gate and the Stop key without starting the service', async () => {
  const off = setup();
  assert.deepEqual(await off.ipc.call('computerUse.status'), { ok: true, available: true, reason: null, stopChord: 'Ctrl+Alt+Shift+F12', stopChordRegistered: null });
  const on = setup({ service: fakeService(), backendOptions: { sandbox: true } });
  assert.deepEqual(await on.ipc.call('computerUse.status'), { ok: true, available: false, reason: 'sandbox', stopChord: 'Ctrl+Alt+Shift+F12', stopChordRegistered: true });
  const hosted = setup({ backendOptions: { hostMode: 'server' } });
  assert.equal((await hosted.ipc.call('computerUse.status')).reason, 'disabled');
});

test('grants, revoke, resume and stop need a chat that exists and touch only its own grants', async () => {
  const service = fakeService();
  const { ipc } = setup({ service });
  assert.deepEqual(await ipc.call('computerUse.grants', { sessionId: 'chat' }), { ok: true, grants: [
    { name: 'Game', path: 'C:\\Games\\game.exe', viewOnly: false }, { name: 'Viewer', path: 'C:\\Apps\\view.exe', viewOnly: true }] });
  for (const payload of [null, {}, { sessionId: 'nobody' }, { sessionId: 'x'.repeat(201) }, ['chat']]) {
    assert.deepEqual(await ipc.call('computerUse.grants', payload), { ok: false, reason: 'bad_request' });
    assert.deepEqual(await ipc.call('computerUse.resume', payload), { ok: false, reason: 'bad_request' });
  }
  assert.deepEqual(await ipc.call('computerUse.revoke', { sessionId: 'chat', path: 'C:\\Windows\\other.exe' }), { ok: true, revoked: false });
  assert.deepEqual(await ipc.call('computerUse.revoke', { sessionId: 'chat', path: 'C:\\Games\\game.exe' }), { ok: true, revoked: true });
  assert.deepEqual(await ipc.call('computerUse.resume', { sessionId: 'chat' }), { ok: true, held: true });
  assert.deepEqual(await ipc.call('computerUse.stop', { sessionId: 'chat' }), { ok: true, held: false });
  assert.deepEqual(service.calls, [['revoke', 'chat', 'C:\\Games\\game.exe'], ['resume', 'chat'], ['stop', 'chat']]);

  const idle = setup();
  assert.deepEqual(await idle.ipc.call('computerUse.grants', { sessionId: 'chat' }), { ok: true, grants: [] });
  assert.deepEqual(await idle.ipc.call('computerUse.resume', { sessionId: 'chat' }), { ok: true, held: false });
});

test('the program list: main picks the file, rename only an entry that is there, remove', async () => {
  const picks = [];
  const dialog = { showOpenDialog: async (...args) => { picks.push(args); return { canceled: false, filePaths: ['D:\\Games\\Space Game\\SpaceGame.exe'] }; } };
  const { ipc, store } = setup({ dialog });
  assert.deepEqual(await ipc.call('computerUse.addProgram', { path: 'C:\\evil.exe' }), { ok: true, program: { name: 'SpaceGame', path: 'D:\\Games\\Space Game\\SpaceGame.exe' } });
  assert.deepEqual(picks[0][0].filters, [{ name: 'Programs', extensions: ['exe'] }], 'the renderer never names the path');
  assert.deepEqual(await ipc.call('computerUse.listPrograms'), { ok: true, programs: [{ name: 'SpaceGame', path: 'D:\\Games\\Space Game\\SpaceGame.exe' }] });
  assert.deepEqual(await ipc.call('computerUse.renameProgram', { path: 'd:\\games\\space game\\spacegame.exe', name: 'Space' }), { ok: true });
  assert.equal(store.items[0].name, 'Space');
  assert.deepEqual(await ipc.call('computerUse.renameProgram', { path: 'C:\\new.exe', name: 'New' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await ipc.call('computerUse.renameProgram', { path: 'C:\\new.exe' }), { ok: false, reason: 'bad_request' });
  assert.deepEqual(await ipc.call('computerUse.removeProgram', { path: 'D:\\Games\\Space Game\\SpaceGame.exe' }), { ok: true, removed: true });
  assert.deepEqual(await ipc.call('computerUse.removeProgram', { path: 'D:\\Games\\Space Game\\SpaceGame.exe' }), { ok: true, removed: false });

  const cancelled = setup({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.deepEqual(await cancelled.ipc.call('computerUse.addProgram'), { ok: false, reason: 'cancelled' });
  const mac = setup({ dialog, platform: 'darwin' });
  assert.deepEqual(await mac.ipc.call('computerUse.addProgram'), { ok: false, reason: 'unsupported_platform' });
  assert.equal(nameFromPath('C:\\a\\b\\Tool.EXE'), 'Tool');
});

test('turn states reach the renderer without the screen point, and the status is pushed when the Stop key is known', async () => {
  const service = fakeService();
  const { pushes, emit } = setup({ service });
  emit({ sessionId: 'chat', state: 'step', action: 'click', programName: 'Game', screenPoint: { x: 1, y: 2 } });
  emit({ sessionId: 'chat', state: 'bogus' });
  emit({ sessionId: 'chat', state: 'idle', action: '', programName: '' });
  assert.deepEqual(pushes.filter(([method]) => method === 'computerUse.onTurnState').map(([, payload]) => payload), [
    { sessionId: 'chat', state: 'step', action: 'click', programName: 'Game' },
    { sessionId: 'chat', state: 'idle', action: '', programName: '' },
  ]);
  const statuses = pushes.filter(([method]) => method === 'computerUse.onStatus');
  assert.equal(statuses.length, 1, 'once, when the registration became known');
  assert.equal(statuses[0][1].stopChordRegistered, true);
});

// ---- the frame and the pill ---------------------------------------------------------------

function fakeElectron() {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.calls = [];
      this.destroyed = false;
      this.sent = [];
      const contents = new EventEmitter();
      contents.send = (channel, payload) => this.sent.push([channel, payload]);
      contents.setWindowOpenHandler = () => {};
      this.webContents = contents;
      windows.push(this);
    }
    setAlwaysOnTop(...args) { this.calls.push(['setAlwaysOnTop', ...args]); }
    setContentProtection(value) { this.calls.push(['setContentProtection', value]); }
    setIgnoreMouseEvents(value) { this.calls.push(['setIgnoreMouseEvents', value]); }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    loadFile(page) { this.page = page; setImmediate(() => this.webContents.emit('did-finish-load')); return Promise.resolve(); }
    showInactive() { this.shown = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, workArea: { x: 1920, y: 0, width: 1280, height: 984 } },
  ];
  const screen = {
    getDisplayNearestPoint: (point) => (point.x >= 1920 ? displays[1] : displays[0]),
    getPrimaryDisplay: () => displays[0],
  };
  return { BrowserWindow, screen, windows, ipcMain: fakeIpc() };
}

function overlaySetup(extra = {}) {
  const electron = fakeElectron();
  const answers = [];
  const spots = new Map();
  const overlay = createTurnOverlay({
    BrowserWindow: electron.BrowserWindow, screen: electron.screen, ipcMain: electron.ipcMain,
    pillPage: 'pill.html', framePage: 'frame.html', preload: 'preload.js',
    authorizeSender: (event, getWindow) => event.sender === getWindow()?.webContents,
    onResume: (id) => { answers.push(['resume', id]); return { ok: true, held: true }; },
    onStop: (id) => { answers.push(['stop', id]); return { ok: true, held: true }; },
    positions: { get: (id) => spots.get(id) || null, set: (id, spot) => spots.set(id, spot) },
    ...extra,
  });
  return { electron, overlay, answers, spots };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the frame and pill appear on the first state, click-through and out of every capture, and go at idle', async () => {
  const { electron, overlay } = overlaySetup();
  overlay.update({ sessionId: 'chat', state: 'idle' });
  assert.equal(electron.windows.length, 0, 'idle before any call creates nothing');
  overlay.update({ sessionId: 'chat', state: 'step', action: 'click', programName: 'Game', screenPoint: { x: 500, y: 500 } });
  const [frame, pillWindow] = electron.windows;
  assert.equal(electron.windows.length, 2);
  for (const win of [frame, pillWindow]) {
    assert.deepEqual(win.calls.filter((call) => call[0] === 'setContentProtection'), [['setContentProtection', true]]);
    assert.deepEqual([win.options.frame, win.options.transparent, win.options.alwaysOnTop, win.options.focusable], [false, true, true, false]);
    assert.deepEqual([win.options.webPreferences.sandbox, win.options.webPreferences.contextIsolation, win.options.webPreferences.nodeIntegration], [true, true, false]);
  }
  assert.deepEqual(frame.calls.filter((call) => call[0] === 'setIgnoreMouseEvents'), [['setIgnoreMouseEvents', true]]);
  assert.deepEqual(frame.bounds, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(pillWindow.bounds.y, 16, 'top-right, never top centre');
  assert.equal(pillWindow.bounds.x + pillWindow.bounds.width, 1920 - 16);
  await flush();
  assert.equal(pillWindow.shown, true);
  assert.equal(pillWindow.sent.at(-1)[0], PILL_STATE);
  assert.equal(pillWindow.sent.at(-1)[1].text, 'Clicking in Game');

  overlay.update({ sessionId: 'other', state: 'idle' });
  assert.equal(frame.destroyed, false, 'another chat going idle leaves this one');
  overlay.update({ sessionId: 'chat', state: 'idle' });
  assert.deepEqual([frame.destroyed, pillWindow.destroyed, overlay.isShown()], [true, true, false]);
  overlay.update({ sessionId: 'chat', state: 'thinking' });
  assert.equal(electron.windows.length, 4, 'a new turn makes new windows');
  overlay.dispose();
  assert.deepEqual([electron.windows[2].destroyed, electron.windows[3].destroyed], [true, true]);
  assert.equal(electron.ipcMain.handlers.size, 0, 'shutdown takes the handlers away');
});

test('the pill answers only from its own window, for the chat it shows, and fits its text', async () => {
  const { electron, overlay, answers } = overlaySetup();
  overlay.update({ sessionId: 'chat', state: 'paused', programName: 'Game', screenPoint: { x: 10, y: 10 } });
  const pillWindow = electron.windows[1];
  const handler = (channel) => electron.ipcMain.handlers.get(channel);
  assert.deepEqual(await handler(PILL_RESUME)({ sender: {} }), { ok: false }, 'not the pill');
  assert.deepEqual(await handler(PILL_RESUME)({ sender: pillWindow.webContents }, { sessionId: 'evil' }), { ok: true, held: true });
  assert.deepEqual(await handler(PILL_STOP)({ sender: pillWindow.webContents }), { ok: true, held: true });
  assert.deepEqual(answers, [['resume', 'chat'], ['stop', 'chat']], 'the chat id comes from main');
  const right = pillWindow.bounds.x + pillWindow.bounds.width;
  await handler(PILL_SIZE)({ sender: pillWindow.webContents }, { width: 420, height: 38 });
  assert.deepEqual([pillWindow.bounds.width, pillWindow.bounds.height, pillWindow.bounds.x + pillWindow.bounds.width], [420, 38, right], 'grows to the left');
  await handler(PILL_SIZE)({ sender: pillWindow.webContents }, { width: 99999, height: 'x' });
  assert.equal(pillWindow.bounds.width, 420, 'a bad size is ignored');
  await handler(PILL_SIZE)({ sender: pillWindow.webContents }, { width: 99999, height: 999 });
  assert.deepEqual([pillWindow.bounds.width, pillWindow.bounds.height], [560, 64], 'clamped');
});

test('the pill remembers its spot per screen and moves with the window to another screen', async () => {
  const { electron, overlay, spots } = overlaySetup();
  overlay.update({ sessionId: 'chat', state: 'thinking', screenPoint: { x: 10, y: 10 } });
  const [frame, pillWindow] = electron.windows;
  pillWindow.setBounds({ x: 40, y: 900, width: 300, height: 40 });
  pillWindow.emit('moved');
  assert.deepEqual(spots.get('1'), { x: 40, y: 900 });
  overlay.update({ sessionId: 'chat', state: 'step', action: 'type', programName: 'Game', screenPoint: { x: 2000, y: 10 } });
  assert.deepEqual(frame.bounds, { x: 1920, y: 0, width: 1280, height: 1024 });
  assert.equal(pillWindow.bounds.x + pillWindow.bounds.width, 1920 + 1280 - 16, 'the corner of the second screen');
  assert.equal(spots.has('2'), false, 'our own move is not saved as the owner\'s spot');
  overlay.dispose();

  const again = overlaySetup();
  again.spots.set('1', { x: 40, y: 900 });
  again.overlay.update({ sessionId: 'chat', state: 'thinking', screenPoint: null });
  assert.deepEqual([again.electron.windows[1].bounds.x, again.electron.windows[1].bounds.y], [40, 900]);
  again.spots.set('1', { x: 5000, y: 10 });
  again.overlay.update({ sessionId: 'chat', state: 'idle' });
  again.overlay.update({ sessionId: 'chat', state: 'thinking', screenPoint: null });
  assert.equal(again.electron.windows[3].bounds.y, 16, 'a spot that no longer fits falls back to the corner');
});

test('the pill words: each state, the program, and the Stop key hint', () => {
  const t = (_key, english, params) => english.replace(/\{(\w+)\}/g, (m, k) => params?.[k] ?? m);
  assert.deepEqual(pillView({ state: 'thinking' }, true, t), { paused: false, dot: 'active', text: 'Thinking', keyHint: 'Ctrl+Alt+Shift+F12', resumeLabel: 'Resume', stopLabel: 'Stop' });
  assert.equal(pillView({ state: 'step', action: 'type', programName: 'Paint' }, null, t).text, 'Typing in Paint');
  assert.equal(pillView({ state: 'step', action: 'screenshot', programName: 'Paint' }, null, t).text, 'Looking at Paint');
  assert.equal(pillView({ state: 'step', action: 'open', programName: 'Paint' }, null, t).text, 'Opening Paint');
  assert.equal(pillView({ state: 'step', action: 'click', programName: '' }, null, t).text, 'Thinking');
  const paused = pillView({ state: 'paused', programName: 'Paint' }, false, t);
  assert.deepEqual([paused.paused, paused.dot, paused.text, paused.keyHint], [true, 'warn', 'Paused: you have control', 'Stop key not available: use Stop']);
});

test('the pill page draws main\'s words and sends Resume and Stop', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="cuPill"><span id="cuPillDot"></span><span id="cuPillText"></span><span id="cuPillKey"></span></div><div id="cuFrame"></div>');
  const doc = dom.window.document;
  const calls = [];
  let push = null;
  const bridge = { onState: (fn) => { push = fn; return () => {}; }, resume: async () => calls.push('resume'), stop: async () => calls.push('stop'), size: async () => calls.push('size') };
  pill.mount(doc, bridge, require('../renderer/inventory/action-button'));
  assert.equal(doc.getElementById('cuPillResume').hidden, true);
  push({ paused: true, dot: 'warn', text: 'Paused: you have control', keyHint: 'Ctrl+Alt+Shift+F12', resumeLabel: 'Resume', stopLabel: 'Stop' });
  assert.equal(doc.getElementById('cuPillText').textContent, 'Paused: you have control');
  assert.equal(doc.getElementById('cuPillDot').className, 'status-dot status-dot--warn');
  assert.equal(doc.getElementById('cuPillResume').hidden, false);
  assert.equal(doc.getElementById('cuFrame').classList.contains('cu-frame--paused'), true);
  doc.getElementById('cuPillResume').click();
  doc.getElementById('cuPillStop').click();
  await flush();
  assert.deepEqual(calls.filter((call) => call !== 'size'), ['resume', 'stop']);
  push({ paused: false, dot: 'active', text: '<b>x</b>', keyHint: '', resumeLabel: 'Resume', stopLabel: 'Stop' });
  assert.equal(doc.getElementById('cuPillText').textContent, '<b>x</b>', 'text, never markup');
  assert.equal(doc.getElementById('cuPillResume').hidden, true);
});

test('the holder fans turn states out to the overlay and listeners, and its pill spots survive a bad file', async () => {
  const updates = [];
  const disposed = [];
  const holder = createLazyComputerUse({
    getRunView: () => ({ helperHost: () => ({ request: async () => ({}), on() {}, removeListener() {} }) }), userDataPath: 'C:\\data', log: () => {},
    electron: { app: { getAppMetrics: () => [] }, shell: { readShortcutLink: () => ({}), openPath: async () => '' } },
    processRef: { pid: 1, execPath: 'C:\\Jenny\\Jenny.exe' },
    createOverlay: () => ({ update: (state) => updates.push(state.state), dispose: () => disposed.push(true) }),
  });
  const seen = [];
  const unsubscribe = holder.subscribeTurnState((state) => seen.push(state.state));
  assert.equal(holder.ownerPrograms(), holder.ownerPrograms(), 'one program store');
  const service = holder.get();
  assert.deepEqual([typeof service.resume, typeof service.stop, typeof service.stopChordRegistered], ['function', 'function', 'function']);
  await service.execute({ action: 'screenshot' }, { sessionId: 's1', turnId: 't1', callId: 'c1' });
  await holder.onTurnEnd('s1');
  assert.deepEqual(seen, ['step', 'thinking', 'idle']);
  assert.deepEqual(updates, [], 'no frame or pill before a program window is in front');
  unsubscribe();
  await holder.dispose();
  assert.equal(disposed.length, 0, 'nothing to close when it never opened');

  const fs = { readFileSync: () => '{not json' };
  const spots = createPillSpots({ filePath: 'x.json', fs, log: () => {} });
  assert.equal(spots.get('1'), null);
});

test('the real pill authorizer accepts only the pill window\'s own top frame on the pill page', () => {
  const page = path.join(PILL_DIR, 'pill.html');
  const url = pathToFileURL(page).href;
  const mainFrame = { url };
  const contents = { mainFrame, getURL: () => url, isDestroyed: () => false };
  const pillWindow = { webContents: contents, isDestroyed: () => false };
  const authorize = createPillAuthorizer();
  assert.equal(authorize({ sender: contents, senderFrame: mainFrame }, () => pillWindow, page), true);
  assert.equal(authorize({ sender: contents, senderFrame: { url } }, () => pillWindow, page), false, 'a sub-frame');
  assert.equal(authorize({ sender: { ...contents }, senderFrame: mainFrame }, () => pillWindow, page), false, 'another window');
  assert.equal(authorize({ sender: contents, senderFrame: mainFrame }, () => null, page), false, 'no pill');
  const elsewhere = pathToFileURL(path.join(PILL_DIR, 'frame.html')).href;
  const moved = { mainFrame: { url: elsewhere }, getURL: () => elsewhere, isDestroyed: () => false };
  assert.equal(authorize({ sender: moved, senderFrame: moved.mainFrame }, () => ({ webContents: moved, isDestroyed: () => false }), page), false, 'not the pill page');
});

test('one chat drives the overlay; the window centre is turned into screen units; the spot is saved on the pill\'s own screen', () => {
  const { electron, overlay, spots } = overlaySetup();
  const asked = [];
  electron.screen.screenToDipPoint = (point) => { asked.push(point); return { x: point.x / 2, y: point.y / 2 }; };
  electron.screen.getDisplayMatching = (bounds) => (bounds.x >= 1920
    ? { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 984 } } : { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } });
  overlay.update({ sessionId: 'a', state: 'paused', programName: 'Game', screenPoint: { x: 3000, y: 100 } });
  assert.deepEqual(asked, [{ x: 3000, y: 100 }]);
  const [frame, pillWindow] = electron.windows;
  assert.deepEqual(frame.bounds, { x: 0, y: 0, width: 1920, height: 1080 }, '3000 physical is 1500 in screen units: the first screen');
  overlay.update({ sessionId: 'b', state: 'step', action: 'click', programName: 'Paint', screenPoint: { x: 10, y: 10 } });
  assert.ok(!pillWindow.sent.some(([, view]) => view?.text === 'Clicking in Paint'), 'another chat does not take the pill');
  overlay.update({ sessionId: 'b', state: 'idle' });
  assert.equal(pillWindow.destroyed, false, 'nor close it');
  pillWindow.setBounds({ x: 2000, y: 50, width: 300, height: 40 });
  pillWindow.emit('moved');
  assert.deepEqual(spots.get('2'), { x: 80, y: 50 });
  assert.equal(spots.has('1'), false);
  overlay.dispose();
});

test('the pill preload exposes only Resume, Stop, its size and the state push, on the overlay\'s channels', async () => {
  const Module = require('node:module');
  const captured = { api: null, invokes: [], listeners: [] };
  const originalLoad = Module._load;
  const resolved = require.resolve('../services/main/computer-pill-preload');
  delete require.cache[resolved];
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { captured.api = { name, api }; } },
        ipcRenderer: {
          invoke: async (channel, ...args) => { captured.invokes.push([channel, args]); return { ok: true }; },
          on: (channel, listener) => captured.listeners.push([channel, listener]),
          removeListener: (channel, listener) => captured.listeners.push([channel, listener, 'removed']),
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require('../services/main/computer-pill-preload'); // electron is the stub above
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
  const { name, api } = captured.api;
  assert.equal(name, 'jennyComputerPill');
  assert.deepEqual(Object.keys(api).sort(), ['onState', 'resume', 'size', 'stop']);
  assert.equal(Object.isFrozen(api), true);
  await api.resume('chat-from-the-page');
  await api.stop();
  await api.size('300', 40);
  assert.deepEqual(captured.invokes, [[PILL_RESUME, []], [PILL_STOP, []], [PILL_SIZE, [{ width: 300, height: 40 }]]], 'no chat id leaves the page');
  const seen = [];
  const off = api.onState((view) => seen.push(view));
  assert.equal(captured.listeners[0][0], PILL_STATE);
  captured.listeners[0][1]({}, { text: 'Thinking' });
  assert.deepEqual(seen, [{ text: 'Thinking' }]);
  off();
  assert.equal(captured.listeners[1][2], 'removed');
  assert.equal(typeof api.onState('not a function'), 'function');
});
