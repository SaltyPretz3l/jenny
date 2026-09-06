'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_OPERATION_DATA_KEYS,
  poll,
} = require('../../../services/plugins/session-provider/operation-lifecycle');

test('polling settles when cumulative operation data exceeds the key cap', async () => {
  const authority = {
    active_generation_id: 'generation-1',
    commit_epoch: 4,
    registry_revision: 7,
    dependency_graph_hash: 'a'.repeat(64),
  };
  const operationId = 'operation-1';
  const settlements = [];
  const record = {
    operationId,
    attempt: 1,
    authority,
    hostSessionEpoch: 9,
    sequence: 0,
    frames: [],
    data: {},
    sessionId: 'session-1',
    sessionIncarnation: 'incarnation-1',
    terminalReceived: false,
    settled: false,
    host: {
      status: async () => ({
        ok: true,
        frames: [{
          frame_schema_version: 1,
          invocation_id: operationId,
          commit_epoch: authority.commit_epoch,
          lifecycle_epoch: 9,
          sequence: record.sequence,
          frame: { kind: 'data', payload: JSON.stringify({ [`key_${record.sequence}`]: true }) },
        }],
      }),
    },
  };
  const sessionStore = {
    getSession: () => ({
      session_incarnation: record.sessionIncarnation,
      plugin_session: { active_operation: { operation_id: operationId, attempt: 1 } },
    }),
    updateSession: () => ({}),
  };
  const owner = {
    disposed: false,
    operations: new Map([[operationId, record]]),
    runtime: { currentAuthority: () => authority },
    sessionStore,
    log() {},
    setTimeoutFn: () => ({ unref() {} }),
    _settle: async (_record, status, reason) => {
      settlements.push({ status, reason });
      record.settled = true;
      return { ok: true };
    },
  };

  for (let index = 0; index <= MAX_OPERATION_DATA_KEYS; index += 1) {
    await poll(owner, record);
  }

  assert.deepEqual(settlements, [{
    status: 'failed',
    reason: 'operation_data_limit_exceeded',
  }]);
  assert.equal(Object.keys(record.data).length, MAX_OPERATION_DATA_KEYS);
});
