'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceGitClient, GIT_METHODS } = require('../renderer/features/renderer-workspace-git-client');

function makeWindow(workspaceGit) {
  return { jennyShell: workspaceGit ? { workspaceGit } : {} };
}

test('exposes all 14 typed pass-throughs plus getApi/isAvailable', () => {
  const client = createWorkspaceGitClient({ windowRef: makeWindow({}) });
  assert.equal(GIT_METHODS.length, 14);
  for (const method of GIT_METHODS) {
    assert.equal(typeof client[method], 'function', `${method} is a function`);
  }
  assert.equal(typeof client.getApi, 'function');
  assert.equal(typeof client.isAvailable, 'function');
});

test('forwards the payload verbatim and returns the bridge result', async () => {
  const calls = [];
  const api = {
    getStatus: async (payload) => { calls.push(['getStatus', payload]); return { ok: true, available: true, isRepo: true, op: 'getStatus', files: [] }; },
    stage: async (payload) => { calls.push(['stage', payload]); return { ok: true, op: 'stage', staged: 1, paths: payload.paths }; },
    commit: async (payload) => { calls.push(['commit', payload]); return { ok: true, op: 'commit', committed: true, shortSha: 'abc1234' }; },
  };
  const client = createWorkspaceGitClient({ windowRef: makeWindow(api) });

  const status = await client.getStatus({ signal: 'sig' });
  assert.equal(status.available, true);
  const staged = await client.stage({ paths: ['a.js', 'b.js'] });
  assert.equal(staged.staged, 1);
  await client.commit({ message: 'hi' });

  assert.deepEqual(calls, [
    ['getStatus', { signal: 'sig' }],
    ['stage', { paths: ['a.js', 'b.js'] }],
    ['commit', { message: 'hi' }],
  ]);
  assert.equal(client.isAvailable(), true);
  assert.equal(client.getApi(), api);
});

test('a missing bridge degrades to a synthetic available:false and never throws', async () => {
  const client = createWorkspaceGitClient({ windowRef: makeWindow(null) });
  const status = await client.getStatus();
  assert.equal(status.ok, false);
  assert.equal(status.available, false);
  assert.equal(status.isRepo, false);
  assert.equal(status.reason, 'bridge_unavailable');
  assert.equal(status.op, 'getStatus');
  assert.equal(client.isAvailable(), false);
  assert.equal(client.getApi(), null);

  const staged = await client.stage({ paths: ['a'] });
  assert.equal(staged.ok, false);
  assert.equal(staged.reason, 'bridge_unavailable');
});

test('a rejecting bridge call degrades to a structured failure, preserving the code', async () => {
  const api = {
    getStatus: async () => ({ ok: true, available: true, isRepo: true, op: 'getStatus' }),
    commit: async () => { const error = new Error('Commit message is empty.'); error.code = 'CMP-GIT-0020'; throw error; },
  };
  const client = createWorkspaceGitClient({ windowRef: makeWindow(api) });
  const result = await client.commit({ message: '' });
  assert.equal(result.ok, false);
  assert.equal(result.available, true);
  assert.equal(result.reason, 'call_failed');
  assert.equal(result.error_code, 'CMP-GIT-0020');
  assert.match(result.message, /empty/);
});

test('re-reads the bridge on every call (resilient to a late-arriving bridge)', async () => {
  const win = makeWindow(null);
  const client = createWorkspaceGitClient({ windowRef: win });
  assert.equal((await client.getStatus()).available, false);
  win.jennyShell.workspaceGit = {
    getStatus: async () => ({ ok: true, available: true, isRepo: true, op: 'getStatus' }),
  };
  assert.equal((await client.getStatus()).available, true);
  assert.equal(client.isAvailable(), true);
});
