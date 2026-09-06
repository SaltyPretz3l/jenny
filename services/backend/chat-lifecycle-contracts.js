// Builders are pure, throw-free normalizers: malformed input becomes null or
// an empty list, and terminal identity validation is fail-closed.

const {
  normalizeTerminalStatus: normalizeGeneratedTerminalStatus,
} = require('./generated-chat-lifecycle-contract');

function coerceNullableString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function coerceNullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function coerceNullableGeneration(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function coerceMessageIdList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
}

// §3.2 TerminalCoordinator commit result -- the structured shape a terminal
// settlement (complete | error | cancelled | denied | timeout | preempted |
// question_batch | plan_proposal) is supposed to produce. L1 uses this only
// to give diagnostics WARNs at existing discard sites (backend-chat-stream.js
// settle site) a consistent vocabulary; L4 makes the coordinator actually act
// on it instead of discarding it.
function buildTerminalCommitResult({
  ok,
  visibleTerminal,
  durableTerminal,
  reason,
  persistedMessageIds,
  repairDurable,
  artifactId,
} = {}) {
  return {
    ok: Boolean(ok),
    visibleTerminal: Boolean(visibleTerminal),
    durableTerminal: Boolean(durableTerminal),
    reason: coerceNullableString(reason),
    persistedMessageIds: coerceMessageIdList(persistedMessageIds),
    repairDurable: typeof repairDurable === 'boolean' ? repairDurable : null,
    artifactId: coerceNullableString(artifactId),
  };
}

const TERMINAL_KINDS = Object.freeze([
  'complete',
  'error',
  'cancelled',
  'denied',
  'timeout',
  'preempted',
  'question_batch',
  'plan_proposal',
]);
const TERMINAL_KIND_SET = new Set(TERMINAL_KINDS);
const TERMINAL_IDENTITY_FIELDS = Object.freeze([
  'sessionId',
  'sessionIncarnation',
  'generation',
  'turnId',
  'streamId',
  'userMessageId',
]);

function normalizeTerminalKind(value) {
  const normalized = typeof value === 'string' ? value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase() : '';
  if (normalized === 'question_batch' || normalized === 'plan_proposal') {
    return normalized;
  }
  const canonical = normalizeGeneratedTerminalStatus(normalized);
  if (TERMINAL_KIND_SET.has(canonical)) return canonical;
  if (TERMINAL_KIND_SET.has(normalized)) {
    return normalized;
  }
  return null;
}

function buildTerminalIdentity({
  sessionId,
  sessionIncarnation,
  generation,
  turnId,
  streamId,
  userMessageId,
  sessionRevision,
} = {}) {
  return {
    sessionId: coerceNullableString(sessionId),
    sessionIncarnation: coerceNullableString(sessionIncarnation),
    generation: coerceNullableGeneration(generation),
    turnId: coerceNullableString(turnId),
    streamId: coerceNullableString(streamId),
    userMessageId: coerceNullableString(userMessageId),
    sessionRevision: coerceNullableNumber(sessionRevision),
  };
}

function validateTerminalIdentity(source) {
  const identity = buildTerminalIdentity(source);
  const missingField = TERMINAL_IDENTITY_FIELDS.find((field) => identity[field] == null);
  return missingField
    ? { ok: false, reason: `missing_terminal_identity_${missingField}`, identity }
    : { ok: true, reason: null, identity };
}

function terminalIdentityMatches(left, right) {
  const leftResult = validateTerminalIdentity(left);
  const rightResult = validateTerminalIdentity(right);
  return Boolean(
    leftResult.ok
    && rightResult.ok
    && TERMINAL_IDENTITY_FIELDS.every(
      (field) => leftResult.identity[field] === rightResult.identity[field]
    )
  );
}

// A cache mutation is not terminally durable without an explicit positive
// commit epoch and proof that the durable epoch reached it. Legacy truthy
// summaries and `ok:true` without epoch proof fail closed.
function isDurableCommitOutcome(value) {
  const commitEpoch = Number(value?.commitEpoch);
  const durableEpoch = Number(value?.durableEpoch);
  return Boolean(
    value?.ok === true
    && value?.durable === true
    && Number.isSafeInteger(commitEpoch)
    && commitEpoch > 0
    && Number.isSafeInteger(durableEpoch)
    && durableEpoch >= commitEpoch
  );
}

// §3.4 "authoritative identity bundle" a provider start is supposed to
// return: {sessionId, streamId, turnId, userMessageId, generation}
// (+ sessionRevision, threaded alongside generation as the L3 durability
// counterpart). L2 makes turnId, userMessageId, and generation authoritative
// values minted by the Electron-owned SessionTurnActor before provider work.
// sessionRevision remains nullable until L3's durability epochs land.
function buildStartIdentityBundle({
  sessionId,
  streamId,
  turnId,
  userMessageId,
  sessionRevision,
  generation,
} = {}) {
  return {
    sessionId: coerceNullableString(sessionId),
    streamId: coerceNullableString(streamId),
    turnId: coerceNullableString(turnId),
    userMessageId: coerceNullableString(userMessageId),
    sessionRevision: coerceNullableNumber(sessionRevision),
    generation: coerceNullableNumber(generation),
  };
}

const IDENTITY_BUNDLE_FIELDS = [
  'sessionId',
  'streamId',
  'turnId',
  'userMessageId',
  'sessionRevision',
  'generation',
];

// Diagnostics helper: which identity-bundle fields are still null/absent.
// Used to give the L1 'chat.start_identity' debug log a quick "what's
// missing" summary without every caller re-deriving the field list.
function describeMissingIdentityFields(bundle) {
  const source = bundle && typeof bundle === 'object' ? bundle : {};
  return IDENTITY_BUNDLE_FIELDS.filter(
    (fieldName) => source[fieldName] === null || source[fieldName] === undefined
  );
}

// Managed-path start result builder (L1 wiring helper, not part of the §3
// shape vocabulary itself): builds {streamId, sessionId} plus the additive
// `identity` bundle and emits the 'chat.start_identity' DEBUG log, so
// managed-sidecar-chat.js's return site stays a single line.
function buildManagedStartResult(service, { sessionId, streamId, identity: issuedIdentity } = {}) {
  const identity = buildStartIdentityBundle({
    sessionId,
    streamId,
    turnId: issuedIdentity?.turnId,
    userMessageId: issuedIdentity?.userMessageId,
    sessionRevision: issuedIdentity?.sessionRevision,
    generation: issuedIdentity?.generation,
  });
  if (service && typeof service._emitServiceLog === 'function') {
    service._emitServiceLog('DEBUG', 'chat.start_identity', {
      sessionId,
      streamId,
      identity,
      missingIdentityFields: describeMissingIdentityFields(identity),
    });
  }
  return { streamId, sessionId, identity };
}

module.exports = {
  TERMINAL_KINDS,
  buildTerminalCommitResult,
  buildTerminalIdentity,
  buildStartIdentityBundle,
  describeMissingIdentityFields,
  buildManagedStartResult,
  isDurableCommitOutcome,
  normalizeTerminalKind,
  terminalIdentityMatches,
  validateTerminalIdentity,
};
