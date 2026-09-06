'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WorkspaceGitOperationContext,
  linkedSignal,
} = require('../services/workspace-git-operation-context');
const { createDeferred } = require('./helpers/deferred');
const { workspaceRootId } = require('../services/workspace-root-identity');

test('fallback operation contexts use the canonical workspace root identity shape', () => {
  const root = 'G:/repo';
  const operation = new WorkspaceGitOperationContext({ rootProvider: () => root }).acquire();
  assert.equal(operation.context.rootId, workspaceRootId(root));
  operation.release();
});

test('operation context combines caller cancellation with a coordinator lease and releases once', () => {
  const caller = new AbortController();
  const leaseAbort = new AbortController();
  let releases = 0;
  const context = new WorkspaceGitOperationContext({
    rootContextProvider: () => ({
      acquireOperation: () => ({
        acquired: true,
        context: { rootPath: 'G:/repo', rootId: 'repo', generation: 2, phase: 'ready' },
        signal: leaseAbort.signal,
        isCurrent: () => true,
        release: () => { releases += 1; },
      }),
    }),
  });
  const operation = context.acquire({ signal: caller.signal });
  assert.equal(operation.acquired, true);
  leaseAbort.abort('root_transition');
  assert.equal(operation.signal.aborted, true);
  assert.equal(operation.signal.reason, 'root_transition');
  assert.equal(operation.release(), true);
  assert.equal(operation.release(), false);
  assert.equal(releases, 1);
});

test('serialized writes never overlap for the same root and independent roots may proceed', async () => {
  const context = new WorkspaceGitOperationContext({ rootProvider: () => 'G:/repo' });
  const firstGate = createDeferred();
  const events = [];
  const first = context.runSerialized('repo-a', async () => {
    events.push('first-start');
    await firstGate.promise;
    events.push('first-end');
  });
  const second = context.runSerialized('repo-a', async () => { events.push('second'); });
  const other = context.runSerialized('repo-b', async () => { events.push('other'); });
  await Promise.resolve();
  await other;
  assert.deepEqual(events, ['first-start', 'other']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'other', 'first-end', 'second']);
});

test('linkedSignal disposes listeners and preserves already-aborted state', () => {
  const first = new AbortController();
  const second = new AbortController();
  second.abort('caller');
  const linked = linkedSignal(first.signal, second.signal);
  assert.equal(linked.signal.aborted, true);
  assert.equal(linked.signal.reason, 'caller');
  assert.doesNotThrow(() => linked.dispose());
});
