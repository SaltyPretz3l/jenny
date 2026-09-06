// CTL-004 acceptance contract: a settled message replaced by OBJECT
// REPLACEMENT with new nested content (settled text edit, monitor metadata,
// generated-artifact metadata) must reach the render — the #15 structural
// cache may skip the heavy rebuilds, but it must not feed STALE object refs to
// the fingerprint pass, where an unchanged render signature no-ops the whole
// render. Uses the REAL canonical builder and the REAL fingerprint pipeline;
// only DOM markup production is simplified (it records exactly which message
// objects reach the full render and writes their nested values into the DOM).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createRenderPipelineMessageRenderer,
} = require('../renderer/chat/renderer-render-pipeline-message-renderer');
const {
  createProjectionCachePipeline,
} = require('../renderer/chat/renderer-render-pipeline-projection-cache');
const rendererMessageIndexUtils = require('../renderer/chat/renderer-message-index-utils');

function createSettledRefreshHarness(initialMessages, options = {}) {
  const dom = new JSDOM(`
    <main>
      <section id="scroll"><div id="timeline"></div></section>
    </main>
  `);
  let sourceMessages = initialMessages;
  const state = {
    currentSessionId: 'session-settled-refresh',
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    ui: { animateNextChatActivation: false, chatMode: 'thread' },
  };
  const uiRuntime = {};
  const projectionPipeline = createProjectionCachePipeline({
    state,
    dom: {},
    runtime: { uiRuntime },
    callbacks: {},
  });
  const fullRenders = { count: 0, lastMessages: null };
  const timeline = dom.window.document.getElementById('timeline');

  function renderArticleHtml(message) {
    const monitorProgress = message?.tool_result?.metadata?.monitor?.progress;
    const artifacts = Array.isArray(message?.tool_result?.generated_artifacts)
      ? message.tool_result.generated_artifacts.map((artifact) => String(artifact?.name || '')).join(',')
      : '';
    return `<article class="chat-entry" data-message-id="${message.id}">`
      + `${String(message.content || '')}`
      + (monitorProgress !== undefined ? `|monitor:${monitorProgress}` : '')
      + (artifacts ? `|artifacts:${artifacts}` : '')
      + '</article>';
  }

  const renderer = createRenderPipelineMessageRenderer({
    state,
    dom: {
      chatTimeline: timeline,
      chatThreadScroll: dom.window.document.getElementById('scroll'),
    },
    controllers: {
      reducedMotionQuery: { matches: false },
      thinkingController: { prune() {}, resumeAutoScroll() {} },
    },
    runtime: { uiRuntime },
    callbacks: {
      pruneToolRowProjectionSessionCaches() {},
      getCurrentVisibleMessages() { return sourceMessages; },
      // REAL canonical transcript builder (projection-cache module).
      buildCanonicalTranscriptMessages: projectionPipeline.buildCanonicalTranscriptMessages,
      // REAL fingerprint pipeline — the seam the defect lives on.
      computeMessageFingerprintList: rendererMessageIndexUtils.computeMessageFingerprintList,
      renderSignatureFromFingerprints: rendererMessageIndexUtils.renderSignatureFromFingerprints,
      computeStructureHash: rendererMessageIndexUtils.computeStructureHash,
      pruneRecapExpansionState() {},
      updateTokenDisplay() {},
      computeDerivedMessageState() {
        return {
          latestAssistantMessageId: '',
          latestReplyAssistantMessageId: '',
          thinkingMessageIds: [],
          streamingMessage: null,
          idToIndex: new Map(),
        };
      },
      buildTranscriptThreadTree: typeof options.buildThreadTree === 'function'
        ? options.buildThreadTree
        : () => ({ nodeById: new Map(), roots: [] }),
      buildProjectionContext() { return {}; },
      pruneThreadBranchState() {},
      collectThreadBranchIds() { return new Set(); },
      getForcedOpenStreamingMessageId() { return ''; },
      isSendBusy() { return false; },
      isSendPreflightPending() { return false; },
      syncChatState() {},
      resetStreamRevealState() {},
      setFollowLatest() {},
      hideAssistantSprite() {},
      syncTimelineBusyState() {},
      syncPostRenderChrome() {},
      runPostTimelineRenderEffects() {},
      updateAssistantSpritePosition() {},
      // The full render records the message array it is handed and writes each
      // message's nested values into the timeline so DOM assertions are real.
      performFullMessageRender(messages, threadTree) {
        fullRenders.count += 1;
        fullRenders.lastMessages = messages;
        fullRenders.lastThreadTree = threadTree;
        timeline.innerHTML = messages.map(renderArticleHtml).join('');
      },
      buildMessageArticleMarkup(message) { return renderArticleHtml(message); },
      buildMessageInnerMarkup() { return { innerHtml: '', pending: false, entryReveal: false, status: '', finalizedAt: '' }; },
      buildMessageArticleInnerHtml() { return ''; },
      deriveTimelineTimeDividers() { return []; },
      buildTimeDividerMap() { return new Map(); },
      buildMessageRenderSignature: rendererMessageIndexUtils.buildMessageRenderSignature,
      buildTimelineDividerInputSignature() { return 'divider'; },
      buildRecapExpansionSignature() { return 'recap'; },
      buildThreadExpansionSignature() { return 'thread'; },
    },
  });

  return {
    fullRenders,
    timeline,
    uiRuntime,
    render() { renderer.renderMessages(); },
    setMessages(next) { sourceMessages = next; },
  };
}

function settledTurn() {
  return [
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', finalizedAt: 't2', streamId: 's1', content: 'original answer' },
  ];
}

test('settled DIFFERENT-length content replacement re-renders with the fresh object', () => {
  const harness = createSettledRefreshHarness(settledTurn());
  harness.render();
  assert.equal(harness.fullRenders.count, 1, 'initial full render');

  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', finalizedAt: 't2', streamId: 's1', content: 'a corrected, longer answer' },
  ]);
  harness.render();

  assert.equal(harness.fullRenders.count, 2, 'a settled content replacement must not no-op');
  const freshRef = harness.fullRenders.lastMessages.find((message) => message.id === 'a1');
  assert.equal(freshRef.content, 'a corrected, longer answer', 'the render sees the FRESH object, not the cached stale ref');
  assert.match(harness.timeline.innerHTML, /a corrected, longer answer/, 'the new content reaches the DOM');
});

test('settled SAME-length content replacement re-renders (fingerprints must see the new object value)', () => {
  const harness = createSettledRefreshHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', finalizedAt: 't2', streamId: 's1', content: 'abc' },
  ]);
  harness.render();

  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', finalizedAt: 't2', streamId: 's1', content: 'xyz' },
  ]);
  harness.render();

  assert.equal(harness.fullRenders.count, 2, 'same-length replacement must not no-op');
  assert.match(harness.timeline.innerHTML, /xyz/, 'the replaced content reaches the DOM');
  assert.doesNotMatch(harness.timeline.innerHTML, /data-message-id="a1">abc/, 'the stale content is gone');
});

test('tool_result.metadata.monitor update with unchanged status reaches the DOM (the background-monitor path)', () => {
  const monitorMessage = (progress) => ({
    id: 'tr1', role: 'assistant', kind: 'tool_result', status: 'complete', finalizedAt: 't3',
    tool_result: {
      call_id: 'call_1', tool_name: 'run_command', status: 'completed',
      metadata: { monitor: { progress, note: 'background job' } },
    },
  });
  const harness = createSettledRefreshHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    monitorMessage(0.2),
  ]);
  harness.render();
  assert.match(harness.timeline.innerHTML, /monitor:0\.2/, 'initial monitor presentation');

  // Same id/role/kind/status/finalizedAt — only the nested monitor payload
  // changed via object replacement (monitor-event-service updateMessage path).
  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    monitorMessage(0.9),
  ]);
  harness.render();

  assert.equal(harness.fullRenders.count, 2, 'a monitor metadata update must not hit the render no-op guard');
  assert.match(harness.timeline.innerHTML, /monitor:0\.9/, 'the new monitor progress reaches the DOM');
  assert.doesNotMatch(harness.timeline.innerHTML, /monitor:0\.2/, 'the stale monitor presentation is gone');
});

test('generated-artifact metadata update on a settled tool result reaches the DOM', () => {
  const artifactMessage = (artifactName) => ({
    id: 'tr2', role: 'assistant', kind: 'tool_result', status: 'complete', finalizedAt: 't4',
    tool_result: {
      call_id: 'call_2', tool_name: 'create_artifact', status: 'completed',
      generated_artifacts: [{ name: artifactName, path: `C:/artifacts/${artifactName}` }],
    },
  });
  const harness = createSettledRefreshHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    artifactMessage('draft-v1.html'),
  ]);
  harness.render();

  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    artifactMessage('draft-v2.html'),
  ]);
  harness.render();

  assert.equal(harness.fullRenders.count, 2, 'an artifact metadata update must not no-op');
  assert.match(harness.timeline.innerHTML, /artifacts:draft-v2\.html/, 'the updated artifact metadata reaches the DOM');
});

test('same-session hydration refresh: identical ids/roles/statuses with one changed nested value re-renders', () => {
  const harness = createSettledRefreshHarness(settledTurn());
  harness.render();

  // Terminal hydration replaces the WHOLE array with fresh normalized objects;
  // ids/roles/statuses identical, but the store's copy of a1 has newer text.
  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', finalizedAt: 't2', streamId: 's1', content: 'store-corrected answer' },
  ]);
  harness.render();

  assert.equal(harness.fullRenders.count, 2, 'the hydration refresh with changed content must render');
  assert.match(harness.timeline.innerHTML, /store-corrected answer/);
});

// Green pin (I2 / CTL-012 guard): an identical-content refresh — new objects,
// replacement is deliberately authoritative even when sampled values match.
// Avoiding arbitrary nested deep comparison keeps cost independent of transcript size.
test('an identical-content full-array replacement refreshes object revisions', () => {
  const harness = createSettledRefreshHarness(settledTurn());
  harness.render();
  assert.equal(harness.fullRenders.count, 1);

  harness.setMessages(settledTurn());
  harness.render();

  assert.equal(harness.fullRenders.count, 2, 'replacement objects must advance the fixed-cost render revision');
});

// CTL-012 anti-freeze pin (I2, frozen): a STREAMING message growing content or
// reasoning via object replacement must reach the DOM on every frame — even
// when the structural cache HITS (post-CTL-012, growth frames are hits). The
// guard rides the real fingerprint pipeline: streaming messages are never
// fingerprint-memoized, so the render signature moves with every delta while
// the ref-refresh hands the fresh object to the full render. This is the
// regression the ORIGINAL growth-fields fix (now removed) was for; if this
// test ever reds, the live timeline freezes until the terminal status flip.
test('streaming growth frames reach the DOM without a structural rebuild (CTL-012 anti-freeze)', () => {
  const streamingTurn = (content, reasoningText) => [
    { id: 'u1', role: 'user', kind: '', status: 'complete', finalizedAt: 't1', content: 'the prompt' },
    {
      id: 'a1', role: 'assistant', kind: '', status: 'streaming', streamId: 's1',
      content,
      ...(reasoningText
        ? { reasoning: { source: 'provider', entries: [{ id: 'r1', text: reasoningText }] } }
        : {}),
    },
  ];
  const harness = createSettledRefreshHarness(streamingTurn('partial'));
  harness.render();
  assert.equal(harness.fullRenders.count, 1);
  assert.match(harness.timeline.innerHTML, /partial/);

  // Token frame: content grows via object replacement (updatePendingMessage).
  harness.setMessages(streamingTurn('partial plus more tokens'));
  harness.render();
  assert.equal(harness.fullRenders.count, 2, 'a content-growth frame must not hit the render no-op guard');
  assert.match(harness.timeline.innerHTML, /partial plus more tokens/, 'the grown content reaches the DOM');
  const renderedRef = harness.fullRenders.lastMessages.find((message) => message.id === 'a1');
  assert.equal(renderedRef.content, 'partial plus more tokens', 'the full render is handed the FRESH streaming object');

  // Reasoning-only frame (the pre-text thinking window): content unchanged,
  // reasoning grows.
  harness.setMessages(streamingTurn('partial plus more tokens', 'thinking about it'));
  harness.render();
  assert.equal(harness.fullRenders.count, 3, 'a reasoning-growth frame must not hit the render no-op guard');
  const reasoningRef = harness.fullRenders.lastMessages.find((message) => message.id === 'a1');
  assert.equal(reasoningRef.reasoning.entries[0].text, 'thinking about it', 'the reasoning delta reaches the render');

  // A no-growth streaming frame (identical values, new objects) stays a
  // an owner-declared revision; preserve that signal without a deep comparison.
  harness.setMessages(streamingTurn('partial plus more tokens', 'thinking about it'));
  harness.render();
  assert.equal(harness.fullRenders.count, 4, 'a replacement streaming object advances the render revision');
});

// Wave-7 audit pin (surviving-mutant closure): on a structural-signature HIT
// the renderer must refresh the CACHED thread tree's node.message refs to the
// current source objects, not just the canonical array — otherwise thread/
// branch view renders a settled content replacement from a frozen-in-time
// node ref. Node shape mirrors renderer-thread-tree-utils ({id, message}).
// The oracle is the tree handed to the full render AND the cache write-back.
test('signature-hit refresh updates cached thread-tree node refs to the fresh settled object', () => {
  const buildCalls = { count: 0 };
  const harness = createSettledRefreshHarness(settledTurn(), {
    buildThreadTree(messages) {
      buildCalls.count += 1;
      const nodeById = new Map();
      const roots = [];
      for (const message of messages) {
        const node = { id: message.id, message, children: [] };
        nodeById.set(node.id, node);
        roots.push(node);
      }
      return { nodeById, roots };
    },
  });
  harness.render();
  assert.equal(buildCalls.count, 1, 'initial render builds the tree once');
  assert.equal(
    harness.uiRuntime.cachedThreadTree.nodeById.get('a1').message.content,
    'original answer'
  );

  const replaced = settledTurn();
  replaced[1] = { ...replaced[1], content: 'a completely different settled answer' };
  harness.setMessages(replaced);
  harness.render();

  assert.equal(buildCalls.count, 1, 'a content-only replacement must NOT rebuild the tree (structural hit)');
  assert.equal(harness.fullRenders.count, 2, 'the content change still re-renders');
  assert.equal(
    harness.fullRenders.lastThreadTree.nodeById.get('a1').message.content,
    'a completely different settled answer',
    'the tree handed to the full render must carry the fresh object ref'
  );
  assert.equal(
    harness.uiRuntime.cachedThreadTree.nodeById.get('a1').message.content,
    'a completely different settled answer',
    'the cache write-back must hold the refreshed tree for the next render'
  );
});
