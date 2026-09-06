const test = require('node:test');
const assert = require('node:assert/strict');

const toolShellUtils = require('../renderer/chat/renderer-tool-shell-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { withInventory } = require('./helpers/inventory-harness');

/* Phase 7 §4a: focused unit coverage for the shared helpers exposed by
 * createToolShellRenderer — status-dot tone derivation, kv-grid markup,
 * and the kicker/status-dot emission baked into shell headers. */

function setupRenderer(t) {
  withInventory(t);
  return toolShellUtils.createToolShellRenderer({
    escapeHtml,
    toolCallUtils,
    renderDiffHunks: null,
    sanitizeHtmlFragment: null,
  });
}

test('canonical result status keeps specific stop outcomes ahead of generic errors', () => {
  const expected = new Map([
    ['denied', 'denied'],
    ['cancelled', 'cancelled'],
    ['blocked', 'blocked'],
    ['timed_out', 'timed_out'],
    ['interrupted', 'interrupted'],
    ['abandoned', 'abandoned'],
  ]);
  expected.forEach((visible, status) => {
    assert.equal(toolCallUtils.statusForToolResult({ status, is_error: true }), visible);
  });
  assert.equal(toolCallUtils.statusForToolResult({ is_error: true }), 'errored');
  assert.equal(toolCallUtils.statusForToolResult({ is_error: false }), 'completed');
  assert.equal(toolCallUtils.statusForToolResult({ error_code: 'CMP-APPROVAL-REJECTED', is_error: true }), 'denied');
});

test('composite tool row keys escape component delimiters without collisions', () => {
  const first = toolCallUtils.buildToolRowKey({ sessionId: 'a|turn=b', turnId: 'c', rowId: 'r', callId: 'x' });
  const second = toolCallUtils.buildToolRowKey({ sessionId: 'a', turnId: 'b|turn=c', rowId: 'r', callId: 'x' });
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /a\|turn=b/);
});

test('phase 7: statusToneFor maps every documented status to a foundation dot tone', () => {
  /* Active wins over status. */
  assert.equal(toolCallUtils.statusToneFor('completed', true), 'active');
  assert.equal(toolCallUtils.statusToneFor('errored', true), 'active');

  /* Terminal-success states share the ok dot. */
  assert.equal(toolCallUtils.statusToneFor('completed', false), 'ok');
  assert.equal(toolCallUtils.statusToneFor('approved', false), 'ok');

  /* Only genuine execution failures use the error dot. */
  assert.equal(toolCallUtils.statusToneFor('errored', false), 'error');

  /* Interrupted terminal states use the warn dot. */
  assert.equal(toolCallUtils.statusToneFor('timed_out', false), 'warn');
  assert.equal(toolCallUtils.statusToneFor('interrupted', false), 'warn');
  assert.equal(toolCallUtils.statusToneFor('abandoned', false), 'warn');

  /* User/policy stops stay calm. */
  assert.equal(toolCallUtils.statusToneFor('denied', false), 'muted');
  assert.equal(toolCallUtils.statusToneFor('cancelled', false), 'muted');
  assert.equal(toolCallUtils.statusToneFor('blocked', false), 'muted');

  /* Pre-action states (waiting on user / not-yet-issued) use the pending dot. */
  assert.equal(toolCallUtils.statusToneFor('awaiting_approval', false), 'pending');
  assert.equal(toolCallUtils.statusToneFor('requested', false), 'pending');

  /* Anything unrecognized degrades quietly to muted. */
  assert.equal(toolCallUtils.statusToneFor('unknown_state_xyz', false), 'muted');
  assert.equal(toolCallUtils.statusToneFor('', false), 'muted');
});

/* buildToolHeaderInner (tool-call-utils) is the single source for the
 * one-liner header anatomy — both the shell header and the generic
 * transcript fallback render it. */
function headerInner(model) {
  return toolCallUtils.buildToolHeaderInner(
    { displayToolName: 'Bash', summary: 'echo hi', ...model },
    { escapeHtml }
  );
}

test('buildToolHeaderInner renders the label sr-only on plain success (dot carries the signal)', () => {
  const html = headerInner({ status: 'completed', statusLabel: 'Completed', isRunning: false, durationLabel: '1.5s' });
  // Quiet grammar: the leading row dot carries the settled-success signal;
  // the textual label is a11y-only on settled success.
  assert.match(html, /status-dot status-dot--ok/);
  assert.match(html, /class="tool-call-status-label sr-only">Completed</);
  assert.match(html, /class="tool-call-duration">1\.5s</);
});

test('buildToolHeaderInner keeps the label visible for states that need words', () => {
  const html = headerInner({ status: 'errored', statusLabel: 'Errored', isRunning: false, durationLabel: '' });
  assert.match(html, /class="tool-call-status-label">Errored</);
  assert.doesNotMatch(html, /tool-call-duration/);
  const running = headerInner({ status: 'completed', statusLabel: 'Running', isRunning: true, durationLabel: '' });
  assert.match(running, /class="tool-call-status-label">Running</);
  assert.match(running, /status-dot status-dot--active/);
});

test('buildToolHeaderInner accepts trusted summary and duration render hooks without changing shared anatomy', () => {
  const html = toolCallUtils.buildToolHeaderInner({
    displayToolName: 'Read', summary: 'README.md', status: 'running',
    statusLabel: 'Running', isRunning: true, durationLabel: '0:07',
  }, {
    escapeHtml,
    renderSummary: (summary) => `<span class="custom-summary">${escapeHtml(summary)}</span>`,
    renderDuration: (duration) => `<span class="custom-duration" data-live="true">${escapeHtml(duration)}</span>`,
  });
  assert.match(html, /status-dot status-dot--active/);
  assert.match(html, /tool-call-name">Read/);
  assert.match(html, /custom-summary">README\.md/);
  assert.match(html, /tool-call-status-label">Running/);
  assert.match(html, /custom-duration" data-live="true">0:07/);
  assert.match(html, /tool-call-disclosure/);
});

test('phase 7: kvGrid renders three-column rows with mono-discipline labels', (t) => {
  const renderer = setupRenderer(t);
  const html = renderer.kvGrid({ file_path: 'notes.md', line: 42, write: true });
  assert.ok(html, 'expected non-empty grid markup');
  assert.match(html, /class="tool-kv-grid"/);
  /* Each scalar value gets its own row with label / value / meta cells. */
  assert.match(html, /class="tool-kv-row">[\s\S]*?tool-kv-label">file_path/);
  assert.match(html, /tool-kv-value">notes\.md/);
  assert.match(html, /tool-kv-value">42/);
  assert.match(html, /tool-kv-value">true/);
  /* Meta describes the value shape. */
  assert.match(html, /tool-kv-meta">8 chars/);
  assert.match(html, /tool-kv-meta">num/);
  assert.match(html, /tool-kv-meta">bool/);
});

test('phase 7: kvGrid stacks complex values as a code block under the row', (t) => {
  const renderer = setupRenderer(t);
  const html = renderer.kvGrid({
    nested: { a: 1, b: 2 },
    items: [1, 2, 3],
  });
  assert.match(html, /class="tool-kv-row tool-kv-row--block"/);
  assert.match(html, /class="tool-kv-pre">/);
  /* Object meta reports key count; array meta reports item count. */
  assert.match(html, /tool-kv-meta">2 keys/);
  assert.match(html, /tool-kv-meta">3 items/);
});

test('phase 7: kvGrid returns empty string for non-objects, arrays, and empty objects', (t) => {
  const renderer = setupRenderer(t);
  assert.equal(renderer.kvGrid(null), '');
  assert.equal(renderer.kvGrid(undefined), '');
  assert.equal(renderer.kvGrid('not an object'), '');
  assert.equal(renderer.kvGrid([1, 2, 3]), '');
  assert.equal(renderer.kvGrid({}), '');
});

test('phase 7: kvRow renders metadata for common value shapes', (t) => {
  const renderer = setupRenderer(t);
  for (const [value, meta] of [
    [null, 'null'], [undefined, ''], [true, 'bool'], [0, 'num'],
    ['', '0 chars'], ['a', '1 char'], ['hello', '5 chars'],
    [[], '0 items'], [['only'], '1 item'], [[1, 2, 3], '3 items'],
    [{}, '0 keys'], [{ a: 1 }, '1 key'], [{ a: 1, b: 2 }, '2 keys'],
  ]) {
    assert.match(renderer.kvRow('value', value), new RegExp(`tool-kv-meta">${meta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`));
  }
});

test('phase 7: bash shell header emits the tool kicker, status-dot, and call-id data hook', (t) => {
  const renderer = setupRenderer(t);
  const html = renderer.renderToolShell({
    toolKind: 'Bash',
    callId: 'phase7_bash_call',
    displayToolName: 'Bash',
    summary: 'echo hi',
    status: 'completed',
    statusLabel: 'Completed',
    isRunning: false,
    durationLabel: '0.4s',
    defaultExpanded: false,
    input: { command: 'echo hi' },
    inputJson: '{"command":"echo hi"}',
    metadata: { stdout: 'hi\n', exitCode: 0 },
    outputText: 'hi\n',
  });
  assert.ok(html, 'shell renderer should produce markup for Bash');
  /* Quiet one-liner grammar: no uppercase "Tool" kicker; a leading status
   * dot opens the row and the success label is screen-reader-only. */
  assert.doesNotMatch(html, /tool-call-kicker/);
  assert.match(html, /class="status-dot status-dot--ok"/);
  assert.match(html, /class="tool-call-status-label sr-only">Completed</);
  assert.match(html, /class="tool-call-duration">0\.4s</);
  /* Header carries the call-id so the toggle handler can persist state. */
  assert.match(html, /data-call-id="phase7_bash_call"/);
  /* Disclosure chevron is present for the click affordance. */
  assert.match(html, /class="tool-call-disclosure"/);
});

test('phase 7: running bash shell renders the active dot regardless of stored status', (t) => {
  const renderer = setupRenderer(t);
  const html = renderer.renderToolShell({
    toolKind: 'Bash',
    callId: 'phase7_bash_running',
    displayToolName: 'Bash',
    summary: 'sleep 30',
    status: 'completed',
    statusLabel: 'Running',
    isRunning: true,
    durationLabel: '',
    defaultExpanded: true,
    input: { command: 'sleep 30' },
    inputJson: '{"command":"sleep 30"}',
    metadata: {},
    outputText: '',
  });
  assert.ok(html);
  assert.match(html, /class="status-dot status-dot--active"/);
  assert.match(html, /class="tool-call-status-label">Running</);
});

test('read shell prefers canonical path and accepts legacy file_path', (t) => {
  const renderer = setupRenderer(t);
  const base = {
    toolKind: 'Read', callId: 'read-path', domToken: 'read-path-token',
    displayToolName: 'Read', summary: 'Read canonical.md', status: 'completed',
    statusLabel: 'Success', isRunning: false, durationLabel: '', defaultExpanded: true,
    metadata: {}, outputText: 'contents',
  };
  const canonical = renderer.renderToolShell({
    ...base,
    input: { path: 'canonical.md', file_path: 'legacy.md' },
  });
  const legacy = renderer.renderToolShell({
    ...base,
    input: { file_path: 'legacy.md' },
  });
  assert.match(canonical, /canonical\.md/);
  assert.doesNotMatch(canonical, /legacy\.md/);
  assert.match(canonical, /aria-label="Copy file preview"/);
  assert.match(legacy, /legacy\.md/);
});

test('legacy/live Edit and Write shells share the lazy file diff presentation', (t) => {
  const renderer = setupRenderer(t);
  const base = {
    callId: 'call-edit', sessionId: 'session-a', displayToolName: 'Edit', summary: 'src/a.js',
    status: 'completed', statusLabel: 'Completed', isRunning: false, defaultExpanded: true,
    input: { path: 'src/a.js' }, outputText: '{"raw":true}',
    metadata: { diff: { diff_id: 'diff:live', additions: 1, deletions: 1, hunks: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }] } },
  };
  const edit = renderer.renderToolShell({ ...base, toolKind: 'Edit' });
  const write = renderer.renderToolShell({ ...base, toolKind: 'Write' });
  for (const html of [edit, write]) {
    assert.match(html, /class="file-diff"/);
    assert.match(html, /data-file-diff-pending/);
    assert.match(html, />−1</);
    assert.doesNotMatch(html, /&quot;raw&quot;|diff-hunk-header/);
  }
});

test('B3: monitor shell sources rich-normalized metadata byte-identically (single normalize source)', (t) => {
  const renderer = setupRenderer(t);
  const html = renderer.renderToolShell({
    toolKind: 'monitor',
    callId: 'call_monitor',
    summary: 'Monitoring',
    status: 'running',
    metadata: {
      monitor: {
        monitor_id: 'mon_1',
        description: 'Watching build output',
        state: 'running',
        persistent: true,
        timeout_ms: 30000,
        event_count: 2,
        dropped_event_count: 1,
        terminal_reason: '',
        exit_code: null,
        events: [
          { sequence: 1, stream: 'stdout', text: 'building...', timestamp: 't', elapsed_ms: 100 },
          { stream: 'stderr', text: 'warning: x' },
        ],
      },
    },
  });
  assert.ok(html, 'monitor shell should render');
  /* Pinned byte-for-byte against the pre-B3 (lean normalize) output. renderMonitorShell
   * now sources its monitor object from the rich renderer-monitor-tool-utils copy (the lean
   * duplicate was deleted); the rich copy must produce identical markup for every field the
   * shell reads. This is the regression gate for the previously-untested shell monitor path. */
  const expectedPanel = '<div class="tool-monitor-panel" data-monitor-state="running"><div class="tool-monitor-heading"><div class="tool-monitor-description">Watching build output</div><div class="tool-monitor-meta">running | timeout 30s | persistent | 2 events | 1 dropped</div></div><div class="tool-monitor-events"><div class="tool-monitor-event" data-monitor-stream="stdout"><span class="tool-monitor-event-stream">stdout</span><span class="tool-monitor-event-text">building...</span></div><div class="tool-monitor-event" data-monitor-stream="stderr"><span class="tool-monitor-event-stream">stderr</span><span class="tool-monitor-event-text">warning: x</span></div></div></div>';
  assert.ok(html.includes(expectedPanel), 'monitor panel markup must be byte-identical to the pre-B3 lean output');
});


/* Verification gate Wave 3: the `verify` verdict rides the tool-row header's
 * meta slot straight from the result metadata -- no second call. */
test('formatToolResultMeta renders a verify verdict and nothing for other tools', () => {
  const f = toolCallUtils.formatToolResultMeta;
  assert.equal(f('verify', {
    result_kind: 'verify', status: 'failed', action: 'gate',
    passed_count: 138, failed_count: 4, duration_ms: 21400, attempt: 2,
  }), 'Gate · Failed · 4 of 142 · 21.4s · attempt 2');
  assert.equal(f('verify', {
    result_kind: 'verify', status: 'passed', action: 'run', passed_count: 142, failed_count: 0, duration_ms: 21400,
  }), 'Passed · 142 · 21.4s');
  assert.equal(f('verify', { result_kind: 'verify', status: 'failed', action: 'run' }), 'Failed', 'no counts, no duration: still a verdict');
  assert.equal(f('verify', { result_kind: 'verify', status: 'skipped', action: 'gate', reason: 'already_running' }), 'Gate · Skipped · a run was in progress');
  assert.equal(f('verify', { result_kind: 'verify', status: 'skipped', action: 'gate', reason: 'no_gate_configured' }), 'Gate · Skipped');
  assert.equal(f('verify', { result_kind: 'verify', status: 'ok', action: 'list', configs: [] }), '', 'a listing has no verdict');
  assert.equal(f('verify', { result_kind: 'verify', status: 'failed', reason: 'config_not_found' }), 'Failed');
  assert.equal(f('verify', { result_kind: 'other', status: 'failed' }), '', 'foreign metadata is ignored');
  assert.equal(f('run_command', { result_kind: 'verify', status: 'failed' }), '', 'only the verify tool');
  assert.equal(f('verify', null), '');
});

test('buildToolHeaderInner shows the verify verdict in the meta slot, escaped', () => {
  const html = toolCallUtils.buildToolHeaderInner(
    { displayToolName: 'Verify', summary: 'Run the verification gate', status: 'completed', statusLabel: 'Completed', isRunning: false, durationLabel: '', secondaryMeta: 'Gate · Failed · 4 of 142 <b>' },
    { escapeHtml }
  );
  assert.match(html, /class="tool-call-meta">Gate · Failed · 4 of 142 &lt;b&gt;</);
});
