'use strict';

// Split view W1-4c, LOAD-BEARING (W1_SPEC §3, addendum §8.3): a stream into
// the non-focused pane's session re-renders THAT pane only.
//
// Part A pins the render-frame routing in renderer-stream-handler-runtime.js:
// one rAF latch, `messages`/`composer` keyed per session and routed through
// the pane composition's `renderSessionPane(sessionId, kind)`; no router (or a
// one-pane composition answering `undefined`) is exactly the pre-split path.
// Part B drives the real shell (jsdom harness): two mounted panes, deltas into
// pane 1's session while pane 0 is focused; pane 0's timeline is byte-identical
// and exactly one pipeline render runs per delta.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamHandlerRuntime } = require('../renderer/chat/renderer-stream-handler-runtime.js');

function withManualFrames(t) {
  const saved = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    globalThis.requestAnimationFrame = saved.requestAnimationFrame;
    globalThis.cancelAnimationFrame = saved.cancelAnimationFrame;
  });
  return {
    frames,
    runFrames() {
      while (frames.length) frames.shift()(0);
    },
  };
}

function createRoutedRuntime(t, { router, visible = ['session-a', 'session-b'], current = 'session-a' } = {}) {
  const calls = [];
  const state = {
    currentSessionId: current,
    ui: { activeView: 'chat' },
    pendingStreams: new Map(),
    pendingToolApprovals: new Map(),
    toolCallsByStream: new Map(),
    messagesBySession: new Map(),
    streamThinkingStatusByStream: new Map(),
  };
  const options = {
    state,
    renderAll: () => calls.push(['renderAll']),
    renderHeader: () => calls.push(['renderHeader']),
    renderMessages: () => calls.push(['renderMessages']),
    renderComposerState: () => calls.push(['renderComposerState']),
    renderComposerStatusNotice: () => calls.push(['renderComposerStatusNotice']),
    renderWorkspaceChrome: () => calls.push(['renderWorkspaceChrome']),
    isCurrentSession: (id) => id === state.currentSessionId,
    isVisibleChatSession: (id) => visible.includes(id),
    markHiddenRenderableEvent: (event) => calls.push(['hidden', event.sessionId]),
  };
  if (router !== undefined) {
    options.renderSessionPane = (sessionId, kind) => {
      calls.push(['pane', sessionId, kind]);
      return router(sessionId, kind);
    };
  }
  const runtime = createStreamHandlerRuntime(options);
  t.after(() => runtime.disposeRenderQueue());
  return { runtime, calls, state };
}

test('A1: a delta into the non-focused pane routes one keyed messages render and never the global one', (t) => {
  const frames = withManualFrames(t);
  const { runtime, calls } = createRoutedRuntime(t, { router: () => true });
  runtime.queueSessionRender('session-b', { messages: true });
  runtime.queueSessionRender('session-b', { messages: true });
  assert.equal(frames.frames.length, 1, 'one latch: a second delta in the same frame schedules nothing new');
  frames.runFrames();
  const renders = calls.filter(([kind]) => kind === 'pane' || kind === 'renderMessages');
  assert.deepEqual(renders, [['pane', 'session-b', 'messages']], 'exactly one pane render, no global renderMessages');
});

test('A2: two panes streaming in one frame each get one keyed render, still one latch', (t) => {
  const frames = withManualFrames(t);
  const { runtime, calls } = createRoutedRuntime(t, { router: () => true });
  runtime.queueSessionRender('session-a', { messages: true, composer: true });
  runtime.queueSessionRender('session-b', { messages: true });
  assert.equal(frames.frames.length, 1);
  frames.runFrames();
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'pane'),
    [['pane', 'session-a', 'messages'], ['pane', 'session-b', 'messages'], ['pane', 'session-a', 'composer']],
    'messages keyed renders drain at the messages position, composer ones at the composer position'
  );
  assert.equal(calls.some(([kind]) => kind === 'renderMessages' || kind === 'renderComposerState'), false);
});

test('A3: a router answering undefined (one pane) falls back to the global render once', (t) => {
  const frames = withManualFrames(t);
  const { runtime, calls } = createRoutedRuntime(t, { router: () => undefined });
  runtime.queueSessionRender('session-a', { messages: true, composer: true });
  runtime.queueSessionRender('session-a', { messages: true });
  frames.runFrames();
  assert.deepEqual(
    calls.filter(([kind]) => kind !== 'renderWorkspaceChrome'),
    [['pane', 'session-a', 'messages'], ['renderMessages'], ['pane', 'session-a', 'composer'], ['renderComposerState']]
  );
});

test('A4: a session the frame finds in no pane takes the hidden catch-up path', (t) => {
  const frames = withManualFrames(t);
  const { runtime, calls } = createRoutedRuntime(t, { router: () => false });
  runtime.queueSessionRender('session-b', { messages: true });
  frames.runFrames();
  assert.deepEqual(
    calls.filter(([kind]) => kind !== 'renderWorkspaceChrome'),
    [['pane', 'session-b', 'messages'], ['hidden', 'session-b']]
  );
});

test('A5: without a router the frame is exactly the pre-split flat queue', (t) => {
  const frames = withManualFrames(t);
  const { runtime, calls } = createRoutedRuntime(t, {});
  runtime.queueSessionRender('session-a', { header: true, messages: true, composer: true });
  frames.runFrames();
  assert.deepEqual(calls, [['renderWorkspaceChrome'], ['renderHeader'], ['renderMessages'], ['renderComposerState']]);
});

test('A6: a full render wins over keyed renders queued in the same frame', (t) => {
  const frames = withManualFrames(t);
  const { runtime, calls } = createRoutedRuntime(t, { router: () => true });
  runtime.queueSessionRender('session-b', { messages: true });
  runtime.queueRender({ full: true });
  frames.runFrames();
  assert.deepEqual(calls, [['renderAll']]);
});

test('A7: a session-tagged queueRender (the delta commit, thinking and phase paths) is keyed like queueSessionRender', (t) => {
  const frames = withManualFrames(t);
  const { runtime, calls } = createRoutedRuntime(t, { router: () => true });
  runtime.queueRender({ messages: true }, { sessionId: 'session-b' });
  runtime.queueRender({ messages: true }, { sessionId: 'session-b' });
  frames.runFrames();
  assert.deepEqual(calls, [['pane', 'session-b', 'messages']]);
});

test('A8: an untagged queueRender keeps the flat global flag', (t) => {
  const frames = withManualFrames(t);
  const { runtime, calls } = createRoutedRuntime(t, { router: () => true });
  runtime.queueRender({ messages: true });
  frames.runFrames();
  assert.deepEqual(calls, [['renderMessages']]);
});

/* ── Part B: the real shell, two panes ── */

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function buildSummary(id, title) {
  return {
    id,
    title,
    session_type: 'chat',
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function transcript(sessionId, text) {
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Question for ${text}`, status: 'complete' },
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Answer from ${text}.`, status: 'complete', finalizedAt: new Date().toISOString() },
  ];
}

async function openTwoPanes(t, extraShell = {}) {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'] },
    sessionMessagePayloads: {
      'session-a': { data: transcript('session-a', 'pane zero') },
      'session-b': { data: transcript('session-b', 'pane one') },
    },
    ...extraShell,
  } });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const tab = doc.querySelector('.workspace-rail-tab[data-session-id="session-b"]');
  assert.ok(tab, 'precondition: session-b is an open rail tab');
  tab.dispatchEvent(new window.MouseEvent('contextmenu', { clientX: 5, clientY: 5, bubbles: true }));
  const openBeside = [...doc.querySelectorAll('.workspace-tab-context-menu-item')].find((item) => item.textContent === 'Open beside');
  assert.ok(openBeside, 'the tab menu offers Open beside');
  openBeside.click();
  await waitForUi(window, 150);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  const pane1 = composition.getPane(1);
  assert.ok(pane1, 'pane 1 is mounted');
  return { app, window, doc, composition, pane1 };
}

test('B1: two panes from the tab menu: pane 1 shows its own transcript, pane 0 keeps focus and its own', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const chatView = doc.getElementById('chatView');
  assert.equal(chatView.dataset.paneCount, '2');
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'focus stays on pane 0');
  assert.match(doc.getElementById('chatTimeline').textContent, /Answer from pane zero/);
  assert.doesNotMatch(doc.getElementById('chatTimeline').textContent, /pane one/);
  assert.match(pane1.dom.chatTimeline.textContent, /Answer from pane one/);
  assert.doesNotMatch(pane1.dom.chatTimeline.textContent, /pane zero/);
  assert.equal(doc.getElementById('chatPaneKicker').hidden, false);
  assert.match(doc.getElementById('chatPaneKicker').textContent, /Alpha/);
  assert.match(pane1.dom.chatPaneKicker.textContent, /Beta/);
});

test('B2 (LOAD-BEARING): a stream into pane 1 while pane 0 is focused leaves pane 0 byte-identical, one render per delta', async (t) => {
  const { window, doc, pane1, composition } = await openTwoPanes(t, {
    chat: {
      async startStream(payload) {
        return { sessionId: payload.sessionId, streamId: 'stream-b' };
      },
    },
  });
  const shell = window.jennyShell;
  // Send from pane 1's own composer: the send goes to pane 1's session.
  pane1.dom.chatInput.value = 'stream into the side pane';
  pane1.dom.chatInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  pane1.sendButton.click();
  await waitForUi(window, 60);
  const chatCalls = shell.__state.chatCalls;
  assert.equal(chatCalls.length, 1, 'one send');
  assert.equal(chatCalls[0].sessionId, 'session-b', "pane 1's composer sends to pane 1's session");
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'the send did not move focus');

  const emit = (payload) => shell.__emitChat({ sessionId: 'session-b', streamId: 'stream-b', ...payload });
  await emit({ type: 'started' });
  await waitForUi(window, 30);

  const pane0Timeline = doc.getElementById('chatTimeline');
  const before = pane0Timeline.innerHTML;
  const mutations = [];
  const observer = new window.MutationObserver((records) => mutations.push(...records));
  observer.observe(pane0Timeline, { childList: true, subtree: true, attributes: true, characterData: true });
  t.after(() => observer.disconnect());

  const pipeline = composition.getPane(1).pipeline;
  const renderMessages = pipeline.renderMessages;
  let pane1Renders = 0;
  pipeline.renderMessages = (...args) => { pane1Renders += 1; return renderMessages(...args); };

  const routed = [];
  const originalRoute = composition.renderSessionPane;
  composition.renderSessionPane = (...args) => { const r = originalRoute(...args); routed.push([...args, r]); return r; };
  const deltas = ['First words. ', 'Second words. ', 'Third words.'];
  let aggregate = '';
  for (const piece of deltas) {
    aggregate += piece;
    await emit({ type: 'delta', content: piece, aggregate });
    // Past the 50 ms stream-commit coalescing window, so each delta commits
    // (and renders) on its own frame.
    await waitForUi(window, 90);
  }

  assert.equal(pane0Timeline.innerHTML, before, "pane 0's timeline is byte-identical across the pane-1 stream");
  assert.deepEqual(mutations, [], 'pane 0 was not touched at all');
  assert.equal(pane1Renders, deltas.length, 'exactly one pane-1 render per delta');
  assert.deepEqual(routed, deltas.map(() => ['session-b', 'messages', true]), 'every delta frame routed to pane 1 only');
  assert.match(pane1.dom.chatTimeline.textContent, /First words\. Second words\. Third words\./, 'pane 1 shows the stream');
  assert.equal(pane1.stopButton.classList.contains('hidden'), false, "pane 1's Stop shows while its session streams");
});

test('B3: closing pane 1 from its kicker returns the chat view to the exact one-pane DOM', async (t) => {
  const app = await loadRendererApp({ shell: {
    sessions: [buildSummary('session-a', 'Alpha'), buildSummary('session-b', 'Beta')],
    workspaceState: { activeSessionId: 'session-a', openSessionIds: ['session-a', 'session-b'] },
    sessionMessagePayloads: { 'session-a': { data: transcript('session-a', 'pane zero') }, 'session-b': { data: transcript('session-b', 'pane one') } },
  } });
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  await waitForUi(window, 150);
  const chatView = doc.getElementById('chatView');
  const shape = () => [...chatView.children].map((child) => [child.tagName, child.id, child.className, child.getAttribute('data-pane-focused'), child.hidden]);
  const oneAttrs = () => [chatView.dataset.paneCount, chatView.style.getPropertyValue('--chat-pane-a'), doc.getElementById('chatPaneKicker').hidden, doc.getElementById('chatPaneKicker').innerHTML];
  const before = { shape: shape(), attrs: oneAttrs() };

  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'the chord opens the most recent other tab beside');
  await waitForUi(window, 100);
  assert.equal(chatView.dataset.paneCount, '2');
  const close = composition.getPane(1).dom.chatPaneKicker.querySelector('.chat-pane-close');
  close.click();
  await waitForUi(window, 100);
  assert.deepEqual(shape(), before.shape, '#chatView children are exactly the one-pane set again');
  assert.deepEqual(oneAttrs(), before.attrs, 'pane count, split tracks and the kicker are back to one-pane values');
  assert.equal(window.__rendererState.currentSessionId, 'session-a');
  assert.match(doc.getElementById('chatTimeline').textContent, /Answer from pane zero/);
});
