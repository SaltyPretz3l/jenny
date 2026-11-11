'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPageHost, chromeUserAgent } = require('../services/browser-use/page-host');
const { createUrlGuard } = require('../services/browser-use/url-guard');
const { createConsentGate } = require('../services/browser-use/consent-gate');
const { createFakeElectron } = require('./helpers/fake-browser-use-electron');
const { createFakeTimers } = require('./helpers/fake-timers');

function setup(overrides = {}, electronOptions = {}) {
  const electron = createFakeElectron(electronOptions);
  const timers = createFakeTimers();
  const seen = { crashes: 0, changes: 0, activity: 0, takeOvers: [], chords: [], logs: [] };
  const state = { userHolding: false, token: 0 };
  let host = null;
  const urlGuard = createUrlGuard({
    resolveHost: (name) => host.resolveHost(name),
    reservedPorts: () => [11434],
    now: timers.now,
  });
  const consent = createConsentGate({ urlGuard, getCurrentUrl: () => host?.currentUrl() || '', now: timers.now });
  host = createPageHost({
    createView: electron.createView,
    sessionFromPartition: electron.sessionFromPartition,
    getMainWindow: electron.getMainWindow,
    randomToken: () => { state.token += 1; return `tok${state.token}`; },
    urlGuard,
    consent,
    isUserHolding: () => state.userHolding,
    onUserInput: (reason) => seen.takeOvers.push(reason),
    onActivity: () => { seen.activity += 1; },
    onCrash: () => { seen.crashes += 1; },
    onChanged: () => { seen.changes += 1; },
    forwardChord: (input) => seen.chords.push(input),
    logger: (level, event, fields) => seen.logs.push({ level, event, fields }),
    now: timers.now,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
    ...overrides,
  });
  const view = electron.lastView();
  return { host, view, wc: view.webContents, session: view.webContents.session, electron, consent, urlGuard, seen, state, timers };
}

test('each host gets its own in-memory partition with the exact hardened web preferences', () => {
  const first = setup();
  assert.equal(first.electron.viewOptions.length, 1);
  assert.deepEqual(first.electron.viewOptions[0], {
    webPreferences: {
      partition: 'jenny-browser-use-tok1',
      devTools: false,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      plugins: true,
      disableDialogs: true,
    },
  });
  assert.ok(!first.electron.viewOptions[0].webPreferences.partition.includes('persist:'));
});

test('the default token is random per host', () => {
  const { createPageHost: make } = require('../services/browser-use/page-host');
  const partitions = new Set();
  for (let i = 0; i < 3; i += 1) {
    const electron = createFakeElectron();
    const urlGuard = createUrlGuard({});
    const consent = createConsentGate({ urlGuard, getCurrentUrl: () => '' });
    make({
      createView: electron.createView, sessionFromPartition: electron.sessionFromPartition,
      getMainWindow: electron.getMainWindow, urlGuard, consent, isUserHolding: () => false,
    });
    partitions.add(electron.viewOptions[0].webPreferences.partition);
  }
  assert.equal(partitions.size, 3);
  for (const partition of partitions) assert.match(partition, /^jenny-browser-use-[0-9a-f]{16,}$/);
});

test('the user agent looks like Chrome and never says Electron or jenny', () => {
  const { session } = setup();
  assert.match(session.userAgent, /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(session.userAgent, /electron|jenny/i);
  // Plain Node has no process.versions.chrome, so the fallback major applies there.
  assert.equal(session.userAgent, chromeUserAgent(process.versions, process.platform));
});

test('chromeUserAgent follows the platform and falls back safely', () => {
  assert.equal(chromeUserAgent({ chrome: '136.0.7103.49' }, 'win32'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');
  assert.match(chromeUserAgent({ chrome: '136.0.1' }, 'darwin'), /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(chromeUserAgent({ chrome: '136.0.1' }, 'linux'), /X11; Linux x86_64/);
  assert.match(chromeUserAgent({}, 'win32'), /Chrome\/\d+\.0\.0\.0/);
  assert.doesNotMatch(chromeUserAgent({ chrome: '136.0.1' }, 'freebsd'), /electron|jenny/i);
});

test('WebRTC leaks are limited and every permission is denied', async () => {
  const { wc, session } = setup();
  assert.equal(wc.webrtcPolicy, 'disable_non_proxied_udp');
  let answered;
  session.permissionRequestHandler({}, 'media', (value) => { answered = value; });
  assert.equal(answered, false);
  assert.equal(session.permissionCheckHandler({}, 'geolocation'), false);
  assert.equal(session.devicePermissionHandler({}), false);
});

test('the view is added to the main window with bounds from the first moment', () => {
  const { view, electron, host } = setup();
  assert.deepEqual(electron.window.contentView.children, [view]);
  assert.deepEqual(view.boundsHistory[0], { x: -32000, y: 0, width: 1280, height: 800 });
  host.place({ x: 10, y: 20, width: 640, height: 480 });
  assert.deepEqual(view.bounds, { x: 10, y: 20, width: 640, height: 480 });
  host.offscreen({ width: 640, height: 480 });
  assert.deepEqual(view.bounds, { x: -32000, y: 0, width: 640, height: 480 });
  for (const bounds of view.boundsHistory) assert.ok(bounds.width > 0 && bounds.height > 0);
});

test('without a main window the host refuses to start', () => {
  assert.throws(() => setup({}, { noWindow: true }));
});

test('a download during a model step is cancelled and reported without a URL', () => {
  const { session, consent } = setup({ isModelActing: () => true });
  assert.equal(session.download('https://files.example.com/a/b.zip?token=1'), true);
  assert.deepEqual(consent.takeBlockedNavigation(), { host: 'files.example.com', reason: 'download' });
  assert.equal(session.download('not a url'), true);
  assert.deepEqual(consent.takeBlockedNavigation(), { host: '', reason: 'download' });
});

test('requests are classified by the guard, the main frame as a navigation', async () => {
  const { session } = setup();
  assert.deepEqual(await session.request({ url: 'https://example.com/', resourceType: 'mainFrame' }), {});
  assert.deepEqual(await session.request({ url: 'https://cdn.example.com/a.js', resourceType: 'script' }), {});
  assert.deepEqual(await session.request({ url: 'data:text/plain,hi', resourceType: 'image' }), {});
  assert.deepEqual(await session.request({ url: 'data:text/html,hi', resourceType: 'mainFrame' }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'file:///C:/secret.txt', resourceType: 'subFrame' }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'http://127.0.0.1:11434/api/tags', resourceType: 'xhr' }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'http://192.168.1.5/', resourceType: 'image' }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'http://localhost:3000/', resourceType: 'mainFrame' }), {});
  assert.deepEqual(session.listeners.onBeforeRequest.filter, { urls: ['<all_urls>'] });
});

test('the refuse tier also applies while the user holds the browser', async () => {
  const { session, state } = setup();
  state.userHolding = true;
  assert.deepEqual(await session.request({ url: 'http://127.0.0.1:11434/', resourceType: 'mainFrame' }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'https://example.com/', resourceType: 'mainFrame' }), {});
});

test('a page that landed on a private address is blanked once per generation and reported', () => {
  const { session, wc, consent } = setup();
  session.completed({ url: 'https://example.com/', ip: '93.184.216.34' });
  assert.equal(wc.stopCalls, 0);
  assert.equal(consent.takeWithheld(), null);

  session.completed({ url: 'https://evil.example.com/', ip: '10.0.0.5' });
  assert.equal(wc.stopCalls, 1);
  assert.equal(wc.inputEvents.length, 0);
  assert.deepEqual(wc.log.filter((entry) => entry.name === 'loadURL').map((entry) => entry.args[0]), ['about:blank']);
  assert.deepEqual(consent.takeWithheld(), { reason: 'landed_on_private_address' });

  session.redirected({ url: 'https://evil.example.com/next', ip: '192.168.0.9' });
  assert.equal(wc.stopCalls, 1, 'a second hit in the same generation does not blank again');
  assert.deepEqual(consent.takeWithheld(), { reason: 'landed_on_private_address' });

  wc.emit('did-navigate', {}, 'about:blank');
  session.redirected({ url: 'https://evil.example.com/again', ip: '10.1.1.1' });
  assert.equal(wc.stopCalls, 2);
});

test('a failed blanking load is swallowed and the page is still withheld', async () => {
  const loads = [];
  const loadURL = (url) => { loads.push(url); return Promise.reject(new Error('boom')); };
  const { session, wc, consent } = setup({}, { webContents: { loadURL } });
  session.completed({ url: 'https://evil.example.com/', ip: '10.0.0.5' });
  await new Promise(setImmediate);
  assert.deepEqual(loads, ['about:blank']);
  assert.equal(wc.stopCalls, 1);
  assert.deepEqual(consent.takeWithheld(), { reason: 'landed_on_private_address' });
});

test('a loopback page on its own loopback address is not withheld', () => {
  const { session, wc } = setup();
  session.completed({ url: 'http://localhost:3000/', ip: '127.0.0.1' });
  assert.equal(wc.stopCalls, 0);
});

test('a popup is always denied, and loaded in place only when the guard and consent allow', async () => {
  const { wc, state, consent } = setup();
  wc.state.url = 'https://example.com/start';
  assert.deepEqual(wc.windowOpenHandler({ url: 'https://example.com/next' }), { action: 'deny' });
  assert.equal(wc.log.filter((entry) => entry.name === 'loadURL').at(-1)?.args[0], 'https://example.com/next');

  const before = wc.log.filter((entry) => entry.name === 'loadURL').length;
  assert.deepEqual(wc.windowOpenHandler({ url: 'https://other-site.example.org/' }), { action: 'deny' });
  assert.equal(wc.log.filter((entry) => entry.name === 'loadURL').length, before);
  assert.equal(consent.takeBlockedNavigation()?.reason, 'new_site');

  state.userHolding = true;
  assert.deepEqual(wc.windowOpenHandler({ url: 'https://other-site.example.org/' }), { action: 'deny' });
  assert.equal(wc.log.filter((entry) => entry.name === 'loadURL').at(-1).args[0], 'https://other-site.example.org/');
  assert.equal(consent.takeBlockedNavigation(), null, 'user mode does not review');

  const loads = wc.log.filter((entry) => entry.name === 'loadURL').length;
  assert.deepEqual(wc.windowOpenHandler({ url: 'http://127.0.0.1:11434/' }), { action: 'deny' });
  assert.deepEqual(wc.windowOpenHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.equal(wc.log.filter((entry) => entry.name === 'loadURL').length, loads);
});

test('a popup load that rejects is swallowed', async () => {
  const { wc } = setup({}, { webContents: { loadURL: () => Promise.reject(new Error('boom')) } });
  wc.state.url = 'https://example.com/start';
  wc.windowOpenHandler({ url: 'https://example.com/next' });
  await new Promise(setImmediate);
});

function navEvent(url, extra = {}) {
  const event = { url, prevented: false, preventDefault() { event.prevented = true; }, ...extra };
  return event;
}

test('model mode blocks a page-started jump to a new site and records it', () => {
  const { wc, consent } = setup();
  wc.state.url = 'https://example.com/start';
  const same = navEvent('https://example.com/other');
  wc.emit('will-navigate', same);
  assert.equal(same.prevented, false);
  const jump = navEvent('https://tracker.example.net/x');
  wc.emit('will-navigate', jump);
  assert.equal(jump.prevented, true);
  assert.equal(consent.takeBlockedNavigation()?.host, 'tracker.example.net');
  const redirect = navEvent('https://tracker.example.net/y');
  wc.emit('will-redirect', redirect);
  assert.equal(redirect.prevented, true);
});

test('user mode prevents only Refuse-tier targets and does not review', () => {
  const { wc, consent, state } = setup();
  state.userHolding = true;
  wc.state.url = 'https://example.com/start';
  const fine = navEvent('https://tracker.example.net/x');
  wc.emit('will-navigate', fine);
  assert.equal(fine.prevented, false);
  const refused = navEvent('http://10.0.0.1/admin');
  wc.emit('will-navigate', refused);
  assert.equal(refused.prevented, true);
  const redirect = navEvent('http://127.0.0.1:11434/');
  wc.emit('will-redirect', redirect);
  assert.equal(redirect.prevented, true);
  assert.equal(consent.takeBlockedNavigation(), null);
});

test('sub-frame navigations are skipped and the URL may arrive as the second argument', () => {
  const { wc } = setup();
  wc.state.url = 'https://example.com/start';
  const frame = navEvent('https://tracker.example.net/x', { isMainFrame: false });
  wc.emit('will-redirect', frame);
  assert.equal(frame.prevented, false);
  const legacyFrame = navEvent(undefined);
  wc.emit('will-navigate', legacyFrame, 'https://tracker.example.net/x', false, false);
  assert.equal(legacyFrame.prevented, false);
  const legacyMain = navEvent(undefined);
  wc.emit('will-navigate', legacyMain, 'https://tracker.example.net/x', false, true);
  assert.equal(legacyMain.prevented, true);
});

test('the generation grows on a committed navigation and never on an in-page one', () => {
  const { host, wc, seen } = setup();
  assert.equal(host.getGeneration(), 1);
  wc.emit('did-navigate-in-page', {}, 'https://example.com/#a', true);
  assert.equal(host.getGeneration(), 1);
  wc.emit('did-navigate', {}, 'https://example.com/b');
  assert.equal(host.getGeneration(), 2);
  assert.equal(seen.changes, 2);
  for (const event of ['page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.emit(event, {});
  assert.equal(seen.changes, 5);
});

test('host info reports the committed address, title and loading state', () => {
  const { host, wc } = setup();
  wc.state.url = 'https://example.com/a';
  wc.state.title = 'Example';
  wc.state.loading = true;
  assert.equal(host.currentUrl(), 'https://example.com/a');
  const { url, title, loading } = host.info();
  assert.deepEqual({ url, title, loading }, { url: 'https://example.com/a', title: 'Example', loading: true });
});

test('a renderer crash is reported unless the host is being disposed', async () => {
  const { host, seen, electron, view } = setup();
  electron.crash(view);
  assert.equal(seen.crashes, 1);
  await host.dispose();
  electron.crash(view);
  assert.equal(seen.crashes, 1);
});

test('user input reaches the watch, but our own input through actionContents does not', () => {
  const { host, wc, seen } = setup();
  wc.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseMove' });
  assert.deepEqual(seen.takeOvers, []);
  assert.equal(seen.activity, 1);
  wc.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'h' });
  assert.deepEqual(seen.takeOvers, ['keyboard']);

  host.actionContents.sendInputEvent({ type: 'mouseDown', x: 1, y: 1 });
  assert.equal(wc.inputEvents.length, 1, 'the call reaches the real contents');
  wc.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown' });
  wc.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'x' });
  assert.deepEqual(seen.takeOvers, ['keyboard']);
});

test('the PDF viewer gets its shared scripts and nothing else does', async () => {
  const { session } = setup();
  const viewer = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html';
  const script = { url: 'chrome://resources/js/assert.js', resourceType: 'script' };
  assert.deepEqual(await session.request({ url: viewer, resourceType: 'subFrame' }), {});
  assert.deepEqual(await session.request({ ...script, frame: { url: viewer } }), {});
  assert.deepEqual(await session.request({ ...script, frame: { url: 'https://example.test/' } }), { cancel: true });
  assert.deepEqual(await session.request(script), { cancel: true });
  assert.deepEqual(await session.request({ url: 'chrome://settings/', resourceType: 'subFrame', frame: { url: viewer } }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/x.js', resourceType: 'script' }), { cancel: true });
});

test('typing in a password field marks the page signed in; a password field elsewhere on the page does not', async () => {
  let focusedIsPassword = false;
  const { host, wc } = setup();
  wc.executeJavaScriptInIsolatedWorld = async () => focusedIsPassword;
  const press = async (key) => {
    wc.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await press('a');
  assert.equal(host.info().signed_in, false);
  focusedIsPassword = true;
  await press('b');
  assert.equal(host.info().signed_in, true, 'a later key on the same page still counts');
  focusedIsPassword = false;
  await press('c');
  assert.equal(host.info().signed_in, true, 'it stays through what follows');
});

test('a chord from the page is prevented and handed to the app', () => {
  const { wc, seen } = setup();
  let prevented = false;
  wc.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'k', control: true });
  assert.equal(prevented, true);
  assert.equal(seen.chords.length, 1);
  assert.deepEqual(seen.takeOvers, []);
});

test('the model\'s pointer positions allow for page zoom; keys and an unzoomed page pass unchanged', () => {
  const { host, wc } = setup();
  const sent = [];
  wc.sendInputEvent = (input) => sent.push(input);
  host.actionContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 200 });
  host.zoom('in');
  host.zoom('in');
  host.actionContents.sendInputEvent({ type: 'mouseDown', x: 100, y: 200 });
  host.actionContents.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
  assert.deepEqual(sent, [{ type: 'mouseDown', x: 100, y: 200 }, { type: 'mouseDown', x: 125, y: 250 }, { type: 'keyDown', keyCode: 'a' }]);
});

test('actionContents binds methods to the real contents and passes values through', async () => {
  const { host, wc } = setup();
  wc.state.url = 'https://example.com/z';
  const { isLoading, getURL } = host.actionContents;
  assert.equal(isLoading(), false);
  assert.equal(getURL(), 'https://example.com/z');
  assert.equal(typeof host.actionContents.navigationHistory.canGoBack, 'function');
  await host.actionContents.insertText('abc');
  assert.deepEqual(wc.insertedText, ['abc']);
});

test('capture returns a JPEG data URL or a bare failure', async () => {
  const { host } = setup();
  const shot = await host.capture();
  assert.equal(shot.ok, true);
  assert.equal(shot.data_url, `data:image/jpeg;base64,${Buffer.from('jpeg-70').toString('base64')}`);
  assert.deepEqual([shot.width, shot.height], [800, 600]);
  const broken = setup({}, { webContents: { capturePage: () => Promise.reject(new Error('gone')) } });
  assert.deepEqual(await broken.host.capture(), { ok: false });
});

test('resolveHost goes through the host session', async () => {
  const { host, session } = setup();
  const answer = await host.resolveHost('example.com');
  assert.equal(answer.endpoints[0].address, '93.184.216.34');
  assert.deepEqual(session.resolved, ['example.com']);
});

test('stopLoading stops the contents and tolerates a destroyed one', async () => {
  const { host, wc } = setup();
  host.stopLoading();
  assert.equal(wc.stopCalls, 1);
  await host.dispose();
  assert.doesNotThrow(() => host.stopLoading());
});

test('dispose closes the contents, clears handlers and storage, and proves destruction', async () => {
  const { host, wc, session, electron, view } = setup();
  const proven = await host.dispose();
  assert.equal(proven, true);
  assert.equal(host.isDisposed(), true);
  assert.deepEqual(wc.closeCalls, [{ waitForBeforeUnload: false }]);
  assert.equal(wc.isDestroyed(), true);
  assert.deepEqual(electron.window.contentView.children, []);
  assert.equal(session.listeners.onBeforeRequest, null);
  assert.equal(session.listeners.onCompleted, null);
  assert.equal(session.listeners.onBeforeRedirect, null);
  assert.equal(session.permissionRequestHandler, null);
  assert.equal(session.permissionCheckHandler, null);
  assert.equal(session.devicePermissionHandler, null);
  assert.equal(session.listenerCount('will-download'), 0);
  assert.equal(session.clearedStorage, 1);
  assert.equal(view.bounds !== null, true);
  assert.equal(await host.dispose(), true, 'a second dispose reuses the first result');
  assert.equal(wc.closeCalls.length, 1);
});

test('an unproven destruction is logged and reported false after the cap', async () => {
  const { host, seen, timers, wc } = setup({}, { webContents: { autoDestroy: false } });
  const pending = host.dispose();
  await new Promise(setImmediate);
  assert.equal(wc.closeCalls.length, 1);
  timers.tick(2000);
  assert.equal(await pending, false);
  assert.ok(seen.logs.some((entry) => entry.event === 'browser_use.dispose_unproven'));
});

test('destruction is also proven by polling when no destroyed event arrives', async () => {
  const { host, timers, wc, seen } = setup({}, { webContents: { autoDestroy: false } });
  const pending = host.dispose();
  await new Promise(setImmediate);
  wc.isDestroyed = () => true;
  timers.tick(50);
  assert.equal(await pending, true);
  assert.equal(seen.logs.some((entry) => entry.event === 'browser_use.dispose_unproven'), false);
  assert.equal(timers.pending(), 0);
});

test('dispose survives storage and window failures', async () => {
  const { host, electron, session } = setup({}, { session: { clearStorageFails: true } });
  electron.window.destroy();
  assert.equal(await host.dispose(), true);
  assert.equal(session.clearedStorage, 1);
  assert.equal(electron.window.contentView.children.length, 1, 'a destroyed window is left alone');
});

test('logs carry event names and generic fields only', async () => {
  const { host, session, seen } = setup();
  session.completed({ url: 'https://secret-host.example.com/path?q=1', ip: '10.0.0.5' });
  await host.dispose();
  const text = JSON.stringify(seen.logs);
  assert.doesNotMatch(text, /secret-host|path|q=1/);
});

test('only a localhost page the user allowed may reach this machine', async () => {
  const { session, wc } = setup();
  const local = { url: 'http://127.0.0.1:1234/v1/models', resourceType: 'xhr' };
  wc.state.url = 'https://example.com/';
  assert.deepEqual(await session.request(local), { cancel: true });
  assert.deepEqual(await session.request({ url: 'http://localhost:3000/', resourceType: 'subFrame' }), { cancel: true });
  assert.deepEqual(await session.request({ url: 'https://cdn.example.com/a.js', resourceType: 'script' }), {}, 'public requests still pass');
  assert.deepEqual(await session.request({ url: 'http://localhost:3000/', resourceType: 'mainFrame' }), {}, 'navigation has its own ask');
  wc.state.url = 'http://localhost:3000/';
  assert.deepEqual(await session.request(local), {});
  assert.deepEqual(await session.request({ url: 'http://127.0.0.1:11434/api/tags', resourceType: 'xhr' }), { cancel: true }, 'a reserved port stays refused');
  wc.state.url = 'about:blank';
  assert.deepEqual(await session.request(local), { cancel: true });
  wc.getURL = () => { throw new Error('gone'); };
  assert.deepEqual(await session.request(local), { cancel: true }, 'an unreadable page fails closed');
});

test('a page is heard only while it is on screen', () => {
  const { host, wc } = setup();
  assert.equal(wc.audioMuted, true);
  host.place({ x: 1, y: 1, width: 10, height: 10 });
  assert.equal(wc.audioMuted, false);
  host.offscreen({ width: 10, height: 10 });
  assert.equal(wc.audioMuted, true);
});
