const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createImmediateRevealController,
  disposeTrackedRevealDoms,
  reasoningStackMarkup,
} = require('./helpers/renderer-stream-reveal-harness');

test.afterEach(() => {
  disposeTrackedRevealDoms();
});

// A row-model turn article mid-way through a multi-segment (tool-round) turn:
// segment 0 carried reasoning, segment 1 is streaming text and has none of its
// own. This is the shape the 2026-08-25 degraded turns were in when 526 of 606
// deltas charged patch_fallback:row_model_not_surgical.
function buildRowModelTurnMarkup() {
  return `
    <html>
      <body>
        <div id="timeline">
          <div class="chat-thread-root" data-thread-message-id="user_stream_root">
            <article class="chat-entry assistant" data-message-id="assistant_stream_root" data-turn-id="assistant_stream_root">
              <div class="turn-row-list" data-turn-row-list="true">
                <div class="chat-row" data-row-id="row_reasoning_seg0" data-row-kind="reasoning" data-source-message-id="assistant_stream_root_seg0">
                  ${reasoningStackMarkup('thought about it', { messageId: 'assistant_stream_root_seg0' })}
                </div>
                <div class="chat-row" data-row-id="row_tool_1" data-row-kind="tool_call" data-tool-call-id="call_1">
                  <div class="tool-card">web_search</div>
                </div>
                <div class="chat-row" data-row-id="row_text_seg1" data-row-kind="assistant_text" data-source-message-id="assistant_stream_root_seg1">
                  <div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true"><span>partial</span></div>
                </div>
              </div>
            </article>
          </div>
        </div>
      </body>
    </html>
  `;
}

function patchRowModelTurn(t, { onFallback, buildTurnRowListMarkup } = {}) {
  const { timeline, controller } = createImmediateRevealController(buildRowModelTurnMarkup(), {
    renderStreamingMarkdownUnits: () => ({
      html: '<span>partial and more</span>',
      units: [{ html: '<span>partial and more</span>', revealed: true, tail: true }],
      fingerprints: ['partial and more'],
      changedStartIndex: 0,
    }),
  });

  const streamingMessage = {
    id: 'assistant_stream_root_seg1',
    role: 'assistant',
    status: 'streaming',
    content: 'partial and more',
  };

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage,
    streamingArticleMessageId: 'assistant_stream_root',
    activeTurnRootMessageId: 'user_stream_root',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:1',
  });

  // Captured BEFORE the patch: a destructive rebuild replaces these nodes, and
  // node identity is the only assertion that can tell a keyed morph apart from
  // one. Text and row counts survive both.
  const preRows = {
    reasoning: timeline.querySelector('[data-row-id="row_reasoning_seg0"]'),
    tool: timeline.querySelector('[data-row-id="row_tool_1"]'),
    text: timeline.querySelector('[data-row-id="row_text_seg1"]'),
  };

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream_root_seg1',
    streamingMessage,
    messages: [streamingMessage],
    // The live segment has no reasoning of its own: thinkingMarkup is present
    // but empty. segmentScope then falls back to the LAST reasoning stack in
    // the turn -- segment 0's -- and the empty-vs-present mismatch makes
    // patchReasoningStack demand a full fallback.
    buildMessageNodeState: () => ({
      bubbleInnerHtml: '<span>partial and more</span>',
      thinkingMarkup: '',
      innerHtml: '<div class="chat-bubble" data-streaming-bubble="true"><span>partial and more</span></div>',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
    buildTurnRowListMarkup,
    onFallback,
  });

  return { timeline, controller, preRows };
}

test('a live segment without its own reasoning does not fall back to a full transcript render', (t) => {
  const fallbacks = [];
  const { timeline } = patchRowModelTurn(t, {
    onFallback: (cause) => { fallbacks.push(cause); },
    // Wave 1 seam: the row-list markup the morph applies when the surgical
    // patch cannot take. Mirrors the live row set with the grown text.
    buildTurnRowListMarkup: () => `
      <div class="chat-row" data-row-id="row_reasoning_seg0" data-row-kind="reasoning" data-source-message-id="assistant_stream_root_seg0">
        ${reasoningStackMarkup('thought about it', { messageId: 'assistant_stream_root_seg0' })}
      </div>
      <div class="chat-row" data-row-id="row_tool_1" data-row-kind="tool_call" data-tool-call-id="call_1">
        <div class="tool-card">web_search</div>
      </div>
      <div class="chat-row" data-row-id="row_text_seg1" data-row-kind="assistant_text" data-source-message-id="assistant_stream_root_seg1">
        <div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true"><span>partial and more</span></div>
      </div>
    `,
  });

  assert.deepEqual(
    fallbacks,
    [],
    'the row-model article must be reconciled in place, never charged to a full transcript render'
  );
  assert.match(
    String(timeline.textContent || ''),
    /partial and more/,
    'the delta must actually be painted -- a silent no-op is the failure this replaces'
  );
});

test('an inert morph names itself rather than hiding behind the old reason code', (t) => {
  const fallbacks = [];
  patchRowModelTurn(t, {
    onFallback: (cause) => { fallbacks.push(cause); },
    // No builder supplied -- the production wiring failed to reach the patch
    // path. This must be distinguishable in full_render_reasons from a morph
    // that was attempted and failed, or the fix can be silently inert in the
    // field while the telemetry still looks like the pre-fix bug.
    buildTurnRowListMarkup: undefined,
  });

  assert.deepEqual(fallbacks, ['row_model_no_row_list_markup']);
});

test('whitespace-only row markup counts as no markup, not as a failed morph', (t) => {
  const fallbacks = [];
  patchRowModelTurn(t, {
    onFallback: (cause) => { fallbacks.push(cause); },
    buildTurnRowListMarkup: () => '   ',
  });

  assert.deepEqual(fallbacks, ['row_model_no_row_list_markup']);
});

test('the keyed morph reuses the untouched rows instead of rebuilding the turn', (t) => {
  const { timeline, preRows } = patchRowModelTurn(t, {
    onFallback: () => {},
    // Carries a row the DOM did not have. Without it the morph could no-op and
    // still satisfy every other assertion -- Case A has already painted the
    // bubble by this point, so "the text is there" proves nothing about the morph.
    buildTurnRowListMarkup: () => `
      <div class="chat-row" data-row-id="row_reasoning_seg0" data-row-kind="reasoning" data-source-message-id="assistant_stream_root_seg0">
        ${reasoningStackMarkup('thought about it', { messageId: 'assistant_stream_root_seg0' })}
      </div>
      <div class="chat-row" data-row-id="row_tool_1" data-row-kind="tool_call" data-tool-call-id="call_1">
        <div class="tool-card">web_search</div>
      </div>
      <div class="chat-row" data-row-id="row_tool_2" data-row-kind="tool_call" data-tool-call-id="call_2">
        <div class="tool-card">fetch_url</div>
      </div>
      <div class="chat-row" data-row-id="row_text_seg1" data-row-kind="assistant_text" data-source-message-id="assistant_stream_root_seg1">
        <div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true"><span>partial and more</span></div>
      </div>
    `,
  });

  // The morph actually wrote: the new row exists only in the incoming markup.
  assert.ok(
    timeline.querySelector('[data-row-id="row_tool_2"]'),
    'a row present only in the incoming markup proves the morph ran rather than no-opped'
  );
  // ...and reused rather than rebuilt: same nodes, not equal ones.
  assert.strictEqual(
    timeline.querySelector('[data-row-id="row_tool_1"]'),
    preRows.tool,
    'a settled tool row must be the SAME node after the morph, not a rebuilt twin'
  );
  assert.strictEqual(
    timeline.querySelector('[data-row-id="row_reasoning_seg0"]'),
    preRows.reasoning,
    'an earlier segment reasoning row must survive the morph as the same node'
  );
  assert.strictEqual(
    timeline.querySelector('[data-row-id="row_text_seg1"]'),
    preRows.text,
    'the streaming row must be patched in place, never replaced -- replacement is the flicker'
  );

  const rows = timeline.querySelectorAll('.chat-row');
  assert.equal(rows.length, 4, 'the settled rows survive and the new one is appended');
  assert.equal(
    timeline.querySelector('[data-row-id="row_tool_1"]')?.textContent?.trim(),
    'web_search',
    'a settled tool card must not be destroyed by a text delta on a later segment'
  );
  // Without this the test passes vacuously against the pre-fix bail-out, which
  // leaves all three rows in place precisely because it paints nothing.
  assert.match(
    String(timeline.querySelector('[data-row-id="row_text_seg1"]')?.textContent || ''),
    /partial and more/,
    'the streaming row must carry the grown text after the morph'
  );
});
