'use strict';

// Split view W1-4b: the chat shell controller, the composer flow and the send
// path act on the session THEIR PANE holds, through one injectable pane
// session context ({ paneId, getSessionId, setSessionId, isCurrent }).
//
// The two-pane fixture is layout [A, B] with pane 0 focused, so
// `state.currentSessionId` (the FOCUSED pane's session) is A. A pane-1 surface
// must send to B, gate on B's busy state, route every write through its own
// setSessionId and never assign `state.currentSessionId` itself. With no
// context and a blank layout, everything is today's one-pane behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createControllerHarness } = require('./helpers/send-controller-harness');
const { normalizePaneLayout } = require('../renderer/shell/renderer-pane-model');
const { resolvePaneSessionId } = require('../renderer/chat/renderer-pane-visibility-utils');
const { createComposerV2FlowController } = require('../renderer/chat/renderer-composer-v2-flow');
const composerState = require('../renderer/chat/renderer-composer-v2-state');
const { createChatShellController } = require('../renderer/chat/renderer-chat-shell-controller');
const { createMessageBranchController } = require('../renderer/chat/renderer-chat-branch-utils');

const ROOT = path.resolve(__dirname, '..');
const A = 'session-1';
const B = 'session-2';
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Required lazily so the rest of this file reports its own failures while the
// module does not exist yet.
function paneSessionContextModule() {
  return require('../renderer/chat/renderer-pane-session-context');
}

// What W1-4c's pane-bound context does: read the pane's own entry, and place a
// written id in THAT pane of the layout. It never touches currentSessionId.
function paneBoundContext(state, paneId, writes) {
  const read = () => resolvePaneSessionId(state, paneId);
  return {
    paneId,
    getSessionId: read,
    setSessionId(id) {
      const next = String(id || '').trim();
      writes.push(next);
      const panes = state.panes.panes.map((pane, index) => (index === paneId ? { sessionId: next } : pane));
      state.panes = normalizePaneLayout({ panes, focusedPaneId: state.panes.focusedPaneId, splitRatio: state.panes.splitRatio });
    },
    isCurrent: (id) => read() === String(id || '').trim(),
  };
}

// The send harness (one session A, currentSessionId A) grown into the
// two-pane fixture: B exists and pane 1 holds it (or holds nothing).
function twoPaneSendHarness(t, options = {}, paneOneSessionId = B) {
  const writes = [];
  const h = createControllerHarness([], {
    ...options,
    sessionContextFor: (state) => paneBoundContext(state, 1, writes),
  });
  t.after(() => h.restore());
  h.state.sessions.push({ id: B, title: 'Session 2' });
  h.state.messagesBySession.set(B, []);
  h.state.panes = normalizePaneLayout({ panes: [A, paneOneSessionId], focusedPaneId: 0 });
  return { h, writes };
}

test('a pane-1 send targets the session pane 1 holds and leaves the focused session alone', async (t) => {
  const { h, writes } = twoPaneSendHarness(t);

  const result = await h.controller.startPromptSend('hello from pane 1');

  assert.equal(h.calls.startStream.length, 1);
  assert.equal(h.calls.startStream[0].sessionId, B);
  assert.deepEqual(h.calls.optimisticAppend.map((entry) => entry.sessionId), [B]);
  assert.equal(result.streamId, 'stream-regen');
  assert.equal(h.state.currentSessionId, A);
  assert.equal(resolvePaneSessionId(h.state, 0), A);
  assert.equal(resolvePaneSessionId(h.state, 1), B);
  assert.deepEqual(h.calls.activations, [], 'no rail activation for the focused pane');
  assert.deepEqual([...new Set(writes)], [B], 'the dispatch write goes through the pane context, and only names B');
});

test('the busy check for a pane-1 send consults B, not the focused session A', async (t) => {
  // B busy: the pane-1 send queues behind B's stream instead of starting.
  const busyB = twoPaneSendHarness(t);
  busyB.h.multiStreamController.registerStream(B, 'stream_b');
  const queued = await busyB.h.controller.startPromptSend('wait behind B');
  assert.deepEqual({ queued: queued.queued, sessionId: queued.sessionId }, { queued: true, sessionId: B });
  assert.equal(busyB.h.calls.startStream.length, 0);

  // A busy, B idle: A's stream does not block pane 1.
  const busyA = twoPaneSendHarness(t);
  busyA.h.multiStreamController.registerStream(A, 'stream_a');
  await busyA.h.controller.startPromptSend('B is free');
  assert.deepEqual(busyA.h.calls.startStream.map((payload) => payload.sessionId), [B]);

  // A pending approval on B blocks pane 1's send (idle B: nothing to queue behind); one on A does not.
  const approvalB = twoPaneSendHarness(t, { hasPendingToolApprovalForSession: (id) => id === B });
  assert.equal(await approvalB.h.controller.startPromptSend('approval on B'), null);
  assert.equal(approvalB.h.calls.startStream.length, 0);
  const approvalA = twoPaneSendHarness(t, { hasPendingToolApprovalForSession: (id) => id === A });
  await approvalA.h.controller.startPromptSend('approval on A');
  assert.deepEqual(approvalA.h.calls.startStream.map((payload) => payload.sessionId), [B]);
});

test('an optimistic session created by a pane-1 send goes through setSessionId, never currentSessionId', async (t) => {
  const { h, writes } = twoPaneSendHarness(t, {
    startStream: () => ({ sessionId: 'session-new', streamId: 'stream-new' }),
  }, '');

  await h.controller.startPromptSend('a new conversation in pane 1');

  assert.equal(h.calls.startStream[0].sessionId, '', 'a blank pane starts a new session');
  assert.match(writes[0], /^session_local_/, 'the optimistic id is placed through the pane context');
  assert.equal(writes[writes.length - 1], 'session-new');
  assert.equal(h.state.currentSessionId, A);
  assert.equal(resolvePaneSessionId(h.state, 0), A);
});

test('durable send: a pane-1 context sees B as current, so B renders and B gets the acceptance notice', async (t) => {
  let renders = 0;
  const submitted = [];
  const { h } = twoPaneSendHarness(t, {
    durableRuntime: true,
    callbacks: { renderMessages: () => { renders += 1; } },
    shell: { sessionRuntime: { submit: async (payload) => { submitted.push(payload); throw new Error('lost_ack'); } } },
  });
  t.after(() => h.controller.dispose());

  const result = await h.controller.startPromptSend('durable from pane 1');

  assert.deepEqual(submitted.map((payload) => payload.session_id), [B, B]);
  assert.equal(result.sessionId, B);
  assert.equal(renders > 0, true, 'render(B) repaints: B is current for this pane');
  assert.deepEqual(
    h.calls.composerNotices.filter((notice) => notice.options.owner === 'runtime:acceptance').length,
    1,
    'the acceptance-unknown notice is shown for the pane that sent'
  );
  assert.equal(h.state.currentSessionId, A);
});

test('durable send: an optimistic pane-1 session is placed through setSessionId', async (t) => {
  const submitted = [];
  const { h, writes } = twoPaneSendHarness(t, {
    durableRuntime: true,
    shell: {
      sessions: { create: async () => ({ data: { id: 'canonical_session', title: 'New' } }) },
      sessionRuntime: { submit: async (payload) => { submitted.push(payload); return { ok: true, work_id: 'work_1', turn_id: 'turn_1', session_id: payload.session_id, revision: 1, status: 'pending' }; } },
    },
  }, '');
  t.after(() => h.controller.dispose());

  await h.controller.startPromptSend('new durable conversation');
  await tick();

  assert.match(writes[0], /^session_local_/);
  assert.equal(submitted[0].session_id, 'canonical_session');
  assert.equal(h.state.currentSessionId, A);
});

test('composer flow: the send lookup and the guardrail write go through the pane context', async () => {
  const state = {
    currentSessionId: A,
    sessions: [{ id: A }, { id: B, session_type: 'plugin' }],
    interactiveDraftsBySession: new Map(),
    panes: normalizePaneLayout({ panes: [A, B], focusedPaneId: 0 }),
  };
  const writes = [];
  const sends = [];
  const controller = createComposerV2FlowController({
    INTERACTIVE_GUARDRAIL_PROMPT: 'Guardrail prompt',
    INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
    appendClientLog() {},
    chatInput: { value: 'hi' },
    normalizePendingQuestionBatch: (batch) => batch,
    patchSessionSummary() {},
    startPromptSend: async (prompt, options) => { sends.push({ prompt, options }); },
    state,
    windowRef: { jennyShell: { sessions: { setPreferences: async () => ({}) } } },
    sessionContext: paneBoundContext(state, 1, writes),
  });

  // Pane 1 holds B, a plugin session: its Send is swallowed, even though the
  // focused session A would send.
  await controller.handleSend();
  assert.deepEqual(sends, []);

  await controller.requestInteractiveGuardrailAnswer('session-3', { batch_id: 'batch-1', round_index: 1, questions: [] });
  assert.deepEqual(writes, ['session-3']);
  assert.equal(state.currentSessionId, A);
  assert.equal(sends[0].options.sessionIdOverride, 'session-3');

  // Already current for this pane: no write.
  await controller.requestInteractiveGuardrailAnswer('session-3', { batch_id: 'batch-2', round_index: 1, questions: [] });
  assert.deepEqual(writes, ['session-3']);
});

test('default context: no sessionContext and a blank layout is today\'s currentSessionId, read and written', () => {
  const { createPaneSessionContext } = paneSessionContextModule();
  for (const panes of [undefined, normalizePaneLayout(null), normalizePaneLayout({ panes: ['', ''] })]) {
    for (const current of ['  session-x  ', '', null, undefined, 'session-y']) {
      const state = { currentSessionId: current, ...(panes ? { panes } : {}) };
      const context = createPaneSessionContext({ state });
      assert.equal(context.paneId, 0);
      assert.equal(context.getSessionId(), String(current || '').trim(), `current=${String(current)}`);
      assert.equal(context.isCurrent(`  ${String(current || '').trim()} `), true);
      assert.equal(context.isCurrent('session-other'), false);
    }
    const state = { currentSessionId: 'session-x', ...(panes ? { panes } : {}) };
    const context = createPaneSessionContext({ state });
    context.setSessionId('  session-z ');
    assert.equal(state.currentSessionId, 'session-z');
    context.setSessionId(null);
    assert.equal(state.currentSessionId, '');
  }
});

test('default context: the paneId shorthand reads that pane and never writes the focused mirror', () => {
  const { createPaneSessionContext } = paneSessionContextModule();
  const state = { currentSessionId: A, panes: normalizePaneLayout({ panes: [A, B], focusedPaneId: 0 }) };
  const paneOne = createPaneSessionContext({ state, paneId: 1 });
  assert.equal(paneOne.paneId, 1);
  assert.equal(paneOne.getSessionId(), B);
  assert.equal(paneOne.isCurrent(B), true);
  assert.equal(paneOne.isCurrent(A), false);
  paneOne.setSessionId('session-3');
  assert.equal(state.currentSessionId, A);
  assert.equal(resolvePaneSessionId(state, 1), B);
  assert.throws(() => createPaneSessionContext({ state, paneId: -1 }), TypeError);
  assert.throws(() => createPaneSessionContext({ state, paneId: '1' }), TypeError);
});

test('default context: every sub-module built without a context keeps one-pane identity', async (t) => {
  // Send utils: the optimistic write still lands on currentSessionId.
  const h = createControllerHarness([], { startStream: () => ({ sessionId: 'session-new', streamId: 'stream-new' }) });
  t.after(() => h.restore());
  h.state.currentSessionId = '';
  await h.controller.startPromptSend('first message');
  assert.equal(h.state.currentSessionId, 'session-new');

  // Composer state: the pending skill is keyed by currentSessionId without a context,
  // and by the pane's session with one.
  const state = { currentSessionId: A, panes: normalizePaneLayout({ panes: [A, B], focusedPaneId: 0 }) };
  composerState.setPendingSkillInvocation(state, { id: 'skill-1', name: 'Skill' });
  assert.equal(composerState.getPendingSkillInvocation(state)?.id, 'skill-1');
  composerState.setPendingSkillInvocation(state, { id: 'skill-2', name: 'Skill' }, paneBoundContext(state, 1, []));
  assert.equal(composerState.getPendingSkillInvocation(state, paneBoundContext(state, 1, []))?.id, 'skill-2');
  assert.equal(composerState.getPendingSkillInvocation(state), null, 'a skill bound to pane 1 does not steer the focused pane');

  // Branch utils: the branch write goes through the injected context.
  const branchWrites = [];
  const branchState = { currentSessionId: A, panes: normalizePaneLayout({ panes: [A, B], focusedPaneId: 0 }) };
  const forked = [];
  const branch = createMessageBranchController({
    state: branchState,
    sessionContext: paneBoundContext(branchState, 1, branchWrites),
    jennyShellSessions: { forkSession: async (...args) => { forked.push(args[0]); return { id: 'session-branch' }; } },
    getCurrentSessionMessages: () => [{ id: 'msg_user', role: 'user', content: 'Hello' }],
    loadSessions: async () => {},
  });
  await branch.branchFromMessage('msg_user');
  assert.deepEqual(forked, [B], 'pane 1 forks the session it holds');
  assert.deepEqual(branchWrites, ['session-branch']);
  assert.equal(branchState.currentSessionId, A);
});

function withGlobals(t, entries) {
  const previous = Object.fromEntries(Object.keys(entries).map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, entries);
  t.after(() => { Object.assign(globalThis, previous); });
}

function shellDeps(state, extra = {}) {
  const seen = {};
  const deps = {
    state,
    windowRef: { jennyShell: { chat: {} } },
    slashDependencies: { getInteractiveComposerStatusNotice() { return null; } },
    dom: { chatInput: { value: '', disabled: false } },
    constants: { MESSAGE_STATUS: {}, TOAST_SOURCE: {}, ACTIVITY_SCOPE: {} },
    controllers: {},
    callbacks: {
      renderAll() {},
      appendClientLog() {},
      showToastMessage() {},
      getCurrentSessionMessages() { return []; },
      isSessionStreaming: (id) => { (seen.streamingChecks ||= []).push(id); return false; },
      hasPendingToolApprovalForSession: () => false,
    },
    factories: {
      sendUtils: { createSendController(d) { seen.send = d; return {}; } },
      composerFlowUtils: { createComposerV2FlowController(d) { seen.flow = d; return {}; } },
      chatEventUtils: { createChatEventBindings(d) { seen.chatEvent = d; return { bind() {}, dispose() {} }; } },
    },
    ...extra,
  };
  return { deps, seen };
}

function spySubControllers(t) {
  const got = {};
  const spy = (name) => (d) => { got[name] = d; return {}; };
  withGlobals(t, {
    rendererResumeTurnInteraction: { createResumeTurnInteraction: spy('resume') },
    rendererChatMessageEditUtils: { createMessageEditController: spy('edit') },
    rendererChatBranchUtils: { createMessageBranchController: spy('branch') },
    rendererChatSelectionUtils: { createSelectionController: spy('selection') },
    rendererChatBulkActionsUtils: { createBulkActionsController: spy('bulk') },
    rendererChatUnreadOrientationUtils: { createUnreadOrientationController: spy('unread') },
  });
  return got;
}

test('shell controller: paneId 1 hands a pane-1 context to every sub-controller', (t) => {
  const got = spySubControllers(t);
  const state = { currentSessionId: A, ui: {}, panes: normalizePaneLayout({ panes: [A, B], focusedPaneId: 0 }) };
  const { deps, seen } = shellDeps(state, { paneId: 1 });

  createChatShellController(deps);

  for (const name of ['resume', 'edit', 'branch', 'selection', 'bulk', 'unread']) {
    assert.equal(got[name]?.getCurrentSessionId?.(), B, `${name} reads pane 1's session`);
  }
  for (const [name, d] of [['send', seen.send], ['flow', seen.flow], ['chatEvent', seen.chatEvent], ['branch', got.branch]]) {
    assert.equal(d.sessionContext?.paneId, 1, `${name} receives the pane-1 context`);
    assert.equal(d.sessionContext.getSessionId(), B, `${name} context reads B`);
  }
  // The seventh site: the edit controller's busy gate asks about B.
  assert.deepEqual(got.edit.resolveFollowUpActionBlock(), { blocked: false });
  assert.deepEqual(seen.streamingChecks, [B]);
  assert.equal(state.currentSessionId, A);
});

test('shell controller: an injected context is passed through as-is, and a malformed one is refused', (t) => {
  const got = spySubControllers(t);
  const state = { currentSessionId: A, ui: {}, panes: normalizePaneLayout({ panes: [A, B], focusedPaneId: 0 }) };
  const context = paneBoundContext(state, 1, []);
  const { deps, seen } = shellDeps(state, { sessionContext: context });

  createChatShellController(deps);

  assert.equal(seen.send.sessionContext, context);
  assert.equal(seen.flow.sessionContext, context);
  assert.equal(seen.chatEvent.sessionContext, context);
  assert.equal(got.branch.sessionContext, context);
  assert.equal(got.selection.getCurrentSessionId(), B);

  assert.throws(
    () => createChatShellController(shellDeps(state, { sessionContext: { getSessionId: () => B } }).deps),
    /sessionContext/
  );
});

test('shell controller: the one-pane default, with and without the context module loaded', (t) => {
  const got = spySubControllers(t);
  const state = { currentSessionId: '  session-1 ', ui: {} };
  const { deps, seen } = shellDeps(state);
  createChatShellController(deps);
  assert.equal(seen.send.sessionContext.paneId, 0);
  assert.equal(seen.send.sessionContext.getSessionId(), A);
  assert.equal(got.resume.getCurrentSessionId(), A);
  seen.send.sessionContext.setSessionId(' session-9 ');
  assert.equal(state.currentSessionId, 'session-9');

  // Browser load order today: the context module has no <script> tag yet
  // (W1-4c adds it), so the shell controller builds its inline default.
  const context = vm.createContext({ rendererPaneVisibilityUtils: require('../renderer/chat/renderer-pane-visibility-utils') });
  const source = path.join(ROOT, 'renderer/chat/renderer-chat-shell-controller.js');
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  assert.equal(context.rendererPaneSessionContext, undefined);
  const browserState = { currentSessionId: ' session-1 ', ui: {} };
  const browser = shellDeps(browserState);
  context.rendererChatShellControllerUtils.createChatShellController(browser.deps);
  const inline = browser.seen.send.sessionContext;
  assert.equal(inline.paneId, 0);
  assert.equal(inline.getSessionId(), A);
  assert.equal(inline.isCurrent(A), true);
  inline.setSessionId(' session-9 ');
  assert.equal(browserState.currentSessionId, 'session-9');
  assert.equal(browser.seen.flow.sessionContext, inline);
  // The inline default honours the paneId shorthand too.
  const paneState = { currentSessionId: A, ui: {}, panes: normalizePaneLayout({ panes: [A, B], focusedPaneId: 0 }) };
  const paneBrowser = shellDeps(paneState, { paneId: 1 });
  context.rendererChatShellControllerUtils.createChatShellController(paneBrowser.deps);
  assert.equal(paneBrowser.seen.send.sessionContext.getSessionId(), B);
  paneBrowser.seen.send.sessionContext.setSessionId('session-3');
  assert.equal(paneState.currentSessionId, A);
});
