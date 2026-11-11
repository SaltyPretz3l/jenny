'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { addressToUrl, buildContextMenu } = require('../services/browser-use/user-controls');
const { createBrowserUseHarness, holdEventLoop } = require('./helpers/fake-browser-use-electron');

holdEventLoop(test);

const ctx = (extra = {}) => ({ sessionId: 'chat-a', turnId: 'turn-1', callId: 'call-1', userText: 'please open example.com', ...extra });

async function openPage(harness, extra) {
  const result = await harness.service.execute({ action: 'navigate', url: 'https://example.com/' }, ctx(extra));
  assert.equal(result.ok, true, JSON.stringify(result));
  return harness.electron.views.at(-1).webContents;
}

function byHand(overrides = {}) {
  return createBrowserUseHarness({ canOpenByHand: () => true, getRunningTurnId: () => '', ...overrides });
}

const key = (wc, input) => {
  const event = { prevented: false, preventDefault() { event.prevented = true; } };
  wc.emit('before-input-event', event, { type: 'keyDown', ...input });
  return event;
};

test('the address bar turns what was typed into a URL or says why not', () => {
  assert.deepEqual(addressToUrl('example.com/a?b=1'), { url: 'https://example.com/a?b=1' });
  assert.deepEqual(addressToUrl('  HTTP://example.com '), { url: 'http://example.com/' });
  assert.deepEqual(addressToUrl('localhost:3000/x'), { url: 'http://localhost:3000/x' });
  assert.deepEqual(addressToUrl('127.0.0.1:18440'), { url: 'http://127.0.0.1:18440/' });
  assert.deepEqual(addressToUrl('example.com:8443/a'), { url: 'https://example.com:8443/a' });
  for (const text of ['', 'cats', 'two words.com', 'x'.repeat(5000)]) assert.deepEqual(addressToUrl(text), { problem: 'not_address' }, text.slice(0, 10));
  for (const text of ['javascript:alert(1)', 'file:///C:/a.txt', 'mailto:a@b.co', 'chrome://settings']) assert.deepEqual(addressToUrl(text), { problem: 'not_web' }, text);
});

test('the right-click menu only offers what applies', () => {
  const labels = { back: 'B', reload: 'R', cut: 'X', copy: 'C', paste: 'V', selectAll: 'A', copyLink: 'L', copyImage: 'I' };
  const page = { canGoBack: () => false, back() {}, reload() {}, copyImageAt() {} };
  const plain = buildContextMenu({ editFlags: { canCopy: false } }, { labels, page });
  assert.deepEqual(plain.filter((item) => item.label).map((item) => item.label), ['B', 'R', 'C', 'A']);
  assert.equal(plain[0].enabled, false);
  const written = [];
  const rich = buildContextMenu({ isEditable: true, linkURL: 'https://a.example/x', mediaType: 'image', editFlags: { canCopy: true, canCut: true, canPaste: true } }, { labels, page, writeClipboard: (text) => written.push(text) });
  assert.deepEqual(rich.filter((item) => item.label).map((item) => item.label), ['B', 'R', 'X', 'C', 'V', 'A', 'L', 'I']);
  rich.find((item) => item.label === 'L').click();
  assert.deepEqual(written, ['https://a.example/x']);
});

test('a typed address on an idle page is the user\'s, so a redirect is neither judged nor reported as the model\'s', async () => {
  const harness = byHand();
  const wc = await openPage(harness);
  assert.deepEqual(harness.service.navigate('chat-a', { url: 'bit.ly/x' }), { ok: true });
  const state = harness.service.getState('chat-a');
  assert.equal(state.mode, 'model', 'nothing was taken over: no turn is running');
  assert.equal(state.user_touched, true);
  const redirect = { preventDefault() { redirect.prevented = true; }, url: 'https://elsewhere.example/landing', isMainFrame: true };
  wc.emit('will-redirect', redirect);
  assert.equal(redirect.prevented, undefined);
  const next = await harness.service.execute({ action: 'read' }, ctx({ turnId: 'turn-2', callId: 'call-2' }));
  assert.equal(next.blockedNavigation, undefined);
  assert.equal(harness.service.getState('chat-a').user_touched, false, 'a model step clears it');
});

test('going somewhere during a turn takes the page, before the load starts', async () => {
  const harness = byHand({ getRunningTurnId: () => 'turn-1' });
  await openPage(harness);
  assert.equal(harness.service.navigate('chat-a', { op: 'reload' }).ok, true);
  assert.equal(harness.service.getState('chat-a').mode, 'user');
});

test('a refused or unusable address loads nothing and says why', async () => {
  const harness = byHand();
  const wc = await openPage(harness);
  const loads = () => wc.log.filter(({ name }) => name === 'loadURL').length;
  const before = loads();
  assert.deepEqual(harness.service.navigate('chat-a', { url: 'cats' }), { ok: false, reason: 'not_address' });
  assert.deepEqual(harness.service.navigate('chat-a', { url: 'javascript:alert(1)' }), { ok: false, reason: 'not_web' });
  assert.deepEqual(harness.service.navigate('chat-a', { url: 'http://192.168.1.5/' }), { ok: false, reason: 'private_address' });
  assert.equal(loads(), before);
  assert.equal(harness.service.getState('chat-a').user_touched, false);
});

test('opening a page by hand needs the feature to be on for that chat', () => {
  const blocked = createBrowserUseHarness({ canOpenByHand: () => false });
  assert.deepEqual(blocked.service.navigate('chat-a', { url: 'example.com' }), { ok: false, reason: 'browser_unavailable' });
  assert.equal(blocked.electron.views.length, 0);
  const allowed = byHand();
  assert.deepEqual(allowed.service.navigate('chat-a', { url: 'example.com' }), { ok: true });
  assert.equal(allowed.electron.views.length, 1);
});

test('a load that really failed is reported; a stopped one and a subframe are not; the next navigation clears it', async () => {
  const harness = byHand();
  const wc = await openPage(harness);
  const failed = () => harness.service.getState('chat-a').failed;
  wc.emit('did-fail-load', {}, -3, 'aborted', 'https://gone.example/', true);
  wc.emit('did-fail-load', {}, -20, 'blocked', 'https://gone.example/', true);
  wc.emit('did-fail-load', {}, -105, 'dns', 'https://ad.example/', false);
  assert.equal(failed(), '');
  wc.emit('did-fail-load', {}, -105, 'dns', 'https://gone.example/', true);
  assert.equal(failed(), 'https://gone.example/');
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://x.example/' });
  assert.equal(failed(), '');
});

test('a refused link and a refused permission leave a note the next navigation clears', async () => {
  const harness = byHand();
  const wc = await openPage(harness);
  const blocked = { preventDefault() { blocked.prevented = true; }, url: 'http://192.168.1.9/', isMainFrame: true };
  wc.emit('will-navigate', blocked);
  assert.equal(blocked.prevented, true);
  assert.deepEqual(harness.service.getState('chat-a').note, { kind: 'blocked_network', host: '' });
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://x.example/' });
  assert.equal(harness.service.getState('chat-a').note, null);
  const { session } = wc;
  let answer = null;
  session.permissionRequestHandler(wc, 'geolocation', (granted) => { answer = granted; });
  assert.equal(answer, false);
  assert.deepEqual(harness.service.getState('chat-a').note, { kind: 'permission', what: 'location' });
});

test('clipboard write is allowed only while the user is on the page', async () => {
  const harness = byHand({ getRunningTurnId: () => 'turn-1' });
  const wc = await openPage(harness);
  const asked = (permission) => { let answer = null; wc.session.permissionRequestHandler(wc, permission, (granted) => { answer = granted; }); return answer; };
  assert.equal(asked('clipboard-sanitized-write'), false);
  harness.service.takeOver('chat-a');
  assert.equal(asked('clipboard-sanitized-write'), true);
  assert.equal(asked('clipboard-read'), false);
  assert.equal(asked('media'), false);
});

function downloadItem(url, savePath) {
  const item = new EventEmitter();
  item.getURL = () => url;
  item.getSavePath = () => savePath;
  return item;
}

test('a download by hand goes through the Save dialog and the model never hears of it', async () => {
  const harness = byHand({ getRunningTurnId: () => 'turn-1' });
  const wc = await openPage(harness);
  harness.service.takeOver('chat-a');
  const event = { preventDefault() { event.prevented = true; } };
  const item = downloadItem('https://files.example/a.zip', 'C:\\Users\\me\\Downloads\\a.zip');
  wc.session.emit('will-download', event, item);
  assert.equal(event.prevented, undefined);
  const second = { preventDefault() { second.prevented = true; } };
  wc.session.emit('will-download', second, downloadItem('https://files.example/b.zip', ''));
  assert.equal(second.prevented, true, 'one at a time, so a page cannot stack dialogs');
  item.emit('done', {}, 'completed');
  assert.deepEqual(harness.service.getState('chat-a').note, { kind: 'saved', file: 'a.zip' });
});

test('a download nobody started by hand is cancelled and the panel says so', async () => {
  const harness = byHand();
  const wc = await openPage(harness);
  const event = { preventDefault() { event.prevented = true; } };
  wc.session.emit('will-download', event, downloadItem('https://files.example/a.zip', ''));
  assert.equal(event.prevented, true);
  assert.deepEqual(harness.service.getState('chat-a').note, { kind: 'download_off', host: '' });
  const next = await harness.service.execute({ action: 'read' }, ctx({ turnId: 'turn-2', callId: 'call-2' }));
  assert.equal(next.blockedNavigation, undefined, 'it was not during a model step');
});

test('page shortcuts drive the page or hand the keyboard to the panel', async () => {
  const pushed = [];
  const harness = byHand({ sendBridgeEvent: (_method, payload) => pushed.push(payload) });
  const wc = await openPage(harness);
  assert.equal(key(wc, { key: 'l', control: true }).prevented, true);
  assert.equal(pushed.at(-1).command, 'focus_address');
  assert.equal(key(wc, { key: 'f', control: true }).prevented, true);
  assert.equal(pushed.at(-1).command, 'open_find');
  assert.ok(harness.electron.window.webContents.focusCalls >= 2);
  key(wc, { key: '=', control: true });
  assert.equal(harness.service.getState('chat-a').zoom, 1.1);
  key(wc, { key: '0', control: true });
  assert.equal(harness.service.getState('chat-a').zoom, 1);
});

test('zoom steps through fixed levels and refuses anything else', async () => {
  const harness = byHand();
  await openPage(harness);
  harness.service.zoom('chat-a', 'in');
  harness.service.zoom('chat-a', 'in');
  assert.equal(harness.service.getState('chat-a').zoom, 1.25);
  harness.service.zoom('chat-a', 'out');
  assert.equal(harness.service.getState('chat-a').zoom, 1.1);
  assert.equal(harness.service.zoom('chat-a', 'bogus').ok, false);
});

test('find reports its count and clears', async () => {
  const harness = byHand();
  const wc = await openPage(harness);
  assert.equal(harness.service.find('chat-a', { text: 'ridge', forward: true, next: false }).ok, true);
  wc.emit('found-in-page', {}, { activeMatchOrdinal: 2, matches: 14 });
  assert.deepEqual(harness.service.getState('chat-a').find, { ordinal: 2, total: 14 });
  assert.equal(harness.service.stopFind('chat-a').ok, true);
  assert.equal(harness.service.getState('chat-a').find, null);
});

test('a page sign-in is noticed as a key goes in, stops asking once known, and survives the navigation it causes', async () => {
  const harness = byHand();
  const wc = await openPage(harness);
  let asked = 0;
  wc.executeJavaScriptInIsolatedWorld = async () => { asked += 1; return true; };
  key(wc, { key: 'h' });
  await new Promise((resolve) => setImmediate(resolve));
  key(wc, { key: 'i' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 1, 'known after the first answer');
  assert.equal(harness.service.getState('chat-a').signed_in, true);
  wc.emit('did-navigate', {}, 'https://example.com/home');
  assert.equal(harness.service.getState('chat-a').signed_in, true);
});

test('a parked page only runs at full speed during a step', async () => {
  const harness = byHand();
  const wc = await openPage(harness);
  const seen = [];
  wc.setBackgroundThrottling = (allowed) => seen.push(allowed);
  await harness.service.execute({ action: 'read' }, ctx({ turnId: 'turn-2', callId: 'call-2' }));
  assert.deepEqual(seen, [false, true]);
});

test('a page in use by hand is not closed to make room; closing says why', async () => {
  const pushed = [];
  const harness = byHand({ sendBridgeEvent: (_method, payload) => pushed.push(payload), maxPages: 1 });
  const wc = await openPage(harness);
  wc.emit('before-mouse-event', {}, { type: 'mouseDown' });
  assert.equal(harness.service.getState('chat-a').user_touched, true);
  const other = await harness.service.execute({ action: 'navigate', url: 'https://example.com/' }, ctx({ sessionId: 'chat-b', callId: 'b1', turnId: 'b' }));
  assert.equal(other.status, 'too_many_pages');
  await harness.service.close('chat-a');
  assert.equal(pushed.at(-1).closed_reason, 'user');
  assert.equal(harness.service.getState('chat-a').closed_reason, 'user');
});

test('a crash is visible to the panel until the page is used again', async () => {
  const harness = byHand();
  await openPage(harness);
  harness.electron.crash(harness.electron.views.at(-1));
  assert.equal(harness.service.getState('chat-a').crashed, true);
  harness.service.navigate('chat-a', { url: 'example.com' });
  assert.equal(harness.service.getState('chat-a').crashed, false);
});

test('site info lists the other sites Jenny may use and Remove takes one away', async () => {
  const harness = byHand();
  await openPage(harness);
  const allow = ctx({ turnId: 'turn-2', callId: 'c2', userText: '', authorize: async () => true });
  const moved = await harness.service.execute({ action: 'navigate', url: 'https://other.example/' }, allow);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const wc = harness.electron.views.at(-1).webContents;
  assert.deepEqual(harness.service.siteInfo('chat-a'), { ok: true, sites: [] }, 'the site showing stays allowed, so it is not listed');
  wc.state.url = 'https://example.com/';
  assert.deepEqual(harness.service.siteInfo('chat-a'), { ok: true, sites: ['other.example'] });
  assert.deepEqual(harness.service.removeSite('chat-a', 'other.example'), { ok: true });
  assert.deepEqual(harness.service.siteInfo('chat-a'), { ok: true, sites: [] });
  assert.equal(harness.service.removeSite('chat-a', 'nothing.example').ok, false);
});

test('the page background follows the app theme', async () => {
  const harness = byHand();
  await openPage(harness);
  const colors = [];
  harness.electron.views.at(-1).setBackgroundColor = (color) => colors.push(color);
  assert.equal(harness.service.configure('chat-a', { background: '#101010', labels: {} }).ok, true);
  assert.deepEqual(colors, ['#101010']);
});
