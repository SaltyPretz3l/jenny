'use strict';

// Chromium drops clicks and keys sent to a view that has never overlapped its window. The real run
// showed the tool reporting "Clicked" while the page saw nothing, so these pin the cure and the refusal.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPageHost } = require('../services/browser-use/page-host');
const { createFakeElectron, createBrowserUseHarness, holdEventLoop } = require('./helpers/fake-browser-use-electron');
const { logNames } = require('./helpers/fake-web-contents-view');
const { harness } = require('./helpers/browser-use-page-actions-harness');

holdEventLoop(test);

const FAR = { x: -32000, y: 0, width: 1280, height: 800 };
const CORNER = { x: 1599, y: 899, width: 1280, height: 800 };
const PANEL = { x: 900, y: 60, width: 640, height: 780 };
const NUDGED = { ...PANEL, x: PANEL.x + 1 };

function setupHost() {
  const electron = createFakeElectron();
  const host = createPageHost({
    createView: electron.createView,
    sessionFromPartition: electron.sessionFromPartition,
    getMainWindow: electron.getMainWindow,
    randomToken: () => 'tok',
    urlGuard: {},
    consent: {},
  });
  return { host, view: electron.lastView(), window: electron.window };
}

test('a parked page touches the window corner across a task, then parks again', async () => {
  const { host, view } = setupHost();
  assert.deepEqual(view.bounds, FAR);
  const pending = host.armView();
  // Trials: nothing strictly synchronous arms the view, so it must still be there when control returns.
  assert.deepEqual(view.bounds, CORNER);
  assert.equal(await pending, true);
  assert.deepEqual(view.bounds, FAR);
  assert.deepEqual(view.boundsHistory.slice(-3), [FAR, CORNER, FAR]);
});

function recordCaptures(view) {
  const seen = [];
  view.webContents.capturePage = async (...args) => { seen.push({ bounds: { ...view.bounds }, args }); return null; };
  return seen;
}

test('a parked page gets one plain capture while it is on the window', async () => {
  const { host, view } = setupHost();
  const seen = recordCaptures(view);
  await host.armView();
  // Trials with the display asleep: only a plain capture, with the view on the window, brought input back.
  assert.deepEqual(seen, [{ bounds: CORNER, args: [] }]);
  assert.deepEqual(view.bounds, FAR);
});

for (const [name, capturePage] of [
  ['fails', async () => { throw new Error('UnknownVizError'); }],
  ['throws', () => { throw new Error('no surface'); }],
  ['never answers', () => new Promise(() => {})],
]) {
  test(`a capture that ${name} still ends the touch`, async () => {
    const { host, view } = setupHost();
    view.webContents.capturePage = capturePage;
    assert.equal(await host.armView(), true);
    assert.deepEqual(view.bounds, FAR);
  });
}

test('a parked page is never asked whether it paints', async () => {
  const { host } = setupHost();
  let asked = 0;
  await host.armView({ paints: async () => { asked += 1; return true; } });
  assert.equal(asked, 0);
});

test('a page in place that still paints is left alone', async () => {
  const { host, view } = setupHost();
  host.place(PANEL);
  const before = view.boundsHistory.length;
  const seen = recordCaptures(view);
  assert.equal(await host.armView({ paints: async () => true }), true);
  assert.equal(view.boundsHistory.length, before);
  assert.deepEqual(seen, []);
  assert.deepEqual(view.bounds, PANEL);
});

test('a page in place that stopped painting moves one pixel, is captured there and goes back', async () => {
  const { host, view } = setupHost();
  host.place(PANEL);
  const seen = recordCaptures(view);
  assert.equal(await host.armView({ paints: async () => false }), true);
  assert.deepEqual(seen, [{ bounds: NUDGED, args: [] }]);
  assert.deepEqual(view.boundsHistory.slice(-2), [NUDGED, PANEL]);
});

test('the panel moving during the nudge wins', async () => {
  const { host, view } = setupHost();
  host.place(PANEL);
  const pending = host.armView({ paints: async () => false });
  while (view.bounds.x !== NUDGED.x) await new Promise(setImmediate);
  const moved = { ...PANEL, x: 800 };
  host.place(moved);
  assert.equal(await pending, true);
  assert.deepEqual(view.bounds, moved);
});

for (const [name, change] of [
  ['minimized', (window) => { window.minimized = true; }],
  ['hidden', (window) => { window.visible = false; }],
  ['of no size', (window) => { window.contentBounds = { x: 0, y: 0, width: 0, height: 0 }; }],
]) {
  test(`a window that is ${name} cannot take input and the page stays parked`, async () => {
    const { host, view, window } = setupHost();
    change(window);
    const before = view.boundsHistory.length;
    assert.equal(await host.armView(), false);
    assert.equal(view.boundsHistory.length, before);
  });
}

test('a page in place in a minimized window cannot take input either', async () => {
  const { host, window } = setupHost();
  host.place(PANEL);
  window.minimized = true;
  assert.equal(await host.armView(), false);
});

test('opening the panel during the touch keeps the page in the panel', async () => {
  const { host, view } = setupHost();
  const pending = host.armView();
  host.place(PANEL);
  assert.equal(await pending, true);
  assert.deepEqual(view.bounds, PANEL);
});

test('parking at a new size during the touch parks at that size', async () => {
  const { host, view } = setupHost();
  const pending = host.armView();
  host.offscreen({ width: 640, height: 780 });
  assert.equal(await pending, true);
  assert.deepEqual(view.bounds, { x: -32000, y: 0, width: 640, height: 780 });
});

test('the touch uses the size the page is parked at, so the page never reflows', async () => {
  const { host, view } = setupHost();
  host.offscreen({ width: 640, height: 780 });
  const pending = host.armView();
  assert.deepEqual(view.bounds, { x: 1599, y: 899, width: 640, height: 780 });
  await pending;
});

test('a disposed page cannot take input', async () => {
  const { host } = setupHost();
  await host.dispose();
  assert.equal(await host.armView(), false);
});

test('click readies the page after the ask and before the last identity check', async () => {
  const h = harness({ armView: async () => true });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.status, 'clicked');
  assert.deepEqual(logNames(h.log).slice(0, 4), ['reader.probe', 'gate.beforeClick', 'host.armView', 'reader.verify']);
  assert.equal(h.webContents.inputEvents.length, 3);
});

test('click says so when the window cannot take input, and sends nothing', async () => {
  const h = harness({ armView: async () => false });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'window_hidden');
  assert.match(result.message, /minimized or hidden/);
  assert.equal(h.webContents.inputEvents.length, 0);
  assert.equal(h.calls('verify').length, 0);
});

test('press readies the page after the ask and before the last focus check', async () => {
  const h = harness({ armView: async () => true });
  const result = await h.actions.press({ key: 'Tab' });
  assert.equal(result.status, 'pressed');
  assert.deepEqual(logNames(h.log).slice(0, 4), ['reader.probeFocused', 'gate.beforePress', 'host.armView', 'reader.probeFocused']);
});

test('press says so when the window cannot take input, and sends nothing', async () => {
  const h = harness({ armView: async () => false });
  const result = await h.actions.press({ key: 'Tab' });
  assert.equal(result.status, 'window_hidden');
  assert.equal(h.webContents.inputEvents.length, 0);
});

test('type with submit readies the page before any text goes in', async () => {
  const blocked = harness({ armView: async () => false });
  const refused = await blocked.actions.type({ ref: 'r12', text: 'hello', submit: true });
  assert.equal(refused.status, 'window_hidden');
  assert.equal(blocked.calls('focusForTyping').length, 0);

  const ready = harness({ armView: async () => true });
  assert.equal((await ready.actions.type({ ref: 'r12', text: 'hello', submit: true })).status, 'typed');
  assert.deepEqual(logNames(ready.log).slice(0, 4), ['reader.probe', 'gate.beforeType', 'host.armView', 'reader.focusForTyping']);
});

test('type without submit never needs the native input path', async () => {
  const h = harness({ armView: async () => false });
  assert.equal((await h.actions.type({ ref: 'r12', text: 'hello' })).status, 'typed');
  assert.equal(logNames(h.log).includes('host.armView'), false);
});

test('Stop during the touch cancels without sending anything', async () => {
  const controller = new AbortController();
  const h = harness({ armView: () => new Promise(() => {}) });
  const pending = h.actions.click({ ref: 'r12' }, { signal: controller.signal });
  while (!logNames(h.log).includes('host.armView')) await new Promise(setImmediate);
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(h.webContents.inputEvents.length, 0);
});

// Answers a click's arrival checks in order: after the first send, after the second touch, after the second send.
const pressAnswers = (...answers) => () => ({ status: 'ok', seen: answers.shift() });

test('a click the page never saw is readied and sent once more', async () => {
  const h = harness({ armView: async () => true, replies: { pressSeen: pressAnswers(false, false, true) } });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.status, 'clicked');
  assert.equal(h.webContents.inputEvents.length, 6);
  assert.deepEqual(h.calls('verify').map((call) => call.args.watchPress), [true, true]);
  assert.equal(logNames(h.log).filter((name) => name === 'host.armView').length, 2);
  assert.equal(h.calls('read').length, 1);
});

test('a click that never arrives says so and claims nothing', async () => {
  const h = harness({ armView: async () => true, replies: { pressSeen: pressAnswers(false, false, false) } });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'input_not_delivered');
  assert.match(result.message, /did not reach the page/);
  assert.equal(h.webContents.inputEvents.length, 6);
  assert.equal(h.calls('read').length, 0);
});

test('a press that turns up late is not answered with a second one', async () => {
  const h = harness({ armView: async () => true, replies: { pressSeen: pressAnswers(false, true) } });
  assert.equal((await h.actions.click({ ref: 'r12' })).status, 'clicked');
  assert.equal(h.webContents.inputEvents.length, 3);
});

test('a page that went away after the click counts as reached', async () => {
  const h = harness({ armView: async () => true, replies: { pressSeen: new Error('context destroyed') } });
  assert.equal((await h.actions.click({ ref: 'r12' })).status, 'clicked');
  assert.equal(h.webContents.inputEvents.length, 3);
});

test('Stop during the arrival check cancels without sending again', async () => {
  const controller = new AbortController();
  const h = harness({ armView: async () => true, replies: { pressSeen: () => new Promise(() => {}) } });
  const pending = h.actions.click({ ref: 'r12' }, { signal: controller.signal });
  while (h.calls('pressSeen').length === 0) await new Promise(setImmediate);
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(h.webContents.inputEvents.length, 3);
});

test('the touch can ask the page whether it paints, and no answer means no', async () => {
  const answers = [];
  const armView = async ({ paints }) => { answers.push(await paints()); return true; };
  await harness({ armView }).actions.click({ ref: 'r12' });
  await harness({ armView, replies: { paints: { status: 'ok', paints: false } } }).actions.click({ ref: 'r12' });
  await harness({ armView, replies: { paints: new Error('page gone') } }).actions.click({ ref: 'r12' });
  assert.deepEqual(answers, [true, false, false]);
});

// The page answers the key acknowledgement with false only when it ran and never saw the key.
const keyMissed = { executeJavaScript: async (script) => !script.includes('__jennyInputAck ||') };
const keyUnknown = { executeJavaScript: async (script) => { if (script.includes('__jennyInputAck ||')) throw new Error('page replaced'); return true; } };

test('a key the page never saw is reported', async () => {
  const h = harness({ armView: async () => true, wc: keyMissed });
  const result = await h.actions.press({ key: 'Tab' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'input_not_delivered');
  assert.match(result.message, /Tab did not reach the page/);
  assert.equal(h.calls('read').length, 0);
});

test('a key followed by a page change still counts as pressed', async () => {
  const h = harness({ armView: async () => true, wc: keyUnknown });
  assert.equal((await h.actions.press({ key: 'Enter' })).status, 'pressed');
});

test('a typed Enter the page never saw is reported, and the text is not echoed', async () => {
  const h = harness({ armView: async () => true, wc: keyMissed });
  const result = await h.actions.type({ ref: 'r12', text: 'hello', submit: true });
  assert.equal(result.status, 'input_not_delivered');
  assert.match(result.message, /Typed 5 characters into r12, but Enter did not reach the page/);
  assert.doesNotMatch(JSON.stringify(result), /hello/);
});

test('a screenshot wakes the page only after the mask is on', async () => {
  const h = harness({ armView: async () => true });
  assert.equal((await h.actions.screenshot({})).status, 'screenshot');
  assert.deepEqual(logNames(h.log).slice(0, 2), ['reader.secretMask', 'host.armView']);
});

test('a screenshot still tries when the window cannot arm the page', async () => {
  const h = harness({ armView: async () => false });
  assert.equal((await h.actions.screenshot({})).status, 'screenshot');
});

test('a page with secret fields gets no picture when the mask cannot be proven on screen', async () => {
  const h = harness({ armView: async () => true, replies: { secretMask: { status: 'ok', count: 2 }, paints: { status: 'ok', paints: false } } });
  const result = await h.actions.screenshot({});
  assert.equal(result.ok, false);
  assert.equal(result.status, 'screenshot_failed');
  assert.match(result.message, /password or card/);
  assert.equal(logNames(h.log).includes('wc.capturePage'), false);
  assert.deepEqual(h.calls('secretMask').map((call) => call.args), [{ on: true }, { on: false }]);
  assert.equal(h.calls('paints')[0].args.capMs, 500);
});

test('a page with secret fields gets its picture once frames are confirmed after the mask', async () => {
  const h = harness({ armView: async () => true, replies: { secretMask: { status: 'ok', count: 1 } } });
  assert.equal((await h.actions.screenshot({})).status, 'screenshot');
  const names = logNames(h.log);
  assert.ok(names.indexOf('reader.paints') < names.indexOf('wc.capturePage'));
});

test('a page with no secret fields does not need the proof', async () => {
  const h = harness({ armView: async () => true, replies: { secretMask: { status: 'ok', count: 0 }, paints: { status: 'ok', paints: false } } });
  assert.equal((await h.actions.screenshot({})).status, 'screenshot');
  assert.equal(h.calls('paints').length, 0);
});

test('the service wires a real click through the touch on the real host', async () => {
  const { service, electron } = createBrowserUseHarness({}, {
    webContents: { readerOps: {
      probe: () => ({ status: 'ready', ref: 'r1', tag: 'button', role: 'button', name: 'Add', isAnchor: false, isEditable: false, isFileInput: false, isSecret: false, fingerprint: 'fp', rect: { centerX: 5, centerY: 5 } }),
      verify: () => ({ status: 'ready', rect: { centerX: 5, centerY: 5 } }),
    } },
  });
  const ctx = { sessionId: 'chat-a', turnId: 'turn-1', callId: 'c1', userText: 'please open example.com' };
  assert.equal((await service.execute({ action: 'navigate', url: 'https://example.com/' }, ctx)).ok, true);
  const result = await service.execute({ action: 'click', ref: 'r1' }, { ...ctx, callId: 'c2' });
  assert.equal(result.status, 'clicked');
  const view = electron.lastView();
  assert.deepEqual(view.boundsHistory.slice(-2), [CORNER, FAR]);
  assert.equal(view.webContents.inputEvents.length, 3);
});
