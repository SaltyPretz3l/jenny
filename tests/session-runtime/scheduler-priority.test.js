'use strict';

// Plan Q13 (row 69): the primary Jenny chat's chat turns take one priority slot per lane so the
// orchestrating chat runs beside a streaming or approval-paused worker chat.

const assert = require('node:assert/strict');
const test = require('node:test');

const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function createStore(prefix) {
  let sequence = 0;
  let tick = 0;
  return new RuntimeStore(createTrackedTempDir(prefix), {
    createId: p => `${p}_${++sequence}`,
    now: () => new Date(Date.UTC(2026, 9, 20, 12, 0, tick++)),
  });
}

function submit(store, suffix, { sessionId }) {
  const projectId = `project_${suffix}`;
  return store.submit({
    idempotencyKey: `idempotency_${suffix}`,
    projectId,
    sessionId,
    purpose: 'chat',
    input: { prompt: `prompt-${suffix}` },
    authority: {
      project_id: projectId, root_path: `G:\\private-${suffix}`, root_id: `root_${suffix}`,
      root_revision: Number(suffix), device_id: `device_${suffix}`, inode: `inode_${suffix}`,
    },
    workId: `work_${suffix}`,
    turnId: `turn_${suffix}`,
  }).record;
}

test('the scheduler admits a priority turn beside a running worker on the same local lane (plan Q13)', async () => {
  const store = createStore('jenny-runtime-application-priority-');
  const lanes = new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
    configuration_revision: 'revision_1', requires_gpu: true, resource_class: 'local' });
  const producerCalls = [];
  const scheduler = new SessionRuntimeScheduler({ store, lanes, resolveRoute: () => route,
    validateWork: () => {}, claimCanonical: work => ({ streamId: `stream_${work.work_id}`,
      authorityRevision: 'authority_1', rollbackBeforeStart: () => true, assertCurrent: () => {} }),
    startProducer: () => new Promise((resolve, reject) => producerCalls.push({ resolve, reject })),
    isPriorityTurn: work => work.session_id === 'session_jenny' });
  const worker = submit(store, '1', { sessionId: 'session_worker' });
  assert.equal(scheduler.tryDispatch(worker.work_id).status, 'started');
  const other = submit(store, '2', { sessionId: 'session_other' });
  assert.equal(scheduler.tryDispatch(other.work_id).reason, 'lane_capacity', 'an ordinary second turn waits');
  const jenny = submit(store, '3', { sessionId: 'session_jenny' });
  assert.equal(scheduler.tryDispatch(jenny.work_id).status, 'started', 'the primary takes the priority slot');
  assert.equal(scheduler.tryDispatch(other.work_id).reason, 'lane_capacity', 'the worker slot is unchanged');
  assert.equal(lanes.snapshot().active_leases, 2);
  for (const call of producerCalls) call.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
});
