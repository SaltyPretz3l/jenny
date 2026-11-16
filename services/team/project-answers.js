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

const PENDING_APPROVAL = (value) => {
  const checked = fields(value, { approval_id: boundedText(512), decision_revision: wordId, stream_id: wordId,
    tool_name: boundedText(128), prompter_member_id: optional(nullable(memberId)) });
  if (checked === BAD) return BAD;
  const rest = jsonCopy(MAX_PART_BYTES)({ call_id: value.call_id, summary: value.summary, policy_scope: value.policy_scope,
    policy_consequence: value.policy_consequence, reason: value.reason });
  return rest === BAD ? BAD : { ...rest, ...checked, prompter_member_id: checked.prompter_member_id ?? null };
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

/** The snapshot of `sessions.snapshot`, rebuilt; BAD when it fails a rule. */
function checkedSnapshot(value) {
  const checked = fields(value, {
    cursor: count,
    session: record({ session_id: sessionId, title, revision, plan_mode: flag }),
    messages: list(MESSAGE, 100),
    message_count: count,
    has_more: flag,
    next_before_message_id: optional(boundedText(256)),
    active_turn: nullable(jsonCopy(MAX_PART_BYTES)),
    pending_approvals: list(PENDING_APPROVAL, 64),
    pending_questions: list(PENDING_QUESTIONS, 64),
    live_projection: optional(nullable(jsonCopy(MAX_PART_BYTES))),
    control: optional(LEASE),
  });
  if (checked === BAD) return BAD;
  return { ...checked, live_projection: checked.live_projection ?? null, control: checked.control ?? null };
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
  'sessions.list': { sessions: firstRows(CONVERSATION_ROW, MAX_CONVERSATION_ROWS, isGeneral((row) => row.project_id)) },
  'sessions.create': { session: CONVERSATION_ROW, revision },
  'sessions.snapshot': { snapshot: checkedSnapshot },
  'session.view': { viewing: flag, viewers: list(memberId, MAX_VIEWERS) },
  'sessions.rename': { revision },
  'sessions.delete': {},
  'chat.send': { revision, turn_id: optional(wordId) },
  'chat.cancel': {},
  'control.acquire': { lease: (value) => { const lease = LEASE(value); return lease === null ? BAD : lease; } },
  'control.heartbeat': { lease: (value) => { const lease = LEASE(value); return lease === null ? BAD : lease; } },
  'control.release': {},
  'approval.resolve': { revision, always_result: optional(ALWAYS_RESULT) },
  'team.project.rules.list': { project_id: projectId, revision: count, rules: list(RULE, MAX_RULES), open_request_count: count,
    requests: list(RULE_REQUEST, MAX_RULE_REQUESTS) },
  'team.project.rules.add': { project_id: projectId, rule_seq: positive, revision: count },
  'team.project.rules.answer': { project_id: projectId, request_seq: positive, outcome: oneOf(RULE_OUTCOMES),
    rule_seq: nullable(positive), revision: count },
  'team.project.rules.remove': { project_id: projectId, rule_seq: positive, revision: count },
  'questions.answer': { revision },
  'questions.decline': { revision },
});

/** The host's answer to `operation` as the renderer may see it: rebuilt, a checked failure, or the invalid failure. */
function projectAnswer(operation, answer) {
  if (!Object.hasOwn(ANSWERS, operation)) return invalidRequest(INVALID_REASON);
  if (!answer || answer.ok !== true) return failureAnswer(answer);
  const checked = fields(answer, ANSWERS[operation]);
  if (checked === BAD) return invalidRequest(INVALID_REASON);
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
// { session_id, kind, approval_id? } or null.
const COUNTED_STREAM = new Set(['started', 'complete', 'error', 'cancelled', 'canceled', 'failed', 'tool_approval_needed']);
const APPROVAL_ID = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 512 && !CONTROL.test(value);
function countedEvent(type, payload) {
  if (!isPlainObject(payload) || !isSessionId(payload.session_id)) return null;
  if (type === 'chat_stream') {
    const kind = isPlainObject(payload.event) ? payload.event.type : null;
    if (typeof kind !== 'string' || !COUNTED_STREAM.has(kind)) return null;
    if (kind !== 'tool_approval_needed') return { session_id: payload.session_id, kind };
    return APPROVAL_ID(payload.event.approval_id) ? { session_id: payload.session_id, kind, approval_id: payload.event.approval_id } : null;
  }
  if (type === 'approval_unattended' || type === 'decision_changed') {
    if (payload.approval_id === undefined && type === 'decision_changed') return null;
    return APPROVAL_ID(payload.approval_id) ? { session_id: payload.session_id, kind: type, approval_id: payload.approval_id } : null;
  }
  return null;
}

module.exports = { checkedEvent, checkedProjectChange, checkedRuleEvent, countedEvent, projectAnswer };
