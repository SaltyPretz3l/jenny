'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const taskBoardTool = require('../services/tools/builtin/task-board-tool');

function createConfigService() {
  const state = { followUps: [] };
  let nextId = 1;
  const service = {
    getState: () => structuredClone(state),
    upsertFollowUp(input) {
      state.followUps.push({ id: `task-${nextId++}`, ...input });
      return service.getState();
    },
    updateFollowUp(id, patch) {
      Object.assign(state.followUps.find((entry) => entry.id === id), patch);
      return service.getState();
    },
    activateFollowUp(id) {
      state.followUps.find((entry) => entry.id === id).status = 'active';
      return service.getState();
    },
    resolveFollowUp(id) {
      state.followUps.find((entry) => entry.id === id).status = 'resolved';
      return service.getState();
    },
  };
  return service;
}

test('only add metadata includes the bounded persisted task title', async () => {
  const configService = createConfigService();
  const title = `${'A'.repeat(98)}\n${'B'.repeat(100)}`;
  const added = await taskBoardTool.execute({ action: 'add', title }, { configService });
  const taskId = added.metadata.task_id;

  assert.equal(taskId, 'task-1');
  assert.equal(added.metadata.task_title.includes('\n'), false);
  assert.ok(added.metadata.task_title.length <= 200);

  const updated = await taskBoardTool.execute({ action: 'update', id: taskId, title: 'Updated' }, { configService });
  const completed = await taskBoardTool.execute({ action: 'complete', id: taskId }, { configService });
  const listed = await taskBoardTool.execute({ action: 'list' }, { configService });
  for (const result of [updated, completed, listed]) {
    assert.equal(Object.hasOwn(result.metadata, 'task_title'), false);
  }
});
