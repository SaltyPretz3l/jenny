'use strict';

// Durable reader/writer of `chat_proposals` + `coordination_revision` over an
// ElectronSessionStore (row 59 checkpoint 3, slice S1). Same shape as
// createWorkspaceViewStore: one `_updateSessionRecord(..., {bumpUpdatedAt:false})`
// carries the container and the revision bump, `flushSession(id) === true` gates
// the acknowledgment, and a failed flush restores the in-memory record
// (`persist:false`). A future-schema container is frozen (never written).
// Entries that fail normalization (records and launch grants alike) are dropped from
// reads but preserved verbatim on every write, so an older build never destroys a
// newer build's records. A callback may also return `coordination_receipts` (the full next
// list, see ./coordination-receipts): it is persisted in the same flushed update and rolled back with it.

const {
  isCoordinationContainerFrozen, normalizeChatProposals, normalizeCoordinationRevision, normalizeLaunchGrantList, partitionLaunchGrants,
} = require('./session-coordination-records');
const { canonicalJson, isUnresolved, normalizeProposalRecord } = require('./chat-proposal-records');
const { normalizeReceiptList, partitionReceipts } = require('./coordination-receipts');

function readRecord(store, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id || !store) return null;
  const reader = typeof store.peekSession === 'function' ? store.peekSession : store.getSession;
  return typeof reader === 'function' ? reader.call(store, id) || null : null;
}

// Splits the raw stored list into valid normalized records and opaque raw entries
// (invalid, future-version or duplicate ids) that must be kept untouched.
function partition(container) {
  const records = [];
  const opaque = [];
  const seen = new Set();
  for (const raw of container.records) {
    const record = normalizeProposalRecord(raw);
    if (record && !seen.has(record.proposal_id)) {
      seen.add(record.proposal_id);
      records.push(record);
    } else {
      opaque.push(structuredClone(raw));
    }
  }
  return { records, opaque };
}

function createChatProposalStore(store) {
  function read(sessionId) {
    const session = readRecord(store, sessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    const stored = session.chat_proposals;
    const frozen = isCoordinationContainerFrozen(stored);
    const container = normalizeChatProposals(frozen ? undefined : stored);
    return {
      ok: true,
      session_incarnation: String(session.session_incarnation || ''),
      coordination_revision: normalizeCoordinationRevision(session.coordination_revision),
      records: frozen ? [] : partition(container).records,
      launch_grants: frozen ? [] : partitionLaunchGrants(container.launch_grants).grants,
      coordination_receipts: partitionReceipts(session.coordination_receipts).records,
      frozen,
    };
  }

  function persist(id, previous, update, currentRevision) {
    const ioFailed = { ok: false, reason: 'io_failed', retryable: true, current_revision: currentRevision };
    if (typeof store._updateSessionRecord !== 'function') return ioFailed;
    let flushed;
    try {
      const summary = store._updateSessionRecord(id, update, { bumpUpdatedAt: false });
      if (!summary) {
        if (store.hasNewerSchema?.() === true) {
          return { ok: false, reason: 'unavailable', retryable: false, current_revision: currentRevision };
        }
        return ioFailed;
      }
      flushed = store.flushSession(id) === true;
    } catch {
      flushed = false;
    }
    if (flushed) return null;
    // Memory only: the disk never took the new value, so a later flush must not persist it.
    try {
      store._updateSessionRecord(id, previous, { bumpUpdatedAt: false, persist: false });
    } catch {
      // The failure result already reports the revision callers must retry from.
    }
    return ioFailed;
  }

  // fn({records, launch_grants, coordination_receipts, coordination_revision}) -> {records: Record[], launch_grants?: Grant[],
  // coordination_receipts?: Receipt[]} | {abort: value}. Omitting launch_grants / receipts keeps them; all are written in the
  // same flushed update.
  function mutate(sessionId, fn) {
    const session = readRecord(store, sessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    const id = String(sessionId).trim();
    const currentRevision = normalizeCoordinationRevision(session.coordination_revision);
    const unavailable = { ok: false, reason: 'unavailable', retryable: false, current_revision: currentRevision };
    if (isCoordinationContainerFrozen(session.chat_proposals) || store.hasNewerSchema?.() === true
      || currentRevision >= Number.MAX_SAFE_INTEGER) return unavailable;
    const container = normalizeChatProposals(session.chat_proposals);
    const { records, opaque } = partition(container);
    const { grants, opaque: opaqueGrants } = partitionLaunchGrants(container.launch_grants);
    const { records: receipts, opaque: opaqueReceipts } = partitionReceipts(session.coordination_receipts);
    const outcome = fn({
      records: structuredClone(records),
      launch_grants: structuredClone(grants),
      coordination_receipts: structuredClone(receipts),
      coordination_revision: currentRevision,
    });
    if (outcome && typeof outcome === 'object' && Object.hasOwn(outcome, 'abort')) {
      return { ok: true, aborted: true, value: outcome.abort };
    }
    if (!outcome || !Array.isArray(outcome.records)) {
      return { ok: false, reason: 'invalid_request', retryable: false, current_revision: currentRevision };
    }
    const normalized = outcome.records.map(normalizeProposalRecord);
    const ids = new Set(normalized.map((record) => record?.proposal_id));
    if (normalized.includes(null) || ids.size !== normalized.length) {
      return { ok: false, reason: 'invalid_record', retryable: false, current_revision: currentRevision };
    }
    const grantsGiven = Object.hasOwn(outcome, 'launch_grants');
    const nextGrants = grantsGiven ? normalizeLaunchGrantList(outcome.launch_grants) : grants;
    if (nextGrants === null) return { ok: false, reason: 'invalid_record', retryable: false, current_revision: currentRevision };
    const grantFields = grantsGiven ? { launch_grants: nextGrants } : {}; // only echoed when the caller wrote them
    const receiptsGiven = Object.hasOwn(outcome, 'coordination_receipts');
    if (receiptsGiven && isCoordinationContainerFrozen(session.coordination_receipts)) return unavailable;
    const nextReceipts = receiptsGiven ? normalizeReceiptList(outcome.coordination_receipts) : receipts;
    if (nextReceipts === null) return { ok: false, reason: 'invalid_record', retryable: false, current_revision: currentRevision };
    const receiptFields = receiptsGiven ? { coordination_receipts: nextReceipts } : {};
    if (canonicalJson(normalized) === canonicalJson(records) && canonicalJson(nextGrants) === canonicalJson(grants)
      && canonicalJson(nextReceipts) === canonicalJson(receipts)) {
      return { ok: true, records: normalized, ...grantFields, ...receiptFields, coordination_revision: currentRevision };
    }
    const nextRevision = currentRevision + 1;
    const update = {
      chat_proposals: {
        schema_version: 1,
        records: [...normalized, ...opaque],
        launch_grants: [...nextGrants, ...opaqueGrants],
      },
      coordination_revision: nextRevision,
      ...(receiptsGiven ? { coordination_receipts: [...nextReceipts, ...opaqueReceipts] } : {}),
    };
    const previous = {
      chat_proposals: structuredClone(session.chat_proposals),
      coordination_revision: currentRevision,
      ...(receiptsGiven ? { coordination_receipts: structuredClone(session.coordination_receipts) } : {}),
    };
    const failure = persist(id, previous, update, currentRevision);
    if (failure) return failure;
    return { ok: true, records: normalized, ...grantFields, ...receiptFields, coordination_revision: nextRevision };
  }

  // Unresolved (pending, or accepted and unsettled) proposals across the loaded profile.
  function countUnresolvedAcrossProfile() {
    let ids = [];
    if (typeof store?.getSessionIds === 'function') ids = store.getSessionIds();
    else if (typeof store?.listSessions === 'function') ids = store.listSessions().map((summary) => summary.id);
    let count = 0;
    for (const id of ids) {
      const result = read(id);
      if (result.ok) count += result.records.filter(isUnresolved).length;
    }
    return count;
  }

  return { read, mutate, countUnresolvedAcrossProfile };
}

module.exports = { createChatProposalStore };
