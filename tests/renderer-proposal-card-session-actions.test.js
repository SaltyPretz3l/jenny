'use strict';

// The session proposal cards' delegated interactions (row 59 checkpoint 5a-2): New session and
// Do it here decisions, the Options popover (capabilities, setOptions, Escape and click-away),
// the suggestion group header and Start all (one snapshot, one decision id, partial results),
// and the Open link that reaches only the injected openSession. Fixture projections follow
// the frozen shapes of the cp5a spec section 1.9.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const cards = require('../renderer/chat/renderer-proposal-cards');
const actions = require('../renderer/chat/renderer-proposal-card-actions');
const { createProposalCardStore } = require('../renderer/chat/renderer-proposal-card-store');

const SID = 'pane-session';
const LINKS = { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null };
const NO = { available: false, reason: null };
const YES = { available: true, reason: null };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeBridge(handlers = {}) {
  const calls = [];
  const bridge = {
    calls,
    onChanged: () => () => {},
    only: (name) => calls.filter((call) => call.name === name),
  };
  for (const name of ['get', 'decide', 'cancel', 'retry', 'setOptions', 'startAll', 'list', 'getCapabilities']) {
    bridge[name] = async (request) => {
      calls.push({ name, request });
      const handler = handlers[name];
      return typeof handler === 'function' ? handler(request, calls.length) : handler;
    };
  }
  return bridge;
}

const GID = `group_${'e'.repeat(64)}`;
const pidOf = (c) => `proposal_${c.repeat(64)}`;
const S_LINKS = { ...LINKS, child_session_id: null, first_turn_turn_id: null, first_turn_work_id: null, preparation_turn_id: null };
const S_OPTIONS = { destination_project_id: 'proj-a', preferred_model: null, reasoning_effort: null, run_mode: 'agent' };
const CAPS = {
  schema_version: 1, ok: true, destinations: [{ project_id: 'proj-a', label: 'jenny', available: true }, { project_id: null, label: 'No project', available: true }],
  models: [{ id: 'qwen', label: 'Qwen' }, { id: 'small', label: 'Small' }], reasoning_efforts: ['low', 'high'], run_modes: ['agent', 'plan'],
  restrictions: { read_only: false, plan_mode: false, lockdown: false }, unavailable_reason: null,
};

function sessionProposal(c = 'a', overrides = {}) {
  return {
    schema_version: 1, proposal_id: pidOf(c), revision: 2, kind: 'session', decision_state: 'pending', action_state: 'none',
    created_at: `2026-10-15T10:00:0${c.charCodeAt(0) % 10}Z`, expires_at: new Date(Date.now() + 86400000).toISOString(),
    display: { title: `Task ${c}`, description: 'd', initiation: 'offer', authorization_required: false },
    group_id: null, options: S_OPTIONS, options_editable: true, decision: null, links: S_LINKS, execution: null, last_error: null,
    actions: { do_it_here: YES, new_session: YES, dismiss: YES, cancel: NO, retry: NO }, ...overrides,
  };
}

const sessionAccepted = (c, choice, actionState, extra = {}) => sessionProposal(c, {
  revision: 3, decision_state: 'accepted', action_state: actionState, options_editable: false,
  decision: { choice, accepted_at: '2026-10-15T10:00:00Z', accepted_revision: 2, options: choice === 'new_session' ? S_OPTIONS : null },
  actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: YES, retry: NO }, ...extra,
});

const sessionBridge = (handlers = {}) => makeBridge({ getCapabilities: CAPS, ...handlers });

async function setupSession(proposals, { bridge, extraDeps = {} } = {}) {
  const list = Array.isArray(proposals) ? proposals : [proposals];
  const theBridge = bridge || sessionBridge({ list: { ok: true, items: list, next_cursor: null, revision: 1 } });
  const dom = new JSDOM('<body><div class="timeline"></div></body>');
  let n = 0;
  const store = createProposalCardStore({ getBridge: () => theBridge, randomUUID: () => `decision-${n += 1}` });
  for (const proposal of list) store.apply(SID, proposal);
  store.lookup(SID, list[0].proposal_id);
  await flush();
  const container = dom.window.document.querySelector('.timeline');
  for (const proposal of list) {
    container.insertAdjacentHTML('beforeend', cards.buildProposalCardMarkup({ sessionId: SID, proposalId: proposal.proposal_id, kind: 'session', lookup: store.lookup(SID, proposal.proposal_id) }, extraDeps));
  }
  await flush();
  const dispose = actions.bindProposalCardInteractions(container, { store, cards, getBridge: () => theBridge, ...extraDeps });
  const doc = dom.window.document;
  const row = (id) => container.querySelector(`[data-proposal-id="${id}"]`);
  return { dom, doc, store, bridge: theBridge, container, dispose, row, q: (selector) => container.querySelector(selector), key: (el, key) => el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })) };
}

test('New session and Do it here each send one decide with their choice from the card session', async () => {
  for (const [action, choice] of [['new_session', 'new_session'], ['do_it_here', 'do_it_here']]) {
    const bridge = sessionBridge({ decide: { schema_version: 1, ok: true, created: true, proposal: sessionAccepted('a', choice, 'queued') } });
    const ctx = await setupSession(sessionProposal('a'), { bridge });
    ctx.q(`[data-proposal-action="${action}"]`).click();
    await flush();
    assert.deepEqual(bridge.only('decide')[0].request, {
      schema_version: 1, session_id: SID, proposal_id: pidOf('a'), expected_revision: 2, decision_id: 'decision-1', choice,
    });
    assert.equal(bridge.only('decide').length, 1);
    assert.equal(ctx.q('.proposal-status').dataset.tone, 'pending');
    assert.equal(ctx.q('[data-proposal-action="new_session"]'), null);
    ctx.dispose();
  }
});

test('an unsupported refusal for a session says so in session words, not Run words', async () => {
  const bridge = sessionBridge({ decide: { schema_version: 1, ok: false, error_code: 'CMP-PROPOSAL-0009', reason: 'unsupported_capability', retryable: false, current_revision: 2 } });
  const ctx = await setupSession(sessionProposal('a'), { bridge });
  ctx.q('[data-proposal-action="new_session"]').click();
  await flush();
  assert.equal(ctx.q('.proposal-notice').textContent, "Starting a separate chat isn't available here.");
  assert.equal(actions.errorText('CMP-PROPOSAL-0009', '', 'command'), "Run isn't available yet. Copy still works.");
  ctx.dispose();
});

test('Options: opening reads capabilities, moves focus into the popover; a change sends setOptions with the whole options object', async () => {
  const next = sessionProposal('a', { revision: 3, options: { ...S_OPTIONS, preferred_model: 'qwen' } });
  const bridge = sessionBridge({ setOptions: { schema_version: 1, ok: true, created: false, proposal: next } });
  const ctx = await setupSession(sessionProposal('a'), { bridge });
  const toggle = ctx.q('[data-proposal-action="options"]');
  toggle.focus();
  toggle.click();
  await flush();
  assert.ok(bridge.only('getCapabilities').length >= 1);
  const popover = ctx.q('.proposal-options-popover');
  assert.equal(popover.hidden, false);
  assert.equal(ctx.q('[data-proposal-action="options"]').getAttribute('aria-expanded'), 'true');
  const model = popover.querySelector('select[data-proposal-option="model"]');
  assert.equal(ctx.doc.activeElement.getAttribute('data-proposal-option'), 'destination', 'focus lands on the first control');
  model.value = 'qwen';
  model.dispatchEvent(new ctx.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(bridge.only('setOptions')[0].request, {
    schema_version: 1, session_id: SID, proposal_id: pidOf('a'), expected_revision: 2,
    options: { destination_project_id: 'proj-a', preferred_model: 'qwen', reasoning_effort: null, run_mode: 'agent' },
  });
  assert.equal(ctx.q('.proposal-options-popover').hidden, false, 'the popover stays open across the re-render');
  assert.equal(ctx.q('select[data-proposal-option="model"]').value, 'qwen');
  assert.equal(ctx.store.lookup(SID, pidOf('a')).proposal.revision, 3);
  ctx.dispose();
});

test('Options: automatic means null, the mode radio sends run_mode, and an unchanged value sends nothing', async () => {
  const withModel = sessionProposal('a', { options: { ...S_OPTIONS, preferred_model: 'qwen' } });
  const bridge = sessionBridge({ setOptions: (request) => ({ ok: true, proposal: sessionProposal('a', { revision: 3, options: request.options }) }) });
  const ctx = await setupSession(withModel, { bridge });
  ctx.q('[data-proposal-action="options"]').click();
  await flush();
  const model = ctx.q('select[data-proposal-option="model"]');
  model.value = '';
  model.dispatchEvent(new ctx.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(bridge.only('setOptions')[0].request.options.preferred_model, null);
  ctx.q('[data-proposal-option="run_mode"] [data-value="plan"]').click();
  await flush();
  assert.equal(bridge.only('setOptions')[1].request.options.run_mode, 'plan');
  assert.equal(bridge.only('setOptions')[1].request.expected_revision, 3);
  const same = ctx.q('select[data-proposal-option="effort"]');
  same.value = '';
  same.dispatchEvent(new ctx.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(bridge.only('setOptions').length, 2, 'null to null is not a change');
  ctx.dispose();
});

test('Options: Escape closes the popover and returns focus to the Options button; a click elsewhere closes it too', async () => {
  const ctx = await setupSession(sessionProposal('a'));
  ctx.q('[data-proposal-action="options"]').click();
  await flush();
  const control = ctx.q('.proposal-options-popover select');
  control.focus();
  ctx.key(control, 'Escape');
  await flush();
  assert.equal(ctx.q('.proposal-options-popover').hidden, true);
  assert.equal(ctx.doc.activeElement, ctx.q('[data-proposal-action="options"]'));
  ctx.q('[data-proposal-action="options"]').click();
  await flush();
  assert.equal(ctx.q('.proposal-options-popover').hidden, false);
  ctx.q('.proposal-session-title').click();
  await flush();
  assert.equal(ctx.q('.proposal-options-popover').hidden, true);
  ctx.dispose();
});

test('Options: a stale setOptions reads the record again and says so; nothing is sent when options are locked', async () => {
  const bridge = sessionBridge({ setOptions: { ok: false, error_code: 'CMP-PROPOSAL-0003', reason: 'stale_revision', retryable: true, current_revision: 9 }, get: { ok: true, proposal: sessionProposal('a', { revision: 9 }) } });
  const ctx = await setupSession(sessionProposal('a'), { bridge });
  ctx.q('[data-proposal-action="options"]').click();
  await flush();
  const effort = ctx.q('select[data-proposal-option="effort"]');
  effort.value = 'low';
  effort.dispatchEvent(new ctx.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(bridge.only('get').length >= 1, true);
  assert.equal(ctx.store.lookup(SID, pidOf('a')).proposal.revision, 9);
  ctx.dispose();
  const locked = sessionBridge();
  const second = await setupSession(sessionProposal('b', { options_editable: false }), { bridge: locked });
  assert.equal(second.q('[data-proposal-action="options"]').disabled, true);
  second.q('[data-proposal-action="options"]').click();
  await flush();
  assert.equal(locked.only('setOptions').length, 0);
  second.dispose();
});

const groupRows = () => [
  sessionProposal('a', { group_id: GID, display: { title: 'Task a', description: 'd', initiation: 'own_initiative', authorization_required: false } }),
  sessionProposal('b', { group_id: GID, display: { title: 'Task b', description: null, initiation: 'own_initiative', authorization_required: false }, revision: 4 }),
  sessionAccepted('c', 'new_session', 'succeeded', { group_id: GID, display: { title: 'Task c', description: null, initiation: 'own_initiative', authorization_required: false }, links: { ...S_LINKS, child_session_id: 'sess_1_cccccccccccc' } }),
];

test('Start all sends one startAll with the snapshot taken at click time, then patches each row from its result', async () => {
  const rows = groupRows();
  const bridge = sessionBridge({
    list: { ok: true, items: rows, next_cursor: null, revision: 1 },
    startAll: {
      schema_version: 1, ok: true,
      results: [
        { proposal_id: pidOf('a'), ok: true, created: true, proposal: sessionAccepted('a', 'new_session', 'preparing', { group_id: GID, display: rows[0].display }) },
        { proposal_id: pidOf('b'), ok: false, error_code: 'CMP-PROPOSAL-0003', reason: 'stale_revision', retryable: false, current_revision: 5 },
      ],
    },
  });
  const ctx = await setupSession(rows, { bridge });
  assert.equal(ctx.q('.proposal-group-count').textContent, '2 suggested tasks');
  assert.equal(ctx.container.querySelectorAll('[data-proposal-group]').length, 1, 'one header, on the first row only');
  assert.ok(ctx.row(pidOf('a')).querySelector('[data-proposal-group]'));
  ctx.q('[data-proposal-action="start-all"]').click();
  await flush();
  assert.deepEqual(bridge.only('startAll')[0].request, {
    schema_version: 1, session_id: SID, group_id: GID, decision_id: 'decision-1',
    items: [{ proposal_id: pidOf('a'), expected_revision: 2 }, { proposal_id: pidOf('b'), expected_revision: 4 }],
  });
  assert.equal(bridge.only('startAll').length, 1);
  assert.equal(ctx.row(pidOf('a')).querySelector('.proposal-state').textContent, 'Preparing the new chat…');
  assert.equal(ctx.row(pidOf('b')).querySelector('.proposal-notice').textContent, 'This proposal changed. It has been refreshed.');
  assert.ok(ctx.row(pidOf('b')).querySelector('[data-proposal-action="new_session"]'), 'the failed row stays pending and individually actionable');
  assert.match(ctx.q('.proposal-group-head .proposal-notice').textContent, /Some suggestions didn't start/u);
  assert.equal(ctx.q('.proposal-group-count').textContent, '1 suggested task', 'the header counts only what is still actionable');
  assert.equal(ctx.row(pidOf('c')).querySelector('[data-proposal-action="open-child"]').dataset.proposalChildId, 'sess_1_cccccccccccc');
  ctx.dispose();
});

test('Start all: a transport failure keeps the decision id for the repeat click; a changed snapshot gets a new one', async () => {
  const rows = groupRows();
  let attempt = 0;
  const bridge = sessionBridge({
    list: { ok: true, items: rows, next_cursor: null, revision: 1 },
    startAll: async () => { attempt += 1; if (attempt === 1) throw new Error('ipc closed'); return { ok: true, results: [] }; },
  });
  const ctx = await setupSession(rows, { bridge });
  ctx.q('[data-proposal-action="start-all"]').click();
  await flush();
  assert.equal(ctx.q('.proposal-group-head .proposal-notice').textContent, "That didn't work. Try again.");
  ctx.q('[data-proposal-action="start-all"]').click();
  await flush();
  const calls = bridge.only('startAll');
  assert.equal(calls[0].request.decision_id, calls[1].request.decision_id, 'the same snapshot is the same intent');
  ctx.store.apply(SID, { ...rows[0], revision: 5 });
  ctx.q('[data-proposal-action="start-all"]').click();
  await flush();
  assert.notEqual(bridge.only('startAll')[2].request.decision_id, calls[0].request.decision_id);
  ctx.dispose();
});

test('Start all: one request in flight; a double click is one call; nothing is sent when no row can start', async () => {
  const rows = groupRows();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = sessionBridge({ list: { ok: true, items: rows, next_cursor: null, revision: 1 }, startAll: async () => { await gate; return { ok: true, results: [] }; } });
  const ctx = await setupSession(rows, { bridge });
  const button = ctx.q('[data-proposal-action="start-all"]');
  button.click();
  button.click();
  await flush();
  assert.equal(ctx.q('[data-proposal-action="start-all"]').disabled, true);
  release();
  await flush();
  assert.equal(bridge.only('startAll').length, 1);
  ctx.dispose();
  const none = [sessionAccepted('c', 'new_session', 'succeeded', { group_id: GID, links: { ...S_LINKS, child_session_id: 'sess_1_cccccccccccc' } })];
  const quiet = sessionBridge({ list: { ok: true, items: none, next_cursor: null, revision: 1 } });
  const second = await setupSession(none, { bridge: quiet });
  assert.equal(second.q('[data-proposal-action="start-all"]'), null, 'hidden when nothing is actionable');
  second.dispose();
});

test('any member change repaints the group header in place: dismissing a row lowers the count', async () => {
  const rows = groupRows();
  const bridge = sessionBridge({ list: { ok: true, items: rows, next_cursor: null, revision: 1 }, decide: { ok: true, created: true, proposal: sessionProposal('b', { revision: 5, decision_state: 'dismissed', group_id: GID, options_editable: false, actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO } }) } });
  const ctx = await setupSession(rows, { bridge });
  const headBefore = ctx.q('[data-proposal-group]');
  ctx.row(pidOf('b')).querySelector('[data-proposal-action="dismiss"]').click();
  await flush();
  assert.equal(ctx.q('.proposal-group-count').textContent, '1 suggested task');
  assert.notEqual(ctx.q('[data-proposal-group]'), headBefore, 'the header element was replaced, the rows around it were not touched');
  assert.equal(ctx.row(pidOf('b')).querySelector('.proposal-state').textContent, 'Dismissed');
  ctx.dispose();
});

test('Open reaches only the injected openSession with the child id; a click elsewhere never opens or moves focus', async () => {
  const opened = [];
  const rows = [sessionAccepted('c', 'new_session', 'succeeded', { links: { ...S_LINKS, child_session_id: 'sess_1_cccccccccccc' } })];
  const ctx = await setupSession(rows, { extraDeps: { openSession: (id) => opened.push(id) } });
  const before = ctx.doc.activeElement;
  ctx.q('.proposal-session-title').click();
  assert.deepEqual(opened, []);
  assert.equal(ctx.doc.activeElement, before);
  ctx.q('[data-proposal-action="open-child"]').click();
  assert.deepEqual(opened, ['sess_1_cccccccccccc']);
  ctx.dispose();
  const without = await setupSession(rows);
  without.q('[data-proposal-action="open-child"]').click();
  await flush();
  assert.equal(without.bridge.only('decide').length, 0, 'Open is not a proposal gesture');
  without.dispose();
});

test('a status change on a session card is announced once through the shared announcer', async () => {
  const announced = [];
  const bridge = sessionBridge({ decide: { ok: true, created: true, proposal: sessionAccepted('a', 'new_session', 'preparing') } });
  const ctx = await setupSession(sessionProposal('a'), { bridge, extraDeps: { announcer: { announce: (text, options) => announced.push([text, options.key]) } } });
  ctx.q('[data-proposal-action="new_session"]').click();
  await flush();
  assert.deepEqual(announced, [['Preparing the new chat…', `proposal-status:${pidOf('a')}`]]);
  ctx.dispose();
});

test('Options with the app-wide popover handlers: the open survives its own click, a changed control keeps focus, a click elsewhere closes it in the store too', async () => {
  const popoverApi = require('../renderer/inventory/popover');
  const next = sessionProposal('a', { revision: 3, options: { ...S_OPTIONS, preferred_model: 'qwen' } });
  const bridge = sessionBridge({ setOptions: { schema_version: 1, ok: true, created: false, proposal: next } });
  const ctx = await setupSession(sessionProposal('a'), { bridge });
  popoverApi.initPopoverHandlers(ctx.doc);
  ctx.q('[data-proposal-action="options"]').click();
  await flush();
  assert.equal(ctx.q('.proposal-options-popover').hidden, false, 'the document click-away does not close the popover that click opened');
  const model = ctx.q('select[data-proposal-option="model"]');
  model.focus();
  model.value = 'qwen';
  model.dispatchEvent(new ctx.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(ctx.doc.activeElement.getAttribute('data-proposal-option'), 'model', 'focus returns to the control that changed');
  ctx.doc.body.click();
  await flush();
  assert.equal(ctx.store.isOptionsOpen(SID, pidOf('a')), false, 'the store follows the app-wide close');
  assert.equal(ctx.q('.proposal-options-popover').hidden, true);
  ctx.dispose();
});

// ---- Row 76 (E1): "Always allow Jenny to start chats in <project>" on the primary chat's offer card ----

const ALWAYS = '[data-proposal-always-allow]';
const P_OPTIONS = { ...S_OPTIONS, destination_project_id: 'proj_1' };
const primaryDeps = (grantLaunch, extra = {}) => {
  const calls = [];
  return {
    calls,
    deps: {
      isPrimarySession: (id) => id === SID,
      getPrimaryBridge: () => ({ grantLaunch: async (request) => { calls.push(request); return typeof grantLaunch === 'function' ? grantLaunch(request) : grantLaunch; } }),
      ...extra,
    },
  };
};
const primaryOffer = (overrides = {}) => sessionProposal('a', { options: P_OPTIONS, ...overrides });
const decideOk = (choice = 'new_session') => ({ decide: { schema_version: 1, ok: true, created: true, proposal: sessionAccepted('a', choice, 'queued', { options: P_OPTIONS }) } });

test('Always allow: New session with the box ticked decides, then grants the destination project once', async () => {
  const bridge = sessionBridge(decideOk());
  const { calls, deps } = primaryDeps({ schema_version: 1, ok: true, permission: {}, created: true });
  const ctx = await setupSession(primaryOffer(), { bridge, extraDeps: deps });
  const box = ctx.q(ALWAYS);
  assert.ok(box, 'the row is on the primary chat offer');
  box.click();
  ctx.q('[data-proposal-action="new_session"]').click();
  await flush();
  await flush();
  assert.equal(bridge.only('decide').length, 1);
  assert.deepEqual(calls, [{ schema_version: 1, project_id: 'proj_1' }]);
  assert.equal(ctx.q(ALWAYS), null, 'the decided card no longer carries the row');
  assert.equal(ctx.q('.proposal-notice'), null);
  ctx.dispose();
});

test('Always allow: Do it here with the box ticked grants too; an unticked box grants nothing', async () => {
  const ticked = primaryDeps({ schema_version: 1, ok: true });
  const bridgeA = sessionBridge(decideOk('do_it_here'));
  const a = await setupSession(primaryOffer(), { bridge: bridgeA, extraDeps: ticked.deps });
  a.q(ALWAYS).click();
  a.q('[data-proposal-action="do_it_here"]').click();
  await flush(); await flush();
  assert.equal(ticked.calls.length, 1);
  a.dispose();
  const unticked = primaryDeps({ schema_version: 1, ok: true });
  const bridgeB = sessionBridge(decideOk());
  const b = await setupSession(primaryOffer(), { bridge: bridgeB, extraDeps: unticked.deps });
  b.q('[data-proposal-action="new_session"]').click();
  await flush(); await flush();
  assert.equal(bridgeB.only('decide').length, 1);
  assert.equal(unticked.calls.length, 0);
  b.dispose();
});

test('Always allow: a refused decision grants nothing', async () => {
  const bridge = sessionBridge({ decide: { schema_version: 1, ok: false, error_code: 'CMP-PROPOSAL-0004', reason: 'conflict', retryable: false, current_revision: 2 } });
  const { calls, deps } = primaryDeps({ schema_version: 1, ok: true });
  const ctx = await setupSession(primaryOffer(), { bridge, extraDeps: deps });
  ctx.q(ALWAYS).click();
  ctx.q('[data-proposal-action="new_session"]').click();
  await flush(); await flush();
  assert.equal(calls.length, 0);
  assert.equal(ctx.q('.proposal-notice').textContent, 'That conflicts with an earlier choice.');
  ctx.dispose();
});

test('Always allow: a refused or failed grant leaves a calm notice that the chat still started', async () => {
  for (const refusal of [{ schema_version: 1, ok: false, code: 'CMP-PRIMARY-0004', reason: 'capacity', retryable: false }, null]) {
    const bridge = sessionBridge(decideOk());
    const { calls, deps } = primaryDeps(() => { if (refusal === null) throw new Error('bridge down'); return refusal; });
    const ctx = await setupSession(primaryOffer(), { bridge, extraDeps: deps });
    ctx.q(ALWAYS).click();
    ctx.q('[data-proposal-action="new_session"]').click();
    await flush(); await flush();
    assert.equal(calls.length, 1);
    assert.equal(ctx.q('.proposal-notice').textContent, 'The permission was not saved.');
    ctx.dispose();
  }
});

test('Always allow: the tick survives a repaint between ticking and clicking', async () => {
  const bridge = sessionBridge(decideOk());
  const { calls, deps } = primaryDeps({ schema_version: 1, ok: true });
  const ctx = await setupSession(primaryOffer(), { bridge, extraDeps: deps });
  ctx.q(ALWAYS).click();
  ctx.store.setNotice(SID, pidOf('a'), { text: 'Something changed' });
  await flush();
  assert.equal(ctx.q('.proposal-notice').textContent, 'Something changed');
  assert.equal(ctx.q(ALWAYS).checked, true, 'the repainted card keeps the tick');
  ctx.q('[data-proposal-action="new_session"]').click();
  await flush(); await flush();
  assert.deepEqual(calls, [{ schema_version: 1, project_id: 'proj_1' }]);
  ctx.dispose();
});

test('Always allow: never offered or granted for a non-primary chat, even if a box is present', async () => {
  const { calls, deps } = primaryDeps({ schema_version: 1, ok: true }, { isPrimarySession: () => false });
  const bridge = sessionBridge(decideOk());
  const ctx = await setupSession(primaryOffer(), { bridge, extraDeps: deps });
  assert.equal(ctx.q(ALWAYS), null);
  ctx.q('[data-proposal-action="new_session"]').insertAdjacentHTML('afterend', '<input type="checkbox" data-proposal-always-allow checked>');
  ctx.q('[data-proposal-action="new_session"]').click();
  await flush(); await flush();
  assert.equal(bridge.only('decide').length, 1);
  assert.equal(calls.length, 0);
  ctx.dispose();
});
