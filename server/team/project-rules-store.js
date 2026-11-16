'use strict';

// The team host's "Always allowed" rules and the requests for them (slice 3-12, TEAM_PROJECTS_SPEC "3-12 as built"):
// `team-project-rules.json` in the team profile, schema 1, read with a 512 KiB cap and written through
// `services/host/durable-json.js` (the file mechanics are bounded-log.js's BoundedLogFile, which takes any document).
//
// Strict load: exact keys at every level, every bound below, and an upgrade step per older version (none yet: version
// 1 is the first). A newer version fails closed and stays as it is; a file refused for its content is set aside at
// start (E46's rule, as the project audit) and a fresh document starts; a broken file is never rewritten in place.
// While the store is unavailable no rule answers anything: a person is asked.
//
// Use counts: a call a rule answered adds to its rule's count in memory (`noteUse`, when the call settles approved).
// The counts are written with the next rule change, at teardown (`flush`), and otherwise on a later use once a minute
// has passed since the last write attempt (no timer). A crash loses every count held since the last write; a clean
// stop writes them. A failed write keeps them and the next attempt waits a minute, so a broken disk costs the turn
// path one attempt a minute.
//
// The store takes no actor and decides no role: team-project-rules.js authorizes, audits first, then commits here.

const { BoundedLogFile } = require('./bounded-log');
const { isId, isSessionId } = require('./ids');
const { hasExactKeys, isCleanText, isCount, isPlainObject, isProjectId } = require('./member-schema');
const { isRuleTool, validateFolder } = require('./project-rules-match');

const PROJECT_RULES_FILE = 'team-project-rules.json';
const PROJECT_RULES_SCHEMA_VERSION = 1;
const PROJECT_RULES_LIMITS = Object.freeze({
  MAX_RULES: 32,
  MAX_OPEN_REQUESTS: 16,
  MAX_ANSWERED_REQUESTS: 32,
  MAX_PROJECTS: 64,
  MAX_REASON_CHARS: 200,
  MAX_BYTES: 512 * 1024,
  USE_WRITE_INTERVAL_MS: 60_000,
});
const REQUEST_STATES = Object.freeze(['open', 'allowed', 'changed', 'declined']);
const DOCUMENT_KEYS = Object.freeze(['schema_version', 'projects']);
const PROJECT_KEYS = Object.freeze(['project_id', 'revision', 'next_rule_seq', 'next_request_seq', 'rules', 'requests']);
const RULE_KEYS = Object.freeze(['rule_seq', 'tool_name', 'folder', 'set_by', 'set_at', 'from_request_seq', 'use_count',
  'last_used_at', 'last_used_by']);
const REQUEST_KEYS = Object.freeze(['request_seq', 'tool_name', 'asker_member_id', 'session_id', 'asked_at', 'state',
  'answered_by', 'answered_at', 'outcome_tool', 'outcome_folder', 'reason', 'rule_seq']);

const isSeq = (value) => Number.isSafeInteger(value) && value >= 1;
const isMember = (value) => isId('member', value);
const isTool = isRuleTool;
const isFolder = (value) => validateFolder(value).ok;
const isNullOr = (check) => (value) => value === null || check(value);

// A decline reason: clean text (NFC, no control, line-separator, invisible or reordering character, no surrounding
// space), 1 to 200 characters. Markup is plain text here; the renderer escapes it.
function isReason(value) {
  return isCleanText(value, PROJECT_RULES_LIMITS.MAX_REASON_CHARS);
}

function validRule(rule, nextSeq) {
  if (!isPlainObject(rule) || !hasExactKeys(rule, RULE_KEYS)) return false;
  return isSeq(rule.rule_seq) && rule.rule_seq < nextSeq && isTool(rule.tool_name) && isFolder(rule.folder)
    && isMember(rule.set_by) && isCount(rule.set_at) && isNullOr(isSeq)(rule.from_request_seq) && isCount(rule.use_count)
    && isNullOr(isCount)(rule.last_used_at) && isNullOr(isMember)(rule.last_used_by)
    && (rule.last_used_at === null) === (rule.last_used_by === null);
}

function validRequest(request, nextSeq) {
  if (!isPlainObject(request) || !hasExactKeys(request, REQUEST_KEYS)) return false;
  if (!isSeq(request.request_seq) || request.request_seq >= nextSeq || !isTool(request.tool_name)
    || !isMember(request.asker_member_id) || !isSessionId(request.session_id) || !isCount(request.asked_at)
    || !REQUEST_STATES.includes(request.state)) return false;
  const answer = [request.answered_by, request.answered_at, request.outcome_tool, request.outcome_folder,
    request.reason, request.rule_seq];
  if (request.state === 'open') return answer.every((value) => value === null);
  if (!isMember(request.answered_by) || !isCount(request.answered_at)) return false;
  if (request.state === 'declined') {
    return request.outcome_tool === null && request.outcome_folder === null && isReason(request.reason)
      && request.rule_seq === null;
  }
  return isTool(request.outcome_tool) && isFolder(request.outcome_folder) && request.reason === null
    && isSeq(request.rule_seq);
}

function validProject(project) {
  if (!isPlainObject(project) || !hasExactKeys(project, PROJECT_KEYS) || !isProjectId(project.project_id)) return false;
  if (!isCount(project.revision) || !isSeq(project.next_rule_seq) || !isSeq(project.next_request_seq)) return false;
  const { rules, requests } = project;
  if (!Array.isArray(rules) || rules.length > PROJECT_RULES_LIMITS.MAX_RULES) return false;
  if (!Array.isArray(requests)) return false;
  if (!rules.every((rule) => validRule(rule, project.next_rule_seq))) return false;
  if (!requests.every((request) => validRequest(request, project.next_request_seq))) return false;
  const open = requests.filter((request) => request.state === 'open');
  if (open.length > PROJECT_RULES_LIMITS.MAX_OPEN_REQUESTS
    || requests.length - open.length > PROJECT_RULES_LIMITS.MAX_ANSWERED_REQUESTS) return false;
  const unique = (values) => new Set(values).size === values.length;
  return unique(rules.map((rule) => rule.rule_seq)) && unique(requests.map((request) => request.request_seq))
    && unique(rules.map((rule) => JSON.stringify([rule.tool_name, rule.folder])))
    && unique(open.map((request) => JSON.stringify([request.asker_member_id, request.tool_name])));
}

function validDocument(doc) {
  if (!isPlainObject(doc) || !hasExactKeys(doc, DOCUMENT_KEYS) || doc.schema_version !== PROJECT_RULES_SCHEMA_VERSION) {
    return false;
  }
  if (!Array.isArray(doc.projects) || doc.projects.length > PROJECT_RULES_LIMITS.MAX_PROJECTS) return false;
  return doc.projects.every(validProject)
    && new Set(doc.projects.map((project) => project.project_id)).size === doc.projects.length;
}

// One step per older version, each to the next; version 1 is the first, so there is none yet. A version this host
// does not know (newer, or not a safe integer) is refused: BoundedLogFile keeps a newer one as it is.
const UPGRADES = Object.freeze({});
function upgradeDocument(stored) {
  let doc = stored;
  while (isPlainObject(doc) && Object.hasOwn(UPGRADES, doc.schema_version)) doc = UPGRADES[doc.schema_version](doc);
  return validDocument(doc) ? doc : null;
}

function emptyDocument() {
  return { schema_version: PROJECT_RULES_SCHEMA_VERSION, projects: [] };
}

function emptyProject(projectId) {
  return { project_id: projectId, revision: 0, next_rule_seq: 1, next_request_seq: 1, rules: [], requests: [] };
}

const refused = (kind, reason) => ({ ok: false, kind, reason });

class ProjectRulesStore {
  constructor({ filePath, clock = Date.now, logger = null, assertSafePath = null, readJson, writeJson } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('ProjectRulesStore requires a filePath.');
    this.filePath = filePath;
    this._clock = clock;
    this._file = new BoundedLogFile({
      filePath, readCapBytes: PROJECT_RULES_LIMITS.MAX_BYTES, parse: upgradeDocument, emptyDocument,
      events: { rejected: 'team_project_rules.rejected', writeFailed: 'team_project_rules.write_failed' },
      logger, assertSafePath, readJson, writeJson,
    });
    // JSON [project, rule_seq] -> { add, at, by }: counts not yet written.
    this._uses = new Map();
    this._lastWriteAt = null;
  }

  // At host start: a file refused for its content is set aside and a fresh document starts. Never throws.
  openAtStart() {
    this._file.load();
    if (this._file.refusal() === 'content') this._file.setAside({ now: this._clock() });
    return this.available();
  }

  available() {
    return this._file.load() !== null;
  }

  // A copy of one project's entry (an empty one when it has none) with the unwritten counts folded in; null while
  // the store is unavailable.
  project(projectId) {
    const doc = this._file.load();
    if (!doc) return null;
    const found = doc.projects.find((project) => project.project_id === projectId);
    const copy = structuredClone(found ?? emptyProject(projectId));
    this._fold(copy);
    return copy;
  }

  // The held rules for one project and tool as frozen { rule_seq, folder } pairs, with no copy of the entry (the
  // port reads this on every write_file / edit_file approval; counts are not needed to match). null while the store
  // is unavailable.
  rulesFor(projectId, toolName) {
    const doc = this._file.load();
    if (!doc) return null;
    const found = doc.projects.find((project) => project.project_id === projectId);
    return Object.freeze((found?.rules ?? []).filter((rule) => rule.tool_name === toolName)
      .map((rule) => Object.freeze({ rule_seq: rule.rule_seq, folder: rule.folder })));
  }

  projectIds() {
    const doc = this._file.load();
    return doc ? doc.projects.map((project) => project.project_id) : null;
  }

  _fold(project) {
    for (const rule of project.rules) {
      const use = this._uses.get(JSON.stringify([project.project_id, rule.rule_seq]));
      if (!use) continue;
      rule.use_count = Math.min(Number.MAX_SAFE_INTEGER, rule.use_count + use.add);
      rule.last_used_at = use.at;
      rule.last_used_by = use.by;
    }
  }

  // Writes the projects with every unwritten count folded in (a dry run checks and writes nothing). Answers
  // { ok: true } or the refusal: a document the rules refuse, one over 512 KiB, or a failed write.
  _write(projects, dryRun = false) {
    projects.forEach((project) => this._fold(project));
    const candidate = { schema_version: PROJECT_RULES_SCHEMA_VERSION, projects };
    // A 65th project with rules is a limit, not a broken document.
    if (projects.length > PROJECT_RULES_LIMITS.MAX_PROJECTS) return refused('limit', 'team_rules_full');
    if (!validDocument(candidate)) return refused('invalid', 'team_rules_invalid');
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PROJECT_RULES_LIMITS.MAX_BYTES) {
      return refused('limit', 'team_rules_full');
    }
    if (dryRun) return { ok: true };
    if (!this._file.persist(candidate)) return refused('unavailable', 'team_rules_unavailable');
    this._uses.clear();
    this._lastWriteAt = this._clock();
    return { ok: true };
  }

  // Runs `change(project)` on a copy of one project's entry and writes the document. `change` answers
  // { ok: false, kind, reason } to refuse (nothing written), { drop: true } to remove the project's entry, or any
  // other object (written, revision bumped). Answers what `change` answered, or a refusal of the write. `dryRun`
  // checks the same document and writes nothing (the caller audits between the two).
  commit(projectId, change, { dryRun = false } = {}) {
    const doc = this._file.load();
    if (!doc) return refused('unavailable', 'team_rules_unavailable');
    const projects = structuredClone(doc.projects);
    const index = projects.findIndex((project) => project.project_id === projectId);
    const project = index >= 0 ? projects[index] : emptyProject(projectId);
    const outcome = change(project);
    if (!outcome || outcome.ok === false) return outcome ?? refused('invalid', 'team_rules_invalid');
    if (outcome.drop) {
      if (index < 0) return { ok: true, ...outcome };
      projects.splice(index, 1);
    } else {
      project.revision += 1;
      if (index < 0) projects.push(project);
    }
    const written = this._write(projects, dryRun);
    return written.ok ? { ok: true, ...outcome, revision: outcome.drop ? null : project.revision } : written;
  }

  // Drops entries for any project `keep` refuses (start-time reconcile). Answers how many went, or null.
  prune(keep) {
    const doc = this._file.load();
    if (!doc) return null;
    const projects = structuredClone(doc.projects.filter((project) => keep(project.project_id)));
    const gone = doc.projects.length - projects.length;
    if (gone === 0) return 0;
    return this._write(projects).ok ? gone : null;
  }

  // One rule-answered call. Written now only when the last write attempt is a minute old or more; a failed attempt
  // counts, so a broken disk is tried once a minute (the write logs its own failure) and the counts stay held.
  noteUse(projectId, ruleSeq, memberId) {
    const key = JSON.stringify([projectId, ruleSeq]);
    const now = this._clock();
    const held = this._uses.get(key);
    this._uses.set(key, { add: (held?.add ?? 0) + 1, at: now, by: memberId });
    if (this._lastWriteAt === null) this._lastWriteAt = now;
    else if (now - this._lastWriteAt >= PROJECT_RULES_LIMITS.USE_WRITE_INTERVAL_MS) {
      this._lastWriteAt = now;
      this.flush();
    }
  }

  // Writes the unwritten counts (teardown, and the once-a-minute rule). A failure keeps them for the next write.
  flush() {
    if (this._uses.size === 0) return { ok: true };
    const doc = this._file.load();
    if (!doc) return refused('unavailable', 'team_rules_unavailable');
    return this._write(structuredClone(doc.projects));
  }
}

module.exports = { PROJECT_RULES_FILE, PROJECT_RULES_LIMITS, ProjectRulesStore, upgradeDocument, validDocument };
