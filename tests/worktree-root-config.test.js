'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  transitionToolsWorkspaceRoot,
} = require('../services/tools/builtin/worktree-root-config');

test('workspace-root transition contains preparation and cancellation failures', async () => {
  const preparationResult = await transitionToolsWorkspaceRoot(
    {
      prepareTarget: async () => {
        const error = new Error('coordinator unavailable');
        error.code = 'coordinator_prepare_unavailable';
        throw error;
      },
      commit: async () => ({}),
    },
    { requestPreparedTransition: async () => ({}) },
    'C:/next'
  );
  assert.deepEqual(preparationResult, {
    committed: false,
    changed: false,
    blocked: true,
    code: 'coordinator_prepare_unavailable',
  });

  const coordinator = {
    prepareTarget: async () => ({ prepared: true, transitionId: 'transition-1' }),
    commit: async () => ({}),
    cancel: async () => { throw new Error('cancel store unavailable'); },
  };
  const brokerFailure = new Error('renderer unavailable');
  brokerFailure.code = 'renderer_unavailable';
  const brokerResult = await transitionToolsWorkspaceRoot(
    coordinator,
    { requestPreparedTransition: async () => { throw brokerFailure; } },
    'C:/next'
  );
  assert.deepEqual(brokerResult, {
    committed: false,
    changed: false,
    blocked: true,
    code: 'renderer_unavailable',
    cancelResult: null,
    uncertain: true,
  });

  const invalidResponseResult = await transitionToolsWorkspaceRoot(
    coordinator,
    { requestPreparedTransition: async () => null },
    'C:/next'
  );
  assert.deepEqual(invalidResponseResult, {
    committed: false,
    changed: false,
    blocked: true,
    code: 'external_transition_response_invalid',
    cancelResult: null,
    uncertain: true,
  });
});
