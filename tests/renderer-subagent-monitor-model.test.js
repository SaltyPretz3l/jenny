'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/chat/renderer-subagent-monitor-model');

function liveStep(overrides = {}) {
  return {
    source: 'subagent_batch',
    toolCallId: 'call-1',
    childTaskId: 'child-1',
    childAgentId: 'research@request:call:1',
    childOrdinal: 1,
    childCount: 2,
    childLabel: 'Inspect persistence',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_500,
    ...overrides,
  };
}

test('live monitor ignores the batch aggregate frame and models sequential children', () => {
  const result = model.buildMonitorViewModel({
    now: 5_000,
    steps: [
      { source: 'subagent_batch', toolCallId: 'call-1', taskId: 'batch-1', status: 'running' },
      liveStep(),
      liveStep({ childTaskId: 'child-2', childOrdinal: 2, childLabel: 'Inspect renderer', status: 'queued' }),
    ],
  });
  assert.equal(result.childCount, 2);
  assert.equal(result.children[0].label, 'Inspect persistence');
  assert.equal(result.parentState, 'Waiting on child');
  assert.equal(result.elapsedMs, 4_000);
});

test('live monitor also ignores the delegate aggregate frame', () => {
  const result = model.buildMonitorViewModel({
    steps: [
      { source: 'delegate', toolCallId: 'call-1', taskId: 'batch-1', status: 'running' },
      liveStep({ source: 'delegate' }),
    ],
  });

  assert.equal(result.childCount, 1);
});

test('queued delegate siblings keep the aggregate live after one task settles', () => {
  const result = model.buildMonitorViewModel({
    steps: [
      { source: 'delegate', toolCallId: 'call-1', taskId: 'batch-1', status: 'running' },
      liveStep({
        source: 'delegate', childTaskId: 'child-1', childOrdinal: 1,
        childCount: 3, status: 'completed', childTerminal: true,
      }),
      liveStep({
        source: 'delegate', childTaskId: 'child-2', childOrdinal: 2,
        childCount: 3, status: 'queued', childTerminal: false,
      }),
      liveStep({
        source: 'delegate', childTaskId: 'child-3', childOrdinal: 3,
        childCount: 3, status: 'queued', childTerminal: false,
      }),
    ],
  });

  assert.equal(result.childCount, 3);
  assert.equal(result.status, 'running');
  assert.equal(result.terminal, false);
  assert.equal(result.parentState, 'Waiting on child');
});

test('live selection keeps separate delegate calls in separate monitor groups', () => {
  const selected = model.selectLiveDelegationSteps([
    liveStep({
      toolCallId: 'call-older', childTaskId: 'older-child', childCount: 1,
      status: 'completed', childTerminal: true, updatedAt: 1_500,
    }),
    liveStep({
      toolCallId: 'call-newer', childTaskId: 'newer-child', childCount: 1,
      status: 'running', updatedAt: 2_000,
    }),
  ]);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].toolCallId, 'call-newer');
});

test('terminal evidence preserves tool provenance and line ranges', () => {
  const terminal = {
    kind: 'batch',
    report: {
      status: 'completed',
      tasks: [{
        task_id: 'child-1', status: 'completed', summary: 'Done.', tools_used: [],
        evidence: [{
          source_tool: 'read_file', relative_path: 'package.json', line_start: 8,
          line_end: 8, quote: 'npm test', provenance: 'tool_observed',
        }],
      }],
    },
  };

  const result = model.buildMonitorViewModel({ terminal });
  assert.equal(result.selected.evidence[0].provenance, 'tool_observed');
  assert.equal(result.selected.evidence[0].line_start, 8);
});

test('validated terminal report takes precedence over stale advisory progress', () => {
  const terminal = {
    kind: 'single',
    report: {
      task_id: 'child-1',
      label: 'Inspect persistence',
      status: 'completed',
      summary: 'Canonical persistence is verified.',
      evidence: [{ relative_path: 'services/backend/store.js', summary: 'Writer.' }],
      tools_used: ['read_file'],
      budget: { elapsed_ms: 3_200 },
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  };
  const result = model.buildMonitorViewModel({ steps: [liveStep()], terminal });
  assert.equal(result.authoritative, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.selected.summary, 'Canonical persistence is verified.');
  assert.equal(result.elapsedMs, 3_200);
  assert.equal(result.usage.total_tokens, 120);
});

test('plain-language terminal copy covers timeout, work limit, and capacity', () => {
  assert.equal(model.terminalCopy('deadline_exceeded', 'failed'), 'Ran out of time');
  assert.equal(model.terminalCopy('budget_exhausted', 'partial'), 'Reached its work limit');
  assert.equal(model.terminalCopy('capacity_unavailable', 'rejected'), 'Did not start — no subagent slot was available');
});

test('message reconciliation associates live and terminal state by tool call id', () => {
  const messages = [{ agent_status_steps: [liveStep()] }, {
    tool_result: {
      call_id: 'call-1',
      metadata: { subagent_report: { task_id: 'child-1', label: 'Inspect persistence', status: 'completed', summary: 'Done.' } },
    },
  }, { role: 'assistant', content: 'Here is the synthesized result.' }];
  const result = model.buildMonitorFromMessages(messages, 'call-1');
  assert.equal(result.authoritative, true);
  assert.equal(result.childCount, 1);
  assert.equal(result.selected.summary, 'Done.');
  assert.equal(result.parentStateKey, 'done', 'a settled answer after the report: the delegation is done');
  assert.equal(result.parentState, 'Completed');
});

test('the report maps a bounded step log, the full answer and a step count that survives unrecorded steps', () => {
  const steps = Array.from({ length: 45 }, (_, index) => ({
    tool: 'read_file', display: `Read ${index}`, ok: index !== 3, target: `src/file-${index}.js`,
    ...(index === 3 ? { error_code: 'CMP-TOOL-0001', detail: 'File not found' } : {}),
    secret: 'dropped',
  }));
  const child = model.buildMonitorViewModel({
    terminal: { kind: 'single', report: {
      task_id: 'child-1', status: 'completed', summary: 'Short.', answer: 'A'.repeat(4_500), steps,
      budget: { tool_results_used: 50, elapsed_ms: 41_000 },
      usage: { total_tokens: 2_400, model: 'qwen-test' },
    } },
  }).selected;
  assert.equal(child.steps.length, 40, 'steps are capped at 40');
  assert.equal(child.answer.length, 4_000, 'the answer is capped at 4000');
  assert.equal(child.stepCount, 50, 'the step count is the larger of the log and tool_results_used');
  assert.equal(child.steps[3].ok, false);
  assert.equal(child.steps[3].detail, 'File not found');
  assert.equal(Object.hasOwn(child.steps[3], 'errorCode'), false, 'a step-level code is not surfaced');
  assert.equal(Object.hasOwn(child.steps[0], 'secret'), false, 'unknown step keys are dropped');
  assert.equal(child.model, 'qwen-test');
  assert.equal(child.elapsedMs, 41_000);
});

test('an old report without steps or an answer still maps', () => {
  const child = model.buildMonitorViewModel({
    terminal: { kind: 'single', report: { task_id: 'child-1', status: 'completed', summary: 'Done.', tools_used: ['grep'] } },
  }).selected;
  assert.deepEqual(child.steps, []);
  assert.equal(child.answer, '');
  assert.equal(child.stepCount, 0);
});

test('the parent state is i18n copy with a stable key, and tokens read "Tokens not reported"', () => {
  const responding = model.buildMonitorViewModel({
    terminal: { kind: 'single', report: { task_id: 'c', status: 'completed', summary: 'Done.' } },
    parentResponding: true,
  });
  assert.equal(responding.parentState, 'Responding');
  assert.equal(responding.parentStateKey, 'responding');
  const waiting = model.buildMonitorViewModel({ steps: [liveStep(), liveStep({ childTaskId: 'child-2', childOrdinal: 2, status: 'completed', childTerminal: true })] });
  assert.equal(waiting.parentStateKey, 'waiting');
  assert.equal(waiting.runningCount, 1);
  assert.equal(model.formatTokens(undefined), 'Tokens not reported');
  assert.equal(model.formatTokens(2_400), '2.4k');
});

test('live children carry their own elapsed time; the totals sum steps and tokens', () => {
  const live = model.buildMonitorViewModel({ now: 5_000, steps: [liveStep({ startedAt: 2_000 })] });
  assert.equal(live.children[0].elapsedMs, 3_000);
  const batch = model.buildMonitorViewModel({ terminal: { kind: 'batch', report: { status: 'completed', tasks: [
    { task_id: 'a', status: 'completed', summary: 'A', budget: { tool_results_used: 7 }, usage: { total_tokens: 100 } },
    { task_id: 'b', status: 'completed', summary: 'B', budget: { tool_results_used: 5 }, usage: { total_tokens: 300 } },
  ] } } });
  assert.equal(batch.totalSteps, 12);
  assert.equal(batch.totalTokens, 400);
  assert.equal(batch.children[0].statusLabel, 'Completed');
});

test('terminalCopy is the status word unless the report names a reason', () => {
  assert.equal(model.terminalCopy('', 'failed'), 'Failed');
  assert.equal(model.terminalCopy('deadline_exceeded', 'failed'), 'Ran out of time');
  assert.equal(model.terminalCopy('', 'running'), 'Running');
  assert.equal(model.terminalCopy(undefined, 'partial'), 'Partially completed');
});

test('HB-019: the parent reads Responding only while its answer streams, then the status copy', () => {
  const report = { subagent_batch_report: { status: 'completed', tasks: [
    { task_id: 'a', status: 'completed', summary: 'A' },
    { task_id: 'b', status: 'completed', summary: 'B' },
  ] } };
  const toolRow = { role: 'assistant', tool_result: { call_id: 'call-1', metadata: report } };
  const streaming = model.buildMonitorFromMessages([toolRow, { role: 'assistant', content: 'Both lists', status: 'streaming' }], 'call-1');
  assert.equal(streaming.parentStateKey, 'responding');
  assert.equal(streaming.parentState, 'Responding');
  const settled = model.buildMonitorFromMessages([toolRow, { role: 'assistant', content: 'Both lists' }], 'call-1');
  assert.equal(settled.parentStateKey, 'done');
  assert.equal(settled.parentState, 'Completed');
  const noAnswerYet = model.buildMonitorFromMessages([toolRow], 'call-1');
  assert.equal(noAnswerYet.parentStateKey, 'synthesizing');
});

test('settled advisory child duration freezes while another child continues', () => {
  const steps = [liveStep({ status: 'completed', childTerminal: true, updatedAt: 2_000 }),
    liveStep({ childTaskId: 'child-2', childOrdinal: 2, updatedAt: 3_000 })];
  const first = model.buildMonitorViewModel({ steps, now: 5_000, selectedKey: 'child-1' });
  const later = model.buildMonitorViewModel({ steps, now: 9_000, selectedKey: 'child-1' });
  assert.equal(first.children[0].elapsedMs, 1_000);
  assert.equal(later.children[0].elapsedMs, 1_000);
  assert.equal(later.children[1].elapsedMs, 8_000);
});
