const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Echo stubs: each renderer returns a string encoding the synthetic message the registry
// adapter passed it, so the test pins the payload->message field mapping (registry == the
// Tier-3 twin called with the same synthetic message).
function createRenderer() {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown(text) { return `<p>${escapeHtml(text)}</p>`; },
    renderInteractiveRoundRecap(message) {
      return `RECAP[id=${message.id}|content=${message.content}|recap=${JSON.stringify(message.interactive_round_recap)}]`;
    },
    renderProactiveSuggestionBlock(message) {
      return `SUGG[id=${message.id}|content=${message.content}|suggestion=${JSON.stringify(message.proactive_suggestion)}]`;
    },
    renderSlashCommandOutput(message) {
      return `SLASH[id=${message.id}|cmd=${message.slash_command}|content=${message.content}]`;
    },
  });
}

// The full set of kinds the projector can emit (SIMPLE_ROW_KIND_BY_EVENT + the tool/text
// kinds). Every one must resolve to a real registry builder so no kind reaches
// buildGenericRowMarkup at runtime (acceptance criterion 3).
const PROJECTOR_EMITTABLE_KINDS = [
  'user_bubble', 'assistant_text', 'reasoning',
  'tool_step', 'tool_call', 'tool_result', 'approval_gap',
  'system_notice', 'agent_progress', 'plan_object', 'plan_document', 'plan_proposal',
  'recap', 'suggestion', 'slash_output', 'batch', 'attachment',
];

test('dispatch registry: every projector-emittable kind has a builder (no orphaned kinds)', () => {
  const renderer = createRenderer();
  assert.ok(renderer.ROW_BUILDERS, 'ROW_BUILDERS should be exported');
  for (const kind of PROJECTOR_EMITTABLE_KINDS) {
    assert.equal(typeof renderer.ROW_BUILDERS[kind], 'function', `missing builder for kind=${kind}`);
  }
});

test('dispatch registry: recap row delegates to renderInteractiveRoundRecap with the mapped synthetic message', () => {
  const renderer = createRenderer();
  const recap = { round_index: 1, answer_count: 1, items: [{ question_id: 'q1', prompt: 'Pick A or B?', answer_label: 'A' }], collapsed: true };
  const row = { kind: 'recap', primary_message_id: 'interactive_round_recap_stream_15', payload: { content: '', interactive_round_recap: recap } };
  const out = renderer.buildRowBodyMarkup(row);
  assert.equal(out, `RECAP[id=interactive_round_recap_stream_15|content=|recap=${JSON.stringify(recap)}]`);
  assert.ok(out.length > 0, 'recap row must be non-empty');
  // registry == Tier-3 twin: the dedicated builder produces the same output.
  assert.equal(renderer.buildRecapRowMarkup(row), out);
});

test('dispatch registry: suggestion row delegates to renderProactiveSuggestionBlock with content + proactive_suggestion mapped', () => {
  const renderer = createRenderer();
  const suggestion = { id: 's1', title: 'T', body: 'B', promptSuggestion: 'P' };
  const row = { kind: 'suggestion', primary_message_id: 'sugg_msg', payload: { content: 'B', proactive_suggestion: suggestion } };
  const out = renderer.buildRowBodyMarkup(row);
  assert.equal(out, `SUGG[id=sugg_msg|content=B|suggestion=${JSON.stringify(suggestion)}]`);
  assert.ok(out.length > 0, 'suggestion row must be non-empty');
  assert.equal(renderer.buildSuggestionRowMarkup(row), out);
});

test('dispatch registry: slash_output row maps content and degrades slash_command to empty (renders /command default)', () => {
  const renderer = createRenderer();
  // The projector carries only `content` in the slash_output row payload (no slash_command).
  const row = { kind: 'slash_output', primary_message_id: 'slash_output_stream_13', payload: { content: 'Available commands: /help, /clear' } };
  const out = renderer.buildRowBodyMarkup(row);
  assert.equal(out, 'SLASH[id=slash_output_stream_13|cmd=|content=Available commands: /help, /clear]');
  assert.ok(out.length > 0, 'slash_output row must be non-empty');
  // slash_command is absent from the row payload -> empty (real renderer renders '/command').
  assert.match(out, /cmd=\|/);
  assert.equal(renderer.buildSlashOutputRowMarkup(row), out);
});

test('dispatch registry: tool_step still routes to buildToolStepRowMarkup (live-reducer row), NOT the generic fallback', () => {
  const renderer = createRenderer();
  const row = {
    kind: 'tool_step',
    primary_message_id: 'assistant_x',
    turn_id: 'stream_x',
    payload: { tool_call_id: 'call_1', tool_name: 'Bash', state: 'completed' },
  };
  assert.equal(renderer.buildRowBodyMarkup(row), renderer.buildToolStepRowMarkup(row));
});

test('dispatch registry: attachment row is defensive-only (D3) -> empty markup', () => {
  const renderer = createRenderer();
  assert.equal(renderer.buildRowBodyMarkup({ kind: 'attachment', primary_message_id: 'a', payload: {} }), '');
});

test('dispatch registry: batch row with no render-pipeline builder degrades to empty (headless default)', () => {
  const renderer = createRenderer();
  // buildInteractiveBatchRowMarkup is supplied by the render pipeline (it needs
  // the session pending batch + draft); absent in this headless harness -> ''.
  assert.equal(renderer.buildRowBodyMarkup({ kind: 'batch', primary_message_id: 'b', payload: {} }), '');
});

test('dispatch registry: batch row delegates to the render-pipeline buildInteractiveBatchRowMarkup with the row', () => {
  let seen = null;
  const renderer = createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    buildInteractiveBatchRowMarkup(row) {
      seen = row;
      return `BATCH[batch_id=${row?.payload?.question_batch?.batch_id || ''}]`;
    },
  });
  const row = { kind: 'batch', primary_message_id: 'qb_msg', payload: { content: '', question_batch: { batch_id: 'qb_1', questions: [] } } };
  const out = renderer.buildRowBodyMarkup(row);
  assert.equal(out, 'BATCH[batch_id=qb_1]');
  assert.equal(seen, row, 'the full row (with payload.question_batch) is threaded to the builder');
  assert.equal(renderer.buildBatchRowMarkup(row), out, 'registry == the dedicated batch builder');
});

test('interactive panel markup builder: live variant emits the editable panel with data-interactive-* affordances', () => {
  const { buildInteractivePanelMarkup } = require('../renderer/features/renderer-interactive-panel-utils');
  const batch = {
    batch_id: 'qb_live',
    intro_text: 'A couple quick questions',
    questions: [{ id: 'q1', prompt: 'Pick A or B?' }],
  };
  const draft = { selections: {}, customTextByQuestionId: {}, customModeByQuestionId: {}, activeQuestionIndex: 0 };
  const markup = buildInteractivePanelMarkup(batch, draft, {
    disabled: false,
    escapeHtml,
    getInteractiveQuestionOptions: () => [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    isInteractiveQuestionAnswered: () => false,
    areInteractiveQuestionsAnswered: () => false,
    isInteractiveOtherTrigger: () => false,
  });
  assert.match(markup, /data-interactive-batch-id="qb_live"/);
  assert.match(markup, /data-interactive-option="true"/);
  assert.match(markup, /data-interactive-submit="true"/);
  assert.match(markup, /Pick A or B\?/);
  assert.match(markup, /class="ask-card"/);
  assert.match(markup, /Jenny asks/);
});

test('interactive panel markup builder: inert summary has no interactive affordances', () => {
  const { buildInertInteractiveBatchSummaryMarkup } = require('../renderer/features/renderer-interactive-panel-utils');
  const batch = { batch_id: 'qb_old', intro_text: 'Asked earlier', questions: [{ id: 'q1', prompt: 'Old question?' }] };
  const markup = buildInertInteractiveBatchSummaryMarkup(batch, escapeHtml);
  assert.match(markup, /ask-card-inert/);
  assert.match(markup, /data-interactive-inert="true"/);
  assert.match(markup, /Old question\?/);
  assert.doesNotMatch(markup, /data-interactive-option/);
  assert.doesNotMatch(markup, /data-interactive-submit/);
});

test('dispatch registry: an unknown kind falls through to the generic builder (default preserved)', () => {
  const renderer = createRenderer();
  assert.equal(typeof renderer.ROW_BUILDERS.totally_unknown_kind, 'undefined');
  const out = renderer.buildRowBodyMarkup({ kind: 'totally_unknown_kind', primary_message_id: 'u', payload: {} });
  assert.equal(typeof out, 'string', 'unknown kind degrades to a string (generic fallback), not a throw');
});
