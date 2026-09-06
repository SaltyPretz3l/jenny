'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  WorkspaceRootExternalTransitionBroker,
} = require('../services/main/workspace-root-external-transition-broker');

const PREVIOUS = Object.freeze({
  rootPath: 'G:/workspace/a', rootId: 'root-a', generation: 3, phase: 'ready',
});
const CANDIDATE = Object.freeze({
  rootPath: 'G:/workspace/b', rootId: 'root-b', generation: 4, phase: 'transitioning',
});

function prepared() {
  return {
    prepared: true,
    transitionId: 'transition-4',
    previous: PREVIOUS,
    candidate: CANDIDATE,
  };
}

function createManualTimers() {
  const callbacks = new Map();
  let nextId = 0;
  return {
    setTimeoutImpl(callback) {
      nextId += 1;
      callbacks.set(nextId, callback);
      return { id: nextId, unref() {} };
    },
    clearTimeoutImpl(handle) {
      callbacks.delete(handle?.id);
    },
    fireNext() {
      const [id, callback] = callbacks.entries().next().value || [];
      if (!callback) throw new Error('no pending timer');
      callbacks.delete(id);
      callback();
    },
    get size() { return callbacks.size; },
  };
}

test('a prepared transition resolves only after the trusted renderer reports commit and rehydration', async () => {
  const sent = [];
  const canceled = [];
  const broker = new WorkspaceRootExternalTransitionBroker({
    sendRequest(payload) { sent.push(payload); return true; },
    cancelTransition: async (payload) => { canceled.push(payload); return { canceled: true }; },
    requestIdFactory: () => 'external-1',
  });
  const pending = broker.requestPreparedTransition({
    prepared: prepared(),
    mode: 'worktree_select',
  });

  assert.deepEqual(sent, [{
    request_id: 'external-1',
    transition_id: 'transition-4',
    mode: 'worktree_select',
    terminate_processes: false,
    deadline_ms: sent[0].deadline_ms,
    previous: {
      root_path: PREVIOUS.rootPath,
      root_id: PREVIOUS.rootId,
      generation: PREVIOUS.generation,
      phase: PREVIOUS.phase,
    },
    candidate: {
      root_path: CANDIDATE.rootPath,
      root_id: CANDIDATE.rootId,
      generation: CANDIDATE.generation,
      phase: CANDIDATE.phase,
    },
  }]);
  assert.equal(Number.isSafeInteger(sent[0].deadline_ms), true);

  const response = await broker.respond({
    request_id: 'external-1',
    transition_id: 'transition-4',
    outcome: {
      committed: true,
      changed: true,
      degraded: false,
      context: { root_path: CANDIDATE.rootPath, root_id: CANDIDATE.rootId, generation: 4, phase: 'ready' },
    },
  });
  assert.deepEqual(response, { accepted: true });
  assert.deepEqual(await pending, {
    committed: true,
    changed: true,
    canceled: false,
    blocked: false,
    rolledBack: false,
    degraded: false,
    code: '',
    context: { ...CANDIDATE, phase: 'ready' },
  });
  assert.deepEqual(canceled, []);
  await broker.dispose();
});

test('renderer unavailability cancels the prepared coordinator transition before refusing', async () => {
  const canceled = [];
  const broker = new WorkspaceRootExternalTransitionBroker({
    sendRequest: () => false,
    cancelTransition: async (payload) => {
      canceled.push(payload);
      return { canceled: true, changed: false };
    },
  });

  const result = await broker.requestPreparedTransition({ prepared: prepared() });

  assert.equal(result.committed, false);
  assert.equal(result.changed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'external_transition_renderer_unavailable');
  assert.equal(result.uncertain, false);
  assert.deepEqual(canceled, [{ transitionId: 'transition-4' }]);
});

test('timeout and abort return typed refusals and expose cancellation uncertainty', async () => {
  const timers = createManualTimers();
  const broker = new WorkspaceRootExternalTransitionBroker({
    sendRequest: () => true,
    cancelTransition: async () => ({ canceled: true, changed: false }),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const timed = broker.requestPreparedTransition({ prepared: prepared() });
  assert.equal(timers.size, 1);
  timers.fireNext();
  const timedResult = await timed;
  assert.equal(timedResult.code, 'external_transition_timeout');
  assert.equal(timedResult.uncertain, false);

  const abortController = new AbortController();
  const uncertainBroker = new WorkspaceRootExternalTransitionBroker({
    sendRequest: () => true,
    cancelTransition: async () => ({ canceled: false, changed: false, code: 'transition_commit_in_progress' }),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const aborted = uncertainBroker.requestPreparedTransition({
    prepared: prepared(), signal: abortController.signal,
  });
  abortController.abort();
  const abortedResult = await aborted;
  assert.equal(abortedResult.code, 'external_transition_canceled');
  assert.equal(abortedResult.uncertain, true);
  assert.equal(abortedResult.cancelResult.code, 'transition_commit_in_progress');
});

test('mismatched responses are refused and degraded renderer settlement never reports tool success', async () => {
  const broker = new WorkspaceRootExternalTransitionBroker({
    sendRequest: () => true,
    cancelTransition: async () => ({ canceled: true, changed: false }),
    requestIdFactory: () => 'external-2',
  });
  const pending = broker.requestPreparedTransition({ prepared: prepared() });

  assert.deepEqual(await broker.respond({
    request_id: 'external-other', transition_id: 'transition-4', outcome: {},
  }), { accepted: false, code: 'external_transition_request_unknown' });
  assert.deepEqual(await broker.respond({
    request_id: 'external-2', transition_id: 'wrong', outcome: {},
  }), { accepted: false, code: 'external_transition_response_mismatch' });

  assert.deepEqual(await broker.respond({
    request_id: 'external-2',
    transition_id: 'transition-4',
    outcome: {
      committed: true,
      changed: true,
      degraded: true,
      code: 'ui_commit_failed',
      context: { root_path: CANDIDATE.rootPath, root_id: CANDIDATE.rootId, generation: 4, phase: 'ready' },
    },
  }), { accepted: true });
  const result = await pending;
  assert.equal(result.committed, false, 'tool-facing success waits for renderer rehydration');
  assert.equal(result.backendCommitted, true);
  assert.equal(result.changed, true);
  assert.equal(result.degraded, true);
  assert.equal(result.code, 'renderer_rehydrate_failed');

  assert.deepEqual(await broker.respond({
    request_id: 'external-2', transition_id: 'transition-4', outcome: {},
  }), { accepted: false, code: 'external_transition_request_unknown' });
});

test('a committed response for a different root context is rejected as uncertain', async () => {
  const broker = new WorkspaceRootExternalTransitionBroker({
    sendRequest: () => true,
    cancelTransition: async () => ({
      canceled: false, changed: false, code: 'transition_missing',
    }),
    requestIdFactory: () => 'external-context-mismatch',
  });
  const pending = broker.requestPreparedTransition({ prepared: prepared() });

  assert.deepEqual(await broker.respond({
    request_id: 'external-context-mismatch',
    transition_id: 'transition-4',
    outcome: {
      committed: true,
      changed: true,
      degraded: false,
      context: { root_path: 'G:/workspace/c', root_id: 'root-c', generation: 4, phase: 'ready' },
    },
  }), { accepted: false, code: 'external_transition_response_invalid' });

  const result = await pending;
  assert.equal(result.committed, false);
  assert.equal(result.code, 'external_transition_response_invalid');
  assert.equal(result.uncertain, true);
});

test('a non-committed renderer response owns settlement before cancellation awaits', async () => {
  const timers = createManualTimers();
  let resolveCancel;
  const cancelPending = new Promise((resolve) => { resolveCancel = resolve; });
  const broker = new WorkspaceRootExternalTransitionBroker({
    sendRequest: () => true,
    cancelTransition: () => cancelPending,
    requestIdFactory: () => 'external-settlement-race',
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const pending = broker.requestPreparedTransition({ prepared: prepared() });

  const response = broker.respond({
    request_id: 'external-settlement-race',
    transition_id: 'transition-4',
    outcome: {
      committed: false,
      changed: false,
      blocked: true,
      code: 'participants_active',
    },
  });
  await Promise.resolve();

  assert.equal(timers.size, 0, 'the timeout cannot win after a trusted response is accepted');
  resolveCancel({ canceled: true, changed: false });
  assert.deepEqual(await response, { accepted: true });
  assert.deepEqual(await pending, {
    committed: false,
    changed: false,
    canceled: false,
    blocked: true,
    rolledBack: false,
    degraded: false,
    code: 'participants_active',
    cancelResult: { canceled: true, changed: false, code: '' },
    uncertain: false,
  });
});
