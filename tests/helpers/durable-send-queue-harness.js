'use strict';
/**
 * tests/helpers/durable-send-queue-harness.js
 *
 * Shared harness for the durable Send queue suites (Runtime UX A1/A2): a
 * controller over a stubbed session runtime that records every snapshot,
 * work, cancel, resume and pause call.
 */
const { createControllerHarness } = require('./send-controller-harness');
const receipt = (payload, i = 1) => ({ ok: true, work_id: `work_${i}`, turn_id: `turn_${i}`, session_id: payload.session_id, revision: 1, status: 'pending' });

const summary = (i, overrides = {}) => ({ work_id: `work_${i}`, project_id: 'project_1', session_id: 'session-1',
  turn_id: `turn_${i}`, purpose: 'chat', status: 'pending', revision: 1, submission_sequence: i,
  created_at: '2026-09-16T12:00:00.000Z', updated_at: '2026-09-16T12:00:00.000Z', ...overrides });

function queueHarness(t, overrides = {}) {
  let sequence = 0;
  const calls = { snapshots: [], works: [], cancels: [], resumes: [], pauses: [] };
  const h = createControllerHarness([], { durableRuntime: true, ...overrides.harness, shell: { sessionRuntime: {
    submit: async payload => receipt(payload, ++sequence),
    getWork: async payload => { calls.works.push(payload); return overrides.getWork
      ? overrides.getWork(payload)
      : { ok: true, work: { work_id: payload.work_id, session_id: 'session-1',
        turn_id: payload.work_id.replace('work_', 'turn_'), status: 'pending', revision: 4 } }; },
    getSnapshot: async payload => { calls.snapshots.push(payload);
      return overrides.snapshot ? overrides.snapshot() : { ok: true, work: [summary(1)], next_cursor: null }; },
    cancel: async payload => { calls.cancels.push(payload); return overrides.cancel(payload); },
    resume: async payload => { calls.resumes.push(payload); return overrides.resume(payload); },
    pause: async payload => { calls.pauses.push(payload); return overrides.pause(payload); },
  } } });
  t.after(h.restore); t.after(() => h.controller.dispose());
  return { h, calls };
}

const running = (i = 1, overrides = {}) => summary(i, { status: 'running', ...overrides });
const workRead = (status, revision) => payload => ({ ok: true, work: { work_id: payload.work_id,
  session_id: 'session-1', turn_id: payload.work_id.replace('work_', 'turn_'), status, revision } });

module.exports = { receipt, summary, running, workRead, queueHarness };
