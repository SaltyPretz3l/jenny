/**
 * tests/renderer-error-card-markup.test.js
 *
 * EH-W3 gate — unified timeline error card markup
 * (renderer/chat/renderer-error-recovery-utils.js). Corpus goldens are
 * projector-level, so markup tests are the deterministic gate for the
 * card contract: severities, roles, badge, details, action wiring.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');

/* ── resolveErrorSeverity ── */

test('resolveErrorSeverity is danger by default', () => {
  assert.equal(errorRecoveryUtils.resolveErrorSeverity({}), 'danger');
  assert.equal(errorRecoveryUtils.resolveErrorSeverity(null), 'danger');
  assert.equal(errorRecoveryUtils.resolveErrorSeverity({ status: 'error' }), 'danger');
});

test('resolveErrorSeverity maps cancelled/denied recovery classes to calm', () => {
  assert.equal(errorRecoveryUtils.resolveErrorSeverity({ recovery_class: 'cancelled' }), 'calm');
  assert.equal(errorRecoveryUtils.resolveErrorSeverity({ recovery_class: 'denied' }), 'calm');
  assert.equal(errorRecoveryUtils.resolveErrorSeverity({ recovery_class: 'transport' }), 'danger');
});

test('resolveErrorSeverity falls back to terminal status pre-enrichment', () => {
  assert.equal(errorRecoveryUtils.resolveErrorSeverity({ terminal_status: 'cancelled' }), 'calm');
  assert.equal(errorRecoveryUtils.resolveErrorSeverity({ status: 'aborted' }), 'calm');
  assert.equal(errorRecoveryUtils.resolveErrorSeverity({ status: 'denied' }), 'calm');
});

/* ── danger card ── */

test('danger card renders alert role, badge, title, message, and details', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: 'Sidecar exited unexpectedly',
    error_code: 'CMP-SIDECAR-0003',
    recovery_class: 'sidecar_transport',
    recovery_title: 'Sidecar connection issue',
    recovery_hint: 'Restart the local sidecar, then retry this turn.',
  });
  assert.ok(html.includes('chat-error-card--danger'), 'danger variant class');
  assert.ok(html.includes('role="group"'), 'persisted static region, not a re-announcing alert');
  assert.ok(html.includes('aria-label="Error: Sidecar connection issue"'), 'labelled region for screen readers');
  assert.ok(!html.includes('role="alert"'), 'no live-region re-announcement on re-render');
  assert.ok(html.includes('data-error-severity="danger"'), 'severity dataset');
  assert.ok(html.includes('data-error-code="CMP-SIDECAR-0003"'), 'code dataset');
  assert.ok(html.includes('inv-badge'), 'renders inventory badge');
  assert.ok(html.includes('CMP-SIDECAR-0003</span>'), 'badge carries the code');
  assert.ok(html.includes('chat-error-card-title'), 'title element');
  assert.ok(html.includes('Sidecar connection issue'), 'server title preferred');
  assert.ok(html.includes('Sidecar exited unexpectedly'), 'message body');
  assert.ok(html.includes('Restart the local sidecar, then retry this turn.'), 'hint body');
  assert.ok(html.includes('<details class="chat-error-card-details">'), 'collapsed details');
  assert.ok(html.includes('chat-error-card-raw'), 'raw error block');
  assert.ok(html.includes('data-inv-error-action="open_logs"'), 'view-in-logs deep link');
});

test('danger card renders backend recovery actions as inventory buttons', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_42',
    session_id: 'sess_7',
    stream_error: 'Sidecar exited unexpectedly',
    error_code: 'CMP-SIDECAR-0003',
    recovery_class: 'sidecar_transport',
    next_action: 'retry_turn',
    recovery_actions: [
      { id: 'retry_turn', label: 'Retry turn' },
      { id: 'restart_sidecar', label: 'Restart sidecar' },
    ],
  });
  assert.ok(html.includes('chat-error-card-actions'), 'actions row');
  assert.ok(html.includes('data-inv-error-action="retry_turn"'), 'retry action id');
  assert.ok(html.includes('data-inv-error-action="restart_sidecar"'), 'restart action id');
  assert.ok(html.includes('data-message-id="msg_42"'), 'threads message id');
  assert.ok(html.includes('data-session-id="sess_7"'), 'threads session id');
  assert.ok(/class="inv-error-action[ "]/.test(html), 'inventory button keeps the error-action base class (allows primary/muted modifiers)');
  assert.ok(html.includes('type="button"'), 'buttons are type=button');
});

test('enriched recovery copy is preferred over the local classifier fallback', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: 'Connection failed',
    error_code: 'CMP-AI-0002',
    recovery_title: 'Bespoke server title',
    recovery_hint: 'Bespoke server hint copy.',
  });
  assert.ok(html.includes('Bespoke server title'), 'server title wins');
  assert.ok(html.includes('Bespoke server hint copy.'), 'server hint wins');
  assert.ok(!html.includes('Connection issue — the request may succeed on retry.'), 'local hint suppressed');
});

test('no-metadata danger card still renders with local fallback copy', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: 'Something broke badly',
  });
  assert.ok(html.includes('chat-error-card--danger'), 'renders danger card');
  assert.ok(html.includes('Turn failed'), 'local fallback title');
  assert.ok(html.includes('Something broke badly'), 'raw message preserved');
  assert.ok(!html.includes('thinking-error-note'), 'no legacy note');
});

test('code-only card renders without a message body', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    error_code: 'CMP-CTX-0003',
  });
  assert.ok(html.includes('chat-error-card--danger'), 'renders card from code alone');
  assert.ok(html.includes('data-error-code="CMP-CTX-0003"'), 'code dataset');
  assert.ok(html.includes('Context limit reached'), 'class-derived local title');
  assert.ok(!html.includes('chat-error-card-message'), 'no empty message block');
});

test('code-only CMP-CFG card derives the setup class, not the context fallback', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    error_code: 'CMP-CFG-0001',
  });
  assert.ok(html.includes('chat-error-card--danger'), 'renders card from code alone');
  assert.ok(html.includes('data-error-code="CMP-CFG-0001"'), 'code dataset');
  assert.ok(html.includes('Setup required'), 'class-derived setup title');
  assert.ok(!html.includes('Context limit reached'), 'must not borrow the context-window title');
  assert.ok(/workspace root/i.test(html), 'setup hint mentions the workspace root');
  // Local fallback leads with Settings (config errors are fixed in Settings, not by retry).
  assert.ok(html.includes('data-inv-error-action="settings"'), 'leads with a Settings action');
});

test('setup card with a resolvable message id still offers no misleading universal Retry', () => {
  // With a message id present, the EH-W4 universal-retry fallback would otherwise unshift a
  // primary "Retry" onto a danger card — but retrying a config error just re-sends the same
  // request and fails identically. The setup class must be exempt: Settings is the only fix.
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    error_code: 'CMP-CFG-0001',
    id: 'assistant_stream_42',
  });
  assert.ok(html.includes('chat-error-card--danger'), 'danger card (the severity that unshifts a primary Retry)');
  assert.ok(html.includes('Setup required'), 'setup title');
  assert.ok(html.includes('data-inv-error-action="settings"'), 'leads with a Settings action');
  assert.ok(!html.includes('data-inv-error-action="retry"'), 'no misleading Retry despite a resolvable message id');
});

test('context-limit card keeps New session primary and offers no futile Retry', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-CTX-0003',
    message: 'Budget exceeded',
    messageId: 'msg_1',
  });
  const actionsRow = extractActionsRow(html);

  assert.ok(actionsRow.includes('data-inv-error-action="new-session"'));
  assert.ok(!html.includes('data-inv-error-action="retry"'));
});

test('card with nothing to show returns empty string', () => {
  assert.equal(errorRecoveryUtils.renderTimelineErrorCard({}), '');
  assert.equal(errorRecoveryUtils.renderTimelineErrorCard(null), '');
});

test('card escapes hostile message and code content', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: '<script>alert(1)</script> & "quotes"',
    error_code: 'CMP-AI-0005',
  });
  assert.ok(!html.includes('<script>'), 'script tag escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form present');
});

/* ── calm card ── */

test('calm card renders status role, muted variant, and no details', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: 'Turn cancelled',
    recovery_class: 'cancelled',
    recovery_title: 'Turn cancelled',
    recovery_hint: 'This turn was cancelled before it completed.',
  });
  assert.ok(html.includes('chat-error-card--calm'), 'calm variant class');
  assert.ok(html.includes('role="group"'), 'static labelled region, not a re-announcing live region');
  assert.ok(html.includes('aria-label="Turn cancelled"'), 'labelled region for screen readers');
  assert.ok(!html.includes('aria-live'), 'no re-announcing live region on a persisted entry');
  assert.ok(!html.includes('role="alert"'), 'not an alert');
  assert.ok(!html.includes('chat-error-card-details'), 'no raw details on calm cards');
  assert.ok(!html.includes('data-inv-error-action="retry"'), 'no synthesized local retry');
});

test('calm card derives from terminal status pre-enrichment with stop copy', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: 'Turn cancelled by user',
    status: 'cancelled',
  });
  assert.ok(html.includes('chat-error-card--calm'), 'calm from bare status');
  assert.ok(html.includes('Response stopped'), 'default calm title');
  assert.ok(html.includes('Turn cancelled by user'), 'message still shown');
});

test('calm card suppresses message identical to its title', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    stream_error: 'Turn cancelled',
    recovery_class: 'cancelled',
    recovery_title: 'Turn cancelled',
  });
  assert.ok(!html.includes('chat-error-card-message'), 'duplicate message suppressed');
});

/* ── compatibility surface ── */

test('renderEnhancedFailureNotice requires stream_error and emits the card', () => {
  assert.equal(errorRecoveryUtils.renderEnhancedFailureNotice({ error_code: 'CMP-AI-0002' }), '');
  const html = errorRecoveryUtils.renderEnhancedFailureNotice({
    stream_error: 'Connection failed',
    error_code: 'CMP-AI-0002',
  });
  assert.ok(html.includes('chat-error-card'), 'card emitted');
  assert.ok(html.includes('data-inv-error-action="retry"'), 'local retry synthesized for transport');
  assert.ok(html.includes('title="Retry this request"'), 'retry action carries hover guidance');
});

test('renderErrorRecovery keeps the opts-shaped compatibility surface', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-TOOL-0008',
    message: 'Execution failed',
    callId: 'call_123',
  });
  assert.ok(html.includes('chat-error-card'), 'card emitted');
  assert.ok(html.includes('data-inv-error-action="retry-tool"'), 'tool retry action');
  assert.ok(html.includes('data-inv-error-action="skip-tool"'), 'tool skip action');
  assert.ok(html.includes('title="Retry this tool call"'), 'tool retry carries hover guidance');
  assert.ok(html.includes('title="Skip this tool call and continue"'), 'tool skip carries hover guidance');
  assert.ok(html.includes('data-call-id="call_123"'), 'call id threaded');
});

test('open_logs recovery action navigates to the logs view', async () => {
  const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');
  const viewCalls = [];
  const controller = createShellRuntimeController({
    state: {},
    callbacks: {
      setActiveView: (viewId) => { viewCalls.push(viewId); },
    },
  });
  await controller.handleErrorRecoveryAction({ action: 'open_logs' });
  assert.deepEqual(viewCalls, ['logs'], 'setActiveView("logs") invoked once');
});

test('module emits no raw button markup of its own', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'chat', 'renderer-error-recovery-utils.js'),
    'utf8'
  );
  assert.ok(!/<\s*button\b/i.test(source), 'no raw <button> literal — inventory primitive only');
});

/* ── CSS selector presence (pattern: chat-composer-affordances-css.test.js) ── */

test('chat-system-notices-v2.css styles the unified card and legacy fallback', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'styles', 'chat-system-notices-v2.css'),
    'utf8'
  );
  for (const selector of [
    '.chat-error-card {',
    '.chat-error-card--calm {',
    '.chat-error-card-head {',
    '.chat-error-card-title {',
    '.chat-error-card-message {',
    '.chat-error-card-hint {',
    '.chat-error-card-raw {',
    '.chat-error-card-actions {',
  ]) {
    assert.ok(css.includes(selector), `missing selector: ${selector}`);
  }
});

test('styles.css imports the system-notices sheet that carries the card styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(
    css.includes('./styles/chat-system-notices-v2.css'),
    'chat-system-notices-v2.css must stay in the import list'
  );
});

/* ── consolidation: 2-button cap + Details demotion ── */

function extractActionsRow(html) {
  const match = html.match(/<div class="chat-error-card-actions">([\s\S]*?)<\/div>/);
  return match ? match[1] : '';
}

function extractDetails(html) {
  const match = html.match(/<details class="chat-error-card-details">[\s\S]*?<\/details>/);
  return match ? match[0] : '';
}

test('danger card caps visible buttons at the lead action + View in logs; the rest demote into Details', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_cap',
    session_id: 'sess_cap',
    stream_error: 'Sidecar exited unexpectedly',
    error_code: 'CMP-SIDECAR-0003',
    recovery_class: 'sidecar_transport',
    next_action: 'retry_turn',
    recovery_actions: [
      { id: 'retry_turn', label: 'Retry turn' },
      { id: 'restart_sidecar', label: 'Restart sidecar' },
      { id: 'open_diagnostics', label: 'Open diagnostics' },
    ],
  });
  const actionsRow = extractActionsRow(html);
  assert.equal((actionsRow.match(/<button/g) || []).length, 2, 'exactly two visible buttons');
  assert.ok(actionsRow.includes('data-inv-error-action="retry_turn"'), 'lead retry stays visible');
  assert.ok(actionsRow.includes('data-inv-error-action="open_logs"'), 'View in logs stays visible');
  const details = extractDetails(html);
  assert.ok(details.includes('data-inv-error-action="restart_sidecar"'), 'restart demoted into Details');
  assert.ok(details.includes('data-inv-error-action="open_diagnostics"'), 'diagnostics demoted into Details');
  assert.ok(details.includes('chat-error-card-details-actions'), 'demoted actions container present');
  assert.ok(details.includes('chat-error-card-details-action'), 'demoted actions carry the link-styled modifier');
  assert.ok(!actionsRow.includes('restart_sidecar'), 'restart no longer a top-level button');
});

test('tool-class card keeps Retry tool visible and demotes Skip into Details', () => {
  const html = errorRecoveryUtils.renderErrorRecovery({
    errorCode: 'CMP-TOOL-0008',
    message: 'Execution failed',
    callId: 'call_123',
  });
  const actionsRow = extractActionsRow(html);
  assert.equal((actionsRow.match(/<button/g) || []).length, 2, 'retry-tool + View in logs only');
  assert.ok(actionsRow.includes('data-inv-error-action="retry-tool"'), 'tool retry leads');
  assert.ok(actionsRow.includes('data-inv-error-action="open_logs"'), 'logs second');
  assert.ok(extractDetails(html).includes('data-inv-error-action="skip-tool"'), 'skip demoted into Details');
});

test('error cards never render a disabled button', () => {
  const cases = [
    { stream_error: 'x', error_code: 'CMP-SIDECAR-0003', recovery_class: 'sidecar_transport', recovery_actions: [{ id: 'retry_turn', label: 'Retry turn' }, { id: 'open_diagnostics', label: 'Open diagnostics' }] },
    { stream_error: 'x', error_code: 'CMP-CFG-0001' },
    { stream_error: 'x', error_code: 'CMP-TOOL-0008' },
    { stream_error: 'x', recovery_class: 'cancelled' },
    { error_code: 'CMP-CTX-0003', id: 'msg_1' },
  ];
  for (const message of cases) {
    const html = errorRecoveryUtils.renderTimelineErrorCard(message);
    assert.ok(!/<button[^>]*\sdisabled/.test(html), `no disabled buttons for ${JSON.stringify(message)}`);
  }
});

/* ── consolidation: suppressed same-turn errors fold into Details ── */

test('suppressed same-turn errors render as one-line entries inside Details', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_fold',
    stream_error: 'Stream failed hard',
    error_code: 'CMP-CHAT-0002',
    suppressedErrors: [
      { code: 'CMP-TOOL-0002', message: 'Tool "read_file" failed' },
      { code: '', message: 'unnamed earlier failure' },
    ],
  });
  assert.equal((html.match(/class="chat-error-card chat-error-card--/g) || []).length, 1, 'single card');
  const details = extractDetails(html);
  assert.ok(details.includes('Also: CMP-TOOL-0002 — Tool &quot;read_file&quot; failed'), 'code + message line');
  assert.ok(details.includes('Also: unnamed earlier failure'), 'message-only line');
});

/* ── consolidation: backend recovery_class drives buttons AND title together ── */

test('CMP-LOOP code with backend runtime class keeps title and buttons on one source', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_loop',
    stream_error: 'Model stopped mid-stream',
    error_code: 'CMP-LOOP-0003',
    recovery_class: 'runtime',
    recovery_title: 'Model stopped responding',
  });
  assert.ok(html.includes('Model stopped responding'), 'backend title renders');
  const actionsRow = extractActionsRow(html);
  assert.ok(actionsRow.includes('data-inv-error-action="retry"'), 'runtime→loop mapping leads with Retry');
  assert.ok(actionsRow.includes('data-error-class="loop"'), 'buttons carry the backend-mapped class');
});

test('backend setup class overrides a conflicting local code-prefix classification', () => {
  /* A CMP-LOOP-* code that the backend classified as setup must not lead
   * with Retry (title says configure, buttons must agree). */
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_conflict',
    stream_error: 'Workspace root missing',
    error_code: 'CMP-LOOP-0003',
    recovery_class: 'setup',
    recovery_title: 'Setup required',
  });
  const actionsRow = extractActionsRow(html);
  assert.ok(actionsRow.includes('data-inv-error-action="settings"'), 'settings leads for backend setup class');
  assert.ok(!actionsRow.includes('data-inv-error-action="retry"'), 'no local-class Retry despite the CMP-LOOP prefix');
});

/* ── logs deep link: the error code chip navigates to Activity ── */

test('error code chip becomes a focusable link when the turn has a stream id', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_link',
    stream_error: 'Stream failed hard',
    error_code: 'CMP-CHAT-0002',
    stream_id: 'stream_abc',
  });
  const chip = html.match(/<span[^>]*chat-error-card-code[^>]*>/)[0];
  assert.ok(chip.includes('role="link"'), 'chip exposes the link role');
  assert.ok(chip.includes('tabindex="0"'), 'chip is keyboard focusable');
  assert.ok(chip.includes('data-inv-error-action="open_logs"'), 'chip rides the delegated error-action contract');
  assert.ok(chip.includes('data-stream-id="stream_abc"'), 'chip carries the turn stream id');
  assert.ok(
    chip.includes('title="View this error&#39;s diagnostic event in Activity"'),
    'chip carries the tooltip copy (the tooltip layer migrates title=)'
  );
  assert.ok(chip.includes('inv-badge'), 'still the badge primitive, not a fork');
});

test('error code chip stays inert metadata without a resolvable stream id', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_no_link',
    stream_error: 'Stream failed hard',
    error_code: 'CMP-CHAT-0002',
  });
  const chip = html.match(/<span[^>]*chat-error-card-code[^>]*>/)[0];
  assert.ok(!chip.includes('role="link"'), 'no dead link when nothing to navigate to');
  assert.ok(!chip.includes('data-inv-error-action'), 'no action contract on an inert chip');
  assert.ok(!chip.includes('tabindex'), 'inert chip stays out of the tab order');
});

test('View in logs button carries the same stream id as the chip', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_link_button',
    stream_error: 'Stream failed hard',
    error_code: 'CMP-CHAT-0002',
    parent_stream_id: 'stream_parent',
  });
  const logsButton = html.match(/<button[^>]*data-inv-error-action="open_logs"[^>]*>/)[0];
  assert.ok(logsButton.includes('data-stream-id="stream_parent"'), 'both routes deep-link');
});

test('resolveErrorStreamId mirrors the projector field order', () => {
  const { resolveErrorStreamId } = errorRecoveryUtils;
  assert.equal(resolveErrorStreamId({ stream_id: 'a', request_id: 'b' }), 'a');
  assert.equal(resolveErrorStreamId({ requestId: 'b' }), 'b');
  assert.equal(resolveErrorStreamId({ parentStreamId: 'c' }), 'c');
  assert.equal(resolveErrorStreamId({ tool_call: { parent_stream_id: 'd' } }), 'd');
  assert.equal(resolveErrorStreamId({ tool_result: { parent_stream_id: 'e' } }), 'e');
  assert.equal(resolveErrorStreamId({ stream_id: 'a' }, { streamId: 'row-turn' }), 'row-turn');
  assert.equal(resolveErrorStreamId(null, null), '');
});

test('calm cards deep-link too when the stream id is known', () => {
  const html = errorRecoveryUtils.renderTimelineErrorCard({
    id: 'msg_calm_link',
    stream_error: 'Turn cancelled',
    error_code: 'CMP-CHAT-0002',
    recovery_class: 'cancelled',
    stream_id: 'stream_calm',
  });
  const chip = html.match(/<span[^>]*chat-error-card-code[^>]*>/)[0];
  assert.ok(chip.includes('data-stream-id="stream_calm"'), 'calm chip links as well');
  assert.ok(
    !/<button[^>]*data-inv-error-action="open_logs"/.test(html),
    'calm cards stay minimal — the chip is the only logs route'
  );
});
