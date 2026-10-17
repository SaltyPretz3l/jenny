'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { normalizeAgentProgressNotification } = require('../services/backend/work-lifecycle-coordinator');
const { appendAgentStatusStep } = require('../renderer/chat/renderer-stream-handler-agent-status');
const model = require('../renderer/chat/renderer-subagent-monitor-model');
const view = require('../renderer/chat/renderer-subagent-monitor-view');
const { normalizeSubagentMetadata } = require('../services/backend/subagent-report-metadata');
const { buildAgentProgressSnapshot } = require('../renderer/chat/renderer-stream-handler-terminal-merge');

function frame(sequence, overrides = {}) {
  return normalizeAgentProgressNotification({
    request_id: 'parent', session_id: 'session', task_id: 'batch', task_type: 'sub_agent',
    source: 'delegate', tool_call_id: 'call', child_task_id: 'child', child_agent_id: 'child-agent',
    child_label: 'Inspect the repository', child_ordinal: 1, child_count: 1,
    status: 'running', model: 'codex-cli/gpt-test', reasoning_effort: 'low',
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    child_activity: { sequence, steps: [{ tool: 'read_file', display: 'Read', status: 'running', target: '../secret' }],
      step_count: 1, text: 'Checking the files. <script>alert(1)</script>', visible_output_tokens_estimate: 5 },
    ...overrides,
  });
}

test('wire snapshot reaches running detail, rejects replay, and yields to terminal report', () => {
  const incoming = frame(2);
  assert.equal(incoming.model, 'codex-cli/gpt-test');
  assert.equal(incoming.childActivity.steps[0].target, undefined);
  let steps = appendAgentStatusStep([], incoming);
  steps = appendAgentStatusStep(steps, frame(1, { summary: 'obsolete' }));
  assert.equal(steps[0].childActivity.sequence, 2);
  let vm = model.buildMonitorViewModel({ steps });
  let parts = view.renderMonitor(vm, { page: 'detail' });
  assert.match(parts.body, /Live response/);
  assert.match(parts.body, /subagent-monitor-dot--pending/);
  assert.doesNotMatch(parts.body, /<script>/);
  assert.match(parts.footer, /110 tokens/);
  assert.match(parts.footer, /~5 visible-output tokens/);
  const report = normalizeSubagentMetadata({ subagent_batch_report: {
    batch_id: 'batch', status: 'completed', tasks: [{ task_id: 'child', status: 'completed', summary: 'Done',
      answer: 'Final answer', evidence: [], tools_used: ['read_file'], uncertainties: [],
      steps: [{ tool: 'read_file', ok: true }], model: 'codex-cli/gpt-test', reasoning_effort: 'low',
      child_activity: incoming.childActivity,
    }],
  } });
  assert.equal(report.subagent_batch_report.tasks[0].child_activity, undefined);
  vm = model.buildMonitorViewModel({ steps, terminal: model.extractTerminalReport(report) });
  parts = view.renderMonitor(vm, { page: 'detail' });
  assert.match(parts.body, /Final answer/);
  assert.doesNotMatch(parts.body, /Live response|Checking the files/);
  assert.doesNotMatch(parts.footer, /visible-output/);
});

test('terminal child rejects late nonterminal activity and missing usage remains partial', () => {
  let steps = appendAgentStatusStep([], frame(3, { status: 'completed', child_terminal: true }));
  steps = appendAgentStatusStep(steps, frame(4));
  assert.equal(steps[0].status, 'completed');
  const second = frame(1, { child_task_id: 'child-2', child_ordinal: 2, usage: null });
  steps = appendAgentStatusStep(steps, second);
  const vm = model.buildMonitorViewModel({ steps });
  assert.equal(vm.totalTokens, 110);
  assert.equal(vm.partialUsage, true);
  assert.equal(buildAgentProgressSnapshot({ agent_status_steps: steps }, [], true)[0].childActivity, undefined);
});

test('long catalog model IDs survive transport and monitor metadata', () => {
  const modelId = `codex-cli/${'m'.repeat(128)}`;
  const steps = appendAgentStatusStep([], frame(1, { model: modelId }));
  assert.equal(model.buildMonitorViewModel({ steps }).selected.model, modelId);
});

test('partial generation accounting stays labeled in tree and child detail', () => {
  const steps = appendAgentStatusStep([], frame(1, { usage: { total_tokens: 14, partial: true } }));
  const vm = model.buildMonitorViewModel({ steps });
  assert.equal(vm.partialUsage, true);
  assert.match(view.renderMonitor(vm, { page: 'tree' }).footer, /partially reported/);
  assert.match(view.renderMonitor(vm, { page: 'detail' }).footer, /partially reported/);
});

test('live repaint preserves expanded usage, scroll position and keyboard focus', () => {
  const dom = new JSDOM('<main></main>');
  const host = dom.window.document.querySelector('main');
  const vm = model.buildMonitorViewModel({ steps: [frame(1)] });
  const parts = view.renderMonitor(vm, { page: 'detail' });
  const html = parts.body + parts.footer;
  host.innerHTML = html;
  const trigger = host.querySelector('[data-inv-collapsible]');
  trigger.setAttribute('aria-expanded', 'true');
  trigger.focus();
  host.querySelector('.subagent-monitor-body').scrollTop = 75;
  view.preserveLiveState(host, () => { host.innerHTML = html; });
  assert.equal(host.querySelector('.subagent-monitor-body').scrollTop, 75);
  assert.equal(host.querySelector('[data-inv-collapsible]').getAttribute('aria-expanded'), 'true');
  assert.equal(host.querySelector('.inv-collapsible-content').hidden, false);
  assert.equal(dom.window.document.activeElement.getAttribute('data-inv-collapsible'), trigger.getAttribute('data-inv-collapsible'));
  dom.window.close();
});


test('never-started children do not imply partial usage', () => {
  const steps = appendAgentStatusStep([], frame(1));
  steps.push({ childTaskId: 'never', childLabel: 'Never started', taskType: 'sub_agent', source: 'delegate', status: 'rejected', childTerminal: true });
  assert.equal(model.buildMonitorViewModel({ steps }).partialUsage, false);
});

test('actual stream handler normalizes snapshots and rejects late child frames', async (t) => {
  const { createHarness } = require('./helpers/renderer-stream-handler-harness');
  const harness = createHarness(); t.after(() => harness.restore());
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-live' });
  const event = { ...frame(2), type: 'agent_status', sessionId: 'session-1', streamId: 'stream-live', childTerminal: true, status: 'cancelled' };
  await harness.emit(event);
  const messages = harness.state.messagesBySession.get('session-1');
  const pending = messages.find((row) => row.agent_status_steps?.length);
  assert.ok(pending); assert.equal(pending.agent_status.childActivity.steps[0].target, undefined);
  const snapshot = pending.agent_status;
  await harness.emit({ ...event, childTerminal: false, status: 'running', childActivity: { ...event.childActivity, sequence: 3, text: 'late' } });
  const after = harness.state.messagesBySession.get('session-1').find((row) => row.agent_status_steps?.length);
  assert.deepEqual(after.agent_status, snapshot);
  assert.equal(after.agent_status_steps[0].status, 'cancelled');
});


test('real failed/rejected reports do not imply missing provider usage', () => {
  for (const terminal_reason of ['rejected', 'capacity_unavailable']) {
    const vm = model.buildMonitorViewModel({ terminal: { kind: 'batch', report: {
      status: 'partial', tasks: [
        { status: 'completed', usage: { total_tokens: 14 } },
        { status: 'failed', terminal_reason, usage: null },
      ],
    } } });
    assert.equal(vm.totalTokens, 14);
    assert.equal(vm.partialUsage, false);
  }
});
