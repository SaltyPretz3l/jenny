'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  executeElectronToolRequest,
} = require('../services/backend/electron-tool-bridge');
const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');

describe('Electron worktree tool bridge', () => {
  test('allows worktree_list through the Electron tool bridge allowlist', async () => {
    let bridgedCall = null;
    const result = await executeElectronToolRequest(
      {
        configService: {
          getState() {
            return { toolsWorkspaceRoot: 'C:/dev/jenny' };
          },
        },
        toolExecutor: {
          async executePreApproved(call, context) {
            bridgedCall = { call, context };
            return {
              content: '1 worktree found.',
              isError: false,
              metadata: { result_kind: 'worktree_list' },
            };
          },
        },
      },
      {
        sessionId: 'session_worktree',
        streamId: 'stream_worktree',
        params: {
          tool_name: 'worktree_list',
          tool_call_id: 'call_worktree',
          arguments: {},
        },
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.metadata.result_kind, 'worktree_list');
    assert.equal(bridgedCall.call.toolName, 'worktree_list');
    assert.equal(bridgedCall.context.workingDirectory, path.resolve('C:/dev/jenny'));
  });

  test('worktree_create remains plan-mode guarded by the executor', async () => {
    const result = await executeElectronToolRequest(
      {
        configService: {
          getState() {
            return { toolsWorkspaceRoot: 'C:/dev/jenny' };
          },
        },
        toolExecutor: {
          async executePreApproved() {
            return {
              content: 'Tool "worktree_create" is not available in plan mode.',
              isError: true,
              errorCode: TOOL_ERROR_CODES.DISABLED,
              metadata: {},
            };
          },
        },
      },
      {
        sessionId: 'session_worktree',
        streamId: 'stream_worktree',
        planMode: true,
        params: {
          tool_name: 'worktree_create',
          tool_call_id: 'call_worktree_create',
          arguments: { name: 'Feature Alpha' },
        },
      }
    );

    assert.equal(result.success, false);
    assert.equal(result.error_code, TOOL_ERROR_CODES.DISABLED);
  });
});
