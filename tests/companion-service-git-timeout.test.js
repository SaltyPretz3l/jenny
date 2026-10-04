const test = require('node:test');
const assert = require('node:assert/strict');

const { CompanionService } = require('../services/companion-service');
const { formatDateKey } = require('../services/personality-workspace-service');

function createConfigService(state) {
  return {
    getState: () => JSON.parse(JSON.stringify(state)),
    getWorkspaceState: () => ({ activeSessionId: '', openSessionIds: [] }),
    getWorkspaceRootStatus: () => ({ state: 'ready' }),
  };
}

test('HOM-15 Home core state loads after Git times out, and the timeout is not cached for the day', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  let options;
  const service = new CompanionService({
    formatDateKey,
    configService: createConfigService({ toolsWorkspaceRoot: 'repo', companion: { mode: 'planner' }, followUps: [],
      proactive: { reminders: [{ id: 'rem', label: 'Keep visible', enabled: true }] } }),
    personalityWorkspace: {
      getResolvedTimeZone: async () => 'America/Chicago',
      getNotesSnapshot: async () => ({ available: true, notes: '' }),
    },
    execFileImpl: (_cmd, _args, opts) => { calls += 1; options = opts; return { kill() {} }; },
  });
  const pending = service.getState();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(options.timeout, 10000);
  t.mock.timers.tick(10000);
  const state = await pending;
  assert.equal(state.workspaceGit.available, false);
  assert.equal(state.reminders[0].label, 'Keep visible');
  assert.ok(state.openLoopsBoard);
  const retry = service.getState();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10000);
  assert.equal((await retry).workspaceGit.available, false);
  assert.equal(calls, 2);
});
