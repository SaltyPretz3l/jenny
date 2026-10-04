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

// HB-005: the reducer reuses a reasoning row across a tool boundary when the
// phase/thinking id repeats, so the row keeps segment 0 as its primary id and
// names the live segment only in data-source-message-ids. The live lookup
// missed it, scoped the patch to the LAST stack (another phase), failed the
// block-key check and rebuilt the whole row list -- big diff row included --
// on every reasoning delta.
test('a reused reasoning row named only in data-source-message-ids is patched surgically', () => {
  const html = `<html><body><div id="timeline">
    <article class="chat-entry assistant" data-message-id="seg0">
      <div class="turn-row-list" data-turn-row-list="true">
        <div class="chat-row" data-row-id="row_reasoning_a" data-row-kind="reasoning" data-source-message-id="seg0" data-source-message-ids="seg0 seg2">
          ${reasoningStackMarkup('planning the edit', { messageId: 'seg0', thinkingId: 'think_a' })}
        </div>
        <div class="chat-row" data-row-id="row_edit" data-row-kind="tool_call" data-tool-call-id="call_edit">
          <pre class="diff">${'+ line<br>'.repeat(200)}</pre>
        </div>
        <div class="chat-row" data-row-id="row_reasoning_b" data-row-kind="reasoning" data-source-message-id="seg1" data-source-message-ids="seg1">
          ${reasoningStackMarkup('checked the result', { messageId: 'seg1', thinkingId: 'think_b' })}
        </div>
      </div>
    </article>
  </div></body></html>`;
  const { timeline, controller } = createImmediateRevealController(html);
  const streamingMessage = { id: 'seg2', role: 'assistant', status: 'streaming', content: '' };
  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 7,
    streamingMessage,
    streamingArticleMessageId: 'seg0',
  });
  let rowListRebuilds = 0;
  const fallbacks = [];
  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 7,
    latestAssistantMessageId: 'seg2',
    streamingMessage,
    messages: [streamingMessage],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: reasoningStackMarkup('planning the edit, then more', { messageId: 'seg2', thinkingId: 'think_a' }),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
    buildTurnRowListMarkup: () => { rowListRebuilds += 1; return ''; },
    onFallback: (cause) => { fallbacks.push(cause); },
  });

  assert.deepEqual(fallbacks, []);
  assert.equal(rowListRebuilds, 0, 'a reasoning delta must not rebuild the turn row list');
  assert.match(
    timeline.querySelector('[data-row-id="row_reasoning_a"]').textContent,
    /then more/,
    'the delta lands in the reused row that names the live segment'
  );
  assert.doesNotMatch(timeline.querySelector('[data-row-id="row_reasoning_b"]').textContent, /then more/);
});

// HB-010: a live segment message carries EVERY reasoning phase of the stream
// (reasoning_phases is stream-scoped), so the message-level widget renders
// "Step N" blocks for the earlier phases with empty bodies. Their settled
// fingerprints never match the rows those phases really render in, so the
// sibling check failed and every reasoning delta rebuilt the whole turn row
// list. The patch now takes the live row's own render.
function phaseBlockMarkup(messageId, iteration, { name, status, fp = '', body = '' }) {
  const key = `think_${iteration}`;
  return `
    <div class="reasoning-row-block" data-reasoning-status="${status}" data-thinking-id="${key}" data-phase-key="${key}"${fp ? ` data-reasoning-fp="${fp}"` : ''}>
      <button class="reasoning-row-header" type="button" data-reasoning-toggle="true" data-message-id="${messageId}" data-thinking-id="${key}" data-phase-key="${key}">
        <span class="reasoning-row-name">${name}</span>
      </button>
      <div class="reasoning-row-panel${body ? ' expanded' : ' empty'}" data-thinking-id="${key}" data-phase-key="${key}"${body ? '' : ' hidden'}>
        ${body ? `<div class="reasoning-row-panel-body chat-bubble-markdown"><p>${body}</p></div>` : ''}
      </div>
    </div>`;
}

function reasoningRowMarkup(segment, iteration, options) {
  return `<div class="chat-row" data-row-id="turn:reasoning:phase_${iteration}" data-row-kind="reasoning" data-source-message-id="seg${segment}" data-source-message-ids="seg${segment}">
    <div class="reasoning-row-stack" data-reasoning-row-version="2">${phaseBlockMarkup(`seg${segment}`, iteration, options)}</div>
  </div>`;
}

function patchLiveReasoningOnLongTurn({ withRowRenderer }) {
  const priorSegments = 12;
  let rows = '';
  for (let segment = 0; segment < priorSegments; segment += 1) {
    rows += reasoningRowMarkup(segment, segment + 1, { name: 'Thought', status: 'complete', fp: `own${segment}`, body: `settled ${segment}` });
    rows += `<div class="chat-row" data-row-id="turn:tool_call:call_${segment}" data-row-kind="tool_call" data-tool-call-id="call_${segment}"><div class="tool-card">read_file ${segment}</div></div>`;
  }
  const live = priorSegments;
  rows += reasoningRowMarkup(live, live + 1, { name: 'Thinking', status: 'streaming', body: 'draft' });
  const { timeline, controller } = createImmediateRevealController(`<html><body><div id="timeline">
    <article class="chat-entry assistant" data-message-id="seg0">
      <div class="turn-row-list" data-turn-row-list="true">${rows}</div>
    </article>
  </div></body></html>`);
  const streamingMessage = { id: `seg${live}`, role: 'assistant', status: 'streaming', content: '' };
  controller.commitFullRender({ currentSessionId: 'session-1', structureSignature: 3, streamingMessage, streamingArticleMessageId: 'seg0' });
  const liveRowId = `turn:reasoning:phase_${live + 1}`;
  const settledRow = timeline.querySelector('[data-row-id="turn:reasoning:phase_1"]');
  const toolRow = timeline.querySelector('[data-row-id="turn:tool_call:call_0"]');
  // The message-level widget: every phase of the stream, earlier ones as empty
  // metadata-only "Step N" blocks with a fingerprint of their own.
  let messageStack = '<div class="reasoning-row-stack" data-reasoning-row-version="2">';
  for (let iteration = 1; iteration <= live; iteration += 1) {
    messageStack += phaseBlockMarkup(`seg${live}`, iteration, { name: `Step ${iteration}`, status: 'complete', fp: 'meta' });
  }
  messageStack += `${phaseBlockMarkup(`seg${live}`, live + 1, { name: `Step ${live + 1}`, status: 'streaming', body: 'draft and more' })}</div>`;
  const calls = { rowList: 0, rowRender: [] };
  const fallbacks = [];
  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 3,
    latestAssistantMessageId: streamingMessage.id,
    streamingMessage,
    messages: [streamingMessage],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null, thinkingMarkup: messageStack, innerHtml: '', pending: true, entryReveal: false, status: 'streaming', finalizedAt: '',
    }),
    buildLiveReasoningRowsMarkup: withRowRenderer
      ? () => {
        calls.rowRender.push(streamingMessage.id);
        return reasoningRowMarkup(live, live + 1, { name: 'Thinking', status: 'streaming', body: 'draft and more' });
      }
      : undefined,
    buildTurnRowListMarkup: () => { calls.rowList += 1; return ''; },
    onFallback: (cause) => { fallbacks.push(cause); },
  });
  return { timeline, calls, fallbacks, liveRowId, settledRow, toolRow };
}

test('HB-010: a reasoning delta on a long row-model turn patches the live row without a whole-turn build', () => {
  const { timeline, calls, fallbacks, liveRowId, settledRow, toolRow } = patchLiveReasoningOnLongTurn({ withRowRenderer: true });

  assert.equal(calls.rowList, 0, 'a reasoning-only delta must not build the whole turn row list');
  assert.deepEqual(fallbacks, []);
  assert.deepEqual(calls.rowRender, ['seg12'], 'only the live segment\'s rows are rendered, once');
  const liveRow = timeline.querySelector(`[data-row-id="${liveRowId}"]`);
  assert.match(liveRow.textContent, /draft and more/, 'the delta is painted in the live row');
  assert.equal(liveRow.querySelector('.reasoning-row-name').textContent.trim(), 'Thinking', 'the row keeps its own header, never the message-level "Step N"');
  assert.equal(timeline.querySelectorAll('.reasoning-row-block').length, 13, 'no phase block is added or dropped');
  assert.strictEqual(timeline.querySelector('[data-row-id="turn:reasoning:phase_1"]'), settledRow, 'earlier rows are untouched');
  assert.strictEqual(timeline.querySelector('[data-row-id="turn:tool_call:call_0"]'), toolRow);
  assert.match(settledRow.textContent, /settled 0/);
});

test('HB-010: without the live row render, the stream-scoped message stack forces a whole-turn build (the defect)', () => {
  const { calls } = patchLiveReasoningOnLongTurn({ withRowRenderer: false });
  assert.equal(calls.rowList, 1, 'the message-level stack never lines up with a one-phase row');
});
