// Wave 1 wiring proof. The keyed row-list morph in queuePatch is only as good
// as the markup the render pipeline hands it: if buildTurnRowListMarkup is not
// supplied, or returns '', the fix is silently inert in the field while the
// telemetry still looks like the pre-fix bug. These tests pin the seam itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createRenderPipelineMessageRenderer,
} = require('../renderer/chat/renderer-render-pipeline-message-renderer');

const ARTICLE_MARKUP = `<article class="chat-entry message-shell assistant"
  data-message-id="assistant_stream"
  data-message-role="assistant"
  data-message-status="streaming">
  <div class="turn-row-list" data-turn-row-list="true" data-turn-phase="running">
    <div class="chat-row" data-row-id="turn_1:reasoning:p0" data-row-kind="reasoning">thought</div>
    <div class="chat-row" data-row-id="turn_1:tool_call:call_1" data-row-kind="tool_call">web_search</div>
    <div class="chat-row" data-row-id="turn_1:assistant_text:1" data-row-kind="assistant_text">grown text</div>
  </div>
  <div class="chat-hover-row" data-hover-row="true"></div>
</article>`;

function buildWiringHarness(t, {
  articleMarkup = ARTICLE_MARKUP,
  timelineArticleMessageId = 'assistant_stream',
  extraMessages = [],
  callbackOverrides = {},
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="scroll"><div id="timeline">
      <article class="chat-entry message-shell assistant"
        data-message-id="${timelineArticleMessageId}"
        data-message-role="assistant"
        data-message-status="streaming">
        <div class="turn-row-list" data-turn-row-list="true" data-turn-phase="running">
          <div class="chat-row" data-row-id="turn_1:assistant_text:1" data-row-kind="assistant_text">old text</div>
        </div>
      </article>
    </div></div>
  </body></html>`);
  const doc = dom.window.document;
  const priorDocument = global.document;
  global.document = doc;
  t.after(() => {
    if (priorDocument === undefined) {
      delete global.document;
    } else {
      global.document = priorDocument;
    }
  });

  const messages = [{
    id: 'assistant_stream',
    role: 'assistant',
    status: 'streaming',
    content: 'grown text',
    streamId: 'stream-1',
  }];
  const capturedPatchOptions = [];
  let structureSeq = 40;
  let renderSeq = 0;

  const renderer = createRenderPipelineMessageRenderer({
    state: {
      currentSessionId: 'session-row-list-morph',
      ui: { chatMode: 'thread', animateNextChatActivation: false },
      auth: { authenticated: true },
      backend: { phase: 'ready' },
      features: { featureFlags: { chat_timeline_render_telemetry: true } },
    },
    dom: {
      chatTimeline: doc.getElementById('timeline'),
      chatThreadScroll: doc.getElementById('scroll'),
    },
    runtime: {
      uiRuntime: {
        recapExpansionSignature: 'recap',
        threadBranchSignature: 'thread',
        projectionCommittedRevisionKey: '',
      },
    },
    callbacks: {
      buildCanonicalTranscriptMessages: () => messages.concat(extraMessages),
      buildMessageArticleMarkup: () => articleMarkup,
      buildMessageRenderSignature: () => `message:${renderSeq += 1}`,
      buildProjectionContext: () => ({
        activeTurnRootMessageId: 'assistant_stream',
        activeTurnStructureHash: 1,
        activeTurnTailFingerprint: 'tail:stream-1',
      }),
      buildRecapExpansionSignature: () => 'recap',
      buildThreadExpansionSignature: () => 'thread',
      buildTimelineDividerInputSignature: () => '',
      buildTranscriptThreadTree: () => ({ roots: [], nodeById: new Map() }),
      // Drive the render down the surgical-patch branch, which is where the
      // row-list morph fallback is wired.
      canPatchStreamRevealMessage: () => true,
      queueStreamRevealPatch: (patchOptions) => { capturedPatchOptions.push(patchOptions); },
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
      getCurrentVisibleMessages: () => messages.concat(extraMessages),
      recordTurnArticleRolloutSignal: () => ({ logged: true, count: 1 }),
      resolveRegenerateRequest: () => null,
      resolveTurnArticleMessageId: () => 'assistant_stream',
      resolveVisibleTurnArticleTarget: () => doc.querySelector(`[data-message-id="${timelineArticleMessageId}"]`),
      ...callbackOverrides,
    },
  });

  renderer.renderMessages();
  return { capturedPatchOptions, doc };
}

test('the streaming patch path is handed a row-list markup builder', (t) => {
  const { capturedPatchOptions } = buildWiringHarness(t);

  assert.equal(capturedPatchOptions.length, 1, 'the render must reach queueStreamRevealPatch');
  assert.equal(
    typeof capturedPatchOptions[0].buildTurnRowListMarkup,
    'function',
    'without this option the keyed morph is inert and every structural delta still full-renders'
  );
});

test('the builder yields the same rows a full render would write', (t) => {
  const { capturedPatchOptions } = buildWiringHarness(t);
  const markup = capturedPatchOptions[0].buildTurnRowListMarkup();

  assert.notEqual(markup.trim(), '', 'empty markup makes the morph fall through to a full render');
  // Parity: the rows come from buildMessageArticleMarkup -- the builder
  // performFullMessageRender uses -- so every row of the turn is present, not
  // just the streaming one, and tool/reasoning rows survive the patch.
  for (const rowId of ['turn_1:reasoning:p0', 'turn_1:tool_call:call_1', 'turn_1:assistant_text:1']) {
    assert.ok(markup.includes(rowId), `row-list markup must carry ${rowId}`);
  }
  assert.match(markup, /grown text/, 'the streaming row must carry the current content');
  // The wrapper is deliberately stripped: the morph targets the live
  // [data-turn-row-list] element's children, so its own attributes stay put.
  assert.ok(
    !markup.includes('data-turn-row-list'),
    'the builder must return the rows, not a nested row-list wrapper'
  );
  assert.ok(
    !markup.includes('chat-hover-row'),
    'the hover row lives outside the row list and must not be morphed into it'
  );
});

test('a turn article with no row list yields empty markup rather than a partial morph', (t) => {
  const { capturedPatchOptions } = buildWiringHarness(t, {
    articleMarkup: `<article class="chat-entry message-shell assistant"
      data-message-id="assistant_stream" data-message-role="assistant"
      data-message-status="streaming"><div class="chat-bubble">legacy</div></article>`,
  });

  assert.equal(
    capturedPatchOptions[0].buildTurnRowListMarkup(),
    '',
    'a legacy (non row-model) article must not be morphed into the row list'
  );
});

// Wave 1 field regression (2026-08-25). The first version of the builder resolved
// the article message with resolveTurnArticleMessageId alone. Under
// turn_activity_envelope the whole turn renders at ONE anchor message, and the
// dispatcher inside buildMessageArticleMarkup picks that anchor with a different
// function -- so when the two disagreed the dispatcher returned a thread-compat
// stub with no row list, the morph went inert, and the turn charged
// patch_fallback:row_model_no_row_list_markup on every delta. That is exactly what
// the owner's first post-fix turn showed: 78 of its 95 full renders.
test('the builder anchors on the live article, not on the streaming message id', (t) => {
  const anchorMarkup = ARTICLE_MARKUP.replace('data-message-id="assistant_stream"', 'data-message-id="assistant_anchor"');
  const { capturedPatchOptions } = buildWiringHarness(t, {
    // The live article is anchored on a DIFFERENT message than the streaming one.
    timelineArticleMessageId: 'assistant_anchor',
    extraMessages: [{ id: 'assistant_anchor', role: 'assistant', status: 'complete', content: 'anchor' }],
    callbackOverrides: {
      // Stale resolver: still reports the streaming message, as it did in the field.
      resolveTurnArticleMessageId: () => 'assistant_stream',
      // The dispatcher only yields a row list for the anchor message; every other
      // message gets the compat stub.
      buildMessageArticleMarkup: (message) => (
        String(message?.id || '') === 'assistant_anchor'
          ? anchorMarkup
          : '<div class="chat-row chat-row-thread-compat" data-row-kind="thread_compat"></div>'
      ),
    },
  });

  const markup = capturedPatchOptions[0].buildTurnRowListMarkup();
  assert.notEqual(markup, '', 'anchoring on the live article must yield the turn row list');
  assert.match(markup, /data-row-id="turn_1:tool_call:call_1"/);
});
