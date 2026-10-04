// Split view W1-4a: a render pipeline renders THE SESSION ITS PANE HOLDS.
//
// W0-6 (tests/renderer-pane-render-memo-isolation.test.js) proved two pipelines
// keep their own render memos, but it handed each pipeline its OWN `state`
// with its own `currentSessionId`. In production both panes read ONE `state`,
// and `state.currentSessionId` means "the FOCUSED pane's session" -- so a
// pipeline that asked it would paint the focused conversation into every pane.
//
// Every test here therefore drives two real pipelines over ONE shared state
// (one harness `state`, one session store), each pipeline with its own pane
// runtime (`uiRuntime.paneId` 0 and 1) and its own document, and asserts on
// what each timeline RENDERED: article ids and text, never node identity (the
// timeline reconcile reuses an article element across a rebuild, so identity
// cannot tell a memo hit from a rebuild -- the sentinel below can).
//
// One-pane identity is the other half of the contract: with a blank layout and
// pane 0 every read must resolve to `state.currentSessionId`, which the
// untouched render-pipeline suites pin; test 3 and test 5 pin it here too.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPipelineHarness,
  createHarnessState,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');
const {
  createSharedSessionStore,
  createPaneRuntime,
} = require('../renderer/chat/renderer-pane-runtime.js');
const { normalizePaneLayout } = require('../renderer/shell/renderer-pane-model.js');

const SESSION_A = 'session-bound-a';
const SESSION_B = 'session-bound-b';
const SENTINEL_ATTRIBUTE = 'data-pane-bound-sentinel';

function settledMessages(assistantId, text) {
  return [
    {
      id: `u-${assistantId}`,
      role: 'user',
      content: `Prompt for ${assistantId}`,
      status: 'complete',
      timestamp: '2026-09-25T10:00:00.000Z',
    },
    {
      id: assistantId,
      role: 'assistant',
      content: text,
      status: 'complete',
      finalizedAt: '2026-09-25T10:00:05.000Z',
      timestamp: '2026-09-25T10:00:05.000Z',
    },
  ];
}

function promptOnly(userId) {
  return [{
    id: userId,
    role: 'user',
    content: `Prompt ${userId}`,
    status: 'complete',
    timestamp: '2026-09-25T10:00:00.000Z',
  }];
}

function twoPaneLayout(focusedPaneId) {
  return normalizePaneLayout({
    panes: [{ sessionId: SESSION_A }, { sessionId: SESSION_B }],
    focusedPaneId,
  });
}

/* One shared state + one shared session store + two pane runtimes. */
function createSharedRig({ panes, currentSessionId = SESSION_A, messages, harnessOptions = () => ({}) } = {}) {
  const state = createHarnessState({ currentSessionId });
  if (panes !== undefined) state.panes = panes;
  state.sessions = [{ id: SESSION_A, title: 'A' }, { id: SESSION_B, title: 'B' }];
  const messagesBySession = new Map(Object.entries(messages || {
    [SESSION_A]: settledMessages('a1', 'Pane A settled assistant text.'),
    [SESSION_B]: settledMessages('b1', 'Pane B settled assistant text.'),
  }));
  const shared = createSharedSessionStore();
  const panesById = [0, 1].map((paneId) => {
    const dom = createRenderDom();
    return createPipelineHarness({
      dom,
      state,
      messagesBySession,
      uiRuntime: createPaneRuntime({ paneId, shared }),
      ...harnessOptions(paneId, dom.window.document),
    });
  });
  return { state, shared, messagesBySession, pane0: panesById[0], pane1: panesById[1] };
}

function disposeRig(rig) {
  rig.pane0.pipeline.dispose?.();
  rig.pane1.pipeline.dispose?.();
}

function render(harness) {
  withWindowGlobals(harness.dom, () => {
    harness.pipeline.renderMessages({});
  });
}

function renderedArticleIds(harness) {
  return Array.from(harness.dom.window.document.querySelectorAll('#timeline .chat-entry[data-message-id]'))
    .map((node) => node.getAttribute('data-message-id'));
}

function renderedText(harness) {
  return harness.dom.window.document.getElementById('timeline').textContent;
}

test('two pipelines over ONE state render the session each pane holds, not the focused one', (t) => {
  const rig = createSharedRig({ panes: twoPaneLayout(0), currentSessionId: SESSION_A });
  t.after(() => disposeRig(rig));

  render(rig.pane0);
  render(rig.pane1);

  assert.deepEqual(renderedArticleIds(rig.pane0), ['u-a1', 'a1'], 'pane 0 renders A');
  assert.deepEqual(renderedArticleIds(rig.pane1), ['u-b1', 'b1'], 'pane 1 renders B although A is focused');
  assert.match(renderedText(rig.pane0), /Pane A settled assistant text\./);
  assert.doesNotMatch(renderedText(rig.pane0), /Pane B/);
  assert.match(renderedText(rig.pane1), /Pane B settled assistant text\./);
  assert.doesNotMatch(renderedText(rig.pane1), /Pane A/);
  assert.equal(rig.pane0.pipeline.getPaneSessionId(), SESSION_A);
  assert.equal(rig.pane1.pipeline.getPaneSessionId(), SESSION_B);
  // Both sessions' projection contexts live in the one shared store.
  assert.deepEqual([...rig.shared.projectionContextBySession.keys()].sort(), [SESSION_A, SESSION_B].sort());
});

test('focus moving to pane 1 leaves pane 0 on A as a memo HIT and pane 1 on B', (t) => {
  const rig = createSharedRig({ panes: twoPaneLayout(0), currentSessionId: SESSION_A });
  t.after(() => disposeRig(rig));

  render(rig.pane0);
  render(rig.pane1);
  const article = rig.pane0.dom.window.document.querySelector('#timeline [data-message-id="a1"]');
  assert.equal(article?.getAttribute('data-message-id'), 'a1', 'pane 0 must paint a1 before focus moves');
  article.setAttribute(SENTINEL_ATTRIBUTE, '1');
  const signatureBefore = rig.pane0.uiRuntime.messageRenderSignature;
  const canonicalBefore = rig.pane0.uiRuntime.cachedCanonicalMessages;

  // Focus moves: the focused pane's session becomes currentSessionId.
  rig.state.currentSessionId = SESSION_B;
  rig.state.panes = twoPaneLayout(1);
  render(rig.pane0);
  render(rig.pane1);

  assert.deepEqual(renderedArticleIds(rig.pane0), ['u-a1', 'a1'], 'pane 0 still renders A after focus moved');
  assert.deepEqual(renderedArticleIds(rig.pane1), ['u-b1', 'b1'], 'pane 1 still renders B');
  assert.equal(
    rig.pane0.dom.window.document.querySelectorAll(`[${SENTINEL_ATTRIBUTE}]`).length,
    1,
    'pane 0\'s a1 article must not be rebuilt: a focus move is not a change to what pane 0 shows'
  );
  assert.equal(rig.pane0.uiRuntime.messageRenderSignature, signatureBefore, 'pane 0\'s render signature is unchanged');
  assert.equal(rig.pane0.uiRuntime.cachedCanonicalMessages, canonicalBefore, 'pane 0\'s canonical transcript keeps identity');
});

test('a blank layout: pane 0 renders currentSessionId, pane 1 renders nothing and does not throw', (t) => {
  for (const panes of [undefined, normalizePaneLayout(null)]) {
    const rig = createSharedRig({ panes, currentSessionId: SESSION_A });
    t.after(() => disposeRig(rig));

    render(rig.pane0);
    render(rig.pane1);

    const label = `panes=${JSON.stringify(panes)}`;
    assert.equal(rig.pane0.pipeline.getPaneSessionId(), SESSION_A, label);
    assert.equal(rig.pane1.pipeline.getPaneSessionId(), '', label);
    assert.deepEqual(renderedArticleIds(rig.pane0), ['u-a1', 'a1'], `${label}: pane 0 is the one-pane chat`);
    assert.deepEqual(renderedArticleIds(rig.pane1), [], `${label}: pane 1 holds nothing`);
    assert.equal(renderedText(rig.pane1).trim(), '', `${label}: pane 1's timeline is empty`);
  }
});

test('pane 1\'s live thinking state and origin chip come from B, not the focused A', (t) => {
  const previousMultiStream = globalThis.rendererMultiStreamController;
  globalThis.rendererMultiStreamController = {
    getStreamIdForSession(sessionId) { return sessionId === SESSION_B ? 'stream-b' : ''; },
    getSessionIdForStream(streamId) { return streamId === 'stream-b' ? SESSION_B : ''; },
    getPreflight() { return null; },
  };
  t.after(() => { globalThis.rendererMultiStreamController = previousMultiStream; });
  const resets = [0, 0];
  const chips = [];
  const rig = createSharedRig({
    panes: twoPaneLayout(0),
    currentSessionId: SESSION_A,
    // Prompt-only transcripts: an origin chip hides once an assistant replies.
    messages: { [SESSION_A]: promptOnly('u-a'), [SESSION_B]: promptOnly('u-b') },
    harnessOptions(paneId, documentRef) {
      const chip = documentRef.createElement('div');
      chip.className = 'hidden';
      const label = documentRef.createElement('span');
      chip.appendChild(label);
      chips[paneId] = { chip, label };
      return {
        thinkingIndicator: {
          getDisplayState() { return { mode: 'thinking', shouldShow: true }; },
          resetIndicator() { resets[paneId] += 1; },
        },
        composerDom: {
          chatInput: documentRef.createElement('textarea'),
          composer: documentRef.createElement('form'),
          chatOriginChip: chip,
          chatOriginLabel: label,
        },
      };
    },
  });
  t.after(() => disposeRig(rig));
  rig.state.streamThinkingStatusByStream.set('stream-b', { text: 'Reading files', thinkingId: 't-b' });

  // Thinking widget: a pane whose session has no live stream resets its
  // indicator; the pane whose session streams keeps it showing.
  for (const harness of [rig.pane0, rig.pane1]) {
    withWindowGlobals(harness.dom, () => harness.pipeline.renderLiveThinkingChip());
  }
  assert.deepEqual(resets, [1, 0], 'pane 0 (A, idle) resets its indicator; pane 1 (B, streaming) keeps it');

  // Origin chip: each pane's chrome names the origin of the session it holds.
  for (const harness of [rig.pane0, rig.pane1]) {
    harness.pipeline.setSessionOrigin(SESSION_A, 'Origin A');
    harness.pipeline.setSessionOrigin(SESSION_B, 'Origin B');
    withWindowGlobals(harness.dom, () => harness.pipeline.syncComposerVisualState());
  }
  assert.equal(chips[0].label.textContent, 'Origin A');
  assert.equal(chips[1].label.textContent, 'Origin B', 'pane 1\'s chip names B\'s origin, not the focused A\'s');
  assert.equal(chips[1].chip.classList.contains('hidden'), false);
});

test('the old getter names still work: a harness with only the current-session getters renders as today', (t) => {
  const harness = createPipelineHarness({
    dom: createRenderDom(),
    currentSessionId: SESSION_A,
    visibleMessages: settledMessages('a1', 'Current-session only.'),
    callbacks: { getVisibleSessionMessages: undefined, getSessionMessages: undefined },
  });
  t.after(() => harness.pipeline.dispose?.());

  render(harness);

  assert.deepEqual(renderedArticleIds(harness), ['u-a1', 'a1']);
  assert.match(renderedText(harness), /Current-session only\./);
  assert.equal(harness.pipeline.getPaneSessionId(), SESSION_A, 'a bag with no paneId is pane 0');
});
