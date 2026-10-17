'use strict';

// Durable reader/writer of `session_mail` + `coordination_revision` over an
// ElectronSessionStore (row 59 checkpoint 4, slice S1). Same shape as
// createChatProposalStore: one `_updateSessionRecord(..., {bumpUpdatedAt:false})`
// carries the container and the revision bump, `flushSession(id) === true` gates
// the acknowledgment, and a failed flush restores the in-memory record
// (`persist:false`). Every mutation is synchronous (read, fn, write, flush with no
// await), which is the serialization lock on the Electron main thread. A
// future-schema container is frozen (never written). Entries that fail
// normalization are dropped from reads but preserved verbatim on every write.
// A callback may also return `coordination_receipts` (the full next list, see
// ./coordination-receipts): it is persisted in the same flushed update as the mail
// and rolled back with it.

const {
  isCoordinationContainerFrozen, normalizeCoordinationRevision, normalizeSessionMail,
} = require('./session-coordination-records');
const { canonicalJson } = require('./chat-proposal-records');
const { normalizeReceiptList, partitionReceipts } = require('./coordination-receipts');
const { NORMALIZERS, partitionList } = require('./session-mail-records');

const LISTS = Object.freeze(Object.keys(NORMALIZERS));

function readRecord(store, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id || !store) return null;
  const reader = typeof store.peekSession === 'function' ? store.peekSession : store.getSession;
  return typeof reader === 'function' ? reader.call(store, id) || null : null;
}

// Valid normalized lists + the opaque raw entries per list, over a v1 container.
function partitionMail(container) {
  const mail = {
    schema_version: 1,
    next_receive_sequence: container.next_receive_sequence,
    reporting_enabled: container.reporting_enabled,
  };
  const opaque = {};
  for (const name of LISTS) {
    const [normalize, identity] = NORMALIZERS[name];
    const parts = partitionList(container[name], normalize, identity);
    mail[name] = parts.records;
    opaque[name] = parts.opaque;
  }
  return { mail, opaque };
}

function highestSequence(mail) {
  return Math.max(0, ...mail.inbox.map((r) => r.receive_sequence), ...mail.discarded.map((r) => r.receive_sequence));
}

function createSessionMailStore(store) {
  function read(sessionId) {
    const session = readRecord(store, sessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    const frozen = isCoordinationContainerFrozen(session.session_mail);
    const container = normalizeSessionMail(frozen ? undefined : session.session_mail);
    return {
      ok: true,
      session_incarnation: String(session.session_incarnation || ''),
      project_id: session.project_id || null,
      archived: Boolean(session.archived_at),
      coordination_revision: normalizeCoordinationRevision(session.coordination_revision),
      mail: partitionMail(container).mail,
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

  // Normalizes the callback's mail: every entry must be a valid record with a unique identity.
  function normalizeNext(next, current) {
    const out = { ...current };
    if (!next || typeof next !== 'object') return null;
    for (const name of LISTS) {
      // A callback result that omits the reservations keeps the current ones.
      const list = next[name] === undefined && name === 'report_reservations' ? current[name] : next[name];
      if (!Array.isArray(list)) return null;
      const [normalize, identity] = NORMALIZERS[name];
      const normalized = list.map(normalize);
      if (normalized.includes(null)) return null;
      if (new Set(normalized.map(identity)).size !== normalized.length) return null;
      out[name] = normalized;
    }
    const sequence = next.next_receive_sequence ?? current.next_receive_sequence;
    out.next_receive_sequence = sequence;
    out.reporting_enabled = typeof next.reporting_enabled === 'boolean' ? next.reporting_enabled : current.reporting_enabled;
    // The receive sequence only moves forward and stays above every sequence newly issued.
    const issued = highestSequence(out);
    if (!Number.isSafeInteger(sequence) || sequence < current.next_receive_sequence) return null;
    if (sequence <= issued && issued > highestSequence(current)) return null;
    return out;
  }

  // fn({mail, session, coordination_revision, coordination_receipts}) -> {mail[, coordination_receipts]} | {abort:{reason, ...}}.
  // Resolves {ok:true, revision, coordination_revision, mail, coordination_receipts[, noop:true]}, or
  // {ok:false, reason[, retryable], current_revision[, aborted:true, abort]}.
  function mutate(sessionId, fn) {
    const session = readRecord(store, sessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    const id = String(sessionId).trim();
    const currentRevision = normalizeCoordinationRevision(session.coordination_revision);
    const unavailable = { ok: false, reason: 'unavailable', retryable: false, current_revision: currentRevision };
    if (isCoordinationContainerFrozen(session.session_mail) || store.hasNewerSchema?.() === true
      || currentRevision >= Number.MAX_SAFE_INTEGER) return unavailable;
    const container = normalizeSessionMail(session.session_mail);
    const { mail, opaque } = partitionMail(container);
    const { records: receipts, opaque: opaqueReceipts } = partitionReceipts(session.coordination_receipts);
    const outcome = fn({
      mail: structuredClone(mail),
      session: { id, session_incarnation: String(session.session_incarnation || ''), project_id: session.project_id || null, archived: Boolean(session.archived_at) },
      coordination_revision: currentRevision,
      coordination_receipts: structuredClone(receipts),
    });
    if (outcome && typeof outcome === 'object' && Object.hasOwn(outcome, 'abort')) {
      const abort = outcome.abort && typeof outcome.abort === 'object' ? outcome.abort : {};
      return {
        retryable: false, ...abort, ok: false, aborted: true, reason: abort.reason || 'aborted', abort,
        current_revision: currentRevision,
      };
    }
    const normalized = normalizeNext(outcome?.mail, mail);
    if (!normalized) return { ok: false, reason: 'invalid_record', retryable: false, current_revision: currentRevision };
    const receiptsGiven = Object.hasOwn(outcome, 'coordination_receipts');
    if (receiptsGiven && isCoordinationContainerFrozen(session.coordination_receipts)) return unavailable;
    const nextReceipts = receiptsGiven ? normalizeReceiptList(outcome.coordination_receipts) : receipts;
    if (!nextReceipts) return { ok: false, reason: 'invalid_record', retryable: false, current_revision: currentRevision };
    if (canonicalJson(normalized) === canonicalJson(mail) && canonicalJson(nextReceipts) === canonicalJson(receipts)) {
      return {
        ok: true, noop: true, revision: currentRevision, coordination_revision: currentRevision, mail: normalized, coordination_receipts: nextReceipts,
      };
    }
    const nextRevision = currentRevision + 1;
    const update = {
      session_mail: {
        schema_version: 1,
        next_receive_sequence: normalized.next_receive_sequence,
        inbox: [...normalized.inbox, ...opaque.inbox],
        discarded: [...normalized.discarded, ...opaque.discarded],
        outbox: [...normalized.outbox, ...opaque.outbox],
        authorizations: [...normalized.authorizations, ...opaque.authorizations],
        report_reservations: [...normalized.report_reservations, ...opaque.report_reservations],
        admission_snapshots: [...normalized.admission_snapshots, ...opaque.admission_snapshots],
        reporting_enabled: normalized.reporting_enabled,
      },
      coordination_revision: nextRevision,
      ...(receiptsGiven ? { coordination_receipts: [...nextReceipts, ...opaqueReceipts] } : {}),
    };
    const previous = {
      session_mail: structuredClone(session.session_mail),
      coordination_revision: currentRevision,
      ...(receiptsGiven ? { coordination_receipts: structuredClone(session.coordination_receipts) } : {}),
    };
    const failure = persist(id, previous, update, currentRevision);
    if (failure) return failure;
    return { ok: true, revision: nextRevision, coordination_revision: nextRevision, mail: normalized, coordination_receipts: nextReceipts };
  }

  return { read, mutate };
}

module.exports = { createSessionMailStore };
