'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../renderer/chat/renderer-subagent-monitor-view');
const progressView = require('../renderer/chat/renderer-transcript-agent-progress');
const { createTranscriptThinkingRenderer } = require('../renderer/chat/renderer-transcript-thinking');

const metadata = {
  subagent_report: {
    task_id: 'child-1',
    label: '<Inspect persistence>',
    status: 'failed',
    terminal_reason: 'deadline_exceeded',
    summary: '<script>alert(1)</script>',
    evidence: [{ relative_path: 'services/backend/store.js', summary: 'Canonical writer.' }],
    tools_used: ['read_file'],
    budget: { elapsed_ms: 1_500 },
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    error: { code: 'CMP-AGENT-0001', message: 'Timed out', retryable: true },
  },
};

test('terminal summary uses the inventory action primitive and stable inspector hook', () => {
  const html = view.renderTerminalSummary(metadata, { key: 'call-1' });
  assert.match(html, /<button/);
  assert.match(html, /data-subagent-open="call-1"/);
  assert.match(html, /aria-controls="subagentInspector"/);
  assert.match(html, /title="Open subagent monitor: &lt;Inspect persistence&gt;,/);
  assert.doesNotMatch(html, /<script>/);
});

test('live delegate source routes to the subagent summary without task-type metadata', () => {
  const step = {
    source: 'delegate',
    toolCallId: 'call-live',
    childTaskId: 'child-live',
    childOrdinal: 1,
    childCount: 1,
    childLabel: 'Task 1',
    status: 'running',
    startedAt: Date.now(),
  };

  const progressHtml = progressView.renderAgentProgressRow({ steps: [step] });
  const thinkingHtml = createTranscriptThinkingRenderer({
    escapeHtml(value) { return String(value); },
  }).renderAgentStatusWidget({ agent_status_steps: [step] });

  assert.match(progressHtml, /data-subagent-open="call-live"/);
  assert.match(thinkingHtml, /data-subagent-open="call-live"/);
});

test('live summary renders only the newest active delegate call', () => {
  const steps = [{
    source: 'delegate', toolCallId: 'call-older', childTaskId: 'child-older',
    childOrdinal: 1, childCount: 1, childLabel: 'Older task', status: 'completed',
    childTerminal: true, startedAt: 1_000, updatedAt: 1_500,
  }, {
    source: 'delegate', toolCallId: 'call-newer', childTaskId: 'child-newer',
    childOrdinal: 1, childCount: 1, childLabel: 'Newer task', status: 'running',
    startedAt: 2_000, updatedAt: 2_500,
  }];

  const html = view.renderLiveSummary(steps, { now: 3_000 });

  assert.match(html, /data-subagent-open="call-newer"/);
  assert.match(html, /1 subagent/);
  assert.doesNotMatch(html, /call-older/);
});
const modelUtils = require('../renderer/chat/renderer-subagent-monitor-model');

function batchModel(tasks, extra = {}) {
  return modelUtils.buildMonitorViewModel({ terminal: { kind: 'batch', report: { status: 'completed', tasks, ...extra } }, key: 'call-1' });
}

const CHILDREN = [
  { task_id: 'a', label: 'Survey <renderer>', status: 'completed', summary: 'Summary A.', budget: { elapsed_ms: 41_000, tool_results_used: 7 }, usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200, model: 'qwen-test' } },
  { task_id: 'b', label: 'Survey sidecar', status: 'failed', terminal_reason: 'budget_exhausted', summary: 'Summary B.', budget: { elapsed_ms: 12_000 } },
];

test('the tree page: parent row, one treeitem button per child, footer totals', () => {
  const parts = view.renderMonitor(batchModel(CHILDREN), { page: 'tree' });
  assert.match(parts.header, /<h2[^>]*>Subagents<\/h2>/);
  assert.match(parts.header, /data-subagent-close="true"/);
  assert.match(parts.body, /role="tree"/);
  assert.match(parts.body, /Jenny<\/span>/);
  assert.match(parts.body, /Delegated research/);
  const rows = parts.body.match(/<button[^>]*role="treeitem"[^>]*>/g) || [];
  assert.equal(rows.length, 2, 'each child is one actionButton treeitem');
  assert.match(rows[0], /data-subagent-select="a"/);
  assert.match(parts.body, /Survey &lt;renderer&gt;/);
  assert.match(parts.body, /Completed · <span>41s<\/span> · 7 steps/);
  assert.match(parts.body, /Failed · Reached its work limit/);
  assert.equal(parts.footer.replace(/<[^>]+>/g, ''), '2 tasks · 7 steps · 1.2k tokens');
  assert.doesNotMatch(parts.body, /subagent-monitor-master|subagent-monitor-detail\b/, 'no two-column markup');
});

test('the tree footer says "Tokens not reported" when no usage came back', () => {
  const parts = view.renderMonitor(batchModel([{ task_id: 'a', status: 'completed', summary: 'A' }, { task_id: 'b', status: 'completed', summary: 'B' }]), { page: 'tree' });
  assert.match(parts.footer, /Tokens not reported/);
  assert.doesNotMatch(parts.footer, /Unavailable/);
});

test('the drill-in page: back control, title and status line, steps, answer, evidence, uncertainties', () => {
  const steps = [
    { tool: 'read_file', display: 'Read file', ok: true, target: 'src/a.js' },
    { tool: 'read_file', display: 'Read file', ok: false, target: 'src/missing.js', detail: 'File not found', error_code: 'CMP-TOOL-1' },
  ];
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], steps, answer: '## Findings\n\n- one\n- two', uncertainties: ['Not sure about X'],
    evidence: [{ relative_path: 'services/backend/store.js', line_start: 8, line_end: 9, summary: 'Canonical writer.', provenance: 'tool_observed' }],
  }]), { page: 'detail' });
  assert.match(parts.header, /data-subagent-back="true"/);
  assert.match(parts.body, /Tool observed/, 'tool-observed provenance is labelled');
  assert.match(parts.header, /title="Back to subagent list"/);
  assert.match(parts.body, /<h2[^>]*class="subagent-detail-title"[^>]*>Survey &lt;renderer&gt;<\/h2>/);
  assert.match(parts.body, /Completed · <span>41s<\/span> · qwen-test/);
  assert.match(parts.body, /subagent-step--ok/);
  assert.match(parts.body, /subagent-step--error/);
  assert.match(parts.body, /<span class="subagent-step-detail">File not found<\/span>/);
  assert.match(parts.body, />Answer</);
  assert.match(parts.body, /Findings/, 'the answer renders through markdown, not as a raw paragraph');
  assert.doesNotMatch(parts.body, /## Findings/);
  assert.match(parts.body, /data-chat-path-open="services\/backend\/store.js"/);
  assert.match(parts.body, /services\/backend\/store.js:8-9/);
  assert.match(parts.body, />Uncertainties</);
  assert.match(parts.body, /Not sure about X/);
  assert.doesNotMatch(parts.body, /Technical details/, 'the technical disclosure is for errors only');
  assert.match(parts.footer, /1\.2k tokens/);
  assert.match(parts.footer, /data-inv-collapsible/, 'the usage grid sits behind a Details disclosure');
  assert.match(parts.footer, />Details</);
});

test('a script in the answer is escaped or sanitized, never injected', () => {
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], answer: 'Before <script>alert(1)</script> after <img src=x onerror=alert(2)>',
  }]), { page: 'detail' });
  assert.doesNotMatch(parts.body, /<script/i);
  assert.doesNotMatch(parts.body, /<img[^>]*onerror/i);
  assert.match(parts.body, /Before/, 'the text around the payload still renders');
  assert.match(parts.body, /after/);
});

test('a report without an answer shows its summary as Summary and says the answer was not kept', () => {
  const parts = view.renderMonitor(batchModel([CHILDREN[0]]), { page: 'detail' });
  assert.match(parts.body, /Summary A\./);
  assert.match(parts.body, />Summary</);
  assert.doesNotMatch(parts.body, />Answer</);
  assert.match(parts.body, /The full answer wasn&#39;t saved for this run\.|The full answer wasn't saved for this run\./);
});

test('a failed child without an answer shows its summary but no not-saved note', () => {
  const parts = view.renderMonitor(batchModel([CHILDREN[1]]), { page: 'detail' });
  assert.match(parts.body, /Summary B\./);
  assert.match(parts.body, />Summary</);
  assert.doesNotMatch(parts.body, /wasn/);
});

test('a report with an answer titles it Answer and adds no not-saved note', () => {
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], answer: 'Full answer.' }]), { page: 'detail' });
  assert.match(parts.body, />Answer</);
  assert.doesNotMatch(parts.body, /wasn/);
  assert.doesNotMatch(parts.body, /Summary A\./);
});

test('a report with no step log lists its tools and step count, never "not recorded"', () => {
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], tools_used: ['read_file'], steps: [], budget: { tool_results_used: 7, elapsed_ms: 1_000 },
  }]), { page: 'detail' });
  assert.match(parts.body, /<p class="subagent-step-note">read_file · 7 steps<\/p>/);
  assert.doesNotMatch(parts.body, /not recorded/);
});

test('more than eight steps collapse behind "+ N more"; unrecorded steps are noted', () => {
  const steps = Array.from({ length: 11 }, (_, index) => ({ tool: 'grep', display: `Step ${index}`, ok: true }));
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[0], steps, budget: { tool_results_used: 14, elapsed_ms: 1_000 },
  }]), { page: 'detail' });
  assert.match(parts.body, /\+ 3 more/);
  assert.equal((parts.body.match(/subagent-step subagent-step--ok/g) || []).length, 11, 'every recorded step renders (three inside the collapsible)');
  assert.match(parts.body, /class="inv-collapsible-content subagent-more-detail"[^>]*hidden/);
  assert.match(parts.body, /\+ 3 steps not recorded/);
});

test('a running child shows its live stage summary and the pending-steps placeholder', () => {
  const live = modelUtils.buildMonitorViewModel({ now: 5_000, steps: [{
    source: 'delegate', toolCallId: 'call-1', childTaskId: 'child-1', childOrdinal: 1, childCount: 1,
    childLabel: 'Live survey', status: 'running', summary: 'Reading the repo', startedAt: 1_000, updatedAt: 4_000,
  }], key: 'call-1' });
  const parts = view.renderMonitor(live, { page: 'detail' });
  assert.match(parts.body, /Reading the repo/);
  assert.match(parts.body, /Steps appear when this subagent finishes\./);
  assert.match(parts.body, /data-subagent-live-elapsed="child:child-1"/);
  assert.doesNotMatch(parts.body, />Answer</, 'no answer section while running');
});

test('an error child shows the technical details disclosure; the ids take the pane suffix', () => {
  const parts = view.renderMonitor(batchModel([{
    ...CHILDREN[1], error: { code: 'CMP-AGENT-0001', message: 'Timed out', retryable: true },
  }]), { page: 'detail', idSuffix: '-pane1' });
  assert.match(parts.body, /Technical details · CMP-AGENT-0001/);
  assert.match(parts.body, /id="subagentInspectorTitle-pane1"/);
  assert.ok([...parts.body.matchAll(/ id="([^"]+)"/g)].every((match) => match[1].endsWith('-pane1')), 'every id is suffixed');
});

test('old reports without steps fall back to the tool names', () => {
  const parts = view.renderMonitor(batchModel([{ ...CHILDREN[0], budget: { elapsed_ms: 1_000 }, tools_used: ['read_file', 'grep'] }]), { page: 'detail' });
  assert.match(parts.body, /read_file · grep/);
});
