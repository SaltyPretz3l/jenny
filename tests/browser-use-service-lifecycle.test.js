'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserUseHarness, createFakeElectron, deferred, holdEventLoop, waitFor } = require('./helpers/fake-browser-use-electron');

holdEventLoop(test);

const INACTIVITY_MS = 600000;
const ctx = (extra = {}) => ({
  sessionId: 'chat-a', turnId: 'turn-1', callId: 'call-1', userText: 'please open example.com', ...extra,
});
const nav = (harness, sessionId, callId = `n-${sessionId}`) => harness.service.execute(
  { action: 'navigate', url: 'https://example.com/' }, ctx({ sessionId, callId, turnId: `t-${callId}` }),
);
const read = (harness, sessionId, callId = `r-${sessionId}`) => harness.service.execute(
  { action: 'read' }, ctx({ sessionId, callId, turnId: `t-${callId}` }),
);
const viewFor = (harness, index) => harness.electron.views[index];

async function open(harness, sessionId) {
  const result = await nav(harness, sessionId);
  assert.equal(result.ok, true, JSON.stringify(result));
  return harness.electron.views.at(-1);
}

async function startBlockedRead(harness, sessionId, view) {
  const hold = deferred();
  view.webContents.readerOps.read = () => hold.promise;
  const running = read(harness, sessionId, `blocked-${sessionId}`);
  await waitFor(() => harness.service.getState(sessionId).busy);
  return { hold, running };
}

const SQUEEZED_OUT = 'The browser page was closed to make room for another chat. Use navigate to open a new one. Sign-ins are gone.';

test('at the cap the least recently active idle page is closed for the new chat', async () => {
  const harness = createBrowserUseHarness();
  await open(harness, 'chat-a');
  harness.timers.tick(10);
  await open(harness, 'chat-b');
  harness.timers.tick(10);
  await read(harness, 'chat-a');
  harness.timers.tick(10);
  const opened = await nav(harness, 'chat-c');
  assert.equal(opened.ok, true);
  assert.equal(harness.service.getState('chat-b').open, false, 'chat-b was the least recently active');
  assert.equal(harness.service.getState('chat-a').open, true);
  assert.equal(viewFor(harness, 1).webContents.closeCalls.length, 1);
  assert.equal(viewFor(harness, 0).webContents.closeCalls.length, 0);
  const note = await read(harness, 'chat-b');
  assert.equal(note.ok, false);
  assert.equal(note.status, 'browser_closed');
  assert.equal(note.message, SQUEEZED_OUT);
});

test('a navigate clears the closed note and opens a fresh page', async () => {
  const harness = createBrowserUseHarness({ maxPages: 1 });
  await open(harness, 'chat-a');
  await open(harness, 'chat-b');
  assert.equal((await read(harness, 'chat-a')).status, 'browser_closed');
  assert.equal((await read(harness, 'chat-a')).status, 'browser_closed', 'the note stays until a navigate');
  assert.equal((await nav(harness, 'chat-a')).ok, true);
  assert.equal(harness.service.getState('chat-a').open, true);
  assert.equal(harness.service.getState('chat-b').open, false);
});

test('busy, user-held and visible pages are never evicted', async () => {
  const harness = createBrowserUseHarness();
  const viewA = await open(harness, 'chat-a');
  harness.timers.tick(10);
  await open(harness, 'chat-b');
  harness.timers.tick(10);
  const { hold, running } = await startBlockedRead(harness, 'chat-a', viewA);
  harness.service.show('chat-b', { x: 0, y: 0, width: 600, height: 400 });
  const blocked = await nav(harness, 'chat-c');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'too_many_pages');
  assert.equal(blocked.message, 'Two browser pages are already in use in other chats. Try again when one is free.');
  assert.equal(harness.electron.views.length, 2, 'no third page was created');

  harness.service.hide('chat-b');
  harness.service.takeOver('chat-b');
  assert.equal((await nav(harness, 'chat-c')).status, 'too_many_pages');

  harness.service.handBack('chat-b');
  assert.equal((await nav(harness, 'chat-c')).ok, true, 'once chat-b is idle and hidden it can go');
  assert.equal(harness.service.getState('chat-a').open, true);
  assert.equal(harness.service.getState('chat-b').open, false);
  hold.resolve({ status: 'ok' });
  await running;
});

test('a page with a call waiting behind another is not evicted either', async () => {
  const harness = createBrowserUseHarness();
  const viewA = await open(harness, 'chat-a');
  await open(harness, 'chat-b');
  const { hold, running } = await startBlockedRead(harness, 'chat-a', viewA);
  const queued = read(harness, 'chat-a', 'queued');
  harness.service.show('chat-b', { x: 0, y: 0, width: 600, height: 400 });
  assert.equal((await nav(harness, 'chat-c')).status, 'too_many_pages');
  hold.resolve({ status: 'ok' });
  await Promise.all([running, queued]);
});

test('an idle page closes after the inactivity window and says why', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  harness.timers.tick(INACTIVITY_MS - 1);
  assert.equal(harness.service.getState('chat-a').open, true);
  harness.timers.tick(1);
  assert.equal(harness.service.getState('chat-a').open, false);
  await waitFor(() => view.webContents.isDestroyed());
  const note = await read(harness, 'chat-a');
  assert.equal(note.status, 'browser_closed');
  assert.equal(note.message, 'The browser page was closed because it sat unused. Use navigate to open a new one. Sign-ins are gone.');
  assert.equal(harness.events.at(-1).payload.open, false);
});

test('the inactivity timer waits out a running call and restarts after it', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  const { hold, running } = await startBlockedRead(harness, 'chat-a', view);
  assert.equal(harness.timers.pending(), 0, 'no timer while a call runs');
  harness.timers.tick(INACTIVITY_MS * 2);
  assert.equal(harness.service.getState('chat-a').open, true);
  hold.resolve({ status: 'ok', text: 'done' });
  await running;
  assert.equal(harness.timers.pending(), 1);
  harness.timers.tick(INACTIVITY_MS);
  assert.equal(harness.service.getState('chat-a').open, false);
});

test('the timer handle is unreffed so it never keeps the app alive', async () => {
  let unrefs = 0;
  const harness = createBrowserUseHarness({
    setTimer: () => ({ unref() { unrefs += 1; } }),
    clearTimer: () => {},
  });
  await open(harness, 'chat-a');
  assert.ok(unrefs >= 1);
});

test('user activity on the page restarts the inactivity window', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  harness.timers.tick(500000);
  view.webContents.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseMove' });
  harness.timers.tick(500000);
  assert.equal(harness.service.getState('chat-a').open, true);
  harness.timers.tick(100000);
  assert.equal(harness.service.getState('chat-a').open, false);
});

test('a user key press during a task takes over; a hand back resumes the model', async () => {
  const harness = createBrowserUseHarness();
  harness.turn.id = 't-n-chat-a';
  const view = await open(harness, 'chat-a');
  view.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'h' });
  assert.equal(harness.service.getState('chat-a').mode, 'user');
  assert.equal(harness.events.at(-1).payload.mode, 'user');
  const waiting = read(harness, 'chat-a', 'n-chat-a');
  await new Promise((resolve) => setTimeout(resolve, 20));
  harness.service.handBack('chat-a');
  assert.equal((await waiting).status, 'handed_back');
  assert.equal((await read(harness, 'chat-a')).ok, true);
});

test('an app chord pressed in the page goes to the main window and does not take over', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  let prevented = false;
  view.webContents.emit('before-input-event', { preventDefault() { prevented = true; } },
    { type: 'keyDown', key: 'k', control: true });
  assert.equal(prevented, true);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
  const main = harness.electron.window.webContents;
  assert.equal(main.focusCalls, 1);
  assert.deepEqual(main.inputEvents, [
    { type: 'keyDown', keyCode: 'k', modifiers: ['control'] },
    { type: 'keyUp', keyCode: 'k', modifiers: ['control'] },
  ]);
});

test('a crash mid-step replaces the page and the step answers page_crashed', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  harness.service.show('chat-a', { x: 5, y: 6, width: 700, height: 500 });
  const { hold, running } = await startBlockedRead(harness, 'chat-a', view);
  harness.electron.crash(view);
  const result = await running;
  assert.equal(result.status, 'page_crashed');
  assert.equal(result.message, 'The page crashed and was reset. Use navigate to open it again. Sign-ins are gone.');
  assert.equal(harness.electron.views.length, 2);
  assert.deepEqual(harness.electron.views[1].bounds, { x: 5, y: 6, width: 700, height: 500 });
  assert.deepEqual(harness.electron.window.contentView.children, [harness.electron.views[1]]);
  await waitFor(() => view.webContents.closeCalls.length === 1);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
  assert.equal(harness.service.getState('chat-a').busy, false);
  assert.equal((await nav(harness, 'chat-a', 'again')).ok, true, 'a navigate works at once, with no stale note');
  hold.resolve({ status: 'ok' });
});

test('an idle crash leaves a note: other actions get page_crashed once, navigate runs', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  harness.electron.crash(view);
  assert.equal(harness.electron.views.length, 2);
  assert.deepEqual(harness.electron.views[1].bounds, { x: -32000, y: 0, width: 1280, height: 800 });
  const first = await read(harness, 'chat-a');
  assert.equal(first.status, 'page_crashed');
  const readsOnNew = harness.electron.views[1].webContents.readerCalls.length;
  assert.equal(readsOnNew, 0, 'no action ran on the new page');
  assert.equal((await read(harness, 'chat-a')).ok, true, 'the note was cleared by being delivered');

  harness.electron.crash(harness.electron.views[1]);
  assert.equal((await nav(harness, 'chat-a', 'after-crash')).ok, true);
  assert.equal((await read(harness, 'chat-a', 'r2')).ok, true);
});

test('a crash while the user holds the browser returns it to the model', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  harness.service.takeOver('chat-a');
  harness.electron.crash(view);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
});

test('a host that cannot be rebuilt after a crash closes the page with a note', async () => {
  const electron = createFakeElectron();
  let fail = false;
  const harness = createBrowserUseHarness({
    createView: (options) => {
      if (fail) throw new Error('nope');
      return electron.createView(options);
    },
    sessionFromPartition: electron.sessionFromPartition,
    getMainWindow: electron.getMainWindow,
  });
  assert.equal((await nav(harness, 'chat-a')).ok, true);
  fail = true;
  electron.crash(electron.views[0]);
  assert.equal(harness.service.getState('chat-a').open, false);
  const note = await read(harness, 'chat-a');
  assert.equal(note.status, 'browser_closed');
  assert.match(note.message, /crashed/);
});

test('closing the page leaves the user\'s note and disposes the host', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  assert.deepEqual(await harness.service.close('chat-a'), { ok: true });
  assert.equal(view.webContents.closeCalls.length, 1);
  assert.equal(view.webContents.isDestroyed(), true);
  const note = await read(harness, 'chat-a');
  assert.equal(note.status, 'browser_closed');
  assert.equal(note.message, 'The user closed the browser page. Do not reopen it unless they ask.');
  assert.deepEqual(await harness.service.close('chat-a'), { ok: false, reason: 'no_page' });
  assert.equal((await nav(harness, 'chat-a', 'reopen')).ok, true);
});

test('a chat that reported back gives up its page, unless the user has it or a step is running', async () => {
  const harness = createBrowserUseHarness();
  assert.equal(harness.service.closeFinished('chat-a'), false, 'no page, nothing to close');
  const view = await open(harness, 'chat-a');
  assert.equal(harness.service.closeFinished('chat-a'), true);
  await waitFor(() => view.webContents.isDestroyed(), { label: 'the page is destroyed' });
  assert.equal(harness.service.getState('chat-a').open, false);
  const note = await harness.service.execute({ action: 'close' }, ctx({ callId: 'c-late', turnId: 't-late' }));
  assert.equal(note.status, 'browser_closed');
  assert.match(note.message, /already closed/, 'a later close request reads as done, not as a failure to close');

  await open(harness, 'chat-b');
  harness.service.takeOver('chat-b');
  assert.equal(harness.service.closeFinished('chat-b'), false, 'the user has it');
  assert.equal(harness.service.getState('chat-b').open, true);

  const busy = await open(harness, 'chat-c');
  const { hold, running } = await startBlockedRead(harness, 'chat-c', busy);
  assert.equal(harness.service.closeFinished('chat-c'), false, 'a step is running');
  hold.resolve({ status: 'ok' });
  await running;
});

test('closing while a step runs aborts it and the step reports the closed page', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  const { hold, running } = await startBlockedRead(harness, 'chat-a', view);
  await harness.service.close('chat-a');
  const result = await running;
  assert.equal(result.status, 'browser_closed');
  assert.equal(result.message, 'The user closed the browser page. Do not reopen it unless they ask.');
  hold.resolve({ status: 'ok' });
});

test('show, resize and hide move the view and remember the viewport size', async () => {
  const harness = createBrowserUseHarness();
  const view = await open(harness, 'chat-a');
  assert.equal(harness.service.show('chat-a', { x: 10, y: 20, width: 700, height: 500 }).ok, true);
  assert.deepEqual(view.bounds, { x: 10, y: 20, width: 700, height: 500 });
  assert.equal(harness.service.setBounds('chat-a', { x: 12, y: 22, width: 640, height: 480 }).ok, true);
  assert.deepEqual(view.bounds, { x: 12, y: 22, width: 640, height: 480 });
  assert.equal(harness.service.hide('chat-a').ok, true);
  assert.deepEqual(view.bounds, { x: -32000, y: 0, width: 640, height: 480 });
  assert.deepEqual(harness.service.setBounds('chat-a', { x: 1, y: 1, width: 5, height: 5 }), { ok: false, reason: 'not_shown' });
  assert.deepEqual(view.bounds, { x: -32000, y: 0, width: 640, height: 480 });
  for (const bounds of view.boundsHistory) assert.ok(bounds.width > 0 && bounds.height > 0);
});

test('panel controls on a chat with no page answer no_page; bad bounds are refused', async () => {
  const harness = createBrowserUseHarness();
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  for (const result of [
    harness.service.show('nope', bounds), harness.service.setBounds('nope', bounds), harness.service.hide('nope'),
    harness.service.takeOver('nope'), harness.service.handBack('nope'), await harness.service.capture('nope'),
    await harness.service.close('nope'),
  ]) assert.deepEqual(result, { ok: false, reason: 'no_page' });
  await open(harness, 'chat-a');
  assert.deepEqual(harness.service.show('chat-a', { x: 0, y: 0, width: 0, height: 10 }), { ok: false, reason: 'invalid_bounds' });
  assert.deepEqual(harness.service.show('chat-a', null), { ok: false, reason: 'invalid_bounds' });
});

test('capture returns the page image', async () => {
  const harness = createBrowserUseHarness();
  await open(harness, 'chat-a');
  const shot = await harness.service.capture('chat-a');
  assert.equal(shot.ok, true);
  assert.match(shot.data_url, /^data:image\/jpeg;base64,/);
});

test('closed notes are bounded to 32, oldest dropped', async () => {
  const harness = createBrowserUseHarness();
  for (let i = 0; i < 34; i += 1) {
    await open(harness, `chat-${i}`);
    await harness.service.close(`chat-${i}`);
  }
  assert.equal((await read(harness, 'chat-0')).status, 'no_page');
  assert.equal((await read(harness, 'chat-1')).status, 'no_page');
  assert.equal((await read(harness, 'chat-2')).status, 'browser_closed');
  assert.equal((await read(harness, 'chat-33')).status, 'browser_closed');
});

test('dispose aborts running steps, closes every page and refuses later calls', async () => {
  const harness = createBrowserUseHarness();
  const viewA = await open(harness, 'chat-a');
  const viewB = await open(harness, 'chat-b');
  const { hold, running } = await startBlockedRead(harness, 'chat-a', viewA);
  await harness.service.dispose();
  assert.equal((await running).status, 'unavailable');
  for (const view of [viewA, viewB]) {
    assert.equal(view.webContents.closeCalls.length, 1);
    assert.equal(view.webContents.isDestroyed(), true);
  }
  assert.equal(harness.electron.window.contentView.children.length, 0);
  const later = await nav(harness, 'chat-c');
  assert.equal(later.ok, false);
  assert.equal(later.status, 'unavailable');
  assert.equal(harness.electron.views.length, 2);
  assert.equal(harness.service.getState('chat-a').open, false);
  assert.equal(harness.service.show('chat-a', { x: 0, y: 0, width: 10, height: 10 }).ok, false);
  await harness.service.dispose();
  hold.resolve({ status: 'ok' });
});

test('dispose waits for pages that were closing and survives an unproven destruction', async () => {
  const harness = createBrowserUseHarness({}, { webContents: { autoDestroy: false } });
  await open(harness, 'chat-a');
  const disposing = harness.service.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  harness.timers.tick(2000);
  await disposing;
  assert.ok(harness.logs.some((entry) => entry.event === 'browser_use.dispose_unproven'));
});

test('a closed page cancels its inactivity timer', async () => {
  const harness = createBrowserUseHarness();
  await open(harness, 'chat-a');
  assert.equal(harness.timers.pending(), 1);
  await harness.service.close('chat-a');
  assert.equal(harness.timers.pending(), 0);
});
