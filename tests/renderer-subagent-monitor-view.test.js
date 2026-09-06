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
test('inspector renders tree, escaped details, evidence path hook, and expandable usage', () => {
  const model = require('../renderer/chat/renderer-subagent-monitor-model').buildMonitorViewModel({
    terminal: { kind: 'single', report: metadata.subagent_report },
    key: 'call-1',
  });
  const html = view.renderInspector(model, { compact: false, compactDetail: false });
  assert.match(html, /role="tree"/);
  assert.match(html, /&lt;Inspect persistence&gt;/);
  assert.match(html, /data-chat-path-open="services\/backend\/store.js"/);
  assert.match(html, /15 tokens/);
  assert.match(html, /Technical details/);
  assert.match(html, /title="Close subagent monitor"/);
  assert.match(view.renderInspector(model, { compactDetail: true }), /title="Back to subagent list"/);
  assert.doesNotMatch(html, /<script>/);
});

test('inspector renders delegate evidence line ranges and provenance copy', () => {
  const model = require('../renderer/chat/renderer-subagent-monitor-model').buildMonitorViewModel({
    terminal: {
      kind: 'batch',
      report: {
        status: 'completed',
        tasks: [{
          task_id: 'child-1', status: 'completed', summary: 'Done.', tools_used: [],
          evidence: [{
            source_tool: 'read_file', relative_path: 'package.json', line_start: 8,
            line_end: 9, quote: 'npm test', provenance: 'tool_observed',
          }],
        }],
      },
    },
  });
  const html = view.renderInspector(model);

  assert.match(html, /package\.json:8-9/);
  assert.match(html, /Tool observed/);
});
