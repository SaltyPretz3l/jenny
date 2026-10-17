'use strict';

// Pure restore transform for one archived session's coordination record (row 59 cp5b-3, slice H1).
// A trusted full-profile archive restore is not an ordinary restart: nothing that was in flight or
// authorized when the archive was taken may resume on its own. This module turns the captured record
// into the restored one and decides nothing else (no IO, no store, no clock besides the injected one):
//   - pending sends become failed ops that need the user's confirmation (a prepared op was never sent:
//     it stays prepared and needs the user's Send, which revalidates it);
//   - report reservations are dropped, reserved admission snapshots released, reporting switched off;
//   - directional agent grants and launch grants are kept as records but revoked (never live);
//   - accepted non-terminal proposals need attention, pending ones and every command become read-only.
// Delivered history, inbox/discard receipts and inclusion state are preserved. Entries this build cannot
// parse (invalid, duplicate or future-versioned) and whole future-versioned containers pass through
// verbatim; a structurally malformed record is quarantined to default coordination with a reason.

const { MESSAGE_ERROR_CODES } = require('../backend/error-codes');
const {
  PROPOSAL_ERROR_CODES, canonicalJson, nextRevision, normalizeProposalRecord, primitives,
} = require('../backend/chat-proposal-records');
const { NORMALIZERS } = require('../backend/session-mail-records');
const {
  normalizeCoordinationFields,
  normalizeCoordinationRevision,
  normalizeLaunchGrant,
  normalizeSpawnedFrom,
  normalizeWorkspaceView,
} = require('../backend/session-coordination-records');

const RESTORE_REASON = 'restored_confirmation_required';
const SETTLED_ACTIONS = Object.freeze(['succeeded', 'failed', 'cancelled']);
const MAIL_LISTS = Object.freeze(['inbox', 'discarded', 'outbox', 'authorizations', 'report_reservations', 'admission_snapshots']);
const MAX_INCARNATION_CHARS = 512;
const { isPlainObject } = primitives;

function versionKind(value) {
  if (!isPlainObject(value)) return 'malformed';
  if (value.schema_version === 1) return 'v1';
  const version = value.schema_version;
  return Number.isSafeInteger(version) && version > 1 ? 'future' : 'malformed';
}

function isoOf(now) {
  const date = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid timestamp');
  return date.toISOString();
}

// The valid first-of-their-identity records of a raw stored list.
function validRecords(list, key) {
  const [normalize, identity] = NORMALIZERS[key];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const record = normalize(raw);
    const id = record ? identity(record) : null;
    if (record && !seen.has(id)) {
      seen.add(id);
      out.push(record);
    }
  }
  return out;
}

// In-place map over a raw stored list: a valid first-of-its-identity entry goes through `lift`
// (which may return null to drop it); everything else is carried as an untouched clone.
function liftList(list, key, lift) {
  const [normalize, identity] = NORMALIZERS[key];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const record = normalize(raw);
    const id = record ? identity(record) : null;
    if (!record || seen.has(id)) {
      out.push(structuredClone(raw));
      continue;
    }
    seen.add(id);
    const lifted = lift(record);
    if (lifted !== null) out.push(lifted);
  }
  return out;
}

function liftOutbox(op) {
  if (op.state !== 'pending') return op;
  return {
    ...op,
    state: 'failed',
    restore_requires_confirmation: true,
    last_error: { code: MESSAGE_ERROR_CODES.AUTHORIZATION_REQUIRED, reason: RESTORE_REASON, retryable: false },
  };
}

function liftAuthorization(auth, at) {
  if (auth.kind !== 'agent_directional' || (auth.revoked_at !== null && auth.remaining_sends === 0)) return auth;
  return { ...auth, revoked_at: auth.revoked_at ?? at, remaining_sends: 0 };
}

function liftLaunchGrants(list, at) {
  const seen = new Set();
  return list.map((raw) => {
    const grant = normalizeLaunchGrant(raw);
    if (!grant || seen.has(grant.authorization_ref)) return structuredClone(raw);
    seen.add(grant.authorization_ref);
    if (grant.revoked_at !== null && grant.remaining === 0) return grant;
    return { ...grant, revoked_at: grant.revoked_at ?? at, remaining: 0 };
  });
}

function liftProposal(record) {
  if (record.decision_state === 'pending') {
    return record.restore_requires_confirmation ? record : nextRevision(record, { restore_requires_confirmation: true });
  }
  if (record.decision_state !== 'accepted' || SETTLED_ACTIONS.includes(record.action_state)) return record;
  const prior = record.last_error;
  if (record.restore_requires_confirmation && record.action_state === 'needs_attention' && prior?.reason === RESTORE_REASON) {
    return record;
  }
  return nextRevision(record, {
    action_state: 'needs_attention',
    restore_requires_confirmation: true,
    last_error: {
      code: PROPOSAL_ERROR_CODES.authorization_required,
      reason: RESTORE_REASON,
      retryable: false,
      cause_code: prior ? (prior.reason === RESTORE_REASON ? prior.cause_code : prior.reason) : null,
    },
  });
}

// ---------- containers ----------

function liftSessionMail(value, at) {
  const kind = versionKind(value);
  if (kind === 'future') return { mail: structuredClone(value) };
  const sequence = value?.next_receive_sequence;
  if (kind !== 'v1' || !MAIL_LISTS.every((key) => Array.isArray(value[key]))
    || !Number.isSafeInteger(sequence) || sequence < 1 || typeof value.reporting_enabled !== 'boolean') {
    return { reason: 'session_mail_invalid' };
  }
  const snapshots = liftList(value.admission_snapshots, 'admission_snapshots', (snapshot) => (snapshot.state === 'reserved' ? null : snapshot));
  return {
    mail: {
      schema_version: 1,
      next_receive_sequence: sequence,
      inbox: liftList(value.inbox, 'inbox', (row) => (row.context.state === 'reserved' ? { ...row, context: { state: 'queued' } } : row)),
      discarded: structuredClone(value.discarded),
      outbox: liftList(value.outbox, 'outbox', liftOutbox),
      authorizations: liftList(value.authorizations, 'authorizations', (auth) => liftAuthorization(auth, at)),
      report_reservations: liftList(value.report_reservations, 'report_reservations', () => null),
      admission_snapshots: snapshots,
      reporting_enabled: false,
    },
  };
}

function liftChatProposals(value, at) {
  const kind = versionKind(value);
  if (kind === 'future') return { proposals: structuredClone(value) };
  if (kind !== 'v1' || !Array.isArray(value.records) || !Array.isArray(value.launch_grants)) {
    return { reason: 'chat_proposals_invalid' };
  }
  const records = [];
  const seen = new Set();
  for (const raw of value.records) {
    const record = normalizeProposalRecord(raw);
    if (!record || seen.has(record.proposal_id)) {
      records.push(structuredClone(raw));
      continue;
    }
    seen.add(record.proposal_id);
    const lifted = liftProposal(record);
    if (lifted !== record && !normalizeProposalRecord(lifted)) return { reason: 'proposal_transform_invalid' };
    records.push(lifted);
  }
  return {
    proposals: { schema_version: 1, records, launch_grants: liftLaunchGrants(value.launch_grants, at) },
  };
}

function liftSpawnedFrom(value) {
  if (value === undefined || value === null) return { spawned: null };
  const kind = versionKind(value);
  if (kind === 'future') return { spawned: structuredClone(value) };
  const spawned = kind === 'v1' ? normalizeSpawnedFrom(value) : null;
  return spawned ? { spawned } : { reason: 'spawned_from_invalid' };
}

// Session ids this record links to (parent, destinations, sources, children) that were not restored.
function missingCounterparts(record, restored) {
  const ids = new Set();
  const note = (id) => { if (typeof id === 'string' && id && !restored.has(id)) ids.add(id); };
  if (record.spawned_from?.schema_version === 1) note(record.spawned_from.parent_session_id);
  const mail = record.session_mail;
  if (mail.schema_version === 1) {
    for (const op of validRecords(mail.outbox, 'outbox')) note(op.envelope.destination_session_id);
    for (const row of validRecords(mail.inbox, 'inbox')) note(row.envelope.source_session_id);
    for (const auth of validRecords(mail.authorizations, 'authorizations')) {
      note(auth.source_session_id);
      note(auth.destination_session_id);
    }
  }
  if (record.chat_proposals.schema_version === 1) {
    for (const raw of record.chat_proposals.records) {
      const proposal = normalizeProposalRecord(raw);
      if (proposal) note(proposal.child_session_id);
    }
  }
  return [...ids].sort();
}

function quarantined(incarnation, reason) {
  return {
    record: { session_incarnation: incarnation, ...normalizeCoordinationFields({}) },
    quarantined: true,
    reason,
    unavailable_session_ids: [],
  };
}

/**
 * @param {object} record  One archived session record: `session_incarnation` plus the six coordination fields.
 * @param {object} [options]
 * @param {Iterable<string>} [options.restoredSessionIds]  Sessions present after the restore.
 * @param {Date|string|number} [options.now]  Injected clock.
 * @returns {{record: object, quarantined: boolean, reason: string|null, unavailable_session_ids: string[]}}
 */
function transformRestoredCoordination(record, { restoredSessionIds = [], now } = {}) {
  const at = isoOf(now);
  if (!isPlainObject(record)) return quarantined('', 'record_invalid');
  const incarnation = record.session_incarnation;
  if (typeof incarnation !== 'string' || incarnation.length > MAX_INCARNATION_CHARS) {
    return quarantined('', 'incarnation_invalid');
  }
  const defaults = normalizeCoordinationFields({});
  const rawMail = record.session_mail === undefined ? defaults.session_mail : record.session_mail;
  const rawProposals = record.chat_proposals === undefined ? defaults.chat_proposals : record.chat_proposals;
  const rawReceipts = record.coordination_receipts === undefined ? [] : record.coordination_receipts;
  if (!Array.isArray(rawReceipts)) return quarantined(incarnation, 'coordination_receipts_invalid');
  const spawned = liftSpawnedFrom(record.spawned_from);
  if (spawned.reason) return quarantined(incarnation, spawned.reason);
  const mail = liftSessionMail(rawMail, at);
  if (mail.reason) return quarantined(incarnation, mail.reason);
  const proposals = liftChatProposals(rawProposals, at);
  if (proposals.reason) return quarantined(incarnation, proposals.reason);

  const changed = canonicalJson(mail.mail) !== canonicalJson(rawMail)
    || canonicalJson(proposals.proposals) !== canonicalJson(rawProposals);
  const revision = normalizeCoordinationRevision(record.coordination_revision);
  const restored = {
    session_incarnation: incarnation,
    spawned_from: spawned.spawned,
    coordination_revision: changed && revision < Number.MAX_SAFE_INTEGER ? revision + 1 : revision,
    coordination_receipts: structuredClone(rawReceipts),
    chat_proposals: proposals.proposals,
    session_mail: mail.mail,
    workspace_view: normalizeWorkspaceView(record.workspace_view),
  };
  return {
    record: restored,
    quarantined: false,
    reason: null,
    unavailable_session_ids: missingCounterparts(restored, new Set(restoredSessionIds)),
  };
}

module.exports = { RESTORE_REASON, transformRestoredCoordination };
