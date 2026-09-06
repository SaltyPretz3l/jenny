'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const taskBoardTool = require('../services/tools/builtin/task-board-tool');

function task(index, overrides = {}) {
  return {
    id: `task-${index}`,
    label: `Task ${index}`,
    body: '',
    status: 'active',
    sourceKind: 'agent_task',
    ...overrides,
  };
}

function createConfigService(followUps, { persist = true } = {}) {
  const state = { followUps: structuredClone(followUps) };
  let nextId = state.followUps.length + 1;
  const service = {
    upsertCalls: 0,
    getState: () => structuredClone(state),
    upsertFollowUp(input) {
      service.upsertCalls += 1;
      if (persist) state.followUps.push(task(nextId++, input));
      return service.getState();
    },
    updateFollowUp(id, patch) {
      if (!persist) return service.getState();
      const existing = state.followUps.find((entry) => entry.id === id);
      if (existing) Object.assign(existing, patch);
      return service.getState();
    },
    activateFollowUp(id) {
      if (persist) state.followUps.find((entry) => entry.id === id).status = 'active';
      return service.getState();
    },
    resolveFollowUp(id) {
      if (persist) state.followUps.find((entry) => entry.id === id).status = 'resolved';
      return service.getState();
    },
  };
  return service;
}

test('the 201st agent task is refused at the 200-task cap', async () => {
  const configService = createConfigService(Array.from({ length: 200 }, (_, index) => task(index)));

  const result = await taskBoardTool.execute({ action: 'add', title: 'Overflow' }, { configService });

  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'task_limit_reached');
  assert.match(result.content, /200/);
  assert.equal(configService.upsertCalls, 0);
});

test('list renders at most 200 rows and a trailer for hidden tasks', async () => {
  const configService = createConfigService(Array.from({ length: 201 }, (_, index) => task(index)));

  const result = await taskBoardTool.execute({ action: 'list' }, { configService });
  const lines = result.content.split('\n');

  assert.equal(result.isError, false);
  assert.equal(lines.length, 201);
  assert.equal(lines[199].startsWith('- id=task-199'), true);
  assert.equal(lines[200], '... and 1 more');
  assert.equal(result.metadata.count, 201);
});

test('blocked task updates and completion report persistence_failed', async () => {
  const configService = createConfigService([task(1)], { persist: false });

  const updated = await taskBoardTool.execute({
    action: 'update',
    id: 'task-1',
    title: 'Changed',
    notes: 'Changed notes',
    status: 'resolved',
  }, { configService });
  const completed = await taskBoardTool.execute({ action: 'complete', id: 'task-1' }, { configService });

  assert.equal(updated.isError, true);
  assert.equal(updated.metadata.reason, 'persistence_failed');
  assert.equal(completed.isError, true);
  assert.equal(completed.metadata.reason, 'persistence_failed');
});

test('a blank title is refused before any write instead of being saved as a placeholder', async () => {
  const configService = createConfigService([task(1)]);

  const result = await taskBoardTool.execute({ action: 'update', id: 'task-1', title: '   ' }, { configService });

  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, 'invalid_title');
  assert.equal(configService.getState().followUps[0].label, 'Task 1');
});
