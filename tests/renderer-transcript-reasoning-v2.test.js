const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clearReasoningStreamStateCache,
  createReasoningV2Renderer,
} = require('../renderer/chat/renderer-transcript-reasoning-v2');
const { createTranscriptThinkingRenderer } = require('../renderer/chat/renderer-transcript-thinking');
const {
  ThinkingPanelController,
  getRenderableReasoningPhaseGroups,
  groupReasoningByPhase,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');

test.beforeEach(() => {
  clearReasoningStreamStateCache();
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeV2Renderer({ controller } = {}) {
  return createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => (message?.reasoning?.entries || []),
    renderMarkdown: (s) => `<p>${escapeHtml(s)}</p>`,
    renderStreamingMarkdownUnits: (s) => ({ html: `<p>${escapeHtml(s)}</p>` }),
    shouldShowThinkingToggle,
    thinkingController: controller || new ThinkingPanelController(),
  });
}

function makeTranscriptThinkingRenderer() {
  return createTranscriptThinkingRenderer({ escapeHtml });
}

test('not-applicable compaction renders neutral trim copy', () => {
  const html = makeTranscriptThinkingRenderer().renderContextCompactedNotice({
    context_compacted: {
      strategy: 'micro',
      summaryStatus: 'not_applicable',
      tokensBefore: 5000,
      tokensAfter: 4000,
    },
  });

  assert.match(html, /Older context was trimmed to fit this request/);
  assert.doesNotMatch(html, /Automatic summarization failed/);
});

test('compaction notice suppresses unchanged token metadata', () => {
  const html = makeTranscriptThinkingRenderer().renderContextCompactedNotice({
    context_compacted: {
      strategy: 'micro',
      summaryStatus: 'not_applicable',
      tokensBefore: 4525,
      tokensAfter: 4525,
    },
  });

  assert.doesNotMatch(html, /context-compacted-notice-meta/);
  assert.doesNotMatch(html, /4,525/);
});

test('mid-turn compaction notice reads as working-memory summarization', () => {
  const html = makeTranscriptThinkingRenderer().renderContextCompactedNotice({
    context_compacted: {
      strategy: 'summary',
      summaryStatus: 'created',
      phase: 'tool_loop',
      summaryPersisted: false,
    },
  });

  assert.match(html, /Working memory was summarized mid-task to keep going/);
});

test('mid-turn compaction label ignores the persisted flag while details report it', () => {
  const html = makeTranscriptThinkingRenderer().renderContextCompactedNotice({
    context_compacted: {
      strategy: 'summary',
      summaryStatus: 'created',
      phase: 'tool_loop',
      summaryPersisted: true,
    },
  });

  assert.match(html, /Working memory was summarized mid-task to keep going/);
  const label = html.match(/context-compacted-notice-label">([^<]+)</)?.[1] || '';
  assert.doesNotMatch(label, /future turns/);
  assert.match(html, /Summary saved for future turns/);
});

test('preflight created compaction notice copy is unchanged', () => {
  const renderer = makeTranscriptThinkingRenderer();
  const currentRequestHtml = renderer.renderContextCompactedNotice({
    context_compacted: {
      strategy: 'summary',
      summaryStatus: 'created',
      phase: 'preflight',
      summaryPersisted: false,
    },
  });
  const futureTurnsHtml = renderer.renderContextCompactedNotice({
    context_compacted: {
      strategy: 'summary',
      summaryStatus: 'created',
      phase: 'preflight',
      summaryPersisted: true,
    },
  });

  assert.match(currentRequestHtml, /Older turns were summarized for this request/);
  assert.doesNotMatch(currentRequestHtml, /future turns/);
  assert.match(futureTurnsHtml, /Older turns were summarized for this request and future turns/);
});

function buildMessage({
  id = 'msg_1',
  status = 'complete',
  entries = [{ text: 'pondering the question', thinkingId: 'tid_1' }],
  reasoningStatus = 'complete',
  reasoningPhases = null,
  phases = null,
} = {}) {
  return {
    id,
    role: 'assistant',
    status,
    streamId: 'stream_1',
    reasoning: {
      source: 'provider',
      status: reasoningStatus,
      entries,
    },
    reasoning_phases: reasoningPhases,
    phases,
  };
}

function makeStreamingRendererSpy() {
  const calls = [];
  const models = [];
  const renderer = createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => message?.reasoning?.entries || [],
    renderMarkdown: (source) => `<p>${escapeHtml(source)}</p>`,
    renderStreamingMarkdownUnits(source, options) {
      calls.push({ source, options });
      const model = {
        html: `<p>${escapeHtml(source)}</p>`,
        units: [{ html: `<p>${escapeHtml(source)}</p>`, fingerprint: `unit_${calls.length}` }],
        streamState: { call: calls.length },
      };
      models.push(model);
      return model;
    },
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });
  return { calls, models, renderer };
}

test('renderThinkingWidget no longer renders a Copy reasoning button', () => {
  const r = makeV2Renderer();
  const html = r.renderThinkingWidget(buildMessage(), 'msg_1');
  assert.ok(!html.includes('thinking-panel-actions'), 'copy-button container removed');
  assert.ok(!html.includes('data-thinking-copy'), 'copy hook removed');
  assert.ok(!html.includes('tool-result-copy-btn'), 'copy button removed');
  assert.ok(!html.includes('aria-label="Copy reasoning"'), 'copy button removed');
  // The widget still renders its trace content.
  assert.ok(html.includes('reasoning-row-stack'), 'the widget still renders');
});

test('renderThinkingWidget still renders the widget while streaming before any reasoning entries arrive', () => {
  const r = makeV2Renderer();
  // Live phase rendered before any entries arrive: the stack must still render.
  const message = buildMessage({
    status: 'streaming',
    entries: [],
    reasoningStatus: 'streaming',
    reasoningPhases: [
      { phaseKind: 'reasoning', phaseId: 'phase_1', thinkingId: 'tid_1', iteration: 1, summary: 'Reading context' },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('reasoning-row-stack'), 'the widget still renders');
});

test('renderThinkingWidget renders the v2 three-part header anatomy', () => {
  const r = makeV2Renderer();
  const html = r.renderThinkingWidget(buildMessage(), 'msg_1');
  assert.ok(html.includes('reasoning-row-stack'));
  assert.ok(html.includes('reasoning-row-block'));
  // Quiet one-liner grammar: leading name span, no uppercase kicker.
  assert.ok(html.includes('reasoning-row-name'));
  assert.ok(!html.includes('reasoning-row-kicker'), 'uppercase kicker removed by the quiet overhaul');
  assert.ok(html.includes('reasoning-row-main'));
  assert.ok(html.includes('reasoning-row-status-cluster'));
  assert.ok(html.includes('status-dot status-dot--ok'), 'completed row uses ok dot');
});

test('renderThinkingWidget marks streaming tail with active dot and shimmer', () => {
  const r = makeV2Renderer();
  const message = buildMessage({ status: 'streaming', reasoningStatus: 'streaming' });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('data-reasoning-status="streaming"'));
  assert.ok(html.includes('status-dot status-dot--active'));
  assert.ok(html.includes('reasoning-row-main shimmer-active'));
  assert.ok(html.includes('reasoning-row-name">Thinking<'), 'streaming tail is named Thinking');
});

test('renderThinkingWidget renders completed messages with stale streaming reasoning as complete', () => {
  const r = makeV2Renderer();
  const message = buildMessage({ status: 'complete', reasoningStatus: 'streaming' });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('data-thinking-status="complete"'));
  assert.ok(html.includes('data-reasoning-status="complete"'));
  assert.ok(html.includes('status-dot status-dot--ok'));
  assert.equal(html.includes('reasoning-row-main shimmer-active'), false);
});

test('renderThinkingWidget auto-expands only streaming rows (settled collapses, error included)', () => {
  const r = makeV2Renderer();
  const streamingMsg = buildMessage({ status: 'streaming', reasoningStatus: 'streaming' });
  const errorMsg = buildMessage({ status: 'error', reasoningStatus: 'error' });
  const completeMsg = buildMessage({ reasoningStatus: 'complete' });
  assert.ok(r.renderThinkingWidget(streamingMsg, 'msg_1').includes('reasoning-row-block expanded'));
  /* Owner call 2026-07-05: errored turns collapse to the preview — the error card owns the story. */
  assert.ok(!r.renderThinkingWidget(errorMsg, 'msg_1').includes('reasoning-row-block expanded'));
  assert.ok(!r.renderThinkingWidget(completeMsg, 'msg_2').includes('reasoning-row-block expanded'));
});

test('renderThinkingWidget renders multi-iteration parent header and iteration kickers', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    entries: [
      { text: 'first thought', thinkingId: 'tid_1' },
      { text: 'second thought', thinkingId: 'tid_2' },
    ],
    reasoningPhases: [
      { phaseKind: 'reasoning', thinkingId: 'tid_1', iteration: 1 },
      { phaseKind: 'reasoning', thinkingId: 'tid_2', iteration: 2 },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('Reasoning · 2 steps'), 'parent header reflects step count');
  assert.ok(html.includes('Step 1'));
  assert.ok(html.includes('Step 2'));
  assert.ok(!html.includes('Expand all'), 'inert group action is absent');
  assert.ok(!html.includes('data-reasoning-group-toggle'), 'dead group hook is absent');
  assert.ok(!html.includes('reasoning-row-group-toggle'), 'dead group control class is absent');
  assert.equal((html.match(/data-reasoning-toggle="true"/g) || []).length, 2, 'individual disclosures remain');
  assert.equal((html.match(/aria-expanded="(?:true|false)"/g) || []).length, 2, 'individual expansion state remains');
  assert.equal((html.match(/aria-controls="[^"]+"/g) || []).length, 2, 'individual panel relationships remain');
  assert.match(html, /class="reasoning-row-stack"[^>]*role="group"[^>]*aria-label="Reasoning"/);
  assert.equal((html.match(/class="reasoning-row-panel[^>]*role="region"[^>]*aria-labelledby="[^"]+"/g) || []).length, 2);
});

test('renderThinkingWidget settles completed reasoning phases while a later phase streams', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [
      { text: 'inspect the workspace', thinkingId: 'tid_1' },
      { text: 'verify the result', thinkingId: 'tid_2' },
    ],
    reasoningPhases: [
      {
        phaseKind: 'reasoning',
        phaseId: 'phase_1',
        thinkingId: 'tid_1',
        iteration: 1,
        completed: true,
      },
      {
        phaseKind: 'reasoning',
        phaseId: 'phase_2',
        thinkingId: 'tid_2',
        iteration: 2,
        completed: false,
      },
    ],
  });

  const html = r.renderThinkingWidget(message, 'msg_1');

  assert.match(html, /data-reasoning-status="complete"\s+data-reasoning-iteration="1"/);
  // 2026-08-29: the streaming tail additionally carries data-reasoning-live-tail.
  assert.match(html, /data-reasoning-status="streaming" data-reasoning-live-tail="true"\s+data-reasoning-iteration="2"/);
  assert.equal(
    (html.match(/class="reasoning-row-block expanded"/g) || []).length,
    1,
    'only the active tail phase auto-expands',
  );
});

test('renderThinkingWidget does not animate a completed final phase while answer text streams', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [{ text: 'finished reasoning', thinkingId: 'tid_1' }],
    reasoningPhases: [{
      phaseKind: 'reasoning',
      phaseId: 'phase_1',
      thinkingId: 'tid_1',
      completed: true,
    }],
  });

  const html = r.renderThinkingWidget(message, 'msg_1');

  assert.match(html, /data-reasoning-status="complete"/);
  assert.match(html, /reasoning-row-name">Thought</);
  assert.equal(html.includes('status-dot--active'), false);
  assert.equal(html.includes('shimmer-active'), false);
  assert.equal(html.includes('reasoning-row-block expanded'), false);
});

test('renderThinkingWidget keeps bodies separated when phases reuse a thinking id', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    entries: [
      { id: 'r1', text: 'first phase body', thinkingId: 'tid_shared' },
      { id: 'r2', text: 'second phase body', thinkingId: 'tid_shared' },
    ],
    reasoningPhases: [
      { phaseKind: 'reasoning', phaseId: 'phase_1', thinkingId: 'tid_shared', completed: true },
      { phaseKind: 'reasoning', phaseId: 'phase_2', thinkingId: 'tid_shared', completed: true },
    ],
    phases: [
      {
        phase_kind: 'reasoning',
        phase_id: 'phase_1',
        thinking_id: 'tid_shared',
        entries: [{ id: 'r1', text: 'first phase body', thinkingId: 'tid_shared' }],
      },
      {
        phase_kind: 'reasoning',
        phase_id: 'phase_2',
        thinking_id: 'tid_shared',
        entries: [{ id: 'r2', text: 'second phase body', thinkingId: 'tid_shared' }],
      },
    ],
  });

  const html = r.renderThinkingWidget(message, 'msg_1');
  const firstPhaseIndex = html.indexOf('data-phase-key="phase_1"');
  const firstBodyIndex = html.indexOf('first phase body');
  const secondPhaseIndex = html.indexOf('data-phase-key="phase_2"');
  const secondBodyIndex = html.indexOf('second phase body');

  assert.ok(firstPhaseIndex >= 0 && firstPhaseIndex < firstBodyIndex);
  assert.ok(firstBodyIndex < secondPhaseIndex && secondPhaseIndex < secondBodyIndex);
  assert.equal((html.match(/reasoning-row-panel empty/g) || []).length, 0);
});

test('renderThinkingWidget includes a newly started tail phase before its first reasoning entry', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [{ text: 'inspect the workspace', thinkingId: 'tid_1' }],
    reasoningPhases: [
      {
        phaseKind: 'reasoning',
        phaseId: 'phase_1',
        thinkingId: 'tid_1',
        iteration: 1,
        completed: true,
      },
      {
        phaseKind: 'reasoning',
        phaseId: 'phase_2',
        thinkingId: 'tid_2',
        iteration: 2,
        summary: 'Reviewing the tool result',
        completed: false,
      },
    ],
  });

  const html = r.renderThinkingWidget(message, 'msg_1');

  assert.ok(html.includes('Reasoning · 2 steps'));
  assert.ok(html.includes('Reviewing the tool result'));
  assert.match(html, /data-reasoning-status="complete"\s+data-reasoning-iteration="1"/);
  // 2026-08-29: the streaming tail additionally carries data-reasoning-live-tail.
  assert.match(html, /data-reasoning-status="streaming" data-reasoning-live-tail="true"\s+data-reasoning-iteration="2"/);
  assert.equal((html.match(/class="reasoning-row-block expanded"/g) || []).length, 1);
});

test('renderThinkingWidget honors user override on the shared ThinkingPanelController', () => {
  const controller = new ThinkingPanelController();
  const r = makeV2Renderer({ controller });
  const message = buildMessage();
  let html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(!html.includes('reasoning-row-block expanded'));
  controller.togglePhaseExpanded('msg_1', 'tid_1', false);
  html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('reasoning-row-block expanded'));
});

test('renderThinkingWidget surfaces tokens_per_second meta from phase metadata', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    reasoningPhases: [
      { phaseKind: 'reasoning', thinkingId: 'tid_1', iteration: 1, tokensPerSecond: 18 },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('reasoning-row-meta'));
  assert.ok(html.includes('18 tok/s'));
});

// "Thought for Xs" is a response_loop_display_v2 surface; the renderer reads the
// flag off document.documentElement.dataset (reflected by the render pipeline).
// These unit tests have no jsdom, so stub a minimal document for the flag state.
function withResponseLoopDisplayV2(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, 'document');
  const prev = global.document;
  global.document = {
    documentElement: { dataset: { responseLoopDisplay: value ? 'true' : 'false' } },
  };
  try {
    return fn();
  } finally {
    if (had) {
      global.document = prev;
    } else {
      delete global.document;
    }
  }
}

function settledDurationMessage() {
  return buildMessage({
    reasoningPhases: [
      {
        phaseKind: 'reasoning',
        thinkingId: 'tid_1',
        iteration: 1,
        tokensPerSecond: 18,
        startedAt: '2026-06-22T10:00:00.000Z',
        completedAt: '2026-06-22T10:00:03.400Z',
      },
    ],
  });
}

test('renderThinkingWidget shows "Thought for Xs" duration for a settled phase (flag on)', () => {
  const r = makeV2Renderer();
  // id mismatch with the latest assistant id => never the streaming tail.
  const html = withResponseLoopDisplayV2(true, () => r.renderThinkingWidget(settledDurationMessage(), 'msg_other'));
  // Quiet grammar: the duration IS the row name ("Thought for 3.4s"), so the
  // cluster meta is intentionally empty for a single settled phase.
  assert.ok(html.includes('reasoning-row-name'));
  assert.ok(html.includes('Thought for 3.4s'));
});

test('renderThinkingWidget hides "Thought for Xs" when response_loop_display_v2 is off', () => {
  const r = makeV2Renderer();
  // Same settled phase + same timing, flag OFF: the duration label is suppressed
  // and the pre-feature tok/s secondary meta is shown instead. Locks the
  // flag-isolation gap so the Phase-2 label can never leak when the flag is off.
  const html = withResponseLoopDisplayV2(false, () => r.renderThinkingWidget(settledDurationMessage(), 'msg_other'));
  assert.ok(!html.includes('Thought for'), 'duration label must not render with the flag off');
  assert.ok(html.includes('reasoning-row-name">Thought<'), 'settled row without a duration is named Thought');
  assert.ok(html.includes('18 tok/s'), 'flag-off falls back to the tok/s secondary meta');
});

test('renderThinkingWidget keeps tok/s (not duration) while the tail is streaming', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    reasoningPhases: [
      {
        phaseKind: 'reasoning',
        thinkingId: 'tid_1',
        iteration: 1,
        tokensPerSecond: 18,
        startedAt: '2026-06-22T10:00:00.000Z',
        completedAt: '2026-06-22T10:00:03.400Z',
      },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('18 tok/s'));
  assert.ok(!html.includes('Thought for'));
});

test('renderThinkingWidget prefers metadata.summary over entry-derived summary', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    entries: [{ text: 'long internal monologue here', thinkingId: 'tid_1' }],
    reasoningPhases: [
      { phaseKind: 'reasoning', thinkingId: 'tid_1', iteration: 1, summary: 'Synthesizing answer' },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('Synthesizing answer'));
});

test('renderThinkingWidget renders a live reasoning phase before entries arrive', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    status: 'streaming',
    entries: [],
    reasoningStatus: 'streaming',
    reasoningPhases: [
      { phaseKind: 'reasoning', phaseId: 'phase_1', thinkingId: 'tid_1', iteration: 1, summary: 'Reading context' },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');

  assert.ok(html.includes('Reading context'));
  assert.ok(html.includes('data-thinking-id="tid_1"'));
  assert.deepEqual(
    getRenderableReasoningPhaseGroups(message),
    [{ phaseId: 'phase_1', phaseKey: 'tid_1', thinkingId: 'tid_1', entries: [] }]
  );
});

test('renderThinkingWidget renders reasoning markdown with mermaid:plain on both paths', () => {
  const markdownCalls = [];
  const streamingCalls = [];
  const renderer = createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => (message?.reasoning?.entries || []),
    renderMarkdown: (s, options) => {
      markdownCalls.push(options);
      return `<p>${escapeHtml(s)}</p>`;
    },
    renderStreamingMarkdownUnits: (s, options) => {
      streamingCalls.push(options);
      return { html: `<p>${escapeHtml(s)}</p>` };
    },
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });

  renderer.renderThinkingWidget(buildMessage(), 'msg_1');
  renderer.renderThinkingWidget(
    buildMessage({ status: 'streaming', reasoningStatus: 'streaming' }),
    'msg_1',
  );

  assert.equal(markdownCalls.length, 1, 'settled path uses renderMarkdown');
  assert.deepEqual(markdownCalls[0], { mermaid: 'plain' }, 'settled reasoning must render fences plain');
  assert.equal(streamingCalls.length, 1, 'streaming tail uses renderStreamingMarkdownUnits');
  assert.deepEqual(streamingCalls[0], {
    mermaid: 'plain',
    previousUnits: [],
    previousStreamState: null,
  }, 'streaming reasoning must render fences plain with an empty initial stream state');
});

test('renderThinkingWidget preserves cached units and streamState object identity across frames', () => {
  const { calls, models, renderer } = makeStreamingRendererSpy();
  const first = buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [{ id: 'entry_1', text: 'first paragraph\n\ntail', thinkingId: 'phase_1' }],
  });
  renderer.renderThinkingWidget(first, 'msg_1');
  renderer.renderThinkingWidget(buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [{ id: 'entry_1', text: 'first paragraph\n\ntail grows', thinkingId: 'phase_1' }],
  }), 'msg_1');

  assert.strictEqual(calls[1].options.previousUnits, models[0].units);
  assert.strictEqual(calls[1].options.previousStreamState, models[0].streamState);
});

test('reasoning stream-state cache is message-scoped', () => {
  const { calls, renderer } = makeStreamingRendererSpy();
  for (const messageId of ['message_a', 'message_b']) {
    renderer.renderThinkingWidget(buildMessage({
      id: messageId,
      status: 'streaming',
      reasoningStatus: 'streaming',
      entries: [{ id: `entry_${messageId}`, text: 'shared phase body', thinkingId: 'shared_phase' }],
    }), messageId);
  }

  assert.deepEqual(calls[1].options.previousUnits, []);
  assert.equal(calls[1].options.previousStreamState, null);
});

test('settling a reasoning phase evicts its cached stream state', () => {
  const { calls, renderer } = makeStreamingRendererSpy();
  renderer.renderThinkingWidget(buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [{ id: 'entry_1', text: 'streaming body', thinkingId: 'phase_1' }],
  }), 'msg_1');
  renderer.renderThinkingWidget(buildMessage({
    status: 'complete',
    reasoningStatus: 'complete',
    entries: [{ id: 'entry_1', text: 'settled body', thinkingId: 'phase_1' }],
  }), 'msg_1');
  renderer.renderThinkingWidget(buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [{ id: 'entry_1', text: 'new streaming body', thinkingId: 'phase_1' }],
  }), 'msg_1');

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].options.previousUnits, []);
  assert.equal(calls[1].options.previousStreamState, null);
});

test('reasoning stream-state cache evicts the least-recently-used phase past eight entries', () => {
  const { calls, models, renderer } = makeStreamingRendererSpy();
  const renderPhase = (phaseNumber, suffix = '') => renderer.renderThinkingWidget(buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [{
      id: `entry_${phaseNumber}`,
      text: `phase ${phaseNumber}${suffix}`,
      thinkingId: `phase_${phaseNumber}`,
    }],
  }), 'msg_1');

  for (let phaseNumber = 1; phaseNumber <= 8; phaseNumber += 1) renderPhase(phaseNumber);
  renderPhase(1, ' touched');
  assert.strictEqual(calls[8].options.previousStreamState, models[0].streamState, 'phase 1 was promoted to most-recent');
  renderPhase(9);
  renderPhase(2, ' after eviction');

  assert.deepEqual(calls[10].options.previousUnits, []);
  assert.equal(calls[10].options.previousStreamState, null, 'phase 2 was the least-recently-used entry');
});

test('renderThinkingWidget keeps phase-only summaries distinct when thinking ids collide', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    status: 'streaming',
    entries: [],
    reasoningStatus: 'streaming',
    reasoningPhases: [
      { phaseKind: 'reasoning', phaseId: 'phase_1', thinkingId: 'dup_tid', iteration: 1, summary: 'Reading context' },
      { phaseKind: 'reasoning', phaseId: 'phase_2', thinkingId: 'dup_tid', iteration: 2, summary: 'Checking tools' },
    ],
  });

  const html = r.renderThinkingWidget(message, 'msg_1');

  assert.ok(html.includes('Reading context'));
  assert.ok(html.includes('Checking tools'));
  assert.ok(html.includes('data-phase-key="phase_1"'));
  assert.ok(html.includes('data-phase-key="phase_2"'));
});

/* 2026-06-11 live-debug regressions: generic per-hop labels and the tall
   blank auto-expanded shell row. */

test('renderPhase derives the header label from entries when the sidecar sends the generic constant', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    entries: [{ text: 'The user wants me to write a script into the workspace.', thinkingId: 'tid_1' }],
    reasoningPhases: [
      { phaseKind: 'reasoning', thinkingId: 'tid_1', iteration: 1, summary: 'Reasoning through the turn' },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(
    html.includes('The user wants me to write a script'),
    'header label comes from the actual thinking text'
  );
  assert.ok(
    !html.includes('>Reasoning through the turn<'),
    'the generic constant is fallback-only'
  );
});

test('renderPhase keeps a non-generic sidecar summary as the header label', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    entries: [{ text: 'irrelevant entry text', thinkingId: 'tid_1' }],
    reasoningPhases: [
      { phaseKind: 'reasoning', thinkingId: 'tid_1', iteration: 1, summary: 'Choosing the animation library' },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.ok(html.includes('Choosing the animation library'));
});

test('renderPhase falls back to the short Reasoning label when entries cannot produce one', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    entries: [{ text: '   ', thinkingId: 'tid_1' }],
    reasoningPhases: [
      { phaseKind: 'reasoning', thinkingId: 'tid_1', iteration: 1, summary: 'Reasoning through the turn' },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  // summaryFromEntries' own fallback ('Reasoning') wins over the generic
  // sidecar constant, so the long boilerplate label never renders.
  assert.match(html, /reasoning-row-main[^>]*>Reasoning</);
  assert.ok(!html.includes('Reasoning through the turn'));
});

test('renderPhase reports effective expansion while preserving a requested-open preference for an empty panel', () => {
  const controller = new ThinkingPanelController();
  controller.togglePhaseExpanded('msg_1', 'tid_1', false);
  const r = makeV2Renderer({ controller });
  const emptyMessage = buildMessage({
    entries: [{ text: '   ', thinkingId: 'tid_1' }],
  });
  const emptyHtml = r.renderThinkingWidget(emptyMessage, 'msg_1');

  assert.equal(controller.isPhaseExpanded('msg_1', 'tid_1', false), true, 'requested preference remains open');
  assert.match(emptyHtml, /data-phase-key="tid_1"[\s\S]*?aria-expanded="false"/);
  assert.ok(emptyHtml.includes('reasoning-row-block expanded'), 'block header keeps requested expansion');
  assert.ok(emptyHtml.includes('reasoning-row-panel empty'), 'body-less panel is marked empty');
  assert.ok(!emptyHtml.includes('reasoning-row-panel expanded'), 'body-less panel stays closed');
  assert.match(emptyHtml, /reasoning-row-panel[^"]*"[^>]*hidden/, 'body-less panel keeps the hidden attribute');

  const bodyHtml = r.renderThinkingWidget(buildMessage({
    entries: [{ text: 'now there is real thinking text', thinkingId: 'tid_1' }],
  }), 'msg_1');
  assert.match(bodyHtml, /data-phase-key="tid_1"[\s\S]*?aria-expanded="true"/);
  assert.ok(bodyHtml.includes('reasoning-row-panel expanded'), 'untouched preference opens the panel once a body arrives');
});

test('renderPhase opens the panel once body content exists for the same auto-expand state', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    status: 'streaming',
    reasoningStatus: 'streaming',
    entries: [{ text: 'now there is real thinking text', thinkingId: 'tid_1' }],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.match(html, /data-phase-key="tid_1"[\s\S]*?aria-expanded="true"/);
  assert.ok(html.includes('reasoning-row-panel expanded'), 'panel opens with a body');
  assert.ok(html.includes('reasoning-row-panel-body'));
});

test('renderPhase strips inline markdown from the derived header label but not the body', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    entries: [{ text: '**Testing local file URL access**\n\nProbing the sandbox rules.', thinkingId: 'tid_1' }],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.match(
    html,
    /reasoning-row-main[^>]*>Testing local file URL access</,
    'header label drops the ** wrappers'
  );
  assert.ok(
    html.includes('**Testing local file URL access**'),
    'the markdown body still receives the raw entry text'
  );
});

test('renderPhase strips inline markdown from a non-generic sidecar summary label', () => {
  const r = makeV2Renderer();
  const message = buildMessage({
    entries: [{ text: 'irrelevant entry text', thinkingId: 'tid_1' }],
    reasoningPhases: [
      { phaseKind: 'reasoning', thinkingId: 'tid_1', iteration: 1, summary: '**Choosing the animation library**' },
    ],
  });
  const html = r.renderThinkingWidget(message, 'msg_1');
  assert.match(html, /reasoning-row-main[^>]*>Choosing the animation library</);
});
