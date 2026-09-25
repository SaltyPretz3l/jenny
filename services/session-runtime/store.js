'use strict';
const { createRuntimeStoreIO } = require('./store-io');
const { compactTerminalDetail } = require('./terminal-retention');
const { isPendingInputRevision, updatePendingInput } = require('./pending-input');
const { TERMINAL, isTerminalTombstone } = require('./terminal-retention-contract');
const path = require('node:path');
const crypto = require('node:crypto');
const { RuntimeStoreError, isoNow, attemptMatches, requestWorkControl } = require('./store-control');
const {
  MAX_INDEX_BYTES,
  MAX_PENDING_INPUT_BYTES,
  MAX_WORK_RECORD_BYTES,
  RUNTIME_STORE_SCHEMA_VERSION,
  cloneJson,
  createIndexDocument,
  normalizeAttempt,
  normalizeAuthority,
  normalizeCheckpointRef,
  pendingCapacityReason,
  pendingProjection,
  stableJson,
  submissionHash,
  validId,
  validateIndexDocument,
  validateJournal,
  validateWorkRecord,
  workSummary,
} = require('./contracts');
const TRANSITIONS = Object.freeze({
  pending: new Set(['paused', 'running', 'cancelled']),
  paused: new Set(['pending', 'running', 'cancelled']),
  running: new Set(['paused', 'completed', 'failed', 'cancelled', 'needs_attention']),
  needs_attention: new Set(['paused', 'completed', 'failed', 'cancelled']),
  completed: new Set(), failed: new Set(), cancelled: new Set(),
});
const UNFINISHED = new Set(['pending', 'running']);
const MAX_CACHED_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_RECORDS = 8;
const IMMUTABLE_FIELDS = ['work_id', 'turn_id', 'idempotency_key', 'submission_sequence',
  'project_id', 'session_id', 'purpose', 'created_at'];
function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
function decodeCursor(cursor) {
  if (cursor === null || cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || Object.keys(parsed).sort().join(',') !== 'offset,project_id,revision,session_id'
      || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0
      || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) throw new Error('invalid');
    return parsed;
  } catch (_error) {
    throw new RuntimeStoreError('invalid_cursor');
  }
}
class RuntimeStore {
  constructor(root, { io = createRuntimeStoreIO(), now = () => new Date(),
    createId: idFactory = createId, logger = null } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('runtime store root is required');
    this.root = root;
    this.io = io;
    this.now = now;
    this.createId = idFactory;
    this.logger = typeof logger === 'function' ? logger : null;
    this.indexPath = path.join(root, 'index.json');
    this.journalPath = path.join(root, 'transition.json');
    this.workDirectory = path.join(root, 'work');
    this.readOnly = false;
    this.reason = null;
    this.records = new Map();
    this.recordFiles = new Set();
    this.index = createIndexDocument();
    this._load();
  }
  getStatus() {
    return Object.freeze({ read_only: this.readOnly, reason: this.reason,
      schema_version: RUNTIME_STORE_SCHEMA_VERSION, revision: this.index.revision,
      pending: cloneJson(this.index.pending) });
  }
  get(workId) {
    if (!validId(workId)) throw new RuntimeStoreError('invalid_work_id');
    const record = this._loadRecord(workId);
    return record ? cloneJson(record) : null;
  }
  findSubmission(idempotencyKey) {
    if (!validId(idempotencyKey)) throw new RuntimeStoreError('invalid_submission_key');
    const summary = this.index.summaries.find(entry => entry.idempotency_key === idempotencyKey);
    return summary ? this.get(summary.work_id) : null;
  }
  submit({ idempotencyKey, projectId, sessionId, purpose, input, authority,
    workId = this.createId('work'), turnId = this.createId('turn') } = {}) {
    this._assertWritable();
    if (!validId(idempotencyKey) || !validId(projectId) || !validId(sessionId)
      || !validId(workId) || !validId(turnId) || typeof purpose !== 'string'
      || !purpose.trim() || purpose.length > 256 || !input || typeof input !== 'object'
      || Array.isArray(input)) throw new RuntimeStoreError('invalid_submission');
    const normalizedAuthority = normalizeAuthority(authority);
    if (!normalizedAuthority || normalizedAuthority.project_id !== projectId) {
      throw new RuntimeStoreError('invalid_authority');
    }
    let savedInput;
    try { savedInput = cloneJson(input); } catch (_error) {
      throw new RuntimeStoreError('invalid_submission_input');
    }
    if (isTerminalTombstone(savedInput)) throw new RuntimeStoreError('invalid_submission_input');
    const inputBytes = Buffer.byteLength(JSON.stringify(savedInput), 'utf8');
    if (inputBytes > MAX_PENDING_INPUT_BYTES) throw new RuntimeStoreError('pending_input_capacity');
    let hash;
    try {
      hash = submissionHash({ authority: normalizedAuthority, input: savedInput,
        project_id: projectId, purpose: purpose.trim(), session_id: sessionId });
    } catch (_error) { throw new RuntimeStoreError('invalid_submission_input'); }
    const duplicate = this.index.summaries.find((entry) => entry.idempotency_key === idempotencyKey);
    if (duplicate) {
      const existing = this._loadRecord(duplicate.work_id);
      if (!existing || existing.submission_hash !== hash) {
        throw new RuntimeStoreError('idempotency_conflict');
      }
      return Object.freeze({ created: false, record: cloneJson(existing) });
    }
    if (this.recordFiles.has(workId)) throw new RuntimeStoreError('work_id_conflict');
    if (this.index.summaries.some((entry) => entry.turn_id === turnId)) {
      throw new RuntimeStoreError('turn_id_conflict');
    }
    const at = isoNow(this.now);
    const record = {
      schema_version: RUNTIME_STORE_SCHEMA_VERSION, work_id: workId, turn_id: turnId,
      idempotency_key: idempotencyKey, submission_hash: hash, revision: 1,
      submission_sequence: this.index.next_submission_sequence,
      project_id: projectId, session_id: sessionId, purpose: purpose.trim(), status: 'pending',
      input: savedInput, input_bytes: inputBytes, authority: normalizedAuthority, attempt: null,
      checkpoint_ref: null, control_request: null,
      transition: { transition_id: this.createId('transition'), from: null, to: 'pending',
        reason: 'Durable submission accepted.', at },
      recovery: null, created_at: at, updated_at: at,
    };
    const checked = validateWorkRecord(record);
    if (!checked.ok) throw new RuntimeStoreError(checked.reason);
    let commitStarted = false;
    try { this._commit(checked.record, () => { commitStarted = true; }); }
    catch (error) { error.submissionOutcome = commitStarted ? 'unknown' : 'rejected'; throw error; }
    return Object.freeze({ created: true, record: cloneJson(checked.record) });
  }
  updatePending(workId, options) { return updatePendingInput(this, workId, options); }
  transition(workId, { expectedRevision, to, reason, transitionId = this.createId('transition'),
    attempt = null, expectedAttempt = null, checkpointRef = undefined, clearPause = false } = {}) {
    this._assertWritable();
    const current = this._loadRecord(workId);
    if (!current) throw new RuntimeStoreError('work_not_found');
    if (current.transition.transition_id === transitionId) {
      if (current.status !== to || current.transition.reason !== String(reason || '').trim()) {
        throw new RuntimeStoreError('transition_id_conflict');
      }
      if (checkpointRef !== undefined) {
        const checkpoint = normalizeCheckpointRef(checkpointRef);
        if (checkpoint === undefined || stableJson(checkpoint) !== stableJson(current.checkpoint_ref)) {
          throw new RuntimeStoreError('transition_id_conflict');
        }
      }
      return Object.freeze({ changed: false, record: cloneJson(current) });
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new RuntimeStoreError('revision_conflict');
    }
    if (clearPause && (current.status !== 'paused' || to !== 'pending'
      || reason !== 'explicit_resume' || current.control_request?.kind !== 'pause')) {
      throw new RuntimeStoreError('pause_clear_state_conflict');
    }
    if (current.control_request && !clearPause && (to === 'pending' || to === 'running')) {
      throw new RuntimeStoreError(current.control_request.kind === 'cancel'
        ? 'cancellation_requested' : 'pause_requested');
    }
    if (!TRANSITIONS[current.status]?.has(to) || !validId(transitionId)
      || typeof reason !== 'string' || !reason.trim() || reason.length > 256) {
      throw new RuntimeStoreError('invalid_transition');
    }
    let nextAttempt = current.attempt;
    if (to === 'running') {
      nextAttempt = normalizeAttempt(attempt);
      if (!nextAttempt || (current.attempt && (nextAttempt.attempt_id === current.attempt.attempt_id
        || nextAttempt.stream_id === current.attempt.stream_id))) {
        throw new RuntimeStoreError('attempt_not_fresh');
      }
    } else if ((current.status === 'running'
      || (TERMINAL.has(to) && (current.status === 'needs_attention'
        || Boolean(current.control_request && current.attempt))))
      && !attemptMatches(current.attempt, expectedAttempt)) {
      throw new RuntimeStoreError('attempt_fence_conflict');
    }
    const at = isoNow(this.now);
    const checkpoint = checkpointRef === undefined ? current.checkpoint_ref : normalizeCheckpointRef(checkpointRef);
    if (checkpoint === undefined || (checkpointRef !== undefined
      && (to !== 'paused' || current.status !== 'running' || !checkpoint
        || !attemptMatches(current.attempt, checkpoint.source_attempt)))) {
      throw new RuntimeStoreError('checkpoint_fence_conflict');
    }
    const next = { ...current, revision: current.revision + 1, status: to,
      control_request: clearPause ? null : current.control_request,
      attempt: nextAttempt, checkpoint_ref: checkpoint, transition: { transition_id: transitionId, from: current.status,
        to, reason: reason.trim(), at }, recovery: null, updated_at: at };
    const checked = validateWorkRecord(next);
    if (!checked.ok) throw new RuntimeStoreError(checked.reason);
    this._commit(checked.record);
    return Object.freeze({ changed: true, record: cloneJson(checked.record) });
  }
  attachRecoveredCheckpoint(workId, { expectedRevision, expectedAttempt, checkpointRef } = {}) {
    this._assertWritable();
    const current = this._loadRecord(workId);
    if (!current) throw new RuntimeStoreError('work_not_found');
    const interruptedPublication = current.status === 'needs_attention'
      && ['pause', 'cancel'].includes(current.control_request?.kind)
      && current.transition?.from === 'running' && current.transition.reason === 'settlement_unconfirmed';
    const repairedPublication = current.status === 'paused' && current.checkpoint_ref
      && current.recovery?.kind === 'transition_repaired' && current.recovery.previous_status === 'needs_attention';
    if (current.control_request?.kind === 'cancel' && !interruptedPublication && !repairedPublication) throw new RuntimeStoreError('cancellation_requested');
    const checkpoint = normalizeCheckpointRef(checkpointRef);
    if (!checkpoint || !attemptMatches(current.attempt, expectedAttempt)
      || !attemptMatches(current.attempt, checkpoint.source_attempt)) {
      throw new RuntimeStoreError('checkpoint_fence_conflict');
    }
    if (!interruptedPublication && !repairedPublication && (current.status !== 'paused' || current.recovery?.kind !== 'restart_paused'
      || current.recovery.previous_status !== 'running')) {
      throw new RuntimeStoreError('checkpoint_recovery_state_conflict');
    }
    if (current.checkpoint_ref) {
      if (stableJson(current.checkpoint_ref) !== stableJson(checkpoint)) {
        throw new RuntimeStoreError('checkpoint_fence_conflict');
      }
      return Object.freeze({ changed: false, record: cloneJson(current) });
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new RuntimeStoreError('revision_conflict');
    }
    const at = isoNow(this.now);
    const next = { ...current, revision: current.revision + 1,
      checkpoint_ref: checkpoint, updated_at: at,
      ...(interruptedPublication ? { status: 'paused',
        transition: { transition_id: this.createId('transition'), from: current.status, to: 'paused',
          reason: 'Recovered exact published checkpoint after interrupted settlement.', at },
        recovery: { kind: 'transition_repaired', previous_status: current.status,
          reason: 'Recovered checkpoint retains explicit pause/cancellation intent.', at } } : {}) };
    const checked = validateWorkRecord(next);
    if (!checked.ok) throw new RuntimeStoreError(checked.reason);
    this._commit(checked.record);
    return Object.freeze({ changed: true, record: cloneJson(checked.record) });
  }
  requestPause(workId, options = {}) {
    return requestWorkControl(this, workId, options, 'pause');
  }

  requestCancellation(workId, options = {}) {
    return requestWorkControl(this, workId, options, 'cancel');
  }

  listSummaries({ cursor = null, limit = 50, projectId = null, sessionId = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (projectId !== null && !validId(projectId)) || (sessionId !== null && !validId(sessionId))) {
      throw new RuntimeStoreError('invalid_page_request');
    }
    const position = decodeCursor(cursor);
    if (position && position.revision !== this.index.revision) throw new RuntimeStoreError('stale_cursor');
    if (position && (position.project_id !== projectId || position.session_id !== sessionId)) {
      throw new RuntimeStoreError('cursor_scope_mismatch');
    }
    const summaries = this.index.summaries.filter((entry) => (
      (projectId === null || entry.project_id === projectId)
      && (sessionId === null || entry.session_id === sessionId)
    )).sort((left, right) => right.updated_at.localeCompare(left.updated_at)
      || left.work_id.localeCompare(right.work_id));
    const offset = position?.offset || 0;
    const items = summaries.slice(offset, offset + limit).map(cloneJson);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < summaries.length
      ? Buffer.from(JSON.stringify({ revision: this.index.revision, offset: nextOffset,
        project_id: projectId, session_id: sessionId })).toString('base64url')
      : null;
    return Object.freeze({ items: Object.freeze(items), next_cursor: nextCursor,
      revision: this.index.revision });
  }

  compactTerminalDetail(options) { return compactTerminalDetail(this, options); }

  listReadyCandidates({ limit = 256 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RuntimeStoreError('invalid_ready_request');
    }
    return Object.freeze(this.index.summaries.filter((entry) => entry.status === 'pending')
      .slice(0, limit).map(cloneJson));
  }

  listMutationRecoveryCandidates() {
    const saved = this.io.readJson(path.join(this.root, 'mutation-recovery-cursor.json'), { maxBytes: 512 });
    const cursorValid = saved.status === 'ok' && saved.value?.schema_version === 1
      && Object.keys(saved.value).length === 2 && validId(saved.value.after_work_id);
    // The cursor carries scan fairness, never mutation authority. Corruption restarts the scan.
    const candidates = this.index.summaries.filter(entry =>
      ['paused', 'needs_attention', 'failed', 'cancelled'].includes(entry.status)).toReversed();
    const after = cursorValid ? candidates.findIndex(entry => entry.work_id === saved.value.after_work_id) : -1;
    const rotated = [...candidates.slice(after + 1), ...candidates.slice(0, after + 1)];
    return Object.freeze({ items: Object.freeze(rotated.slice(0, 64).map(cloneJson)),
      deferred: Math.max(0, rotated.length - 64), cursor_blocked: saved.status !== 'missing' && !cursorValid });
  }

  advanceMutationRecoveryCursor(workId) {
    this._assertWritable();
    if (!validId(workId)) throw new RuntimeStoreError('recovery_cursor_invalid');
    this.io.writeJsonAtomic(path.join(this.root, 'mutation-recovery-cursor.json'),
      { schema_version: 1, after_work_id: workId });
  }

  _assertWritable() {
    if (this.readOnly) throw new RuntimeStoreError('store_read_only', this.reason || 'store_read_only');
  }

  _workPath(workId) { return path.join(this.workDirectory, `${workId}.json`); }

  _setReadOnly(reason, error = null) {
    this.readOnly = true;
    this.reason = reason;
    try { this.logger?.('ERROR', 'runtime_store.read_only', { reason, error: error?.message || null }); }
    catch (_error) { /* Diagnostics must not hide the original failure. */ }
  }
  _readDocument(filePath, maxBytes = MAX_INDEX_BYTES) {
    try { return this.io.readJson(filePath, { maxBytes }); } catch (error) {
      return { status: 'corrupt', error };
    }
  }
  _readRecordFile(workId) {
    const read = this._readDocument(this._workPath(workId), MAX_WORK_RECORD_BYTES);
    if (read.status !== 'ok') return { ok: false, reason: 'work_record_unreadable', error: read.error };
    const checked = validateWorkRecord(read.value);
    if (!checked.ok) return checked;
    if (checked.record.work_id !== workId) return { ok: false, reason: 'work_record_filename_mismatch' };
    return checked;
  }
  _loadRecord(workId) {
    const cached = this.records.get(workId);
    if (cached) return cached;
    const summary = this.index.summaries.find((entry) => entry.work_id === workId);
    if (!summary) return null;
    if (!this.recordFiles.has(workId)) {
      this._setReadOnly('index_record_mismatch');
      throw new RuntimeStoreError('store_read_only', this.reason);
    }
    const checked = this._readRecordFile(workId);
    if (!checked.ok || stableJson(workSummary(checked.record)) !== stableJson(summary)) {
      this._setReadOnly(checked.reason || 'index_record_mismatch', checked.error);
      throw new RuntimeStoreError('store_read_only', this.reason);
    }
    this._rememberRecord(checked.record);
    return checked.record;
  }

  _rememberRecord(record) {
    this.records.delete(record.work_id);
    if (TERMINAL.has(record.status)) return;
    this.records.set(record.work_id, record);
    const cachedBytes = () => [...this.records.values()]
      .reduce((sum, entry) => sum + entry.input_bytes + 64 * 1024, 0);
    while (this.records.size > MAX_CACHED_RECORDS || cachedBytes() > MAX_CACHED_INPUT_BYTES) {
      this.records.delete(this.records.keys().next().value);
    }
  }
  _load(pauseUnfinished = true) {
    const journalRead = this._readDocument(this.journalPath, MAX_WORK_RECORD_BYTES + 64 * 1024);
    let journal = null;
    if (journalRead.status === 'corrupt') return this._setReadOnly('journal_unreadable', journalRead.error);
    if (journalRead.status === 'ok') {
      const checked = validateJournal(journalRead.value);
      if (!checked.ok) return this._setReadOnly(checked.reason);
      journal = checked.journal;
    }
    const indexRead = this._readDocument(this.indexPath, MAX_INDEX_BYTES);
    if (indexRead.status === 'corrupt') return this._setReadOnly('index_unreadable', indexRead.error);
    const loadedIndex = indexRead.status === 'ok' ? validateIndexDocument(indexRead.value) : null;
    if (loadedIndex && !loadedIndex.ok) return this._setReadOnly(loadedIndex.reason);
    let files;
    try { files = this.io.listJson(this.workDirectory); } catch (error) {
      return this._setReadOnly('work_directory_unreadable', error);
    }
    if (files.length > 100_000) return this._setReadOnly('work_record_capacity');
    for (const filePath of files) {
      const basename = path.basename(filePath);
      const workId = basename.endsWith('.json') ? basename.slice(0, -5) : '';
      if (!validId(workId) || basename !== `${workId}.json`) {
        return this._setReadOnly('work_record_filename_mismatch');
      }
      if (this.recordFiles.has(workId)) return this._setReadOnly('duplicate_work_id');
      this.recordFiles.add(workId);
    }

    const baseSummaries = loadedIndex?.document.summaries || [];
    const reconstructedSummaries = [];
    let existingJournalRecord = null;
    if (loadedIndex?.ok) {
      const indexedIds = new Set(baseSummaries.map((entry) => entry.work_id));
      const allIds = new Set([...indexedIds, ...this.recordFiles]);
      for (const workId of allIds) {
        if (workId !== journal?.work_id
          && (indexedIds.has(workId) !== this.recordFiles.has(workId))) {
          return this._setReadOnly('index_record_mismatch');
        }
      }
      // Validate every body before any repair write, but retain only a bounded
      // cache. Terminal future/corrupt records must not become hidden by index IO.
      const mustLoad = baseSummaries.map((entry) => entry.work_id);
      if (journal && this.recordFiles.has(journal.work_id)) mustLoad.push(journal.work_id);
      for (const workId of new Set(mustLoad)) {
        const checked = this._readRecordFile(workId);
        if (!checked.ok) return this._setReadOnly(checked.reason, checked.error);
        const summary = baseSummaries.find((entry) => entry.work_id === workId);
        if (workId !== journal?.work_id
          && stableJson(workSummary(checked.record)) !== stableJson(summary)) {
          return this._setReadOnly('index_record_mismatch');
        }
        if (workId === journal?.work_id) existingJournalRecord = checked.record;
        this._rememberRecord(checked.record);
      }
    } else {
      for (const workId of this.recordFiles) {
        const checked = this._readRecordFile(workId);
        if (!checked.ok) return this._setReadOnly(checked.reason, checked.error);
        reconstructedSummaries.push(workSummary(checked.record));
        if (workId === journal?.work_id) existingJournalRecord = checked.record;
        this._rememberRecord(checked.record);
      }
      const recordValues = reconstructedSummaries;
      if (new Set(recordValues.map((entry) => entry.turn_id)).size !== recordValues.length
        || new Set(recordValues.map((entry) => entry.idempotency_key)).size !== recordValues.length
        || new Set(recordValues.map((entry) => entry.submission_sequence)).size !== recordValues.length) {
        return this._setReadOnly('duplicate_work_identity');
      }
    }
    if (journal) {
      const existing = existingJournalRecord;
      const indexed = loadedIndex?.document.summaries.find((entry) => entry.work_id === journal.work_id);
      for (const prior of [existing, indexed].filter(Boolean)) {
        if (IMMUTABLE_FIELDS.some(key => prior[key] !== journal.record[key])
          || (prior.submission_hash && prior.submission_hash !== journal.record.submission_hash
            && !isPendingInputRevision(prior, journal.record))) {
          return this._setReadOnly('journal_immutable_identity_conflict');
        }
      }
      const alreadySettled = existing && stableJson(existing) === stableJson(journal.record)
        && indexed && stableJson(indexed) === stableJson(journal.summary)
        && loadedIndex.document.revision >= journal.index_revision;
      if (!alreadySettled) {
        if (existing && existing.revision > journal.record.revision) {
          return this._setReadOnly('stale_journal_conflict');
        }
        if (existing && existing.revision === journal.record.revision
          && stableJson(existing) !== stableJson(journal.record)) {
          return this._setReadOnly('journal_record_conflict');
        }
        const identitySummaries = loadedIndex?.ok
          ? baseSummaries : reconstructedSummaries;
        if (identitySummaries.some((summary) => summary.work_id !== journal.work_id
          && (summary.turn_id === journal.record.turn_id
            || summary.idempotency_key === journal.record.idempotency_key
            || summary.submission_sequence === journal.record.submission_sequence))) {
          return this._setReadOnly('journal_identity_conflict');
        }
        const repaired = this._repairRecord(journal.record, 'transition_repaired', journal.record.status);
        if (!repaired) return this._setReadOnly('journal_revision_exhausted');
        const repairJournal = { ...journal, record: repaired, summary: workSummary(repaired),
          index_revision: Math.max(journal.index_revision,
            (loadedIndex?.document.revision || 0) + 1) };
        const checkedRepairJournal = validateJournal(repairJournal);
        if (!checkedRepairJournal.ok) return this._setReadOnly(checkedRepairJournal.reason);
        journal = checkedRepairJournal.journal;
        try {
          // Persist the exact repair target first. Every later crash boundary
          // can replay this journal without incrementing the record again.
          this.io.writeJsonAtomic(this.journalPath, journal);
          this.io.writeJsonAtomic(this._workPath(repaired.work_id), repaired);
        }
        catch (error) { return this._setReadOnly('journal_repair_failed', error); }
        this.recordFiles.add(repaired.work_id);
        this._rememberRecord(repaired);
      }
    }
    let summaries = loadedIndex?.ok
      ? [...loadedIndex.document.summaries] : reconstructedSummaries;
    if (journal) {
      const journalIndex = summaries.findIndex((entry) => entry.work_id === journal.work_id);
      if (journalIndex >= 0) summaries[journalIndex] = journal.summary;
      else summaries.push(journal.summary);
    }
    const expected = createIndexDocument(summaries,
      Math.max(loadedIndex?.document.revision || 0, journal?.index_revision || 0),
      loadedIndex?.document.next_submission_sequence || null);
    const checkedExpected = validateIndexDocument(expected);
    if (!checkedExpected.ok) return this._setReadOnly(checkedExpected.reason);
    const reconstructedIndex = checkedExpected.document;
    const capacityReason = pendingCapacityReason(reconstructedIndex.pending);
    const recoverablePendingCapacity = capacityReason && reconstructedIndex.summaries
      .filter(summary => ['pending', 'paused'].includes(summary.status))
      .every(summary => {
        const checked = this._readRecordFile(summary.work_id);
        return checked.ok && ['pending', 'paused'].includes(checked.record.status);
      });
    if (capacityReason && !recoverablePendingCapacity) return this._setReadOnly(capacityReason);
    try {
      if (indexRead.status === 'missing' || journal) this.io.writeJsonAtomic(this.indexPath, reconstructedIndex);
    } catch (error) { return this._setReadOnly('index_repair_failed', error); }
    this.index = reconstructedIndex;
    if (journal) this._removeJournalBestEffort(); // Committed state is published; a stuck journal is cleanup only.
    for (const [workId, record] of this.records) {
      if (TERMINAL.has(record.status)) this.records.delete(workId);
    }
    if (pauseUnfinished) this._pauseUnfinishedAfterRestart();
  }
  _repairRecord(record, kind, previousStatus) {
    if (record.recovery?.kind === kind) return record;
    const at = isoNow(this.now);
    const repaired = { ...record, revision: record.revision + 1, updated_at: at,
      recovery: record.recovery?.kind === 'restart_paused'
        ? record.recovery
        : { kind, previous_status: previousStatus,
          reason: 'Recovered an interrupted durable transition.', at } };
    const checked = validateWorkRecord(repaired);
    return checked.ok ? checked.record : null;
  }
  _pauseUnfinishedAfterRestart() {
    if (this.readOnly) return;
    for (const summary of [...this.index.summaries]) {
      if (!UNFINISHED.has(summary.status)) continue;
      const record = this._loadRecord(summary.work_id);
      const at = isoNow(this.now);
      const paused = { ...record, revision: record.revision + 1, status: 'paused', updated_at: at,
        transition: { transition_id: this.createId('transition'), from: record.status, to: 'paused',
          reason: 'Paused during durable runtime recovery.', at },
        recovery: { kind: 'restart_paused', previous_status: record.status,
          reason: 'Unfinished work requires an explicit resume after restart.', at } };
      const checked = validateWorkRecord(paused);
      if (!checked.ok) return this._setReadOnly(checked.reason);
      try { this._commit(checked.record); } catch (error) {
        if (!this.readOnly) this._setReadOnly('recovery_pending_capacity', error);
        return;
      }
    }
  }
  // Reports whether memory provably matches disk again. The journal is the
  // first write of every commit and memory is untouched until all three land,
  // so a journal that never persisted means nothing changed on either side; a
  // persisted journal is replayed by the reload. Only the remaining cases are
  // an inconsistency worth latching read-only for.
  _reconcileCommitFailure(journal) {
    const persisted = this._readDocument(this.journalPath, MAX_WORK_RECORD_BYTES + 64 * 1024);
    if (persisted.status !== 'corrupt' && (persisted.status !== 'ok'
      || persisted.value.transaction_id !== journal.transaction_id)) return true;
    if (persisted.status === 'ok') {
      this.records.clear(); this.recordFiles.clear(); this.index = createIndexDocument();
      this.readOnly = false; this.reason = null;
      this._load(false);
      if (!this.readOnly) return true;
    }
    this.records.delete(journal.work_id);
    const indexRead = this._readDocument(this.indexPath, MAX_INDEX_BYTES);
    const checked = indexRead.status === 'ok' ? validateIndexDocument(indexRead.value) : null;
    const source = checked?.ok ? checked.document : this.index;
    this.index = createIndexDocument(source.summaries.filter(entry => entry.work_id !== journal.work_id),
      source.revision, source.next_submission_sequence);
    return false;
  }
  _commit(record, beforeWrite = null) {
    const summary = workSummary(record);
    const existingIndex = this.index.summaries.findIndex((entry) => entry.work_id === record.work_id);
    const summaries = [...this.index.summaries];
    const previousSummary = existingIndex >= 0 ? summaries[existingIndex] : null;
    if (existingIndex >= 0) summaries[existingIndex] = summary;
    else summaries.push(summary);
    const pending = pendingProjection(summaries);
    const capacityReason = pendingCapacityReason(pending);
    const countedStatus = ['pending', 'paused'].includes(record.status);
    const entersPendingCapacity = countedStatus
      && (!previousSummary || !['pending', 'paused'].includes(previousSummary.status));
    // Count caps apply on entry; aggregate bytes also guard edits; restart recovery stays drainable.
    const restartPausedRecovery = record.status === 'paused'
      && record.recovery?.kind === 'restart_paused';
    let applicableCapacityReason = entersPendingCapacity ? capacityReason : null;
    if (!entersPendingCapacity && countedStatus
      && pending.serialized_input_bytes > MAX_PENDING_INPUT_BYTES) {
      applicableCapacityReason = 'pending_input_capacity';
    }
    if (applicableCapacityReason && !restartPausedRecovery) {
      throw new RuntimeStoreError(applicableCapacityReason);
    }
    const isNew = existingIndex < 0;
    if (isNew && record.submission_sequence !== this.index.next_submission_sequence) {
      throw new RuntimeStoreError('submission_sequence_conflict');
    }
    const nextSubmissionSequence = isNew
      ? record.submission_sequence + 1 : this.index.next_submission_sequence;
    const nextIndex = createIndexDocument(summaries, this.index.revision + 1,
      nextSubmissionSequence);
    const checkedIndex = validateIndexDocument(nextIndex);
    if (!checkedIndex.ok) throw new RuntimeStoreError(checkedIndex.reason);
    const journal = { schema_version: RUNTIME_STORE_SCHEMA_VERSION,
      transaction_id: this.createId('transaction'), work_id: record.work_id,
      record, summary, index_revision: checkedIndex.document.revision, at: isoNow(this.now) };
    const checkedJournal = validateJournal(journal);
    if (!checkedJournal.ok) throw new RuntimeStoreError(checkedJournal.reason);
    beforeWrite?.();
    try {
      this.io.writeJsonAtomic(this.journalPath, checkedJournal.journal);
      this.io.writeJsonAtomic(this._workPath(record.work_id), record);
      this.io.writeJsonAtomic(this.indexPath, checkedIndex.document);
    } catch (error) {
      if (this._reconcileCommitFailure(checkedJournal.journal)) {
        try { this.logger?.('WARN', 'runtime_store.write_failed_reconciled', { error: error?.message || null }); }
        catch (_error) { /* Diagnostics must not hide the original failure. */ }
      } else this._setReadOnly('write_failed', error);
      throw new RuntimeStoreError('write_failed', error?.message || 'write_failed');
    }
    this.recordFiles.add(record.work_id);
    this._rememberRecord(record);
    this.index = checkedIndex.document;
    this._removeJournalBestEffort();
  }
  _removeJournalBestEffort() {
    try { this.io.remove(this.journalPath); } catch (error) {
      try { this.logger?.('WARN', 'runtime_store.journal_remove_failed', { error_code: error?.code || null }); }
      catch (_error) { /* Diagnostics must not hide a completed commit. */ }
    }
  }
}
module.exports = { RuntimeStore, RuntimeStoreError, createRuntimeStoreIO };
