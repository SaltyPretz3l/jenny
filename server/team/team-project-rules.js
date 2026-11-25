'use strict';

// "Always allowed" rules for a team project, on the host (slice 3-12, E66; TEAM_PROJECTS_SPEC "3-12 as built").
// Built once by team-main.js. It owns:
// - the store (project-rules-store.js), opened at start: a file refused for its content is set aside, entries of a
//   project with no team row are dropped (the start-time reconcile), and a store that cannot be read leaves every
//   approval to a person;
// - the commands `team.project.rules.list|add|answer|remove` (the router's identity check already passed the
//   registry row; every handler reads the caller's role again before it changes anything);
// - the two `approval.resolve` extras (`always: 'rule' | 'ask'`) through `decisions`, which the decision handlers
//   reach on the approvals object (`withApprovals`);
// - the backend port `teamProjectRules.match` / `.used`, consulted by services/backend/team-rule-gate.js beside
//   Full auto (`used` counts a call only once it settled approved);
// - the events and the cleanup on project delete and member removal.
//
// Audit first (E10): the project audit entry, then the rules file. A crash between leaves an entry with no change,
// never a change with no entry. Audit entries carry ids, the tool and numbers; the folder and the reason live only
// in the rules file. Every change runs with no await between its role read and its write, so nothing can come
// between them. Logs carry event names, ids, counts and reasons only.

const path = require('node:path');

const { hostFailure } = require('../api-contract');
const { PROJECT_BUCKET, RULE_ANSWERED_EVENT, RULE_REQUESTS_EVENT, RULES_CHANGED_EVENT } = require('./event-scope');
const { isId } = require('./ids');
const { GENERAL_PROJECT_ID, isInputText } = require('./member-schema');
const { effectiveProjectRole, projectAudience, roleAtLeast } = require('./project-visibility');
const { folderCovers, isRuleTool, ruleTarget, validateFolder } = require('./project-rules-match');
const { PROJECT_RULES_FILE, PROJECT_RULES_LIMITS: LIMITS, ProjectRulesStore } = require('./project-rules-store');
const { safeLogger } = require('./safe-logger');
const { turnStarter } = require('./turn-starter');

const READS = new Set(['team.project.rules.list']);
const OUTCOMES = Object.freeze({ allow: 'allowed', change: 'changed', decline: 'declined' });
// What each answer outcome may carry besides project_id, request_seq and outcome.
const ANSWER_FIELDS = Object.freeze({ allow: [], change: ['tool_name', 'folder'], decline: ['reason'] });

const fail = (kind, reason) => hostFailure(kind, reason);
// A store refusal ({ ok: false, kind, reason }) as a command answer.
const failOf = (refusal) => hostFailure(refusal.kind, refusal.reason);
const unavailable = () => fail('unavailable', 'team_rules_unavailable');

/**
 * userDataPath: the team profile. directory: the member directory. approvals: team-approvals.js (its `append`
 * and `projectOf`). serialized: the project commands' chain. publish(type, payload, options): lazy.
 * backend(): the backend, lazily (turn starter, project roots). platform: the host's, for path forms.
 */
function createTeamProjectRules({
  userDataPath, directory, approvals, serialized = (fn) => Promise.resolve().then(fn), publish = () => {},
  backend = () => null, clock = Date.now, logger = null, assertSafePath = null, platform = process.platform,
  createStore = (options) => new ProjectRulesStore(options),
} = {}) {
  if (!directory || typeof directory.memberActor !== 'function') throw new TypeError('createTeamProjectRules requires a directory.');
  if (!approvals || typeof approvals.append !== 'function' || typeof approvals.projectOf !== 'function') {
    throw new TypeError('createTeamProjectRules requires the approvals.');
  }
  const log = safeLogger(logger);
  let rules = null;
  try {
    rules = createStore({ filePath: path.join(userDataPath, PROJECT_RULES_FILE), clock, logger, assertSafePath });
  } catch {
    rules = null;
  }
  const project = (projectId) => (rules ? rules.project(projectId) : null);

  // Row 123 (D5) and OD-2: with project files on, the rule gate answers nothing, so the rules are paused: the list says
  // so, and no rule changes and no request is filed meanwhile (the reason is the unavailable one: every approval asks a person).
  function pausedReason() {
    try { return backend()?.hostRootBoundary ? 'file_tools' : null; } catch { return null; }
  }
  const pausedRefusal = () => (pausedReason() ? unavailable() : null);

  // The caller's effective role in an active team project, or null (General, a deleting or unknown project). The
  // twin of project-visibility.js's unexported `activeProjectRole`.
  function roleIn(memberId, projectId) {
    if (typeof projectId !== 'string' || projectId === GENERAL_PROJECT_ID) return null;
    if (typeof directory.projectState === 'function' && directory.projectState(projectId) !== 'active') return null;
    return effectiveProjectRole(directory, directory.memberActor(memberId), projectId);
  }
  function mustBe(memberId, projectId, minimum) {
    const role = roleIn(memberId, projectId);
    if (role === null) return fail('forbidden', 'team_not_found');
    return roleAtLeast(role, minimum) ? null : fail('forbidden', 'role_forbidden');
  }

  // ------------------------------------------------------------------ events (ids and counts only)

  const bucket = (projectId) => `${PROJECT_BUCKET}${projectId}`;
  function admins(projectId) {
    const audience = new Set();
    for (const memberId of directory.activeMemberIds()) if (roleIn(memberId, projectId) === 'admin') audience.add(memberId);
    return audience;
  }
  function send(type, payload, options) {
    try { publish(type, payload, options); } catch { log('WARN', 'team_project_rules.publish_failed', { event_type: type }); }
  }
  const openCount = (entry) => entry.requests.filter((request) => request.state === 'open').length;
  // After a change: everyone with a row reads the list again; the project's admins get the open-request count.
  function announce(projectId, revision, counts) {
    send(RULES_CHANGED_EVENT, { project_id: projectId, revision },
      { audience: projectAudience(directory, projectId), bucket: bucket(projectId) });
    if (counts !== undefined) {
      send(RULE_REQUESTS_EVENT, { project_id: projectId, open_count: counts },
        { audience: admins(projectId), bucket: bucket(projectId) });
    }
  }

  // ------------------------------------------------------------------ changes (audit first, then the file)

  function audit(entry) {
    const written = approvals.append(entry);
    return written?.ok === true;
  }

  // Dry run, audit entry, write. `change(project)` is run twice on fresh copies (the store refuses what cannot be
  // written before anything is audited); answers the commit's outcome or a host failure.
  function commitAudited(projectId, entry, change) {
    if (!rules) return unavailable();
    const dry = rules.commit(projectId, change, { dryRun: true });
    if (!dry.ok) return failOf(dry);
    if (!audit(entry)) return fail('unavailable', 'team_audit_unavailable');
    const written = rules.commit(projectId, change);
    if (!written.ok) {
      log('WARN', 'team_project_rules.audited_unwritten', { project_id: projectId, kind: entry.kind, reason: written.reason });
      return failOf(written);
    }
    return written;
  }

  const sameRule = (toolName, folder) => (rule) => rule.tool_name === toolName && rule.folder === folder;
  const newRule = (seq, toolName, folder, setBy, fromRequest) => ({ rule_seq: seq, tool_name: toolName, folder,
    set_by: setBy, set_at: clock(), from_request_seq: fromRequest, use_count: 0, last_used_at: null, last_used_by: null });

  function saveRule(projectId, toolName, folder, actorId) {
    const current = project(projectId);
    if (!current) return unavailable();
    if (current.rules.some(sameRule(toolName, folder))) return fail('conflict', 'team_rule_exists');
    if (current.rules.length >= LIMITS.MAX_RULES) return fail('limit', 'team_rule_limit');
    const seq = current.next_rule_seq;
    const written = commitAudited(projectId,
      { kind: 'rule_added', project_id: projectId, actor_member_id: actorId, tool_name: toolName, detail: { rule_seq: seq } },
      (entry) => {
        entry.rules.push(newRule(seq, toolName, folder, actorId, null));
        entry.next_rule_seq = seq + 1;
        return { rule_seq: seq };
      });
    if (!written.ok) return written;
    announce(projectId, written.revision);
    return { ok: true, project_id: projectId, rule_seq: seq, revision: written.revision };
  }

  function fileRequest(projectId, sessionId, toolName, askerId) {
    const current = project(projectId);
    if (!current) return unavailable();
    const open = current.requests.filter((request) => request.state === 'open');
    const same = open.find((request) => request.asker_member_id === askerId && request.tool_name === toolName);
    if (same) return { ok: true, request_seq: same.request_seq, duplicate: true };
    if (open.length >= LIMITS.MAX_OPEN_REQUESTS) return fail('limit', 'team_rule_request_limit');
    const seq = current.next_request_seq;
    const written = commitAudited(projectId,
      { kind: 'rule_requested', project_id: projectId, session_id: sessionId, actor_member_id: askerId,
        tool_name: toolName, detail: { request_seq: seq } },
      (entry) => {
        entry.requests.push({ request_seq: seq, tool_name: toolName, asker_member_id: askerId, session_id: sessionId,
          asked_at: clock(), state: 'open', answered_by: null, answered_at: null, outcome_tool: null,
          outcome_folder: null, reason: null, rule_seq: null });
        entry.next_request_seq = seq + 1;
        return { request_seq: seq, open: open.length + 1 };
      });
    if (!written.ok) return written;
    announce(projectId, written.revision, written.open);
    return { ok: true, request_seq: seq };
  }

  // ------------------------------------------------------------------ commands

  function list({ params, actor }) {
    const role = roleIn(actor.member_id, params.project_id);
    if (role === null) return fail('forbidden', 'team_not_found');
    const current = project(params.project_id);
    if (!current) return unavailable();
    const admin = role === 'admin';
    const requests = current.requests.filter((request) => request.asker_member_id === actor.member_id
      || (admin && request.state === 'open'));
    const paused = pausedReason();
    return { ok: true, project_id: params.project_id, revision: current.revision, rules: current.rules,
      open_request_count: openCount(current), requests, ...(paused ? { paused } : {}) };
  }

  function add({ params, actor }) {
    const denied = mustBe(actor.member_id, params.project_id, 'admin');
    if (denied) return denied;
    const stopped = pausedRefusal();
    if (stopped) return stopped;
    const folder = validateFolder(params.folder);
    if (!folder.ok) return fail('invalid', folder.reason);
    return saveRule(params.project_id, params.tool_name, folder.folder, actor.member_id);
  }

  // The answer's place: { tool, folder } for an allow or change, { reason } for a decline, or a failure.
  function answerShape(params, request) {
    const extra = Object.keys(params).filter((key) => !['project_id', 'request_seq', 'outcome'].includes(key));
    if (extra.some((key) => !ANSWER_FIELDS[params.outcome].includes(key))) return fail('invalid', 'team_rule_answer_invalid');
    if (params.outcome === 'allow') return { tool: request.tool_name, folder: null };
    if (params.outcome === 'decline') {
      return isInputText(params.reason, LIMITS.MAX_REASON_CHARS) ? { reason: params.reason }
        : fail('invalid', 'team_rule_reason_invalid');
    }
    if (!isRuleTool(params.tool_name)) return fail('invalid', 'team_rule_answer_invalid');
    const folder = validateFolder(params.folder ?? null);
    return folder.ok ? { tool: params.tool_name, folder: folder.folder } : fail('invalid', folder.reason);
  }

  function answer({ params, actor }) {
    const projectId = params.project_id;
    // While paused a decline still clears a stale request (it grants nothing); allow and change are refused.
    const denied = mustBe(actor.member_id, projectId, 'admin') || (params.outcome === 'decline' ? null : pausedRefusal());
    if (denied) return denied;
    const current = project(projectId);
    if (!current) return unavailable();
    const request = current.requests.find((entry) => entry.request_seq === params.request_seq);
    if (!request) return fail('conflict', 'team_rule_request_not_found');
    if (request.state !== 'open') return fail('conflict', 'decision_stale');
    const shape = answerShape(params, request);
    if (shape.ok === false) return shape;
    const state = OUTCOMES[params.outcome];
    const existing = shape.tool ? current.rules.find(sameRule(shape.tool, shape.folder)) : null;
    if (shape.tool && !existing && current.rules.length >= LIMITS.MAX_RULES) return fail('limit', 'team_rule_limit');
    const ruleSeq = shape.tool ? existing?.rule_seq ?? current.next_rule_seq : null;
    const detail = ruleSeq === null ? { request_seq: request.request_seq } : { request_seq: request.request_seq, rule_seq: ruleSeq };
    const written = commitAudited(projectId,
      { kind: `rule_request_${state}`, project_id: projectId, actor_member_id: actor.member_id,
        tool_name: shape.tool ?? request.tool_name, detail },
      (entry) => {
        const target = entry.requests.find((item) => item.request_seq === request.request_seq);
        Object.assign(target, { state, answered_by: actor.member_id, answered_at: clock(),
          outcome_tool: shape.tool ?? null, outcome_folder: shape.tool ? shape.folder : null,
          reason: shape.reason ?? null, rule_seq: ruleSeq });
        if (shape.tool && !existing) {
          entry.rules.push(newRule(ruleSeq, shape.tool, shape.folder, actor.member_id, request.request_seq));
          entry.next_rule_seq = ruleSeq + 1;
        }
        // Past 32 answered: the oldest answers go (answered_at, then request_seq), never the one just answered.
        const older = entry.requests.filter((item) => item.state !== 'open' && item !== target)
          .sort((a, b) => a.answered_at - b.answered_at || a.request_seq - b.request_seq);
        const drop = new Set(older.slice(0, Math.max(0, older.length + 1 - LIMITS.MAX_ANSWERED_REQUESTS)));
        entry.requests = entry.requests.filter((item) => !drop.has(item));
        return { open: openCount(entry) };
      });
    if (!written.ok) return written;
    announce(projectId, written.revision, written.open);
    send(RULE_ANSWERED_EVENT, { session_id: request.session_id, request_seq: request.request_seq, outcome: state });
    return { ok: true, project_id: projectId, request_seq: request.request_seq, outcome: state, rule_seq: ruleSeq,
      revision: written.revision };
  }

  // A removal only takes authority away, so it stays open while the rules are paused.
  function remove({ params, actor }) {
    const projectId = params.project_id;
    const denied = mustBe(actor.member_id, projectId, 'admin');
    if (denied) return denied;
    const current = project(projectId);
    if (!current) return unavailable();
    const rule = current.rules.find((entry) => entry.rule_seq === params.rule_seq);
    if (!rule) return fail('conflict', 'team_rule_not_found');
    const written = commitAudited(projectId,
      { kind: 'rule_removed', project_id: projectId, actor_member_id: actor.member_id, tool_name: rule.tool_name,
        detail: { rule_seq: rule.rule_seq } },
      (entry) => {
        entry.rules = entry.rules.filter((item) => item.rule_seq !== rule.rule_seq);
        return {};
      });
    if (!written.ok) return written;
    announce(projectId, written.revision);
    return { ok: true, project_id: projectId, rule_seq: rule.rule_seq, revision: written.revision };
  }

  const HANDLERS = { 'team.project.rules.list': list, 'team.project.rules.add': add,
    'team.project.rules.answer': answer, 'team.project.rules.remove': remove };
  const commands = Object.freeze({
    handles: (operation) => Object.hasOwn(HANDLERS, operation),
    isRead: (operation) => READS.has(operation),
    // `call` is { params, actor: { member_id, owner, device_id } } from team-commands.js.
    dispatch: async (command, call) => {
      const handler = Object.hasOwn(HANDLERS, command.operation) ? HANDLERS[command.operation] : null;
      if (!handler) return fail('invalid', 'unsupported_operation');
      return READS.has(command.operation) ? handler(call) : serialized(() => handler(call));
    },
  });

  // ------------------------------------------------------------------ approval.resolve's `always`

  // Before the audited decision: null when `always` ('rule' or 'ask', the closed schema) may ride on this answer,
  // else the refusal (nothing is applied).
  function precheck({ always, projectId, toolName, memberId }) {
    if (typeof projectId !== 'string') return fail('conflict', 'team_rule_no_project');
    if (!isRuleTool(toolName)) return fail('invalid', 'team_rule_tool_invalid');
    return mustBe(memberId, projectId, always === 'rule' ? 'admin' : 'writer') || pausedRefusal();
  }

  // After the decision applied, in the same synchronous run as `precheck` (no await between, so the role it read
  // still holds): saves the rule or files the request. Answers { ok, rule_seq | request_seq } or { ok: false, reason };
  // never throws, and a refusal never undoes the allow it rode on.
  function record({ always, projectId, sessionId, toolName, memberId }) {
    let done;
    try {
      done = always === 'rule' ? saveRule(projectId, toolName, null, memberId)
        : fileRequest(projectId, sessionId, toolName, memberId);
    } catch {
      done = unavailable();
    }
    if (!done.ok) return { ok: false, reason: done.error.reason };
    return always === 'rule' ? { ok: true, rule_seq: done.rule_seq } : { ok: true, request_seq: done.request_seq };
  }
  const decisions = Object.freeze({ precheck, record });

  // ------------------------------------------------------------------ the backend port

  // The conversation's project and its running turn's starter, when the starter may still write there; else null.
  function writerTurn(sessionId) {
    const projectId = approvals.projectOf(sessionId);
    if (typeof projectId !== 'string') return null;
    const host = backend();
    const starter = host ? turnStarter(host, sessionId) : null;
    if (!isId('member', starter) || !roleAtLeast(roleIn(starter, projectId), 'writer')) return null;
    return { host, projectId, starter };
  }

  // One read, synchronous, never throws. A rule answers only a running turn of a member who may still write in the
  // conversation's project (from the host's own session index now), for a path the matcher can compare. The most
  // specific folder wins, then the lowest rule number. Counts nothing: `used` does, once the call settled.
  function match({ sessionId, toolName, input } = {}) {
    try {
      if (!rules || !isRuleTool(toolName)) return null;
      const turn = writerTurn(sessionId);
      if (!turn) return null;
      const candidates = rules.rulesFor(turn.projectId, toolName) ?? [];
      if (candidates.length === 0) return null;
      const root = turn.host?.projectService?.get?.(turn.projectId)?.root_path ?? null;
      const target = ruleTarget(toolName, input, { root, platform });
      if (!target) return null;
      const found = candidates.filter((rule) => folderCovers(rule.folder, target))
        .sort((a, b) => (b.folder?.length ?? -1) - (a.folder?.length ?? -1) || a.rule_seq - b.rule_seq)[0];
      return found ? { rule_seq: found.rule_seq } : null;
    } catch {
      return null;
    }
  }

  // A call the rule answered settled approved: one use for the rule, by the turn's starter. Never throws.
  function used({ sessionId, ruleSeq } = {}) {
    try {
      const turn = rules && Number.isSafeInteger(ruleSeq) && ruleSeq >= 1 ? writerTurn(sessionId) : null;
      if (turn) rules.noteUse(turn.projectId, ruleSeq, turn.starter);
    } catch {
      log('WARN', 'team_project_rules.use_failed', {});
    }
  }

  // ------------------------------------------------------------------ cleanup

  // The delete's step (team-project-delete.js) and its reconcile: the project's rules and requests go. Idempotent; a
  // store that cannot be read is skipped (a later start's prune drops them) and never stops a delete.
  function dropProject(projectId) {
    if (!rules || !rules.available()) {
      log('WARN', 'team_project_rules.drop_skipped', { project_id: projectId });
      return { ok: true };
    }
    const dropped = rules.commit(projectId, () => ({ drop: true }));
    if (!dropped.ok) log('WARN', 'team_project_rules.drop_failed', { project_id: projectId, reason: dropped.reason });
    return { ok: true };
  }

  // A member who left the team, or the project: their open requests go (no audit entry: the membership log has the
  // removal). Answered ones stay for the record; rules they set stay.
  function dropRequests(memberId, projectIds) {
    for (const projectId of projectIds) {
      const current = project(projectId);
      if (!current?.requests.some((request) => request.state === 'open' && request.asker_member_id === memberId)) continue;
      const written = rules.commit(projectId, (entry) => {
        entry.requests = entry.requests.filter((request) => request.state !== 'open' || request.asker_member_id !== memberId);
        return { open: openCount(entry) };
      });
      if (written.ok) announce(projectId, written.revision, written.open);
      else log('WARN', 'team_project_rules.requests_drop_failed', { project_id: projectId, reason: written.reason });
    }
  }

  // At start, before any command: set aside a refused file, then drop the entries of projects with no team row.
  function open({ teamProjectIds } = {}) {
    if (!rules || !rules.openAtStart()) {
      log('WARN', 'team_project_rules.unavailable');
      return;
    }
    if (Array.isArray(teamProjectIds)) {
      const keep = new Set(teamProjectIds);
      const gone = rules.prune((projectId) => keep.has(projectId));
      if (gone) log('INFO', 'team_project_rules.pruned', { projects: gone });
    }
  }

  // After the host core exists: the backend port, the membership and project subscribers, and the teardown flush.
  function attach({ core, store }) {
    const host = core.composition.backend;
    host.teamProjectRules = Object.freeze({ match, used });
    const offMembers = store.onMembershipChange((event) => {
      if (typeof event?.member_id !== 'string') return;
      // A revoke or leave, or a demotion to read-only (a reader asks for nothing): the member's open requests close.
      if (event.kind === 'member_revoked' || (event.kind === 'role_changed' && event.role === 'read_only')) {
        dropRequests(event.member_id, rules?.projectIds() ?? []);
      }
    });
    const offProjects = store.onProjectChange((event) => {
      // A delete drops the project's entry itself (team-project-delete.js); only a member leaving matters here.
      if (typeof event?.project_id !== 'string' || event.reason !== 'members') return;
      for (const memberId of Array.isArray(event.member_ids) ? event.member_ids : []) {
        if (directory.projectRole(memberId, event.project_id) == null) dropRequests(memberId, [event.project_id]);
      }
    });
    return [offMembers, offProjects, () => {
      if (host.teamProjectRules?.match === match) delete host.teamProjectRules;
      const flushed = rules?.flush();
      if (flushed && !flushed.ok) log('WARN', 'team_project_rules.flush_failed', { reason: flushed.reason });
    }];
  }

  return Object.freeze({
    open, attach, commands, decisions, dropProject, match, used,
    // The approvals object the router and the decision handlers get: the same functions, plus `rules`.
    withApprovals: (base) => Object.freeze({ ...base, rules: decisions }),
    store: () => rules,
  });
}

// team-main.js's one call: built on the member store's directory and opened at once, before any command, with the
// store's team project ids for the prune.
function startTeamProjectRules({ memberStore, ...options }) {
  const rules = createTeamProjectRules({ ...options, directory: memberStore.directory });
  let ids;
  try { ids = memberStore.snapshot()?.projects.map((entry) => entry.project_id) ?? null; } catch { ids = null; }
  rules.open({ teamProjectIds: ids });
  return rules;
}

module.exports = { createTeamProjectRules, startTeamProjectRules };
