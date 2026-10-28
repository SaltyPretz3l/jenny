'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeCloseOrchestrator } = require('../renderer/features/renderer-ide-close-orchestrator');

function makeOrchestrator(openTabs, { dirty = [], confirm = 'discard' } = {}) {
  const closed = [];
  const prompts = [];
  const dirtySet = new Set(dirty);
  const orch = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs }),
    isDirty: (path) => dirtySet.has(path),
    forceClose: (path) => closed.push(path),
    confirmClose: (payload) => { prompts.push(payload); return Promise.resolve(confirm); },
  });
  return { orch, closed, prompts };
}

test('requestCloseToRight closes the unpinned tabs after the path in the same group', async () => {
  const { orch, closed } = makeOrchestrator([
    { path: 'p.js', pinned: true },
    { path: 'a.js' },
    { path: 'g1.js', group: 'editor-2' },
    { path: 'b.js' },
    { path: 'q.js', pinned: true },
    { path: 'c.js' },
  ]);
  const result = await orch.requestCloseToRight('a.js');
  assert.equal(result.committed, true);
  assert.deepEqual(closed, ['b.js', 'c.js'], 'pinned and other-group tabs stay, earlier tabs stay');
});

test('requestCloseToRight acts inside the group of the path', async () => {
  const { orch, closed } = makeOrchestrator([
    { path: 'a.js' },
    { path: 'g1.js', group: 'editor-2' },
    { path: 'b.js' },
    { path: 'g2.js', group: 'editor-2' },
    { path: 'g3.js', group: 'editor-2' },
  ]);
  await orch.requestCloseToRight('g1.js');
  assert.deepEqual(closed, ['g2.js', 'g3.js']);
});

test('requestCloseToRight raises one batched prompt for the dirty tabs and honours Cancel', async () => {
  const tabs = [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }, { path: 'd.js' }];
  const kept = makeOrchestrator(tabs, { dirty: ['b.js', 'd.js'], confirm: 'cancel' });
  const canceled = await kept.orch.requestCloseToRight('a.js');
  assert.equal(canceled.canceled, true);
  assert.deepEqual(kept.closed, []);
  assert.deepEqual(kept.prompts, [{ dirtyPaths: ['b.js', 'd.js'] }]);
  const discarded = makeOrchestrator(tabs, { dirty: ['b.js', 'd.js'], confirm: 'discard' });
  await discarded.orch.requestCloseToRight('a.js');
  assert.deepEqual(discarded.closed, ['b.js', 'c.js', 'd.js']);
  assert.equal(discarded.prompts.length, 1, 'one prompt for the whole batch');
});

test('requestCloseToRight is a no-op for the last tab or an unknown path', async () => {
  const { orch, closed, prompts } = makeOrchestrator([{ path: 'a.js' }, { path: 'b.js' }]);
  await orch.requestCloseToRight('b.js');
  assert.equal(await orch.requestCloseToRight('nope.js'), undefined);
  assert.deepEqual(closed, []);
  assert.deepEqual(prompts, []);
});
