'use strict';

/* Row 59 checkpoint 2, slice S3: the per-pane session rail controller in jsdom, against a fake
   chatWorkspace bridge (contract C2) and a fake detail API (contract C3). Layout is covered by
   tests/renderer-session-rail-layout.test.js in headless Chromium; here: data flow, docking
   decisions, the toggle, the sheet, disclosures and their persistence, focus, disposal. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { flush, sleep, deferred, summaryFor, createBridge, createFixture, docked } = require('./helpers/session-rail-fixture.js');

test('next-send breakdown renders inline, counts the local draft, and retains stale counts on failure', async (t) => {
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
  assert.equal(f.section('context').querySelectorAll('.session-context-category').length, 7);
  assert.equal(f.value('context'), '10%');
  const input = f.doc.getElementById('chatInput');
  input.value = 'a'.repeat(400);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(f.value('context'), '20%');
  failed = true;
  f.api.refresh();
  await flush();
  assert.match(f.value('context'), /20%.*stale/);
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
  assert.equal(f.value('context'), '10%');
  contextPreview.remember('sess_a', estimate(300)); // the ring's popover fetched a newer estimate
  await sleep(50);
  assert.equal(f.value('context'), '30%');
  failed = true;
  f.api.refresh();
  await flush();
  assert.match(f.value('context'), /10%.*stale/);
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
  assert.doesNotMatch(f.text('environment'), /Obsolete/);
  assert.equal(requests, 2);
});

test('mount: asks for this pane\u2019s own session and paints the five sections in order', async () => {
  const f = await docked({ width: 1133, sessionId: 'sess_a' });
  assert.deepEqual(f.bridge.summaryCalls, [{ schema_version: 1, session_id: 'sess_a' }]);
  assert.deepEqual([...f.doc.querySelectorAll('[data-section]')].map((node) => node.dataset.section), ['environment', 'context', 'outputs', 'changes', 'background_tasks']);
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  assert.equal(f.rail().hidden, false);
  assert.equal(f.rail().querySelector('.session-rail-tray') !== null, true, 'the tray lives in the docked rail');
  assert.equal(f.value('environment'), 'Local');
  assert.equal(f.value('context'), '64%');
  assert.equal(f.value('outputs'), '1');
  assert.equal(f.value('changes'), '+412 \u221237');
  assert.equal(f.value('background_tasks'), '1 running');
  assert.match(f.text('background_tasks'), /Some sources aren't connected yet\./);
  assert.match(f.text('environment'), /project of sess_a/);
  assert.equal(f.sheet().hidden, true);
  f.api.dispose();
});

test('first paint is checking words, never zeros', async () => {
  const gate = deferred();
  const bridge = createBridge({ respond: () => gate.promise });
  const f = createFixture({ bridge });
  assert.equal(f.value('context'), 'Checking\u2026');
  assert.equal(f.value('changes'), 'Checking\u2026');
  assert.doesNotMatch(f.doc.querySelector('.session-rail-tray').textContent, /\d/);
  gate.resolve({ schema_version: 1, ok: true, summary: summaryFor('sess_a'), workspace_view: bridge.view, coordination_revision: 0 });
  await flush();
  assert.equal(f.value('context'), '64%');
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
  assert.equal(f.value('environment'), 'Unavailable');
  assert.equal(f.value('changes'), 'Unavailable');
  mode = 'ok';
  f.api.refresh();
  await flush();
  assert.equal(f.value('context'), '64%');
  mode = 'bad';
  f.api.refresh();
  await flush();
  assert.equal(f.value('context'), '64% \u00b7 stale', 'the last reading stays, labelled stale');
  assert.equal(f.section('context').dataset.state, 'stale');
  f.api.dispose();
});

test('disclosures: defaults where null, one control per section with aria-expanded', async () => {
  const f = await docked();
  const expanded = (key) => f.head(key).getAttribute('aria-expanded');
  assert.deepEqual(['environment', 'context', 'outputs', 'changes', 'background_tasks'].map(expanded), ['true', 'false', 'true', 'false', 'true']);
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
  f.head('environment').click();
  assert.equal(f.head('environment').getAttribute('aria-expanded'), 'false', 'optimistic collapse');
  await flush(10);
  assert.equal(bridge.setViewCalls.length, 2, 'one re-send at the current revision, then give up');
  assert.equal(bridge.setViewCalls[1].expected_revision, 9);
  assert.equal(bridge.summaryCalls.length, before + 1, 'exactly one refetch');
  assert.equal(f.head('environment').getAttribute('aria-expanded'), 'true', 'reverted to the persisted default');
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
  f.head('environment').click();
  await flush(10);
  assert.equal(bridge.setViewCalls.length, 2);
  assert.equal(bridge.setViewCalls[1].expected_revision, 12);
  assert.deepEqual(bridge.setViewCalls[1].patch, bridge.setViewCalls[0].patch, 'the same idempotent patch');
  assert.equal(f.head('environment').getAttribute('aria-expanded'), 'false', 'the toggle stuck');
  f.api.dispose();
});

test('a thrown write reverts too', async () => {
  const bridge = createBridge();
  bridge.setViewHandler = async () => { throw new Error('ipc closed'); };
  const f = await docked({ bridge });
  f.head('changes').click();
  await flush(10);
  assert.equal(f.head('changes').getAttribute('aria-expanded'), 'false');
  f.api.dispose();
});

test('persisted disclosures from the profile win over the defaults', async () => {
  const bridge = createBridge();
  bridge.view = { schema_version: 1, rail_visible: null, disclosures: { environment: false, changes: true }, children_expanded: null };
  const f = await docked({ bridge });
  assert.equal(f.head('environment').getAttribute('aria-expanded'), 'false');
  assert.equal(f.head('changes').getAttribute('aria-expanded'), 'true');
  assert.equal(f.head('outputs').getAttribute('aria-expanded'), 'true', 'an unset key keeps its default');
  f.api.dispose();
});

test('docked: the Session toggle hides and shows the rail and writes rail_visible', async () => {
  const f = await docked();
  assert.equal(f.toggle().getAttribute('aria-pressed'), 'true');
  assert.equal(f.toggle().hasAttribute('aria-expanded'), false);
  f.toggle().click();
  await flush();
  assert.deepEqual(f.bridge.setViewCalls[0].patch, { rail_visible: false });
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  assert.equal(f.rail().hidden, true);
  assert.equal(f.toggle().getAttribute('aria-pressed'), 'false');
  f.toggle().click();
  await flush();
  assert.deepEqual(f.bridge.setViewCalls[1].patch, { rail_visible: true });
  assert.equal(f.bridge.setViewCalls[1].expected_revision, 1);
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  assert.equal(f.rail().hidden, false);
  f.api.dispose();
});

test('a persisted rail_visible false starts hidden; a failed write puts the rail back', async () => {
  const bridge = createBridge();
  bridge.view = { schema_version: 1, rail_visible: false, disclosures: {}, children_expanded: null };
  const hidden = await docked({ bridge });
  assert.equal(hidden.pane.dataset.sessionRail, 'hidden');
  hidden.api.dispose();

  const failing = createBridge();
  failing.setViewHandler = async () => ({ schema_version: 1, ok: false, error_code: 'CMP-CHATWS-0005', reason: 'io_failed', retryable: true, current_revision: 0 });
  const f = await docked({ bridge: failing });
  f.toggle().click();
  assert.equal(f.pane.dataset.sessionRail, 'hidden', 'optimistic hide');
  await flush(10);
  assert.equal(f.pane.dataset.sessionRail, 'docked', 'reverted');
  f.api.dispose();
});

test('undocked: the toggle opens a non-modal sheet anchored to the pane and never writes rail_visible', async () => {
  const f = await docked({ width: 700 });
  assert.equal(f.pane.dataset.sessionRail, 'undocked');
  assert.equal(f.rail().hidden, true);
  assert.equal(f.toggle().getAttribute('aria-expanded'), 'false');
  assert.equal(f.toggle().getAttribute('aria-haspopup'), 'dialog');
  assert.equal(f.toggle().hasAttribute('aria-pressed'), false);
  assert.equal(f.sheet().hidden, true);
  f.toggle().click();
  assert.equal(f.sheet().hidden, false);
  assert.equal(f.toggle().getAttribute('aria-expanded'), 'true');
  assert.equal(f.sheet().getAttribute('role'), 'dialog');
  assert.equal(f.sheet().getAttribute('aria-modal'), 'false');
  assert.ok(f.sheet().querySelector('.session-rail-tray'), 'the tray moved into the sheet');
  assert.equal(f.value('context'), '64%');
  assert.equal(f.doc.activeElement, f.head('environment'), 'focus moves into the sheet');
  f.toggle().click();
  assert.equal(f.sheet().hidden, true);
  assert.equal(f.doc.activeElement, f.toggle(), 'closing returns focus to the toggle');
  assert.equal(f.bridge.setViewCalls.length, 0, 'the sheet never writes rail_visible');
  f.api.dispose();
});

test('sheet: Escape closes it and returns focus to the toggle without the key reaching the document', async () => {
  const f = await docked({ width: 700 });
  f.toggle().click();
  let leaked = 0;
  f.doc.addEventListener('keydown', () => { leaked += 1; });
  f.head('context').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(f.sheet().hidden, true);
  assert.equal(f.doc.activeElement, f.toggle());
  assert.equal(leaked, 0, 'Escape is consumed by the sheet');
  f.api.dispose();
});

test('sheet: an outside pointer closes it and returns focus only when focus was inside', async () => {
  const f = await docked({ width: 700 });
  f.toggle().click();
  f.doc.getElementById('other').dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
  assert.equal(f.sheet().hidden, true);
  assert.equal(f.doc.activeElement, f.toggle(), 'focus was in the sheet, so it returns to the toggle');
  f.toggle().click();
  f.doc.getElementById('other').focus();
  f.doc.getElementById('other').dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
  assert.equal(f.sheet().hidden, true);
  assert.equal(f.doc.activeElement, f.doc.getElementById('other'), 'a click elsewhere keeps the focus it chose');
  f.toggle().click();
  f.sheet().dispatchEvent(new f.window.Event('pointerdown', { bubbles: true }));
  assert.equal(f.sheet().hidden, false, 'a pointer inside the sheet keeps it open');
  f.api.dispose();
});

test('responsive collapse never writes: crossing the threshold only changes the mode', async () => {
  const f = await docked({ width: 1133 });
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  await f.resize(700);
  assert.equal(f.pane.dataset.sessionRail, 'undocked');
  assert.equal(f.rail().hidden, true);
  await f.resize(1133);
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  assert.equal(f.bridge.setViewCalls.length, 0);
  f.api.dispose();
});

test('widening past the threshold with the sheet open docks the rail and closes the sheet', async () => {
  const f = await docked({ width: 700 });
  f.toggle().click();
  assert.equal(f.sheet().hidden, false);
  await f.resize(1000);
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  assert.equal(f.sheet().hidden, true);
  assert.ok(f.rail().querySelector('.session-rail-tray'));
  f.api.dispose();
});

test('a person-hidden rail stays hidden when docking, and an undocked pane ignores the preference', async () => {
  const bridge = createBridge();
  bridge.view = { schema_version: 1, rail_visible: false, disclosures: {}, children_expanded: null };
  const f = await docked({ bridge, width: 700 });
  assert.equal(f.pane.dataset.sessionRail, 'undocked', 'the sheet is still reachable');
  f.toggle().click();
  assert.equal(f.sheet().hidden, false);
  f.toggle().click();
  await f.resize(1200);
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  f.api.dispose();
});

test('a side panel keeps a docked rail down to 640px, never docks an undocked one, and never re-evaluates mid-motion', async () => {
  const f = await docked({ width: 1133 });
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  f.chatView.classList.add('artifact-review-open');
  await f.resize(713);
  assert.equal(f.pane.dataset.sessionRail, 'docked', '1455 single with the panel open');
  f.chatView.dataset.panelMotion = 'closing';
  await f.resize(500);
  assert.equal(f.pane.dataset.sessionRail, 'docked', 'mid-motion: no re-evaluation');
  delete f.chatView.dataset.panelMotion;
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'undocked', 'the motion\u2019s end re-evaluates: 500px is below the floor');
  f.chatView.classList.remove('artifact-review-open');
  f.api.dispose();

  const g = await docked({ width: 800 });
  assert.equal(g.pane.dataset.sessionRail, 'undocked');
  g.context.classList.remove('collapsed');
  await flush();
  g.state.width = 800;
  g.api.evaluateDock();
  assert.equal(g.pane.dataset.sessionRail, 'undocked', 'an expanded context panel does not dock an undocked rail');
  g.api.dispose();
});

test('docking changes are bracketed by the reflow notice so the reader keeps their place', async () => {
  const f = await docked({ width: 700 });
  const phases = [];
  f.pane.addEventListener('session-rail-reflow', (event) => phases.push([event.detail.phase, f.pane.dataset.sessionRail]));
  await f.resize(1200);
  assert.deepEqual(phases, [['before', 'undocked'], ['after', 'docked']]);
  phases.length = 0;
  f.toggle().click();
  assert.deepEqual(phases, [['before', 'docked'], ['after', 'hidden']]);
  await flush();
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
  assert.match(f.text('environment'), /project of sess_a/);
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
  assert.match(f.text('environment'), /project of sess_c/);
  f.api.dispose();
});

test('a session change also drops unconfirmed toggles and the persisted view of the old session', async () => {
  const bridge = createBridge();
  bridge.view = { schema_version: 1, rail_visible: false, disclosures: { context: true }, children_expanded: null };
  const f = await docked({ bridge });
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  bridge.view = { schema_version: 1, rail_visible: null, disclosures: {}, children_expanded: null };
  f.changeSession('sess_b');
  assert.notEqual(f.pane.dataset.sessionRail, 'hidden', 'sess_a\u2019s hidden preference does not carry over');
  await flush();
  assert.equal(f.head('context').getAttribute('aria-expanded'), 'false');
  f.api.dispose();
});

test('no session in the pane: nothing to show, the toggle steps aside', async () => {
  const f = await docked({ sessionId: '' });
  assert.equal(f.toggle().hidden, true);
  assert.equal(f.bridge.summaryCalls.length, 0);
  f.changeSession('sess_a');
  await flush();
  assert.equal(f.toggle().hidden, false);
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

test('a rail nobody can see does not refetch on invalidations; it catches up when shown', async () => {
  const f = await docked({ width: 700 });
  assert.equal(f.bridge.summaryCalls.length, 1, 'mount still fetches');
  f.bridge.emit({ schema_version: 1, session_id: 'sess_a', revision: 9 });
  await sleep(200);
  assert.equal(f.bridge.summaryCalls.length, 1, 'sheet closed: no refetch');
  f.toggle().click();
  await flush();
  assert.equal(f.bridge.summaryCalls.length, 2, 'opening the sheet fetches what was missed');
  f.api.dispose();
});
