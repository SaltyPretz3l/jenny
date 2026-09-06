'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PluginViewRuntimeAuthority } = require('../../../services/plugins/view/view-runtime-authority');

test('dispose invalidates an in-flight commit before final host teardown', async () => {
  let settleCommit;
  const destroyed = [];
  const host = {
    commitGeneration: () => new Promise((resolve) => { settleCommit = resolve; }),
    destroyAll: async (reason) => { destroyed.push(reason); },
  };
  const authority = new PluginViewRuntimeAuthority({ host });
  const prepared = { generation_id: 'generation-1', commit_epoch: 1, descriptors: new Map() };

  const committing = authority.commit(prepared);
  const disposing = authority.dispose('test-dispose');
  assert.deepEqual(destroyed, []);
  settleCommit({ ok: true });

  assert.deepEqual(await committing, { ok: false, reason: 'view_authority_disposed' });
  await disposing;
  assert.deepEqual(authority.snapshot(), { generation_id: null, commit_epoch: 0, active_views: 0 });
  assert.deepEqual(destroyed, ['test-dispose']);
});
