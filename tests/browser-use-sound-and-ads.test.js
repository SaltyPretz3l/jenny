'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPageHost } = require('../services/browser-use/page-host');
const { createUrlGuard } = require('../services/browser-use/url-guard');
const { createConsentGate } = require('../services/browser-use/consent-gate');
const { getBridgeChannel } = require('../services/ipc-contract');
const { registerAppSoundIpc, registerBrowserUseIpc } = require('../services/main/browser-use-ipc-registration');
const { createDesktopNotifier } = require('../services/main/desktop-notifier');
const { createReminderNotifier } = require('../services/main/reminder-notifier');
const { createBrowserUseHarness, createFakeElectron, holdEventLoop } = require('./helpers/fake-browser-use-electron');
const { createFakeTimers } = require('./helpers/fake-timers');

holdEventLoop(test);

const INACTIVITY_MS = 600000;
const BOUNDS = Object.freeze({ x: 10, y: 20, width: 640, height: 480 });
const ctx = (extra = {}) => ({
  sessionId: 'chat-a', turnId: 'turn-1', callId: 'call-1', userText: 'please open example.com', ...extra,
});
const run = (harness, input, extra) => harness.service.execute(input, ctx(extra));

async function open(harness, sessionId = 'chat-a') {
  const result = await run(harness, { action: 'navigate', url: 'https://example.com/' }, { sessionId, callId: `n-${sessionId}`, turnId: `t-${sessionId}` });
  assert.equal(result.ok, true, JSON.stringify(result));
  return harness.electron.views.at(-1);
}

async function playInBackground(harness, sessionId) {
  const view = await open(harness, sessionId);
  harness.service.show(sessionId, BOUNDS);
  view.webContents.emit('audio-state-changed', { audible: true });
  harness.service.hide(sessionId);
  return view;
}

// ---- the page host's network guard ----

function hostWithBlocker(shouldBlock) {
  const electron = createFakeElectron();
  const timers = createFakeTimers();
  const asked = [];
  let host = null;
  const urlGuard = createUrlGuard({ resolveHost: (name) => host.resolveHost(name), reservedPorts: () => [11434], now: timers.now });
  const consent = createConsentGate({ urlGuard, getCurrentUrl: () => host?.currentUrl() || '', now: timers.now });
  host = createPageHost({
    createView: electron.createView,
    sessionFromPartition: electron.sessionFromPartition,
    getMainWindow: electron.getMainWindow,
    urlGuard,
    consent,
    isUserHolding: () => false,
    adBlocker: { shouldBlock: (details) => { asked.push(details); return shouldBlock(details); }, stylesFor: () => 'ad{display:none}' },
    now: timers.now,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });
  const { webContents } = electron.lastView();
  return { host, asked, webContents, session: webContents.session };
}

test('a request the guard refused stays refused even when the blocker says no', async () => {
  const { session, asked } = hostWithBlocker(() => false);
  assert.deepEqual(await session.request({ url: 'http://192.168.1.5/', resourceType: 'image' }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'file:///C:/secret.txt', resourceType: 'subFrame' }), { cancel: true });
  assert.deepEqual(asked, [], 'a refused request is not worth asking the blocker about');
});

test('an allowed subresource the blocker matches is cancelled and the rest pass', async () => {
  const { session, asked } = hostWithBlocker((details) => details.url.includes('ads.example.net'));
  assert.deepEqual(await session.request({ url: 'https://ads.example.net/banner.js', resourceType: 'script', referrer: 'https://example.test/' }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'https://cdn.example.com/app.js', resourceType: 'script' }), {});
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[0], { url: 'https://ads.example.net/banner.js', sourceUrl: 'https://example.test/', type: 'script' });
  assert.equal(asked[1].sourceUrl, 'https://example.test/', 'no referrer falls back to the page address');
});

test('a main-frame request is never asked about, even for an ad address', async () => {
  const { session, asked } = hostWithBlocker(() => true);
  assert.deepEqual(await session.request({ url: 'https://ads.example.net/', resourceType: 'mainFrame' }), {});
  assert.deepEqual(asked, []);
});

test('the filter stops asking once ad blocking is off, and a new document gets its hiding rules', async () => {
  const { host, session, asked, webContents } = hostWithBlocker(() => true);
  const css = [];
  webContents.insertCSS = (sheet, options) => { css.push({ sheet, options }); return Promise.resolve('key'); };
  webContents.emit('dom-ready');
  assert.deepEqual(css, [{ sheet: 'ad{display:none}', options: { cssOrigin: 'user' } }]);
  assert.equal(host.setAdBlock(false, 'user'), true);
  assert.deepEqual(await session.request({ url: 'https://ads.example.net/banner.js', resourceType: 'script' }), {});
  webContents.emit('dom-ready');
  assert.equal(css.length, 1);
  assert.deepEqual(asked, []);
});

// ---- the service ----

test('the ad_block action turns blocking off, reloads, and says it was the model', async () => {
  const harness = createBrowserUseHarness();
  const { webContents } = await open(harness);
  const reloads = () => webContents.log.filter((entry) => entry.name === 'reload').length;
  assert.deepEqual([harness.service.getState('chat-a').ad_block, harness.service.getState('chat-a').ad_block_by], [true, '']);
  const off = await run(harness, { action: 'ad_block', enabled: false });
  assert.deepEqual([off.ok, off.status], [true, 'ad_block_off']);
  assert.match(off.message, /off for this chat.*reloaded.*user can see/);
  assert.equal(reloads(), 1);
  assert.deepEqual([harness.service.getState('chat-a').ad_block, harness.service.getState('chat-a').ad_block_by], [false, 'model']);
  const again = await run(harness, { action: 'ad_block', enabled: false });
  assert.deepEqual([again.ok, again.status, again.message], [true, 'ad_block_off', 'Ad blocking was already set that way, so nothing changed.']);
  assert.equal(reloads(), 1);
  const on = await run(harness, { action: 'ad_block', enabled: true });
  assert.deepEqual([on.ok, on.status], [true, 'ad_block_on']);
  assert.match(on.message, /on for this chat.*reloaded/);
  assert.equal(reloads(), 2);
  assert.deepEqual([harness.service.getState('chat-a').ad_block, harness.service.getState('chat-a').ad_block_by], [true, '']);
});

test('ad_block already on says nothing changed and does not reload', async () => {
  const harness = createBrowserUseHarness();
  const { webContents } = await open(harness);
  const same = await run(harness, { action: 'ad_block', enabled: true });
  assert.deepEqual([same.ok, same.status, same.message], [true, 'ad_block_on', 'Ad blocking was already set that way, so nothing changed.']);
  assert.equal(webContents.log.filter((entry) => entry.name === 'reload').length, 0);
});

test('ad_block without a true or false enabled is an invalid argument', async () => {
  const harness = createBrowserUseHarness();
  await open(harness);
  for (const extra of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { enabled: undefined }]) {
    const result = await run(harness, { action: 'ad_block', ...extra });
    assert.deepEqual([result.ok, result.status, result.message], [false, 'invalid_arguments', 'ad_block needs enabled set to true or false.'], JSON.stringify(extra));
  }
  assert.equal(harness.service.getState('chat-a').ad_block, true);
});

test('ad_block with no page open answers no_page', async () => {
  const harness = createBrowserUseHarness();
  const result = await run(harness, { action: 'ad_block', enabled: false });
  assert.deepEqual([result.ok, result.status, result.message], [false, 'no_page', 'No page is open. Use navigate to open one.']);
  assert.equal(harness.electron.views.length, 0);
});

test('ad_block is refused while the user holds the page', async () => {
  const harness = createBrowserUseHarness();
  const { webContents } = await open(harness);
  harness.service.takeOver('chat-a');
  const result = await run(harness, { action: 'ad_block', enabled: false });
  assert.deepEqual([result.ok, result.status], [false, 'refused']);
  assert.match(result.message, /user has the browser right now/);
  assert.equal(harness.service.getState('chat-a').ad_block, true);
  assert.equal(webContents.log.filter((entry) => entry.name === 'reload').length, 0);
});

test('the user toggling ad blocking is recorded as the user', async () => {
  const harness = createBrowserUseHarness();
  await open(harness);
  assert.deepEqual(harness.service.setAdBlock('chat-a', false), { ok: true, changed: true });
  assert.equal(harness.service.getState('chat-a').ad_block_by, 'user');
  assert.deepEqual(harness.service.setAdBlock('chat-a', false), { ok: true, changed: false });
  assert.deepEqual(harness.service.setAdBlock('chat-a', true), { ok: true, changed: true });
  assert.equal(harness.service.getState('chat-a').ad_block_by, '');
});

test('toggleSound and setAdBlock for a chat with no page answer no_page', () => {
  const harness = createBrowserUseHarness();
  assert.deepEqual(harness.service.toggleSound('nobody'), { ok: false, reason: 'no_page' });
  assert.deepEqual(harness.service.setAdBlock('nobody', false), { ok: false, reason: 'no_page' });
});

test('toggleSound mutes the chat page and the state says so', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness);
  harness.service.show('chat-a', BOUNDS);
  view.webContents.emit('audio-state-changed', { audible: true });
  assert.equal(harness.service.getState('chat-a').sound, 'playing');
  assert.deepEqual(harness.service.toggleSound('chat-a'), { ok: true });
  assert.equal(harness.service.getState('chat-a').sound, 'muted');
  assert.equal(view.webContents.audioMuted, true);
  assert.equal(harness.events.at(-1).payload.sound, 'muted');
});

test('a page that is playing survives the idle close; a silent one does not', async () => {
  const harness = createBrowserUseHarness();
  const view = await playInBackground(harness, 'chat-a');
  assert.equal(harness.service.getState('chat-a').sound, 'playing');
  harness.timers.tick(INACTIVITY_MS);
  harness.timers.tick(INACTIVITY_MS);
  assert.equal(harness.service.getState('chat-a').open, true, 'sound keeps it open');
  view.webContents.emit('audio-state-changed', { audible: false });
  harness.timers.tick(2500 + 30000);
  assert.equal(harness.service.getState('chat-a').sound, null);
  harness.timers.tick(INACTIVITY_MS);
  assert.equal(harness.service.getState('chat-a').open, false, 'once it is quiet the idle close takes it');
});

test('eviction spares a page that is playing and takes a silent parked one', async () => {
  const control = createBrowserUseHarness();
  await open(control, 'chat-b');
  control.timers.tick(10);
  await open(control, 'chat-a');
  control.timers.tick(10);
  assert.equal((await open(control, 'chat-c')).webContents.isDestroyed(), false);
  assert.equal(control.service.getState('chat-b').open, false, 'the older silent page is the one that goes');

  const harness = createBrowserUseHarness();
  await playInBackground(harness, 'chat-b');
  harness.timers.tick(10);
  await open(harness, 'chat-a');
  harness.timers.tick(10);
  assert.equal((await open(harness, 'chat-c')).webContents.isDestroyed(), false);
  assert.equal(harness.service.getState('chat-b').open, true, 'older, but it is playing');
  assert.equal(harness.service.getState('chat-a').open, false, 'the silent one was closed instead');
});

test('onChatSound is told the sound on change and null when the page goes', async () => {
  const calls = [];
  const harness = createBrowserUseHarness({ onChatSound: (sessionId, sound) => calls.push([sessionId, sound]) });
  const view = await open(harness);
  harness.service.show('chat-a', BOUNDS);
  view.webContents.emit('audio-state-changed', { audible: true });
  assert.deepEqual(calls.at(-1), ['chat-a', 'playing']);
  harness.service.toggleSound('chat-a');
  assert.deepEqual(calls.at(-1), ['chat-a', 'muted']);
  await harness.service.close('chat-a');
  assert.deepEqual(calls.at(-1), ['chat-a', null]);
});

test('applyAppMute reaches every page', async () => {
  const app = { muted: false };
  const harness = createBrowserUseHarness({ isAppMuted: () => app.muted });
  const first = await open(harness, 'chat-a');
  const second = await open(harness, 'chat-b');
  harness.service.show('chat-a', BOUNDS);
  harness.service.show('chat-b', BOUNDS);
  assert.deepEqual([first.webContents.audioMuted, second.webContents.audioMuted], [false, false]);
  app.muted = true;
  harness.service.applyAppMute();
  assert.deepEqual([first.webContents.audioMuted, second.webContents.audioMuted], [true, true]);
  app.muted = false;
  harness.service.applyAppMute();
  assert.deepEqual([first.webContents.audioMuted, second.webContents.audioMuted], [false, false]);
});

test('read tells the model what is playing, and says nothing when nothing is', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness);
  const reads = () => view.webContents.readerCalls.filter((call) => call.op === 'read');
  await run(harness, { action: 'read' }, { callId: 'r1', turnId: 't-r1' });
  assert.equal(Object.hasOwn(reads().at(-1).args, 'sound'), false);
  harness.service.show('chat-a', BOUNDS);
  view.webContents.emit('audio-state-changed', { audible: true });
  await run(harness, { action: 'read', scope: 'full' }, { callId: 'r2', turnId: 't-r2' });
  assert.equal(reads().at(-1).args.sound, 'playing');
  assert.equal(reads().at(-1).args.scope, 'full');
  harness.service.toggleSound('chat-a');
  await run(harness, { action: 'navigate', url: 'https://example.com/next' }, { callId: 'r3', turnId: 't-r3' });
  assert.equal(reads().at(-1).args.sound, 'muted', 'the read after a step carries it too');
});

// ---- IPC ----

function ipcFixture(service, { enabled = true } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const authorization = { authorize: (event) => event.trusted === true };
  registerBrowserUseIpc(ipcMain, { getService: () => service, authorization, isEnabled: () => enabled });
  const holder = { muted: false, soundState: () => ({ muted: holder.muted, audible: false, chats: {} }), setAppMuted(value) { holder.muted = value; return holder.soundState(); } };
  registerAppSoundIpc(ipcMain, { getHolder: () => holder, authorization });
  const call = (method, payload, event = { trusted: true }) => handlers.get(getBridgeChannel(method))(event, payload);
  return { call, holder };
}

test('browserUse.setAdBlock takes exactly a chat id and a boolean', async () => {
  const calls = [];
  const service = { setAdBlock: (...args) => { calls.push(args); return { ok: true, changed: true }; }, toggleSound: (...args) => { calls.push(['toggle', ...args]); return { ok: true }; } };
  const { call } = ipcFixture(service);
  const invalid = { ok: false, reason: 'invalid_payload' };
  for (const payload of [undefined, 'chat-a', { session_id: 'chat-a' }, { session_id: 'chat-a', enabled: 'true' }, { session_id: 'chat-a', enabled: 1 },
    { session_id: 'chat-a', enabled: null }, { session_id: 'chat-a', enabled: true, extra: 1 }, { enabled: true }, { session_id: '../x', enabled: true }]) {
    assert.deepEqual(await call('browserUse.setAdBlock', payload), invalid, JSON.stringify(payload));
  }
  assert.deepEqual(await call('browserUse.toggleSound', { session_id: 'chat-a', extra: 1 }), invalid);
  assert.deepEqual(calls, []);
  assert.deepEqual(await call('browserUse.setAdBlock', { session_id: 'chat-a', enabled: false }), { ok: true, changed: true });
  assert.deepEqual(await call('browserUse.toggleSound', { session_id: 'chat-a' }), { ok: true });
  assert.deepEqual(calls, [['chat-a', false], ['toggle', 'chat-a']]);
  assert.equal((await call('browserUse.setAdBlock', { session_id: 'chat-a', enabled: true }, {})).authorized, false);
  assert.equal(calls.length, 2, 'an untrusted sender reaches nothing');
});

test('appSound.setMuted rejects anything but exactly one boolean', async () => {
  const { call, holder } = ipcFixture({});
  for (const payload of [undefined, null, true, 'true', {}, { muted: 'true' }, { muted: 1 }, { muted: null }, { muted: true, extra: 1 }, []]) {
    assert.deepEqual(await call('appSound.setMuted', payload), { ok: false, reason: 'invalid_payload' }, JSON.stringify(payload));
  }
  assert.equal(holder.muted, false);
  assert.deepEqual(await call('appSound.setMuted', { muted: true }), { ok: true, muted: true, audible: false, chats: {} });
  assert.equal(holder.muted, true);
});

test('appSound.getState works with the browser flag off', async () => {
  const { call } = ipcFixture({}, { enabled: false });
  assert.deepEqual(await call('browserUse.getState', { session_id: 'chat-a' }), { ok: false, reason: 'browser_unavailable' });
  assert.deepEqual(await call('appSound.getState'), { ok: true, muted: false, audible: false, chats: {} });
  assert.deepEqual(await call('appSound.setMuted', { muted: true }), { ok: true, muted: true, audible: false, chats: {} });
});

test('appSound with no holder says the browser is unavailable', async () => {
  const handlers = new Map();
  registerAppSoundIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, { getHolder: () => null, authorization: { authorize: () => true } });
  assert.deepEqual(await handlers.get(getBridgeChannel('appSound.getState'))({}), { ok: false, reason: 'browser_unavailable' });
  assert.deepEqual(await handlers.get(getBridgeChannel('appSound.setMuted'))({}, { muted: true }), { ok: false, reason: 'browser_unavailable' });
});

// ---- notifiers ----

const REMINDER_NOW = new Date(2026, 8, 15, 10, 0).getTime();

function reminderToastSilent({ sound, appMuted }) {
  const shown = [];
  const reminder = {
    id: 'reminder-1', label: 'Stretch', prompt: 'Stand up.', scheduleType: 'once_at', dailyAt: '', intervalMinutes: 0,
    onceAt: '2026-09-15T10:00', enabled: true, createdAt: new Date(2026, 8, 15, 9, 0).toISOString(), lastFiredAt: '',
  };
  const shell = new EventEmitter();
  shell.getState = () => ({ proactive: { reminders: [{ ...reminder }] } });
  shell.upsertReminder = () => {};
  shell.getWindowUiState = () => ({ appZoomPercent: 100, notifications: { sound } });
  const notifier = createReminderNotifier({
    isAppMuted: appMuted === undefined ? undefined : () => appMuted,
    getShellConfigService: () => shell,
    getMainWindow: () => ({ isDestroyed: () => false, isMinimized: () => false, focus() {} }),
    notificationFactory(options) { shown.push(options); return { on() {}, show() {} }; },
    isSupported: () => true,
    sendBridgeEvent: () => {},
    log: () => {},
    now: () => REMINDER_NOW,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  notifier.tick();
  assert.equal(shown.length, 1);
  return shown[0].silent;
}

test('the reminder toast is silent while the app is muted, even with sound on', () => {
  assert.equal(reminderToastSilent({ sound: true, appMuted: true }), true);
  assert.equal(reminderToastSilent({ sound: true, appMuted: false }), false);
  assert.equal(reminderToastSilent({ sound: true }), false, 'no mute hook means not muted');
  assert.equal(reminderToastSilent({ sound: false, appMuted: false }), true);
});

function desktopToastSilent({ sound, appMuted }) {
  const shown = [];
  const window = new EventEmitter();
  Object.assign(window, {
    isVisible: () => true, isFocused: () => false, isMinimized: () => false, isDestroyed: () => false, restore() {}, focus() {},
  });
  const notifier = createDesktopNotifier({
    isAppMuted: appMuted === undefined ? undefined : () => appMuted,
    getShellConfigService: () => ({ getWindowUiState: () => ({ appZoomPercent: 100, notifications: { onlyWhenUnfocused: true, sound } }), getChatUiState: () => ({}) }),
    isPrimarySession: () => false,
    isChildSession: () => false,
    now: () => REMINDER_NOW,
    getMainWindow: () => window,
    notificationFactory(options) { shown.push(options); return { on() {}, show() {}, close() {} }; },
    isSupported: () => true,
    sendBridgeEvent: () => {},
    log: () => {},
    isEnabled: () => true,
    ipcMainLike: { on() {}, removeListener() {} },
    authorizeSender: () => true,
  });
  assert.equal(notifier.notify({ category: 'replies', key: 'turn-1', sessionId: 'session-1', title: 'Reply ready', body: 'Trip planning' }), true);
  assert.equal(shown.length, 1);
  return shown[0].silent;
}

test('the desktop toast is silent while the app is muted, even with sound on', () => {
  assert.equal(desktopToastSilent({ sound: true, appMuted: true }), true);
  assert.equal(desktopToastSilent({ sound: true, appMuted: false }), false);
  assert.equal(desktopToastSilent({ sound: true }), false, 'no mute hook means not muted');
  assert.equal(desktopToastSilent({ sound: false, appMuted: false }), true);
});

test('a page crash keeps the ad setting and the chat mute', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness);
  harness.service.show('chat-a', BOUNDS);
  harness.service.setAdBlock('chat-a', false);
  harness.service.toggleSound('chat-a');
  harness.electron.crash(view);
  const state = harness.service.getState('chat-a');
  assert.deepEqual([state.ad_block, state.ad_block_by, state.sound], [false, 'user', 'muted']);
  assert.notEqual(harness.electron.views.at(-1), view);
});

test('ad_block is a step, so a loop of flips hits the limit', async () => {
  const harness = createBrowserUseHarness({ maxStepsPerTurn: 1 });
  const { webContents } = await open(harness);
  assert.equal((await run(harness, { action: 'ad_block', enabled: false })).ok, true);
  const reloads = webContents.log.filter((entry) => entry.name === 'reload').length;
  const over = await run(harness, { action: 'ad_block', enabled: true });
  assert.equal(over.status, 'step_limit');
  assert.equal(webContents.log.filter((entry) => entry.name === 'reload').length, reloads);
});
