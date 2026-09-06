'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDailyBriefingCache } = require('../services/companion-briefing-cache');

test('briefing cache keeps the newer key when an older request resolves last', async () => {
  const resolvers = {};
  const cache = createDailyBriefingCache({
    formatDateKey: () => 'today', buildSnapshot: ({ gitSnapshot }) => gitSnapshot,
    readGitSnapshotImpl: (root) => new Promise((resolve) => { resolvers[root] = resolve; }),
  });
  const params = (workspaceRoot) => ({ workspaceRoot, workspaceRootStatus: { state: 'ready' } });
  const requests = [cache.getSnapshot(params('older')), cache.getSnapshot(params('newer'))];
  await Promise.resolve();
  resolvers.newer({ branch: 'newer' }); await requests[1];
  resolvers.older({ branch: 'older' }); await requests[0];
  assert.deepEqual(await cache.getSnapshot(params('newer')), { branch: 'newer' });
});
