const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTurnRowToolRenderUtils,
  getToolStatusLabel,
  setToolRowExpansion,
  getToolRowExpansion,
  clearToolRowExpansionOverrides,
} = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { renderApprovalBlock } = require('../renderer/chat/renderer-approval-block');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { projectPersistedEventsWithReducer } = require('../renderer/chat/renderer-stream-rehydrate');
const { projectRows } = require('./helpers/renderer-turn-row-projector-helpers');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createToolRenderer(overrides = {}) {
  return createTurnRowToolRenderUtils({
    escapeHtml,
    normalizeId(value) {
      return String(value || '').trim();
    },
    formatDurationMs(ms) {
      const durationMs = Number(ms);
      return Number.isFinite(durationMs) && durationMs > 0 ? `${durationMs}ms` : '';
    },
    renderArtifactTeaser(artifact) {
      return `<span data-artifact-id="${escapeHtml(artifact && artifact.artifact_id)}">Artifact</span>`;
    },
    buildToolMarkerBannerMarkup(payload) {
      return payload && payload.marker ? `<aside data-marker="${escapeHtml(payload.marker)}"></aside>` : '';
    },
    renderApprovalBlock(request) {
      return `
        <div
          data-approval-id="${escapeHtml(request.approvalId)}"
          data-tool-call-id="${escapeHtml(request.toolCallId)}"
          data-mode="${escapeHtml(request.mode)}"
        >${escapeHtml(request.displayToolName)}:${escapeHtml(request.prompt)}</div>
      `;
    },
    ...overrides,
  });
}

function rowKeyFor(row, options = {}) {
  return toolCallUtils.buildToolRowKey({
    sessionId: options.sessionId,
    turnId: row.turn_id,
    rowId: row.row_id,
    messageId: row.primary_message_id,
    callId: row.payload && row.payload.tool_call_id,
  });
}

const MERMAID_SOURCE = 'graph TD\nA --> B';

function buildMermaidResultRow(overrides = {}) {
  return {
    payload: {
      tool_call_id: 'call-pair',
      tool_name: 'mermaid_generate',
      duration_ms: 14,
      result_summary: 'mermaid_generate',
      output_text: JSON.stringify({ mermaid: MERMAID_SOURCE, diagram_type: 'flowchart' }),
      state: 'completed',
      ...overrides,
    },
  };
}

test('turn row tool renderer formats tool status labels', () => {
  assert.equal(getToolStatusLabel('running'), 'Running');
  assert.equal(getToolStatusLabel('awaiting_approval'), 'Awaiting approval');
  assert.equal(getToolStatusLabel('custom_state'), 'custom_state');
});

test('settled-success badge is a11y-only; other states keep a visible word', () => {
  const renderer = createToolRenderer();
  // Quiet grammar parity with the block family: the dot + duration carry the
  // settled-success signal, so the badge word hides from sighted users only.
  const done = renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-done', tool_name: 'read_file', state: 'completed' },
  });
  assert.match(done, /class="tool-call-status-label sr-only">Success</);
  const running = renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-run', tool_name: 'read_file', state: 'running' },
  });
  assert.match(running, /class="tool-call-status-label">Running</);
});

/* ── Minimal one-row tool card ── */

test('tool call rows render as a minimal collapsed toggle row by default', () => {
  const renderer = createToolRenderer();
  const html = renderer.buildToolCallRowMarkup({
    payload: {
      tool_call_id: 'call-min',
      tool_name: 'mermaid_generate',
      state: 'running',
      input: { prompt: 'cars by type', diagram_type: 'flowchart' },
    },
  });

  assert.match(html, /class="tool-call-row tool-call-row--minimal"/);
  assert.match(html, /data-tool-status="running"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /data-expanded="false"/);
  // Single toggle row: shared formatted header anatomy. div[role=button]
  // per the raw-primitive policy; Enter/Space wired in transcript bindings.
  assert.match(html, /class="tool-call-row-toggle"[\s\S]*?role="button"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /data-tool-row-toggle="true"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="tool-row-[^"]+-body"/);
  assert.match(html, /class="tool-call-summary tool-call-row-summary">Mermaid flowchart: cars by type</);
  assert.match(html, /tool-call-status-label/);
  assert.match(html, /tool-call-disclosure/);
  // Collapsed detail DOM is intentionally lightweight; the first expansion
  // materializes the bounded preview from canonical row state.
  assert.match(html, /data-tool-details-materialized="false"/);
  assert.match(html, /class="tool-call-row-body" id="tool-row-[^"]+-body" inert/);
  assert.doesNotMatch(html, /inv-codeblock-language/);
  // The outer block toggle stays absent while both families share the inner anatomy.
  assert.doesNotMatch(html, /tool-call-header/);
  assert.match(html, /tool-call-name/);
});

test('tool call rows escape identifiers and input payloads', () => {
  const renderer = createToolRenderer();
  const html = renderer.buildToolCallRowMarkup({
    payload: {
      tool_call_id: ' call<1 ',
      tool_name: 'Read <File>',
      state: 'running',
      input: { path: 'a<b.txt' },
    },
  });

  assert.match(html, /data-tool-call-id="call&lt;1"/);
  // Unknown tool kind falls back to the input subject (the path), escaped.
  assert.match(html, /class="tool-call-summary tool-call-row-summary">a&lt;b\.txt</);
  assert.match(html, /a&lt;b\.txt/);
  assert.doesNotMatch(html, /<File>/);
});

test('collapsed rows keep one-megabyte inputs out of DOM and bound the expanded preview', () => {
  const renderer = createToolRenderer();
  const row = {
    turn_id: 'turn-large',
    row_id: 'row-large',
    payload: {
      tool_call_id: 'call-large',
      tool_name: 'write_file',
      state: 'completed',
      input: { path: 'large.txt', content: 'x'.repeat(1_000_000) },
    },
  };
  const collapsed = renderer.buildToolCallRowMarkup(row, [], { sessionId: 'session-a' });
  assert.ok(collapsed.length < 10_000, `collapsed markup must stay bounded, got ${collapsed.length}`);
  assert.doesNotMatch(collapsed, /x{100}/);
  assert.doesNotMatch(collapsed, /inv-codeblock-gutter/);

  const expanded = renderer.buildToolCallRowMarkup(row, [], {
    sessionId: 'session-a', forceMaterializeToolDetails: true,
  });
  assert.match(expanded, /tool-call-section-kicker">Input/);
  assert.match(expanded, /class="tool-kv-grid"/);
  assert.match(expanded, /data-detail-capped="true"/);
  assert.match(expanded, /Copy all \(/);
  assert.doesNotMatch(expanded, /data-inv-truncation-marker/);
  assert.match(expanded, /aria-label="Copy input"/);
  assert.ok(expanded.length < 30_000, `expanded preview must stay bounded, got ${expanded.length}`);
});

test('row identity and disclosure controls are isolated from repeated provider call ids', () => {
  const renderer = createToolRenderer();
  const first = renderer.buildToolCallRowMarkup({
    turn_id: 'turn-a', row_id: 'row-a',
    payload: { tool_call_id: 'provider call/1', tool_name: 'read_file', state: 'completed', input: { path: 'README.md' } },
  }, [], { sessionId: 'session-a' });
  const second = renderer.buildToolCallRowMarkup({
    turn_id: 'turn-b', row_id: 'row-b',
    payload: { tool_call_id: 'provider call/1', tool_name: 'read_file', state: 'completed', input: { path: 'README.md' } },
  }, [], { sessionId: 'session-a' });
  const firstId = first.match(/aria-controls="([^"]+)"/)[1];
  const secondId = second.match(/aria-controls="([^"]+)"/)[1];
  assert.notEqual(firstId, secondId);
  assert.doesNotMatch(firstId, /\s/);
  assert.match(first, /class="tool-path-chip"/);
  const toggleStart = first.indexOf('data-tool-row-toggle="true"');
  const toggleEnd = first.indexOf('</div>', toggleStart);
  assert.ok(first.indexOf('class="tool-path-chip"') > toggleEnd, 'path action must remain a disclosure sibling');
  assert.match(first, /data-chat-path-open="README\.md"/);
});

test('only a call still waiting on the user auto-expands; every settled state stays collapsed', () => {
  const renderer = createToolRenderer();
  const byStatus = (state) => renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: `call-${state}`, tool_name: 'run_command', state, input: { command: 'ls' } },
  });

  for (const state of ['awaiting_approval', 'pending_approval']) {
    const html = byStatus(state);
    assert.match(html, /data-expanded="true"/, `${state} must auto-expand`);
    assert.doesNotMatch(html, /class="tool-call-row-body"[^>]*inert/, `${state} body must be visible`);
  }
  // Failures used to open themselves, which reflowed the transcript under the
  // reader mid-turn. They now collapse like any other finished row -- the
  // status label and severity tint carry the signal instead of the open body.
  for (const state of ['errored', 'denied', 'blocked', 'timed_out', 'cancelled', 'interrupted', 'abandoned']) {
    const html = byStatus(state);
    assert.match(html, /data-expanded="false"/, `${state} must stay collapsed`);
    assert.match(html, /class="tool-call-row-body"[^>]*inert/, `${state} body must be collapsed`);
    assert.match(html, /data-tool-severity="/, `${state} must still carry a severity signal`);
  }
  for (const state of ['requested', 'running', 'completed', 'approved']) {
    const html = byStatus(state);
    assert.match(html, /data-expanded="false"/, `${state} must stay collapsed`);
    assert.match(html, /class="tool-call-row-body"[^>]*inert/, `${state} body must be collapsed`);
  }
});

test('user expansion overrides survive re-renders via the module store', (t) => {
  t.after(() => clearToolRowExpansionOverrides());
  const renderer = createToolRenderer();
  const row = {
    payload: { tool_call_id: 'call-override', tool_name: 'run_command', state: 'completed', input: { command: 'ls' } },
  };

  assert.match(renderer.buildToolCallRowMarkup(row), /data-expanded="false"/);

  const rowKey = rowKeyFor(row);
  setToolRowExpansion(rowKey, true);
  assert.equal(getToolRowExpansion(rowKey), true);
  assert.match(renderer.buildToolCallRowMarkup(row), /data-expanded="true"/);

  // An override can also pin an auto-expanding status closed.
  const errRow = {
    payload: { tool_call_id: 'call-err-pin', tool_name: 'run_command', state: 'errored' },
  };
  setToolRowExpansion(rowKeyFor(errRow), false);
  const errHtml = renderer.buildToolCallRowMarkup(errRow);
  assert.match(errHtml, /data-expanded="false"/);
});

test('paired results fold into the call card with terminal status and static Output label', () => {
  const renderer = createToolRenderer();
  const callRow = {
    payload: {
      tool_call_id: 'call-pair',
      tool_name: 'mermaid_generate',
      state: 'running',
      input: { prompt: 'graph TD', diagram_type: 'flowchart' },
    },
  };
  const resultRow = buildMermaidResultRow({
    generated_artifacts: [{ artifact_id: 'art-pair' }],
    marker: 'carried',
  });

  const html = renderer.buildToolCallRowMarkup(callRow, [], { pairedToolResultRow: resultRow, forceMaterializeToolDetails: true });

  // The result's terminal state replaces the call's stale 'running' state.
  assert.match(html, /data-tool-status="completed"/);
  assert.doesNotMatch(html, /aria-busy/);
  assert.match(html, /data-has-result="true"/);
  assert.match(html, /14ms/);
  assert.match(html, /class="inv-codeblock-copy tool-detail-copy"/);
  assert.doesNotMatch(html, /data-action="copy-result"/);
  assert.match(html, /data-marker="carried"/);
  assert.match(html, /class="tool-result-body tool-result-diagram" data-tool-call-id="call-pair"/);
  // Static captions: the payload summary ("mermaid_generate") must not appear
  // as either region caption — that read as two identical stacked rows.
  assert.match(html, /tool-call-section-kicker">Input<\/div>/);
  assert.match(html, /tool-call-section-kicker">Output<\/div>/);
  assert.doesNotMatch(html, /tool-call-section-kicker">mermaid_generate/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /data-artifact-id="art-pair"/);
  // No standalone result row markup leaks into the combined card.
  assert.doesNotMatch(html, /tool-result-row/);
  assert.doesNotMatch(html, /tool-result-header/);
});

test('settled Edit rows render their structured diff in-row and suppress raw output JSON', () => {
  const renderer = createToolRenderer();
  const html = renderer.buildToolCallRowMarkup({
    row_id: 'row-edit',
    payload: { tool_call_id: 'call-edit', tool_name: 'edit_file', state: 'running', input: { path: 'src/a.js' } },
  }, [], {
    sessionId: 'session-edit',
    forceMaterializeToolDetails: true,
    pairedToolResultRow: { payload: {
      tool_call_id: 'call-edit', tool_name: 'edit_file', state: 'completed', output_text: '{"raw":true}',
      metadata: { diff: { diff_id: 'diff:settled', additions: 1, deletions: 0, hunks: [{ oldStart: 3, newStart: 3, lines: ['+new'] }] } },
    } },
  });
  assert.match(html, /data-tool-status="completed"/);
  assert.match(html, /class="file-diff"/);
  assert.match(html, /data-diff-id="diff:settled"/);
  assert.doesNotMatch(html, /&quot;raw&quot;|tool-call-section-kicker">Output/);
});

test('the collapsed header carries the tool\'s own failure line only for genuine failures', () => {
  const renderer = createToolRenderer();
  const build = (resultPayload) => renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-fail-line', tool_name: 'run_command', state: 'running' },
  }, [], { pairedToolResultRow: { payload: { tool_call_id: 'call-fail-line', tool_name: 'run_command', ...resultPayload } } });

  const failed = build({ is_error: true, output_text: '\nnpm ERR! missing script: test\nnpm ERR! more', result_summary: 'exit 1' });
  assert.match(failed, /data-expanded="false"/);
  assert.match(failed, /class="tool-call-failure-summary">npm ERR! missing script: test<\/span>/);
  assert.doesNotMatch(failed, /npm ERR! more/, 'only the first output line, not the body');
  assert.doesNotMatch(failed, /data-tool-detail-section/, 'the body itself stays out of the DOM');

  const denied = build({ is_error: true, error_code: 'CMP-APPROVAL-REJECTED', output_text: 'The user denied this call.' });
  assert.match(denied, /data-tool-status="denied"/);
  assert.doesNotMatch(denied, /tool-call-failure-summary/, 'denied rows already say so in the status word');

  const ok = build({ is_error: false, output_text: 'all good' });
  assert.doesNotMatch(ok, /tool-call-failure-summary/);
});

test('the combined card goes errored but stays collapsed when the paired result failed', () => {
  const renderer = createToolRenderer();
  const build = (extra) => renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-pair-err', tool_name: 'run_command', state: 'running' },
  }, [], {
    pairedToolResultRow: {
      payload: {
        tool_call_id: 'call-pair-err',
        tool_name: 'run_command',
        is_error: true,
        error_code: 'CMP-TOOL-0009',
        result_summary: 'exit 1',
      },
    },
    retryMessageId: 'assistant-latest',
    ...extra,
  });
  const collapsed = build();
  // A collapsed failure keeps its detail out of the DOM until the reader opens
  // it, so the error body is asserted through the expansion a reader performs.
  const html = build({ forceMaterializeToolDetails: true });

  assert.match(collapsed, /data-tool-status="errored"/);
  assert.match(collapsed, /data-expanded="false"/);
  assert.match(collapsed, /data-tool-severity="danger"/);
  assert.doesNotMatch(collapsed, /CMP-TOOL-0009/);
  // R2-12: the failure text itself stays readable (and findable) in the
  // collapsed header, one bounded line, so a red row says why without a click.
  assert.match(collapsed, /class="tool-call-failure-summary">exit 1<\/span>/);
  assert.match(html, /data-tool-status="errored"/);
  assert.match(html, /data-is-error="true"/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, /data-tool-detail-section="true" data-tool-result-outcome="failure"/);
  assert.match(html, /CMP-TOOL-0009/);
  assert.match(html, /data-inv-error-action="retry"/);
  assert.match(html, /Regenerate response/);
  assert.match(html, /data-message-id="assistant-latest"/);
  assert.doesNotMatch(html, /Error CMP-TOOL-0009/);
  // Error content stays in the same flat body — no Output section is duplicated.
  assert.doesNotMatch(html, /tool-call-section-kicker">Output/);
  assert.doesNotMatch(html, /<details/);
});

/* ── Mermaid fallback + answer dedup ── */

test('settled turn with no echoed fence renders the mermaid fallback diagram outside the body', () => {
  const renderer = createToolRenderer();
  const html = renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-fb', tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
  }, [], {
    pairedToolResultRow: buildMermaidResultRow({ tool_call_id: 'call-fb' }),
    turnPhase: 'done',
    turnRows: [
      { kind: 'assistant_text', payload: { text: 'Here is the chart I generated for you.' } },
    ],
  });

  assert.match(html, /class="tool-result-body tool-result-diagram" data-tool-call-id="call-fb"/);
  assert.match(html, /class="markdown-mermaid-block"/);
  assert.match(html, /data-tool-details-materialized="false"/);
  // The diagram sits OUTSIDE the hidden detail body: the body start tag
  // comes after the diagram block in the markup.
  assert.ok(
    html.indexOf('tool-result-diagram') < html.indexOf('tool-call-row-body'),
    'fallback diagram must precede the collapsible body'
  );
});

for (const terminalStatus of ['error', 'cancelled', 'interrupted']) {
  test(`terminal ${terminalStatus} turn renders mermaid without final assistant text`, () => {
    const renderer = createToolRenderer();
    const html = renderer.buildToolCallRowMarkup({
      payload: { tool_call_id: `call-${terminalStatus}`, tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
    }, [], {
      pairedToolResultRow: buildMermaidResultRow({ tool_call_id: `call-${terminalStatus}` }),
      turnPhase: terminalStatus,
      turnRows: [
        { kind: 'tool_call', primary_message_id: `tool-${terminalStatus}`, payload: { tool_call_id: `call-${terminalStatus}` } },
        { kind: 'tool_result', primary_message_id: `tool-${terminalStatus}`, payload: { tool_call_id: `call-${terminalStatus}` } },
        {
          kind: 'system_notice',
          primary_message_id: `terminal-${terminalStatus}`,
          payload: { subkind: 'assistant_error', terminal_status: terminalStatus },
        },
      ],
      pendingStreamMessageIds: [],
    });

    assert.match(html, /class="markdown-mermaid-block"/);
  });
}

test('terminal evidence still suppresses mermaid while its message remains pending', () => {
  const renderer = createToolRenderer();
  const html = renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-terminal-pending', tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
  }, [], {
    pairedToolResultRow: buildMermaidResultRow({ tool_call_id: 'call-terminal-pending' }),
    turnPhase: 'cancelled',
    turnRows: [
      {
        kind: 'system_notice',
        primary_message_id: 'terminal-pending',
        payload: { subkind: 'assistant_error', terminal_status: 'cancelled' },
      },
    ],
    pendingStreamMessageIds: ['terminal-pending'],
  });

  assert.doesNotMatch(html, /markdown-mermaid-block/);
});

test('canonical and rollback projections both render terminal mermaid without assistant text', () => {
  const turnId = 'turn-projection-parity';
  const callId = 'call-projection-parity';
  const events = [
    {
      event_id: 'event-tool-call', turn_id: turnId, kind: 'tool_use', status: 'running',
      primary_message_id: 'tool-projection-parity', source_message_ids: ['tool-projection-parity'],
      tool_call_id: callId,
      payload: { tool_call_id: callId, tool_name: 'mermaid_generate', input: { prompt: 'x' } },
    },
    {
      event_id: 'event-tool-result', turn_id: turnId, kind: 'tool_result', status: 'completed',
      primary_message_id: 'tool-projection-parity', source_message_ids: ['tool-projection-parity'],
      tool_call_id: callId,
      payload: {
        tool_call_id: callId,
        tool_name: 'mermaid_generate',
        output_text: JSON.stringify({ mermaid: MERMAID_SOURCE, diagram_type: 'flowchart' }),
      },
    },
    {
      event_id: 'event-terminal', turn_id: turnId, kind: 'assistant_error', status: 'cancelled',
      primary_message_id: 'assistant-projection-parity', source_message_ids: ['assistant-projection-parity'],
      payload: { subkind: 'assistant_error', terminal_status: 'cancelled' },
    },
  ];
  const projections = [
    ['canonical_renderer_projection=true', projectPersistedEventsWithReducer(events, { turnId, deterministicRowId: true }).rows],
    ['canonical_renderer_projection=false', projectTurnRows(events, { deterministicRowId: true })],
  ];
  const renderer = createToolRenderer();

  for (const [pathLabel, rows] of projections) {
    const callRow = rows.find((row) => row.kind === 'tool_call');
    const resultRow = rows.find((row) => row.kind === 'tool_result');
    assert.ok(callRow, `${pathLabel} must preserve the tool call`);
    assert.ok(resultRow, `${pathLabel} must preserve the tool result`);
    const html = renderer.buildToolCallRowMarkup(callRow, [], {
      pairedToolResultRow: resultRow,
      turnRows: rows,
      forceMaterializeToolDetails: true,
    });
    assert.match(html, /class="markdown-mermaid-block"/, pathLabel);
  }
});

test('mermaid fallback emits the Open-in-panel affordance whenever an artifact id resolves (flag retired in W1-5)', () => {
  const settledOptions = (callId, artifacts) => ({
    pairedToolResultRow: buildMermaidResultRow({
      tool_call_id: callId,
      generated_artifacts: artifacts,
    }),
    forceMaterializeToolDetails: true,
    turnPhase: 'done',
    turnRows: [
      { kind: 'assistant_text', payload: { text: 'Here is the chart.' } },
    ],
  });
  const callRow = (callId) => ({
    payload: { tool_call_id: callId, tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
  });

  // W1-5: workspace_artifact_panel is retired — the affordance is
  // unconditional (default renderer, no flags).
  const renderer = createToolRenderer();
  const onHtml = renderer.buildToolCallRowMarkup(
    callRow('call-aff'), [], settledOptions('call-aff', [{ artifact_id: 'art-mermaid-1', title: 'Chart' }])
  );
  assert.match(onHtml, /data-inv-artifact-action="panel"/);
  assert.match(onHtml, /data-artifact-id="art-mermaid-1"/);
  assert.match(onHtml, /aria-label="Open in panel"/);
  assert.doesNotMatch(onHtml, /data-inv-artifact-action="panel"[^>]*>Open in panel</, 'icon-only control, no visible text');

  // NO resolvable artifact id -> no affordance.
  const noIdHtml = renderer.buildToolCallRowMarkup(
    callRow('call-noid'), [], settledOptions('call-noid', [])
  );
  assert.doesNotMatch(noIdHtml, /data-inv-artifact-action="panel"/);
  assert.match(noIdHtml, /markdown-mermaid-block/, 'diagram itself still renders');
});

test('a whitespace-variant fence echoed in the answer suppresses the tool-card diagram', () => {
  const renderer = createToolRenderer();
  const echoedVariant = '```mermaid\n  graph   TD\n\n  A   -->   B  \n```';
  const html = renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-dedup', tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
  }, [], {
    pairedToolResultRow: buildMermaidResultRow({ tool_call_id: 'call-dedup' }),
    forceMaterializeToolDetails: true,
    turnPhase: 'done',
    turnRows: [
      { kind: 'assistant_text', payload: { text: `The chart:\n\n${echoedVariant}\n\nDone.` } },
    ],
  });

  assert.doesNotMatch(html, /markdown-mermaid-block/);
  assert.doesNotMatch(html, /tool-result-diagram/);
  // The output stays available in the flat detail body.
  assert.match(html, /tool-call-section-kicker">Output<\/div>/);
});

test('a different fence in the answer does not suppress the fallback', () => {
  const renderer = createToolRenderer();
  const html = renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-diff', tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
  }, [], {
    pairedToolResultRow: buildMermaidResultRow({ tool_call_id: 'call-diff' }),
    forceMaterializeToolDetails: true,
    turnPhase: 'done',
    turnRows: [
      { kind: 'assistant_text', payload: { text: '```mermaid\ngraph TD\nA --> C\n```' } },
    ],
  });

  assert.match(html, /class="markdown-mermaid-block"/);
});

test('no diagram renders while the turn is still active (streaming or non-terminal phase)', () => {
  const renderer = createToolRenderer();
  const base = {
    payload: { tool_call_id: 'call-live', tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
  };
  const paired = buildMermaidResultRow({ tool_call_id: 'call-live' });

  const streamingHtml = renderer.buildToolCallRowMarkup(base, [], {
    pairedToolResultRow: paired,
    isStreaming: true,
    forceMaterializeToolDetails: true,
  });
  const activePhaseHtml = renderer.buildToolCallRowMarkup(base, [], {
    pairedToolResultRow: paired,
    turnPhase: 'streaming',
    forceMaterializeToolDetails: true,
  });

  assert.doesNotMatch(streamingHtml, /markdown-mermaid-block/);
  assert.doesNotMatch(activePhaseHtml, /markdown-mermaid-block/);
});

test('no diagram in the gap between model calls: turn rows ending at the tool result block the fallback', () => {
  // The live projected path renders tool articles with no turn phase and
  // isStreaming=false even mid-turn — the rows themselves are the signal.
  const renderer = createToolRenderer();
  const html = renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-gap', tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
  }, [], {
    pairedToolResultRow: buildMermaidResultRow({ tool_call_id: 'call-gap' }),
    forceMaterializeToolDetails: true,
    turnRows: [
      { kind: 'user_bubble', primary_message_id: 'user_1', payload: { text: 'draw it' } },
      { kind: 'assistant_text', primary_message_id: 'asst_pre', payload: { text: 'Let me chart that.' } },
      { kind: 'tool_call', primary_message_id: 'tool_1', payload: { tool_call_id: 'call-gap' } },
      { kind: 'tool_result', primary_message_id: 'tool_1', payload: { tool_call_id: 'call-gap' } },
    ],
  });

  assert.doesNotMatch(html, /markdown-mermaid-block/);
});

test('no diagram while the turn answer is still the session streaming message', () => {
  const renderer = createToolRenderer();
  const turnRows = [
    { kind: 'tool_call', primary_message_id: 'tool_1', payload: { tool_call_id: 'call-ans' } },
    { kind: 'tool_result', primary_message_id: 'tool_1', payload: { tool_call_id: 'call-ans' } },
    { kind: 'assistant_text', primary_message_id: 'asst_final', payload: { text: 'partial answer so far' } },
  ];
  const base = {
    payload: { tool_call_id: 'call-ans', tool_name: 'mermaid_generate', state: 'running', input: { prompt: 'x' } },
  };
  const paired = buildMermaidResultRow({ tool_call_id: 'call-ans' });

  const streamingHtml = renderer.buildToolCallRowMarkup(base, [], {
    pairedToolResultRow: paired,
    turnRows,
    projectionContext: { activeStreamingMessageId: 'asst_final' },
    forceMaterializeToolDetails: true,
  });
  // The live projected path leaves activeStreamingMessageId empty; the
  // stream handler's pending map is the signal there.
  const pendingMapHtml = renderer.buildToolCallRowMarkup(base, [], {
    pairedToolResultRow: paired,
    turnRows,
    projectionContext: { activeStreamingMessageId: '' },
    pendingStreamMessageIds: ['asst_final'],
    forceMaterializeToolDetails: true,
  });
  const settledHtml = renderer.buildToolCallRowMarkup(base, [], {
    pairedToolResultRow: paired,
    turnRows,
    projectionContext: { activeStreamingMessageId: '' },
    pendingStreamMessageIds: [],
    forceMaterializeToolDetails: true,
  });
  const otherTurnStreamingHtml = renderer.buildToolCallRowMarkup(base, [], {
    pairedToolResultRow: paired,
    turnRows,
    projectionContext: { activeStreamingMessageId: 'asst_other_turn' },
    pendingStreamMessageIds: ['asst_other_turn'],
    forceMaterializeToolDetails: true,
  });

  assert.doesNotMatch(streamingHtml, /markdown-mermaid-block/);
  assert.doesNotMatch(pendingMapHtml, /markdown-mermaid-block/);
  assert.match(settledHtml, /markdown-mermaid-block/);
  assert.match(otherTurnStreamingHtml, /markdown-mermaid-block/, 'another turn streaming must not block old turns');
});

test('hydrated/legacy contexts (no turn phase, not streaming) count as settled for the fallback', () => {
  const renderer = createToolRenderer();
  const html = renderer.buildToolCallRowMarkup({
    payload: { tool_call_id: 'call-hyd', tool_name: 'mermaid_generate', state: 'completed', input: { prompt: 'x' } },
  }, [], {
    pairedToolResultRow: buildMermaidResultRow({ tool_call_id: 'call-hyd' }),
    forceMaterializeToolDetails: true,
  });

  assert.match(html, /class="markdown-mermaid-block"/);
});

test('orphan result rows apply the same fallback and dedup rules', () => {
  const renderer = createToolRenderer();
  const orphan = buildMermaidResultRow({ tool_call_id: 'call-orphan' });

  const fallbackHtml = renderer.buildToolResultRowMarkup(orphan, [], { turnPhase: 'done', turnRows: [] });
  assert.match(fallbackHtml, /class="markdown-mermaid-block" id="tool-mermaid-tool-row-/);
  assert.ok(fallbackHtml.includes(`data-mermaid-source="${escapeHtml(MERMAID_SOURCE)}"`));
  assert.match(fallbackHtml, /markdown-mermaid-preview/);
  assert.match(fallbackHtml, /tool-call-section-kicker">Output<\/div>/);

  const dedupedHtml = renderer.buildToolResultRowMarkup(orphan, [], {
    turnPhase: 'done',
    turnRows: [{ kind: 'assistant_text', payload: { text: '```mermaid\ngraph TD\nA --> B\n```' } }],
  });
  assert.doesNotMatch(dedupedHtml, /markdown-mermaid-block/);
});

test('orphan Mermaid result ids stay unique when provider call ids repeat', () => {
  const renderer = createToolRenderer();
  const build = (turnId, rowId) => renderer.buildToolResultRowMarkup({
    ...buildMermaidResultRow({ tool_call_id: 'call-reused' }), turn_id: turnId, row_id: rowId,
  }, [], { sessionId: 'session-a', turnPhase: 'done', turnRows: [] });
  const firstId = build('turn-a', 'row-a').match(/class="markdown-mermaid-block" id="([^"]+)"/)[1];
  const secondId = build('turn-b', 'row-b').match(/class="markdown-mermaid-block" id="([^"]+)"/)[1];
  assert.notEqual(firstId, secondId);
  assert.doesNotMatch(firstId, /\s/);
});

test('unusable mermaid output falls back to generic markup', () => {
  const renderer = createToolRenderer();
  const errorRow = renderer.buildToolResultRowMarkup({
    payload: {
      tool_call_id: 'call-mmd-err',
      tool_name: 'mermaid_generate',
      is_error: true,
      error_code: 'CMP-TOOL-MERMAID-0001',
      result_summary: 'invalid diagram',
      output_text: JSON.stringify({ mermaid: MERMAID_SOURCE }),
    },
  });
  const truncatedRow = renderer.buildToolResultRowMarkup({
    payload: {
      tool_call_id: 'call-mmd-trunc',
      tool_name: 'mermaid_generate',
      output_text: '{"mermaid": "graph TD\\nA --',
    },
  });
  const missingKeyRow = renderer.buildToolResultRowMarkup({
    payload: {
      tool_call_id: 'call-mmd-nokey',
      tool_name: 'mermaid_generate',
      output_text: JSON.stringify({ diagram_type: 'flowchart' }),
    },
  });
  const otherToolRow = renderer.buildToolResultRowMarkup({
    payload: {
      tool_call_id: 'call-other',
      tool_name: 'python_execute',
      output_text: JSON.stringify({ mermaid: MERMAID_SOURCE }),
    },
  });

  assert.doesNotMatch(errorRow, /markdown-mermaid-block/);
  assert.doesNotMatch(truncatedRow, /markdown-mermaid-block/);
  assert.doesNotMatch(missingKeyRow, /markdown-mermaid-block/);
  assert.doesNotMatch(otherToolRow, /markdown-mermaid-block/);
  assert.match(truncatedRow, /tool-call-section-kicker">Output<\/div>/);
});

/* ── Blank tool_call_id disambiguation (finding E4) ── */

test('blank tool_call_id rows fall back to the durable row_id so body ids/aria-controls stay unique', () => {
  const renderer = createToolRenderer();
  const rowA = {
    row_id: 'row:evt-aaa',
    payload: { tool_call_id: '', tool_name: 'run_command', state: 'running', input: { command: 'ls' } },
  };
  const rowB = {
    row_id: 'row:evt-bbb',
    payload: { tool_call_id: '', tool_name: 'run_command', state: 'running', input: { command: 'pwd' } },
  };

  const htmlA = renderer.buildToolCallRowMarkup(rowA);
  const htmlB = renderer.buildToolCallRowMarkup(rowB);

  const extractBodyId = (html) => {
    const match = html.match(/class="tool-call-row-body" id="([^"]*)"/);
    return match ? match[1] : null;
  };
  const extractAriaControls = (html) => {
    const match = html.match(/aria-controls="([^"]*)"/);
    return match ? match[1] : null;
  };

  const bodyIdA = extractBodyId(htmlA);
  const bodyIdB = extractBodyId(htmlB);
  const ariaA = extractAriaControls(htmlA);
  const ariaB = extractAriaControls(htmlB);

  assert.ok(bodyIdA, 'row A must emit a body id');
  assert.ok(bodyIdB, 'row B must emit a body id');
  assert.notEqual(bodyIdA, '', 'row A body id must not be blank');
  assert.notEqual(bodyIdB, '', 'row B body id must not be blank');
  assert.notEqual(bodyIdA, bodyIdB, 'body ids for two blank-call-id rows must be distinct');
  assert.equal(ariaA, bodyIdA, 'aria-controls must match the body id it points to');
  assert.equal(ariaB, bodyIdB, 'aria-controls must match the body id it points to');
  assert.notEqual(ariaA, ariaB, 'aria-controls must be distinct across rows');
  // The durable row_id is the disambiguating key.
  assert.match(decodeURIComponent(decodeURIComponent(bodyIdA)), /row:evt-aaa/);
  assert.match(decodeURIComponent(decodeURIComponent(bodyIdB)), /row:evt-bbb/);
});

test('blank tool_call_id orphan result rows still fall back to a stable, present toolCallId key in markup', () => {
  const renderer = createToolRenderer();
  const rowA = {
    row_id: 'row:evt-res-aaa',
    payload: { tool_call_id: '', tool_name: 'run_command', result_summary: 'ok', output_text: 'done' },
  };
  const rowB = {
    row_id: 'row:evt-res-bbb',
    payload: { tool_call_id: '', tool_name: 'run_command', result_summary: 'ok', output_text: 'also done' },
  };

  const htmlA = renderer.buildToolResultRowMarkup(rowA);
  const htmlB = renderer.buildToolResultRowMarkup(rowB);

  // Both must still render (no crash) with distinct row markup even though
  // the call id itself is blank; this documents current, acceptable
  // behavior for the standalone result row (no toggle body id to collide).
  assert.match(htmlA, /class="tool-result-row"/);
  assert.match(htmlB, /class="tool-result-row"/);
});

test('turn row tool renderer builds error result rows and degrades missing approval renderer to empty markup', () => {
  const renderer = createToolRenderer();
  const errorHtml = renderer.buildToolResultRowMarkup({
    payload: {
      tool_call_id: 'call-err',
      is_error: true,
      error_code: 'CMP-TOOL-0001',
      result_summary: 'Denied by policy',
    },
  });
  const approvalHtml = renderer.buildApprovalGapMarkup({
    tool_call_id: 'row-call',
    payload: {
      approval_id: 'approval-1',
      tool_call_id: 'call-approval',
      tool_name: 'write_file',
      tool_display_name: 'Write file',
      prompt: 'Allow edit?',
    },
  });
  const noApprovalRenderer = createToolRenderer({ renderApprovalBlock: null });

  assert.doesNotMatch(errorHtml, /role="alert"/);
  assert.match(errorHtml, /data-tool-result-outcome="stopped"/);
  assert.match(errorHtml, /CMP-TOOL-0001/);
  assert.doesNotMatch(errorHtml, /data-inv-error-action="retry-tool"/);
  assert.doesNotMatch(errorHtml, /Error CMP-TOOL-0001/);
  assert.doesNotMatch(errorHtml, /tool-call-section-kicker">Output/);
  assert.match(approvalHtml, /data-approval-id="approval-1"/);
  assert.match(approvalHtml, /data-tool-call-id="call-approval"/);
  // F16: the renderer's alias wins over the catalog name the sidecar sent, so
  // the card is labelled exactly like the tool row it sits above.
  assert.match(approvalHtml, /Write:Allow edit\?/);
  assert.equal(noApprovalRenderer.buildApprovalGapMarkup({ payload: { approval_id: 'ap' } }), '');
});

test('plan approval gap keeps pending hold markup without generic controls while ordinary tools stay interactive', () => {
  const renderer = createToolRenderer({ renderApprovalBlock });
  const planProjection = projectRows([
    { id: 'user-plan', role: 'user', content: 'Plan the change' },
    {
      id: 'tool-use-plan',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-plan',
        tool_name: 'exit_plan_mode',
        status: 'pending_approval',
        approval_state: 'pending',
        parent_stream_id: 'stream-plan',
      },
    },
    {
      id: 'plan-document-plan',
      role: 'assistant',
      kind: 'plan_document',
      plan_document: {
        plan_id: 'plan-1',
        tool_call_id: 'call-plan',
        state: 'pending',
        title: 'Build it',
        steps: ['Implement'],
        parent_stream_id: 'stream-plan',
      },
    },
  ]);
  const ordinaryProjection = projectRows([
    { id: 'user-write', role: 'user', content: 'Write the file' },
    {
      id: 'tool-use-write',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-write',
        tool_name: 'write_file',
        status: 'pending_approval',
        approval_state: 'pending',
        parent_stream_id: 'stream-write',
      },
    },
  ]);
  const planHtml = renderer.buildApprovalGapMarkup(
    planProjection.rows.find((row) => row.kind === 'approval_gap')
  );
  const ordinaryHtml = renderer.buildApprovalGapMarkup(
    ordinaryProjection.rows.find((row) => row.kind === 'approval_gap')
  );
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(`<main>${planHtml}${ordinaryHtml}</main>`);
  const planGap = dom.window.document.querySelector('[data-tool-call-id="call-plan"].approval-gap-row');
  const ordinaryGap = dom.window.document.querySelector('[data-tool-call-id="call-write"].approval-gap-row');

  assert.ok(planGap);
  assert.equal(planGap.getAttribute('data-approval-status'), 'pending');
  assert.equal(planGap.getAttribute('data-approval-variant'), 'plan');
  assert.equal(planGap.querySelector('.tool-approval-block'), null);
  assert.equal(planGap.querySelector('.tool-approve-btn'), null);
  assert.equal(planGap.querySelector('.tool-deny-btn'), null);
  assert.equal(planGap.querySelector('.tool-approve-always-btn'), null);
  assert.ok(ordinaryGap);
  assert.equal(ordinaryGap.getAttribute('data-approval-variant'), null);
  assert.ok(ordinaryGap.querySelector('.tool-approve-btn'));
  assert.ok(ordinaryGap.querySelector('.tool-deny-btn'));
  assert.ok(ordinaryGap.querySelector('.tool-approve-always-btn'));
});

test('the approval gap card previews the full input object, never the capped input_json stub', () => {
  const { JSDOM } = require('jsdom');
  const renderer = createToolRenderer({ renderApprovalBlock, toolCallUtils });
  const code = Array.from({ length: 5 }, (_, index) => `print(${index})`).join('\n');
  const stub = JSON.stringify({ truncated: true, preview: '{"code":"print(0)\\nprint(1)...' });

  // Persisted rows past the input_json cap carry the {truncated, preview}
  // stub there while `input` is still the full sanitized object.
  const full = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', tool_call_id: 'call-full',
    payload: { tool_name: 'python_execute', input: { code, purpose: 'Print five numbers' }, input_json: stub },
  });
  const fullDom = new JSDOM(`<main>${full}</main>`).window.document;
  assert.equal(fullDom.querySelector('.tool-approval-command').textContent, code);
  assert.equal(fullDom.querySelector('.tool-approval-prompt').textContent, 'Jenny says Print five numbers');

  // With only the stub available the card degrades to prompt-only rather
  // than quoting a JSON fragment as if it were the code.
  const stubOnly = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', tool_call_id: 'call-stub',
    payload: { tool_name: 'python_execute', prompt: 'Approve Python?', input_json: stub },
  });
  const stubDom = new JSDOM(`<main>${stubOnly}</main>`).window.document;
  assert.equal(stubDom.querySelector('.tool-approval-command'), null);
  assert.equal(stubDom.querySelector('.tool-approval-prompt').textContent, 'Approve Python?');

  // Older rows with input_json only still preview.
  const legacy = renderer.buildApprovalGapMarkup({
    kind: 'approval_gap', tool_call_id: 'call-legacy',
    payload: { tool_name: 'run_command', input_json: JSON.stringify({ command: 'npm test' }) },
  });
  const legacyDom = new JSDOM(`<main>${legacy}</main>`).window.document;
  assert.equal(legacyDom.querySelector('.tool-approval-command').textContent, 'npm test');
});
