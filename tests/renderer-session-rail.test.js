'use strict';

/* Row 59 checkpoint 2, slice S3: the per-pane session rail controller in jsdom, against a fake
   chatWorkspace bridge (contract C2) and a fake detail API (contract C3). Layout is covered by
   tests/renderer-session-rail-layout.test.js in headless Chromium; here: data flow, the hosted
   placement, disclosures and their persistence, focus, disposal. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { hostInDocument, flush, sleep, deferred, summaryFor, createBridge, createFixture, docked } = require('./helpers/session-rail-fixture.js');
const rails = require('../renderer/chat/renderer-session-rail.js');

test('next-send estimate: the head counts the local draft, and a failed read keeps the last head marked stale', async (t) => {
  let failed = false;
  const bridge = createBridge({ respond: ({ session_id }) => ({ ok: true,
    summary: summaryFor(session_id, { context: { state: failed ? 'checking' : 'available', data: failed
      ? null
      : { scope: 'next_send', measurement: 'estimated', used_tokens: 100, capacity_tokens: 1000,
        available_tokens: 900, reserve_tokens: 100,
        breakdown: { messages: 0, system_prompt: 100, tools: 0, instructions: 0, skills: 0, other: 0 } } } }),
  }) });
  const f = await docked({ bridge });
  t.after(() => { f.api.dispose(); f.window.close(); });
  f.head('context').click();
  assert.equal(f.section('context').querySelectorAll('.session-context-category').length, 0, 'the token ledger is not in the rail');
  assert.equal(f.value('context'), '10% full');
  const input = f.doc.getElementById('chatInput');
  input.value = 'a'.repeat(400);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(f.value('context'), '20% full');
  failed = true;
  f.api.refresh();
  await flush();
  assert.match(f.value('context'), /20% full.*stale/);
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'true');
});

test('the rail paints a newer shared estimate and never republishes a stale reading', async (t) => {
  const contextPreview = require('../renderer/chat/renderer-context-preview.js');
  let failed = false;
  const estimate = (used) => ({ scope: 'next_send', measurement: 'estimated', used_tokens: used, capacity_tokens: 1000,
    available_tokens: 1000 - used, reserve_tokens: 0, breakdown: { messages: 0, system_prompt: used, tools: 0, instructions: 0, skills: 0, other: 0 } });
  const bridge = createBridge({ respond: ({ session_id }) => ({ ok: true,
    summary: summaryFor(session_id, { context: { state: failed ? 'checking' : 'available', data: failed ? null : estimate(100) } }) }) });
  const f = await docked({ bridge });
  t.after(() => { f.api.dispose(); f.window.close(); contextPreview.resetForTests(); });
  assert.equal(f.value('context'), '10% full');
  contextPreview.remember('sess_a', estimate(300)); // the ring's popover fetched a newer estimate
  await sleep(50);
  assert.equal(f.value('context'), '30% full');
  failed = true;
  f.api.refresh();
  await flush();
  assert.match(f.value('context'), /10% full.*stale/);
  assert.equal(contextPreview.latest('sess_a').data.used_tokens, 300, 'the carried-forward reading is not republished');
});

test('an invalidation during a summary read rejects the obsolete response', async (t) => {
  const pending = deferred();
  let requests = 0;
  const bridge = createBridge({ respond: ({ session_id }) => {
    requests += 1;
    return requests === 1 ? pending.promise : { ok: true, summary: summaryFor(session_id) };
  } });
  const f = createFixture({ bridge });
  t.after(() => { f.api.dispose(); f.window.close(); });
  bridge.emit({ session_id: 'sess_a' });
  await sleep(150);
  pending.resolve({ ok: true, summary: summaryFor('sess_a', { environment: {
    state: 'available', data: { project_name: 'Obsolete project', run_mode: 'ask' },
  } }) });
  await flush();
  assert.doesNotMatch(f.text('this_chat'), /Obsolete/);
  assert.equal(requests, 2);
});

test('mount: asks for this pane\u2019s own session and paints This chat, Context and Running now in order', async () => {
  const f = await docked({ sessionId: 'sess_a' });
  assert.deepEqual(f.bridge.summaryCalls, [{ schema_version: 1, session_id: 'sess_a' }]);
  assert.deepEqual([...f.doc.querySelectorAll('[data-section]')].map((node) => node.dataset.section), ['this_chat', 'context', 'running_now']);
  assert.equal(f.pane.dataset.sessionRail, 'hosted');
  assert.equal(f.rail().hidden, false);
  assert.equal(f.rail().parentNode, f.doc.getElementById('railHost'), 'the rail sits in the workbench host');
  assert.equal(f.rail().querySelector('.session-rail-tray') !== null, true, 'the tray lives in the hosted rail');
  assert.equal(f.value('this_chat'), 'Local');
  assert.equal(f.value('context'), '64% full');
  assert.equal(f.value('running_now'), '1');
  assert.match(f.text('running_now'), /Workspace testsRunning.*All runs/);
  assert.match(f.text('this_chat'), /Some sources aren't connected yet\./, 'a really partial summary keeps its one note');
  assert.match(f.text('this_chat'), /project of sess_a/);
  assert.match(f.text('context'), /Used20\.5k of 32kJenny summarises older messages when this fills\.Context details/);
  f.api.dispose();
});

test('first paint is checking words, never zeros', async () => {
  const gate = deferred();
  const bridge = createBridge({ respond: () => gate.promise });
  const f = createFixture({ bridge });
  assert.equal(f.value('context'), 'Checking\u2026');
  assert.equal(f.value('this_chat'), 'Checking\u2026');
  assert.doesNotMatch(f.doc.querySelector('.session-rail-tray').textContent, /\d/);
  gate.resolve({ schema_version: 1, ok: true, summary: summaryFor('sess_a'), workspace_view: bridge.view, coordination_revision: 0 });
  await flush();
  assert.equal(f.value('context'), '64% full');
  f.api.dispose();
});

test('a failed first fetch reads unavailable; a failed refetch keeps the last values marked stale', async () => {
  let mode = 'fail';
  const bridge = createBridge({
    respond: (request, b) => {
      if (mode === 'fail') throw new Error('offline');
      if (mode === 'bad') return { schema_version: 1, ok: false, error_code: 'CMP-CHATWS-0001', reason: 'unavailable', retryable: false, current_revision: null };
      return { schema_version: 1, ok: true, summary: summaryFor(request.session_id), workspace_view: b.view, coordination_revision: 0 };
    },
  });
  const f = await docked({ bridge });
  assert.equal(f.value('this_chat'), 'Unavailable');
  assert.equal(f.value('context'), 'Unavailable');
  mode = 'ok';
  f.api.refresh();
  await flush();
  assert.equal(f.value('context'), '64% full');
  mode = 'bad';
  f.api.refresh();
  await flush();
  assert.equal(f.value('context'), '64% full \u00b7 stale', 'the last reading stays, labelled stale');
  assert.equal(f.section('context').dataset.state, 'stale');
  f.api.dispose();
});

test('disclosures: defaults where null, one control per section with aria-expanded', async () => {
  const f = await docked();
  const expanded = (key) => f.head(key).getAttribute('aria-expanded');
  assert.deepEqual(['this_chat', 'context', 'running_now'].map(expanded), ['true', 'false', 'true']);
  assert.equal(f.head('context').getAttribute('aria-controls'), f.section('context').querySelector('[data-rail-body]').id);
  f.api.dispose();
});

test('toggling a section is optimistic, writes the disclosure with the current revision, and settles on the persisted view', async () => {
  const bridge = createBridge();
  bridge.revision = 7;
  const gate = deferred();
  bridge.setViewHandler = async (request) => {
    await gate.promise;
    bridge.view = { ...bridge.view, disclosures: { ...bridge.view.disclosures, ...request.patch.disclosures } };
    return { schema_version: 1, ok: true, workspace_view: bridge.view, coordination_revision: 8 };
  };
  const f = await docked({ bridge });
  f.head('context').click();
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'true', 'optimistic: open before the write returns');
  await flush();
  assert.deepEqual(bridge.setViewCalls, [{ schema_version: 1, session_id: 'sess_a', expected_revision: 7, patch: { disclosures: { context: true } } }]);
  gate.resolve();
  await flush();
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'true');
  f.head('context').click();
  await flush();
  assert.equal(bridge.setViewCalls[1].expected_revision, 8, 'the next write uses the revision the last one returned');
  assert.deepEqual(bridge.setViewCalls[1].patch, { disclosures: { context: false } });
  f.api.dispose();
});

test('a summary read before a later write landed never rolls the view or the revision back', async () => {
  const bridge = createBridge();
  const slow = deferred();
  const f = await docked({ bridge });
  bridge.getSummary = async (request) => {
    bridge.summaryCalls.push(request);
    await slow.promise;
    return { schema_version: 1, ok: true, summary: summaryFor(request.session_id, { revision: 0 }), workspace_view: { schema_version: 1, rail_visible: null, disclosures: {}, children_expanded: null }, coordination_revision: 0 };
  };
  bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: 0 });
  await flush();
  f.head('context').click();
  await flush();
  assert.equal(bridge.setViewCalls.length, 1);
  slow.resolve();
  await flush();
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'true', 'the late summary carried the older view');
  f.head('context').click();
  await flush();
  assert.equal(bridge.setViewCalls[1].expected_revision, 1, 'the next write still uses the newer revision');
  f.api.dispose();
});

test('a write that conflicts twice refetches once and reverts the toggle', async () => {
  const bridge = createBridge();
  bridge.setViewHandler = async () => ({ schema_version: 1, ok: false, error_code: 'CMP-CHATWS-0004', reason: 'revision_conflict', retryable: true, current_revision: 9 });
  const f = await docked({ bridge });
  const before = bridge.summaryCalls.length;
  f.head('this_chat').click();
  assert.equal(f.head('this_chat').getAttribute('aria-expanded'), 'false', 'optimistic collapse');
  await flush(10);
  assert.equal(bridge.setViewCalls[0].patch.disclosures.environment, false, 'This chat persists under the service\u2019s own key');
  assert.equal(bridge.setViewCalls.length, 2, 'one re-send at the current revision, then give up');
  assert.equal(bridge.setViewCalls[1].expected_revision, 9);
  assert.equal(bridge.summaryCalls.length, before + 1, 'exactly one refetch');
  assert.equal(f.head('this_chat').getAttribute('aria-expanded'), 'true', 'reverted to the persisted default');
  f.api.dispose();
});

test('review #8: a proposal write that bumped the revision does not lose the toggle', async () => {
  const bridge = createBridge();
  let calls = 0;
  bridge.setViewHandler = async (request) => {
    calls += 1;
    if (calls === 1) return { schema_version: 1, ok: false, error_code: 'CMP-CHATWS-0004', reason: 'revision_conflict', retryable: true, current_revision: 12 };
    bridge.view = { ...bridge.view, disclosures: { ...bridge.view.disclosures, ...request.patch.disclosures } };
    return { schema_version: 1, ok: true, workspace_view: bridge.view, coordination_revision: 13 };
  };
  const f = await docked({ bridge });
  f.head('this_chat').click();
  await flush(10);
  assert.equal(bridge.setViewCalls.length, 2);
  assert.equal(bridge.setViewCalls[1].expected_revision, 12);
  assert.deepEqual(bridge.setViewCalls[1].patch, bridge.setViewCalls[0].patch, 'the same idempotent patch');
  assert.equal(f.head('this_chat').getAttribute('aria-expanded'), 'false', 'the toggle stuck');
  f.api.dispose();
});

test('a thrown write reverts too', async () => {
  const bridge = createBridge();
  bridge.setViewHandler = async () => { throw new Error('ipc closed'); };
  const f = await docked({ bridge });
  f.head('context').click();
  await flush(10);
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'false');
  f.api.dispose();
});

test('persisted disclosures from the profile win over the defaults', async () => {
  const bridge = createBridge();
  bridge.view = { schema_version: 1, disclosures: { environment: false, context: true }, children_expanded: null };
  const f = await docked({ bridge });
  assert.equal(f.head('this_chat').getAttribute('aria-expanded'), 'false');
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'true');
  assert.equal(f.head('running_now').getAttribute('aria-expanded'), 'true', 'an unset key keeps its default');
  f.api.dispose();
});

test('session change: clears to checking at once, fetches the new session, ignores a late answer for the old one', async () => {
  const gates = new Map();
  const bridge = createBridge({
    respond: (request) => {
      const gate = deferred();
      gates.set(request.session_id, gate);
      return gate.promise.then(() => ({ schema_version: 1, ok: true, summary: summaryFor(request.session_id), workspace_view: bridge.view, coordination_revision: 0 }));
    },
  });
  const f = createFixture({ bridge, sessionId: 'sess_a' });
  await flush();
  gates.get('sess_a').resolve();
  await flush();
  assert.match(f.text('this_chat'), /project of sess_a/);
  f.changeSession('sess_b');
  assert.equal(f.value('context'), 'Checking\u2026', 'never another session\u2019s values during a switch');
  assert.doesNotMatch(f.doc.querySelector('.session-rail-tray').textContent, /sess_a/);
  await flush();
  assert.equal(f.bridge.summaryCalls.at(-1).session_id, 'sess_b');
  f.changeSession('sess_c');
  await flush();
  gates.get('sess_b').resolve();
  await flush();
  assert.doesNotMatch(f.doc.querySelector('.session-rail-tray').textContent, /sess_b/, 'a late answer for a session the pane left is dropped');
  gates.get('sess_c').resolve();
  await flush();
  assert.match(f.text('this_chat'), /project of sess_c/);
  f.api.dispose();
});

test('a session switch paints "Checking..." with data-no-motion on the tray, and leaves none behind', async (t) => {
  const f = await docked({ sessionId: 'sess_a' });
  t.after(() => { f.api.dispose(); f.window.close(); });
  const tray = f.doc.querySelector('.session-rail-tray');
  const seen = [];
  const observer = new f.window.MutationObserver((records) => {
    for (const record of records) if (record.attributeName === 'data-no-motion') seen.push(tray.hasAttribute('data-no-motion'));
  });
  observer.observe(tray, { attributes: true, attributeFilter: ['data-no-motion'], attributeOldValue: true });
  f.changeSession('sess_b');
  assert.equal(f.value('context'), 'Checking…', 'the switch cleared to checking');
  const records = observer.takeRecords();
  observer.disconnect();
  assert.deepEqual(records.map((record) => [record.attributeName, record.oldValue]), [['data-no-motion', null], ['data-no-motion', '']],
    'data-no-motion was set around the paint and removed again');
  assert.equal(tray.hasAttribute('data-no-motion'), false);
  assert.equal(seen.length, 0, 'no observer callback ran with the attribute left on');
});

test('a session change also drops unconfirmed toggles and the persisted view of the old session', async () => {
  const bridge = createBridge();
  bridge.view = { schema_version: 1, disclosures: { context: true }, children_expanded: null };
  const f = await docked({ bridge });
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'true');
  bridge.view = { schema_version: 1, disclosures: {}, children_expanded: null };
  f.changeSession('sess_b');
  await flush();
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'false');
  f.api.dispose();
});

test('no session in the pane: nothing to show, the rail steps aside', async () => {
  const f = await docked({ sessionId: '' });
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  assert.equal(f.rail().hidden, true);
  assert.equal(f.bridge.summaryCalls.length, 0);
  f.changeSession('sess_a');
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'hosted');
  assert.equal(f.rail().hidden, false);
  assert.equal(f.bridge.summaryCalls.length, 1);
  f.api.dispose();
});

test('onChanged for this session refetches (coalesced); another session\u2019s event is ignored; no polling', async () => {
  const f = await docked();
  assert.equal(f.bridge.summaryCalls.length, 1);
  f.bridge.emit({ schema_version: 1, session_id: 'sess_other', revision: 3 });
  await sleep(180);
  assert.equal(f.bridge.summaryCalls.length, 1, 'another session\u2019s invalidation is not ours');
  f.bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: 5 });
  f.bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: 6 });
  f.bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: 7 });
  await sleep(220);
  assert.equal(f.bridge.summaryCalls.length, 2, 'three invalidations, one request');
  await sleep(300);
  assert.equal(f.bridge.summaryCalls.length, 2, 'nothing polls');
  f.api.dispose();
});

test('one request in flight: an invalidation during a fetch queues exactly one follow-up', async () => {
  const gates = [];
  const bridge = createBridge({
    respond: (request) => { const gate = deferred(); gates.push(gate); return gate.promise.then(() => ({ schema_version: 1, ok: true, summary: summaryFor(request.session_id), workspace_view: bridge.view, coordination_revision: 0 })); },
  });
  const f = createFixture({ bridge });
  await flush();
  assert.equal(bridge.summaryCalls.length, 1);
  f.api.refresh();
  f.api.refresh();
  f.api.refresh();
  await flush();
  assert.equal(bridge.summaryCalls.length, 1, 'still one in flight');
  gates[0].resolve();
  await flush();
  assert.equal(bridge.summaryCalls.length, 2, 'one follow-up for the burst');
  gates[1].resolve();
  await flush();
  assert.equal(bridge.summaryCalls.length, 2);
  f.api.dispose();
});

test('a rail nobody can see does not refetch on invalidations; it catches up when hosted', async () => {
  rails.configure({ getHost: () => null });
  const f = await docked();
  assert.equal(f.pane.dataset.sessionRail, 'hidden', 'another pane is focused');
  assert.equal(f.bridge.summaryCalls.length, 0, 'a rail nobody sees does not even fetch on mount');
  f.bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: 9 });
  await sleep(200);
  assert.equal(f.bridge.summaryCalls.length, 0, 'hidden: no refetch');
  rails.configure({ getHost: hostInDocument });
  rails.syncHosts();
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'hosted');
  assert.equal(f.bridge.summaryCalls.length, 1, 'being hosted fetches what was missed, once');
  f.api.dispose();
});

/* Row 176 / row 195: the chat's browser page is a row of Running now (renderer-session-rail.js with the jobs helper). */
function browserBridge(states = {}) {
  const bridge = {
    closes: [], listeners: new Set(), states, stateCalls: 0,
    getState: async ({ session_id }) => { bridge.stateCalls += 1; return bridge.states[session_id] || { ok: true, open: false }; },
    close: async (payload) => { bridge.closes.push(payload); return { ok: true }; },
    onChanged: (listener) => { bridge.listeners.add(listener); return () => bridge.listeners.delete(listener); },
    push: (event) => { for (const listener of [...bridge.listeners]) listener(event); },
  };
  return bridge;
}

test('Running now: the chat\'s open browser page is a row that opens the Browser panel and closes itself; the section leaves with the last run', async (t) => {
  const bu = browserBridge({ sess_a: { ok: true, open: true, url: 'https://example.com/docs', title: 'Example docs' } });
  const f = await docked({ mountOptions: { getBrowserUse: () => bu, getRunningRows: () => [] } });
  t.after(() => { f.api.dispose(); f.window.close(); });
  assert.equal(f.value('running_now'), '1');
  const row = f.section('running_now').querySelector('[data-rail-surface="browser"]');
  assert.equal(row.textContent.replace(/\s+/g, ' ').trim(), 'Example docsBrowser');
  row.click();
  assert.deepEqual(f.detail.calls.at(-1), { surface: 'browser', ownerSessionId: 'sess_a', opener: row, pane: f.pane });
  bu.push({ session_id: 'sess_other', open: false });
  assert.equal(f.value('running_now'), '1', 'a push for another chat is ignored');
  f.section('running_now').querySelector('[data-rail-server-stop="browser"]').click();
  await flush();
  assert.deepEqual(bu.closes, [{ session_id: 'sess_a' }]);
  bu.push({ session_id: 'sess_a', open: false });
  assert.equal(f.section('running_now'), null, 'nothing runs, so no Running now');
  assert.deepEqual([...f.rail().querySelectorAll('[data-section]')].map((node) => node.getAttribute('data-section')), ['this_chat', 'context']);
});

test('the browser subscription is released on dispose, and a missing browser bridge is simply no page', async () => {
  const bu = browserBridge({ sess_a: { ok: true, open: true, url: 'https://example.com', title: '' } });
  const f = await docked({ mountOptions: { getBrowserUse: () => bu, getRunningRows: () => [] } });
  assert.equal(bu.listeners.size, 1);
  assert.equal(f.section('running_now').querySelector('.session-rail-ellip').textContent, 'example.com', 'no title: the address');
  f.api.dispose();
  assert.equal(bu.listeners.size, 0);
  f.window.close();
  const bare = await docked({ mountOptions: { getRunningRows: () => [] } });
  assert.equal(bare.section('running_now'), null);
  bare.api.dispose();
  bare.window.close();
});

const RUN_ROWS = [
  { id: 'job:aaaaaaaaaaaa', kind: 'server', label: 'npm run dev', detail: 'localhost:5173', startedAt: 1000, canStop: true },
  { id: 'chat:h1', kind: 'helper', label: 'Helper: summarise', startedAt: 2000, canStop: false },
];

test('Running now: rows come from getRunningRows, a row opens its run and All runs opens the list; unwired they open the task detail', async (t) => {
  const opened = [];
  const f = await docked({ mountOptions: { getRunningRows: (sid) => (sid === 'sess_a' ? RUN_ROWS : []), openRun: (id, ctx) => opened.push(['run', id, ctx.ownerSessionId, ctx.pane]), openRuns: (ctx) => opened.push(['runs', ctx.ownerSessionId]) } });
  t.after(() => { f.api.dispose(); f.window.close(); });
  assert.equal(f.value('running_now'), '2');
  const body = f.section('running_now');
  assert.match(body.textContent.replace(/\s+/g, ' '), /localhost:5173Up · [\d:]+StopHelper: summariseRunningAll runs/);
  body.querySelector('[data-rail-run="chat:h1"]').click();
  body.querySelector('[data-rail-runs]').click();
  assert.deepEqual(opened, [['run', 'chat:h1', 'sess_a', f.pane], ['runs', 'sess_a']]);
  assert.deepEqual(f.detail.calls, [], 'a wired port takes the click');
  const bare = await docked({ mountOptions: { getRunningRows: () => RUN_ROWS } });
  t.after(() => { bare.api.dispose(); bare.window.close(); });
  const row = bare.section('running_now').querySelector('[data-rail-run="chat:h1"]');
  row.click();
  assert.deepEqual(bare.detail.calls.at(-1), { surface: 'background_tasks', ownerSessionId: 'sess_a', opener: row, pane: bare.pane, resourceRef: 'chat:h1' });
  assert.equal(body.querySelector('[data-rail-job-stop], [data-rail-server-stop]').disabled, false, 'a server that can stop has a live Stop');
});

test('Running now follows the runs: syncHosts repaints it, and it is gone when the list is empty', async (t) => {
  let list = RUN_ROWS;
  const f = await docked({ mountOptions: { getRunningRows: () => list } });
  t.after(() => { f.api.dispose(); f.window.close(); });
  assert.equal(f.value('running_now'), '2');
  list = [];
  rails.syncHosts();
  assert.equal(f.section('running_now'), null);
  list = [RUN_ROWS[0]];
  rails.syncHosts();
  assert.equal(f.value('running_now'), '1');
});

test('Jenny\'s checklist: from getChecklist with "1 of 3 done"; absent without items; its fold is local and writes nothing', async (t) => {
  let steps = [{ text: 'Load the ledger', state: 'done' }, { text: 'Compare to plan', state: 'now' }, { text: 'Chart FX', state: 'todo' }];
  const f = await docked({ mountOptions: { getChecklist: () => steps } });
  t.after(() => { f.api.dispose(); f.window.close(); });
  assert.equal(f.value('checklist'), '1 of 3 done');
  assert.match(f.text('checklist'), /Load the ledgerDone.*Compare to planNow.*Chart FX/);
  f.head('checklist').click();
  await flush();
  assert.equal(f.head('checklist').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(f.bridge.setViewCalls, [], 'the checklist has no persisted disclosure');
  steps = [];
  rails.syncHosts();
  assert.equal(f.section('checklist'), null);
  const bare = await docked();
  t.after(() => { bare.api.dispose(); bare.window.close(); });
  assert.equal(bare.section('checklist'), null, 'no reader, no section');
});

test('full auto is named as the run mode when it is armed', async (t) => {
  const f = await docked({ mountOptions: { isFullAuto: (sid) => sid === 'sess_a' } });
  t.after(() => { f.api.dispose(); f.window.close(); });
  assert.match(f.text('this_chat'), /project of sess_aFull auto/);
});

test('a closed tab costs nothing: a rail that is not shown sets no timer, fetches nothing, and refreshes once when shown', async (t) => {
  let shown = false;
  rails.configure({ isShown: () => shown });
  t.after(() => rails.configure({ isShown: null }));
  const bu = browserBridge({ sess_a: { ok: true, open: false } });
  const f = await docked({ mountOptions: { getBrowserUse: () => bu } });
  t.after(() => { f.api.dispose(); f.window.close(); });
  assert.equal(f.bridge.summaryCalls.length, 0, 'not shown at mount: no request');
  assert.equal(bu.stateCalls, 0, 'nor a read of the chat\'s browser page');
  for (let n = 0; n < 3; n += 1) f.bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: n });
  f.window.dispatchEvent(new f.window.Event('focus'));
  await sleep(220);
  assert.equal(f.bridge.summaryCalls.length, 0, 'invalidations and focus do no fetch while not shown');
  shown = true;
  rails.syncHosts();
  await flush();
  assert.equal(f.bridge.summaryCalls.length, 1, 'shown again: one refresh for everything missed');
  rails.syncHosts();
  await flush();
  assert.equal(f.bridge.summaryCalls.length, 1, 'still shown: nothing more');
  shown = false;
  rails.syncHosts();
  shown = true;
  rails.syncHosts();
  await flush();
  assert.equal(f.bridge.summaryCalls.length, 2, 'every return to the tab refreshes once, even with no event in between');
});
