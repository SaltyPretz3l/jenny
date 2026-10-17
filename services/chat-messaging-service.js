'use strict';

/* services/chat-messaging-service.js - main-process owner of addressed session
 * messaging (row 59 checkpoint 4): the `chatMessages.*` bridge (listRecipients,
 * prepare, send, retry, cancel, list, markRead, setContextDisposition, discard,
 * setReporting from checkpoint 5b-1, createGrant / revokeGrant from 5b-2 and the archive-restore
 * confirmRestored from 5b-3 in ./chat-messaging-restore), the linked-child terminal
 * reports (./chat-messaging-reports), the agent-facing operations of the `session_message`
 * tool (./chat-messaging-agent), directional grants (./chat-messaging-grants), the change
 * event and startup reconciliation.
 *
 * Records live in `session.session_mail` behind the mail store (S1). Every state
 * change is one synchronous read-modify-write-flush with no await inside, which is
 * the serialization lock on the main thread (D1); the delivery transaction lives
 * in ./chat-messaging-delivery. Diagnostics carry ids, states and reason tokens
 * only, never message bodies, titles or paths.
 */

const { randomUUID } = require('node:crypto');
const mailRecords = require('./backend/session-mail-records');
const E = require('./backend/session-message-envelope');
const { createChangeNotifier } = require('./chat-workspace-change-notifier');
const contract = require('./chat-messaging-contract');
const { createMessageDelivery } = require('./chat-messaging-delivery');
const { createAgentOps } = require('./chat-messaging-agent');
const { createGrantOps, recipientGrantLookup, userSendAuthorization } = require('./chat-messaging-grants');
const { createRestoreOps } = require('./chat-messaging-restore');
const { createReportOps } = require('./chat-messaging-reports');
const { createProjector, sortedInbox, sortedOutbox } = require('./chat-messaging-projection');
const { listRecipients } = require('./chat-messaging-recipients');

const { fail, succeed } = contract;
const MAX_TRACKED_OPERATIONS = 2048;
const RECOVERY_DELAYS_MS = Object.freeze([1000, 4000, 16000]);
const SETTLED_PREPARED_REASONS = new Set(['exists']);

function boundedSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

class ChatMessagingService {
  constructor({
    mailStore,
    getSessionSummary = () => null,
    listSessionSummaries = () => [],
    listSessionIds = () => [],
    getProjectName = () => null,
    isContinuable = () => true,
    getActiveTurn = () => null,
    getSessionMessages = () => [],
    getProposalTitle = () => '',
    appendMessage = () => null,
    flushSession = () => false,
    reconcileAdmissionSnapshots = () => false,
    notifyCoordinationChanged = () => {},
    emit = () => {},
    log = () => {},
    now = () => new Date(),
    createId = randomUUID,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    notifierOptions = {},
  } = {}) {
    if (!mailStore || typeof mailStore.read !== 'function' || typeof mailStore.mutate !== 'function') {
      throw new TypeError('ChatMessagingService requires a session mail store.');
    }
    this._mail = mailStore;
    this._getSessionSummary = getSessionSummary;
    this._listSessionSummaries = listSessionSummaries;
    this._listSessionIds = listSessionIds;
    this._getProjectName = getProjectName;
    this._isContinuable = isContinuable;
    this._getActiveTurn = getActiveTurn;
    this._getSessionMessages = getSessionMessages;
    this._appendMessage = appendMessage;
    this._flushSession = flushSession;
    this._reconcileAdmission = reconcileAdmissionSnapshots;
    this._notifyCoordination = notifyCoordinationChanged;
    this._log = log;
    this._now = now;
    this._createId = createId;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._operations = new Map(); // operation id -> source session id (a locate cache, never authoritative)
    this._recovery = new Map(); // operation id -> { attempt, timer }
    this._notifier = createChangeNotifier({
      emit,
      getRevision: (sessionId) => {
        const read = this._mail.read(sessionId);
        return read.ok ? read.coordination_revision : 0;
      },
      ...notifierOptions,
    });
    this._project = createProjector({ getSessionSummary, getProjectName, getSessionMessages });
    this._delivery = createMessageDelivery({
      mailStore,
      getSessionSummary,
      isContinuable,
      now,
      createId,
      changed: (sessionId) => this.notify(sessionId),
      log,
    });
    this._reports = createReportOps({
      mail: mailStore,
      getSessionSummary,
      getSessionMessages,
      getActiveTurn,
      getProposalTitle,
      now,
      notify: (sessionId) => this.notify(sessionId),
      deliver: (sourceId, operationId) => this.deliverReport(sourceId, operationId),
      storeFailure: (result) => this._storeFailure(result),
      log,
    });
    const shared = {
      mail: mailStore,
      getSessionSummary,
      isContinuable,
      now,
      createId,
      notify: (sessionId) => this.notify(sessionId),
      storeFailure: (result) => this._storeFailure(result),
    };
    this._grants = createGrantOps({ ...shared, settlePending: (sourceId, operationId) => this._delivery.deliver(sourceId, operationId) });
    this._agent = createAgentOps({
      ...shared,
      getProjectName,
      runDelivery: (sourceId, operationId, created) => this._runDelivery(sourceId, operationId, created),
      projectOperation: (op) => this._project.projectOperation(op),
      track: (operationId, sourceId) => boundedSet(this._operations, operationId, sourceId, MAX_TRACKED_OPERATIONS),
    });
    this._restore = createRestoreOps({
      ...shared, locate: (id) => this._locate(id), readOp: (sourceId, id) => this._delivery.readOp(sourceId, id),
      destinationReceipt: (envelope) => this._delivery.destinationReceipt(envelope),
      projectOperation: (op) => this._project.projectOperation(op),
      runDelivery: (sourceId, id, created) => this._runDelivery(sourceId, id, created),
    });
  }

  // ---- change publication ----------------------------------------------------

  // Publishes `chatMessages.onChanged` and the session rail invalidation. Called only
  // after a durable write (also by admission, which writes mail from the turn path).
  notify(sessionId) {
    this._notifier.notify(sessionId);
    try { this._notifyCoordination(sessionId); } catch { /* the rail refetches on its next signal */ }
  }

  // ---- bridge ------------------------------------------------------------------

  async listRecipients(raw) {
    const checked = contract.validateListRecipientsRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const req = checked.value;
    if (!this._getSessionSummary(req.source_session_id)) return fail('not_found');
    const result = listRecipients({
      summaries: this._listSessionSummaries(),
      sourceSessionId: req.source_session_id,
      query: req.query,
      cursor: req.cursor,
      limit: req.limit,
      getProjectName: this._getProjectName,
      isContinuable: this._isContinuable,
      grantFor: recipientGrantLookup(this._mail.read(req.source_session_id), req.source_session_id, this._now()),
    });
    return result.ok
      ? succeed({ items: result.items, next_cursor: result.next_cursor, revision: result.revision })
      : fail(result.reason);
  }

  async prepare(raw) {
    const checked = contract.validatePrepareRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const req = checked.value;
    if (req.source_session_id === req.destination_session_id) return fail('self_send');
    const source = this._mail.read(req.source_session_id);
    if (!source.ok) return fail(source.reason === 'not_found' ? 'not_found' : 'unavailable');
    if (source.frozen) return fail('unavailable', { currentRevision: source.coordination_revision });
    const replay = source.mail.outbox.find((record) => record.gesture_id === req.gesture_id);
    if (replay) return this._prepareReplay(replay, req, source.coordination_revision);
    if (source.archived || !this._continuable(req.source_session_id)) {
      return fail('source_ineligible', { currentRevision: source.coordination_revision });
    }
    const destination = this._mail.read(req.destination_session_id);
    if (!destination.ok) return fail(destination.reason === 'not_found' ? 'recipient_deleted' : 'unavailable');
    if (destination.frozen) return fail('unavailable');
    if (destination.archived) return fail('recipient_archived');
    if (!this._continuable(req.destination_session_id)) return fail('recipient_ineligible');
    const at = this._now();
    const envelope = E.buildUserEnvelope({
      message_id: this._createId(),
      source: { session_id: req.source_session_id, session_incarnation: source.session_incarnation, project_id: source.project_id },
      destination: {
        session_id: req.destination_session_id, session_incarnation: destination.session_incarnation, project_id: destination.project_id,
      },
      body: req.body,
      created_at: at,
    });
    // An empty incarnation cannot be bound into an envelope: the chat is not addressable.
    if (!envelope) return fail('unavailable');
    const operationId = this._createId();
    const record = {
      envelope,
      operation_id: operationId,
      gesture_id: req.gesture_id,
      tool_call_id: null,
      authorization_id: null,
      state: 'prepared',
      prepared_at: at.toISOString(),
      expires_at: new Date(at.getTime() + mailRecords.MAIL_LIMITS.prepared_expiry_ms).toISOString(),
      send_requested_at: null,
      delivered_at: null,
      destination_receipt_id: null,
      last_error: null,
      restore_requires_confirmation: false,
    };
    const result = this._mail.mutate(req.source_session_id, ({ mail }) => {
      const existing = mail.outbox.find((entry) => entry.gesture_id === req.gesture_id);
      if (existing) return { abort: { reason: 'exists' } };
      const next = mailRecords.pruneMail(mail, { now: at });
      if (mailRecords.outboxCapacity(next, envelope).full) return { abort: { reason: 'sender_backpressure' } };
      next.outbox.push(record);
      return { mail: next };
    });
    if (!result.ok) {
      if (result.aborted && SETTLED_PREPARED_REASONS.has(result.reason)) return this.prepare(raw);
      return this._storeFailure(result);
    }
    this._operations.delete(operationId);
    boundedSet(this._operations, operationId, req.source_session_id, MAX_TRACKED_OPERATIONS);
    this.notify(req.source_session_id);
    return succeed({ operation_id: operationId, envelope, expires_at: record.expires_at });
  }

  async send(raw) {
    const checked = contract.validateOperationRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { operation_id: operationId } = checked.value;
    const sourceId = this._locate(operationId);
    if (!sourceId) return fail('stale_operation');
    const at = this._now();
    const result = this._mail.mutate(sourceId, ({ mail, session }) => {
      const index = mail.outbox.findIndex((record) => record.operation_id === operationId);
      if (index < 0) return { abort: { reason: 'stale_operation' } };
      const op = mail.outbox[index];
      if (['pending', 'delivered'].includes(op.state)) return { abort: { reason: 'replay' } };
      if (op.state !== 'prepared' || op.envelope.kind !== 'user_message') return { abort: { reason: 'stale_operation' } };
      if (op.expires_at !== null && Date.parse(op.expires_at) <= at.getTime()) return { abort: { reason: 'expired' } };
      const { envelope } = op;
      if (session.session_incarnation !== envelope.source_session_incarnation
        || session.project_id !== envelope.source_project_id) return { abort: { reason: 'stale_operation' } };
      if (session.archived) return { abort: { reason: 'source_ineligible' } };
      const authorizationId = this._createId();
      const outbox = mail.outbox.slice();
      outbox[index] = { ...op, state: 'pending', authorization_id: authorizationId, send_requested_at: at.toISOString() };
      return {
        mail: {
          ...mail,
          outbox,
          authorizations: [...mail.authorizations, userSendAuthorization(op, authorizationId, at)],
        },
      };
    });
    if (!result.ok && !(result.aborted && result.reason === 'replay')) return this._storeFailure(result);
    if (result.ok) this.notify(sourceId);
    return this._runDelivery(sourceId, operationId, result.ok);
  }

  async retry(raw) {
    const checked = contract.validateOperationRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { operation_id: operationId } = checked.value;
    const sourceId = this._locate(operationId);
    const op = sourceId ? this._delivery.readOp(sourceId, operationId) : null;
    if (!op) return fail('stale_operation');
    if (['pending', 'delivered'].includes(op.state)) return this._runDelivery(sourceId, operationId, false);
    if (op.state !== 'failed') return fail('stale_operation');
    const resumed = this._delivery.resume(sourceId, operationId);
    if (!resumed.ok) {
      if (!resumed.aborted) return this._storeFailure(resumed);
      return fail(resumed.reason === 'not_failed' ? 'stale_operation' : resumed.reason, { currentRevision: resumed.current_revision });
    }
    return this._runDelivery(sourceId, operationId, true);
  }

  async cancel(raw) {
    const checked = contract.validateOperationRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { operation_id: operationId } = checked.value;
    const sourceId = this._locate(operationId);
    if (!sourceId) return fail('stale_operation');
    this._clearRecovery(operationId);
    const outcome = this._delivery.cancel(sourceId, operationId);
    if (!outcome.ok) return fail(outcome.reason);
    return succeed({ created: outcome.created, operation: this._project.projectOperation(outcome.operation) });
  }

  async list(raw) {
    const checked = contract.validateListRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { session_id: sessionId, direction, cursor, limit } = checked.value;
    this._sweepExpired(sessionId);
    const read = this._mail.read(sessionId);
    if (!read.ok) return fail(read.reason === 'not_found' ? 'not_found' : 'unavailable');
    const revision = read.coordination_revision;
    const scope = `${sessionId}:${direction}`;
    const sorted = direction === 'inbox' ? sortedInbox(read.mail) : sortedOutbox(read.mail, this._now().getTime());
    let start = 0;
    if (cursor !== null) {
      const decoded = contract.decodeCursor(cursor, { scope, revision });
      if (!decoded.ok) return fail(decoded.reason, { currentRevision: revision });
      start = sorted.findIndex((entry) => entry.after(decoded.key));
      if (start < 0) start = sorted.length;
    }
    const page = sorted.slice(start, start + limit);
    const last = page[page.length - 1];
    const more = start + limit < sorted.length && last;
    const items = direction === 'inbox'
      ? this._project.projectInboxPage(sessionId, page.map((entry) => entry.record))
      : page.map((entry) => this._project.projectOperation(entry.record));
    return succeed({
      items,
      next_cursor: more ? contract.encodeCursor({ scope, revision, key: last.key }) : null,
      revision,
      counts: mailRecords.computeCounts(read.mail),
    });
  }

  async markRead(raw) {
    const checked = contract.validateMessageIdsRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { session_id: sessionId, message_ids: messageIds } = checked.value;
    const ids = new Set(messageIds);
    const at = this._now();
    let updated = 0;
    const result = this._mail.mutate(sessionId, ({ mail }) => {
      if (!this._allBelong(mail, ids)) return { abort: { reason: 'invalid_request' } };
      updated = 0;
      const inbox = mail.inbox.map((record) => {
        if (!ids.has(record.envelope.message_id) || record.read_at !== null) return record;
        updated += 1;
        return { ...record, read_at: at.toISOString() };
      });
      return { mail: mailRecords.pruneMail({ ...mail, inbox }, { now: at }) };
    });
    return this._countedResult(sessionId, result, () => updated);
  }

  async setContextDisposition(raw) {
    const checked = contract.validateMessageIdsRequest(raw, { disposition: true });
    if (!checked.ok) return fail(checked.reason);
    const { session_id: sessionId, message_ids: messageIds, disposition } = checked.value;
    const ids = new Set(messageIds);
    const at = this._now().toISOString();
    let updated = 0;
    const result = this._mail.mutate(sessionId, ({ mail }) => {
      const targets = mail.inbox.filter((record) => ids.has(record.envelope.message_id));
      if (targets.length !== ids.size) return { abort: { reason: 'invalid_request' } };
      if (targets.some((record) => !['queued', 'excluded_by_user'].includes(record.context.state))) return { abort: { reason: 'busy' } };
      updated = 0;
      const context = disposition === 'queued' ? { state: 'queued' } : { state: 'excluded_by_user', changed_at: at };
      const inbox = mail.inbox.map((record) => {
        if (!ids.has(record.envelope.message_id) || record.context.state === disposition) return record;
        updated += 1;
        return { ...record, context };
      });
      return { mail: { ...mail, inbox } };
    });
    return this._countedResult(sessionId, result, () => updated);
  }

  async discard(raw) {
    const checked = contract.validateMessageIdsRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { session_id: sessionId, message_ids: messageIds } = checked.value;
    const read = this._mail.read(sessionId);
    if (!read.ok) return fail(read.reason === 'not_found' ? 'not_found' : 'unavailable');
    if (read.frozen) return fail('unavailable', { currentRevision: read.coordination_revision });
    // D4: the receipt row must never land mid-turn.
    if (this._getActiveTurn(sessionId)) return fail('busy', { currentRevision: read.coordination_revision });
    const pending = [];
    for (const id of messageIds) {
      const record = read.mail.inbox.find((entry) => entry.envelope.message_id === id);
      if (record) {
        if (!['queued', 'excluded_by_user'].includes(record.context.state)) return fail('busy', { currentRevision: read.coordination_revision });
        pending.push(record);
      } else if (!read.mail.discarded.some((entry) => entry.message_id === id)) {
        return fail('invalid_request', { currentRevision: read.coordination_revision });
      }
    }
    // The canonical receipt row goes first and is flushed; only then may the inbox entry retire.
    const rows = this._receiptRows(sessionId, pending);
    if (!rows.ok) return fail(rows.reason, { currentRevision: read.coordination_revision });
    const at = this._now().toISOString();
    const result = this._mail.mutate(sessionId, ({ mail }) => {
      const inbox = [];
      const discarded = [...mail.discarded];
      let moved = 0;
      for (const record of mail.inbox) {
        if (!messageIds.includes(record.envelope.message_id)) { inbox.push(record); continue; }
        if (!['queued', 'excluded_by_user'].includes(record.context.state)) return { abort: { reason: 'busy' } };
        moved += 1;
        discarded.push({
          schema_version: 1,
          message_id: record.envelope.message_id,
          envelope_sha256: E.envelopeSha256(record.envelope),
          receipt_id: record.receipt_id,
          receive_sequence: record.receive_sequence,
          discarded_at: at,
          source_receipt_confirmed_at: record.source_receipt_confirmed_at,
          source_absent: record.source_absent,
          canonical_message_id: `${E.RECEIPT_ROW_PREFIX}${record.envelope.message_id}`,
        });
      }
      return moved === 0 ? { mail } : { mail: { ...mail, inbox, discarded } };
    });
    return this._countedResult(sessionId, result, () => pending.length);
  }

  async confirmRestored(raw) { return this._restore.confirmRestored(raw); }

  // ---- directional grants and the agent tool (cp5b-2) ------------------------------

  async createGrant(raw) { return this._grants.createGrant(raw); }
  async revokeGrant(raw) { return this._grants.revokeGrant(raw); }
  listAgentTargets(args) { return this._agent.listAgentTargets(args); }
  agentPrepare(args) { return this._agent.agentPrepare(args); }
  agentSend(args) { return this._agent.agentSend(args); }
  agentCancel(args) { return this._agent.agentCancel(args); }
  agentRead(args) { return this._agent.agentRead(args); }

  // ---- linked-child terminal reports (cp5b-1) -------------------------------------

  setReporting(raw) { return this._reports.setReporting(raw); }

  // Settles a turn's report reservation into one pending outbox report and delivers it.
  convertReport(raw) { return this._reports.convertReport(raw); }

  // Delivers a pending report through the existing delivery transaction (also the Retry path's engine).
  deliverReport(childSessionId, operationId) {
    boundedSet(this._operations, operationId, childSessionId, MAX_TRACKED_OPERATIONS);
    return this._runDelivery(childSessionId, operationId, false);
  }

  // ---- startup -----------------------------------------------------------------

  // Marks records from deleted sources, repeats pending deliveries, finishes acknowledgments,
  // expires prepared operations and lets admission settle reserved snapshots. Never throws; one bad session is skipped.
  reconcileOnStartup() {
    let ids;
    try { ids = this._listSessionIds() || []; } catch { return; }
    const receiptCache = new Map();
    const liveIds = new Set(ids);
    for (const sessionId of ids) {
      try {
        this._delivery.markAbsentSources(sessionId, liveIds);
        this._delivery.reconcileSession(sessionId, receiptCache);
        receiptCache.clear();
        const read = this._mail.read(sessionId);
        if (!read.ok || read.frozen) continue;
        for (const op of read.mail.outbox) {
          if (op.state !== 'delivered' && op.state !== 'cancelled') boundedSet(this._operations, op.operation_id, sessionId, MAX_TRACKED_OPERATIONS);
        }
        if (read.mail.admission_snapshots.some((snapshot) => snapshot.state === 'reserved')) {
          if (this._reconcileAdmission(sessionId)) this.notify(sessionId);
        }
        this._reports.repairSession(sessionId, liveIds);
      } catch {
        this._log('WARN', 'chat_messaging.reconcile_failed', { reason: 'exception' });
      }
    }
  }

  dispose() {
    this._notifier.dispose();
    for (const entry of this._recovery.values()) if (entry.timer) this._clearTimer(entry.timer);
    this._recovery.clear();
    this._operations.clear();
  }

  // ---- internals ---------------------------------------------------------------

  _continuable(sessionId) {
    const summary = this._getSessionSummary(sessionId);
    try { return Boolean(summary) && this._isContinuable(summary) !== false; } catch { return false; }
  }

  _storeFailure(result) {
    const reason = result.reason === 'io_failed' ? 'persistence_failure' : (result.reason === 'invalid_record' ? 'unavailable' : result.reason);
    return fail(reason, { currentRevision: result.current_revision, retryable: result.retryable });
  }

  _countedResult(sessionId, result, count) {
    if (!result.ok) return this._storeFailure(result);
    if (!result.noop) this.notify(sessionId);
    return succeed({ updated_count: count(), revision: result.coordination_revision });
  }

  _allBelong(mail, ids) {
    return [...ids].every((id) => mail.inbox.some((record) => record.envelope.message_id === id)
      || mail.discarded.some((record) => record.message_id === id));
  }

  // The source of an operation: the locate cache, else a bounded scan of every chat's outbox.
  _locate(operationId) {
    const cached = this._operations.get(operationId);
    if (cached && this._delivery.readOp(cached, operationId)) return cached;
    let ids;
    try { ids = this._listSessionIds() || []; } catch { return null; }
    for (const sessionId of ids) {
      if (this._delivery.readOp(sessionId, operationId)) {
        boundedSet(this._operations, operationId, sessionId, MAX_TRACKED_OPERATIONS);
        return sessionId;
      }
    }
    return null;
  }

  _prepareReplay(record, req, revision) {
    const { envelope } = record;
    const same = envelope.destination_session_id === req.destination_session_id && envelope.source_session_id === req.source_session_id
      && envelope.body === req.body;
    if (!same) return fail('idempotency_conflict', { currentRevision: revision });
    return succeed({ operation_id: record.operation_id, envelope, expires_at: record.expires_at });
  }

  // Runs the delivery phases and shapes the answer. A transient write failure leaves the
  // operation pending and schedules a bounded in-process retry; Retry and restart also recover it.
  _runDelivery(sourceId, operationId, created) {
    const outcome = this._delivery.deliver(sourceId, operationId);
    if (!outcome.ok) {
      if (outcome.reason === 'persistence_failure') this._scheduleRecovery(sourceId, operationId);
      return fail(outcome.reason);
    }
    this._clearRecovery(operationId);
    return succeed({ created, operation: this._project.projectOperation(outcome.operation) });
  }

  _scheduleRecovery(sourceId, operationId) {
    const entry = this._recovery.get(operationId) || { attempt: 0, timer: null };
    if (entry.timer) return;
    if (entry.attempt >= RECOVERY_DELAYS_MS.length) {
      this._recovery.delete(operationId); // out of tries: Retry or the next restart recovers it
      return;
    }
    const delay = RECOVERY_DELAYS_MS[entry.attempt];
    entry.attempt += 1;
    entry.timer = this._setTimer(() => {
      entry.timer = null;
      const outcome = this._delivery.deliver(sourceId, operationId);
      if (outcome.ok) this._recovery.delete(operationId);
      else if (outcome.reason === 'persistence_failure') this._scheduleRecovery(sourceId, operationId);
      else this._recovery.delete(operationId);
    }, delay);
    entry.timer?.unref?.();
    this._recovery.set(operationId, entry);
  }

  _clearRecovery(operationId) {
    const entry = this._recovery.get(operationId);
    if (entry?.timer) this._clearTimer(entry.timer);
    this._recovery.delete(operationId);
  }

  // Persist the cancellation of prepared operations that passed their 24 hour expiry.
  _sweepExpired(sessionId) {
    const read = this._mail.read(sessionId);
    if (!read.ok || read.frozen) return;
    const nowMs = this._now().getTime();
    if (!read.mail.outbox.some((op) => op.state === 'prepared' && op.expires_at !== null && Date.parse(op.expires_at) <= nowMs)) return;
    const result = this._mail.mutate(sessionId, ({ mail }) => ({ mail: mailRecords.pruneMail(mail, { now: this._now() }) }));
    if (result.ok && !result.noop) this.notify(sessionId);
  }

  // The receipt rows of a discard: appended once, flushed together; an existing identical row is a replay.
  _receiptRows(sessionId, records) {
    if (records.length === 0) return { ok: true };
    let existing;
    try { existing = new Map((this._getSessionMessages(sessionId) || []).map((row) => [row?.id, row])); } catch { existing = new Map(); }
    let appended = false;
    for (const record of records) {
      const row = E.buildDiscardReceiptRow(record.envelope, { timestamp: this._now() });
      if (!row) return { ok: false, reason: 'invalid_request' };
      const found = existing.get(row.id);
      if (found) {
        if (!E.contextRowsEquivalent(found, row)) return { ok: false, reason: 'idempotency_conflict' };
        continue;
      }
      if (!this._appendMessage(sessionId, row, { updatePreview: false, keepDraft: true })) return { ok: false, reason: 'persistence_failure' };
      appended = true;
    }
    return appended && this._flushSession(sessionId) !== true ? { ok: false, reason: 'persistence_failure' } : { ok: true };
  }
}

module.exports = { ChatMessagingService };
