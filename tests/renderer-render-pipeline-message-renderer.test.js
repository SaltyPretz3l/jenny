const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createRenderPipelineMessageRenderer,
} = require('../renderer/chat/renderer-render-pipeline-message-renderer');

function createRendererHarness() {
  const dom = new JSDOM(`
    <main>
      <section id="scroll">
        <div id="timeline"><article data-message-id="stale"></article></div>
      </section>
    </main>
  `);
  const calls = [];
  const state = {
    currentSessionId: 'session-renderer',
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    ui: {
      animateNextChatActivation: false,
      chatMode: 'thread',
    },
  };
  const uiRuntime = {
    messageRenderSignature: 'old-signature',
    recapExpansionSignature: 'old-recap',
    threadBranchSignature: 'old-thread',
  };
  const renderer = createRenderPipelineMessageRenderer({
    state,
    dom: {
      chatTimeline: dom.window.document.getElementById('timeline'),
      chatThreadScroll: dom.window.document.getElementById('scroll'),
    },
    controllers: {
      reducedMotionQuery: { matches: false },
      thinkingController: {
        prune(ids) { calls.push(['prune', ids]); },
        resumeAutoScroll() { calls.push(['resumeAutoScroll']); },
      },
    },
    runtime: { uiRuntime },
    callbacks: {
      pruneToolRowProjectionSessionCaches(sessionId) { calls.push(['pruneToolRows', sessionId]); },
      getCurrentVisibleMessages() { return []; },
      buildCanonicalTranscriptMessages(messages) { return messages; },
      pruneRecapExpansionState(sessionId, messages) { calls.push(['pruneRecap', sessionId, messages.length]); },
      updateTokenDisplay() { calls.push(['updateTokenDisplay']); },
      computeDerivedMessageState() {
        return {
          latestAssistantMessageId: '',
          latestReplyAssistantMessageId: '',
          thinkingMessageIds: [],
          streamingMessage: null,
          idToIndex: new Map(),
        };
      },
      buildTranscriptThreadTree() { return { nodeById: new Map(), roots: [] }; },
      buildProjectionContext() { return {}; },
      pruneThreadBranchState(sessionId) { calls.push(['pruneBranches', sessionId]); },
      collectThreadBranchIds() { return new Set(); },
      getForcedOpenStreamingMessageId() { return ''; },
      isSendBusy() { return false; },
      isSendPreflightPending() { return false; },
      syncChatState(hasMessages) { calls.push(['syncChatState', hasMessages]); },
      resetStreamRevealState() { calls.push(['resetStreamRevealState']); },
      noteScrollProgrammaticWrite(reason) {
        calls.push(['noteScrollProgrammaticWrite', reason, dom.window.document.getElementById('scroll').scrollTop]);
      },
      setFollowLatest(value) { calls.push(['setFollowLatest', value]); },
      hideAssistantSprite(options) { calls.push(['hideAssistantSprite', options.clearTarget]); },
      syncTimelineBusyState() { calls.push(['syncTimelineBusyState']); },
      syncPostRenderChrome() { calls.push(['syncPostRenderChrome']); },
      buildMessageRenderSignature() { return 'empty-signature'; },
      computeStructureHash() { return 0; },
      buildTimelineDividerInputSignature() { return 'divider-signature'; },
      buildRecapExpansionSignature() { return 'empty-recap'; },
      buildThreadExpansionSignature() { return 'empty-thread'; },
    },
  });
  return { calls, dom, renderer, uiRuntime };
}

test('render pipeline message renderer clears stale DOM for empty transcripts', () => {
  const { calls, dom, renderer, uiRuntime } = createRendererHarness();
  const timeline = dom.window.document.getElementById('timeline');
  const scroll = dom.window.document.getElementById('scroll');
  scroll.scrollTop = 42;

  renderer.renderMessages({ forceFullRender: true });

  assert.equal(timeline.innerHTML, '');
  assert.equal(scroll.scrollTop, 0);
  assert.equal(uiRuntime.messageRenderSignature, '');
  assert.equal(uiRuntime.recapExpansionSignature, '');
  assert.equal(uiRuntime.threadBranchSignature, '');
  assert.deepEqual(calls, [
    ['pruneToolRows', 'session-renderer'],
    ['pruneRecap', 'session-renderer', 0],
    ['updateTokenDisplay'],
    ['pruneBranches', 'session-renderer'],
    ['syncChatState', false],
    ['prune', []],
    ['resetStreamRevealState'],
    ['noteScrollProgrammaticWrite', 'empty_transcript_reset', 42],
    ['resumeAutoScroll'],
    ['setFollowLatest', true],
    ['hideAssistantSprite', true],
    ['syncTimelineBusyState'],
    ['syncPostRenderChrome'],
  ]);
});

test('render pipeline skips the programmatic-write note when the viewport is already at top', () => {
  const { calls, dom, renderer } = createRendererHarness();
  const scroll = dom.window.document.getElementById('scroll');
  scroll.scrollTop = 0;

  renderer.renderMessages({ forceFullRender: true });

  // A no-op reset must not arm the marker: a live 'empty_transcript_reset'
  // reason would excuse the next genuine unattributed jump inside the TTL.
  assert.equal(calls.some(([name]) => name === 'noteScrollProgrammaticWrite'), false);
  assert.equal(scroll.scrollTop, 0);
});

test('render pipeline forwards the stream-target id to the full-render markup builder', () => {
  const dom = new JSDOM(`
    <main>
      <section id="scroll"><div id="timeline"></div></section>
    </main>
  `);
  let forwardedAssistantMessageId = '';
  const renderer = createRenderPipelineMessageRenderer({
    state: {
      currentSessionId: 'session-stream-target',
      auth: { authenticated: true },
      backend: { phase: 'ready' },
      ui: { animateNextChatActivation: false, chatMode: 'thread' },
    },
    dom: {
      chatTimeline: dom.window.document.getElementById('timeline'),
      chatThreadScroll: dom.window.document.getElementById('scroll'),
    },
    callbacks: {
      getCurrentVisibleMessages() {
        return [{ id: 'assistant_seg1', role: 'assistant', status: 'streaming' }];
      },
      computeDerivedMessageState() {
        return {
          latestAssistantMessageId: 'tool_use_c2',
          streamTargetAssistantMessageId: 'assistant_seg1',
          latestReplyAssistantMessageId: '',
          thinkingMessageIds: [],
          streamingMessage: { id: 'assistant_seg1', role: 'assistant', status: 'streaming' },
          idToIndex: new Map(),
        };
      },
      performFullMessageRender(_messages, _threadTree, latestAssistantMessageId) {
        forwardedAssistantMessageId = latestAssistantMessageId;
      },
    },
  });

  renderer.renderMessages({ forceFullRender: true });

  assert.equal(forwardedAssistantMessageId, 'assistant_seg1');
});

// #15: the canonical-transcript + thread-tree builds are reused across renders
// whose source STRUCTURE is unchanged (text-streaming / chrome / toggle frames),
// and rebuilt when the structure changes.
function createCacheCountingHarness(initialMessages, options = {}) {
  const dom = new JSDOM(`
    <main>
      <section id="scroll"><div id="timeline"></div></section>
    </main>
  `);
  let sourceMessages = initialMessages;
  const counts = { canonical: 0, threadTree: 0 };
  const state = {
    currentSessionId: 'session-cache',
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    ui: { animateNextChatActivation: false, chatMode: 'thread' },
  };
  const uiRuntime = {};
  const renderer = createRenderPipelineMessageRenderer({
    state,
    dom: {
      chatTimeline: dom.window.document.getElementById('timeline'),
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
      buildCanonicalTranscriptMessages(messages) { counts.canonical += 1; return messages.slice(); },
      pruneRecapExpansionState() {},
      updateTokenDisplay() {},
      computeDerivedMessageState() {
        return { latestAssistantMessageId: '', latestReplyAssistantMessageId: '', thinkingMessageIds: [], streamingMessage: null, idToIndex: new Map() };
      },
      buildTranscriptThreadTree() { counts.threadTree += 1; return { nodeById: new Map(), roots: [] }; },
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
      performFullMessageRender(...args) {
        if (typeof options.onFullRender === 'function') {
          options.onFullRender({ args, uiRuntime });
        }
      },
      buildMessageArticleMarkup() { return '<article class="chat-entry" data-message-id="m1"></article>'; },
      buildMessageInnerMarkup() { return { innerHtml: '', pending: false, entryReveal: false, status: '', finalizedAt: '' }; },
      buildMessageArticleInnerHtml() { return ''; },
      deriveTimelineTimeDividers() { return []; },
      buildTimeDividerMap() { return new Map(); },
      buildMessageRenderSignature() { return 'sig-' + sourceMessages.map((m) => `${m.id}:${String(m.content || '').length}`).join(','); },
      computeStructureHash() { return 0; },
      buildTimelineDividerInputSignature() { return 'divider'; },
      buildRecapExpansionSignature() { return 'recap'; },
      buildThreadExpansionSignature() { return 'thread'; },
    },
  });
  return {
    counts,
    uiRuntime,
    renderOnce(renderOptions) { renderer.renderMessages(renderOptions); },
    setMessages(next) { sourceMessages = next; },
  };
}

test('forceFullRender drops settled-root markup memo before rebuilding', () => {
  const cacheSizesAtFullRender = [];
  const harness = createCacheCountingHarness([
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', content: 'settled reply' },
  ], {
    onFullRender({ uiRuntime }) {
      cacheSizesAtFullRender.push(uiRuntime.threadRootMarkupCache?.size ?? 0);
    },
  });

  harness.uiRuntime.threadRootMarkupCache = new Map([
    ['a1', { key: 'stale-collapsed-key', html: '<article data-expanded="false"></article>' }],
  ]);
  harness.renderOnce();
  assert.deepEqual(cacheSizesAtFullRender, [1], 'ordinary renders preserve the settled-root memo');

  harness.uiRuntime.threadRootMarkupCache.set(
    'a1',
    { key: 'stale-collapsed-key', html: '<article data-expanded="false"></article>' }
  );
  harness.renderOnce({ forceFullRender: true });
  assert.deepEqual(cacheSizesAtFullRender, [1, 0], 'forced renders rebuild after dropping stale markup');
});

test('#15 cache: unchanged settled structure reuses the canonical + thread-tree builds', () => {
  const harness = createCacheCountingHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi' },
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', streamId: 's1', content: 'settled reply' },
  ]);

  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1, 'first render builds the canonical transcript');
  assert.equal(harness.counts.threadTree, 1, 'first render builds the thread tree');

  // A chrome/toggle frame over a fully settled transcript: nothing changed.
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1, 'a settled structure-stable frame reuses the canonical build');
  assert.equal(harness.counts.threadTree, 1, 'a settled structure-stable frame reuses the thread tree');
});

test('#15 cache: streaming content/reasoning growth frames reuse the canonical + thread-tree builds (CTL-012)', () => {
  // CTL-012: pure content/reasoning growth was once folded into the
  // structural signature (the original anti-freeze fix), which made EVERY
  // token frame rebuild the whole-transcript canonical array + thread tree.
  // The cache-hit path now refreshes stale object-replacement refs in place
  // (CTL-004's refreshCanonicalMessageRefs/refreshCanonicalThreadTreeRefs),
  // and the render decision is driven by the per-render fingerprints — which
  // never memoize the streaming message — so growth frames must be cache
  // HITS. The user-visible anti-freeze contract (grown content still reaches
  // the DOM on a hit frame) is pinned with the real fingerprint pipeline in
  // tests/renderer-render-pipeline-settled-refresh.test.js.
  const harness = createCacheCountingHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi' },
    { id: 'a1', role: 'assistant', kind: '', status: 'streaming', streamId: 's1', content: 'streaming reply' },
  ]);

  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1, 'first render builds the canonical transcript');
  assert.equal(harness.counts.threadTree, 1, 'first render builds the thread tree');

  // Text-streaming frame: content grows via object replacement.
  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi' },
    { id: 'a1', role: 'assistant', kind: '', status: 'streaming', streamId: 's1', content: 'streaming reply grew longer' },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1, 'a streaming content-growth frame reuses the canonical build');
  assert.equal(harness.counts.threadTree, 1, 'a streaming content-growth frame reuses the thread tree');

  // Reasoning growth without content change (the pre-text thinking window is
  // reasoning-delta-only) is also structure-stable — still a hit.
  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi' },
    {
      id: 'a1', role: 'assistant', kind: '', status: 'streaming', streamId: 's1',
      content: 'streaming reply grew longer',
      reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'thinking about it' }] },
    },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1, 'a streaming reasoning-growth frame reuses the canonical build');

  // The terminal status flip IS structural (status feeds the signature) —
  // the settled transcript rebuilds once.
  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi' },
    {
      id: 'a1', role: 'assistant', kind: '', status: 'complete', streamId: 's1',
      content: 'streaming reply grew longer',
      reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'thinking about it' }] },
    },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 2, 'the terminal status flip rebuilds the canonical transcript');
  assert.equal(harness.counts.threadTree, 2, 'the terminal status flip rebuilds the thread tree');
});

test('#15 cache: a structural change rebuilds the canonical + thread-tree', () => {
  const harness = createCacheCountingHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi' },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1);

  // Add a message (structural change) -> the cache must miss and rebuild.
  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi' },
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', streamId: 's1', content: 'reply' },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 2, 'a structural change rebuilds the canonical transcript');
  assert.equal(harness.counts.threadTree, 2, 'a structural change rebuilds the thread tree');
});

test('#15 cache: a tool_call.status transition (running -> pending_approval) busts the cache', () => {
  // Regression for the live tool-approval prompt never rendering. handleApprovalNeeded
  // REPLACES a tool_use message object to flip tool_call.status 'running' ->
  // 'pending_approval'; the turn projector keys the approval_gap row (approve/deny
  // buttons) on that status. The transition therefore MUST be a structural cache
  // miss -- if buildSourceStructureSignature ignores tool_call.status, the cache
  // reuses the stale 'running' canonical ref and the approval_gap is never projected.
  const harness = createCacheCountingHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'run a tool' },
    {
      id: 't1', role: 'assistant', kind: 'tool_use', status: 'complete', streamId: 's1',
      tool_call: { call_id: 'c1', tool_name: 'shell', status: 'running' },
    },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1);

  // Object replacement that changes ONLY tool_call.status (content/kind/status stable).
  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'run a tool' },
    {
      id: 't1', role: 'assistant', kind: 'tool_use', status: 'complete', streamId: 's1',
      tool_call: { call_id: 'c1', tool_name: 'shell', status: 'pending_approval' },
    },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 2, 'a tool_call.status change must rebuild the canonical transcript so approval_gap can project');
  assert.equal(harness.counts.threadTree, 2, 'a tool_call.status change must rebuild the thread tree');
});

test('#15 cache: a tool_result.status transition busts the cache', () => {
  const harness = createCacheCountingHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'run a tool' },
    {
      id: 'r1', role: 'tool', kind: 'tool_result', status: 'complete', streamId: 's1',
      tool_result: { call_id: 'c1', tool_name: 'shell', status: 'running' },
    },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1);

  harness.setMessages([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'run a tool' },
    {
      id: 'r1', role: 'tool', kind: 'tool_result', status: 'complete', streamId: 's1',
      tool_result: { call_id: 'c1', tool_name: 'shell', status: 'complete' },
    },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 2, 'a tool_result.status change must rebuild the canonical transcript');
});

// Audit M2: a settled user message gains/loses send_failure via OBJECT
// REPLACEMENT (annotateUserSendFailureInStore / onDismiss). The timeline
// user-bubble "Failed to send" chip (article-markup) keys on
// send_failure.state === 'failed' && dismissed !== true, and send_failure is
// otherwise absent from the structure signature — so the transition MUST be a
// structural cache miss, or the chip never appears (annotate) / never clears
// (dismiss).
test('#15 cache: a send_failure annotation + dismissal (object replacement) busts the cache', () => {
  const harness = createCacheCountingHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi' },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 1);

  // Annotate failure (object replacement adds send_failure).
  harness.setMessages([
    {
      id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi',
      send_failure: { state: 'failed', dismissed: false, error_code: 'CMP-CHAT-0002' },
    },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 2, 'adding send_failure must rebuild the canonical transcript so the failed chip renders');

  // Dismiss (object replacement flips dismissed true).
  harness.setMessages([
    {
      id: 'u1', role: 'user', kind: '', status: 'complete', content: 'hi',
      send_failure: { state: 'failed', dismissed: true, error_code: 'CMP-CHAT-0002' },
    },
  ]);
  harness.renderOnce();
  assert.equal(harness.counts.canonical, 3, 'dismissing send_failure must rebuild the canonical transcript so the chip clears');
});

// ── stale-chip regression (2026-07-31) ──
// The canonical-rebuild signature above is only HALF the contract: send_failure
// also has to reach buildSettledFingerprintState, which mints the projection
// CONTENT token. annotateUserSendFailureInStore / onDismiss replace the user
// message adding or flipping only send_failure.{state,dismissed} and never bump
// updatedAt, so with send_failure absent from that field list the replacement
// produced an element-wise-equal state, the id-keyed reuse in
// resolveMessageFingerprint handed back the pre-failure token, and every cache
// keyed on it kept the stale row — the per-turn turnRowCache (built to survive
// whole-projection misses), and row.projection_fingerprint, which
// computeTurnTailFingerprint folds. patchActiveTurnRoot no-ops when the root id,
// the structure hash AND the tail fingerprint all match; the structure hash
// cannot see this transition at all (a user_bubble row carries no send_failure
// in its payload — the chip is built from the live message), so the tail
// fingerprint is the only gate that can move. With it stuck, patchActiveTurnRoot
// returns `true` for a rebuild it never did, the render returns without falling
// through to a full build, and the "Failed to send" chip is never painted.
// Same defect class as the image_operation terminal settle.

const {
  buildMessageProjectionFingerprint,
  computeTurnTailFingerprint,
} = require('../renderer/chat/renderer-message-index-utils');

function sendFailureUserMessage(id, failure) {
  return {
    id,
    role: 'user',
    kind: '',
    status: 'complete',
    content: 'a prompt that failed to send',
    timestamp: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:00.000Z',
    attachments: [],
    ...(failure ? { send_failure: failure } : {}),
  };
}

test('annotating and dismissing send_failure mints a fresh projection fingerprint', () => {
  const id = 'user_send_failure_fingerprint_probe';
  const clean = buildMessageProjectionFingerprint(sendFailureUserMessage(id, null));
  const failed = buildMessageProjectionFingerprint(
    sendFailureUserMessage(id, { state: 'failed', error_code: 'CMP-CHAT-0002', restored_to_composer: true })
  );
  const dismissed = buildMessageProjectionFingerprint(
    sendFailureUserMessage(id, {
      state: 'failed', error_code: 'CMP-CHAT-0002', restored_to_composer: true, dismissed: true,
    })
  );
  assert.notEqual(failed, clean, 'adding send_failure must invalidate the projection');
  assert.notEqual(dismissed, failed, 'dismissing send_failure must invalidate the projection');
});

test('the active-turn tail fingerprint sees a send_failure annotation', () => {
  const id = 'user_send_failure_tail_probe';
  const turn = { turn_id: 't1', primary_user_message_id: id, source_message_ids: [id] };
  // Mirrors buildProjectedRowContentFingerprint: a user_bubble row's
  // projection_fingerprint IS the source message's content token, and the row
  // id / payload carry no send_failure of their own, so this is the only field
  // through which patchActiveTurnRoot's second gate can see the flip.
  const rowsFor = (failure) => ([{
    kind: 'user_bubble',
    row_id: `t1:user_bubble:${id}`,
    primary_message_id: id,
    payload: { content: 'a prompt that failed to send', attachments: [] },
    projection_fingerprint: buildMessageProjectionFingerprint(sendFailureUserMessage(id, failure)),
  }]);
  const clean = computeTurnTailFingerprint(turn, rowsFor(null));
  const failed = computeTurnTailFingerprint(turn, rowsFor({ state: 'failed' }));
  const dismissed = computeTurnTailFingerprint(turn, rowsFor({ state: 'failed', dismissed: true }));
  assert.notEqual(failed, clean, 'patchActiveTurnRoot no-ops unless the tail fingerprint moves');
  assert.notEqual(dismissed, failed, 'the dismiss must move it too, or the chip never clears');
});

// Audit M1: entering inline edit / selection mode sets AMBIENT state.ui fields
// (editingMessageId / selectionMode / selected-id set) that are consumed by
// article rendering but were absent from the content-only render signature. On a
// settled timeline the whole-transcript no-op guard therefore held and the full
// render — the only path that swaps in the edit textarea / selection handles —
// was skipped. This harness counts performFullMessageRender to assert the guard
// now busts on ambient-state changes (and still no-ops when idle).
function createFullRenderCountingHarness(initialMessages) {
  const dom = new JSDOM(`
    <main>
      <section id="scroll"><div id="timeline"></div></section>
    </main>
  `);
  let sourceMessages = initialMessages;
  const counts = { fullRender: 0 };
  const state = {
    currentSessionId: 'session-ambient',
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    ui: {
      animateNextChatActivation: false,
      chatMode: 'thread',
      editingMessageId: '',
      selectionMode: false,
      selectedMessageIdsBySession: new Map(),
    },
  };
  const uiRuntime = {};
  const renderer = createRenderPipelineMessageRenderer({
    state,
    dom: {
      chatTimeline: dom.window.document.getElementById('timeline'),
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
      buildCanonicalTranscriptMessages(messages) { return messages.slice(); },
      pruneRecapExpansionState() {},
      updateTokenDisplay() {},
      computeDerivedMessageState() {
        return { latestAssistantMessageId: '', latestReplyAssistantMessageId: '', thinkingMessageIds: [], streamingMessage: null, idToIndex: new Map() };
      },
      buildTranscriptThreadTree() { return { nodeById: new Map(), roots: [] }; },
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
      performFullMessageRender() { counts.fullRender += 1; },
      buildMessageArticleMarkup() { return ''; },
      buildMessageInnerMarkup() { return { innerHtml: '', pending: false, entryReveal: false, status: '', finalizedAt: '' }; },
      buildMessageArticleInnerHtml() { return ''; },
      deriveTimelineTimeDividers() { return []; },
      buildTimeDividerMap() { return new Map(); },
      buildMessageRenderSignature() { return 'sig-' + sourceMessages.map((m) => `${m.id}:${String(m.content || '').length}`).join(','); },
      computeStructureHash() { return 0; },
      buildTimelineDividerInputSignature() { return 'divider'; },
      buildRecapExpansionSignature() { return 'recap'; },
      buildThreadExpansionSignature() { return 'thread'; },
    },
  });
  return { counts, state, renderer };
}

test('M1: entering/exiting edit mode busts the no-op guard on a settled timeline', () => {
  const { counts, state, renderer } = createFullRenderCountingHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'first prompt' },
    { id: 'a1', role: 'assistant', kind: '', status: 'complete', streamId: 's1', content: 'reply' },
  ]);

  renderer.renderMessages();
  assert.equal(counts.fullRender, 1, 'first render performs a full render');
  renderer.renderMessages();
  assert.equal(counts.fullRender, 1, 'a settled structure-stable frame no-ops (guard holds)');

  // Enter edit — ambient UI state only, message content unchanged.
  state.ui.editingMessageId = 'u1';
  renderer.renderMessages();
  assert.equal(counts.fullRender, 2, 'entering edit must bust the no-op guard so the editor mounts');

  // Idle re-render while editing stays a no-op.
  renderer.renderMessages();
  assert.equal(counts.fullRender, 2, 'a stable editing frame still no-ops');

  // Exit edit — must full-render to remove the editor.
  state.ui.editingMessageId = '';
  renderer.renderMessages();
  assert.equal(counts.fullRender, 3, 'exiting edit must full-render to remove the editor');
});

test('M1: selection mode + membership changes bust the no-op guard', () => {
  const { counts, state, renderer } = createFullRenderCountingHarness([
    { id: 'u1', role: 'user', kind: '', status: 'complete', content: 'first prompt' },
    { id: 'u2', role: 'user', kind: '', status: 'complete', content: 'second prompt' },
  ]);

  renderer.renderMessages();
  assert.equal(counts.fullRender, 1);
  renderer.renderMessages();
  assert.equal(counts.fullRender, 1);

  // Enter selection mode.
  state.ui.selectionMode = true;
  renderer.renderMessages();
  assert.equal(counts.fullRender, 2, 'entering selection mode must full-render to mount handles');

  // Select u1.
  const set = new Set(['u1']);
  state.ui.selectedMessageIdsBySession.set('session-ambient', set);
  renderer.renderMessages();
  assert.equal(counts.fullRender, 3, 'selecting a message must full-render to show its selected chrome');

  // Swap the selected id (same set size, different membership).
  set.clear();
  set.add('u2');
  renderer.renderMessages();
  assert.equal(counts.fullRender, 4, 'swapping the selected id (same size) must still full-render');
});

test('a streaming-article rebuild replays the reasoning hand-off before re-stamping the marker', () => {
  const dom = new JSDOM(`
    <main>
      <section id="scroll"><div id="timeline"><article class="chat-entry assistant" data-message-id="assistant_seg1"><p>old</p></article></div></section>
    </main>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  const calls = [];
  const streamingMessage = { id: 'assistant_seg1', role: 'assistant', status: 'streaming', content: 'hi' };
  let visibleMessages = [streamingMessage];
  const uiRuntime = {};
  const renderer = createRenderPipelineMessageRenderer({
    state: {
      currentSessionId: 'session-handoff',
      auth: { authenticated: true },
      backend: { phase: 'ready' },
      ui: { animateNextChatActivation: false, chatMode: 'thread' },
      features: { featureFlags: {} },
    },
    dom: {
      chatTimeline: timeline,
      chatThreadScroll: dom.window.document.getElementById('scroll'),
    },
    runtime: { uiRuntime },
    callbacks: {
      getCurrentVisibleMessages() { return visibleMessages; },
      buildCanonicalTranscriptMessages(messages) { return messages; },
      computeDerivedMessageState() {
        return {
          latestAssistantMessageId: 'assistant_seg1',
          latestReplyAssistantMessageId: '',
          thinkingMessageIds: [],
          streamingMessage,
          idToIndex: new Map(visibleMessages.map((message, index) => [message.id, index])),
        };
      },
      // Content-derived signature so the second render is not a no-op.
      computeMessageFingerprintList(messages) { return messages.map((message) => `${message.id}:${message.content}`); },
      renderSignatureFromFingerprints(list) { return list.join('|'); },
      resolveVisibleTurnArticleTarget(messageId) {
        return timeline.querySelector(`[data-message-id="${messageId}"]`);
      },
      buildMessageArticleMarkup() {
        return '<article class="chat-entry assistant" data-message-id="assistant_seg1"><p>new</p></article>';
      },
      commitStreamRevealFullRender() { calls.push('commit'); },
      replayStreamRevealHandoff() { calls.push('replay'); },
      stampStreamingArticleMarkerNode() { calls.push('stamp'); return null; },
      performFullMessageRender() { calls.push('full'); },
    },
  });

  // First render commits the signatures (full render); a structure change the
  // patch path refuses (canPatch defaults to false) then routes through the
  // streaming-article rebuild.
  renderer.renderMessages({ forceFullRender: true });
  calls.length = 0;
  visibleMessages = [{ id: 'user_1', role: 'user', status: 'complete', content: 'q' }, streamingMessage];
  renderer.renderMessages({});

  assert.equal(timeline.querySelector('article p')?.textContent, 'new', 'the streaming article was rebuilt in place');
  assert.deepEqual(calls, ['commit', 'replay', 'stamp']);
});
