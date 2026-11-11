'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserUseHarness, deferred, holdEventLoop, waitFor } = require('./helpers/fake-browser-use-electron');

holdEventLoop(test);

const ctx = (extra = {}) => ({
  sessionId: 'chat-a', turnId: 'turn-1', callId: 'call-1', userText: 'please open example.com', ...extra,
});
const navigate = (service, url = 'https://example.com/', extra = {}) => service.execute({ action: 'navigate', url }, ctx(extra));

async function openPage(harness, extra = {}) {
  const result = await navigate(harness.service, 'https://example.com/', extra);
  assert.equal(result.ok, true, JSON.stringify(result));
  return harness.electron.views.at(-1);
}

test('the first navigate opens a page and returns it; the view is placed from the start', async () => {
  const harness = createBrowserUseHarness();
  const result = await navigate(harness.service);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'navigated');
  assert.equal(result.page.text, 'Outline text');
  assert.equal(harness.electron.views.length, 1);
  const { bounds } = harness.electron.views[0];
  assert.deepEqual(bounds, { x: -32000, y: 0, width: 1280, height: 800 });
  harness.electron.views[0].webContents.state.title = 'Example';
  const { failed, note, pending_url: pendingUrl, can_back: canBack, can_forward: canForward, zoom, find, signed_in: signedIn, ...state } = harness.service.getState('chat-a');
  assert.deepEqual({ failed, note, pendingUrl, canBack, canForward, zoom, find, signedIn }, { failed: '', note: null, pendingUrl: '', canBack: false, canForward: false, zoom: 1, find: null, signedIn: false });
  assert.deepEqual(state, {
    open: true, mode: 'model', url: 'https://example.com/', title: 'Example', loading: false, busy: false, action: '', target: '', crashed: false, user_touched: false, stopped_short: false, closed_reason: '', asking: false, waiting: false, ad_block: true, ad_block_by: '', sound: null,
  });
});

test('every action before a navigate answers no_page and opens nothing', async () => {
  const harness = createBrowserUseHarness();
  for (const action of ['read', 'find', 'click', 'type', 'select', 'scroll', 'press', 'screenshot']) {
    const result = await harness.service.execute({ action, ref: 'r1', query: 'x' }, ctx());
    assert.equal(result.ok, false, action);
    assert.equal(result.status, 'no_page', action);
    assert.equal(result.message, 'No page is open. Use navigate to open one.');
  }
  assert.equal(harness.electron.views.length, 0);
  assert.deepEqual(harness.service.getState('chat-a'), {
    open: false, mode: 'model', url: '', title: '', loading: false, busy: false, action: '', target: '', asking: false, waiting: false, closed_reason: '',
  });
});

test('close shuts the page, says so, and later steps are told it is closed', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness);
  const result = await harness.service.execute({ action: 'close' }, ctx());
  assert.equal(result.ok, true);
  assert.equal(result.status, 'closed');
  const state = harness.service.getState('chat-a');
  assert.equal(state.open, false);
  assert.equal(state.closed_reason, 'user');
  await waitFor(() => harness.electron.views.at(-1).webContents.isDestroyed());
  const after = await harness.service.execute({ action: 'read' }, ctx());
  assert.equal(after.status, 'browser_closed');
  assert.match(after.message, /You closed the browser page/u);
  const reopened = await navigate(harness.service);
  assert.equal(reopened.ok, true, 'a new page can still be opened');
});

test('close with nothing open opens nothing', async () => {
  const harness = createBrowserUseHarness();
  const result = await harness.service.execute({ action: 'close' }, ctx());
  assert.equal(result.status, 'no_page');
  assert.equal(harness.electron.views.length, 0);
});

test('close leaves a page the user is holding alone', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness);
  harness.service.takeOver('chat-a');
  const result = await harness.service.execute({ action: 'close' }, ctx({ turnId: 'turn-2', callId: 'call-2' }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.equal(harness.service.getState('chat-a').open, true);
});

test('the state says whether the last step worked', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness);
  assert.equal(harness.service.getState('chat-a').stopped_short, false);
  const refused = await harness.service.execute({ action: 'navigate', url: 'file:///C:/secret.txt' }, ctx());
  assert.equal(refused.ok, false);
  assert.equal(harness.service.getState('chat-a').stopped_short, true);
  await navigate(harness.service);
  assert.equal(harness.service.getState('chat-a').stopped_short, false, 'a later step that works clears it');
});

test('each chat gets its own partition, grants and page', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness, { sessionId: 'chat-a' });
  await openPage(harness, { sessionId: 'chat-b' });
  const partitions = harness.electron.viewOptions.map((options) => options.webPreferences.partition);
  assert.equal(new Set(partitions).size, 2);
  assert.equal(harness.service.getState('chat-a').open, true);
  assert.equal(harness.service.getState('chat-b').open, true);
});

test('an unknown action is invalid_arguments and never opens a page', async () => {
  const harness = createBrowserUseHarness();
  for (const input of [{ action: 'constructor' }, { action: '__proto__' }, { action: 'hasOwnProperty' }, { action: 'bogus' },
    { action: 7 }, {}, null, 'navigate', [] ]) {
    const result = await harness.service.execute(input, ctx());
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.status, 'invalid_arguments', JSON.stringify(input));
  }
  assert.equal(harness.electron.views.length, 0);
});

test('a throw from the action layer becomes a generic failure with no error text', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  view.webContents.reload = () => { throw new Error('secret C:\\Users\\someone\\file.txt'); };
  const result = await harness.service.execute({ action: 'navigate', url: 'reload' }, ctx({ callId: 'c2' }));
  assert.deepEqual(result,{ ok: false, status: 'unavailable', message: 'The browser step failed.' });
  assert.equal(harness.service.getState('chat-a').busy, false);
  assert.equal(harness.service.getState('chat-a').open, true);
});

test('a view that cannot be created answers unavailable and leaves no entry', async () => {
  const harness = createBrowserUseHarness({}, { createViewFails: true });
  const result = await navigate(harness.service);
  assert.deepEqual(result, { ok: false, status: 'unavailable', message: 'The browser could not start.' });
  assert.equal(harness.service.getState('chat-a').open, false);
  assert.doesNotMatch(JSON.stringify(harness.logs), /secret|C:\\\\/);
});

test('no main window also answers unavailable', async () => {
  const harness = createBrowserUseHarness({}, { noWindow: true });
  const result = await navigate(harness.service);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.message, 'The browser could not start.');
});

test('a new site asks the user once per chat; a decline is final and grants stay in the chat', async () => {
  const harness = createBrowserUseHarness();
  const asked = [];
  const authorize = async (request) => { asked.push(request.messageFields.browser_approval.host); return { approved: true }; };
  const first = await navigate(harness.service, 'https://news.example.org/a', { authorize, userText: '' });
  assert.equal(first.ok, true);
  assert.deepEqual(asked, ['news.example.org']);
  const again = await navigate(harness.service, 'https://news.example.org/b', { authorize, userText: '' });
  assert.equal(again.ok, true);
  assert.equal(asked.length, 1, 'the grant is remembered for this chat');
  const other = await navigate(harness.service, 'https://news.example.org/a', { authorize, userText: '', sessionId: 'chat-b' });
  assert.equal(other.ok, true);
  assert.equal(asked.length, 2, 'another chat does not share the grant');
  const declined = await navigate(harness.service, 'https://shop.example.net/', { authorize: async () => false, userText: '' });
  assert.equal(declined.ok, false);
  assert.equal(declined.status, 'declined');
});

test('a refused address never reaches a page, and opens none', async () => {
  const harness = createBrowserUseHarness();
  const result = await navigate(harness.service, 'http://127.0.0.1:11434/api/tags');
  assert.equal(result.status, 'refused');
  assert.equal(harness.electron.views.length, 0);
  assert.equal(harness.service.getState('chat-a').open, false);
});

test('a chat whose first address is refused does not close another chat\'s page', async () => {
  const harness = createBrowserUseHarness({ maxPages: 2 });
  await openPage(harness, { sessionId: 'chat-a' });
  await openPage(harness, { sessionId: 'chat-b' });
  const refused = await navigate(harness.service, 'file:///C:/Windows/win.ini', { sessionId: 'chat-c' });
  assert.equal(refused.status, 'refused');
  assert.match(refused.message, /^Refused: only http and https pages can be opened\. Send a full address/);
  assert.equal(harness.service.getState('chat-a').open, true);
  assert.equal(harness.service.getState('chat-b').open, true);
  assert.equal(harness.electron.views.length, 2);
});

test('a navigate word on a chat with no page still reaches the page layer', async () => {
  const harness = createBrowserUseHarness();
  const result = await navigate(harness.service, 'back');
  assert.notEqual(result.status, 'refused');
});

test('the step budget counts every call, refuses past the limit, and resets on a new turn', async () => {
  const harness = createBrowserUseHarness({ maxStepsPerTurn: 3 });
  await openPage(harness);
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await harness.service.execute({ action: 'read' }, ctx({ callId: `c${i + 2}` }))).ok, true);
  }
  const over = await harness.service.execute({ action: 'read' }, ctx({ callId: 'c9' }));
  assert.equal(over.ok, false);
  assert.equal(over.status, 'step_limit');
  assert.equal(over.message, 'You have used all 3 browser steps for this turn. Stop here and tell the user where you got to.');
  const next = await harness.service.execute({ action: 'read' }, ctx({ turnId: 'turn-2', callId: 'c10' }));
  assert.equal(next.ok, true);
});

test('the call id stands in for a missing turn id', async () => {
  const harness = createBrowserUseHarness({ maxStepsPerTurn: 1 });
  const bare = { sessionId: 'chat-a', turnId: '', userText: 'example.com' };
  assert.equal((await harness.service.execute({ action: 'navigate', url: 'https://example.com/' }, { ...bare, callId: 'x1' })).ok, true);
  assert.equal((await harness.service.execute({ action: 'read' }, { ...bare, callId: 'x2' })).ok, true);
  assert.equal((await harness.service.execute({ action: 'read' }, { ...bare, callId: 'x2' })).status, 'step_limit');
});

test('Stop cancels the running step, stops the page and leaves it open', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  const hold = deferred();
  view.webContents.readerOps.read = () => hold.promise;
  const stop = new AbortController();
  const running = harness.service.execute({ action: 'read' }, ctx({ abortSignal: stop.signal, callId: 'c2' }));
  await waitFor(() => harness.service.getState('chat-a').busy);
  stop.abort();
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(view.webContents.stopCalls, 1);
  assert.equal(harness.service.getState('chat-a').open, true);
  assert.equal(harness.service.getState('chat-a').busy, false);
  view.webContents.readerOps.read = () => ({ status: 'ok', url: 'https://example.com/', title: 'Again', text: 'Back' });
  assert.equal((await harness.service.execute({ action: 'read' }, ctx({ callId: 'c3' }))).page.text, 'Back');
  hold.resolve();
});

test('an already stopped call does nothing', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness);
  const stop = new AbortController();
  stop.abort();
  const before = harness.electron.views[0].webContents.readerCalls.length;
  const result = await harness.service.execute({ action: 'read' }, ctx({ abortSignal: stop.signal, callId: 'c2' }));
  assert.equal(result.status, 'cancelled');
  assert.equal(harness.electron.views[0].webContents.readerCalls.length, before);
});

test('a take-over during a step keeps it open, and a hand back returns the page as it is now', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  const hold = deferred();
  view.webContents.readerOps.read = () => hold.promise;
  const clocks = { suspended: 0, resumed: 0 };
  const suspendTurnClocks = () => { clocks.suspended += 1; return () => { clocks.resumed += 1; }; };
  let settled = false;
  const running = harness.service.execute({ action: 'read' }, ctx({ callId: 'c2', suspendTurnClocks }));
  running.then(() => { settled = true; });
  await waitFor(() => harness.service.getState('chat-a').busy);
  assert.equal(harness.service.takeOver('chat-a').ok, true);
  await waitFor(() => clocks.suspended === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, 'the step is still open');
  assert.equal(clocks.resumed, 0, 'the turn clocks stay stopped while the user has the page');
  assert.equal(harness.service.getState('chat-a').mode, 'user');
  harness.timers.tick(4000);
  view.webContents.readerOps.read = () => ({ status: 'ok', url: 'https://example.com/', title: 'Yours', text: 'What the user left' });
  harness.service.handBack('chat-a');
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'handed_back');
  assert.match(result.message, /handed the browser back/);
  assert.equal(result.page.text, 'What the user left');
  assert.equal(result.humanWaitMs, 4000);
  assert.equal(clocks.resumed, 1);
  hold.resolve();
});

test('the wait for an approval and the wait for the user add up', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  const asked = deferred();
  const answer = deferred();
  const authorize = () => { asked.resolve(); return answer.promise; };
  const hold = deferred();
  view.webContents.readerOps.status = () => hold.promise;
  const statusCallsBefore = view.webContents.readerCalls.filter((call) => call.op === 'status').length;
  let waiting = false;
  const running = harness.service.execute({ action: 'navigate', url: 'https://shop.example.net/' },
    ctx({ authorize, userText: '', callId: 'c2', suspendTurnClocks: () => { waiting = true; return () => {}; } }));
  await asked.promise;
  harness.timers.tick(300);
  answer.resolve(true);
  await waitFor(() => view.webContents.readerCalls.filter((call) => call.op === 'status').length > statusCallsBefore);
  harness.service.takeOver('chat-a');
  await waitFor(() => waiting);
  harness.timers.tick(200);
  harness.service.handBack('chat-a');
  const result = await running;
  assert.equal(result.status, 'handed_back');
  assert.equal(result.humanWaitMs, 500);
  hold.resolve({ msSinceMutation: 5000 });
});

test('a step that arrives while the user holds the browser waits, touches nothing and is not counted', async () => {
  const harness = createBrowserUseHarness({ maxStepsPerTurn: 2 });
  const view = await openPage(harness);
  harness.service.takeOver('chat-a');
  const pageActions = () => view.webContents.log.filter(({ name }) => !['getURL', 'getTitle', 'isLoading', 'canGoBack', 'canGoForward'].includes(name)).length;
  const before = pageActions();
  let waiting = false;
  const pending = harness.service.execute({ action: 'navigate', url: 'https://example.com/x' },
    ctx({ callId: 'p1', suspendTurnClocks: () => { waiting = true; return () => {}; } }));
  await waitFor(() => waiting);
  assert.equal(pageActions(), before, 'the page was not touched');
  assert.equal(harness.service.handBack('chat-a').ok, true);
  assert.equal(harness.service.getState('chat-a').mode, 'model');
  assert.equal((await pending).status, 'handed_back');
  const resumed = await harness.service.execute({ action: 'read' }, ctx({ callId: 'p9' }));
  assert.equal(resumed.ok, true, 'the step that waited was not counted');
});

test('calls for one chat run one at a time in order', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  const hold = deferred();
  let reads = 0;
  view.webContents.readerOps.read = () => {
    reads += 1;
    return reads === 1 ? hold.promise.then(() => ({ status: 'ok', text: 'first' })) : { status: 'ok', text: 'second' };
  };
  const first = harness.service.execute({ action: 'read' }, ctx({ callId: 'c2' }));
  await waitFor(() => reads === 1);
  const second = harness.service.execute({ action: 'read' }, ctx({ callId: 'c3' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, 1, 'the second call waits behind the first');
  hold.resolve();
  assert.equal((await first).page.text, 'first');
  assert.equal((await second).page.text, 'second');
  assert.equal(reads, 2);
});

test('the reader is built per call on the actions view of the page', async () => {
  const harness = createBrowserUseHarness();
  const view = await openPage(harness);
  const { readerCalls } = view.webContents;
  assert.ok(readerCalls.length > 0);
  assert.ok(readerCalls.every((call) => call.worldId === 1001));
  assert.ok(readerCalls.every((call) => call.args.generation >= 1));
});

test('changes are pushed with the chat id and no URL in the logs', async () => {
  const harness = createBrowserUseHarness();
  await openPage(harness);
  const pushes = harness.events.filter((event) => event.methodPath === 'browserUse.onChanged');
  assert.ok(pushes.length > 0);
  assert.ok(pushes.every((push) => push.payload.session_id === 'chat-a'));
  assert.ok(pushes.some((push) => push.payload.open === true && push.payload.busy === true));
  assert.equal(pushes.at(-1).payload.busy, false);
  assert.doesNotMatch(JSON.stringify(harness.logs), /example\.com/);
});
