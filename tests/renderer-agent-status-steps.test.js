const test = require('node:test');
const assert = require('node:assert/strict');

const { appendAgentStatusStep } = require('../renderer/chat/renderer-stream-handler');

function mkStep(partial) {
  return {
    taskId: 'task-a',
    streamId: 'stream-a',
    taskType: 'local_agent',
    source: 'local_agent',
    status: 'running',
    stage: 'planning',
    percent: 10,
    summary: 'Planning',
    terminal: false,
    success: false,
    updatedAt: 1000,
    ...partial,
  };
}

test('appendAgentStatusStep: new stage appends and stamps startedAt', () => {
  const result = appendAgentStatusStep([], mkStep({ stage: 'planning', updatedAt: 1000 }));
  assert.equal(result.length, 1);
  assert.equal(result[0].stage, 'planning');
  assert.equal(result[0].startedAt, 1000);
  assert.equal(result[0].updatedAt, 1000);
});

test('appendAgentStatusStep: same key updates in place and preserves startedAt', () => {
  const first = appendAgentStatusStep([], mkStep({ stage: 'planning', percent: 10, updatedAt: 1000 }));
  const second = appendAgentStatusStep(first, mkStep({ stage: 'planning', percent: 75, summary: 'Almost done', updatedAt: 2500 }));
  assert.equal(second.length, 1);
  assert.equal(second[0].startedAt, 1000, 'startedAt preserved');
  assert.equal(second[0].updatedAt, 2500, 'updatedAt bumped');
  assert.equal(second[0].percent, 75);
  assert.equal(second[0].summary, 'Almost done');
});

test('appendAgentStatusStep: distinct stages create separate entries', () => {
  let list = appendAgentStatusStep([], mkStep({ stage: 'planning', updatedAt: 1000 }));
  list = appendAgentStatusStep(list, mkStep({ stage: 'gathering_context', updatedAt: 2000 }));
  list = appendAgentStatusStep(list, mkStep({ stage: 'synthesizing', updatedAt: 3000 }));
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((s) => s.stage), ['planning', 'gathering_context', 'synthesizing']);
});

test('appendAgentStatusStep: terminal step is not overwritten by later non-terminal with same key', () => {
  const first = appendAgentStatusStep([], mkStep({ stage: 'planning', terminal: true, success: true, updatedAt: 1000 }));
  const second = appendAgentStatusStep(first, mkStep({ stage: 'planning', terminal: false, percent: 50, updatedAt: 2000 }));
  assert.equal(second.length, 1);
  assert.equal(second[0].terminal, true);
  assert.equal(second[0].success, true);
  assert.equal(second[0].updatedAt, 1000, 'terminal step untouched');
});

test('appendAgentStatusStep: empty stage buckets under "working"', () => {
  const result = appendAgentStatusStep([], mkStep({ stage: '', updatedAt: 1000 }));
  assert.equal(result[0].stage, 'working');
  const again = appendAgentStatusStep(result, mkStep({ stage: '', percent: 40, updatedAt: 2000 }));
  assert.equal(again.length, 1, 'subsequent blank-stage updates coalesce under working');
  assert.equal(again[0].percent, 40);
});

test('appendAgentStatusStep: 24-entry cap drops oldest non-terminal on overflow', () => {
  let list = [];
  for (let i = 0; i < 24; i += 1) {
    list = appendAgentStatusStep(list, mkStep({
      stage: `stage_${i}`,
      terminal: i === 0 || i === 1,
      success: i === 0,
      updatedAt: 1000 + i,
    }));
  }
  assert.equal(list.length, 24);
  const extra = appendAgentStatusStep(list, mkStep({ stage: 'stage_extra', updatedAt: 9999 }));
  assert.equal(extra.length, 24);
  const stages = extra.map((s) => s.stage);
  assert.ok(stages.includes('stage_0'), 'terminal stage_0 retained');
  assert.ok(stages.includes('stage_1'), 'terminal stage_1 retained');
  assert.ok(stages.includes('stage_extra'));
  assert.ok(!stages.includes('stage_2'), 'oldest non-terminal (stage_2) evicted');
});

test('appendAgentStatusStep: falls back to streamId in key when taskId empty', () => {
  const first = appendAgentStatusStep([], mkStep({ taskId: '', streamId: 'stream-x', stage: 'working', updatedAt: 1000 }));
  const second = appendAgentStatusStep(first, mkStep({ taskId: '', streamId: 'stream-x', stage: 'working', percent: 80, updatedAt: 2000 }));
  assert.equal(second.length, 1);
  assert.equal(second[0].percent, 80);
});

test('appendAgentStatusStep: clamps percent and coerces flags', () => {
  const result = appendAgentStatusStep([], mkStep({ percent: 250, terminal: 1, success: 'yes' }));
  assert.equal(result[0].percent, 100);
  assert.equal(result[0].terminal, false, 'terminal requires === true');
  assert.equal(result[0].success, false, 'success requires === true');
});

test('appendAgentStatusStep: undefined existing treated as empty', () => {
  const result = appendAgentStatusStep(undefined, mkStep({ stage: 'planning' }));
  assert.equal(result.length, 1);
});
