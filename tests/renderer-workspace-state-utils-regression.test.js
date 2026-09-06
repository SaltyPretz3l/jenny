const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceStateController } = require('../renderer/shell/renderer-workspace-state-utils');

test('concurrent restore calls keep each invocation valid-session set inside the mutation queue', async () => {
  const updates = [];
  const controller = createWorkspaceStateController({
    jennyShell: {
      workspace: {
        async getState() {
          return { activeSessionId: '', openSessionIds: [] };
        },
        async updateState(patch) {
          const saved = {
            activeSessionId: patch.activeSessionId,
            openSessionIds: patch.openSessionIds.slice(),
          };
          updates.push(saved);
          return saved;
        },
      },
    },
  });

  const firstRestore = controller.restore(['a']);
  const secondRestore = controller.restore(['b']);
  const results = await Promise.all([firstRestore, secondRestore]);

  assert.deepEqual(results, [
    { activeSessionId: 'a', openSessionIds: ['a'] },
    { activeSessionId: 'b', openSessionIds: ['b'] },
  ]);
  assert.deepEqual(updates, results);
});
