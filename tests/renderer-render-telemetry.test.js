// Track A (streaming-flicker investigation): debug-gated render-path
// telemetry. These tests pin the additive, byte-identical-when-off contract:
//   (a) morphChildren's optional `stats` accumulator counts reused/cloned/
//       removed child nodes correctly.
//   (b) setOuterHtmlPreservingCodeScroll returns { outcome, stats } — the
//       precise outcome, plus stats only when the caller opts in (collectStats).
//   (c) patchActiveTurnRoot emits one `active_turn_root_rebuild` rollout
//       signal per committed rebuild when chat_timeline_render_telemetry is
//       on, with the correct `reason`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  morphChildren,
  setOuterHtmlPreservingCodeScroll,
} = require('../renderer/chat/renderer-stream-dom-patch-utils');
const {
  createRenderPipelineMessageRenderer,
} = require('../renderer/chat/renderer-render-pipeline-message-renderer');
const { createStreamRevealController } = require('./helpers/renderer-stream-reveal-harness');

test('morphChildren stats: reused (keyed match), cloned (new key), removed (unconsumed child)', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="target"><span data-row-id="a"></span><span data-row-id="b"></span></div>
    <div id="source"><span data-row-id="a" class="updated"></span><span data-row-id="c"></span></div>
  </body>`);
  const doc = dom.window.document;
  const target = doc.getElementById('target');
  const source = doc.getElementById('source');
  const spanA = target.querySelector('[data-row-id="a"]');
  const spanB = target.querySelector('[data-row-id="b"]');

  const stats = { reused: 0, cloned: 0, removed: 0 };
  morphChildren(target, source, stats);

  assert.equal(stats.reused, 1, 'the keyed "a" match should count as reused');
  assert.equal(stats.cloned, 1, 'the new "c" key should count as cloned');
  assert.equal(stats.removed, 1, 'the unconsumed "b" child should count as removed');
  assert.strictEqual(target.querySelector('[data-row-id="a"]'), spanA, 'reused node keeps identity');
  assert.equal(spanA.className, 'updated', 'reused node picks up attribute sync');
  assert.equal(target.querySelector('[data-row-id="b"]'), null, 'removed node is gone');
  assert.equal(target.contains(spanB), false);
  assert.ok(target.querySelector('[data-row-id="c"]'), 'cloned node is present');
});

test('morphChildren without a stats argument is unaffected (byte-identical, no throw)', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="target"><span data-row-id="a"></span><span data-row-id="b"></span></div>
    <div id="source"><span data-row-id="a"></span><span data-row-id="c"></span></div>
  </body>`);
  const doc = dom.window.document;
  const target = doc.getElementById('target');
  const source = doc.getElementById('source');

  assert.doesNotThrow(() => morphChildren(target, source));
  assert.ok(target.querySelector('[data-row-id="a"]'));
  assert.ok(target.querySelector('[data-row-id="c"]'));
  assert.equal(target.querySelector('[data-row-id="b"]'), null);
});

test('setOuterHtmlPreservingCodeScroll returns morph_applied + stats on a keyed morph (collectStats)', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="root"><div data-thread-message-id="t1"><span>old</span></div></div>
  </body>`);
  const doc = dom.window.document;
  const el = doc.querySelector('[data-thread-message-id="t1"]');

  const { outcome, stats } = setOuterHtmlPreservingCodeScroll(
    el,
    '<div data-thread-message-id="t1"><span>new</span></div>',
    { collectStats: true }
  );

  assert.equal(outcome, 'morph_applied');
  assert.ok(stats);
  assert.equal(typeof stats.reused, 'number');
  assert.equal(typeof stats.cloned, 'number');
  assert.equal(typeof stats.removed, 'number');
  assert.match(String(doc.getElementById('root').textContent || ''), /new/);
});

test('setOuterHtmlPreservingCodeScroll returns root_key_mismatch on a genuine key mismatch', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="root"><div data-thread-message-id="t1">old</div></div>
  </body>`);
  const doc = dom.window.document;
  const el = doc.querySelector('[data-thread-message-id="t1"]');

  const { outcome, stats } = setOuterHtmlPreservingCodeScroll(
    el,
    '<div data-thread-message-id="t2">new</div>',
    { collectStats: true }
  );

  assert.equal(outcome, 'root_key_mismatch');
  assert.deepEqual(stats, { reused: 0, cloned: 0, removed: 0 });
  // Historical fallback path still ran (outerHTML replacement).
  assert.match(String(doc.getElementById('root').textContent || ''), /new/);
});

test('setOuterHtmlPreservingCodeScroll without options is unaffected (byte-identical, stats undefined)', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="root"><div data-thread-message-id="t1"><span>old</span></div></div>
  </body>`);
  const doc = dom.window.document;
  const el = doc.querySelector('[data-thread-message-id="t1"]');

  const result = setOuterHtmlPreservingCodeScroll(el, '<div data-thread-message-id="t1"><span>new</span></div>');
  assert.equal(result.stats, undefined, 'no collectStats => stats is undefined (no allocation/threading)');
  assert.match(String(doc.getElementById('root').textContent || ''), /new/);
});

// Shared harness for the patchActiveTurnRoot signal tests: a timeline seeded
// with one committed user turn root (u1), plus a stubbed rollout-signal sink.
// The only per-test variable is the telemetry flag value.
function buildPatchHarness(telemetryEnabled) {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u1"><article data-message-id="u1">u1-old</article></div>
        </div>
      </body>
    </html>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  const signalCalls = [];
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    escapeSelectorValue: (value) => String(value || ''),
    state: { features: { featureFlags: { chat_timeline_render_telemetry: telemetryEnabled } } },
    recordChatTimelineRolloutSignal: (sessionId, signal, details) => {
      signalCalls.push({ sessionId, signal, details });
      return { logged: true, count: signalCalls.length };
    },
  });
  return { dom, timeline, signalCalls, controller };
}

// Commit the turn root, then patch it with a changed tail fingerprint (hash and
// root id held constant) so the sole rebuild driver is the tail delta.
function commitThenPatchTail(controller) {
  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    activeTurnRootMessageId: 'u1',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:old',
  });
  return controller.patchActiveTurnRoot({
    currentSessionId: 'session-1',
    structureSignature: 11,
    activeTurnRootMessageId: 'u1',
    turnStructureHash: 100,
    turnTailFingerprint: 'tail:new',
    expectedRootOrder: ['u1'],
    buildTurnRootMarkup: () => '<div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u1"><article data-message-id="u1">u1-new</article></div>',
  });
}

test('patchActiveTurnRoot emits one active_turn_root_rebuild signal (reason: tail_fingerprint) when the flag is on', () => {
  const { signalCalls, controller } = buildPatchHarness(true);

  const patched = commitThenPatchTail(controller);

  assert.equal(patched, true);
  // A committed rebuild emits a PAIR: this lane's own active_turn_root_rebuild
  // plus the unified timeline_dom_write that every render lane reports. Kept as
  // an exact list rather than filtered to this lane's name, so a third
  // unexpected signal still trips here -- that exactness is what caught the
  // unified record being added in the first place.
  assert.deepEqual(
    signalCalls.map((entry) => entry.signal),
    ['active_turn_root_rebuild', 'timeline_dom_write'],
    'one lane-specific signal and one unified DOM-write record per committed rebuild'
  );
  const call = signalCalls[0];
  assert.equal(call.sessionId, 'session-1');
  assert.equal(call.signal, 'active_turn_root_rebuild');
  assert.equal(call.details.turnId, 'u1');
  assert.equal(call.details.reason, 'tail_fingerprint');
  assert.equal(call.details.priorHash, 100);
  assert.equal(call.details.nextHash, 100);
  assert.equal(call.details.priorTail, 'tail:old');
  assert.equal(call.details.nextTail, 'tail:new');
  assert.equal(call.details.outcome, 'morph_applied');
  assert.equal(typeof call.details.reused, 'number');
  assert.equal(typeof call.details.cloned, 'number');
  assert.equal(typeof call.details.removed, 'number');
  const domWrite = signalCalls[1];
  assert.equal(domWrite.sessionId, 'session-1');
  assert.equal(domWrite.details.lane, 'active_turn_root');
  assert.equal(domWrite.details.outcome, 'morph_applied');
});

test('patchActiveTurnRoot does not emit a signal when chat_timeline_render_telemetry is off', () => {
  const { timeline, signalCalls, controller } = buildPatchHarness(false);

  const patched = commitThenPatchTail(controller);

  assert.equal(patched, true);
  assert.equal(signalCalls.length, 0, 'flag-off must not emit any telemetry signal');
  assert.match(String(timeline.children[0].textContent || ''), /u1-new/);
});

function installDocumentForRenderer(t, documentRef) {
  const priorDocument = global.document;
  global.document = documentRef;
  t.after(() => {
    if (priorDocument === undefined) {
      delete global.document;
    } else {
      global.document = priorDocument;
    }
  });
}

function buildStreamingArticleHarness(t, options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="scroll"><div id="timeline">
      <article class="chat-entry message-shell assistant"
        data-message-id="assistant_stream"
        data-message-role="assistant"
        data-message-status="streaming">
        <div class="turn-row-list" data-turn-row-list="true">
          <div class="chat-row" data-row-id="turn_1:assistant_text:0">old text</div>
        </div>
      </article>
    </div></div>
  </body></html>`);
  const doc = dom.window.document;
  installDocumentForRenderer(t, doc);
  const chatTimeline = doc.getElementById('timeline');
  const chatThreadScroll = doc.getElementById('scroll');
  const featureFlags = {
    chat_timeline_streaming_article_morph: options.morphEnabled === true,
    chat_timeline_render_telemetry: options.telemetryEnabled === true,
  };
  const messages = [{
    id: 'assistant_stream',
    role: 'assistant',
    status: 'streaming',
    content: 'old text',
    streamId: 'stream-1',
  }];
  const projectionContext = {
    activeTurnRootMessageId: 'assistant_stream',
    activeTurnStructureHash: 1,
    activeTurnTailFingerprint: 'tail:stream-1',
  };
  const state = {
    currentSessionId: 'session-streaming-article',
    ui: { chatMode: 'thread', animateNextChatActivation: false },
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    features: { featureFlags },
  };
  const uiRuntime = {
    recapExpansionSignature: 'recap',
    threadBranchSignature: 'thread',
    // 20e065e7 projection-state revision: the streaming patch branches stand
    // down whenever the committed revision lags the context's. This harness
    // context carries no revision key (''), so seed the committed key to
    // match — the state any prior full render leaves behind.
    projectionCommittedRevisionKey: '',
  };
  const signalCalls = [];
  let renderSeq = 0;
  let structureSeq = 40;
  let nextArticleMarkup = '';
  function setArticleRows(rowMarkup) {
    nextArticleMarkup = `<article class="chat-entry message-shell assistant"
      data-message-id="assistant_stream"
      data-message-role="assistant"
      data-message-status="streaming">${rowMarkup}</article>`;
  }
  setArticleRows(`<div class="turn-row-list" data-turn-row-list="true">
    <div class="chat-row" data-row-id="turn_1:assistant_text:0">new text</div>
    <div class="chat-row" data-row-id="turn_1:tool_call:call_1">tool row</div>
  </div>`);

  const renderer = createRenderPipelineMessageRenderer({
    state,
    dom: { chatTimeline, chatThreadScroll },
    runtime: { uiRuntime },
    callbacks: {
      buildCanonicalTranscriptMessages: () => messages,
      buildMessageArticleMarkup: () => nextArticleMarkup,
      buildMessageRenderSignature: () => `message:${renderSeq += 1}`,
      buildProjectionContext: () => projectionContext,
      buildRecapExpansionSignature: () => 'recap',
      buildThreadExpansionSignature: () => 'thread',
      buildTimelineDividerInputSignature: () => '',
      buildTranscriptThreadTree: () => ({ roots: [], nodeById: new Map() }),
      canPatchStreamRevealMessage: () => false,
      collectThreadBranchIds: () => new Set(),
      commitStreamRevealFullRender: () => {},
      computeDerivedMessageState: () => ({
        latestAssistantMessageId: 'assistant_stream',
        latestReplyAssistantMessageId: 'assistant_stream',
        thinkingMessageIds: [],
        streamingMessage: messages[0],
        idToIndex: new Map([['assistant_stream', 0]]),
      }),
      computeStructureHash: () => structureSeq += 1,
      deriveTimelineTimeDividers: () => [],
      getCurrentVisibleMessages: () => messages,
      recordTurnArticleRolloutSignal: (signal, details) => {
        signalCalls.push({ signal, details });
        return { logged: true, count: signalCalls.length };
      },
      resolveRegenerateRequest: () => null,
      resolveTurnArticleMessageId: () => 'assistant_stream',
      resolveVisibleTurnArticleTarget: () => doc.querySelector('[data-message-id="assistant_stream"]'),
    },
  });

  return {
    article: () => doc.querySelector('[data-message-id="assistant_stream"]'),
    row: (rowId) => doc.querySelector(`[data-row-id="${rowId}"]`),
    renderer,
    setArticleRows,
    signalCalls,
  };
}

test('streaming article morph flag preserves keyed row nodes across structural rebuilds', (t) => {
  const harness = buildStreamingArticleHarness(t, { morphEnabled: true });
  const stableRow = harness.row('turn_1:assistant_text:0');

  harness.renderer.renderMessages();

  assert.strictEqual(
    harness.row('turn_1:assistant_text:0'),
    stableRow,
    'flag-on structural streaming rebuild should reuse the stable row element'
  );
  assert.equal(stableRow.textContent, 'new text');
  assert.ok(harness.row('turn_1:tool_call:call_1'));
});

test('streaming article morph flag off keeps the raw innerHTML replacement baseline', (t) => {
  const harness = buildStreamingArticleHarness(t, { morphEnabled: false });
  const stableRow = harness.row('turn_1:assistant_text:0');

  harness.renderer.renderMessages();

  assert.notStrictEqual(
    harness.row('turn_1:assistant_text:0'),
    stableRow,
    'flag-off structural streaming rebuild documents the historical raw-swap baseline'
  );
});

// The rollback path reconciles the article's ATTRIBUTES as well as its
// children, and nothing covered that until this test: the hand-rolled two-loop
// diff it used to carry could be deleted outright with every suite still green.
// It now delegates to the shared syncElementAttributes, so this asserts both
// halves of that contract -- write through what the next markup carries, remove
// what it does not.
test('streaming article morph flag off still reconciles the article attributes', (t) => {
  const harness = buildStreamingArticleHarness(t, { morphEnabled: false });
  const article = harness.article();
  article.setAttribute('data-stale-rollout', 'yes');
  article.setAttribute('data-message-status', 'stale');

  harness.renderer.renderMessages();

  const rebuilt = harness.article();
  assert.strictEqual(rebuilt, article, 'the rollback path keeps the article node identity');
  assert.equal(
    rebuilt.getAttribute('data-stale-rollout'),
    null,
    'an attribute the next markup does not carry must be removed'
  );
  assert.equal(
    rebuilt.getAttribute('data-message-status'),
    'streaming',
    'an attribute the next markup carries must be written through'
  );
});

test('streaming article rebuild telemetry emits once per structural rebuild when enabled', (t) => {
  const harness = buildStreamingArticleHarness(t, {
    morphEnabled: true,
    telemetryEnabled: true,
  });

  harness.renderer.renderMessages();
  harness.setArticleRows(`<div class="turn-row-list" data-turn-row-list="true">
    <div class="chat-row" data-row-id="turn_1:assistant_text:0">third text</div>
    <div class="chat-row" data-row-id="turn_1:tool_call:call_1">tool row</div>
    <div class="chat-row" data-row-id="turn_1:tool_result:call_1">result row</div>
  </div>`);
  harness.renderer.renderMessages();

  // Each rebuild emits a PAIR -- this lane's own signal plus the unified
  // timeline_dom_write. Kept exact rather than filtered so an unexpected third
  // signal still trips here.
  assert.deepEqual(
    harness.signalCalls.map((call) => call.signal),
    [
      'streaming_article_rebuild',
      'timeline_dom_write',
      'streaming_article_rebuild',
      'timeline_dom_write',
    ]
  );
  assert.deepEqual(
    harness.signalCalls
      .filter((call) => call.signal === 'streaming_article_rebuild')
      .map((call) => call.details.rebuildSeq),
    [1, 2]
  );
  assert.deepEqual(
    harness.signalCalls
      .filter((call) => call.signal === 'timeline_dom_write')
      .map((call) => call.details.lane),
    ['streaming_article', 'streaming_article']
  );
  assert.equal(harness.signalCalls[0].details.turnId, 'assistant_stream');
  assert.equal(harness.signalCalls[0].details.streamingMessageId, 'assistant_stream');
  assert.equal(harness.signalCalls[0].details.outcome, 'morph_applied');
});

test('streaming article rebuild telemetry is silent when the telemetry flag is off', (t) => {
  const harness = buildStreamingArticleHarness(t, {
    morphEnabled: true,
    telemetryEnabled: false,
  });

  harness.renderer.renderMessages();

  assert.equal(harness.signalCalls.length, 0);
});
