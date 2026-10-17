'use strict';

/* Shared fixture for the chat proposal service tests (row 59 checkpoint 3): a
 * real ElectronSessionStore, the real record helpers and proposal store, a fake
 * durable runtime, an injected clock and the two notification sinks. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const R = require('../../services/backend/chat-proposal-records');
const { createChatProposalStore } = require('../../services/backend/chat-proposal-store');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ChatProposalService } = require('../../services/chat-proposal-service');

const START_MS = Date.parse('2026-10-15T10:00:00.000Z');

function gitBinding(paths) {
  return {
    source_project_id: null,
    workspace_id: 'root_1',
    root_identity: { root_id: 'root_1', device_id: '1', inode: '2' },
    authority_revision: 1,
    run_mode: 'agent',
    restrictions: { read_only: false, plan_mode: false },
    model: null,
    effort: null,
    git: {
      ref: 'refs/heads/main',
      head: 'b'.repeat(40),
      fingerprint: 'a'.repeat(64),
      paths: paths.map((entry) => ({
        path: entry, orig_path: null, index_status: ' ', worktree_status: 'M',
        head_oid: 'c'.repeat(40), index_oid: 'c'.repeat(40), worktree_oid: 'd'.repeat(40), worktree_kind: 'file',
      })),
    },
    command: null,
  };
}

function commandBinding(command) {
  return {
    ...gitBinding(['x']),
    git: null,
    command: { backend: 'native', shell: '/bin/sh', cwd: '.', command_sha256: R.sha256Hex(command) },
  };
}

class FakeRuntime {
  constructor() {
    this.mode = 'ok';
    this.submits = [];
    this.cancels = [];
    this.cancelResult = { status: 'cancelled' };
    this.works = new Map();
    this.keys = new Map();
    this.sequence = 0;
  }

  _register(key, request) {
    this.sequence += 1;
    const work = {
      work_id: `work_${this.sequence}`, turn_id: `turn_c${this.sequence}`, session_id: request.sessionId, status: 'pending',
    };
    this.works.set(work.work_id, work);
    this.keys.set(key, work);
    return work;
  }

  async submitApplicationTurn(request, { idempotencyKey }) {
    this.submits.push({ request, idempotencyKey });
    const refusals = {
      closing: { reason: 'runtime_closing', acceptance: 'rejected' },
      disabled: { reason: 'runtime_disabled', acceptance: 'rejected' },
      capacity: { reason: 'session_pending_capacity', acceptance: 'rejected' },
      lost: { reason: 'runtime_submission_refused', acceptance: 'unknown' },
    };
    if (refusals[this.mode]) return { ok: false, ...refusals[this.mode] };
    const known = this.keys.get(idempotencyKey);
    if (this.mode === 'committed-unknown') {
      this._register(idempotencyKey, request);
      return { ok: false, reason: 'runtime_submission_refused', acceptance: 'unknown' };
    }
    if (known) return { ok: true, created: false, ...known };
    return { ok: true, created: true, ...this._register(idempotencyKey, request) };
  }

  findApplicationSubmission(key) {
    const work = this.keys.get(key);
    return work ? this.getApplicationWork(work.work_id) : null;
  }

  getApplicationWork(workId) {
    const work = this.works.get(workId);
    return work ? { ...work } : null;
  }

  cancel(workId, options) {
    this.cancels.push([workId, options]);
    return this.cancelResult;
  }
}

function createFixture(t, {
  runtime = new FakeRuntime(),
  recheck = async () => ({ ok: true }),
  commandAdapter = null,
  profileUnresolved = null,
  isOfflineLockdown = undefined,
  serviceOptions = {},
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-proposal-service-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessionId = store.createSession({ title: 'proposals' }).id;
  const sessionIncarnation = store.getSession(sessionId).session_incarnation;
  const clock = { ms: START_MS };
  const events = [];
  const rail = [];
  const logs = [];
  const completeTurns = new Set();
  const proposalStore = createChatProposalStore(store);
  const fx = {
    dir, store, sessionId, sessionIncarnation, clock, events, rail, logs, completeTurns, runtime, recheck,
    proposalStore,
  };
  fx.service = new ChatProposalService({
    store: profileUnresolved === null ? proposalStore : {
      read: proposalStore.read, mutate: proposalStore.mutate, countUnresolvedAcrossProfile: () => profileUnresolved,
    },
    getSessionSummary: (id) => store.getSessionSummary(id),
    getRuntime: () => fx.runtime,
    recheckGitBinding: (record) => fx.recheck(record),
    commandAdapter,
    ...(isOfflineLockdown ? { isOfflineLockdown } : {}),
    notifyCoordinationChanged: (id) => rail.push(id),
    emit: (event) => events.push(event),
    isTurnCompleteKnown: (_sessionId, turnId) => completeTurns.has(turnId),
    listSessionIds: () => store.getSessionIds(),
    log: (level, event, details) => logs.push([level, event, details]),
    now: () => new Date(clock.ms),
    notifierOptions: { intervalMs: 0 },
    ...serviceOptions,
  });
  t.after(() => fx.service.dispose());
  fx.publishGit = (n = 1, { paths = ['src/a.js', 'src/b.js'], summary = 'Fixed the parser.' } = {}) => {
    const input = R.normalizeGitProposalInput({ summary, question: 'Commit these?', paths }).value;
    return fx.service.publish({
      kind: 'git', sessionId, sessionIncarnation, turnId: `turn_${n}`, toolCallId: `call_${n}`, input, binding: gitBinding(input.paths),
    });
  };
  fx.publishCommand = (n = 1, command = 'npm test') => {
    const input = R.normalizeCommandProposalInput({ command, cwd: '.', purpose: 'Run the tests' }, { shell: '/bin/sh' }).value;
    return fx.service.publish({
      kind: 'command', sessionId, sessionIncarnation, turnId: `turn_${n}`, toolCallId: `call_${n}`, input, binding: commandBinding(command),
    });
  };
  fx.request = (extra = {}) => ({ schema_version: 1, session_id: sessionId, ...extra });
  fx.decide = (proposal, choice, extra = {}) => fx.service.decide(fx.request({
    proposal_id: proposal.proposal_id,
    expected_revision: proposal.revision,
    decision_id: randomUUID(),
    choice,
    ...extra,
  }));
  fx.gesture = (method, proposal, extra = {}) => fx.service[method](fx.request({
    proposal_id: proposal.proposal_id, expected_revision: proposal.revision, decision_id: randomUUID(), ...extra,
  }));
  fx.record = (proposalId) => proposalStore.read(sessionId).records.find((entry) => entry.proposal_id === proposalId);
  fx.get = async (proposalId) => (await fx.service.get(fx.request({ proposal_id: proposalId }))).proposal;
  fx.stream = (turnId, type, extra = {}) => fx.service.handleChatStreamEvent({ type, turnId, sessionId, ...extra });
  fx.advanceDays = (days) => { fx.clock.ms += days * 24 * 60 * 60 * 1000; };
  return fx;
}

module.exports = { FakeRuntime, START_MS, commandBinding, createFixture, gitBinding };
