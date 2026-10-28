'use strict';

// The proposal cards' delegated interactions (row 59 checkpoint 3): one decision per
// gesture, a reused decision_id on retry, Run behind its acknowledgements, Copy that
// never reaches the proposal bridge, and in-place patching when the store changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const cards = require('../renderer/chat/renderer-proposal-cards');
const actions = require('../renderer/chat/renderer-proposal-card-actions');
const { createProposalCardStore } = require('../renderer/chat/renderer-proposal-card-store');
const CodeBlock = require('../renderer/inventory/codeblock');

const PID = `proposal_${'c'.repeat(64)}`;
const SID = 'pane-session';
const LINKS = { continuation_turn_id: null, continuation_work_id: null, command_tool_call_id: null };
const NO = { available: false, reason: null };
const YES = { available: true, reason: null };
const COMMAND = 'echo "<hi>" && cat <<EOF\n$(id)\nEOF';

function gitProposal(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 4, kind: 'git', decision_state: 'pending', action_state: 'none',
    display: { summary: 'Summary', question: 'Commit these 2 files?', paths: ['a.js', 'b.js'], path_count: 2 },
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { commit: YES, test_first: YES, dismiss: YES, cancel: NO, retry: NO },
    ...overrides,
  };
}

function commandProposal(overrides = {}) {
  return {
    schema_version: 1, proposal_id: PID, revision: 2, kind: 'command', decision_state: 'pending', action_state: 'none',
    display: { command: COMMAND, cwd: '.', purpose: 'p', timeout_seconds: 30, expected_exit_codes: [0], preconditions: [{ text: 'one' }, { text: 'two' }], backend: 'native', shell: 'cmd.exe' },
    decision: null, links: LINKS, execution: null, last_error: null,
    actions: { run: YES, dismiss: YES, cancel: NO, retry: NO },
    ...overrides,
  };
}

const accepted = (extra = {}) => gitProposal({
  revision: 5, decision_state: 'accepted', action_state: 'queued', decision: { choice: 'commit', accepted_at: '2026-10-15T10:00:00Z', accepted_revision: 4 },
  actions: { commit: NO, test_first: NO, dismiss: NO, cancel: YES, retry: NO }, ...extra,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeBridge(handlers = {}) {
  const calls = [];
  const record = (name) => async (request) => {
    calls.push({ name, request });
    const handler = handlers[name];
    return typeof handler === 'function' ? handler(request, calls.length) : handler;
  };
  return {
    calls,
    get: record('get'), decide: record('decide'), cancel: record('cancel'), retry: record('retry'),
    onChanged: () => () => {},
    only: (name) => calls.filter((call) => call.name === name),
  };
}

function setup(proposal, { bridge = makeBridge(), kind = proposal.kind, extraDeps = {}, withBridge = true } = {}) {
  const dom = new JSDOM('<body><div class="timeline"><article data-turn-id="turn-9"></article></div></body>');
  let n = 0;
  const store = createProposalCardStore({ getBridge: () => (withBridge ? bridge : null), randomUUID: () => `decision-${n += 1}` });
  store.apply(SID, proposal);
  const container = dom.window.document.querySelector('.timeline');
  const paint = () => {
    container.insertAdjacentHTML('beforeend', cards.buildProposalCardMarkup({ sessionId: SID, proposalId: PID, kind, lookup: store.lookup(SID, PID) }));
  };
  paint();
  const dispose = actions.bindProposalCardInteractions(container, { store, cards, getBridge: () => (withBridge ? bridge : null), ...extraDeps });
  const q = (selector) => container.querySelector(selector);
  return { dom, store, bridge, container, q, paint, dispose, doc: dom.window.document, byAction: (name) => q(`[data-proposal-action="${name}"]`) };
}

test('Commit sends one decide, from the card own session, then the card becomes its receipt', async () => {
  const bridge = makeBridge({ decide: { schema_version: 1, ok: true, created: true, proposal: accepted() } });
  const ctx = setup(gitProposal(), { bridge });
  const commit = ctx.byAction('commit');
  commit.focus();
  commit.click();
  await flush();
  const [call] = bridge.only('decide');
  assert.deepEqual(call.request, {
    schema_version: 1, session_id: SID, proposal_id: PID, expected_revision: 4, decision_id: 'decision-1', choice: 'commit',
  });
  assert.equal(bridge.only('decide').length, 1);
  const card = ctx.q('[data-proposal-id]');
  assert.ok(card.classList.contains('proposal-receipt'));
  assert.equal(ctx.q('.proposal-state').textContent, 'Commit · Queued');
  assert.equal(ctx.byAction('commit'), null);
  assert.equal(ctx.doc.activeElement, ctx.q('.proposal-status'), 'focus lands on the status line, not <body>');
  assert.equal(ctx.container.querySelectorAll('[data-proposal-id]').length, 1);
  ctx.dispose();
});

test('a double click is one gesture: one decide while the first is in flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = makeBridge({ decide: async () => { await gate; return { schema_version: 1, ok: true, created: true, proposal: accepted() }; } });
  const ctx = setup(gitProposal(), { bridge });
  const commit = ctx.byAction('commit');
  commit.click();
  commit.click();
  ctx.byAction('test_first')?.click();
  await flush();
  assert.equal(ctx.q('[data-proposal-id]').getAttribute('aria-busy'), 'true');
  assert.equal(ctx.byAction('commit').disabled, true, 'the in-flight card is disabled');
  release();
  await flush();
  assert.equal(bridge.only('decide').length, 1);
  ctx.dispose();
});

test('a transport failure keeps the decision_id for the retry; a new intent after success gets a new one', async () => {
  let attempt = 0;
  const bridge = makeBridge({
    decide: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('ipc closed');
      if (attempt === 2) return { schema_version: 1, ok: true, created: false, proposal: accepted() };
      return null;
    },
  });
  const ctx = setup(gitProposal(), { bridge });
  ctx.byAction('commit').click();
  await flush();
  assert.match(ctx.q('.proposal-notice').textContent, /didn't work|Try again/u);
  assert.equal(ctx.byAction('commit').disabled, false, 'the card is usable again');
  ctx.byAction('commit').click();
  await flush();
  const [first, second] = bridge.only('decide');
  assert.equal(first.request.decision_id, second.request.decision_id, 'same gesture, same id');
  assert.equal(second.request.expected_revision, 4);
  assert.equal(ctx.q('.proposal-state').textContent, 'Commit · Queued');
  ctx.dispose();
});

test('a definite refusal ends the gesture and re-reads the record on a stale revision', async () => {
  const bridge = makeBridge({
    decide: { schema_version: 1, ok: false, error_code: 'CMP-PROPOSAL-0003', reason: 'stale_revision', retryable: true, current_revision: 6 }, // the real fail() envelope
    get: { schema_version: 1, ok: true, proposal: gitProposal({ revision: 6, decision_state: 'dismissed' }) },
  });
  const ctx = setup(gitProposal(), { bridge });
  ctx.byAction('commit').click();
  await flush();
  await flush();
  assert.equal(bridge.only('get').length, 1);
  assert.equal(ctx.q('[data-proposal-id]').dataset.proposalState, 'dismissed');
  assert.equal(ctx.store.gestureId(SID, PID, 'fresh'), 'decision-2', 'the refused gesture id was released');
  ctx.dispose();
});

test('Dismiss, Withdraw (cancel) and Retry each send their own method with the displayed revision', async () => {
  const dismissed = gitProposal({ revision: 5, decision_state: 'dismissed', actions: { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: NO } });
  const bridge = makeBridge({ decide: { ok: true, created: true, proposal: dismissed } });
  const one = setup(gitProposal(), { bridge });
  one.byAction('dismiss').click();
  await flush();
  assert.equal(bridge.only('decide')[0].request.choice, 'dismiss');
  one.dispose();

  const cancelBridge = makeBridge({ cancel: { ok: true, created: true, proposal: accepted({ revision: 6, action_state: 'cancelled', actions: { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: NO } }) } });
  const two = setup(accepted(), { bridge: cancelBridge });
  two.byAction('cancel').click();
  await flush();
  const [cancel] = cancelBridge.only('cancel');
  assert.equal(cancel.request.expected_revision, 5);
  assert.ok(cancel.request.decision_id);
  assert.equal('choice' in cancel.request, false);
  two.dispose();

  const retryBridge = makeBridge({ retry: { ok: true, created: true, proposal: accepted({ revision: 7 }) } });
  const needs = accepted({ action_state: 'needs_attention', actions: { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: YES }, last_error: { code: 'CMP-PROPOSAL-0002', reason: 'unavailable', retryable: true, cause_code: null } });
  const three = setup(needs, { bridge: retryBridge });
  three.byAction('retry').click();
  await flush();
  assert.equal(retryBridge.only('retry').length, 1);
  three.dispose();
});

test('Run: disabled until every precondition is ticked; then one decide carries confirmed_preconditions', async () => {
  const running = commandProposal({ revision: 3, decision_state: 'accepted', action_state: 'queued', decision: { choice: 'run' }, actions: { run: NO, dismiss: NO, cancel: YES, retry: NO } });
  const bridge = makeBridge({ decide: { ok: true, created: true, proposal: running } });
  const ctx = setup(commandProposal(), { bridge });
  assert.equal(ctx.byAction('run').disabled, true);
  ctx.byAction('run').click();
  await flush();
  assert.equal(bridge.only('decide').length, 0, 'a disabled Run does nothing');

  const first = ctx.q('[data-proposal-ack="0"]');
  first.focus();
  first.click();
  assert.equal(ctx.byAction('run').disabled, true, 'one of two is not enough');
  assert.equal(ctx.doc.activeElement.getAttribute('data-proposal-ack'), '0', 'keyboard focus survives the patch');
  ctx.q('[data-proposal-ack="1"]').click();
  assert.equal(ctx.byAction('run').disabled, false);
  assert.deepEqual(ctx.store.lookup(SID, PID).acks, [0, 1]);

  ctx.byAction('run').click();
  ctx.byAction('run')?.click();
  await flush();
  const [call] = bridge.only('decide');
  assert.equal(bridge.only('decide').length, 1);
  assert.equal(call.request.choice, 'run');
  assert.deepEqual(call.request.confirmed_preconditions, [0, 1]);
  assert.equal(call.request.expected_revision, 2);
  assert.equal(ctx.byAction('run'), null);
  ctx.dispose();
});

test('Run answered unsupported_capability stays unavailable with the reason in words and Copy intact', async () => {
  const bridge = makeBridge({ decide: { ok: false, error_code: 'CMP-PROPOSAL-0009', reason: 'unsupported_capability', retryable: false, current_revision: 2 } });
  const proposal = commandProposal();
  proposal.display.preconditions = [];
  const ctx = setup(proposal, { bridge });
  ctx.byAction('run').click();
  await flush();
  assert.equal(ctx.q('.proposal-notice').textContent, "Run isn't available yet. Copy still works.");
  assert.ok(ctx.q('.inv-codeblock-copy'));
  assert.equal(ctx.q('[data-proposal-id]').dataset.proposalState, 'pending');
  ctx.dispose();
});

test('Run is inert when the projection says it is unavailable, even if the node is forced enabled', async () => {
  const proposal = commandProposal({ actions: { run: { available: false, reason: 'plan_mode' }, dismiss: YES, cancel: NO, retry: NO } });
  proposal.display.preconditions = [];
  const ctx = setup(proposal);
  const run = ctx.byAction('run');
  assert.equal(run.disabled, true);
  run.disabled = false;
  run.click();
  await flush();
  assert.equal(ctx.bridge.only('decide').length, 0);
  ctx.dispose();
});

test('Copy puts the exact command bytes on the clipboard and never calls a proposal method', async (t) => {
  const previous = { document: global.document, navigator: Object.getOwnPropertyDescriptor(global, 'navigator'), setTimeout: global.setTimeout };
  t.after(() => {
    global.document = previous.document;
    global.setTimeout = previous.setTimeout;
    if (previous.navigator) Object.defineProperty(global, 'navigator', previous.navigator); else delete global.navigator;
  });
  const ctx = setup(commandProposal());
  const written = [];
  global.document = ctx.doc;
  Object.defineProperty(global, 'navigator', { value: ctx.dom.window.navigator, configurable: true });
  Object.defineProperty(global.navigator, 'clipboard', { value: { writeText: (text) => { written.push(text); return Promise.resolve(); } }, configurable: true });
  global.setTimeout = () => 1;
  CodeBlock.initCopyHandlers(ctx.doc);
  ctx.q('.inv-codeblock-copy').click();
  await flush();
  assert.deepEqual(written, [COMMAND]);
  assert.equal(ctx.bridge.calls.length, 0, 'copy touches no proposal method');
  ctx.dispose();
});

test('a store change patches every card of that proposal in place and keeps the paths disclosure open', async () => {
  const ctx = setup(gitProposal());
  ctx.paint(); // the same proposal twice (for example two renderings of one transcript)
  const [firstDetails] = ctx.container.querySelectorAll('details.proposal-scope');
  firstDetails.open = true;
  const sibling = ctx.q('article');
  ctx.store.apply(SID, accepted({ revision: 6, action_state: 'admitted', actions: { commit: NO, test_first: NO, dismiss: NO, cancel: YES, retry: NO } }));
  const cardsNow = [...ctx.container.querySelectorAll('[data-proposal-id]')];
  assert.equal(cardsNow.length, 2);
  for (const card of cardsNow) assert.equal(card.querySelector('.proposal-state').textContent, 'Commit · Jenny is working on it');
  assert.equal(ctx.q('article'), sibling, 'nothing else is rewritten');
  const pending = setup(gitProposal());
  pending.q('details.proposal-scope').open = true;
  pending.store.setNotice(SID, PID, { text: 'note' });
  assert.equal(pending.q('details.proposal-scope').open, true);
  ctx.dispose();
  pending.dispose();
});

test('a card from another session is never patched or acted on', async () => {
  const ctx = setup(gitProposal());
  ctx.store.apply('other-session', gitProposal({ revision: 9, decision_state: 'dismissed' }));
  assert.equal(ctx.q('[data-proposal-id]').dataset.proposalState, 'pending');
  ctx.dispose();
});

test('without the bridge a click reports unavailable instead of throwing', async () => {
  const ctx = setup(gitProposal(), { withBridge: false });
  ctx.byAction('commit').click();
  await flush();
  assert.match(ctx.q('.proposal-notice').textContent, /isn't available right now/u);
  ctx.dispose();
});

test('See the reply scrolls to the continuation turn through the injected hook or the article', async () => {
  const proposal = accepted({ revision: 6, action_state: 'succeeded', links: { ...LINKS, continuation_turn_id: 'turn-9' }, actions: { commit: NO, test_first: NO, dismiss: NO, cancel: NO, retry: NO } });
  const ctx = setup(proposal);
  let scrolled = 0;
  ctx.q('article').scrollIntoView = () => { scrolled += 1; };
  ctx.byAction('jump-reply').click();
  assert.equal(scrolled, 1);
  assert.equal(ctx.bridge.calls.length, 0, 'a jump is local');
  ctx.dispose();
  const hooked = [];
  const injected = setup(proposal, { extraDeps: { scrollToTurn: (id) => { hooked.push(id); return true; } } });
  injected.byAction('jump-reply').click();
  assert.deepEqual(hooked, ['turn-9']);
  injected.dispose();
});

test('dispose removes the handlers', async () => {
  const ctx = setup(gitProposal());
  const commit = ctx.byAction('commit');
  ctx.dispose();
  commit.click();
  await flush();
  assert.equal(ctx.bridge.only('decide').length, 0);
});

test('the busy guard holds even when a stale enabled button is clicked', async () => {
  const ctx = setup(gitProposal());
  ctx.store.setBusy(SID, PID, true);
  const commit = ctx.byAction('commit');
  assert.equal(commit.disabled, true);
  commit.disabled = false;
  commit.click();
  await flush();
  assert.equal(ctx.bridge.only('decide').length, 0);
  ctx.dispose();
});

test('review #9: a real state change is announced once through the shared announcer, keyed per proposal', async () => {
  const announced = [];
  const announcer = { announce: (text, opts) => announced.push({ text, key: opts && opts.key }) };
  const ctx = setup(gitProposal(), { extraDeps: { announcer } });
  ctx.paint(); // two renderings of one proposal: the announcer key dedupes them
  ctx.store.apply(SID, accepted({ revision: 6, action_state: 'admitted', actions: { commit: NO, test_first: NO, dismiss: NO, cancel: YES, retry: NO } }));
  assert.deepEqual(announced.map((entry) => entry.key), [`proposal-status:${PID}`, `proposal-status:${PID}`]);
  assert.equal(announced[0].text, 'Commit · Jenny is working on it');
  announced.length = 0;
  ctx.store.setNotice(SID, PID, { text: 'note' }); // a patch that leaves the status unchanged says nothing
  assert.equal(announced.length, 0);
  ctx.dispose();
});

test('review #10: a pane disposed while a decide is in flight does not leave the shared card busy', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = makeBridge({ decide: async () => { await gate; return { schema_version: 1, ok: true, created: true, proposal: accepted() }; } });
  const ctx = setup(gitProposal(), { bridge });
  ctx.byAction('commit').click();
  await flush();
  assert.equal(ctx.store.isBusy(SID, PID), true);
  ctx.dispose();
  release();
  await flush();
  assert.equal(ctx.store.isBusy(SID, PID), false);
});

test("F3b: Retry on a failed child runs the child's own Retry turn once, never a proposal method", async () => {
  const child = 'sess_child';
  const proposal = {
    schema_version: 1, proposal_id: PID, revision: 7, kind: 'session', decision_state: 'accepted', action_state: 'succeeded',
    display: { title: 'Review latest commits', description: '', initiation: 'offer', authorization_required: false },
    group_id: null, options: null, options_editable: false,
    decision: { choice: 'new_session', accepted_at: '2026-10-27T13:16:24Z', accepted_revision: 6 },
    links: { ...LINKS, child_session_id: child, first_turn_turn_id: 't1', first_turn_work_id: 'w1', preparation_turn_id: null },
    execution: null, last_error: null,
    actions: { do_it_here: NO, new_session: NO, dismiss: NO, cancel: NO, retry: NO },
    child: { phase: 'failed', error_class: 'model_busy', failed_turn_is_first: true, retry: { message_id: 'a_t1' }, key: 'k' },
  };
  const retries = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = makeBridge();
  const ctx = setup(proposal, { bridge, extraDeps: { retryChildTurn: async (...args) => { retries.push(args); await gate; } } });
  ctx.byAction('retry-child').click();
  ctx.byAction('retry-child').click();
  await flush();
  assert.deepEqual(retries, [[child, 'a_t1']], 'one retry while the first is in flight');
  release();
  await flush();
  assert.equal(bridge.calls.length, 0, 'no proposal bridge call');
  ctx.dispose();
});
