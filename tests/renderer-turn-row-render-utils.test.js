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

function createRenderer(overrides = {}) {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown(text) {
      return `<p>${escapeHtml(text)}</p>`;
    },
    renderStreamingMarkdownUnits(text) {
      return {
        html: `<p>${escapeHtml(text)}</p>`,
        units: [{
          html: `<span>${escapeHtml(text)}</span>`,
          revealed: true,
          tail: true,
        }],
        changedStartIndex: 0,
      };
    },
    renderThinkingWidget(message, latestAssistantMessageId) {
      return `
        <div
          class="reasoning-test"
          data-message-id="${escapeHtml(message.id)}"
          data-latest-assistant-message-id="${escapeHtml(latestAssistantMessageId)}"
          data-thinking-id="${escapeHtml(message.reasoning_phases?.[0]?.thinkingId || '')}"
        >
          ${escapeHtml(message.reasoning?.entries?.map((entry) => entry.text).join('|') || '')}
        </div>
      `;
    },
    renderToolCallBlock(message, _messages, options) {
      const generatedArtifacts = Array.isArray(options?.projectedToolRow?.payload?.generated_artifacts)
        ? options.projectedToolRow.payload.generated_artifacts
        : [];
      const artifactMarkup = generatedArtifacts.map((artifact) => `
        <div class="inv-artifact-card" data-artifact-id="${escapeHtml(artifact.artifact_id || '')}">
          <button data-inv-artifact-action="studio" data-artifact-id="${escapeHtml(artifact.artifact_id || '')}">Studio</button>
        </div>
      `).join('');
      return `
        <div
          class="tool-test"
          data-message-id="${escapeHtml(message.id)}"
          data-call-id="${escapeHtml(options?.projectedToolRow?.payload?.tool_call_id || '')}"
          data-state="${escapeHtml(options?.projectedToolRow?.payload?.state || '')}"
          data-has-message-by-id="${options?.messageById?.get(message.id) ? 'yes' : 'no'}"
        >${artifactMarkup}</div>
      `;
    },
    renderAgentStatusWidget(message) {
      return `<div class="agent-status-test">${escapeHtml(message.agent_status?.summary || '')}</div>`;
    },
    renderAssistantFailureNotice: overrides.renderAssistantFailureNotice || function renderAssistantFailureNotice(message) {
      return `<div class="assistant-error-test">${escapeHtml(message.stream_error || '')}</div>`;
    },
    renderContextCompactedNotice(message) {
      const compacted = message.context_compacted || {};
      return `<div class="context-compacted-test">${escapeHtml(`${compacted.tokensBefore || 0}->${compacted.tokensAfter || 0}|${message.context_compactions.length}`)}</div>`;
    },
    ...overrides,
  });
}

test('turn row renderer builds assistant text rows with stable ids and source attributes', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:assistant',
    turn_id: 'turn_1',
    kind: 'assistant_text',
    primary_message_id: 'assistant_seg0',
    payload: {
      text: 'Hello row world',
      segment_group_index: 0,
    },
  };

  const html = renderer.buildTurnRowListMarkup([row], [
    { id: 'assistant_seg0', role: 'assistant', content: 'Hello row world' },
  ]);

  assert.match(html, /data-row-id="turn_1:assistant_text:0"/);
  assert.match(html, /data-row-kind="assistant_text"/);
  assert.match(html, /data-source-message-id="assistant_seg0"/);
  assert.match(html, /<p>Hello row world<\/p>/);
});

test('reasoning row ids honor stamped row_id when deterministic row ids are enabled', () => {
  const enabledRenderer = createRenderer({
    getFeatureFlags: () => ({ chat_timeline_deterministic_row_id: true }),
  });
  const disabledRenderer = createRenderer({
    getFeatureFlags: () => ({ chat_timeline_deterministic_row_id: false }),
  });
  const row = {
    row_id: 'row:reasoning:turn_1:thinking_shared',
    turn_id: 'turn_1',
    kind: 'reasoning',
    phase_id: 'live_phase',
    payload: {
      phase_id: 'hydrated_phase',
      thinking_id: 'thinking_shared',
    },
  };

  assert.equal(
    enabledRenderer.buildRowId(row),
    'turn_1:reasoning:row:reasoning:turn_1:thinking_shared'
  );
  assert.equal(
    disabledRenderer.buildRowId(row),
    'turn_1:reasoning:hydrated_phase',
    'flag-off keeps the legacy phase_id-derived DOM key'
  );
});

test('streaming assistant text rows carry ARIA live-region attributes for screen readers (E1)', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:assistant-stream',
    turn_id: 'turn_stream',
    kind: 'assistant_text',
    primary_message_id: 'assistant_streaming',
    payload: {
      text: 'streaming token',
      segment_group_index: 0,
    },
  };

  const html = renderer.buildTurnRowListMarkup(
    [row],
    [{ id: 'assistant_streaming', role: 'assistant', content: 'streaming token' }],
    { isStreaming: true }
  );

  assert.match(html, /chat-bubble-streaming/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="false"/);
  assert.match(html, /aria-label="Assistant response \(streaming\)"/);
});

test('non-streaming assistant text rows do NOT carry live-region attributes (E1)', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:assistant-static',
    turn_id: 'turn_static',
    kind: 'assistant_text',
    primary_message_id: 'assistant_static',
    payload: {
      text: 'final answer',
      segment_group_index: 0,
    },
  };

  const html = renderer.buildTurnRowListMarkup(
    [row],
    [{ id: 'assistant_static', role: 'assistant', content: 'final answer' }],
    { isStreaming: false }
  );

  assert.doesNotMatch(html, /chat-bubble-streaming/);
  assert.doesNotMatch(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /aria-label="Assistant response \(streaming\)"/);
});

test('turn row renderer builds reasoning rows from the projected phase payload', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:reasoning',
    turn_id: 'turn_2',
    kind: 'reasoning',
    primary_message_id: 'assistant_reasoning',
    payload: {
      phase_id: 'phase_pre',
      thinking_id: 'think_pre',
      entries: [{ text: 'Plan first' }],
    },
  };

  const html = renderer.buildTurnRowListMarkup([row], [
    { id: 'assistant_reasoning', role: 'assistant', status: 'complete' },
  ]);

  assert.match(html, /data-row-id="turn_2:reasoning:phase_pre"/);
  assert.match(html, /class="reasoning-test"/);
  assert.match(html, /data-message-id="assistant_reasoning"/);
  assert.match(html, /data-thinking-id="think_pre"/);
  assert.match(html, /Plan first/);
});

test('turn row renderer keeps orphan carry notices as compact markers', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([
    {
      row_id: 'row:orphan-carry',
      turn_id: 'turn_orphan',
      kind: 'system_notice',
      primary_message_id: '',
      payload: { subkind: 'orphan_carry', orphan_count: 2 },
    },
  ], []);

  assert.match(html, /class="system-notice-orphan-carry"/);
  assert.match(html, /data-orphan-count="2"/);
  assert.match(html, /2 orphaned tool calls were carried into a clean turn\./);
});

test('turn row renderer normalizes mixed snake_case reasoning phase metadata before delegating to the thinking widget', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:reasoning-mixed',
    turn_id: 'turn_2b',
    kind: 'reasoning',
    primary_message_id: 'assistant_reasoning_mixed',
    payload: {
      phase_id: 'phase_mixed',
      thinking_id: 'think_mixed',
      entries: [{ text: 'Mixed phase shape' }],
    },
  };

  const html = renderer.buildTurnRowListMarkup([row], [
    {
      id: 'assistant_reasoning_mixed',
      role: 'assistant',
      status: 'complete',
      reasoning_phases: [{
        phase_kind: 'reasoning',
        phase_id: 'phase_mixed',
        thinking_id: 'think_mixed',
        render_collapsed: true,
      }],
    },
  ]);

  assert.match(html, /data-thinking-id="think_mixed"/);
  assert.match(html, /Mixed phase shape/);
});

test('turn row renderer preserves tool step state and tool call identity across canonical row wrappers', () => {
  const renderer = createRenderer();
  const states = ['interrupted', 'awaiting_approval', 'completed', 'errored'];

  for (const state of states) {
    const row = {
      row_id: `row:${state}`,
      turn_id: 'turn_3',
      kind: 'tool_step',
      primary_message_id: `tool_use_${state}`,
      tool_call_id: `call_${state}`,
      payload: {
        tool_call_id: `call_${state}`,
        tool_name: 'Read',
        state,
      },
    };
    const html = renderer.buildTurnRowListMarkup([row], [
      {
        id: `tool_use_${state}`,
        role: 'assistant',
        kind: 'tool_use',
        tool_call: { call_id: `call_${state}`, tool_name: 'Read' },
      },
    ]);

    assert.match(html, new RegExp(`data-row-id="turn_3:tool_step:call_${state}"`));
    assert.match(html, new RegExp(`data-tool-call-id="call_${state}"`));
    assert.match(html, new RegExp(`data-row-state="${state}"`));
    assert.match(html, new RegExp(`data-state="${state}"`));
  }
});

test('turn row renderer preserves inline artifact action markup inside projected tool rows', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([{
    row_id: 'row:artifact',
    turn_id: 'turn_artifact',
    kind: 'tool_step',
    primary_message_id: 'tool_use_artifact',
    tool_call_id: 'call_artifact',
    payload: {
      tool_call_id: 'call_artifact',
      tool_name: 'CreateArtifact',
      state: 'completed',
      generated_artifacts: [{
        artifact_id: 'artifact_plan',
        title: 'Plan',
      }],
    },
  }], []);

  assert.match(html, /inv-artifact-card/);
  assert.match(html, /data-inv-artifact-action="studio"/);
  assert.match(html, /data-artifact-id="artifact_plan"/);
});

test('turn row renderer routes system notice subkinds through the existing notice renderers and fallback copy', () => {
  const renderer = createRenderer();
  const rows = [
    {
      row_id: 'row:agent',
      turn_id: 'turn_4',
      kind: 'system_notice',
      primary_message_id: 'assistant_agent',
      payload: {
        subkind: 'agent_status',
        agent_status: { summary: 'Working through the task' },
      },
    },
    {
      row_id: 'row:context',
      turn_id: 'turn_4',
      kind: 'system_notice',
      primary_message_id: 'assistant_context',
      payload: {
        subkind: 'context_compacted',
        context_compacted: { tokensBefore: 1200, tokensAfter: 400 },
      },
    },
    {
      row_id: 'row:error',
      turn_id: 'turn_4',
      kind: 'system_notice',
      primary_message_id: 'assistant_error',
      payload: {
        subkind: 'assistant_error',
        stream_error: 'Stream failed hard',
      },
    },
    {
      row_id: 'row:unknown',
      turn_id: 'turn_4',
      kind: 'system_notice',
      primary_message_id: 'assistant_unknown',
      payload: {
        subkind: 'unknown_kind',
        unknown_kind: 'custom_notice',
      },
    },
  ];

  const html = renderer.buildTurnRowListMarkup(rows, [{ id: 'assistant_context', context_compactions: [{}, {}] }]);

  assert.match(html, /agent-status-test/);
  assert.match(html, /Working through the task/);
  assert.match(html, /context-compacted-test/);
  assert.match(html, /1200-&gt;400\|2/);
  assert.match(html, /assistant-error-test/);
  assert.match(html, /Stream failed hard/);
  assert.match(html, /chat-system-notice/);
  assert.match(html, /custom_notice/);
});

test('turn row renderer wraps assistant error recovery UI with chat error row metadata', () => {
  let renderedMessage = null;
  const renderer = createRenderer({
    renderAssistantFailureNotice(message) {
      renderedMessage = message;
      const recoveryActions = Array.isArray(message.recovery_actions)
        ? message.recovery_actions.map((entry) => entry.id).join(',')
        : '';
      return `
        <div
          class="inv-error-recovery"
          data-next-action="${escapeHtml(message.next_action || '')}"
          data-recovery-actions="${escapeHtml(recoveryActions)}"
        >${escapeHtml(message.recovery_hint || '')}</div>
      `;
    },
  });
  const rows = [{
    row_id: 'row:error-recovery',
    turn_id: 'turn_error_recovery',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_recovery',
    payload: {
      subkind: 'assistant_error',
      stream_error: 'Sidecar exited unexpectedly',
      error_code: 'CMP-SIDECAR-0003',
      next_action: 'retry_turn',
      recovery_hint: 'Restart the local sidecar, then retry this turn.',
      recovery_actions: [
        { id: 'retry_turn', label: 'Retry turn' },
        { id: 'restart_sidecar', label: 'Restart sidecar', unsafe: '<script>alert(1)</script>' },
        { id: '', label: 'Missing id' },
        { id: { unsafe: 'object id' }, label: 'Unsafe id' },
      ],
    },
  }];

  const html = renderer.buildTurnRowListMarkup(rows, []);

  assert.match(html, /chat-error-row/);
  assert.match(html, /data-error-code="CMP-SIDECAR-0003"/);
  assert.match(html, /inv-error-recovery/);
  assert.match(html, /data-next-action="retry_turn"/);
  assert.match(html, /data-recovery-actions="retry_turn,restart_sidecar"/);
  assert.deepEqual(renderedMessage.recovery_actions, [
    { id: 'retry_turn', label: 'Retry turn' },
    { id: 'restart_sidecar', label: 'Restart sidecar' },
  ]);
});

test('turn row renderer builds decomposable canonical row ids for key row kinds', () => {
  const renderer = createRenderer();

  assert.equal(
    renderer.buildRowId({
      row_id: 'row:any',
      turn_id: 'turn_5',
      kind: 'assistant_text',
      payload: { segment_group_index: 7 },
    }),
    'turn_5:assistant_text:7'
  );
  assert.equal(
    renderer.buildRowId({
      row_id: 'row:any',
      turn_id: 'turn_5',
      kind: 'reasoning',
      payload: { phase_id: 'phase_7' },
    }),
    'turn_5:reasoning:phase_7'
  );
  assert.equal(
    renderer.buildRowId({
      row_id: 'row:any',
      turn_id: 'turn_5',
      kind: 'tool_step',
      payload: { tool_call_id: 'call_7' },
    }),
    'turn_5:tool_step:call_7'
  );
  assert.equal(
    renderer.buildRowId({
      row_id: 'row:any',
      turn_id: 'turn_5',
      kind: 'tool_call',
      payload: { tool_call_id: 'call_7' },
    }),
    'turn_5:tool_call:call_7'
  );
  assert.equal(
    renderer.buildRowId({
      row_id: 'row:any',
      turn_id: 'turn_5',
      kind: 'tool_result',
      payload: { tool_call_id: 'call_7' },
    }),
    'turn_5:tool_result:call_7'
  );
  assert.equal(
    renderer.buildRowId({
      row_id: 'row:any',
      turn_id: 'turn_5',
      kind: 'approval_gap',
      payload: { tool_call_id: 'call_7' },
    }),
    'turn_5:approval_gap:call_7'
  );
  assert.equal(
    renderer.buildRowId({
      row_id: 'row:any',
      turn_id: 'turn_5',
      kind: 'system_notice',
      payload: {},
    }),
    'turn_5:system_notice:row:any'
  );
});

test('turn row renderer skips empty row wrappers when a row body has no renderable content', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([
    {
      row_id: 'row:empty',
      turn_id: 'turn_6',
      kind: 'assistant_text',
      primary_message_id: 'assistant_empty',
      payload: { text: '   ', segment_group_index: 0 },
    },
  ], []);

  assert.match(html, /data-turn-row-list="true"/);
  assert.doesNotMatch(html, /class="chat-row"/);
});

test('turn row renderer formats trace tool rows with details, copy action, artifacts, and approval controls', () => {
  const renderer = createRenderer();
  const toolCallHtml = renderer.buildTurnRowListMarkup([{
    row_id: 'row:tool-call',
    turn_id: 'turn_trace',
    kind: 'tool_call',
    primary_message_id: 'tool_use_trace',
    tool_call_id: 'call_trace',
    payload: {
      tool_call_id: 'call_trace',
      tool_name: 'Read',
      input: 'README.md',
      input_summary: 'README.md',
      state: 'running',
    },
  }], []);
  const completedToolCallHtml = renderer.buildTurnRowListMarkup([{
    row_id: 'row:tool-call-completed',
    turn_id: 'turn_trace',
    kind: 'tool_call',
    primary_message_id: 'tool_use_trace',
    tool_call_id: 'call_trace',
    payload: {
      tool_call_id: 'call_trace',
      tool_name: 'Read',
      input: 'README.md',
      input_summary: 'README.md',
      state: 'completed',
    },
  }], []);
  const toolResultHtml = renderer.buildTurnRowListMarkup([{
    row_id: 'row:tool-result',
    turn_id: 'turn_trace',
    kind: 'tool_result',
    primary_message_id: 'tool_use_trace',
    tool_call_id: 'call_trace',
    payload: {
      tool_call_id: 'call_trace',
      tool_name: 'Read',
      output_text: 'contents',
      result_summary: 'Read complete',
      duration_ms: 2150,
      state: 'completed',
      generated_artifacts: [{
        artifact_id: 'artifact_trace',
        title: 'notes.txt',
      }],
    },
  }], []);
  const approvalHtml = renderer.buildTurnRowListMarkup([{
    row_id: 'row:approval',
    turn_id: 'turn_trace',
    kind: 'approval_gap',
    primary_message_id: 'tool_use_trace',
    tool_call_id: 'call_trace',
    payload: {
      tool_call_id: 'call_trace',
      prompt: 'Approve the read?',
      state: 'awaiting_approval',
    },
  }], []);

  assert.match(toolCallHtml, /data-tool-details-materialized="false"/);
  assert.doesNotMatch(toolCallHtml, /<span class="inv-codeblock-language">Input<\/span>/);
  assert.match(toolCallHtml, /aria-busy="true"/);
  assert.match(toolCallHtml, /README\.md/);
  assert.match(completedToolCallHtml, /data-tool-status="completed"/);
  assert.doesNotMatch(completedToolCallHtml, /data-tool-status="running"/);
  assert.doesNotMatch(completedToolCallHtml, /aria-busy="true"/);
  assert.match(toolResultHtml, /aria-label="Copy output"/);
  assert.match(toolResultHtml, /2\.1s/);
  assert.match(toolResultHtml, /inv-artifact-card/);
  assert.match(approvalHtml, /tool-approve-btn/);
  assert.match(approvalHtml, /tool-deny-btn/);
  assert.match(approvalHtml, /Approve the read\?/);
});

test('turn row renderer folds a paired tool_result into one combined tool card', () => {
  const renderer = createRenderer();
  const rows = [
    {
      row_id: 'row:tool-call',
      turn_id: 'turn_combined',
      kind: 'tool_call',
      primary_message_id: 'tool_use_combined',
      tool_call_id: 'call_combined',
      payload: {
        tool_call_id: 'call_combined',
        tool_name: 'Read',
        input: { file_path: 'README.md' },
        input_summary: 'README.md',
        state: 'running',
      },
    },
    {
      row_id: 'row:tool-result',
      turn_id: 'turn_combined',
      kind: 'tool_result',
      primary_message_id: 'tool_use_combined',
      tool_call_id: 'call_combined',
      payload: {
        tool_call_id: 'call_combined',
        tool_name: 'Read',
        output_text: 'contents',
        result_summary: 'Read complete',
        duration_ms: 2150,
        state: 'completed',
        generated_artifacts: [{ artifact_id: 'artifact_combined', title: 'notes.txt' }],
      },
    },
  ];

  const html = renderer.buildTurnRowListMarkup(rows, [], { forceMaterializeToolDetails: true });

  // One card: the call row carries the result, no standalone result row.
  const callRowCount = (html.match(/class="tool-call-row tool-call-row--minimal"/g) || []).length;
  assert.equal(callRowCount, 1);
  assert.doesNotMatch(html, /class="tool-result-row"/);
  assert.doesNotMatch(html, /data-row-kind="tool_result"/);
  // Result state wins over the call's stale 'running' state.
  assert.match(html, /data-tool-status="completed"/);
  assert.doesNotMatch(html, /aria-busy="true"/);
  // Duration + an accessible copy action on the output region.
  assert.match(html, /2\.1s/);
  assert.match(html, /aria-label="Copy output"/);
  // Result body: flat Output detail section + artifact teaser.
  assert.match(html, /data-tool-detail-body="true"/);
  assert.match(html, /<div class="tool-call-section-kicker">Output<\/div>/);
  assert.match(html, /<pre class="tool-call-output">/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /inv-artifact-card/);
  // The Input detail section stays on the combined card.
  assert.match(html, /<div class="tool-call-section-kicker">Input<\/div>/);
});

test('turn row renderer keeps orphan tool_result rows standalone', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([
    {
      row_id: 'row:tool-call',
      turn_id: 'turn_orphan_result',
      kind: 'tool_call',
      primary_message_id: 'tool_use_a',
      tool_call_id: 'call_a',
      payload: { tool_call_id: 'call_a', tool_name: 'Read', state: 'completed' },
    },
    {
      row_id: 'row:tool-result-orphan',
      turn_id: 'turn_orphan_result',
      kind: 'tool_result',
      primary_message_id: 'tool_use_b',
      tool_call_id: 'call_b',
      payload: {
        tool_call_id: 'call_b',
        tool_name: 'Write',
        output_text: 'done',
        result_summary: 'Write complete',
        state: 'completed',
      },
    },
  ], []);

  // Different call ids: no pairing, the orphan result keeps its own row.
  assert.match(html, /class="tool-result-row" data-tool-call-id="call_b"/);
  assert.match(html, /data-row-kind="tool_result"/);
  assert.doesNotMatch(html, /data-has-result="true"/);
});

test('turn row renderer exposes timeline v2 summaries as row metadata only', () => {
  const renderer = createRenderer();
  const rows = [
    {
      row_id: 'row:reasoning',
      turn_id: 'turn_trace',
      kind: 'reasoning',
      primary_message_id: 'assistant_reasoning',
      payload: {
        phase_id: 'phase_trace',
        phase_kind: 'tool_use',
        summary: 'Inspecting the tool response',
        completed: true,
        entries: [{ text: 'Trace the result.' }],
      },
    },
    {
      row_id: 'row:tool-call',
      turn_id: 'turn_trace',
      kind: 'tool_call',
      primary_message_id: 'tool_use_trace',
      tool_call_id: 'call_trace',
      payload: {
        tool_call_id: 'call_trace',
        tool_name: 'Read',
        input_summary: 'README.md',
        state: 'running',
      },
    },
    {
      row_id: 'row:tool-result',
      turn_id: 'turn_trace',
      kind: 'tool_result',
      primary_message_id: 'tool_use_trace',
      tool_call_id: 'call_trace',
      payload: {
        tool_call_id: 'call_trace',
        tool_name: 'Read',
        result_summary: 'Read complete',
        state: 'completed',
      },
    },
    {
      row_id: 'row:approval',
      turn_id: 'turn_trace',
      kind: 'approval_gap',
      primary_message_id: 'tool_use_trace',
      tool_call_id: 'call_trace',
      payload: {
        tool_call_id: 'call_trace',
        tool_name: 'Read',
        prompt: 'Approve the read?',
        state: 'awaiting_approval',
      },
    },
  ];

  const html = renderer.buildTurnRowListMarkup(rows, [
    { id: 'assistant_reasoning', role: 'assistant', status: 'complete' },
  ]);

  assert.match(html, /data-row-kind="reasoning"/);
  assert.match(html, /data-row-kind="tool_call"/);
  // The paired tool_result row folds into the tool_call card (one tool call =
  // one timeline row), so no standalone tool_result row wrapper is emitted.
  assert.doesNotMatch(html, /data-row-kind="tool_result"/);
  assert.match(html, /data-has-result="true"/);
  assert.match(html, /data-row-kind="approval_gap"/);
  assert.doesNotMatch(html, /class="chat-row-v2-summary"/);
  assert.match(html, /data-chat-row-v2-summary-kind="reasoning"/);
  assert.match(html, /data-chat-row-v2-summary-text="Inspecting the tool response"/);
  assert.match(html, /data-chat-row-v2-summary-text="README\.md"/);
});

test('turn row renderer caps timeline v2 summary metadata from custom presentation helpers', () => {
  const longSummary = Array.from({ length: 40 }, (_, index) => `summary${index}`).join(' ');
  const renderer = createRenderer({
    timelineV2Presentation: {
      buildTimelineV2Presentation() {
        return {
          kind: 'reasoning',
          summary: longSummary,
          attrs: { rowKind: 'reasoning', tone: 'neutral', state: '', targetKind: 'phase' },
        };
      },
    },
  });

  const html = renderer.buildTurnRowListMarkup([{
    row_id: 'row:long-summary',
    turn_id: 'turn_trace',
    kind: 'reasoning',
    primary_message_id: 'assistant_reasoning',
    payload: {
      phase_id: 'phase_trace',
      summary: longSummary,
      entries: [{ text: 'Trace the result.' }],
    },
  }], [
    { id: 'assistant_reasoning', role: 'assistant', status: 'complete' },
  ]);

  const summaryMatch = html.match(/data-chat-row-v2-summary-text="([^"]+)"/);
  assert.ok(summaryMatch, 'summary metadata attribute is present');
  assert.ok(summaryMatch[1].length <= 160, 'summary metadata is capped');
  assert.match(summaryMatch[1], /\.\.\.$/);
});

test('turn row renderer hides trace result copy affordance when there is no copyable output text', () => {
  const renderer = createRenderer();
  const toolResultHtml = renderer.buildTurnRowListMarkup([{
    row_id: 'row:tool-result-empty',
    turn_id: 'turn_trace',
    kind: 'tool_result',
    primary_message_id: 'tool_use_trace',
    tool_call_id: 'call_trace',
    payload: {
      tool_call_id: 'call_trace',
      tool_name: 'Read',
      output_text: '',
      result_summary: 'No output',
      state: 'completed',
    },
  }], []);

  assert.doesNotMatch(toolResultHtml, /data-action="copy-result"/);
});

test('turn row renderer exposes duration formatting for trace tool results', () => {
  const renderer = createRenderer();
  assert.equal(renderer.formatDurationMs(0), '');
  assert.equal(renderer.formatDurationMs(999), '999ms');
  assert.equal(renderer.formatDurationMs(2150), '2.1s');
});

// Multi-turn canonical/live dedup is owned by
// renderer-render-message-index-utils.js (see
// renderer-render-message-index-utils.test.js). buildTurnRowListMarkup now
// trusts its input contract and renders every row it receives, so these two
// tests assert the trust-the-input invariant: any dedup must happen
// upstream.
test('turn row renderer renders every assistant_text row it receives (no render-time dedup)', () => {
  const renderer = createRenderer();
  const firstRow = {
    row_id: 'row:assistant_a',
    turn_id: 'turn_a',
    kind: 'assistant_text',
    primary_message_id: 'assistant_a',
    payload: {
      text: 'Body A',
      segment_group_index: 0,
    },
  };
  const secondRow = {
    row_id: 'row:assistant_b',
    turn_id: 'turn_b',
    kind: 'assistant_text',
    primary_message_id: 'assistant_b',
    payload: {
      text: 'Body B',
      segment_group_index: 0,
    },
  };

  const html = renderer.buildTurnRowListMarkup([firstRow, secondRow], [
    { id: 'assistant_a', role: 'assistant', content: 'Body A', status: 'complete' },
    { id: 'assistant_b', role: 'assistant', content: 'Body B', status: 'complete' },
  ]);

  assert.match(html, /Body A/);
  assert.match(html, /Body B/);
  const rowMatches = html.match(/data-row-kind="assistant_text"/g) || [];
  assert.equal(rowMatches.length, 2);
});

test('turn row renderer renders every reasoning row it receives (no render-time dedup)', () => {
  const renderer = createRenderer();
  const reasoningOne = {
    row_id: 'row:reasoning_one',
    turn_id: 'turn_a',
    kind: 'reasoning',
    primary_message_id: 'assistant_reason_a',
    phase_id: 'phase_a',
    payload: {
      phase_id: 'phase_a',
      thinking_id: 'think_a',
      entries: [{ text: 'Reasoning A' }],
    },
  };
  const reasoningTwo = {
    row_id: 'row:reasoning_two',
    turn_id: 'turn_b',
    kind: 'reasoning',
    primary_message_id: 'assistant_reason_b',
    phase_id: 'phase_b',
    payload: {
      phase_id: 'phase_b',
      thinking_id: 'think_b',
      entries: [{ text: 'Reasoning B' }],
    },
  };

  const html = renderer.buildTurnRowListMarkup([reasoningOne, reasoningTwo], [
    { id: 'assistant_reason_a', role: 'assistant', status: 'complete' },
    { id: 'assistant_reason_b', role: 'assistant', status: 'complete' },
  ]);

  assert.match(html, /Reasoning A/);
  assert.match(html, /Reasoning B/);
  const rowMatches = html.match(/data-row-kind="reasoning"/g) || [];
  assert.equal(rowMatches.length, 2);
});

test('turn row renderer keeps multi-phase reasoning rows distinct (different phase_ids do not get deduped)', () => {
  const renderer = createRenderer();
  const phaseOneRow = {
    row_id: 'row:reasoning_phase_one',
    turn_id: 'turn_multi',
    kind: 'reasoning',
    primary_message_id: 'assistant_multi_phase',
    phase_id: 'phase_one',
    payload: {
      phase_id: 'phase_one',
      thinking_id: 'think_one',
      entries: [{ text: 'Step one body' }],
    },
  };
  const phaseTwoRow = {
    row_id: 'row:reasoning_phase_two',
    turn_id: 'turn_multi',
    kind: 'reasoning',
    primary_message_id: 'assistant_multi_phase',
    phase_id: 'phase_two',
    payload: {
      phase_id: 'phase_two',
      thinking_id: 'think_two',
      entries: [{ text: 'Step two body' }],
    },
  };

  const html = renderer.buildTurnRowListMarkup([phaseOneRow, phaseTwoRow], [
    { id: 'assistant_multi_phase', role: 'assistant', status: 'complete' },
  ]);

  assert.match(html, /Step one body/);
  assert.match(html, /Step two body/);
  const rowMatches = html.match(/data-row-kind="reasoning"/g) || [];
  assert.equal(rowMatches.length, 2);
});

test('legacy plan_object row routes through the collapsed inert plan receipt', () => {
  const renderer = createRenderer();
  const planRow = {
    row_id: 'row:turn_plan:plan_object:plan_abc123',
    turn_id: 'turn_plan',
    kind: 'plan_object',
    primary_message_id: '',
    render_message_id: '',
    source_message_ids: [],
    source_events: ['turn_plan:plan_object:plan_abc123'],
    payload: {
      plan_id: 'plan_abc123',
      agent_id: 'main@req_plan',
      parent_agent_id: '',
      status: 'completed',
      summary: 'Plan summary line.',
      steps: [
        { index: 0, summary: 'Investigate workspace', status: 'pending' },
      ],
      verification: {
        verdict: 'PASS',
        raw_line: 'VERDICT: PASS',
        agent_id: 'verification@req_plan',
      },
      finalized_at: '2026-05-08T10:00:00Z',
    },
  };

  const html = renderer.buildTurnRowListMarkup([planRow], []);

  assert.match(html, /data-row-kind="plan_object"/);
  assert.match(html, /plan-document-receipt/);
  assert.match(html, /^<div[\s\S]*<details/);
  assert.doesNotMatch(html, /data-plan-actions/);
});

test('the turn row list renders one flat mode: no coalescing wrappers regardless of options', () => {
  // The explorer-minimal preset and the response_loop_display_v2 grouped-step
  // <details> were retired 2026-07-05 (quiet-timeline overhaul): every
  // machinery row renders as its own flat .chat-row one-liner. A stale
  // timelineStyleId (e.g. persisted 'explorer-minimal') must not change that.
  const renderer = createRenderer();
  const rows = [
    {
      row_id: 'row:1',
      turn_id: 'turn_1',
      kind: 'reasoning',
      payload: { phase_id: 'phase_1', entries: [{ text: 'thinking' }] }
    },
    {
      row_id: 'row:2',
      turn_id: 'turn_1',
      kind: 'tool_call',
      payload: { tool_call_id: 'call_1', tool_name: 'read_file' }
    },
    {
      row_id: 'row:3',
      turn_id: 'turn_1',
      kind: 'tool_result',
      payload: { duration_ms: 1500, tool_name: 'read_file' }
    },
    {
      row_id: 'row:4',
      turn_id: 'turn_1',
      kind: 'assistant_text',
      payload: { text: 'Done' }
    }
  ];

  for (const options of [
    { timelineStyleId: 'default' },
    { timelineStyleId: 'explorer-minimal' },
    { responseLoopDisplayV2: true, turnActivityEnvelope: true },
  ]) {
    const html = renderer.buildTurnRowListMarkup(rows, [], options);
    assert.doesNotMatch(html, /<details/, `no coalescing <details> for ${JSON.stringify(options)}`);
    assert.doesNotMatch(html, /timeline-explorer|chat-turn-step|chat-turn-activity/);
    assert.match(html, /data-row-kind="reasoning"/);
    // tool_call + tool_result pair into ONE card row; the flat list keeps that.
    assert.match(html, /data-row-kind="tool_call"/);
    assert.match(html, /data-row-kind="assistant_text"/);
  }
});
