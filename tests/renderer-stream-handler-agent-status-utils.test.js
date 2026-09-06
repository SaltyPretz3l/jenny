const test = require('node:test');
const assert = require('node:assert/strict');

const agentStatusUtils = require('../renderer/chat/renderer-stream-handler-agent-status');
const streamHandlerModule = require('../renderer/chat/renderer-stream-handler');

const {
  PHASE_SUMMARY_MAX_LENGTH,
  AGENT_STATUS_STEPS_MAX,
  normalizePhaseSummary,
  normalizeAgentStatusStep,
  appendAgentStatusStep,
} = agentStatusUtils;

test('normalizePhaseSummary: empty/whitespace input returns empty string', () => {
  assert.equal(normalizePhaseSummary(undefined), '');
  assert.equal(normalizePhaseSummary(null), '');
  assert.equal(normalizePhaseSummary(''), '');
  assert.equal(normalizePhaseSummary('   '), '');
  assert.equal(normalizePhaseSummary('\n\t  \n'), '');
});

test('normalizePhaseSummary: collapses internal whitespace to single spaces', () => {
  assert.equal(normalizePhaseSummary('hello\n\tworld'), 'hello world');
  assert.equal(normalizePhaseSummary('a  b  c'), 'a b c');
  assert.equal(normalizePhaseSummary('  leading and trailing  '), 'leading and trailing');
});

test('normalizePhaseSummary: passes through under-cap input verbatim', () => {
  const short = 'planning the next step';
  assert.equal(normalizePhaseSummary(short), short);
});

test('normalizePhaseSummary: preserves exactly-cap-length input without ellipsis', () => {
  const exact = 'x'.repeat(PHASE_SUMMARY_MAX_LENGTH);
  const result = normalizePhaseSummary(exact);
  assert.equal(result.length, PHASE_SUMMARY_MAX_LENGTH);
  assert.equal(result.endsWith('...'), false);
});

test('normalizePhaseSummary: truncates over-cap input with ellipsis', () => {
  const overflow = 'a'.repeat(PHASE_SUMMARY_MAX_LENGTH + 50);
  const result = normalizePhaseSummary(overflow);
  assert.equal(result.length, PHASE_SUMMARY_MAX_LENGTH);
  assert.equal(result.endsWith('...'), true);
  assert.equal(result.slice(0, PHASE_SUMMARY_MAX_LENGTH - 3), 'a'.repeat(PHASE_SUMMARY_MAX_LENGTH - 3));
});

test('normalizeAgentStatusStep: falls back to "working" when stage is missing', () => {
  const step = normalizeAgentStatusStep({ taskId: 't', percent: 50 });
  assert.equal(step.stage, 'working');
  assert.equal(step.key, 't::working');
});

test('normalizeAgentStatusStep: clamps percent to [0, 100] and rounds', () => {
  assert.equal(normalizeAgentStatusStep({ percent: -25 }).percent, 0);
  assert.equal(normalizeAgentStatusStep({ percent: 250 }).percent, 100);
  assert.equal(normalizeAgentStatusStep({ percent: 42.7 }).percent, 43);
  assert.equal(normalizeAgentStatusStep({ percent: 42.4 }).percent, 42);
});

test('normalizeAgentStatusStep: non-finite percent defaults to 0', () => {
  assert.equal(normalizeAgentStatusStep({ percent: NaN }).percent, 0);
  assert.equal(normalizeAgentStatusStep({ percent: Infinity }).percent, 0);
  assert.equal(normalizeAgentStatusStep({ percent: 'abc' }).percent, 0);
  assert.equal(normalizeAgentStatusStep({}).percent, 0);
});

test('normalizeAgentStatusStep: strict boolean coercion for terminal/success', () => {
  const truthyNotTrue = normalizeAgentStatusStep({ terminal: 1, success: 'yes' });
  assert.equal(truthyNotTrue.terminal, false);
  assert.equal(truthyNotTrue.success, false);

  const strictTrue = normalizeAgentStatusStep({ terminal: true, success: true });
  assert.equal(strictTrue.terminal, true);
  assert.equal(strictTrue.success, true);
});

test('normalizeAgentStatusStep: updatedAt falls back to Date.now() when non-finite', () => {
  const before = Date.now();
  const step = normalizeAgentStatusStep({ updatedAt: 'not a number' });
  const after = Date.now();
  assert.ok(step.updatedAt >= before && step.updatedAt <= after);
});

test('normalizeAgentStatusStep: key composition uses taskId, falls back to streamId, then empty', () => {
  assert.equal(normalizeAgentStatusStep({ taskId: 't', streamId: 's', stage: 'planning' }).key, 't::planning');
  assert.equal(normalizeAgentStatusStep({ taskId: '', streamId: 's', stage: 'planning' }).key, 's::planning');
  assert.equal(normalizeAgentStatusStep({ taskId: '', streamId: '', stage: 'planning' }).key, '::planning');
});

test('normalizeAgentStatusStep: preserves child and parent agent identity', () => {
  const step = normalizeAgentStatusStep({
    taskId: 'task-1',
    agentId: 'research@req:call:1',
    parentAgentId: 'main@req',
  });
  assert.equal(step.agentId, 'research@req:call:1');
  assert.equal(step.parentAgentId, 'main@req');
});

test('normalizeAgentStatusStep retains monitor identity and normalized terminal usage', () => {
  const step = normalizeAgentStatusStep({
    taskId: 'batch-1', source: 'subagent_batch', toolCallId: 'call-1',
    childTaskId: 'child-1', childAgentId: 'research@req:call:1',
    childOrdinal: 1, childCount: 2, childLabel: 'Inspect persistence',
    childTerminal: true, childSuccess: true, provider: 'ollama', model: 'qwen3.5',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, raw_usage: { prompt: 'drop' } },
    terminalReason: 'deadline_exceeded',
  });
  assert.equal(step.key, 'child-1');
  assert.equal(step.toolCallId, 'call-1');
  assert.equal(step.childLabel, 'Inspect persistence');
  assert.equal(step.childTerminal, true);
  assert.equal(step.provider, 'ollama');
  assert.deepEqual(step.usage, {
    input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated: false,
  });
  assert.equal(step.terminalReason, 'deadline_exceeded');
});

test('appendAgentStatusStep replaces queued/running/terminal frames for the same child', () => {
  const queued = appendAgentStatusStep([], {
    childTaskId: 'child-1', source: 'subagent_batch', status: 'queued', updatedAt: 1,
  });
  const running = appendAgentStatusStep(queued, {
    childTaskId: 'child-1', source: 'subagent_batch', status: 'running', updatedAt: 2,
  });
  const terminal = appendAgentStatusStep(running, {
    childTaskId: 'child-1', source: 'subagent_batch', status: 'completed', childTerminal: true, updatedAt: 3,
  });
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].status, 'completed');
  assert.equal(running[0].startedAt, 2, 'queued time is not counted as child runtime');
  assert.equal(terminal[0].startedAt, running[0].startedAt);
});

test('appendAgentStatusStep: enforces the AGENT_STATUS_STEPS_MAX cap', () => {
  assert.equal(AGENT_STATUS_STEPS_MAX, 24);
  let list = [];
  for (let i = 0; i < AGENT_STATUS_STEPS_MAX + 5; i += 1) {
    list = appendAgentStatusStep(list, { stage: `stage_${i}`, updatedAt: 1000 + i });
  }
  assert.equal(list.length, AGENT_STATUS_STEPS_MAX);
});

test('sibling export identity: main stream-handler re-exports appendAgentStatusStep from this sibling', () => {
  assert.equal(
    streamHandlerModule.appendAgentStatusStep,
    appendAgentStatusStep,
    'stream-handler re-export must be the same reference as the agent-status sibling export — diverged copies would silently break the contract'
  );
});
