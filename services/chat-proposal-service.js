'use strict';

/* services/chat-proposal-service.js - main-process owner of inline Git / command
 * proposals (row 59 checkpoint 3): `publish` (tool-facing, never IPC), the
 * `sessionProposals.*` bridge (get, list, decide, cancel, retry, and for the session kind
 * getCapabilities, setOptions, startAll, authorizeLaunch, and from checkpoint 5b-3 the archive-restore
 * confirmRestored in ./chat-proposal-restore), the Commit / Test-first continuation,
 * outcome tracking and startup reconciliation. The session kind lives in
 * ./chat-proposal-session (methods) and ./chat-proposal-session-flow (runtime side).
 *
 * Records live in `session.chat_proposals` behind the proposal store (S1); every
 * state change goes through its pure helpers, is flushed before it is
 * acknowledged, and then fires `onChanged` plus the session rail invalidation.
 * A decide / retry / cancel gesture also writes its coordination receipt in the same flushed mutation.
 * The continuation is admitted only through the runtime's durable application
 * entry; there is no non-durable fallback, and restart never resumes or
 * resubmits. Diagnostics carry reason tokens only, never summaries, paths or
 * commands.
 */

const { randomUUID } = require('node:crypto');
const defaultRecords = require('./backend/chat-proposal-records');
const { createChangeNotifier } = require('./chat-workspace-change-notifier');
const contract = require('./chat-proposal-contract');
const continuation = require('./chat-proposal-continuation');
const command = require('./chat-proposal-command');
const session = require('./chat-proposal-session');
const flow = require('./chat-proposal-session-flow');
const support = require('./chat-proposal-support');
const restore = require('./chat-proposal-restore');
const { prepareSessionRetry } = require('./backend/chat-proposal-session-records');
const { createChildTracker } = require('./backend/chat-proposal-child-view');
const { gestureVerdict, proposalGestureReceipt, recordGesture } = require('./backend/coordination-receipts');
const { COMMAND_DRIFT_CAUSES, markCommandOutcome } = require('./backend/chat-proposal-command-records');

const { fail, succeed } = contract;
const DRIFT_CAUSES = new Set([
  'root_changed', 'authority_stale', 'ref_changed', 'head_changed', 'paths_changed', 'binding_missing', ...COMMAND_DRIFT_CAUSES,
]);
const MAX_GESTURES = 512;
const MAX_TRACKED_TURNS = 1024;

function boundedSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

class ChatProposalService {
  constructor({
    store,
    records = defaultRecords,
    getSessionSummary = () => null,
    getRuntime = () => null,
    recheckGitBinding = async () => ({ ok: false, cause_code: 'unavailable' }),
    commandAdapter = null,
    notifyCoordinationChanged = () => {},
    emit = () => {},
    isTurnCompleteKnown = () => false,
    isOfflineLockdown = () => false,
    listSessionIds = () => [],
    log = () => {},
    now = () => new Date(),
    createId = randomUUID,
    notifierOptions = {},
    sessionHandoff = null, // S6's module (tests inject it); default loaded on first use
    ...portOptions // the session ports of flow.buildPorts
  } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.mutate !== 'function') {
      throw new TypeError('ChatProposalService requires a proposal store.');
    }
    this._store = store;
    this._records = records;
    this._getSessionSummary = getSessionSummary;
    this._getRuntime = getRuntime;
    this._recheckGitBinding = recheckGitBinding;
    this._commandAdapter = commandAdapter && typeof commandAdapter === 'object' ? commandAdapter : null;
    this._notifyCoordination = notifyCoordinationChanged;
    this._isTurnCompleteKnown = isTurnCompleteKnown;
    this._isOfflineLockdown = isOfflineLockdown;
    this._listSessionIds = listSessionIds;
    this._log = log;
    this._now = now;
    this._createId = createId;
    this._gestures = new Map(); // `${proposalId}:${decisionId}` -> { op, expectedRevision }
    this._tracked = new Map(); // continuation / preparation turn id -> { sessionId, proposalId, state, role }
    this._ports = flow.buildPorts(portOptions);
    this._child = createChildTracker({ readFacts: portOptions.readChildFacts, changed: (id) => this._changed(id) }); // F3b
    this._sessionHandoff = sessionHandoff;
    this._offerTurns = new Map(); // source turn id -> session id (ordinary offers awaiting their boundary)
    this._turnTerminals = new Map(); // source turn id -> 'complete' | 'failed' | 'cancelled'
    this._waiting = new Map(); // proposal id -> waiting_for_source watcher
    this._deadlines = new Map(); // preparation deadlines (owned by S6's helpers)
    this._pending = new Set(); // deferred work (dispatch after a grant or a released wait)
    this._notifier = createChangeNotifier({
      emit,
      getRevision: (sessionId) => {
        const read = this._store.read(sessionId);
        return read.ok ? read.coordination_revision : 0;
      },
      ...notifierOptions,
    });
  }

  // ---- tool-facing ----------------------------------------------------------

  // Never throws. Idempotent on the deterministic proposal id: an identical input
  // returns the current projection (`created:false`), a different one conflicts.
  async publish({ kind, sessionId, sessionIncarnation, turnId, toolCallId, input, binding } = {}) {
    try {
      if (kind === 'session') return session.publish(this, { sessionId, sessionIncarnation, turnId, toolCallId, input, binding });
      return this._publish({ kind, sessionId, sessionIncarnation, turnId, toolCallId, input, binding });
    } catch {
      this._log('WARN', 'chat_proposal.publish_failed', { reason: 'exception' });
      return fail('unavailable');
    }
  }

  _publish({ kind, sessionId, sessionIncarnation, turnId, toolCallId, input, binding }) {
    const rec = this._records;
    const read = this._store.read(sessionId);
    if (!read.ok) return fail(read.reason === 'not_found' ? 'not_found' : 'unavailable');
    if (read.frozen) return fail('unavailable');
    let proposalId;
    try {
      proposalId = rec.computeProposalId(sessionIncarnation, turnId, toolCallId);
    } catch {
      return fail('invalid_request');
    }
    const created = rec.createProposalRecord({
      kind, sessionId, sessionIncarnation, turnId, toolCallId, input, binding, now: this._now(),
    });
    if (!created.ok) return fail(created.reason === 'capacity' ? 'capacity' : 'invalid_request');
    const profileUnresolved = this._store.countUnresolvedAcrossProfile();
    const nowDate = this._now();
    const result = this._store.mutate(sessionId, ({ records }) => {
      const existing = records.find((entry) => entry.proposal_id === proposalId);
      if (existing) {
        return { abort: rec.canonicalJson(existing.normalized_input) === rec.canonicalJson(input)
          ? { existing } : { reason: 'idempotency_conflict', revision: existing.revision } };
      }
      const live = records.map((entry) => rec.expireIfDue(entry, nowDate) || entry);
      if (live.filter(rec.isUnresolved).length >= rec.PROPOSAL_LIMITS.unresolved_per_source
        || profileUnresolved >= rec.PROPOSAL_LIMITS.unresolved_per_profile) {
        return { abort: { reason: 'capacity' } };
      }
      return { records: [...rec.pruneFinalized(live, nowDate), created.record] };
    });
    if (!result.ok) return this._storeFailure(result);
    if (result.aborted) {
      const { existing, reason, revision } = result.value;
      if (existing) return succeed({ created: false, proposal: this._project(existing) });
      return fail(reason, { currentRevision: revision });
    }
    this._changed(sessionId);
    const stored = result.records.find((entry) => entry.proposal_id === proposalId);
    return succeed({ created: true, proposal: this._project(stored) });
  }

  // ---- renderer bridge ------------------------------------------------------

  async get(raw) {
    const checked = contract.validateGetRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const found = this._find(checked.value.session_id, checked.value.proposal_id);
    return found.ok ? succeed({ proposal: this._project(found.record) }) : fail(found.reason);
  }

  async list(raw) { return support.listPage(this, raw); }
  childChanged(childId) { this._child.touch(childId); } // F3b: an automatic resume took the child's report

  async decide(raw) {
    const checked = contract.validateDecideRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const req = checked.value;
    const rec = this._records;
    let found = this._find(req.session_id, req.proposal_id);
    if (!found.ok) return fail(found.reason);
    let { record } = found;
    const replay = this._decisionReplay(record, req);
    if (replay) return replay;
    // An expired or stale record accepts no choice whatever revision the caller saw.
    if (['expired', 'stale'].includes(record.decision_state)) return this._notPending(record);
    if (record.revision !== req.expected_revision) return fail('stale_revision', { currentRevision: record.revision });
    if (record.decision_state !== 'pending') return this._notPending(record);
    if (!contract.choiceFitsKind(record.kind, req.choice)) return fail('invalid_request');
    const nowDate = this._now();
    if (rec.expireIfDue(record, nowDate)) {
      const expired = this._apply(req.session_id, record.proposal_id, (current) => {
        const next = current.revision === record.revision ? rec.expireIfDue(current, nowDate) : null;
        return next ? { record: next } : { abort: { reason: 'stale_revision' } };
      });
      return fail('expired', { currentRevision: expired.record?.revision ?? record.revision });
    }
    if (req.choice === 'dismiss') {
      return this._persistDecision(req, record, (current) => rec.dismissProposal(current, {
        decisionId: req.decision_id, now: nowDate,
      }));
    }
    const gate = this._project(record).actions[req.choice];
    if (!gate || gate.available !== true) return fail(gate?.reason || 'unavailable', { currentRevision: record.revision });
    if (req.choice === 'run') return this._decideRun(req, record);
    if (record.kind === 'session') return session.decide(this, req, record);
    const recheck = await this._recheck(record);
    if (!recheck.ok) return this._bindingFailure(req, record, recheck);
    found = this._find(req.session_id, req.proposal_id);
    if (!found.ok) return fail(found.reason);
    record = found.record;
    const staleReplay = this._decisionReplay(record, req);
    if (staleReplay) return staleReplay;
    if (record.revision !== req.expected_revision) return fail('stale_revision', { currentRevision: record.revision });
    // The recheck can take seconds: re-read the D6 gate so a mode flip during it still refuses.
    const regate = this._project(record).actions[req.choice];
    if (!regate || regate.available !== true) return fail(regate?.reason || 'unavailable', { currentRevision: record.revision });
    const accepted = this._persistDecision(req, record, (current) => rec.acceptGitDecision(current, {
      decisionId: req.decision_id, choice: req.choice, now: nowDate, attemptId: this._createId(),
    }), { envelope: false });
    if (!accepted.ok) return accepted.failure;
    await this._dispatch(req.session_id, accepted.record);
    return succeed({ created: true, proposal: this._project(this._latest(req.session_id, record.proposal_id) || accepted.record) });
  }

  async cancel(raw) {
    const checked = contract.validateGestureRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const req = checked.value;
    const rec = this._records;
    const found = this._find(req.session_id, req.proposal_id);
    if (!found.ok) return fail(found.reason);
    const { record } = found;
    const replay = this._gestureReplay('cancel', req, record);
    if (replay) return replay;
    if (record.revision !== req.expected_revision) return fail('stale_revision', { currentRevision: record.revision });
    if (!this._project(record).actions.cancel.available) return fail('not_pending', { currentRevision: record.revision });
    const special = flow.cancelSession(this, req, record);
    if (special) return special;
    if (!record.continuation_work_id) return fail('submission_pending', { currentRevision: record.revision });
    const runtime = record.kind === 'command' ? this._commandAdapter : this._getRuntime();
    if (typeof runtime?.cancel !== 'function') return fail('unavailable', { currentRevision: record.revision });
    let outcome;
    try {
      outcome = runtime.cancel(record.continuation_work_id, { reason: 'user' });
    } catch {
      return fail('unavailable', { currentRevision: record.revision, retryable: true });
    }
    if (outcome?.status === 'rejected' || (outcome?.status && !['cancelled', 'requested'].includes(outcome.status))) {
      return fail('not_pending', { currentRevision: record.revision });
    }
    this._rememberGesture('cancel', req);
    // 'cancelled' is final now (queued work never reaches a stream); 'requested'
    // waits for the turn's own terminal event, which settles the record.
    if (outcome?.status === 'cancelled') {
      this._apply(req.session_id, req.proposal_id, (current) => {
        const next = current.kind === 'command'
          ? markCommandOutcome(current, { status: 'cancelled' }) : rec.markContinuationOutcome(current, 'cancelled');
        return next ? { record: next } : { abort: { reason: 'noop' } };
      }, proposalGestureReceipt('cancel', req));
      this._untrack(record.continuation_turn_id);
    }
    return succeed({ created: true, proposal: this._project(this._latest(req.session_id, req.proposal_id) || record) });
  }

  async retry(raw) {
    const checked = contract.validateGestureRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const req = checked.value;
    const rec = this._records;
    const found = this._find(req.session_id, req.proposal_id);
    if (!found.ok) return fail(found.reason);
    let { record } = found;
    const replay = this._gestureReplay('retry', req, record);
    if (replay) return replay;
    if (record.revision !== req.expected_revision) return fail('stale_revision', { currentRevision: record.revision });
    const gate = this._project(record).actions.retry;
    if (!gate.available) return fail(gate.reason === 'not_applicable' ? 'not_pending' : gate.reason, { currentRevision: record.revision });
    if (record.kind === 'git') {
      const rechecked = await support.recheckGitRetry(this, req, record);
      if (rechecked.failure) return rechecked.failure;
      record = rechecked.record;
    }
    const prepared = this._apply(req.session_id, req.proposal_id, (current) => {
      const prepare = record.kind === 'session' ? prepareSessionRetry : rec.prepareRetry;
      const next = current.revision === record.revision ? prepare(current, { attemptId: this._createId() }) : null;
      return next ? { record: next } : { abort: { reason: 'stale_revision', revision: current.revision } };
    }, proposalGestureReceipt('retry', req));
    if (!prepared.ok) return prepared.failure;
    this._rememberGesture('retry', req);
    await (record.kind === 'session' ? flow.dispatch(this, req.session_id, prepared.record) : this._dispatch(req.session_id, prepared.record));
    return succeed({ created: true, proposal: this._project(this._latest(req.session_id, req.proposal_id) || prepared.record) });
  }

  // Session kind (checkpoint 5a): see ./chat-proposal-session.
  async getCapabilities(raw) { return session.getCapabilities(this, raw); }

  async setOptions(raw) { return session.setOptions(this, raw); }

  async startAll(raw) { return session.startAll(this, raw); }

  async authorizeLaunch(raw) { return session.authorizeLaunch(this, raw); }

  // Internal (the complete_session_handoff tool): S6's module records the handoff, creates the
  // child and admits its first turn. Never throws.
  async completeHandoff(args) {
    try {
      const mod = this._handoff();
      if (typeof mod?.completeSessionHandoff !== 'function') return fail('unsupported_capability');
      return await mod.completeSessionHandoff(flow.handoffPorts(this), args);
    } catch {
      this._log('WARN', 'chat_proposal.complete_handoff_failed', { reason: 'exception' });
      return fail('unavailable');
    }
  }

  // Send admission (internal): the refusal reason while a linked child waits for its first turn, else null.
  linkedFirstTurnBlock(sessionId, idempotencyKey = null) {
    try { return flow.linkedFirstTurnBlock(this, sessionId, idempotencyKey); } catch { return null; }
  }

  // Archive restore (checkpoint 5b-3): see ./chat-proposal-restore.
  async confirmRestored(raw) { return restore.confirmRestored(this, raw); }

  // ---- continuation dispatch ------------------------------------------------

  // Submits an accepted/queued Git record's continuation and persists the
  // acknowledgment (or the honest refusal). Never throws.
  async _dispatch(sessionId, record) {
    const rec = this._records;
    const proposalId = record.proposal_id;
    let result;
    try {
      result = await continuation.submitContinuation({
        runtime: this._getRuntime(), record, session: this._getSessionSummary(sessionId),
      });
    } catch {
      result = { outcome: 'refused', runtimeUnavailable: false, causeCode: 'exception' };
    }
    if (result.outcome === 'ack') {
      this._track(result.turn_id, sessionId, proposalId, 'queued');
      const acked = this._apply(sessionId, proposalId, (current) => {
        const next = rec.markDispatchAcknowledged(current, { workId: result.work_id, turnId: result.turn_id });
        return next ? { record: next } : { abort: { reason: 'noop' } };
      });
      if (!acked.ok && !acked.aborted) this._log('WARN', 'chat_proposal.ack_not_persisted', { reason: acked.reason });
      return;
    }
    const refused = this._apply(sessionId, proposalId, (current) => {
      const next = rec.markDispatchRefused(current, {
        runtimeUnavailable: result.runtimeUnavailable === true, causeCode: result.causeCode,
      });
      return next ? { record: next } : { abort: { reason: 'noop' } };
    });
    if (!refused.ok && !refused.aborted) this._log('WARN', 'chat_proposal.refusal_not_persisted', { reason: refused.reason });
  }

  // chat-stream events: the only live progress signal for a continuation turn.
  handleChatStreamEvent(event) {
    const turnId = typeof event?.turnId === 'string' ? event.turnId : '';
    flow.onSourceTurnEvent(this, event);
    this._child.onEvent(event);
    const tracked = turnId ? this._tracked.get(turnId) : null;
    if (!tracked) return;
    if (tracked.role === 'prep') return flow.onPrepEvent(this, tracked, event);
    const next = continuation.classifyStreamEvent(event);
    if (!next || (next === 'admitted' && tracked.state === 'admitted')) return;
    const rec = this._records;
    try {
      const applied = this._apply(tracked.sessionId, tracked.proposalId, (current) => {
        const record = next === 'admitted'
          ? rec.markAdmitted(current, { turnId }) : rec.markContinuationOutcome(current, next);
        return record ? { record } : { abort: { reason: 'noop' } };
      });
      if (applied.ok || applied.aborted) {
        if (next === 'admitted') tracked.state = 'admitted';
        else this._untrack(turnId);
      }
    } catch {
      this._log('WARN', 'chat_proposal.outcome_failed', { reason: 'exception' });
    }
  }

  // Runtime events of an accepted Run (E3): progress -> admitted, outcome -> settled.
  handleCommandProgress(event) { command.onProgress(this, event); }

  handleCommandOutcome(event) { command.onOutcome(this, event); }

  // Startup: expire what is due, then settle every unsettled Git continuation and
  // command Run from the runtime store. Reads only; never resumes or resubmits.
  // The wiring runs startupReconcileSteps() (one step per chat) in yielding slices (row 62).
  reconcileOnStartup() { for (const step of this.startupReconcileSteps()) step(); }

  startupReconcileSteps() {
    let ids;
    try { ids = this._listSessionIds() || []; } catch { return []; }
    return ids.map((sessionId) => () => {
      try {
        const read = this._sweep(sessionId, this._store.read(sessionId));
        if (!read.ok || read.frozen) return;
        for (const record of read.records) {
          if (flow.reconcileRecord(this, sessionId, record)) continue;
          if (record.decision_state !== 'accepted' || !['queued', 'admitted'].includes(record.action_state)) continue;
          if (record.kind === 'command') command.reconcileCommand(this, sessionId, record);
          else this._reconcileRecord(sessionId, record);
        }
      } catch {
        this._log('WARN', 'chat_proposal.reconcile_failed', { reason: 'exception' });
      }
    });
  }

  _reconcileRecord(sessionId, record) { support.reconcileContinuation(this, sessionId, record); }

  dispose() {
    flow.disposeFlow(this);
    this._notifier.dispose();
    this._tracked.clear();
    this._gestures.clear();
  }

  // ---- internals ------------------------------------------------------------

  _track(turnId, sessionId, proposalId, state, role = 'continuation') {
    if (typeof turnId === 'string' && turnId) boundedSet(this._tracked, turnId, { sessionId, proposalId, state, role }, MAX_TRACKED_TURNS);
  }

  // Deferred work (dispatch after a launch grant or a released wait) runs after the caller returns.
  _later(fn) {
    const task = new Promise((resolve) => { setImmediate(resolve); })
      .then(fn).catch(() => this._log('WARN', 'chat_proposal.deferred_failed', { reason: 'exception' }))
      .finally(() => this._pending.delete(task));
    this._pending.add(task);
  }

  async idle() {
    while (this._pending.size) await Promise.allSettled([...this._pending]);
  }

  _handoff() {
    if (this._sessionHandoff) return this._sessionHandoff;
    try { return require('./session-handoff-preparation'); } catch { return null; }
  }

  _handoffSupported() {
    try { return this._ports.supportsSessionHandoff() === true && typeof this._handoff()?.buildPreparationRequest === 'function'; } catch { return false; }
  }

  _untrack(turnId) { if (typeof turnId === 'string') this._tracked.delete(turnId); }

  _changed(sessionId) {
    this._notifier.notify(sessionId);
    try { this._notifyCoordination(sessionId); } catch { /* the rail refetches on its next signal */ }
  }

  _runState(sessionId) {
    let session;
    try { session = this._getSessionSummary(sessionId); } catch { session = null; }
    const mode = String(session?.run_mode || '').toLowerCase();
    let lockdown;
    try { lockdown = this._isOfflineLockdown(session) === true; } catch { lockdown = true; } // fail closed
    return { runMode: session?.plan_mode === true || mode === 'plan' ? 'plan' : 'agent', readOnly: mode === 'propose', lockdown };
  }

  _project(record) {
    return this._records.projectProposal(record, {
      now: this._now(), ...this._runState(record.source_session_id), commandRunSupported: this._commandSupported(),
      sessionRuntimeSupported: true, sessionHandoffSupported: record.kind === 'session' && this._handoffSupported(),
      child: this._child.view(record),
    });
  }

  _commandSupported() { try { return this._commandAdapter?.isSupported?.() === true; } catch { return false; } }
  _storeFailure(result) {
    const reason = result.reason === 'io_failed' ? 'io_failed' : (result.reason === 'not_found' ? 'not_found' : 'unavailable');
    return fail(reason, { currentRevision: result.current_revision, retryable: result.retryable });
  }

  // Due pending records become `expired` on read; a failed write still reads right
  // because the projection reports a due record as expired.
  _sweep(sessionId, read) {
    if (!read.ok || read.frozen) return read;
    const nowDate = this._now();
    if (!read.records.some((record) => this._records.expireIfDue(record, nowDate))) return read;
    const result = this._store.mutate(sessionId, ({ records }) => ({
      records: records.map((record) => this._records.expireIfDue(record, nowDate) || record),
    }));
    if (!result.ok || result.aborted) return read;
    this._changed(sessionId);
    return this._store.read(sessionId);
  }

  _find(sessionId, proposalId) {
    const read = this._sweep(sessionId, this._store.read(sessionId));
    if (!read.ok) return { ok: false, reason: read.reason === 'not_found' ? 'not_found' : 'unavailable' };
    if (read.frozen) return { ok: false, reason: 'unavailable' };
    const record = read.records.find((entry) => entry.proposal_id === proposalId);
    return record ? { ok: true, record, revision: read.coordination_revision } : { ok: false, reason: 'not_found' };
  }

  _latest(sessionId, proposalId) {
    const read = this._store.read(sessionId);
    return read.ok ? read.records.find((entry) => entry.proposal_id === proposalId) || null : null;
  }

  // One read-modify-write of one record. `step(current)` returns {record} or
  // {abort}. `receipt` (see proposalGestureReceipt) is written in the same mutation.
  // -> {ok:true, record} | {ok:true, aborted:true, value} | {ok:false, failure, reason}.
  _apply(sessionId, proposalId, step, receipt = null) {
    const result = this._store.mutate(sessionId, ({ records, coordination_receipts: receipts, coordination_revision: revision }) => {
      const index = records.findIndex((entry) => entry.proposal_id === proposalId);
      if (index < 0) return { abort: { reason: 'not_found' } };
      const out = step(records[index]);
      if (!out || out.record === undefined) return { abort: out?.abort || { reason: 'noop' } };
      const next = records.slice();
      next[index] = out.record;
      if (!receipt) return { records: next };
      return { records: next, coordination_receipts: recordGesture(receipts, receipt, { revision: revision + 1, now: this._now() }) };
    });
    if (!result.ok) return { ok: false, reason: result.reason, failure: this._storeFailure(result) };
    if (result.aborted) {
      const reason = result.value?.reason || 'noop';
      return { ok: true, aborted: true, value: result.value, reason, failure: fail(reason === 'noop' ? 'not_pending' : reason, { currentRevision: result.value?.revision }) };
    }
    this._changed(sessionId);
    return { ok: true, record: result.records.find((entry) => entry.proposal_id === proposalId) };
  }

  // Dismiss / accept persistence shared by decide. `envelope:false` returns the
  // raw {ok, record} so the caller can dispatch; otherwise the success envelope.
  _persistDecision(req, record, build, { envelope = true } = {}) {
    const applied = this._apply(req.session_id, record.proposal_id, (current) => {
      if (current.revision !== record.revision) return { abort: { reason: 'stale_revision', revision: current.revision } };
      const next = build(current);
      return next ? { record: next } : { abort: { reason: 'not_pending', revision: current.revision } };
    }, proposalGestureReceipt('decide', req, { choice: req.choice }));
    if (!applied.ok || applied.aborted) {
      const failure = applied.failure;
      return envelope ? failure : { ok: false, failure };
    }
    return envelope ? succeed({ created: true, proposal: this._project(applied.record) }) : applied;
  }

  _decisionReplay(record, req) {
    const replay = this._records.classifyDecisionReplay(record, {
      decisionId: req.decision_id, choice: req.choice, confirmedPreconditions: req.confirmed_preconditions,
    });
    if (replay === 'same') return succeed({ created: false, proposal: this._project(record) });
    return replay === 'conflict' ? fail('idempotency_conflict', { currentRevision: record.revision }) : null;
  }

  // Cancel and retry are not decisions on the record: their gesture ids are remembered per process
  // (bounded) and, once their effect is applied, in a durable coordination receipt. The same id and
  // revision replays, a different payload conflicts.
  _gestureReplay(op, req, record) {
    const known = this._gestures.get(`${req.proposal_id}:${req.decision_id}`);
    const read = known ? null : this._store.read(req.session_id);
    const verdict = known ? { state: known.op === op && known.expectedRevision === req.expected_revision ? 'same' : 'conflict' }
      : (read.ok ? gestureVerdict(read.coordination_receipts, proposalGestureReceipt(op, req)) : { state: 'none' });
    if (verdict.state === 'none') return null;
    return verdict.state === 'same' ? succeed({ created: false, proposal: this._project(record) })
      : fail('idempotency_conflict', { currentRevision: record.revision });
  }

  _rememberGesture(op, req) {
    boundedSet(this._gestures, `${req.proposal_id}:${req.decision_id}`, { op, expectedRevision: req.expected_revision }, MAX_GESTURES);
  }

  _notPending(record) {
    const state = record.decision_state;
    if (state === 'expired') return fail('expired', { currentRevision: record.revision });
    if (state === 'stale') return fail('authority_changed', { currentRevision: record.revision });
    return fail('not_pending', { currentRevision: record.revision });
  }

  async _recheck(record) {
    try {
      const result = await this._recheckGitBinding(record);
      return result && typeof result === 'object' ? result : { ok: false, cause_code: 'unavailable' };
    } catch {
      return { ok: false, cause_code: 'unavailable' };
    }
  }

  // D7: drift marks the record stale (it accepts no choice afterwards); a recapture
  // that could not finish (budget, unreadable Git) is retryable and changes nothing.
  _bindingFailure(req, record, recheck, mark = this._records.markStale) {
    const cause = typeof recheck.cause_code === 'string' ? recheck.cause_code : 'unavailable';
    if (!DRIFT_CAUSES.has(cause)) {
      return fail(cause === 'binding_budget' ? 'capacity' : 'unavailable', { currentRevision: record.revision, retryable: true });
    }
    const marked = this._apply(req.session_id, record.proposal_id, (current) => {
      const next = current.revision === record.revision ? mark(current, { causeCode: cause }) : null;
      return next ? { record: next } : { abort: { reason: 'stale_revision', revision: current.revision } };
    });
    return fail('authority_changed', { currentRevision: marked.record?.revision ?? record.revision });
  }

  // The exact-command Run (Batch B) lives in ./chat-proposal-command.
  _decideRun(req, record) { return command.decideRun(this, req, record); }
}

module.exports = { ChatProposalService };
