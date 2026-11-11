'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserUseHarness, deferred, holdEventLoop, waitFor } = require('./helpers/fake-browser-use-electron');

holdEventLoop(test);

const INACTIVITY_MS = 600000;
const BOUNDS = Object.freeze({ x: 100, y: 40, width: 400, height: 300 });
const ctx = (extra = {}) => ({
  sessionId: 'chat-a', turnId: 'turn-1', callId: 'call-1', userText: 'please open example.com', ...extra,
});

async function openPage(harness) {
  const result = await harness.service.execute({ action: 'navigate', url: 'https://example.com/' }, ctx());
  assert.equal(result.ok, true, JSON.stringify(result));
  return harness.electron.views.at(-1);
}

const readyFacts = {
  status: 'ready', ref: 'r1', tag: 'button', role: 'button', inputType: 'button', name: 'Add to cart', isAnchor: false, href: '',
  isFileInput: false, isSecret: false, isEditable: false, disabled: false, checked: false, form: null,
  rect: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 }, fingerprint: 'fp',
};

test('panel bounds become window coordinates at the app zoom', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  harness.electron.window.webContents.getZoomFactor = () => 1.25;
  assert.deepEqual(harness.service.show('chat-a', BOUNDS), { ok: true });
  assert.deepEqual(view.bounds, { x: 125, y: 50, width: 500, height: 375 });
  harness.electron.window.webContents.getZoomFactor = () => 0.8;
  harness.service.setBounds('chat-a', BOUNDS);
  assert.deepEqual(view.bounds, { x: 80, y: 32, width: 320, height: 240 });
});

test('without a readable zoom the bounds pass through unchanged', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  harness.electron.window.webContents.getZoomFactor = () => { throw new Error('gone'); };
  harness.service.show('chat-a', BOUNDS);
  assert.deepEqual(view.bounds, { ...BOUNDS });
});

test('the state names the step and its target, then clears both', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  assert.deepEqual([harness.service.getState('chat-a').action, harness.service.getState('chat-a').target], ['', '']);
  const hold = deferred();
  Object.assign(view.webContents.readerOps, { probe: () => readyFacts, verify: () => ({ status: 'ready', rect: readyFacts.rect }), read: () => hold.promise });
  const running = harness.service.execute({ action: 'click', ref: 'r1' }, ctx({ callId: 'c2' }));
  await waitFor(() => harness.service.getState('chat-a').target === 'Add to cart');
  const during = harness.service.getState('chat-a');
  assert.deepEqual([during.busy, during.action, during.asking], [true, 'click', false]);
  assert.ok(harness.events.some((event) => event.payload.target === 'Add to cart'), 'the panel was told');
  hold.resolve({ status: 'ok', text: 'done' });
  await running;
  const after = harness.service.getState('chat-a');
  assert.deepEqual([after.busy, after.action, after.target], [false, '', '']);
});

test('a navigate is labelled with the host, never the full address', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  const hold = deferred();
  view.webContents.readerOps.read = () => hold.promise;
  const running = harness.service.execute({ action: 'navigate', url: 'https://example.com/account?token=abc' }, ctx({ callId: 'c3' }));
  await waitFor(() => harness.service.getState('chat-a').action === 'navigate');
  assert.equal(harness.service.getState('chat-a').target, 'example.com');
  hold.resolve({ status: 'ok', text: 'done' });
  await running;
});

test('asking is on only while the step waits for the user', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness);
  const answer = deferred();
  const authorize = () => answer.promise;
  const running = harness.service.execute({ action: 'navigate', url: 'https://not-named.example/' }, ctx({ callId: 'c4', authorize }));
  await waitFor(() => harness.service.getState('chat-a').asking);
  answer.resolve({ approved: false });
  await running;
  assert.equal(harness.service.getState('chat-a').asking, false);
});

test('a page on screen does not idle out, and goes once it has been hidden long enough', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness);
  harness.service.show('chat-a', BOUNDS);
  harness.timers.tick(INACTIVITY_MS * 3);
  assert.equal(harness.service.getState('chat-a').open, true);
  harness.service.hide('chat-a');
  harness.timers.tick(INACTIVITY_MS);
  assert.equal(harness.service.getState('chat-a').open, false);
});

test('a page the user is holding does not idle out, and goes after hand back', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness);
  harness.service.takeOver('chat-a');
  harness.timers.tick(INACTIVITY_MS * 3);
  assert.equal(harness.service.getState('chat-a').open, true);
  harness.service.handBack('chat-a');
  harness.timers.tick(INACTIVITY_MS);
  assert.equal(harness.service.getState('chat-a').open, false);
});

test('hiding a page that has the keyboard gives the keyboard back to the app', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  harness.service.show('chat-a', BOUNDS);
  view.webContents.isFocused = () => true;
  harness.service.hide('chat-a');
  assert.equal(harness.electron.window.webContents.focusCalls, 1);
  view.webContents.isFocused = () => false;
  harness.service.show('chat-a', BOUNDS);
  harness.service.hide('chat-a');
  assert.equal(harness.electron.window.webContents.focusCalls, 1);
});

test('a state that did not change is not sent again', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  const before = harness.events.length;
  view.webContents.emit('did-stop-loading');
  view.webContents.emit('page-title-updated');
  assert.equal(harness.events.length, before);
  view.webContents.state.title = 'New title';
  view.webContents.emit('page-title-updated');
  assert.equal(harness.events.length, before + 1);
  assert.equal(harness.events.at(-1).payload.title, 'New title');
});

test('an app reload parks every page that was on screen', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  harness.service.show('chat-a', BOUNDS);
  harness.service.hideAll();
  assert.ok(view.bounds.x < 0, 'off screen');
  assert.deepEqual(harness.service.setBounds('chat-a', BOUNDS), { ok: false, reason: 'not_shown' });
  harness.timers.tick(INACTIVITY_MS);
  assert.equal(harness.service.getState('chat-a').open, false, 'and it can idle out now');
});

test('the service knows which web contents are its own', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  assert.equal(harness.service.ownsContents(view.webContents), true);
  assert.equal(harness.service.ownsContents(harness.electron.window.webContents), false);
});

test('mouse traffic right after a step does not restart the idle wait, and later traffic does', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  const move = () => view.webContents.emit('before-mouse-event', {}, { type: 'mouseMove' });
  harness.timers.tick(500);
  move();
  harness.timers.tick(INACTIVITY_MS - 500);
  assert.equal(harness.service.getState('chat-a').open, false, 'the first wait ran out on time');

  const later = createBrowserUseHarness();
  const laterView = await openPage(later);
  later.timers.tick(2000);
  laterView.webContents.emit('before-mouse-event', {}, { type: 'mouseMove' });
  later.timers.tick(INACTIVITY_MS - 1000);
  assert.equal(later.service.getState('chat-a').open, true, 'activity a while later restarted it');
});
