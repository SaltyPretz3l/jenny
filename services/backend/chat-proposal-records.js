'use strict';

const { PROPOSAL_ERROR_CODES: SHARED_PROPOSAL_ERROR_CODES } = require('./error-codes');

// Pure Git/command/session proposal records (row 59 checkpoints 3 and 5a): validators, the closed
// record normalizer, the C8 state machine and expiry/pruning. No IO (writer: ./chat-proposal-store).
// The session kind lives in ./chat-proposal-session-records and the projection in
// ./chat-proposal-projection; both require this module, so it loads them lazily.

const crypto = require('crypto');

const PROPOSAL_LIMITS = Object.freeze({
  summary_chars: 4096,
  question_chars: 512,
  purpose_chars: 1024,
  precondition_text_chars: 256,
  command_bytes: 8 * 1024,
  path_bytes: 4 * 1024,
  paths_max: 200,
  preconditions_max: 5,
  timeout_min: 1,
  timeout_max: 300,
  timeout_default: 30,
  docker_timeout_max: 120,
  exit_codes_max: 16,
  record_bytes: 128 * 1024,
  unresolved_per_source: 20,
  unresolved_per_profile: 256,
  expiry_ms: 7 * 24 * 60 * 60 * 1000,
  finalized_per_session: 1024,
  finalized_max_age_ms: 30 * 24 * 60 * 60 * 1000,
});

const PROPOSAL_ERROR_CODES = Object.freeze(Object.fromEntries(
  Object.entries(SHARED_PROPOSAL_ERROR_CODES).map(([key, code]) => [key.toLowerCase(), code]),
));

const DECISION_STATES = Object.freeze(['pending', 'accepted', 'dismissed', 'expired', 'withdrawn', 'stale']);
const ACTION_STATES = Object.freeze(['none', 'waiting_for_source', 'queued', 'preparing', 'child_created',
  'admitted', 'succeeded', 'failed', 'cancelled', 'needs_attention']);
const GIT_CHOICES = ['commit', 'test_first', 'dismiss'];
const COMMAND_CHOICES = ['run', 'dismiss'];
const SESSION_CHOICES = ['do_it_here', 'new_session', 'dismiss'];
const KINDS = ['git', 'command', 'session'];
const SETTLED_ACTIONS = Object.freeze(['succeeded', 'failed', 'cancelled']);
const BATCH_A_ACCEPTED_ACTIONS = Object.freeze(['queued', 'admitted', ...SETTLED_ACTIONS, 'needs_attention']);
const SESSION_ACCEPTED_ACTIONS = Object.freeze(ACTION_STATES.filter((state) => state !== 'none'));
const RETRYABLE_REASONS = ['unavailable', 'dispatch_failed'];
const RECORD_KEYS = Object.freeze([
  'schema_version', 'proposal_id', 'revision', 'kind', 'source_session_id', 'source_session_incarnation',
  'source_turn_id', 'source_tool_call_id', 'created_at', 'expires_at', 'normalized_input', 'binding',
  'options', 'group_id', 'decision_state', 'action_state', 'decision', 'attempt_id', 'attempt_number',
  'preparation_work_id', 'preparation_turn_id', 'child_session_id', 'child_session_incarnation',
  'child_creation_hash', 'first_turn_work_id', 'first_turn_turn_id', 'continuation_work_id',
  'continuation_turn_id', 'dispatch_key', 'dispatch_key_sha256', 'command_operation_id', 'handoff',
  'last_error', 'restore_requires_confirmation', 'execution',
]);
const SESSION_ONLY_NULL_KEYS = Object.freeze([
  'options', 'group_id', 'preparation_work_id', 'preparation_turn_id', 'child_session_id',
  'child_session_incarnation', 'child_creation_hash', 'first_turn_work_id', 'first_turn_turn_id', 'handoff',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/; // lowercase only (the sidecar's form)
const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROPOSAL_ID_RE = /^proposal_[0-9a-f]{64}$/;
const ERROR_CODE_RE = /^CMP-PROPOSAL-00(?:0[1-9]|1[0-2])$/;
// Invisible or text-reordering characters (C0 but TAB/LF/CR, DEL, C1, bidi, zero-width): inspected = executed.
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/u;

// ---------- primitives ----------

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const isHex64 = (value) => typeof value === 'string' && HEX64_RE.test(value);
function isIsoTimestamp(value) { return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value)); }
function isInt(value, min, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function isNonEmptyString(value, max = 512) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function nullOr(value, check) { return value === null || check(value); }

function sha256Hex(input) {
  return crypto.createHash('sha256').update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input).digest('hex');
}

// Recursively sorted keys, array order kept, no whitespace; throws on values
// JSON cannot represent exactly (undefined, functions, non-finite numbers).
function canonicalJson(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (type === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${type}`);
}

// Unicode code points (not UTF-16 units), counting stops once past the cap.
function codePointLength(text, cap) {
  let count = 0;
  for (const point of text) {
    count += point.length > 0 ? 1 : 0;
    if (count > cap) return count;
  }
  return count;
}

const wellFormed = (text) => (typeof text.isWellFormed === 'function' ? text.isWellFormed() : true);

function isoFromNow(now) {
  const date = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid timestamp');
  return date.toISOString();
}

const timeMs = (iso) => Date.parse(iso);

// ---------- input validators (C2) ----------

const fail = (cause) => ({ ok: false, reason: 'invalid_request', cause_code: cause });

function validText(value, maxChars) {
  if (typeof value !== 'string' || !wellFormed(value) || value.includes('\0') || value.trim().length === 0) return false;
  return codePointLength(value, maxChars) <= maxChars;
}

// Workspace-relative, '/'-separated, no traversal. `allowDot` admits "." alone (cwd).
function validRelativePath(value, { allowDot = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || !wellFormed(value)) return false;
  if (allowDot && value === '.') return true;
  if (/[\0\r\n\\]/.test(value) || INVISIBLE_RE.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (Buffer.byteLength(value, 'utf8') > PROPOSAL_LIMITS.path_bytes) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function checkKeys(args, allowed) {
  if (!isPlainObject(args)) return fail('invalid_args');
  for (const key of Object.keys(args)) if (!allowed.includes(key)) return fail('unknown_key');
  if (Object.hasOwn(args, 'schema_version') && args.schema_version !== 1) return fail('field_schema_version');
  return null;
}

function normalizeGitProposalInput(args) {
  const bad = checkKeys(args, ['schema_version', 'summary', 'question', 'paths']);
  if (bad) return bad;
  if (!validText(args.summary, PROPOSAL_LIMITS.summary_chars)) return fail('field_summary');
  if (!validText(args.question, PROPOSAL_LIMITS.question_chars)) return fail('field_question');
  const { paths } = args;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > PROPOSAL_LIMITS.paths_max) return fail('field_paths');
  if (!paths.every((entry) => validRelativePath(entry))) return fail('field_paths');
  if (new Set(paths).size !== paths.length) return fail('field_paths');
  return {
    ok: true,
    value: { schema_version: 1, summary: args.summary, question: args.question, paths: [...paths].sort() },
  };
}

function normalizeCommandProposalInput(args, { shell, backend } = {}) {
  const bad = checkKeys(args, [
    'schema_version', 'command', 'cwd', 'purpose', 'timeout_seconds', 'expected_exit_codes', 'preconditions',
  ]);
  if (bad) return bad;
  const { command } = args;
  if (typeof command !== 'string' || !wellFormed(command) || command.includes('\0') || command.trim().length === 0
    || Buffer.byteLength(command, 'utf8') > PROPOSAL_LIMITS.command_bytes) return fail('field_command');
  if (shell === 'cmd.exe' && /[\r\n]/.test(command)) return fail('multiline_cmd_exe');
  if (INVISIBLE_RE.test(command)) return fail('invisible_characters');
  if (!validRelativePath(args.cwd, { allowDot: true })) return fail('field_cwd');
  if (!validText(args.purpose, PROPOSAL_LIMITS.purpose_chars)) return fail('field_purpose');
  let timeout = PROPOSAL_LIMITS.timeout_default;
  if (Object.hasOwn(args, 'timeout_seconds')) {
    if (!isInt(args.timeout_seconds, PROPOSAL_LIMITS.timeout_min, PROPOSAL_LIMITS.timeout_max)) return fail('field_timeout_seconds');
    if (backend === 'docker' && args.timeout_seconds > PROPOSAL_LIMITS.docker_timeout_max) return fail('timeout_sandbox_limit');
    timeout = args.timeout_seconds;
  }
  let codes = [0];
  if (Object.hasOwn(args, 'expected_exit_codes')) {
    const list = args.expected_exit_codes;
    if (!Array.isArray(list) || list.length < 1 || list.length > PROPOSAL_LIMITS.exit_codes_max
      || !list.every((code) => isInt(code, 0, 255)) || new Set(list).size !== list.length) {
      return fail('field_expected_exit_codes');
    }
    codes = [...list];
  }
  let preconditions = [];
  if (Object.hasOwn(args, 'preconditions')) {
    const list = args.preconditions;
    if (!Array.isArray(list) || list.length > PROPOSAL_LIMITS.preconditions_max) return fail('field_preconditions');
    for (const entry of list) {
      if (!isPlainObject(entry) || Object.keys(entry).some((key) => key !== 'kind' && key !== 'text')
        || entry.kind !== 'user_confirmation' || !validText(entry.text, PROPOSAL_LIMITS.precondition_text_chars)) {
        return fail('field_preconditions');
      }
    }
    preconditions = list.map((entry) => ({ kind: 'user_confirmation', text: entry.text }));
  }
  return {
    ok: true,
    value: {
      schema_version: 1, command, cwd: args.cwd, purpose: args.purpose,
      timeout_seconds: timeout, expected_exit_codes: codes, preconditions,
    },
  };
}

// ---------- identity ----------

// computeProposalId(incarnation, turnId, toolCallId), or one object with
// source_session_incarnation/source_turn_id/source_tool_call_id (or camelCase).
function computeProposalId(incarnation, turnId, toolCallId) {
  let parts = [incarnation, turnId, toolCallId];
  if (isPlainObject(incarnation)) {
    const src = incarnation;
    parts = [
      src.source_session_incarnation ?? src.sessionIncarnation,
      src.source_turn_id ?? src.turnId,
      src.source_tool_call_id ?? src.toolCallId,
    ];
  }
  if (!parts.every((part) => typeof part === 'string' && part.length > 0)) {
    throw new TypeError('computeProposalId: identity strings required');
  }
  return `proposal_${sha256Hex(canonicalJson(parts))}`;
}

const buildGitDispatchKey = (proposalId, decisionId) => `proposal:${proposalId}:${decisionId}:local`;
const runtimeIdempotencyKey = (dispatchKeySha256) => `pdk_${String(dispatchKeySha256).slice(0, 64)}`;

// ---------- record normalizer (C1/C3) ----------

function validGitFact(fact) {
  return isPlainObject(fact) && isNonEmptyString(fact.path, 4096) && nullOr(fact.orig_path, (v) => isNonEmptyString(v, 4096))
    && typeof fact.index_status === 'string' && fact.index_status.length === 1
    && typeof fact.worktree_status === 'string' && fact.worktree_status.length === 1
    && ['head_oid', 'index_oid', 'worktree_oid'].every((key) => nullOr(fact[key], (v) => isNonEmptyString(v, 128)))
    && ['file', 'symlink', 'missing'].includes(fact.worktree_kind);
}

// A session proposal may come from a projectless chat: workspace_id and root_identity are then null.
function validCommonBinding(binding, nullableRoot = false) {
  if (!isPlainObject(binding)) return false;
  const root = binding.root_identity;
  const rootOk = (nullableRoot && root === null) || (isPlainObject(root) && isNonEmptyString(root.root_id));
  const workspaceOk = (nullableRoot && binding.workspace_id === null) || isNonEmptyString(binding.workspace_id);
  return nullOr(binding.source_project_id, (v) => isNonEmptyString(v)) && workspaceOk && rootOk
    && isInt(binding.authority_revision, 0) && ['agent', 'plan'].includes(binding.run_mode)
    && isPlainObject(binding.restrictions) && typeof binding.restrictions.read_only === 'boolean'
    && typeof binding.restrictions.plan_mode === 'boolean'
    && nullOr(binding.model, (v) => isNonEmptyString(v)) && nullOr(binding.effort, (v) => isNonEmptyString(v));
}

function validBinding(binding, kind) {
  if (kind === 'session') return sessionRecords().validSessionBinding(binding);
  if (!validCommonBinding(binding)) return false;
  const { git, command } = binding;
  if (kind === 'git') {
    return command === null && isPlainObject(git) && nullOr(git.ref, (v) => isNonEmptyString(v, 4096))
      && nullOr(git.head, (v) => isNonEmptyString(v, 128)) && Array.isArray(git.paths)
      && git.paths.length >= 1 && git.paths.length <= PROPOSAL_LIMITS.paths_max && git.paths.every(validGitFact)
      && isHex64(git.fingerprint);
  }
  return git === null && isPlainObject(command) && ['native', 'docker'].includes(command.backend)
    && ['cmd.exe', '/bin/sh'].includes(command.shell) && validRelativePath(command.cwd, { allowDot: true })
    && isHex64(command.command_sha256);
}

function validDecision(decision, kind) {
  if (!isPlainObject(decision)) return false;
  const choices = { git: GIT_CHOICES, command: COMMAND_CHOICES, session: SESSION_CHOICES }[kind];
  const confirmed = decision.confirmed_preconditions;
  return isUuid(decision.decision_id) && isInt(decision.accepted_revision, 1) && choices.includes(decision.choice)
    && isIsoTimestamp(decision.accepted_at)
    && (kind === 'session' ? sessionRecords().validDecisionOptions(decision) : decision.options === null)
    && nullOr(confirmed, (v) => Array.isArray(v) && v.length <= PROPOSAL_LIMITS.preconditions_max
      && v.every((n) => isInt(n, 0, PROPOSAL_LIMITS.preconditions_max - 1)) && new Set(v).size === v.length);
}

function validLastError(error) {
  return isPlainObject(error) && ERROR_CODE_RE.test(error.code) && isNonEmptyString(error.reason, 64)
    && typeof error.retryable === 'boolean' && nullOr(error.cause_code, (v) => isNonEmptyString(v, 128));
}

function validExecution(execution) {
  return isPlainObject(execution) && isNonEmptyString(execution.status, 64) && nullOr(execution.exit_code, (v) => isInt(v, -255, 255))
    && nullOr(execution.cleanup, (v) => v === 'confirmed' || v === 'uncertain');
}

function validStateCombo(record) {
  const { decision_state: ds, action_state: as, decision } = record;
  if (ds === 'pending') return as === 'none' && decision === null;
  if (ds === 'dismissed') return as === 'none' && decision !== null && decision.choice === 'dismiss';
  if (ds === 'accepted') {
    const actions = record.kind === 'session' ? SESSION_ACCEPTED_ACTIONS : BATCH_A_ACCEPTED_ACTIONS;
    return decision !== null && decision.choice !== 'dismiss' && actions.includes(as);
  }
  return as === 'none' && decision === null; // expired | withdrawn | stale
}

function validIdentityFields(raw) {
  if (!PROPOSAL_ID_RE.test(raw.proposal_id) || !isInt(raw.revision, 1)) return false;
  const ids = ['source_session_id', 'source_session_incarnation', 'source_turn_id', 'source_tool_call_id'];
  if (!ids.every((key) => isNonEmptyString(raw[key], 256))) return false;
  if (raw.proposal_id !== computeProposalId(raw.source_session_incarnation, raw.source_turn_id, raw.source_tool_call_id)) return false;
  if (!isIsoTimestamp(raw.created_at) || !isIsoTimestamp(raw.expires_at)) return false;
  return timeMs(raw.expires_at) === timeMs(raw.created_at) + PROPOSAL_LIMITS.expiry_ms;
}

function validDispatchFields(raw) {
  if (!nullOr(raw.attempt_id, isUuid) || !isInt(raw.attempt_number, 0)) return false;
  if (raw.kind !== 'session' && SESSION_ONLY_NULL_KEYS.some((key) => raw[key] !== null)) return false;
  if (!nullOr(raw.continuation_work_id, (v) => isNonEmptyString(v, 256))
    || !nullOr(raw.continuation_turn_id, (v) => isNonEmptyString(v, 256))) return false;
  if (!nullOr(raw.dispatch_key, (v) => isNonEmptyString(v, 512)) || !nullOr(raw.dispatch_key_sha256, isHex64)) return false;
  if ((raw.dispatch_key === null) !== (raw.dispatch_key_sha256 === null)) return false;
  if (raw.dispatch_key !== null && sha256Hex(raw.dispatch_key) !== raw.dispatch_key_sha256) return false;
  return nullOr(raw.command_operation_id, isUuid) && nullOr(raw.last_error, validLastError)
    && typeof raw.restore_requires_confirmation === 'boolean'; // set by a trusted archive restore, any kind
}

function normalizeKindInput(raw) {
  if (raw.kind === 'git') return normalizeGitProposalInput(raw.normalized_input);
  if (raw.kind === 'session') return sessionRecords().normalizeSessionProposalInput(raw.normalized_input);
  return normalizeCommandProposalInput(raw.normalized_input, {
    shell: raw.binding.command.shell, backend: raw.binding.command.backend,
  });
}

// A stored/new record in canonical form, or null when it is not a valid Batch A record.
function normalizeProposalRecord(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== 1) return null;
  if (Object.keys(raw).length !== RECORD_KEYS.length || RECORD_KEYS.some((key) => !Object.hasOwn(raw, key))) return null;
  const { kind } = raw;
  if (!KINDS.includes(kind)) return null;
  if (!validIdentityFields(raw) || !validBinding(raw.binding, kind)) return null;
  const checked = normalizeKindInput(raw);
  if (!checked.ok || canonicalJson(checked.value) !== canonicalJson(raw.normalized_input)) return null;
  if (kind === 'command' && (raw.binding.command.cwd !== checked.value.cwd
    || raw.binding.command.command_sha256 !== sha256Hex(checked.value.command))) return null;
  if (!DECISION_STATES.includes(raw.decision_state) || !ACTION_STATES.includes(raw.action_state)) return null;
  if (raw.decision !== null && !validDecision(raw.decision, kind)) return null;
  if (!validDispatchFields(raw)) return null;
  if (!nullOr(raw.execution, validExecution) || (kind !== 'command' && raw.execution !== null)) return null;
  if (!validStateCombo(raw) || (kind === 'session' && !sessionRecords().validSessionRecord(raw))) return null;
  const record = structuredClone(raw);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.record_bytes) return null;
  return record;
}

// Circular with this module (it requires us for the shared primitives), so it is resolved at call time.
const sessionRecords = () => require('./chat-proposal-session-records');

const pick = (source, camel, snake) => (source[snake] !== undefined ? source[snake] : source[camel]);

// {ok:true, record} | {ok:false, reason, cause_code}. Accepts camelCase or snake_case keys:
// kind, sessionId, sessionIncarnation, turnId, toolCallId, input (C2 value), binding (C3), now.
function createProposalRecord(spec) {
  if (!isPlainObject(spec)) return fail('invalid_args');
  const { kind } = spec;
  const sessionId = pick(spec, 'sessionId', 'source_session_id');
  const incarnation = pick(spec, 'sessionIncarnation', 'source_session_incarnation');
  const turnId = pick(spec, 'turnId', 'source_turn_id');
  const toolCallId = pick(spec, 'toolCallId', 'source_tool_call_id');
  if (!KINDS.includes(kind)) return fail('field_kind');
  if (![sessionId, incarnation, turnId, toolCallId].every((v) => isNonEmptyString(v, 256))) return fail('field_identity');
  const createdAt = isoFromNow(spec.now);
  const record = {
    schema_version: 1,
    proposal_id: computeProposalId(incarnation, turnId, toolCallId),
    revision: 1,
    kind,
    source_session_id: sessionId,
    source_session_incarnation: incarnation,
    source_turn_id: turnId,
    source_tool_call_id: toolCallId,
    created_at: createdAt,
    expires_at: new Date(timeMs(createdAt) + PROPOSAL_LIMITS.expiry_ms).toISOString(),
    normalized_input: spec.input,
    binding: spec.binding,
    ...Object.fromEntries(SESSION_ONLY_NULL_KEYS.map((key) => [key, null])), // session-kind fields stay null
    ...(kind === 'session' ? sessionRecords().sessionCreateFields({ options: spec.options, input: spec.input, incarnation, turnId }) : {}),
    decision_state: 'pending',
    action_state: 'none',
    decision: null,
    attempt_id: null,
    attempt_number: 0,
    continuation_work_id: null,
    continuation_turn_id: null,
    dispatch_key: null,
    dispatch_key_sha256: null,
    command_operation_id: null,
    last_error: null,
    restore_requires_confirmation: false,
    execution: null,
  };
  let size;
  try { size = Buffer.byteLength(JSON.stringify(record), 'utf8'); } catch { return fail('field_input'); }
  if (size > PROPOSAL_LIMITS.record_bytes) return { ok: false, reason: 'capacity', cause_code: 'record_too_large' };
  const normalized = normalizeProposalRecord(record);
  return normalized ? { ok: true, record: normalized } : fail('record_invalid');
}

// ---------- lifecycle (C8) ----------

function isUnresolved(record) {
  if (!record) return false;
  if (record.decision_state === 'pending') return true;
  if (record.decision_state !== 'accepted' || SETTLED_ACTIONS.includes(record.action_state)) return false;
  // Non-retryable needs_attention (an unknown outcome included) is a terminal receipt for caps and pruning.
  return !(record.action_state === 'needs_attention' && record.last_error?.retryable !== true);
}

function isDue(record, now) { return timeMs(isoFromNow(now)) >= timeMs(record.expires_at); }

const next = (record, patch) => ({ ...record, ...patch, revision: record.revision + 1 });

// The expired copy of a pending record past expires_at, else null (unchanged).
function expireIfDue(record, now) {
  if (!record || record.decision_state !== 'pending' || !isDue(record, now)) return null;
  return next(record, { decision_state: 'expired', action_state: 'none' });
}

// Finalized receipts: at most 30 days old (created_at), latest 1024 per session. Unresolved is never pruned.
function pruneFinalized(records, now) {
  const nowMs = timeMs(isoFromNow(now));
  const finalized = records.filter((r) => !isUnresolved(r) && nowMs - timeMs(r.created_at) <= PROPOSAL_LIMITS.finalized_max_age_ms);
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const order = (a, b) => cmp(a.created_at, b.created_at) || cmp(a.proposal_id, b.proposal_id);
  const keep = new Set([...finalized].sort(order).slice(-PROPOSAL_LIMITS.finalized_per_session));
  return records.filter((r) => isUnresolved(r) || keep.has(r));
}

function decisionFor(record, { decisionId, choice, now }) {
  return {
    decision_id: decisionId, accepted_revision: record.revision + 1, choice, accepted_at: isoFromNow(now),
    options: null, confirmed_preconditions: null,
  };
}

// 'none' | 'same' | 'conflict' for a decide payload against the stored decision.
function classifyDecisionReplay(record, { decisionId, choice, confirmedPreconditions = null }) {
  const stored = record?.decision;
  if (!stored || stored.decision_id !== decisionId) return 'none';
  const same = stored.choice === choice
    && canonicalJson(stored.confirmed_preconditions) === canonicalJson(confirmedPreconditions ?? null);
  return same ? 'same' : 'conflict';
}

const pendingLive = (record, now) => Boolean(record) && record.decision_state === 'pending' && !isDue(record, now);

function dismissProposal(record, { decisionId, now }) {
  if (!pendingLive(record, now) || !isUuid(decisionId)) return null;
  return next(record, {
    decision_state: 'dismissed', action_state: 'none', decision: decisionFor(record, { decisionId, choice: 'dismiss', now }),
  });
}

// pending git -> accepted/queued: decision, attempt 1 and dispatch key persist BEFORE submission.
function acceptGitDecision(record, { decisionId, choice, now, attemptId = crypto.randomUUID() }) {
  if (record?.kind !== 'git' || !pendingLive(record, now) || !isUuid(decisionId)) return null;
  if (choice !== 'commit' && choice !== 'test_first') return null;
  const dispatchKey = buildGitDispatchKey(record.proposal_id, decisionId);
  return next(record, {
    decision_state: 'accepted', action_state: 'queued', decision: decisionFor(record, { decisionId, choice, now }),
    attempt_id: attemptId, attempt_number: record.attempt_number + 1,
    dispatch_key: dispatchKey, dispatch_key_sha256: sha256Hex(dispatchKey), last_error: null,
  });
}

// D7: binding drift at decision time; the record accepts no choice afterwards.
function markStale(record, { causeCode = null } = {}) {
  if (!record || record.decision_state !== 'pending') return null;
  return next(record, {
    decision_state: 'stale', action_state: 'none',
    last_error: { code: PROPOSAL_ERROR_CODES.authority_changed, reason: 'authority_changed', retryable: false, cause_code: causeCode },
  });
}

// A Git proposal, or a session "Do it here": both continue in the source session through these helpers.
const isContinuation = (r) => r?.kind === 'git' || (r?.kind === 'session' && r.decision?.choice === 'do_it_here');
const isGitQueued = (r) => isContinuation(r) && r.decision_state === 'accepted' && r.action_state === 'queued';
const isGitLive = (r) => isContinuation(r) && r.decision_state === 'accepted' && ['queued', 'admitted'].includes(r.action_state);
const isCommandLive = (r) => r?.kind === 'command' && r.decision_state === 'accepted' && ['queued', 'admitted'].includes(r.action_state);
// DB6: derived from the accepted decision, so the closed record needs no extra field.
const commandToolCallId = (proposalId, decisionId) => `pcmd_${sha256Hex(`${proposalId}:${decisionId}`).slice(0, 32)}`;

function markDispatchAcknowledged(record, { workId, turnId }) {
  if (!isGitQueued(record)) return null;
  return next(record, { continuation_work_id: workId ?? null, continuation_turn_id: turnId ?? null });
}

// Submission refused: runtime unavailable -> 0002 retryable; any other refusal -> 0011 retryable.
function markDispatchRefused(record, { runtimeUnavailable = false, causeCode = null } = {}) {
  if (!isGitQueued(record)) return null;
  const lastError = runtimeUnavailable
    ? { code: PROPOSAL_ERROR_CODES.unavailable, reason: 'unavailable', retryable: true, cause_code: causeCode || 'runtime_unavailable' }
    : { code: PROPOSAL_ERROR_CODES.dispatch_failed, reason: 'dispatch_failed', retryable: true, cause_code: causeCode };
  return next(record, { action_state: 'needs_attention', last_error: lastError });
}

function markAdmitted(record, { workId, turnId } = {}) {
  if (!isGitQueued(record)) return null;
  return next(record, {
    action_state: 'admitted',
    continuation_work_id: record.continuation_work_id ?? workId ?? null,
    continuation_turn_id: record.continuation_turn_id ?? turnId ?? null,
  });
}

// outcome: 'succeeded' | 'failed' | 'cancelled', from queued|admitted.
function markContinuationOutcome(record, outcome) {
  if (!isGitLive(record) || !SETTLED_ACTIONS.includes(outcome)) return null;
  return next(record, { action_state: outcome });
}

// Startup reconciliation could not prove the continuation's terminal outcome.
function markOutcomeUnknown(record) {
  if (!isGitLive(record)) return null;
  return next(record, {
    action_state: 'needs_attention',
    last_error: { code: PROPOSAL_ERROR_CODES.outcome_unknown, reason: 'outcome_unknown', retryable: false, cause_code: 'restart' },
  });
}

// D5: retry only from needs_attention with a pre-admission dispatch failure; SAME dispatch key.
function canRetry(record) {
  return isContinuation(record) && record.decision_state === 'accepted' && record.action_state === 'needs_attention'
    && record.last_error?.retryable === true && RETRYABLE_REASONS.includes(record.last_error.reason);
}

// A retryable continuation whose binding drifted before Retry: Retry is withdrawn and the record reads
// out of date (it was accepted, so decision_state stays). Same error as markStale.
function markRetryStale(record, { causeCode = null } = {}) {
  if (!canRetry(record)) return null;
  return next(record, {
    last_error: { code: PROPOSAL_ERROR_CODES.authority_changed, reason: 'authority_changed', retryable: false, cause_code: causeCode },
  });
}

function prepareRetry(record, { attemptId = crypto.randomUUID() } = {}) {
  if (!canRetry(record)) return null;
  return next(record, {
    action_state: 'queued', attempt_id: attemptId, attempt_number: record.attempt_number + 1, last_error: null,
  });
}

// ---------- projection (C7): ./chat-proposal-projection ----------

const projectProposal = (record, ctx) => require('./chat-proposal-projection').projectProposal(record, ctx); // lazy: it requires this module

module.exports = {
  PROPOSAL_ERROR_CODES, PROPOSAL_LIMITS, commandToolCallId, decisionFor, isCommandLive, nextRevision: next, pendingLive,
  acceptGitDecision, buildGitDispatchKey, canRetry, canonicalJson, classifyDecisionReplay,
  computeProposalId, createProposalRecord, dismissProposal, expireIfDue, isUnresolved, isUuid,
  markAdmitted, markContinuationOutcome, markDispatchAcknowledged, markDispatchRefused,
  markOutcomeUnknown, markRetryStale, markStale, normalizeCommandProposalInput, normalizeGitProposalInput,
  normalizeProposalRecord, prepareRetry, projectProposal, pruneFinalized, runtimeIdempotencyKey, sha256Hex,
  isGitLive,
  // Shared with ./chat-proposal-session-records and ./chat-proposal-projection.
  primitives: Object.freeze({
    INVISIBLE_RE, SESSION_CHOICES, checkKeys, fail, isDue, isHex64, isInt, isIsoTimestamp, isNonEmptyString, isPlainObject, isoFromNow,
    nullOr, validCommonBinding, validText, wellFormed,
  }),
};
