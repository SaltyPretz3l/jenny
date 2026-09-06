const test = require('node:test');
const assert = require('node:assert/strict');

const manifest = require('../services/tools/tool-manifest.json');
const taskBoardTool = require('../services/tools/builtin/task-board-tool');

test('task board description requires task completion and stays identical across owners', () => {
  const descriptor = manifest.tools.find((entry) => entry.name === 'task_board');

  assert.ok(descriptor);
  assert.match(descriptor.description, /complete/);
  assert.match(descriptor.description, /task id/i);
  assert.equal(taskBoardTool.description, descriptor.description);
});
