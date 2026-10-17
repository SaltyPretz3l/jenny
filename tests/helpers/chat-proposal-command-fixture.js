'use strict';

/* Fixture for the exact-command Run tests (row 59 checkpoint 3, Batch B): the proposal
 * service fixture plus a fake command runtime that stands in for the B2a ports
 * (capability, binding recheck, durable submit, cancel, submission lookup) and builds
 * the E3 progress / outcome events. */

const R = require('../../services/backend/chat-proposal-records');
const { commandBinding, createFixture } = require('./chat-proposal-service-fixture');

class FakeCommandRuntime {
  constructor() {
    this.supported = true;
    this.recheckResult = { ok: true };
    this.mode = 'ok';
    this.submits = [];
    this.rechecks = [];
    this.cancels = [];
    this.cancelResult = { status: 'cancelled' };
    this.works = new Map();
    this.keys = new Map();
    this.sequence = 0;
    this.onSubmit = null;
    this.hasFind = true;
  }

  _register(key, args) {
    this.sequence += 1;
    const work = { work_id: `work_c${this.sequence}`, turn_id: `turn_c${this.sequence}`, session_id: args.sessionId, status: 'pending' };
    this.works.set(work.work_id, work);
    this.keys.set(key, work);
    return work;
  }

  get adapter() {
    const self = this;
    const adapter = {
      isSupported: () => self.supported,
      recheck: async (record) => {
        self.rechecks.push(record.proposal_id);
        if (self.recheckResult instanceof Error) throw self.recheckResult;
        return self.recheckResult;
      },
      submit: async (args) => {
        self.submits.push(args);
        if (self.onSubmit) self.onSubmit(args);
        const refusals = {
          closing: { reason: 'runtime_closing', acceptance: 'rejected' },
          disabled: { reason: 'runtime_disabled', acceptance: 'rejected' },
          capacity: { reason: 'session_pending_capacity', acceptance: 'rejected' },
          unknown: { reason: 'runtime_submission_refused', acceptance: 'unknown' },
        };
        if (self.mode === 'throw') throw new Error('C:\\secret\\boom');
        if (refusals[self.mode]) return { ok: false, ...refusals[self.mode] };
        const known = self.keys.get(args.idempotencyKey);
        if (self.mode === 'committed-unknown') {
          self._register(args.idempotencyKey, args);
          return { ok: false, reason: 'runtime_submission_refused', acceptance: 'unknown' };
        }
        if (known) return { ok: true, created: false, ...known };
        return { ok: true, created: true, ...self._register(args.idempotencyKey, args) };
      },
      cancel: (workId) => {
        self.cancels.push(workId);
        if (self.cancelResult instanceof Error) throw self.cancelResult;
        return self.cancelResult;
      },
    };
    if (this.hasFind) adapter.find = (key) => self.keys.get(key) || null;
    return adapter;
  }
}

function createCommandFixture(t, options = {}) {
  const cmd = options.cmd || new FakeCommandRuntime();
  const fx = createFixture(t, { ...options, commandAdapter: cmd.adapter });
  fx.cmd = cmd;
  // A command proposal with optional preconditions, bound to the native /bin/sh shell.
  fx.publishRun = (n = 1, { command = 'npm test', preconditions = [], timeout = 30 } = {}) => {
    const input = R.normalizeCommandProposalInput({
      command, cwd: '.', purpose: 'Run the tests', timeout_seconds: timeout, preconditions,
    }, { shell: '/bin/sh', backend: 'native' }).value;
    return fx.service.publish({
      kind: 'command', sessionId: fx.sessionId, sessionIncarnation: fx.sessionIncarnation, turnId: `turn_${n}`,
      toolCallId: `call_${n}`, input, binding: commandBinding(command),
    });
  };
  const base = (record, work) => ({
    schema_version: 1, session_id: fx.sessionId, proposal_id: record.proposal_id, decision_id: record.decision.decision_id,
    work_id: work?.work_id ?? record.continuation_work_id, turn_id: work?.turn_id ?? record.continuation_turn_id,
  });
  fx.progress = (record, status, work) => fx.service.handleCommandProgress({ ...base(record, work), status });
  fx.outcome = (record, status, extra = {}, work) => fx.service.handleCommandOutcome({
    ...base(record, work), status, exit_code: null, cleanup: null, ...extra,
  });
  return fx;
}

module.exports = { FakeCommandRuntime, createCommandFixture };
