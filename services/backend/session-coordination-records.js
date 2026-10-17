'use strict';

// Schema-25 session coordination containers (row 59 checkpoint 2, slice S1).
// ElectronSessionStore stays the sole owner; this module holds the pure
// normalizers/defaults for the six new top-level session fields and the one
// writer that checkpoint 2 activates (`workspace_view`, guarded by
// `coordination_revision`). The other containers are inert until later
// checkpoints: a well-formed v1 container is kept as-is, a malformed one falls
// back to its default, and a container carrying an unknown FUTURE nested
// schema_version is preserved verbatim and reported frozen (never normalized
// away, and never written to).

const { normalizeReceiptContainer } = require('./coordination-receipts');

const DISCLOSURE_KEYS = Object.freeze([
  'environment', 'context', 'outputs', 'changes', 'background_tasks',
]);
const COORDINATION_FIELDS = Object.freeze([
  'spawned_from', 'coordination_revision', 'coordination_receipts',
  'chat_proposals', 'session_mail', 'workspace_view',
]);
const WORKSPACE_VIEW_PATCH_KEYS = Object.freeze(['rail_visible', 'children_expanded', 'disclosures']);
const WORKSPACE_VIEW_SCHEMA_VERSION = 1;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// 'v1' | 'future' | 'malformed' for a versioned container object.
function classifyVersion(value) {
  if (!isPlainObject(value)) return 'malformed';
  const version = value.schema_version;
  if (version === 1) return 'v1';
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > 1) return 'future';
  return 'malformed';
}

function cloneVerbatim(value) {
  return structuredClone(value);
}

// True when a stored coordination container must not be executed or written:
// an unknown future nested schema_version (directly, or on an element of a
// record list such as coordination_receipts).
function isCoordinationContainerFrozen(value) {
  if (Array.isArray(value)) return value.some((entry) => classifyVersion(entry) === 'future');
  return classifyVersion(value) === 'future';
}

function normalizeCoordinationRevision(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function defaultWorkspaceView() {
  return {
    schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
    rail_visible: null,
    disclosures: {},
    children_expanded: null,
  };
}

function normalizeDisclosures(value) {
  const disclosures = {};
  if (!isPlainObject(value)) return disclosures;
  for (const key of DISCLOSURE_KEYS) {
    if (hasOwn(value, key) && typeof value[key] === 'boolean') disclosures[key] = value[key];
  }
  return disclosures;
}

function normalizeWorkspaceView(value) {
  const kind = classifyVersion(value);
  if (kind === 'future') return cloneVerbatim(value);
  if (kind !== 'v1') return defaultWorkspaceView();
  return {
    schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
    rail_visible: typeof value.rail_visible === 'boolean' ? value.rail_visible : null,
    disclosures: normalizeDisclosures(value.disclosures),
    children_expanded: typeof value.children_expanded === 'boolean' ? value.children_expanded : null,
  };
}

// The v1 reading of a stored view, used by read(): a frozen future view is
// projected through the v1 field rules and never rewritten.
function projectWorkspaceView(value) {
  if (classifyVersion(value) === 'future') {
    return normalizeWorkspaceView({ ...value, schema_version: WORKSPACE_VIEW_SCHEMA_VERSION });
  }
  return normalizeWorkspaceView(value);
}

// ---------- strict v1 shapes: spawned_from (child provenance) and LaunchGrant ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/; // lowercase only
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const PROPOSAL_ID_RE = /^proposal_[0-9a-f]{64}$/;
const SPAWNED_FROM_KEYS = Object.freeze([
  'schema_version', 'parent_session_id', 'parent_session_incarnation', 'proposal_id', 'created_at',
  'child_creation_hash', 'reporting_consent_id',
]);
const LAUNCH_GRANT_KEYS = Object.freeze([
  'schema_version', 'authorization_ref', 'source_session_incarnation', 'source_user_message_id', 'source_turn_id',
  'action_id', 'destination_project_ids', 'restrictions', 'created_at', 'expires_at', 'max_children', 'remaining',
  'revoked_at',
]);
const LAUNCH_GRANT_RESTRICTION_KEYS = Object.freeze(['read_only', 'plan_mode', 'lockdown']);
const LAUNCH_GRANT_TTL_MS = 60 * 60 * 1000;
const LAUNCH_GRANT_MAX_DESTINATIONS = 8;
const LAUNCH_GRANT_MAX_CHILDREN = 10;

const hasExactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length
  && keys.every((key) => hasOwn(value, key));
const isIso = (value) => typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
const isShortString = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const isCount = (value, min, max) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

function validSpawnedFromV1(value) {
  return hasExactKeys(value, SPAWNED_FROM_KEYS) && value.schema_version === 1
    && isShortString(value.parent_session_id) && isShortString(value.parent_session_incarnation)
    && PROPOSAL_ID_RE.test(value.proposal_id) && isIso(value.created_at) && HEX64_RE.test(value.child_creation_hash)
    && typeof value.reporting_consent_id === 'string' && UUID_RE.test(value.reporting_consent_id);
}

// Strict v1 (immutable, written only at child creation). A malformed v1 value reads as null;
// a future version is preserved verbatim.
function normalizeSpawnedFrom(value) {
  if (value === null || value === undefined) return null;
  const kind = classifyVersion(value);
  if (kind === 'future') return cloneVerbatim(value);
  if (kind === 'v1' && validSpawnedFromV1(value)) return Object.fromEntries(SPAWNED_FROM_KEYS.map((key) => [key, value[key]]));
  return null;
}

function validLaunchGrantV1(value) {
  if (!hasExactKeys(value, LAUNCH_GRANT_KEYS) || value.schema_version !== 1) return false;
  const ids = value.destination_project_ids;
  const restrictions = value.restrictions;
  return typeof value.authorization_ref === 'string' && UUID_RE.test(value.authorization_ref)
    && typeof value.action_id === 'string' && UUID_RE.test(value.action_id)
    && isShortString(value.source_session_incarnation) && isShortString(value.source_user_message_id)
    && isShortString(value.source_turn_id)
    && Array.isArray(ids) && ids.length >= 1 && ids.length <= LAUNCH_GRANT_MAX_DESTINATIONS
    && ids.every((id) => id === null || isShortString(id)) && new Set(ids).size === ids.length
    && hasExactKeys(restrictions, LAUNCH_GRANT_RESTRICTION_KEYS)
    && LAUNCH_GRANT_RESTRICTION_KEYS.every((key) => typeof restrictions[key] === 'boolean')
    && isIso(value.created_at) && isIso(value.expires_at)
    && Date.parse(value.expires_at) === Date.parse(value.created_at) + LAUNCH_GRANT_TTL_MS
    && isCount(value.max_children, 1, LAUNCH_GRANT_MAX_CHILDREN) && isCount(value.remaining, 0, value.max_children)
    && (value.revoked_at === null || isIso(value.revoked_at));
}

// A stored/new LaunchGrant in canonical form, or null when it is not a valid v1 grant.
function normalizeLaunchGrant(value) {
  if (!validLaunchGrantV1(value)) return null;
  const grant = Object.fromEntries(LAUNCH_GRANT_KEYS.map((key) => [key, structuredClone(value[key])]));
  grant.restrictions = Object.fromEntries(LAUNCH_GRANT_RESTRICTION_KEYS.map((key) => [key, value.restrictions[key]]));
  return grant;
}

// Valid grants (unique authorization_ref) and opaque raw entries (invalid, future or duplicate)
// that every write must keep untouched.
function partitionLaunchGrants(list) {
  const grants = [];
  const opaque = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const grant = normalizeLaunchGrant(raw);
    if (grant && !seen.has(grant.authorization_ref)) {
      seen.add(grant.authorization_ref);
      grants.push(grant);
    } else {
      opaque.push(cloneVerbatim(raw));
    }
  }
  return { grants, opaque };
}

// The grants a writer wants to store, or null when any is invalid or a ref repeats.
function normalizeLaunchGrantList(list) {
  if (!Array.isArray(list)) return null;
  const grants = list.map(normalizeLaunchGrant);
  const refs = new Set(grants.map((grant) => grant?.authorization_ref));
  return grants.includes(null) || refs.size !== grants.length ? null : grants;
}

// Keeps every stored entry (valid ones canonical, invalid / future ones verbatim); the record
// shape, pruning and writers live in ./coordination-receipts.
function normalizeCoordinationReceipts(value) {
  return normalizeReceiptContainer(value);
}

function listOrEmpty(value) {
  return Array.isArray(value) ? [...value] : [];
}

function defaultChatProposals() {
  return { schema_version: 1, records: [], launch_grants: [] };
}

function normalizeChatProposals(value) {
  const kind = classifyVersion(value);
  if (kind === 'future') return cloneVerbatim(value);
  if (kind !== 'v1') return defaultChatProposals();
  return {
    schema_version: 1,
    records: listOrEmpty(value.records),
    launch_grants: listOrEmpty(value.launch_grants),
  };
}

function defaultSessionMail() {
  return {
    schema_version: 1,
    next_receive_sequence: 1,
    inbox: [],
    discarded: [],
    outbox: [],
    authorizations: [],
    report_reservations: [],
    admission_snapshots: [],
    reporting_enabled: false,
  };
}

function normalizeSessionMail(value) {
  const kind = classifyVersion(value);
  if (kind === 'future') return cloneVerbatim(value);
  if (kind !== 'v1') return defaultSessionMail();
  const sequence = value.next_receive_sequence;
  return {
    schema_version: 1,
    next_receive_sequence: typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 1
      ? sequence : 1,
    inbox: listOrEmpty(value.inbox),
    discarded: listOrEmpty(value.discarded),
    outbox: listOrEmpty(value.outbox),
    authorizations: listOrEmpty(value.authorizations),
    report_reservations: listOrEmpty(value.report_reservations),
    admission_snapshots: listOrEmpty(value.admission_snapshots),
    reporting_enabled: value.reporting_enabled === true,
  };
}

// The six schema-25 fields for a raw session input; spread into a record.
function normalizeCoordinationFields(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    spawned_from: normalizeSpawnedFrom(source.spawned_from),
    coordination_revision: normalizeCoordinationRevision(source.coordination_revision),
    coordination_receipts: normalizeCoordinationReceipts(source.coordination_receipts),
    chat_proposals: normalizeChatProposals(source.chat_proposals),
    session_mail: normalizeSessionMail(source.session_mail),
    workspace_view: normalizeWorkspaceView(source.workspace_view),
  };
}

// All six fields present on a copy of the session; idempotent.
function applyCoordinationDefaults(session) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  return { ...source, ...normalizeCoordinationFields(source) };
}

// Generic session patches must not reach the coordination fields: they have
// dedicated writers (createWorkspaceViewStore today). Mutates and returns the
// patch the caller already copied.
function stripCoordinationFields(patch) {
  if (patch && typeof patch === 'object') {
    for (const key of COORDINATION_FIELDS) delete patch[key];
  }
  return patch;
}

function validateWorkspaceViewPatch(patch) {
  const invalid = { ok: false, reason: 'invalid_patch' };
  if (!isPlainObject(patch)) return invalid;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !WORKSPACE_VIEW_PATCH_KEYS.includes(key))) return invalid;
  const clean = {};
  for (const key of ['rail_visible', 'children_expanded']) {
    if (!hasOwn(patch, key)) continue;
    if (typeof patch[key] !== 'boolean') return invalid;
    clean[key] = patch[key];
  }
  if (hasOwn(patch, 'disclosures')) {
    const incoming = patch.disclosures;
    if (!isPlainObject(incoming)) return invalid;
    const incomingKeys = Object.keys(incoming);
    if (!incomingKeys.length) return invalid;
    const disclosures = {};
    for (const key of incomingKeys) {
      if (!DISCLOSURE_KEYS.includes(key) || typeof incoming[key] !== 'boolean') return invalid;
      disclosures[key] = incoming[key];
    }
    clean.disclosures = disclosures;
  }
  return { ok: true, patch: clean };
}

function mergeWorkspaceView(current, patch) {
  const base = normalizeWorkspaceView(current);
  return {
    schema_version: WORKSPACE_VIEW_SCHEMA_VERSION,
    rail_visible: hasOwn(patch, 'rail_visible') ? patch.rail_visible : base.rail_visible,
    disclosures: { ...base.disclosures, ...(patch.disclosures || {}) },
    children_expanded: hasOwn(patch, 'children_expanded') ? patch.children_expanded : base.children_expanded,
  };
}

function readRecord(store, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id || !store) return null;
  const reader = typeof store.peekSession === 'function' ? store.peekSession : store.getSession;
  return typeof reader === 'function' ? reader.call(store, id) || null : null;
}

// One reader/writer of `workspace_view` + `coordination_revision` over an
// ElectronSessionStore (or a store with the same dedicated record writer).
function createWorkspaceViewStore(store) {
  function read(sessionId) {
    const session = readRecord(store, sessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      session_incarnation: String(session.session_incarnation || ''),
      workspace_view: projectWorkspaceView(session.workspace_view),
      coordination_revision: normalizeCoordinationRevision(session.coordination_revision),
    };
  }

  function write(sessionId, request) {
    if (!isPlainObject(request)) return { ok: false, reason: 'invalid_request' };
    const expected = request.expected_revision;
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
      return { ok: false, reason: 'invalid_request' };
    }
    const checked = validateWorkspaceViewPatch(request.patch);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const session = readRecord(store, sessionId);
    if (!session) return { ok: false, reason: 'not_found' };
    const id = String(sessionId).trim();
    const currentRevision = normalizeCoordinationRevision(session.coordination_revision);
    if (expected !== currentRevision) {
      return { ok: false, reason: 'revision_conflict', current_revision: currentRevision };
    }
    if (isCoordinationContainerFrozen(session.workspace_view) || currentRevision >= Number.MAX_SAFE_INTEGER) {
      return { ok: false, reason: 'unavailable', retryable: false, current_revision: currentRevision };
    }
    const previous = {
      workspace_view: normalizeWorkspaceView(session.workspace_view),
      coordination_revision: currentRevision,
    };
    const next = {
      workspace_view: mergeWorkspaceView(session.workspace_view, checked.patch),
      coordination_revision: currentRevision + 1,
    };
    const ioFailed = {
      ok: false, reason: 'io_failed', retryable: true, current_revision: currentRevision,
    };
    if (typeof store._updateSessionRecord !== 'function') return ioFailed;
    let flushed;
    try {
      const summary = store._updateSessionRecord(id, next, { bumpUpdatedAt: false });
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
    if (!flushed) {
      // Put the in-memory record back (memory only: the disk never took the
      // new value) so a later flush cannot persist an unacknowledged write.
      try {
        store._updateSessionRecord(id, previous, { bumpUpdatedAt: false, persist: false });
      } catch {
        // The failure result below already reports the revision callers must retry from.
      }
      return ioFailed;
    }
    return { ok: true, ...next };
  }

  return { read, write };
}

module.exports = {
  COORDINATION_FIELDS,
  DISCLOSURE_KEYS,
  LAUNCH_GRANT_TTL_MS,
  applyCoordinationDefaults,
  createWorkspaceViewStore,
  isCoordinationContainerFrozen,
  normalizeChatProposals,
  normalizeCoordinationFields,
  normalizeCoordinationReceipts,
  normalizeCoordinationRevision,
  normalizeLaunchGrant,
  normalizeLaunchGrantList,
  normalizeSessionMail,
  normalizeSpawnedFrom,
  normalizeWorkspaceView,
  partitionLaunchGrants,
  stripCoordinationFields,
  validateWorkspaceViewPatch,
};
