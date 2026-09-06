const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const dedupeUtils = require('../renderer/chat/renderer-turn-row-error-dedupe-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Mirrors tests/renderer-turn-row-render-utils.test.js's createRenderer helper
// pattern (read in full before writing this file).
function createRenderer(overrides = {}) {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown(text) {
      return `<p>${escapeHtml(text)}</p>`;
    },
    renderStreamingMarkdownUnits(text) {
      return { html: `<p>${escapeHtml(text)}</p>`, units: [], changedStartIndex: -1 };
    },
    renderAssistantFailureNotice(message) {
      const code = escapeHtml(message.error_code || '');
      const suppressed = Array.isArray(message.suppressedErrors) ? message.suppressedErrors : [];
      const suppressedLines = suppressed
        .map((entry) => `Also: ${escapeHtml(entry.code || '')} — ${escapeHtml(entry.message || '')}`)
        .join('\n');
      return `
        <div class="chat-error-card chat-error-card--danger" data-error-code="${code}">
          <div class="chat-error-card-title">${escapeHtml(message.stream_error || '')}</div>
          <details class="chat-error-card-details">
            <summary class="chat-error-card-details-summary">Details</summary>
            <pre class="chat-error-card-raw">Code: ${code}${suppressedLines ? '\n' + suppressedLines : ''}</pre>
          </details>
        </div>
      `;
    },
    ...overrides,
  });
}

test('extractToolErrorEntry reads is_error tool_result payloads into {code, message}', () => {
  const row = {
    turn_id: 'turn_1',
    kind: 'tool_result',
    payload: {
      tool_call_id: 'call_1',
      tool_name: 'read_file',
      is_error: true,
      error_code: 'CMP-TOOL-0002',
      result_summary: 'Tool "read_file" failed',
    },
  };
  const entry = dedupeUtils.extractToolErrorEntry(row);
  assert.deepEqual(entry, { code: 'CMP-TOOL-0002', message: 'Tool "read_file" failed' });
});

test('extractToolErrorEntry returns null for a non-erroring tool row', () => {
  const row = { turn_id: 'turn_1', kind: 'tool_result', payload: { tool_call_id: 'call_1', is_error: false } };
  assert.equal(dedupeUtils.extractToolErrorEntry(row), null);
});

test('a lone tool-level error with no turn-level notice is untouched (no dedupe applies)', () => {
  const renderer = createRenderer();
  const rows = [
    {
      row_id: 'row:tool_result',
      turn_id: 'turn_lone',
      kind: 'tool_result',
      payload: {
        tool_call_id: 'call_1',
        tool_name: 'read_file',
        is_error: true,
        error_code: 'CMP-TOOL-0002',
        result_summary: 'Tool "read_file" failed',
      },
    },
  ];
  const html = renderer.buildTurnRowListMarkup(rows, []);
  // No assistant_error system_notice row exists, so buildErrorCodeNoticeMarkup
  // is never invoked for this turn — the tool row renders its own
  // .tool-result-notice markup unchanged (no .chat-error-card at all).
  assert.doesNotMatch(html, /chat-error-card/);
});

test('a turn with both a tool-level error and a turn-level assistant_error notice renders exactly one .chat-error-card, folding the tool error into its details', () => {
  const renderer = createRenderer();
  const toolResultRow = {
    row_id: 'row:tool_result',
    turn_id: 'turn_combo',
    kind: 'tool_result',
    payload: {
      tool_call_id: 'call_1',
      tool_name: 'read_file',
      is_error: true,
      error_code: 'CMP-TOOL-0002',
      result_summary: 'Tool "read_file" failed',
    },
  };
  const assistantErrorRow = {
    row_id: 'row:assistant_error',
    turn_id: 'turn_combo',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_combo',
    payload: {
      subkind: 'assistant_error',
      event_seq: 1,
      stream_error: 'Stream failed hard',
      error_code: 'CMP-SIDECAR-0003',
    },
  };

  const rows = [toolResultRow, assistantErrorRow];
  const html = renderer.buildTurnRowListMarkup(rows, []);

  const cardMatches = html.match(/class="chat-error-card chat-error-card--/g) || [];
  assert.equal(cardMatches.length, 1, 'exactly one .chat-error-card should render for the turn');
  assert.match(html, /Also: CMP-TOOL-0002 — Tool &quot;read_file&quot; failed/);
});

test('resolveTurnErrorDedupe suppresses a non-terminal assistant_error row and folds it into the terminal one', () => {
  const rowA = {
    turn_id: 'turn_x',
    kind: 'system_notice',
    payload: { subkind: 'assistant_error', event_seq: 1, stream_error: '', error_code: 'CMP-TOOL-0001', message: 'first notice' },
  };
  const rowB = {
    turn_id: 'turn_x',
    kind: 'system_notice',
    payload: { subkind: 'assistant_error', event_seq: 2, stream_error: 'Turn-level failure', error_code: 'CMP-SIDECAR-0003' },
  };
  const siblingRows = [rowA, rowB];

  const resultA = dedupeUtils.resolveTurnErrorDedupe(rowA, { siblingRows });
  assert.equal(resultA.suppress, true);

  const resultB = dedupeUtils.resolveTurnErrorDedupe(rowB, { siblingRows });
  assert.equal(resultB.suppress, false);
  assert.equal(resultB.suppressedErrors.length, 1);
  assert.equal(resultB.suppressedErrors[0].code, 'CMP-TOOL-0001');
});

test('dual assistant_error turn renders one REAL card: terminal turn-level wins, retry+logs visible, earlier error folded into Details', () => {
  // End-to-end through the real error-recovery module (no stubbed notice
  // renderer): the terminal stream_error row owns the single card; the
  // earlier tool-level assistant_error row folds into its Details.
  const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');
  const renderer = createRenderer({
    renderAssistantFailureNotice(message) {
      return errorRecoveryUtils.renderEnhancedFailureNotice(message);
    },
  });
  const toolLevelErrorRow = {
    row_id: 'row:err_tool',
    turn_id: 'turn_dual',
    kind: 'system_notice',
    primary_message_id: 'msg_tool_err',
    payload: {
      subkind: 'assistant_error',
      event_seq: 1,
      stream_error: '',
      error_code: 'CMP-TOOL-0002',
      message: 'Tool "read_file" failed',
    },
  };
  const terminalErrorRow = {
    row_id: 'row:err_terminal',
    turn_id: 'turn_dual',
    kind: 'system_notice',
    primary_message_id: 'msg_terminal_err',
    payload: {
      subkind: 'assistant_error',
      event_seq: 2,
      stream_error: 'Stream failed hard',
      error_code: 'CMP-CHAT-0002',
    },
  };
  const html = renderer.buildTurnRowListMarkup([toolLevelErrorRow, terminalErrorRow], []);

  const cards = html.match(/class="chat-error-card chat-error-card--/g) || [];
  assert.equal(cards.length, 1, 'exactly one real .chat-error-card for the dual-error turn');
  assert.match(html, /data-error-code="CMP-CHAT-0002"/, 'the terminal turn-level error owns the card');
  assert.match(html, /Also: CMP-TOOL-0002/, 'suppressed tool-level error folded into Details');

  const actionsRow = (html.match(/<div class="chat-error-card-actions">([\s\S]*?)<\/div>/) || [])[1] || '';
  assert.equal((actionsRow.match(/<button/g) || []).length, 2, 'two visible buttons max');
  assert.ok(actionsRow.includes('data-inv-error-action="retry"'), 'retry leads');
  assert.ok(actionsRow.includes('data-inv-error-action="open_logs"'), 'View in logs second');
  assert.ok(!/<button[^>]*\sdisabled/.test(html), 'no disabled buttons anywhere');
});

test('resolveTurnErrorDedupe is a no-op when only one assistant_error row exists for the turn', () => {
  const row = {
    turn_id: 'turn_solo',
    kind: 'system_notice',
    payload: { subkind: 'assistant_error', event_seq: 1, stream_error: 'Solo failure', error_code: 'CMP-AI-0002' },
  };
  const result = dedupeUtils.resolveTurnErrorDedupe(row, { siblingRows: [row] });
  assert.equal(result.suppress, false);
  assert.deepEqual(result.suppressedErrors, []);
});
