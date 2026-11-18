'use strict';

// Bounded, append-only audit of what happened inside shared projects
// (TEAM_PROJECTS_SPEC, Approvals and Audit log): team-project-audit.json,
// schema 4, read with a 4 MiB cap and written through
// `services/host/durable-json.js`. The strict load, the file and `floor_seq`
// are the shared mechanics in `bounded-log.js`; the bound is the share below.
//
// The store takes no actor: the caller authorizes before it calls (as with
// `getProject` in the member store), and every read names one project.
//
// Entries hold ids, a tool id, a decision and a closed record of numbers. No
// field can hold a path, a prompt, a file name, a display name or free text.
// Schema 3 (team boards, plan PROJECT_BOARD_2026-11-13 section 8.6) adds one
// key, `board_id`, set only by the six board kinds and null on every other.
// Schema 4 (row 175 item 11) adds three optional keys, each null on every kind
// that does not name it and on every older entry: `approval_id` (the backend's
// scoped approval id) and `call_id` (the tool call it belongs to) on the three
// approval kinds, `call_id` on `question_answered`, and `plan_decision` (one of
// three words, exit_plan_mode only) on a decided or not-applied approval. An id
// is a bounded printable word; no answer, question or feedback text has a key.
// Each kind states which keys must be set and which must be null (the table
// below); an entry that breaks its kind's rule is refused with a TypeError and
// nothing is written.
//
// Audit first: `append` answers `{ ok: true, seq }` only after the entry is
// durable. A failed write answers `team_audit_unavailable` and nothing advances,
// so a caller that requires audit-first can refuse its decision. A broken file
// (corrupt, unknown key or kind, newer schema) makes the store unavailable and
// is never rewritten; a passing read failure (a busy or locked file) answers
// unavailable for that call only. Appends are serialized by construction: each
// one is a single synchronous durable write, so two appends in one tick take
// consecutive seqs and both land.
//
// The share (review round two, R15-F01): the log is bounded overall, but one
// project's churn cannot push another project's entries out. Past a bound,
// entries of a project with no live team row go first (no one can read them),
// then the oldest entry of the live project holding the most entries (a tie:
// the one whose oldest entry is oldest). So a project loses an entry only while
// it holds at least as many as any other, and keeps at least its share of the
// bound (10,000 over at most 64 live projects). A drop out of the log's order
// is recorded as that project's own floor (`project_floors`, schema 2): every
// entry of it below that seq is gone. A read answers the higher of the two.

const { isBoardId } = require('../../services/boards/board-ids');
const { hostFailure } = require('../api-contract');
const { BoundedLogFile, emptyLogDocument, validLogDocument } = require('./bounded-log');
const { isId, isSessionId } = require('./ids');
const {
  hasExactKeys, isCount, isPlainObject, isProjectId,
} = require('./member-schema');

const PROJECT_AUDIT_FILE = 'team-project-audit.json';
// Schema 1 (no `project_floors`), schema 2 (no `board_id` on an entry) and schema 3 (no `approval_id`, `call_id` or
// `plan_decision`) are read and upgraded in memory; the next append writes schema 4.
const PROJECT_AUDIT_SCHEMA_VERSION = 4;
const PROJECT_AUDIT_LIMITS = Object.freeze({
  MAX_ENTRIES: 10_000,
  MAX_BYTES: 4 * 1024 * 1024,
  MAX_PAGE: 100,
  MAX_TOOL_NAME_CHARS: 64,
  // Live projects are at most 64 (member-schema.js); a host with no liveness check keeps more.
  MAX_PROJECT_FLOORS: 256,
  // Schema 4: an approval id holds a session id, a stream id and a call id (the bound decision-adapter.js reads).
  MAX_APPROVAL_ID_CHARS: 512,
  MAX_CALL_ID_CHARS: 128,
});
// A key rule's third value (schema 4): the key may be null or a valid value.
const OPTIONAL = 'optional';
// The keys each schema added to an entry, so an older entry is lifted with them null.
const ADDED_KEYS = Object.freeze([[3, 'board_id'], [4, 'approval_id'], [4, 'call_id'], [4, 'plan_decision']]);
const APPROVAL_IDS = Object.freeze({ approval_id: OPTIONAL, call_id: OPTIONAL });

function ruleKind(session, detail) {
  return Object.freeze({ session_id: session, board_id: false, actor_member_id: true, prompter_member_id: false,
    tool_name: true, decision: false, detail: Object.freeze(detail) });
}

// A board kind: the board and the acting member are always set, and there is no tool and no decision word.
// `proposal`: Jenny's proposed changes, decided by a member; it also names the conversation the proposal
// came from and the member whose turn produced it.
function boardKind(detail, proposal = false) {
  return Object.freeze({ session_id: proposal, board_id: true, actor_member_id: true, prompter_member_id: proposal,
    tool_name: false, decision: false, detail: detail === null ? null : Object.freeze(detail) });
}

// `true`: the key must be set; `false` (or absent): it must be null; OPTIONAL: either. `detail` names the
// exact numeric keys of the kind's detail record, or null for no detail.
// `approval_expired` means "ended unanswered by a timeout": the approval's own 10-minute wait, or the
// turn's timeout that ended the wait (the backend reports both as `timeout`).
const PROJECT_AUDIT_KIND_RULES = Object.freeze({
  approval_decided: Object.freeze({
    session_id: true, board_id: false, actor_member_id: true, prompter_member_id: true, tool_name: true, decision: true,
    ...APPROVAL_IDS, plan_decision: OPTIONAL, detail: null,
  }),
  approval_not_applied: Object.freeze({
    session_id: true, board_id: false, actor_member_id: true, prompter_member_id: true, tool_name: true, decision: true,
    ...APPROVAL_IDS, plan_decision: OPTIONAL, detail: Object.freeze(['ref_seq']),
  }),
  approval_expired: Object.freeze({
    session_id: true, board_id: false, actor_member_id: false, prompter_member_id: true, tool_name: true,
    decision: false, ...APPROVAL_IDS, detail: null,
  }),
  // Schema 4: a member answered Jenny's questions (the answering member, the turn's prompter when the turn has a member
  // author, the question's call id). No question, option or answer text is in any key.
  question_answered: Object.freeze({
    session_id: true, board_id: false, actor_member_id: true, prompter_member_id: OPTIONAL, tool_name: false,
    decision: false, call_id: OPTIONAL, detail: null,
  }),
  files_uploaded: Object.freeze({
    session_id: false, board_id: false, actor_member_id: true, prompter_member_id: false, tool_name: false,
    decision: false, detail: Object.freeze(['files', 'bytes', 'skipped']),
  }),
  files_downloaded: Object.freeze({
    session_id: false, board_id: false, actor_member_id: true, prompter_member_id: false, tool_name: false,
    decision: false, detail: Object.freeze(['files', 'bytes', 'skipped']),
  }),
  // Slice 3-12 (team-project-rules.js): "Always allowed" rules and the requests for them. The folder and a decline
  // reason live only in team-project-rules.json; an entry names the tool, the actor and the rule or request number.
  rule_added: ruleKind(false, ['rule_seq']),
  rule_requested: ruleKind(true, ['request_seq']),
  rule_request_allowed: ruleKind(false, ['request_seq', 'rule_seq']),
  rule_request_changed: ruleKind(false, ['request_seq', 'rule_seq']),
  rule_request_declined: ruleKind(false, ['request_seq']),
  rule_removed: ruleKind(false, ['rule_seq']),
  // Slice 3-13: the local `team-copy-in` command on a stopped headless host, written before the copy. The actor
  // is the local command, which is no member id, so it is null; the detail is what the copy was admitted with.
  files_copied_in: Object.freeze({
    session_id: false, board_id: false, actor_member_id: false, prompter_member_id: false, tool_name: false,
    decision: false, detail: Object.freeze(['files', 'bytes']),
  }),
  // Team boards (row 151 slice T5), each written before the change it names. A proposal decision carries the
  // change's number in the proposal (`change`, 0 for "every pending one") and how many changes it covers
  // (`count`). A revert names the revision of the batch it takes back; a bulk removal, how many items a
  // batch removes (20 or more). What was on the board is in no entry.
  board_proposal_accepted: boardKind(['change', 'count'], true),
  board_proposal_rejected: boardKind(['change', 'count'], true),
  board_deleted: boardKind(null),
  board_restored: boardKind(null),
  board_batch_reverted: boardKind(['rev']),
  board_bulk_removed: boardKind(['items']),
});
// Not the membership log's `PROJECT_AUDIT_KINDS` (audit-log.js), a different list.
const PROJECT_AUDIT_ENTRY_KINDS = Object.freeze(Object.keys(PROJECT_AUDIT_KIND_RULES));
const DECISIONS = Object.freeze(['approved', 'denied']);
// exit_plan_mode's decisions a team member may give (server/api-contract.js `approval.resolve`).
const PLAN_DECISIONS = Object.freeze(['approved', 'accepted', 'rejected']);

const ENTRY_KEYS = Object.freeze(['seq', 'at', 'kind', 'project_id', 'session_id', 'board_id', 'actor_member_id',
  'prompter_member_id', 'tool_name', 'decision', 'approval_id', 'call_id', 'plan_decision', 'detail']);
const INPUT_KEYS = Object.freeze(ENTRY_KEYS.filter((key) => key !== 'seq' && key !== 'at'));

// A built-in tool id: lower case, digits and underscores. No dot, slash, space
// or upper case, so no path, file name, sentence or display name fits. Team
// mode has no third-party MCP tools (AGENTS.md, team hosting boundary).
const TOOL_NAME_PATTERN = new RegExp(`^[a-z][a-z0-9_]{0,${PROJECT_AUDIT_LIMITS.MAX_TOOL_NAME_CHARS - 1}}$`, 'u');
// Schema 4: an approval or tool call id, a printable word with no space or slash.
const idWord = (max) => {
  const pattern = new RegExp(`^[A-Za-z0-9_.:-]{1,${max}}$`, 'u');
  return (value) => typeof value === 'string' && pattern.test(value);
};
const isAuditApprovalId = idWord(PROJECT_AUDIT_LIMITS.MAX_APPROVAL_ID_CHARS);
const isAuditCallId = idWord(PROJECT_AUDIT_LIMITS.MAX_CALL_ID_CHARS);

const FIELD_CHECKS = Object.freeze({
  session_id: isSessionId,
  board_id: isBoardId,
  actor_member_id: (value) => isId('member', value),
  prompter_member_id: (value) => isId('member', value),
  tool_name: (value) => typeof value === 'string' && TOOL_NAME_PATTERN.test(value),
  decision: (value) => DECISIONS.includes(value),
  approval_id: isAuditApprovalId,
  call_id: isAuditCallId,
  plan_decision: (value) => PLAN_DECISIONS.includes(value),
});

// One key against its kind's rule: set and valid, null, or (OPTIONAL) either.
function fieldPasses(want, value, check) {
  if (want === OPTIONAL) return value === null || check(value);
  return want ? check(value) : value === null;
}

function validDetail(entry, keys) {
  if (keys === null) return entry.detail === null;
  const { detail } = entry;
  if (!isPlainObject(detail) || !hasExactKeys(detail, keys) || !keys.every((key) => isCount(detail[key]))) return false;
  // `ref_seq` names an earlier entry of this log.
  return !keys.includes('ref_seq') || (detail.ref_seq >= 1 && detail.ref_seq < entry.seq);
}

function validEntry(entry) {
  if (!isPlainObject(entry) || !hasExactKeys(entry, ENTRY_KEYS)) return false;
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || !isCount(entry.at)) return false;
  const rule = Object.prototype.hasOwnProperty.call(PROJECT_AUDIT_KIND_RULES, entry.kind)
    ? PROJECT_AUDIT_KIND_RULES[entry.kind] : null;
  if (!rule || !isProjectId(entry.project_id)) return false;
  for (const [key, check] of Object.entries(FIELD_CHECKS)) {
    if (!fieldPasses(rule[key], entry[key], check)) return false;
  }
  return validDetail(entry, rule.detail);
}

const validBase = (doc, schemaVersion) => validLogDocument(doc, {
  schemaVersion, maxEntries: PROJECT_AUDIT_LIMITS.MAX_ENTRIES, validEntry,
});

// Each floor is above the log's own and at most `next_seq`, and no kept entry of its project lies below it.
function validFloors(floors, doc) {
  if (!isPlainObject(floors)) return false;
  const keys = Object.keys(floors);
  if (keys.length > PROJECT_AUDIT_LIMITS.MAX_PROJECT_FLOORS) return false;
  if (!keys.every((key) => isProjectId(key) && Number.isSafeInteger(floors[key]) && floors[key] > doc.floor_seq
    && floors[key] <= doc.next_seq)) return false;
  return doc.entries.every((entry) => !Object.hasOwn(floors, entry.project_id) || entry.seq >= floors[entry.project_id]);
}

// An entry of an older schema gains each key a later schema added, null (`board_id` before schema 3; `approval_id`,
// `call_id` and `plan_decision` before schema 4). One that already has such a key is not of its file's schema: it
// becomes null, which no entry check passes, so the file is refused.
function liftEntries(entries, version) {
  const keys = ADDED_KEYS.filter(([since]) => version < since).map(([, key]) => key);
  if (!Array.isArray(entries) || keys.length === 0) return entries;
  const nulls = Object.fromEntries(keys.map((key) => [key, null]));
  return entries.map((entry) => (isPlainObject(entry) && keys.every((key) => !Object.hasOwn(entry, key))
    ? { ...entry, ...nulls } : null));
}

// The document to hold, or null to refuse the file. A schema 1 file is upgraded with no project floors, and a
// schema 1, 2 or 3 file with each key a later schema added null on every entry. A newer schema is refused.
function parseDocument(stored) {
  if (!isPlainObject(stored)) return null;
  const version = stored.schema_version;
  if (version === 1) {
    const lifted = { ...stored, entries: liftEntries(stored.entries, 1) };
    return validBase(lifted, 1) ? { ...lifted, schema_version: PROJECT_AUDIT_SCHEMA_VERSION, project_floors: {} } : null;
  }
  if (!Object.hasOwn(stored, 'project_floors')) return null;
  const { project_floors: floors, ...rest } = stored;
  const older = version === 2 || version === 3;
  const base = older ? { ...rest, entries: liftEntries(rest.entries, version) } : rest;
  if (!validBase(base, older ? version : PROJECT_AUDIT_SCHEMA_VERSION) || !validFloors(floors, base)) return null;
  return older ? { ...base, schema_version: PROJECT_AUDIT_SCHEMA_VERSION, project_floors: floors } : stored;
}

function emptyDocument() {
  return { ...emptyLogDocument(PROJECT_AUDIT_SCHEMA_VERSION), project_floors: {} };
}

// The droppable entry to drop next: the oldest of a dead project, else the oldest of the live project holding the
// most (a tie: the oldest such entry). `queues` maps a project to the indexes of its kept entries, oldest first,
// with `head` the first kept one; the newest entry (`last`) is never dropped.
function nextDrop(queues, last, live) {
  let pick = null;
  for (const [projectId, queue] of queues) {
    const index = queue.list[queue.head];
    if (index === undefined || index === last) continue;
    const count = queue.list.length - queue.head;
    const dead = !live(projectId);
    if (pick === null || (dead && !pick.dead) || (dead === pick.dead && (dead ? index < pick.index
      : count > pick.count || (count === pick.count && index < pick.index)))) pick = { projectId, index, count, dead };
  }
  return pick;
}

// Drops entries until the candidate fits both bounds (the share rule above), and records the floors. Returns the
// candidate itself when it already fits. `live(projectId)` is false for a project with no live team row.
function boundShared(candidate, { maxEntries, maxBytes }, isLive) {
  const { entries } = candidate;
  const seen = new Map();
  const live = (projectId) => {
    if (!seen.has(projectId)) seen.set(projectId, isLive(projectId));
    return seen.get(projectId);
  };
  const sizes = entries.map((entry) => Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1);
  let size = sizes.reduce((sum, value) => sum + value, 0);
  const header = (floorSeq, floors) => Buffer.byteLength(JSON.stringify({ ...candidate, floor_seq: floorSeq,
    project_floors: floors, entries: [] }), 'utf8');
  if (entries.length <= maxEntries && header(candidate.floor_seq, candidate.project_floors) + size <= maxBytes) return candidate;
  const queues = new Map();
  entries.forEach((entry, index) => {
    if (!queues.has(entry.project_id)) queues.set(entry.project_id, { list: [], head: 0 });
    queues.get(entry.project_id).list.push(index);
  });
  const dropped = new Uint8Array(entries.length);
  const last = entries.length - 1;
  let kept = entries.length;
  let first = 0;
  let floorSeq = candidate.floor_seq;
  let floors = { ...candidate.project_floors };
  const prune = () => {
    floors = Object.fromEntries(Object.entries(floors).filter(([projectId, seq]) => seq > floorSeq && live(projectId)));
  };
  while (kept > 1 && (kept > maxEntries || header(floorSeq, floors) + size > maxBytes)) {
    const pick = nextDrop(queues, last, live);
    if (pick === null) break;
    queues.get(pick.projectId).head += 1;
    dropped[pick.index] = 1;
    kept -= 1;
    size -= sizes[pick.index];
    if (pick.index === first) {
      while (dropped[first]) first += 1;
      floorSeq = entries[first].seq;
    } else if (!pick.dead) {
      floors[pick.projectId] = entries[pick.index].seq + 1;
    }
    prune();
  }
  // Past the floor cap, the lowest floor is forgotten (that project's read then answers the log's own floor).
  const order = Object.entries(floors).sort((a, b) => a[1] - b[1]);
  floors = Object.fromEntries(order.slice(Math.max(0, order.length - PROJECT_AUDIT_LIMITS.MAX_PROJECT_FLOORS)));
  return { ...candidate, floor_seq: floorSeq, entries: entries.filter((_entry, index) => !dropped[index]),
    project_floors: floors };
}

function copyEntry(entry) {
  return { ...entry, detail: entry.detail === null ? null : { ...entry.detail } };
}

function unavailable() {
  return hostFailure('unavailable', 'team_audit_unavailable');
}

// A bound is a safe integer of at least 1, clamped to its limit.
function bound(value, limit, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`ProjectAudit ${name} must be a positive integer.`);
  return Math.min(value, limit);
}

// Builds the stored entry from a caller's input. Unknown keys are refused;
// an omitted key is null, and the kind rule then decides.
function buildEntry(input, seq, at) {
  if (!isPlainObject(input) || !Object.keys(input).every((key) => INPUT_KEYS.includes(key))) {
    throw new TypeError('Invalid project audit entry.');
  }
  const entry = { seq, at };
  for (const key of INPUT_KEYS) entry[key] = input[key] ?? null;
  if (isPlainObject(entry.detail)) entry.detail = { ...entry.detail };
  if (!validEntry(entry)) throw new TypeError('Invalid project audit entry.');
  return entry;
}

class ProjectAudit {
  constructor({
    filePath, clock = Date.now, logger = null, assertSafePath = null, readJson, writeJson,
    maxEntries = PROJECT_AUDIT_LIMITS.MAX_ENTRIES, maxBytes = PROJECT_AUDIT_LIMITS.MAX_BYTES, liveProject = null,
  } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('ProjectAudit requires a filePath.');
    this.filePath = filePath;
    this._clock = clock;
    // `liveProject(projectId)`: false for a project with no live team row (its entries go first). Absent, or on any
    // doubt (it throws), every project counts as live.
    this._live = (projectId) => {
      try {
        return typeof liveProject !== 'function' || liveProject(projectId) !== false;
      } catch {
        return true;
      }
    };
    this._maxEntries = bound(maxEntries, PROJECT_AUDIT_LIMITS.MAX_ENTRIES, 'maxEntries');
    this._maxBytes = bound(maxBytes, PROJECT_AUDIT_LIMITS.MAX_BYTES, 'maxBytes');
    this._file = new BoundedLogFile({
      filePath,
      readCapBytes: PROJECT_AUDIT_LIMITS.MAX_BYTES,
      parse: parseDocument,
      emptyDocument,
      events: { rejected: 'team_project_audit.rejected', writeFailed: 'team_project_audit.write_failed' },
      logger,
      assertSafePath,
      readJson,
      writeJson,
    });
  }

  limits() {
    return { maxEntries: this._maxEntries, maxBytes: this._maxBytes };
  }

  // At host start (E46's rule for this log, slice 3-4b): a file refused for its content is renamed
  // aside with the shared stamp and a fresh log starts; a newer schema, an unsafe path, an OS refusal
  // and a busy file stay as they are. Answers { setAside, keptName }; never throws. Called by the team
  // host's start before any command (server/team/team-approvals.js `open`, slice 3-6b).
  openAtStart() {
    this._file.load();
    if (this._file.refusal() !== 'content') return { setAside: false, keptName: null };
    const moved = this._file.setAside({ now: this._clock() });
    return moved.ok ? { setAside: true, keptName: moved.keptName } : { setAside: false, keptName: null };
  }

  floorSeq() {
    const doc = this._file.load();
    return doc ? doc.floor_seq : null;
  }

  // Appends one entry in one durable write. Throws a TypeError for an entry
  // that breaks its kind's rule (a caller bug); answers team_audit_unavailable
  // when the log is broken, the clock does not give a time or the write fails.
  append(input) {
    const doc = this._file.load();
    if (!doc) return unavailable();
    const at = this._clock();
    if (!isCount(at)) return unavailable();
    const entry = buildEntry(input, doc.next_seq, at);
    const candidate = boundShared({
      schema_version: PROJECT_AUDIT_SCHEMA_VERSION,
      floor_seq: doc.floor_seq,
      next_seq: entry.seq + 1,
      entries: [...doc.entries, entry],
      project_floors: doc.project_floors,
    }, this.limits(), this._live);
    if (!this._file.persist(candidate)) return unavailable();
    return { ok: true, seq: entry.seq };
  }

  // A page of at most 100 entries of one project, oldest first, with seq
  // greater than `afterSeq`. `projectId` is required: no reader is entitled to
  // every project's entries (E30, E31). `next` is the cursor for the following
  // page, or null when nothing is left. `floor_seq` is the higher of the log's
  // floor and the project's own.
  read({ afterSeq = 0, limit = PROJECT_AUDIT_LIMITS.MAX_PAGE, projectId } = {}) {
    if (!isCount(afterSeq) || !Number.isSafeInteger(limit) || limit < 1 || !isProjectId(projectId)) {
      return hostFailure('invalid', 'team_cursor_invalid');
    }
    const doc = this._file.load();
    if (!doc) return unavailable();
    const size = Math.min(limit, PROJECT_AUDIT_LIMITS.MAX_PAGE);
    const page = [];
    let more = false;
    for (const entry of doc.entries) {
      if (entry.seq <= afterSeq || entry.project_id !== projectId) continue;
      if (page.length === size) {
        more = true;
        break;
      }
      page.push(copyEntry(entry));
    }
    return {
      ok: true,
      entries: page,
      floor_seq: Math.max(doc.floor_seq, Object.hasOwn(doc.project_floors, projectId) ? doc.project_floors[projectId] : 0),
      next: more ? page[page.length - 1].seq : null,
    };
  }
}

module.exports = {
  PROJECT_AUDIT_FILE, PROJECT_AUDIT_SCHEMA_VERSION, PROJECT_AUDIT_LIMITS, PROJECT_AUDIT_ENTRY_KINDS,
  PROJECT_AUDIT_KIND_RULES, PLAN_DECISIONS, ProjectAudit, isAuditApprovalId, isAuditCallId,
};
