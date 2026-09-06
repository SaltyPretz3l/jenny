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
  assert.equal(result.parentState, 'Responding');
});
