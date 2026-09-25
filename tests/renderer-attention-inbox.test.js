'use strict';

/**
 * tests/renderer-attention-inbox.test.js
 *
 * Runtime UX A3 (JEN-045) gate — the "Needs you" section and its titlebar
 * badge. The controller answers approvals in place through the global bridge,
 * keyed by the approval id the backend minted (so a session that is not open
 * can still be answered, and a runtime-decision approval is not refused),
 * opens the session for a plan review or a question batch, and never claims an
 * outcome the bridge has not returned: a `false` result reads "Already
 * resolved", a thrown error re-enables the row, and nothing is ever marked
 * approved optimistically. It also owns no clock — the inbox re-renders from
 * the passes that already re-render the chats panel and the workspace chrome.
 *
 * What the section LOOKS like, and what one of those passes costs, is the
 * sibling gate: tests/renderer-attention-inbox-view.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createAttentionInboxController } = require('../renderer/shell/renderer-attention-inbox');
const inventoryActionButton = require('../renderer/inventory/action-button');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const MARKUP = '<div class="titlebar-brand">'
  + '<div class="workbench-health-pill-slot" id="workbenchHealthPillSlot"></div>'
  + '</div>'
  + '<div class="sidebar-history-content" id="sidebarHistoryContent">'
  + '<div class="attention-inbox" id="attentionInbox" hidden></div>'
  + '<div class="conversation-groups" id="conversationGroups"></div>'
  + '</div>';

function questionBatch(batchId, count = 1) {
  return {
    batch_id: batchId,
    round_index: 1,
    intro_text: 'Pick one',
    questions: Array.from({ length: count }, (_value, index) => ({
      id: `q${index + 1}`, prompt: `Question ${index + 1}`, options: [{ id: 'a', label: 'A' }],
    })),
  };
}

function harness(options = {}) {
  const dom = new JSDOM(MARKUP, { url: 'https://jenny.local/' });
  const { window } = dom;
  const timers = { setTimeout: 0, setInterval: 0 };
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (...args) => { timers.setTimeout += 1; return nativeSetTimeout(...args); };
  window.setInterval = () => { timers.setInterval += 1; return 0; };

  const approveCalls = [];
  const denyCalls = [];
  window.jennyShell = {
    tools: {
      approve: (ref, scope) => {
        approveCalls.push([ref, scope]);
        return options.approve ? options.approve(ref, scope) : Promise.resolve(true);
      },
      deny: (ref) => {
        denyCalls.push([ref]);
        return options.deny ? options.deny(ref) : Promise.resolve(true);
      },
    },
  };

  const state = {
    currentSessionId: options.currentSessionId || '',
    sessions: options.sessions || [],
    pendingToolApprovals: options.pendingToolApprovals || new Map(),
  };
  const logs = [];
  const errors = [];
  const openCalls = [];
  const collapseCalls = [];
  const viewCalls = [];
  const controller = createAttentionInboxController({
    windowRef: window,
    documentRef: window.document,
    state,
    host: window.document.getElementById('attentionInbox'),
    badgeAnchor: window.document.getElementById('workbenchHealthPillSlot'),
    actionButton: inventoryActionButton,
    facts: {
      getApprovalFacts: (_toolName, input) => (input?.path ? [{ kind: 'write', label: `Writes ${input.path}` }] : []),
      getApprovalCommandPreview: (_toolName, input) => String(input?.command || input?.path || ''),
    },
    callbacks: {
      openSession: (sessionId) => openCalls.push(sessionId),
      setActiveView: (viewId) => viewCalls.push(viewId),
      setSidebarCollapsed: (collapsed) => collapseCalls.push(collapsed),
      appendClientLog: (level, event, data) => logs.push([level, event, data]),
      showComposerActionError: (error, title) => errors.push([String(error?.message || error), title]),
    },
    getAttentionInbox: options.getAttentionInbox,
  });

  // Compared, never interpolated: a key may carry selector metacharacters.
  const rowFor = (key) => [...window.document.querySelectorAll('.attention-inbox__row')]
    .find((node) => node.dataset.attentionKey === key) || null;

  return {
    dom, window, document: window.document, state, controller, timers,
    approveCalls, denyCalls, logs, errors, openCalls, collapseCalls, viewCalls,
    host: window.document.getElementById('attentionInbox'),
    badge: () => window.document.getElementById('attentionInboxBadge'),
    rows: () => [...window.document.querySelectorAll('.attention-inbox__row')],
    rowFor,
    title: (key) => {
      const row = rowFor(key);
      return row ? row.querySelector('.attention-inbox__open') : null;
    },
    action: (key, action) => window.document.querySelector(
      `.attention-inbox__row[data-attention-key="${key}"] [data-attention-action="${action}"]`
    ),
  };
}

const approval = (overrides = {}) => ({
  approvalId: 'appr-1', callId: 'call-1', toolName: 'Write', input: { path: 'notes.md' },
  streamId: 'stream-1', sessionId: 's1', summary: 'Write notes.md', oneOffOnly: false, ...overrides,
});
const session = (id, extra = {}) => ({ id, title: `Chat ${id}`, pending_question_batch: null, ...extra });
const map = (entries) => new Map(entries.map((entry) => [entry.approvalId, entry]));
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('an empty inbox stays hidden and grows no badge', () => {
  const h = harness({ sessions: [session('s1')] });
  h.controller.render();
  assert.equal(h.host.hidden, true);
  assert.equal(h.rows().length, 0);
  assert.equal(h.badge(), null, 'the badge is not built until something needs the person');
  h.controller.dispose();
  h.window.close();
});

test('an approval row names the session, the tool, the arguments and the writes-or-not facts', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  assert.equal(h.host.hidden, false);
  const row = h.rows()[0];
  assert.equal(row.dataset.attentionKey, 'approval:call-1');
  assert.match(row.textContent, /Chat s1/);
  assert.match(row.textContent, /Write/);
  assert.match(row.textContent, /notes\.md/);
  assert.match(row.textContent, /Writes notes\.md/);
  assert.equal(h.action('approval:call-1', 'allow').textContent.trim(), 'Allow');
  assert.equal(h.action('approval:call-1', 'always').textContent.trim(), 'Always allow');
  assert.equal(h.action('approval:call-1', 'deny').textContent.trim(), 'Deny');
  assert.ok(h.action('approval:call-1', 'allow').title, 'every control carries a tooltip');
  h.controller.dispose();
  h.window.close();
});

test('a one-off approval is never offered a scope the transcript block would withhold', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval({ oneOffOnly: true })]) });
  h.controller.render();
  assert.equal(h.action('approval:call-1', 'always'), null);
  assert.ok(h.action('approval:call-1', 'allow'));
  h.controller.dispose();
  h.window.close();
});

test('Allow, Always allow and Deny each call the bridge with the approval id and the pressed scope', async () => {
  // The backend keys its pending map by the scoped approval id and only falls
  // back to a call-id scan when the approval does not require an exact
  // reference (runtime-decision approvals do): the transcript card passes the
  // approval id, and so must the inbox, or that approval reads "Already
  // resolved" while the turn is still blocked.
  const h = harness({
    sessions: [session('s1'), session('s2')],
    pendingToolApprovals: map([approval(), approval({ approvalId: 'appr-2', callId: 'call-2', sessionId: 's2' })]),
  });
  h.controller.render();
  h.action('approval:call-1', 'allow').click();
  await tick();
  assert.deepEqual(h.approveCalls, [['appr-1', { alwaysAllow: false }]]);

  h.controller.render();
  h.action('approval:call-2', 'always').click();
  await tick();
  assert.deepEqual(h.approveCalls[1], ['appr-2', { alwaysAllow: true }]);
  h.controller.dispose();
  h.window.close();
});

test('Deny answers the bridge and the answered row leaves at once without a session re-render', async () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  h.action('approval:call-1', 'deny').click();
  await tick();
  assert.deepEqual(h.denyCalls, [['appr-1']]);
  h.controller.render();
  assert.equal(h.rows().length, 0, 'the resolved row is dropped locally; the stream event prunes the map');
  assert.equal(h.host.hidden, true);
  h.controller.dispose();
  h.window.close();
});

test('a row in flight is disabled so one wait cannot be answered twice', () => {
  let settle;
  const h = harness({
    sessions: [session('s1')],
    pendingToolApprovals: map([approval()]),
    approve: () => new Promise((resolve) => { settle = resolve; }),
  });
  h.controller.render();
  h.action('approval:call-1', 'allow').click();
  assert.equal(h.action('approval:call-1', 'allow').disabled, true);
  assert.equal(h.action('approval:call-1', 'deny').disabled, true);
  h.action('approval:call-1', 'allow').click();
  assert.equal(h.approveCalls.length, 1, 'the repeat click is swallowed');
  settle(true);
  h.controller.dispose();
  h.window.close();
});

test('a false result reads "Already resolved" and is logged rather than claimed as approved', async () => {
  const h = harness({
    sessions: [session('s1')],
    pendingToolApprovals: map([approval()]),
    approve: () => Promise.resolve(false),
  });
  h.controller.render();
  h.action('approval:call-1', 'allow').click();
  await tick();
  const row = h.rows()[0];
  assert.match(row.textContent, /Already resolved/);
  assert.equal(/approved/i.test(row.textContent), false, 'nothing may read as approved before the bridge says so');
  assert.equal(h.action('approval:call-1', 'allow'), null, 'a resolved wait offers no more decisions');
  assert.equal(h.logs.at(-1)[1], 'chat.attention_inbox_stale');
  assert.deepEqual(h.errors, [[
    'This approval request was already resolved or is no longer active.', 'Approval Failed',
  ]], 'the same notice the transcript card raises is raised here, because the stale row leaves on the next pass');
  h.controller.render();
  assert.equal(h.rows().length, 0, 'the stale row leaves on the next render');
  h.controller.dispose();
  h.window.close();
});

test('a thrown bridge error surfaces once and leaves the row answerable', async () => {
  const h = harness({
    sessions: [session('s1')],
    pendingToolApprovals: map([approval()]),
    approve: () => Promise.reject(new Error('bridge_gone')),
  });
  h.controller.render();
  h.action('approval:call-1', 'allow').click();
  await tick();
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0][0], 'bridge_gone');
  assert.ok(h.errors[0][1], 'the toast carries a translated title');
  assert.equal(h.action('approval:call-1', 'allow').disabled, false, 'the row is answerable again');
  assert.equal(h.logs.some(([, event]) => event === 'chat.attention_inbox_failed'), true);
  h.controller.dispose();
  h.window.close();
});

test('a plan review is opened, never approved from the row', () => {
  const h = harness({
    sessions: [session('s1')],
    pendingToolApprovals: map([approval({ approvalId: 'p1', callId: 'plan-1', toolName: 'exit_plan_mode', input: { plan: 'do it' } })]),
  });
  h.controller.render();
  const row = h.rows()[0];
  assert.match(row.textContent, /Plan ready for review/);
  assert.equal(h.action('plan_review:plan-1', 'allow'), null);
  assert.equal(h.action('plan_review:plan-1', 'deny'), null);
  h.action('plan_review:plan-1', 'open').click();
  assert.deepEqual(h.openCalls, ['s1']);
  assert.deepEqual(h.approveCalls, []);
  h.controller.dispose();
  h.window.close();
});

test('a question row counts the questions and opens the session to answer them', () => {
  const h = harness({ sessions: [session('s1', { pending_question_batch: questionBatch('b1', 2) })] });
  h.controller.render();
  const row = h.rows()[0];
  assert.match(row.textContent, /2 questions waiting/);
  assert.match(row.textContent, /Pick one/);
  h.action('question:s1:b1', 'answer').click();
  assert.deepEqual(h.openCalls, ['s1']);
  h.controller.dispose();
  h.window.close();
});

test('the badge mirrors the answerable count, hides at zero, and says so out loud', () => {
  const h = harness({
    sessions: [session('s1', { pending_question_batch: questionBatch('b1') })],
    pendingToolApprovals: map([approval()]),
  });
  h.controller.render();
  const badge = h.badge();
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent.trim(), '2');
  assert.equal(badge.getAttribute('aria-label'), '2 things need you');
  assert.equal(badge.previousElementSibling.id, 'workbenchHealthPillSlot', 'the badge is a sibling of the pill slot, never inside it');

  h.state.sessions = [session('s1')];
  h.state.pendingToolApprovals = new Map();
  h.controller.render();
  assert.equal(h.badge().hidden, true);
  assert.equal(h.badge().textContent.trim(), '');
  h.controller.dispose();
  h.window.close();
});

test('one wait reads in the singular', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  assert.equal(h.badge().getAttribute('aria-label'), '1 thing needs you');
  h.controller.dispose();
  h.window.close();
});

test('the badge opens the panel, scrolls the section into view and lands on the first decision', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  const scrolls = [];
  h.host.scrollIntoView = (options) => scrolls.push(options);
  h.controller.render();
  h.badge().click();
  assert.deepEqual(h.viewCalls, ['chat'], 'the section lives in the Chats panel, so the chat view comes first from any view');
  assert.deepEqual(h.collapseCalls, [false]);
  assert.deepEqual(scrolls, [{ block: 'start' }]);
  assert.equal(h.document.activeElement, h.action('approval:call-1', 'allow'));
  h.controller.dispose();
  h.window.close();
});

test('the section collapses, remembers the choice, and survives unreadable storage', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  const toggle = h.document.querySelector('.attention-inbox__toggle');
  assert.equal(toggle.classList.contains('group-label'), true,
    'the heading reuses the panel\'s own group kicker class, like the digest below it');
  const count = toggle.querySelector('.attention-inbox__count');
  assert.ok(count, 'the answerable count is plain text inside the kicker, never a pill beside it');
  assert.equal(count.textContent, '1');
  assert.equal(toggle.querySelector('.attention-inbox__chevron').getAttribute('aria-hidden'), 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click();
  assert.equal(h.document.querySelector('.attention-inbox__toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.querySelector('.attention-inbox__list').hidden, true);
  assert.equal(h.window.localStorage.getItem('jenny.attentionInbox.collapsed'), 'true');
  h.controller.dispose();
  h.window.close();

  const broken = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  Object.defineProperty(broken.window, 'localStorage', {
    get() { throw new Error('storage disabled'); },
    configurable: true,
  });
  broken.controller.render();
  assert.equal(broken.rows().length, 1, 'unreadable storage is not a render failure');
  broken.controller.dispose();
  broken.window.close();
});

test('re-rendering the same inbox touches no DOM', () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  const firstRow = h.rows()[0];
  const firstButton = h.action('approval:call-1', 'allow');
  h.controller.render();
  h.controller.render();
  assert.equal(h.rows()[0], firstRow, 'the row element is not rebuilt');
  assert.equal(h.action('approval:call-1', 'allow'), firstButton);
  h.state.sessions = [session('s1', { title: 'Renamed' })];
  h.controller.render();
  assert.notEqual(h.rows()[0], firstRow, 'a changed inbox does rebuild');
  h.controller.dispose();
  h.window.close();
});

test('the inbox registers no timer and no poll of its own', async () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  h.action('approval:call-1', 'allow').click();
  await tick();
  h.controller.render();
  assert.deepEqual(h.timers, { setTimeout: 0, setInterval: 0 });
  h.controller.dispose();
  h.window.close();
});

test('dispose empties the host, hides it, removes the badge and detaches every listener', async () => {
  const h = harness({ sessions: [session('s1')], pendingToolApprovals: map([approval()]) });
  h.controller.render();
  const allow = h.action('approval:call-1', 'allow');
  h.controller.dispose();
  assert.equal(h.host.hidden, true);
  assert.equal(h.host.children.length, 0);
  assert.equal(h.badge(), null);
  allow.click();
  await tick();
  assert.deepEqual(h.approveCalls, [], 'a detached control asks the bridge for nothing');
  h.controller.dispose();
  h.controller.render();
  assert.equal(h.host.children.length, 0, 'a disposed controller renders nothing');
  h.window.close();
});

test('an injected inbox view is what renders, so the controller holds no model of its own', () => {
  const h = harness({
    getAttentionInbox: () => Object.freeze({
      hidden: false,
      counts: Object.freeze({ approvals: 0, planReviews: 0, questions: 1, answerable: 1 }),
      rows: Object.freeze([Object.freeze({
        key: 'question:sx:bx', kind: 'question', sessionId: 'sx', sessionTitle: 'Injected',
        batchId: 'bx', questionCount: 1, introText: 'Intro', order: 0,
      })]),
    }),
  });
  h.controller.render();
  assert.match(h.rows()[0].textContent, /Injected/);
  assert.equal(h.badge().textContent.trim(), '1');
  h.controller.dispose();
  h.window.close();
});

test('a missing host or a missing badge anchor yields a disposable no-op instead of throwing', () => {
  const controller = createAttentionInboxController({ host: null, state: {}, callbacks: {} });
  assert.equal(typeof controller.render, 'function');
  controller.render();
  controller.dispose();
  assert.equal(typeof createAttentionInboxController().dispose, 'function');
});

/* The wiring proof: index.html's host, the two deferred scripts in their load
 * order, the construction in renderer-app-shell-bindings.js and the render hook
 * on the pass that already redraws the sidebar badges -- all exercised through
 * the real boot rather than a hand-built controller. */
test('the real renderer boots the section and fills it from the session list', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  window.jennyShell.__state.sessions = [
    {
      id: 'wired-1',
      title: 'Wired chat',
      conversation_mode: 'chat',
      preferred_model: 'gpt-test',
      reasoning_effort: 'default',
      context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
      interactive_round_count: 1,
      interactive_sequence_state: 'idle',
      pending_question_batch: {
        batch_id: 'batch-1',
        round_index: 1,
        intro_text: 'Two ways to go',
        questions: [{ id: 'q1', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
      },
      linked_session_ids: [],
      message_count: 1,
      last_message_preview: 'preview',
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      pinned: false,
      archived_at: null,
    },
  ];
  await window.jennyShell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 60);

  const host = window.document.getElementById('attentionInbox');
  assert.ok(host, 'index.html carries the #attentionInbox host');
  assert.equal(host.parentElement.id, 'sidebarHistoryContent');
  // The inbox is the first child of the panel's content, directly above the
  // chat list (the "While you were away" digest lives on Home now).
  assert.equal(host.nextElementSibling.id, 'conversationGroups',
    'the section sits above the chat list');
  assert.equal(host.hidden, false, 'a pending question batch is a wait, so the section shows');
  const row = host.querySelector('.attention-inbox__row[data-attention-key="question:wired-1:batch-1"]');
  assert.ok(row, 'the question batch renders a row without any timer of ours');
  assert.match(row.textContent, /Wired chat/);
  assert.match(row.textContent, /1 question waiting/);
  const badge = window.document.getElementById('attentionInboxBadge');
  assert.ok(badge, 'the titlebar badge is built beside the health pill slot');
  assert.equal(badge.previousElementSibling.id, 'workbenchHealthPillSlot');
  assert.equal(badge.textContent.trim(), '1');
});

test('an approval with nothing declared still says what to review, and a stated reason or scope is shown', () => {
  const h = harness({
    sessions: [session('s1'), session('s2')],
    pendingToolApprovals: map([
      approval({ toolName: 'mcp_lookup', input: { query: 'x' } }),
      approval({
        approvalId: 'appr-2', callId: 'call-2', sessionId: 's2', toolName: 'execute_command',
        input: { command: 'rm -rf build' }, policyScope: 'Local command execution',
        policyConsequence: 'May run a local command and change local state.',
        reason: 'This command can delete or overwrite files (rm). Approve to continue.',
      }),
    ]),
  });
  h.controller.render();
  const [unknown, stated] = h.rows();
  assert.match(unknown.querySelector('.attention-inbox__policy').textContent, /Review requested input/,
    'no facts and no policy: the transcript card\'s own fallback line, never silence');
  assert.equal(unknown.querySelector('.attention-inbox__facts'), null);
  assert.equal(stated.querySelector('.attention-inbox__policy').textContent,
    'Local command execution · This command can delete or overwrite files (rm). Approve to continue.',
    'scope and consequence read as one line, and a stated reason outranks the generic consequence');
  h.controller.dispose();
  h.window.close();
});

test('a call id carrying selector metacharacters is answered, not wedged', async () => {
  const h = harness({
    sessions: [session('s1')],
    pendingToolApprovals: map([approval({ approvalId: 'appr-"]', callId: 'call-"]' })]),
  });
  h.controller.render();
  // The harness's own `action()` interpolates the key into a selector, which
  // is exactly the wedge under test, so this looks the control up directly.
  const allow = h.document.querySelector('[data-attention-action="allow"]');
  assert.ok(allow, 'the row renders');
  allow.click();
  assert.equal(allow.disabled, true, 'the row went busy through the key comparison, not a selector');
  await tick();
  assert.deepEqual(h.approveCalls, [['appr-"]', { alwaysAllow: false }]]);
  h.controller.dispose();
  h.window.close();
});

test('an approval in a background session reaches the inbox on the chrome pass its event queues, and leaves when the call settles', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  const shell = window.jennyShell;
  const summary = (id, title) => ({
    id, title, conversation_mode: 'chat', preferred_model: 'gpt-test', reasoning_effort: 'default',
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    interactive_round_count: 0, interactive_sequence_state: 'idle', pending_question_batch: null,
    linked_session_ids: [], message_count: 1, last_message_preview: 'preview',
    updated_at: new Date().toISOString(), created_at: new Date().toISOString(), pinned: false, archived_at: null,
  });
  shell.__state.sessions = [summary('front-1', 'Front chat'), summary('back-1', 'Background chat')];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 60);
  const rendererState = window.__rendererState;
  const host = window.document.getElementById('attentionInbox');
  assert.equal(host.hidden, true, 'precondition: nothing waits yet');

  await shell.__emitChat({ type: 'started', sessionId: 'back-1', streamId: 'stream-back' });
  await shell.__emitChat({
    type: 'tool_approval_needed', sessionId: 'back-1', streamId: 'stream-back',
    callId: 'call-back', approvalId: 'approval-back', toolName: 'write_file', input: { path: 'notes.md' },
    policyScope: 'Workspace files', policyConsequence: 'May change data in this scope.',
  });
  await waitForUi(window, 80);
  assert.equal(rendererState.pendingToolApprovals.has('approval-back'), true, 'precondition: the approval is pending in state');
  assert.notEqual(String(rendererState.currentSessionId || ''), 'back-1', 'precondition: the approval belongs to a chat that is not on screen');
  const row = host.querySelector('.attention-inbox__row[data-attention-key="approval:call-back"]');
  assert.ok(row, 'a background session\'s approval reaches the inbox with no sessions render and no timer of ours');
  assert.equal(host.hidden, false);
  assert.match(row.textContent, /Background chat/);
  assert.match(row.textContent, /write_file/);
  assert.match(row.textContent, /Writes notes\.md/, 'the writes-or-not facts travel with the row');
  assert.match(row.textContent, /Workspace files/, 'the backend\'s scope travels with the row');
  assert.equal(window.document.getElementById('attentionInboxBadge').textContent.trim(), '1');

  await shell.__emitChat({
    type: 'tool_result', sessionId: 'back-1', streamId: 'stream-back',
    callId: 'call-back', approvalId: 'approval-back', toolName: 'write_file', status: 'complete', output: 'ok',
  });
  await waitForUi(window, 80);
  assert.equal(rendererState.pendingToolApprovals.has('approval-back'), false, 'precondition: the result pruned the approval');
  assert.equal(host.querySelector('[data-attention-key="approval:call-back"]'), null, 'the settled approval leaves on the pass the result queues');
  assert.equal(host.hidden, true);
});
