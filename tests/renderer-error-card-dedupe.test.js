/**
 * tests/renderer-error-card-dedupe.test.js
 *
 * Coverage for the already-implemented same-turn error-card dedupe +
 * button-cap/demotion + recoveryClass mapping additions:
 *   - renderer/chat/renderer-turn-row-error-dedupe-utils.js (NEW)
 *   - renderer/chat/renderer-turn-row-render-utils.js (buildErrorCodeNoticeMarkup
 *     now consults the dedupe and threads suppressedErrors into the card)
 *   - renderer/chat/renderer-error-recovery-utils.js (BACKEND_CLASS_TO_LOCAL_CLASS
 *     mapping; danger-card 2-button cap with demotion into Details; suppressedErrors
 *     rendered as "Also: CODE — message" lines)
 *
 * Uses the createTurnRowRenderUtils harness pattern established in
 * tests/renderer-turn-row-error-dedupe-utils.test.js and
 * tests/renderer-turn-row-render-utils.test.js (read both before writing this file):
 * buildTurnRowListMarkup is the integration entry point that exercises
 * buildSystemNoticeRowMarkup -> resolveTurnErrorDedupe -> buildErrorCodeNoticeMarkup
 * end to end, using the REAL renderer-error-recovery-utils module (not a stub)
 * so the button-cap/demotion and suppressedErrors "Also:" rendering are exercised
 * through the actual card markup.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Real error-recovery module wired in (not a stub) so dedupe + button-cap +
// suppressedErrors folding are exercised through the actual card markup.
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
      return errorRecoveryUtils.renderTimelineErrorCard(message);
    },
    ...overrides,
  });
}

/* ── Same-turn dedupe via the full render pipeline ── */

test('two assistant_error rows on one turn: exactly one .chat-error-card renders, non-terminal suppressed, terminal absorbs "Also:"', () => {
  const renderer = createRenderer();
  const midTurnRow = {
    row_id: 'row:mid',
    turn_id: 'turn_dup',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_mid',
    payload: {
      subkind: 'assistant_error',
      event_seq: 1,
      error_code: 'CMP-TOOL-0002',
      message: 'Tool-ish mid-turn notice',
    },
  };
  const terminalRow = {
    row_id: 'row:terminal',
    turn_id: 'turn_dup',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_terminal',
    payload: {
      subkind: 'assistant_error',
      event_seq: 2,
      stream_error: 'Stream failed hard',
      error_code: 'CMP-SIDECAR-0003',
    },
  };

  const rows = [midTurnRow, terminalRow];
  const html = renderer.buildTurnRowListMarkup(rows, []);

  const cardMatches = html.match(/chat-error-card--danger/g) || [];
  assert.equal(cardMatches.length, 1, 'exactly one .chat-error-card renders for the turn');
  assert.match(html, /Also: CMP-TOOL-0002.*Tool-ish mid-turn notice/, 'terminal card details fold the suppressed sibling');

  // Direct unit check that buildRowBodyMarkup returns '' for the suppressed (non-terminal) row.
  const midTurnAlone = renderer.buildRowBodyMarkup(midTurnRow, [], { siblingRows: rows });
  assert.equal(midTurnAlone, '', 'the non-terminal row returns empty (suppressed) when rendered standalone with siblingRows');
});

test('terminal-pick fallback: no stream_error on either row, last row in order wins', () => {
  const renderer = createRenderer();
  const rowA = {
    row_id: 'row:a',
    turn_id: 'turn_fallback',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_a',
    payload: { subkind: 'assistant_error', event_seq: 1, error_code: 'CMP-TOOL-0001', message: 'first' },
  };
  const rowB = {
    row_id: 'row:b',
    turn_id: 'turn_fallback',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_b',
    payload: { subkind: 'assistant_error', event_seq: 2, error_code: 'CMP-TOOL-0002', message: 'second (last in order)' },
  };
  const rows = [rowA, rowB];

  const htmlA = renderer.buildRowBodyMarkup(rowA, [], { siblingRows: rows });
  const htmlB = renderer.buildRowBodyMarkup(rowB, [], { siblingRows: rows });

  assert.equal(htmlA, '', 'first row (not last, no stream_error anywhere) is suppressed');
  assert.notEqual(htmlB, '', 'last row in stable order renders the surviving card');
  assert.match(htmlB, /chat-error-card--danger/);
  assert.match(htmlB, /CMP-TOOL-0002/);
});

test('rows from different turn_ids never suppress each other', () => {
  const renderer = createRenderer();
  const rowTurn1 = {
    row_id: 'row:t1',
    turn_id: 'turn_1',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_t1',
    payload: { subkind: 'assistant_error', event_seq: 1, stream_error: 'Turn 1 failed', error_code: 'CMP-AI-0002' },
  };
  const rowTurn2 = {
    row_id: 'row:t2',
    turn_id: 'turn_2',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_t2',
    payload: { subkind: 'assistant_error', event_seq: 1, stream_error: 'Turn 2 failed', error_code: 'CMP-AI-0005' },
  };
  const rows = [rowTurn1, rowTurn2];
  const html = renderer.buildTurnRowListMarkup(rows, []);

  const cardMatches = html.match(/chat-error-card--danger/g) || [];
  assert.equal(cardMatches.length, 2, 'both turns render their own card — no cross-turn suppression');
  assert.match(html, /Turn 1 failed/);
  assert.match(html, /Turn 2 failed/);
});

/* ── Danger card button cap / demotion ── */

test('danger card that previously produced 3+ buttons caps top-level actions at 2, demotes the rest into Details, and never disables a button', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_setup_1',
    session_id: 'sess_1',
    stream_error: 'A tools workspace root is not configured.',
    error_code: 'CMP-CFG-0001',
    recovery_class: 'setup',
    next_action: 'open_settings',
    recovery_actions: [
      { id: 'open_settings', label: 'Open settings' },
      { id: 'open_diagnostics', label: 'Open diagnostics' },
    ],
  });

  // Top-level action row: exactly the primary + "View in logs" = 2 buttons.
  const actionsRowMatch = html.match(/<div class="chat-error-card-actions">([\s\S]*?)<\/div>\s*<\/div>\s*$/);
  assert.ok(actionsRowMatch, 'top-level actions row present');
  const topLevelButtonCount = (actionsRowMatch[1].match(/<button/g) || []).length;
  assert.equal(topLevelButtonCount, 2, 'top-level action row has at most 2 buttons (primary + View in logs)');
  assert.match(html, /data-inv-error-action="open_settings"[^]*?class="inv-error-action inv-error-action--primary"|class="inv-error-action inv-error-action--primary"[^]*?data-inv-error-action="open_settings"/);
  assert.match(html, /data-inv-error-action="open_logs"/, 'View in logs present as the second top-level action');

  // Demoted action (open_diagnostics) appears inside Details with the demoted class.
  const detailsMatch = html.match(/<details class="chat-error-card-details">([\s\S]*)<\/details>/);
  assert.ok(detailsMatch, 'details disclosure present');
  assert.match(detailsMatch[1], /chat-error-card-details-actions/, 'demoted actions wrapper present');
  assert.match(detailsMatch[1], /data-inv-error-action="open_diagnostics"/, 'open_diagnostics demoted into details');
  assert.match(detailsMatch[1], /class="inv-error-action chat-error-card-details-action/, 'demoted action carries chat-error-card-details-action class');
  assert.ok(!html.includes('data-inv-error-action="open_diagnostics"' ) || detailsMatch[1].includes('data-inv-error-action="open_diagnostics"'), 'open_diagnostics only appears inside details');
  assert.ok(!actionsRowMatch[1].includes('open_diagnostics'), 'demoted action does not also appear at top level');

  // No button anywhere is disabled.
  assert.ok(!/\bdisabled\b/.test(html), 'no disabled attribute anywhere in the card');
  assert.ok(!/aria-disabled="true"/.test(html), 'no aria-disabled="true" anywhere in the card');
});

test('calm cards are not subject to the 2-button cap (only danger cards demote)', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_calm_1',
    stream_error: 'Turn cancelled',
    recovery_class: 'cancelled',
    recovery_actions: [
      { id: 'retry_turn', label: 'Retry turn' },
      { id: 'restart_sidecar', label: 'Restart sidecar' },
    ],
  });
  assert.ok(!html.includes('chat-error-card-details-action'), 'calm card has no demoted-details wrapper');
  assert.ok(!/\bdisabled\b/.test(html), 'no disabled attribute on calm card');
});

/* ── recoveryClass -> local ErrorClass mapping ── */

test('recovery_class "runtime" + a CMP-LOOP-* code maps to the loop class (retry synthesized, no settings/tool actions)', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_loop_1',
    stream_error: 'Processing loop detected',
    error_code: 'CMP-LOOP-0001',
    recovery_class: 'runtime',
  });
  assert.match(html, /data-error-class="loop"/, 'runtime backend class derives the local loop class');
  assert.match(html, /data-inv-error-action="retry"/, 'loop class is retryable — synthesized retry present');
  assert.ok(!html.includes('data-inv-error-action="settings"'), 'no settings action for a loop-classified error');
});

test('an unknown backend recovery_class falls back to classifyError(errorCode)', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_fallback_1',
    stream_error: 'Tool execution failed',
    error_code: 'CMP-TOOL-0002',
    recovery_class: 'some_future_backend_class_not_in_the_map',
  });
  assert.match(html, /data-error-class="tool"/, 'unmapped backend class falls back to code-derived classifyError -> tool');
  assert.match(html, /Tool failed/, 'tool-class local title used as fallback');
});

/* ── Regression guard: single-error turn unchanged ── */

test('regression guard: a single-error turn still renders exactly one card, retry primary, View in logs second, no suppressedErrors leak', () => {
  const renderer = createRenderer();
  const rows = [{
    row_id: 'row:solo',
    turn_id: 'turn_solo',
    kind: 'system_notice',
    primary_message_id: 'assistant_error_solo',
    payload: {
      subkind: 'assistant_error',
      event_seq: 1,
      stream_error: 'Provider exploded',
      error_code: 'CMP-AI-0005',
    },
  }];
  const html = renderer.buildTurnRowListMarkup(rows, []);

  const cardMatches = html.match(/chat-error-card--danger/g) || [];
  assert.equal(cardMatches.length, 1, 'exactly one card renders');
  assert.ok(!html.includes('Also:'), 'no suppressed-error line leaks in for a solo error');

  const actionsRowMatch = html.match(/<div class="chat-error-card-actions">([\s\S]*?)<\/div>\s*<\/div>\s*$/);
  assert.ok(actionsRowMatch, 'actions row present');
  const actionIds = [...actionsRowMatch[1].matchAll(/data-inv-error-action="([a-z_-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(actionIds, ['retry', 'open_logs'], 'retry is primary (first), View in logs is second');
});
