'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserHold } = require('../services/browser-use/user-hold');
const { createFakeTimers } = require('./helpers/fake-timers');
const { createBrowserUseHarness, holdEventLoop, waitFor } = require('./helpers/fake-browser-use-electron');

holdEventLoop(test);

function makeHold({ idleLimitMs = 1000 } = {}) {
  const timers = createFakeTimers();
  const activity = { at: 0 };
  const hold = createUserHold({
    getLastActiveAt: () => activity.at, idleLimitMs, now: timers.now, setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  return { hold, timers, activity };
}

test('with nothing held the wait answers at once and leaves the clocks alone', async () => {
  const { hold } = makeHold();
  let suspended = 0;
  const outcome = await hold.wait({ suspendClocks: () => { suspended += 1; return () => {}; } });
  assert.deepEqual(outcome, { ended: 'released', waitedMs: 0 });
  assert.equal(suspended, 0);
});

test('the end of the hold releases the wait, reports how long it took and resumes the clocks', async () => {
  const { hold, timers } = makeHold();
  hold.begin();
  let resumed = 0;
  const pending = hold.wait({ suspendClocks: () => () => { resumed += 1; } });
  timers.tick(400);
  assert.equal(resumed, 0);
  hold.end();
  assert.deepEqual(await pending, { ended: 'released', waitedMs: 400 });
  assert.equal(resumed, 1);
});

test('beginning twice keeps one hold, and one end releases it', async () => {
  const { hold } = makeHold();
  hold.begin();
  hold.begin();
  const pending = hold.wait();
  hold.end();
  assert.equal((await pending).ended, 'released');
  assert.equal((await hold.wait()).ended, 'released');
});

test('Stop ends the wait, even when it fired before the wait began', async () => {
  const { hold, timers } = makeHold();
  hold.begin();
  const stop = new AbortController();
  const pending = hold.wait({ signal: stop.signal });
  timers.tick(250);
  stop.abort();
  assert.deepEqual(await pending, { ended: 'stopped', waitedMs: 250 });
  assert.equal((await hold.wait({ signal: stop.signal })).ended, 'stopped');
});

test('input in the page keeps the wait alive; only a full quiet spell ends it', async () => {
  const { hold, timers, activity } = makeHold({ idleLimitMs: 1000 });
  hold.begin();
  let outcome = null;
  const pending = hold.wait().then((value) => { outcome = value; return value; });
  timers.tick(600);
  activity.at = 600;
  timers.tick(600);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome, null, 'still inside the quiet limit after the input at 600');
  timers.tick(400);
  assert.deepEqual(await pending, { ended: 'idle', waitedMs: 1600 });
});

test('a hold already quiet for the whole limit gives up straight away', async () => {
  const { hold, timers } = makeHold({ idleLimitMs: 1000 });
  timers.tick(5000);
  hold.begin();
  assert.deepEqual(await hold.wait(), { ended: 'idle', waitedMs: 0 });
});

// The same wait, seen from the service.

const ctx = (extra = {}) => ({ sessionId: 'chat-a', turnId: 'turn-1', callId: 'call-1', userText: 'please open example.com', ...extra });

async function heldStep(options = {}) {
  const harness = createBrowserUseHarness(options);
  await harness.service.execute({ action: 'navigate', url: 'https://example.com/' }, ctx());
  const view = harness.electron.views.at(-1);
  harness.service.takeOver('chat-a');
  const stop = new AbortController();
  let started = false;
  const running = harness.service.execute({ action: 'read' }, ctx({
    callId: 'c2', abortSignal: stop.signal, suspendTurnClocks: () => { started = true; return () => {}; },
  }));
  await waitFor(() => started);
  return { harness, view, stop, running };
}

test('Stop during the wait cancels the step and leaves the page with the user', async () => {
  const { harness, stop, running } = await heldStep();
  harness.timers.tick(1000);
  stop.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.humanWaitMs, 1000);
  assert.equal(harness.service.getState('chat-a').mode, 'user');
  assert.equal(harness.service.getState('chat-a').open, true);
});

test('a user who goes quiet ends the step with a note, and the page stays theirs', async () => {
  const { harness, running } = await heldStep({ holdIdleMs: 1000 });
  harness.timers.tick(1000);
  const result = await running;
  assert.equal(result.status, 'paused_by_user');
  assert.match(result.message, /Stop here and tell them/);
  assert.equal(result.humanWaitMs, 1000);
  assert.equal(harness.service.getState('chat-a').mode, 'user');
});

test('closing the page during the wait tells the model it was closed', async () => {
  const { harness, running } = await heldStep();
  await harness.service.close('chat-a');
  const result = await running;
  assert.equal(result.status, 'browser_closed');
  assert.match(result.message, /closed the browser page/);
});

test('a crash during the wait reports the crash once', async () => {
  const { harness, view, running } = await heldStep();
  harness.electron.crash(view);
  const result = await running;
  assert.equal(result.status, 'page_crashed');
  assert.equal(harness.service.getState('chat-a').mode, 'model');
  const next = await harness.service.execute({ action: 'read' }, ctx({ callId: 'c3' }));
  assert.notEqual(next.status, 'page_crashed', 'the note was delivered by the step that waited');
});

test('shutting down during the wait releases the step', async () => {
  const { harness, running } = await heldStep();
  await harness.service.dispose();
  assert.equal((await running).status, 'unavailable');
});

test('the chat is told while a step waits, and told when it stops', async () => {
  const { harness, running } = await heldStep();
  assert.equal(harness.service.getState('chat-a').waiting, true);
  assert.equal(harness.events.at(-1).payload.waiting, true);
  harness.service.handBack('chat-a');
  await running;
  assert.equal(harness.service.getState('chat-a').waiting, false);
  assert.equal(harness.events.at(-1).payload.waiting, false);
});

test('Stop can tell that the step was waiting on the user', async () => {
  const { harness, stop, running } = await heldStep();
  assert.equal(harness.service.waitedOnUser('chat-a', 'c2'), true);
  assert.equal(harness.service.waitedOnUser('chat-a', 'c9'), false);
  assert.equal(harness.service.waitedOnUser('chat-b', 'c2'), false);
  stop.abort();
  await running;
  assert.equal(harness.service.waitedOnUser('chat-a', 'c2'), true, 'still known once the abort has landed');
  assert.equal(harness.service.getState('chat-a').waiting, false);
});

test('a step that was handed back was not left waiting', async () => {
  const { harness, running } = await heldStep();
  harness.service.handBack('chat-a');
  await running;
  assert.equal(harness.service.waitedOnUser('chat-a', 'c2'), false);
});

// Who the page belongs to when the user touches it.

const mouseDown = (view) => view.webContents.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown' });

function navEvent(url) {
  const event = { url, prevented: false, preventDefault() { event.prevented = true; } };
  return event;
}

async function openedPage(options = {}) {
  const harness = createBrowserUseHarness(options);
  await harness.service.execute({ action: 'navigate', url: 'https://example.com/' }, ctx());
  return { harness, view: harness.electron.views.at(-1) };
}

test('a click between tasks takes nothing over, and the next task just runs', async () => {
  const { harness, view } = await openedPage();
  harness.turn.id = '';
  mouseDown(view);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
  harness.turn.id = 'turn-2';
  assert.equal((await harness.service.execute({ action: 'read' }, ctx({ turnId: 'turn-2', callId: 'c2' }))).ok, true);
});

test('a click in a task that has not used the page takes nothing over', async () => {
  const { harness, view } = await openedPage();
  harness.turn.id = 'turn-2';
  mouseDown(view);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
});

test('a link the user clicks between tasks works, until Jenny drives again', async () => {
  const { harness, view } = await openedPage();
  harness.turn.id = '';
  const pageJump = navEvent('https://tracker.example.net/a');
  view.webContents.emit('will-navigate', pageJump);
  assert.equal(pageJump.prevented, true, 'before the click this is the page sending itself away');
  mouseDown(view);
  const link = navEvent('https://tracker.example.net/b');
  view.webContents.emit('will-navigate', link);
  assert.equal(link.prevented, false);
  const refused = navEvent('http://10.0.0.1/admin');
  view.webContents.emit('will-navigate', refused);
  assert.equal(refused.prevented, true, 'the never-allowed addresses stay refused');
  await harness.service.execute({ action: 'read' }, ctx({ turnId: 'turn-2', callId: 'c2' }));
  const after = navEvent('https://tracker.example.net/c');
  view.webContents.emit('will-navigate', after);
  assert.equal(after.prevented, true, 'once Jenny is driving, the page cannot send itself away');
});

test('a stale click does not let the page send itself away', async () => {
  const { harness, view } = await openedPage();
  harness.turn.id = '';
  mouseDown(view);
  harness.timers.tick(14999);
  const soon = navEvent('https://tracker.example.net/a');
  view.webContents.emit('will-navigate', soon);
  assert.equal(soon.prevented, false, 'still a clicked link finishing its redirects');
  harness.timers.tick(1);
  const later = navEvent('https://tracker.example.net/b');
  view.webContents.emit('will-navigate', later);
  assert.equal(later.prevented, true);
});

test('a click between two steps of one task makes the next step wait', async () => {
  const { harness, view } = await openedPage();
  mouseDown(view);
  assert.equal(harness.service.getState('chat-a').mode, 'user');
  let waiting = false;
  const running = harness.service.execute({ action: 'read' }, ctx({ callId: 'c2', suspendTurnClocks: () => { waiting = true; return () => {}; } }));
  await waitFor(() => waiting);
  harness.service.handBack('chat-a');
  assert.equal((await running).status, 'handed_back');
});

test('Take over between tasks does not hold up the next one', async () => {
  const { harness } = await openedPage();
  harness.turn.id = '';
  harness.service.takeOver('chat-a');
  assert.equal(harness.service.getState('chat-a').mode, 'user');
  harness.turn.id = 'turn-2';
  assert.equal((await harness.service.execute({ action: 'read' }, ctx({ turnId: 'turn-2', callId: 'c2' }))).ok, true);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
});

test('asking for something new takes the browser back from an earlier take-over', async () => {
  const { harness, view } = await openedPage();
  mouseDown(view);
  assert.equal(harness.service.getState('chat-a').mode, 'user');
  harness.turn.id = 'turn-2';
  const result = await harness.service.execute({ action: 'read' }, ctx({ turnId: 'turn-2', callId: 'c2' }));
  assert.equal(result.ok, true);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
  assert.equal(harness.events.at(-1).payload.mode, 'model');
});

test('a running-turn lookup that fails counts as no running turn', async () => {
  const { harness, view } = await openedPage({ getRunningTurnId: () => { throw new Error('store gone'); } });
  mouseDown(view);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
});
