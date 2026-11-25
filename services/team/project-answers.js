'use strict';

// The host's project and conversation answers and events on the member side (row 123 slice 3-9), rebuilt
// field by field before they reach the renderer (owner decision E49's rule, as admin-answers.js does for the
// admin answers). No state. The tables are closed: an operation or event with no row is refused, never passed
// through, and a row that fails its rule refuses the whole answer (`team_answer_invalid`), except in the lists the
// screen shows as lists (projects, unjoined projects, conversations): there a bad row is dropped and the answer
// marked truncated (gate fault F1). Members, viewers and the audit stay all or nothing.
//
// General (`project_general`, the host's owner-only bucket) is not a team project: its row in a projects list and a
// conversation row that names it are dropped silently, not counted as bad (F1).
//
// Ids, roles, names, counts, revisions and flags are checked against the host's own rules. A conversation's
// structured content (message bodies, turn events, a stream event's body, a pending decision's questions) is the
// host's renderer vocabulary, which this client does not interpret: it is copied through JSON with a byte bound
// per value, so nothing but plain data within the bound reaches the renderer. A device id, client id, request id,
// key, token or host path is never answered: the lease is reduced to its member and its expiry.
//
// Slice 3-10: the "Always allowed" answers (team.project.rules.*, TEAM_PROJECTS_SPEC "3-12 as built"), approval.resolve's
// optional `always_result`, and the three rule events, forwarded as the closed kinds `rules_changed`, `rule_requests`
// and `rule_answered` (`checkedRuleEvent`). A folder and a decline reason are plain text; the renderer escapes them.

const { isId, isSessionId } = require('../../server/team/ids');
const { GENERAL_PROJECT_ID, LIMITS, isCount, isPlainObject, isProjectId } = require('../../server/team/member-schema');
const { BAD, count, fields, flag, is, jsonCopy, list, nullable, oneOf, optional, record } = require('./answer-rules');
const { failureAnswer, invalidRequest } = require('./team-errors');
const { isBoardId } = require('../boards/board-ids');
const { RULE_TOOL_NAMES } = require('../../server/team/project-rules-match');
const { isDrawable, pictureType } = require('./chat-attachments');

const INVALID_REASON = 'team_answer_invalid';
const PROJECT_ROLES = Object.freeze(['admin', 'writer', 'reader']);
const LIST_ROLES = Object.freeze(['owner', ...PROJECT_ROLES]);
// The host's id rule (server/api-contract.js `id`): stream ids, decision revisions, question refs and the like.
const WORD_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const KIND_WORD = /^[a-z][a-z0-9_]{0,63}$/u;
const CONTROL = /\p{Cc}/u;
// What a list may hold at most: projects (64 team rows, General and records the reconcile has not bound), the
// conversations of every project, a page of the project audit.
const MAX_PROJECT_ROWS = 128;
const MAX_CONVERSATION_ROWS = 2_000;
const MAX_AUDIT_PAGE = 100;
const MAX_VIEWERS = 32;
// Byte bounds for copied structured content: one message, one stream event, the snapshot's other parts.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_PART_BYTES = 1024 * 1024;

const memberId = is((value) => isId('member', value));
const positiveSeq = is((value) => Number.isSafeInteger(value) && value >= 1);
const projectId = is(isProjectId);
const sessionId = is(isSessionId);
const wordId = is((value) => typeof value === 'string' && WORD_ID.test(value));
const boundedText = (max) => is((value) => typeof value === 'string' && value.length <= max && !CONTROL.test(value));
// A project name as the host stores it (1 to 80 characters), a conversation title (at most 240).
const projectName = is((value) => typeof value === 'string' && value.length >= 1 && value.length <= 80 && !CONTROL.test(value));
// A title is shown as text by the renderer: bounded, any characters (the host slices it to 240).
const title = is((value) => typeof value === 'string' && value.length <= 240);
const revision = boundedText(160);
const stamp = boundedText(80);

// A shown list (fix 11, F1): the first `max` rows that pass `rule`, the rest dropped and the answer marked
// truncated, so one bad or extra row never takes the project area down. A row `skip` picks (General) is dropped
// without marking anything. Answers `{ rows, truncated }`.
function firstRows(rule, max, skip = () => false) {
  return (value) => {
    if (!Array.isArray(value)) return BAD;
    const rows = [];
    let truncated = false;
    for (const item of value) {
      if (skip(item)) continue;
      if (rows.length >= max) { truncated = true; break; }
      const checked = rule(item);
      if (checked === BAD) truncated = true;
      else rows.push(checked);
    }
    return { rows, truncated };
  };
}

const PROJECT_ROW = record({ id: projectId, name: projectName, root_revision: count, role: nullable(oneOf(LIST_ROLES)) });
// A row naming General, read through `idOf` (a project row's own id, an unjoined or conversation row's project).
const isGeneral = (idOf) => (item) => isPlainObject(item) && idOf(item) === GENERAL_PROJECT_ID;
const CONVERSATION_ROW = record({ session_id: sessionId, title, project_id: optional(projectId),
  updated_at: optional(stamp), created_at: optional(stamp), message_count: optional(count) });
// Row 175 F9: a listed conversation's pending approvals and question batches at the host's read (each 0 to 64). A
// malformed `waiting` is dropped from its row (the row stays); an older host sends none.
const MAX_WAITING = 64;
const waitingCount = (value) => isCount(value) && value <= MAX_WAITING;
function waitingOf(value) {
  return isPlainObject(value) && waitingCount(value.approvals) && waitingCount(value.questions)
    ? { approvals: value.approvals, questions: value.questions } : null;
}
const LISTED_CONVERSATION = (value) => {
  const row = CONVERSATION_ROW(value);
  if (row === BAD) return BAD;
  const waiting = waitingOf(value.waiting);
  return waiting ? { ...row, waiting } : row;
};
// Row 175 item 11: the decisions the host saved for a conversation (its project audit), newest last, at most 50. Each is
// ids, a tool id and the host's ISO time; a malformed receipt is dropped alone, a value that is no list is none.
const MAX_RECEIPTS = 50;
const RECEIPT_OUTCOMES = Object.freeze(['allowed', 'declined', 'withdrawn', 'expired', 'answered']);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
// Audit schema 4 (server/team/project-audit.js): the approval id and tool call id, each optional (an older host sends none).
const auditId = (max, pattern = new RegExp(`^[A-Za-z0-9_.:-]{1,${max}}$`, 'u')) => optional(is((value) => typeof value === 'string'
  && pattern.test(value)));
const RECEIPT = record({ seq: positiveSeq, session_id: sessionId, outcome: oneOf(RECEIPT_OUTCOMES),
  tool_name: nullable(is((value) => typeof value === 'string' && KIND_WORD.test(value))),
  approver_member_id: nullable(memberId), prompter_member_id: nullable(memberId),
  decided_at: is((value) => typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value))),
  approval_id: auditId(512), call_id: auditId(128) });
const RECEIPTS = Object.assign((value) => {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_RECEIPTS).map(RECEIPT).filter((receipt) => receipt !== BAD);
}, { optional: true });
const AUDIT_ENTRY = record({
  seq: count, at: count, kind: is((value) => typeof value === 'string' && KIND_WORD.test(value)), project_id: projectId,
  session_id: nullable(sessionId), actor_member_id: nullable(memberId), prompter_member_id: nullable(memberId),
  // Schema 3 (team boards): the board a board kind names. A host of an older build sends no such key.
  board_id: optional(nullable(is(isBoardId))),
  tool_name: nullable(is((value) => typeof value === 'string' && KIND_WORD.test(value))),
  decision: nullable(oneOf(['approved', 'denied'])),
  detail: nullable((value) => {
    if (!isPlainObject(value)) return BAD;
    const out = {};
    for (const key of ['files', 'bytes', 'skipped', 'ref_seq', 'rule_seq', 'request_seq', 'change', 'count', 'rev', 'items']) if (Object.hasOwn(value, key)) {
      if (!isCount(value[key])) return BAD;
      out[key] = value[key];
    }
    return out;
  }),
});

// Slice 3-10: a rule and a request as team-project-rules.js answers them (project-rules-store.js bounds).
const MAX_RULES = 32;
const MAX_RULE_REQUESTS = 48; // an admin's open (16) plus their own answered (32); anyone else's own, open and answered
const positive = is((value) => Number.isSafeInteger(value) && value >= 1);
const ruleTool = oneOf(RULE_TOOL_NAMES);
const folderText = is((value) => typeof value === 'string' && value.length >= 1 && value.length <= 255 && !CONTROL.test(value));
const reasonText = is((value) => typeof value === 'string' && value.length >= 1 && value.length <= 400 && [...value].length <= 200
  && !CONTROL.test(value));
const RULE_OUTCOMES = Object.freeze(['allowed', 'changed', 'declined']);
const RULE = record({ rule_seq: positive, tool_name: ruleTool, folder: nullable(folderText), set_by: memberId, set_at: count,
  from_request_seq: nullable(positive), use_count: count, last_used_at: nullable(count), last_used_by: nullable(memberId) });
const RULE_REQUEST = record({ request_seq: positive, tool_name: ruleTool, asker_member_id: memberId, session_id: sessionId,
  asked_at: count, state: oneOf(['open', ...RULE_OUTCOMES]), answered_by: nullable(memberId), answered_at: nullable(count),
  outcome_tool: nullable(ruleTool), outcome_folder: nullable(folderText), reason: nullable(reasonText),
  rule_seq: nullable(positive) });
// `always_result`: { ok: true, rule_seq } or { ok: true, request_seq } or { ok: false, reason }; the allow stood either way.
const ALWAYS_RESULT = (value) => {
  if (!isPlainObject(value)) return BAD;
  if (value.ok === false) return typeof value.reason === 'string' && KIND_WORD.test(value.reason) ? { ok: false, reason: value.reason } : BAD;
  if (value.ok !== true) return BAD;
  if (positive(value.rule_seq) !== BAD) return { ok: true, rule_seq: value.rule_seq };
  return positive(value.request_seq) !== BAD ? { ok: true, request_seq: value.request_seq } : BAD;
};

// The lease as the renderer may see it: who drives and until when, never the client or device.
const LEASE = (value) => {
  if (value === null || value === undefined) return null;
  const checked = fields(value, { member_id: optional(memberId), expires_at: count });
  return checked === BAD ? BAD : { member_id: checked.member_id ?? null, expires_at: checked.expires_at };
};

// Row 175 F5: the exact change a pending write_file / edit_file approval shows (the host's presentation, schema 1), kept
// only when it validates; anything else is dropped and the entry carries no `exact_approval` key. Text is data here.
const EXACT_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const EXACT_MAX_FIELDS = 16;
const EXACT_MAX_TEXT_BYTES = 32 * 1024;
const EXACT_APPROVAL = (value) => {
  if (!isPlainObject(value) || value.schema_version !== 1) return BAD;
  if (value.too_large === true) {
    return isCount(value.bytes) && isCount(value.limit_bytes)
      ? { schema_version: 1, too_large: true, bytes: value.bytes, limit_bytes: value.limit_bytes } : BAD;
  }
  if (!Array.isArray(value.fields) || value.fields.length > EXACT_MAX_FIELDS || !isCount(value.bytes)
    || typeof value.sha256 !== 'string' || !SHA256_HEX.test(value.sha256)) return BAD;
  const out = [];
  let total = 0;
  for (const field of value.fields) {
    if (!isPlainObject(field) || typeof field.name !== 'string' || !EXACT_FIELD_NAME.test(field.name)
      || typeof field.text !== 'string') return BAD;
    total += Buffer.byteLength(field.text, 'utf8');
    if (total > EXACT_MAX_TEXT_BYTES) return BAD;
    out.push({ name: field.name, text: field.text });
  }
  return { schema_version: 1, fields: out, bytes: value.bytes, sha256: value.sha256 };
};

const PENDING_APPROVAL = (value) => {
  const checked = fields(value, { approval_id: boundedText(512), decision_revision: wordId, stream_id: wordId,
    tool_name: boundedText(128), prompter_member_id: optional(nullable(memberId)) });
  if (checked === BAD) return BAD;
  const rest = jsonCopy(MAX_PART_BYTES)({ call_id: value.call_id, summary: value.summary, policy_scope: value.policy_scope,
    policy_consequence: value.policy_consequence, reason: value.reason });
  if (rest === BAD) return BAD;
  // Row 175 F5, fail closed: a presentation the host sent as null or that fails the check stays as null, so the card
  // shows no Allow; only a host that sends no key at all keeps the summary card.
  const exact = Object.hasOwn(value, 'exact_approval') ? EXACT_APPROVAL(value.exact_approval) : undefined;
  return { ...rest, ...checked, prompter_member_id: checked.prompter_member_id ?? null,
    ...(exact === undefined ? {} : { exact_approval: exact === BAD ? null : exact }) };
};

const PENDING_QUESTIONS = (value) => {
  const checked = fields(value, { question_ref: boundedText(512), stream_id: wordId,
    prompter_member_id: optional(nullable(memberId)) });
  if (checked === BAD) return BAD;
  const questions = jsonCopy(MAX_PART_BYTES)(value.questions ?? []);
  return questions === BAD ? BAD : { ...checked, call_id: typeof value.call_id === 'string' ? value.call_id.slice(0, 128) : '',
    questions, prompter_member_id: checked.prompter_member_id ?? null };
};

const MESSAGE = (value) => {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !value.id || value.id.length > 256) return BAD;
  const copy = jsonCopy(MAX_MESSAGE_BYTES)(value);
  if (copy === BAD) return BAD;
  // The author is the host's closed shape only; anything else is dropped.
  delete copy.author;
  if (isPlainObject(value.author) && value.author.kind === 'member' && isId('member', value.author.member_id)) {
    copy.author = { kind: 'member', member_id: value.author.member_id };
  }
  return copy;
};

// Row 172: a team host's conversation settings in the snapshot, each bounded, all optional (an older host sends none).
const EFFORTS = Object.freeze(['default', 'low', 'medium', 'high']);
const modelName = is((value) => typeof value === 'string' && value.length <= 256 && /^[!-~][ -~]*$/u.test(value));
const TOOL_SWITCHES = record({ read: flag, write: flag });
// Row 175 item 7: `plan` is optional (an older host's log has none).
const PREFERENCE_STATE = record({ model: nullable(modelName), effort: oneOf(EFFORTS), read: flag, write: flag, plan: optional(flag) });
const PREFERENCE_LOG_ENTRY = record({ at: boundedText(40), by: nullable(memberId), from: PREFERENCE_STATE, to: PREFERENCE_STATE });
// Team host file tools (row 123): why a host with the setting on offers none. The same closed list as the host's
// (server/team-conversation-preferences.js FILE_TOOLS_REASONS); a test keeps the two equal.
const FILE_TOOLS_REASONS = Object.freeze([
  'file_access_api_missing', 'file_access_backup_privilege', 'file_access_component_missing', 'file_access_elevated',
  'file_access_platform_unsupported', 'file_access_root_identity', 'file_access_root_invalid',
  'file_access_selfcheck_failed', 'file_access_switch_off', 'file_access_volume_unsupported', 'file_access_unavailable',
]);
const SNAPSHOT_SESSION = record({ session_id: sessionId, title, revision, plan_mode: flag,
  preferred_model: optional(nullable(modelName)), reasoning_effort: optional(oneOf(EFFORTS)), team_tools: optional(TOOL_SWITCHES),
  preference_log: optional(list(PREFERENCE_LOG_ENTRY, 50)), file_tools: optional(oneOf(['available', 'unavailable'])),
  file_tools_reason: optional(oneOf(FILE_TOOLS_REASONS)) });

/** The snapshot of `sessions.snapshot`, rebuilt; BAD when it fails a rule. */
function checkedSnapshot(value) {
  const checked = fields(value, {
    cursor: count,
    session: SNAPSHOT_SESSION,
    messages: list(MESSAGE, 100),
    message_count: count,
    has_more: flag,
    next_before_message_id: optional(boundedText(256)),
    active_turn: nullable(jsonCopy(MAX_PART_BYTES)),
    pending_approvals: list(PENDING_APPROVAL, 64),
    pending_questions: list(PENDING_QUESTIONS, 64),
    live_projection: optional(nullable(jsonCopy(MAX_PART_BYTES))),
    control: optional(LEASE),
    receipts: RECEIPTS,
    viewers: optional(list(memberId, MAX_VIEWERS)), // row 175 F18: who views it now (the driver is control.member_id)
  });
  if (checked === BAD) return BAD;
  return { ...checked, live_projection: checked.live_projection ?? null, control: checked.control ?? null };
}

// Row 175 round 2 (D13): a project file's picture answer. The bytes are checked here before the renderer draws them, as
// chat-attachments.js does for a chat picture: the signature names the declared type, the length is the file's size,
// and the header declares at most 8192 px a side and 40 megapixels (4 for a GIF). One past those bounds is answered
// as too large to show; a signature or length that does not match refuses the answer.
const PICTURE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PICTURE_MAX_FILE_BYTES = 4 * 1024 * 1024;
const PICTURE_MAX_BASE64 = Math.ceil(PICTURE_MAX_FILE_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const isPictureBase64 = (value) => typeof value === 'string' && value.length <= PICTURE_MAX_BASE64 && value.length % 4 === 0 && BASE64.test(value);
const READ_TEXT_KEYS = Object.freeze(['text', 'truncated', 'binary']);

/** A checked files.read answer in exactly one of its three shapes (text, picture, too large), or BAD. */
function readAnswer(checked) {
  const { path, size, image, too_large: tooLarge } = checked;
  const texts = READ_TEXT_KEYS.filter((key) => Object.hasOwn(checked, key)).length;
  if (image) {
    if (texts > 0 || tooLarge) return BAD;
    const bytes = Buffer.from(image.data_base64, 'base64');
    if (bytes.length !== size || pictureType(bytes) !== image.mime) return BAD;
    return isDrawable(image.mime, bytes) ? { path, size, image } : { path, size, too_large: true };
  }
  if (tooLarge) return texts > 0 ? BAD : { path, size, too_large: true };
  if (texts !== READ_TEXT_KEYS.length) return BAD;
  return { path, size, text: checked.text, truncated: checked.truncated, binary: checked.binary };
}

// Host operation -> the documented fields of its success answer (without `ok`).
const ANSWERS = Object.freeze({
  'projects.list': { projects: firstRows(PROJECT_ROW, MAX_PROJECT_ROWS, isGeneral((row) => row.id)), files_supported: flag },
  'team.project.create': { project_id: projectId, name: projectName, channel: flag, folder: optional(flag) },
  'team.project.rename': { project_id: projectId, name: projectName },
  'team.project.delete': {},
  'team.project.members.list': { members: list(record({ member_id: memberId, role: oneOf(PROJECT_ROLES) }),
    LIMITS.MAX_MEMBER_RECORDS) },
  'team.project.members.add': {},
  'team.project.members.setRole': {},
  'team.project.members.remove': {},
  'team.project.leave': {},
  'team.project.unjoined': { projects: firstRows(record({ project_id: projectId, name: nullable(projectName) }),
    MAX_PROJECT_ROWS, isGeneral((row) => row.project_id)) },
  'team.project.join': {},
  'team.project.audit.read': { entries: list(AUDIT_ENTRY, MAX_AUDIT_PAGE), floor_seq: nullable(count),
    next_cursor: nullable(count) },
  // Row 175 wave 5: the reader view. A relative path (at most 1,024 characters, no control character), a page of at
  // most 500 rows, at most 256 KiB of text (one UTF-16 unit per byte read at most, a replacement included).
  'team.project.files.list': { entries: list(record({ path: (value) => (value === '' ? BAD : boundedText(1024)(value)),
    size: count, kind: oneOf(['file', 'dir']) }), 500), next_cursor: nullable(count), total: count, capped: flag },
  // Round 2 (D13): or a picture whole ({ mime, data_base64 }, at most 4 MiB of bytes), or `too_large: true` alone; one
  // shape exactly (`readAnswer`).
  'team.project.files.read': { path: (value) => (value === '' ? BAD : boundedText(1024)(value)), size: count,
    text: optional(is((value) => typeof value === 'string' && value.length <= 256 * 1024)), truncated: optional(flag),
    binary: optional(flag), image: optional(record({ mime: oneOf(PICTURE_TYPES), data_base64: is(isPictureBase64) })),
    too_large: optional(is((value) => value === true)) },
  'sessions.list': { sessions: firstRows(LISTED_CONVERSATION, MAX_CONVERSATION_ROWS, isGeneral((row) => row.project_id)) },
  'sessions.create': { session: CONVERSATION_ROW, revision },
  'sessions.snapshot': { snapshot: checkedSnapshot },
  'session.view': { viewing: flag, viewers: list(memberId, MAX_VIEWERS) },
  'sessions.rename': { revision },
  // Row 172: the conversation's model, effort and tool switches; the snapshot carries the new values.
  'sessions.preferences': { revision },
  'sessions.delete': {},
  'chat.send': { revision, turn_id: optional(wordId) },
  'chat.cancel': {},
  'control.acquire': { lease: (value) => { const lease = LEASE(value); return lease === null ? BAD : lease; } },
  'control.heartbeat': { lease: (value) => { const lease = LEASE(value); return lease === null ? BAD : lease; } },
  'control.release': {},
  'approval.resolve': { revision, always_result: optional(ALWAYS_RESULT) },
  'team.project.rules.list': { project_id: projectId, revision: count, rules: list(RULE, MAX_RULES), open_request_count: count,
    requests: list(RULE_REQUEST, MAX_RULE_REQUESTS), paused: optional(oneOf(['file_tools'])) },
  'team.project.rules.add': { project_id: projectId, rule_seq: positive, revision: count },
  'team.project.rules.answer': { project_id: projectId, request_seq: positive, outcome: oneOf(RULE_OUTCOMES),
    rule_seq: nullable(positive), revision: count },
  'team.project.rules.remove': { project_id: projectId, rule_seq: positive, revision: count },
  'questions.answer': { revision },
  'questions.decline': { revision },
  // Row 175 item 6, F13, F18 (server/command-router-redo.js): ids only.
  // The host's `control_generation` is dropped: the client's `take` after a redo re-acquires that same seat as a
  // heartbeat (server/control-leases.js), and a lease generation never reaches the renderer.
  'team.project.regenerate': { session_id: sessionId, stream_id: optional(wordId), revision },
  'team.project.edit_resend': { session_id: sessionId, stream_id: optional(wordId), revision },
  'team.project.branch': { session_id: sessionId, revision },
  'team.project.ask': {},
  'team.project.hand_driver': { member_id: memberId },
});

/** The host's answer to `operation` as the renderer may see it: rebuilt, a checked failure, or the invalid failure. */
function projectAnswer(operation, answer) {
  if (!Object.hasOwn(ANSWERS, operation)) return invalidRequest(INVALID_REASON);
  if (!answer || answer.ok !== true) return failureAnswer(answer);
  const checked = fields(answer, ANSWERS[operation]);
  if (checked === BAD) return invalidRequest(INVALID_REASON);
  if (operation === 'team.project.files.read') {
    const read = readAnswer(checked);
    return read === BAD ? invalidRequest(INVALID_REASON) : { ok: true, ...read };
  }
  if (operation === 'sessions.list') return { ok: true, sessions: checked.sessions.rows, truncated: checked.sessions.truncated };
  if (operation === 'projects.list' || operation === 'team.project.unjoined') {
    return { ok: true, ...checked, projects: checked.projects.rows, truncated: checked.projects.truncated };
  }
  return { ok: true, ...checked };
}

// A conversation event as the renderer may see it, by host event type; every one names its conversation.
const EVENTS = Object.freeze({
  chat_stream: { session_id: sessionId, stream_id: wordId, event: (value) => {
    if (!isPlainObject(value) || typeof value.type !== 'string' || !KIND_WORD.test(value.type)) return BAD;
    return jsonCopy(MAX_EVENT_BYTES)(value);
  } },
  session_changed: { session_id: sessionId, revision: optional(revision), reason: optional(is((v) => typeof v === 'string'
    && KIND_WORD.test(v))), state: optional(oneOf(['deleted'])) },
  control_changed: { session_id: sessionId, member_id: optional(memberId), expires_at: optional(count),
    state: optional(oneOf(['released'])) },
  decision_changed: { session_id: sessionId, stream_id: wordId, approval_id: optional(boundedText(512)),
    question_ref: optional(boundedText(512)), prompter_member_id: optional(nullable(memberId)),
    approver_member_id: optional(nullable(memberId)), approved: optional(flag) },
  approval_unattended: { session_id: sessionId, stream_id: wordId, approval_id: boundedText(512),
    prompter_member_id: nullable(memberId) },
  // Row 175 F13 (D8): a teammate asked this member to look (project-list.js turns it into the `asked` notice).
  teammate_asked: { session_id: sessionId, project_id: projectId, asker_member_id: memberId, asked_member_id: memberId,
    approval_id: optional(boundedText(512)) },
});

/** A host conversation event, rebuilt; null for a type with no row or a payload that fails it. */
function checkedEvent(type, payload) {
  if (!Object.hasOwn(EVENTS, type)) return null;
  const checked = fields(payload, EVENTS[type]);
  return checked === BAD ? null : checked;
}

// The rule events (slice 3-12's closed types), each forwarded as its own kind with exactly these fields.
const RULE_EVENTS = Object.freeze({
  team_project_rules_changed: { kind: 'rules_changed', spec: { project_id: projectId, revision: count } },
  team_project_rule_requests: { kind: 'rule_requests', spec: { project_id: projectId, open_count: count } },
  team_rule_request_answered: { kind: 'rule_answered', spec: { session_id: sessionId, request_seq: positive,
    outcome: oneOf(RULE_OUTCOMES) } },
});

/** A rule event as its push: { kind, ...fields }; null when it fails its rule; undefined for any other type. */
function checkedRuleEvent(type, payload) {
  if (typeof type !== 'string' || !Object.hasOwn(RULE_EVENTS, type)) return undefined;
  const checked = fields(payload, RULE_EVENTS[type].spec);
  return checked === BAD ? null : { kind: RULE_EVENTS[type].kind, ...checked };
}

/** `team_project_changed`: exactly { project_id, reason }; null otherwise. */
function checkedProjectChange(payload) {
  const checked = fields(payload, { project_id: projectId,
    reason: oneOf(['created', 'renamed', 'members', 'deleting', 'deleted']) });
  return checked === BAD ? null : checked;
}

// What the project list counts (fix 13): only the fields a count needs, read without copying the stream event's
// body. A chat_stream of any other kind answers null before anything is copied. Answers
// { session_id, kind, approval_id? } or null. A `tool_use` counts only as the end of an approval that timed out (it
// carries no decision_changed), so its count leaves with it; any other `tool_use` answers null.
const COUNTED_STREAM = new Set(['started', 'complete', 'error', 'cancelled', 'canceled', 'failed', 'tool_approval_needed', 'tool_use']);
const APPROVAL_ID = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 512 && !CONTROL.test(value);
function countedEvent(type, payload) {
  if (!isPlainObject(payload) || !isSessionId(payload.session_id)) return null;
  if (type === 'chat_stream') {
    const kind = isPlainObject(payload.event) ? payload.event.type : null;
    if (typeof kind !== 'string' || !COUNTED_STREAM.has(kind)) return null;
    if (kind === 'tool_use' && payload.event.status !== 'timeout') return null;
    if (kind !== 'tool_approval_needed' && kind !== 'tool_use') return { session_id: payload.session_id, kind };
    return APPROVAL_ID(payload.event.approval_id) ? { session_id: payload.session_id, kind, approval_id: payload.event.approval_id } : null;
  }
  if (type === 'approval_unattended' || type === 'decision_changed') {
    if (payload.approval_id === undefined && type === 'decision_changed') return null;
    return APPROVAL_ID(payload.approval_id) ? { session_id: payload.session_id, kind: type, approval_id: payload.approval_id } : null;
  }
  return null;
}

module.exports = { FILE_TOOLS_REASONS, checkedEvent, checkedProjectChange, checkedRuleEvent, countedEvent,
  projectAnswer };
