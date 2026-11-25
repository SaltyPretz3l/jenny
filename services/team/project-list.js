'use strict';

// The member's shared projects for one team (row 123 slice 3-9): the project list and the conversations of each
// project, held in memory only, plus a count per conversation of waiting approvals and whether a turn runs.
// team-projects.js owns one per team and routes the team's host events here.
//
// The list is read with `projects.list` and the conversations with `sessions.list` (the host filters both to what
// this member may read). Both are read again on `team_project_changed`, on `resync_required`, when this member's
// team role or state changes (team-projects.js sees it in the manager's snapshot: the host publishes no project
// event for the revoke, leave and read-only cascades, 3-4a limit), when the team comes online again, and the
// conversations on a conversation's `session_changed` (created, renamed, deleted). The host names a new conversation
// while it saves a turn and sends no `renamed` for that: after a `session_changed` `chat_saved` or the end of a run, the
// conversations are read again while that conversation's row is missing or still carries the title it was first
// listed with, at most TITLE_READS times per conversation (so never once per turn of a long one). A project `deleted`
// drops its conversations at once: the host sends no `session_changed` for the conversations a delete removes (3-4b
// limit).
// A read that an event overtook is dropped and one read follows it, so an answer never undoes a newer change; a
// caller waits for a read whose rows were taken (F1: an overtaken answer once served `projects: null` as ok).
//
// The counts come from the team's live events (`chat_stream` started and ended, `tool_approval_needed`,
// `decision_changed`, `approval_unattended`) for every conversation this member may read, open or not. Only the
// fields a count needs are read (project-answers.js `countedEvent`); a stream event of any other kind is not copied.
// A count change pushes that conversation's entry alone (`kind: 'activity'`). The counts are cleared on a resync and a
// reconnect (an end missed meanwhile would otherwise read running for ever); the conversations read that follows seeds
// them (row 175 F9, below), and a conversation the member joins mid-turn shows running only from its next event.
//
// Row 175 F9: each `sessions.list` row of a current host carries `waiting: { approvals, questions }` (the host's pending
// counts at its read). Every conversations read seeds from it: a conversation whose approvals no live event has named
// yet takes the host's approval count as a placeholder (`seeded`), and every conversation takes its question count
// (questions are counted from the list only; a `decision_changed` that names a question takes one off). The first live
// approval event of that conversation (opened, unattended, decided, its run's end) drops the placeholder and the live
// ids count from there, so a second approval opening while a seeded one still waits reads one until the next read (a
// known limit: the row names no approval id). The approvals waiting for a writer or admin of the project are seeded the
// same way (`project_waiting`); a reader's are not. Running is not seeded (the row carries no turn state).
//
// `current()`: the list was read and events have kept it since (team-projects.js serves calls from it then); a lost
// link, a failed read or a change this client made marks it stale until the next read. `sessions.list` keeps its
// first 2,000 rows that pass the rules (`conversations_truncated` in the push). Nothing is read while Force local
// holds. Nothing here is written to disk; logs carry team ids and reason words only.
//
// Row 175 (F2 with F3 folded in; owner decisions D1, D2): project activity notices. team-projects.js tells the list
// when this app sends a turn for the member (`sending`, `sent`, `unsent`: a send through the conversation path); the
// next `started` of that conversation (its `turn_id` when the send's answer named one) is this member's turn. Its
// `complete`, `error` or `failed`, and each `tool_approval_needed` or `question_batch` of that stream, push one
// `project_notice` ({ notice: finished | failed | approval | question }); a cancelled turn tells nothing. An
// `approval_unattended` (the host found no writer viewing) pushes `unattended` to a writer or admin of the project;
// a reader gets nothing. An unattended notice is never pushed while this member views that conversation (`isViewing`,
// an open conversation); the own-turn notices leave focus to the desktop notifier. Each is pushed once per conversation and turn, question or approval id (the prompter's approval
// and the unattended one share the id). The push names the team, conversation, project, the conversation's title as
// listed and a notice id; never message text. The approvals that wait for this member (theirs and the unattended
// ones of a project they write in) are counted per conversation and pushed as `project_waiting` when the count moves
// (a decision, the end of the turn, a resync or a reconnect clears them). Bounds: 32 turns, 1,000 notices told,
// 2,000 conversations counted. Row 175 F13 (D8): a `teammate_asked` event pushes `project_notice` { notice: 'asked',
// asker_member_id, approval_id? } each time it arrives.

const { isSessionId } = require('../../server/team/ids');
const { projectAnswer, checkedEvent, checkedProjectChange, countedEvent } = require('./project-answers');
const { invalidRequest } = require('./team-errors');

// How many overtaken reads a caller waits through before it answers that the list is not ready.
const TAKE_TRIES = 3;

const MAX_ACTIVITY = 2_000;
// Reads one conversation may cost while its title may still move: the saved turn and the end of the run.
const TITLE_READS = 2;
const RUN_START = new Set(['started']);
const RUN_END = new Set(['complete', 'error', 'cancelled', 'canceled', 'failed']);
// Row 175: what a notice reads of an event (the kind and its ids, never a body).
// `tool_use` only for an approval that timed out (its waiting count goes).
const NOTICE_STREAM = new Set([...RUN_START, ...RUN_END, 'tool_approval_needed', 'question_batch', 'tool_use']);
const WORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVAL_ID = /^[!-~]{1,512}$/;
const MINE_MAX = 32;
const TOLD_MAX = 1_000;
const WRITERS = new Set(['writer', 'admin']);
// Row 175 F9: the approvals a conversation shows waiting: the live ids, or the list's count while no live event named one.
const approvalCount = (entry) => entry.approvals.size + entry.seeded;
const wordOf = (value) => (typeof value === 'string' && WORD_ID.test(value) ? value : null);
const approvalOf = (value) => (typeof value === 'string' && APPROVAL_ID.test(value) ? value : null);

// Row 175: the ids a notice needs from a host event, or null; nothing of the stream event's body is copied.
function noticeFields(type, event) {
  if (!event || !isSessionId(event.session_id)) return null;
  if (type === 'approval_unattended' || type === 'decision_changed') {
    const approvalId = approvalOf(event.approval_id);
    return approvalId ? { sessionId: event.session_id, kind: type, approvalId } : null;
  }
  const inner = type === 'chat_stream' && event.event && typeof event.event === 'object' ? event.event : null;
  if (!inner || !NOTICE_STREAM.has(inner.type) || !wordOf(event.stream_id)) return null;
  return { sessionId: event.session_id, kind: inner.type, streamId: event.stream_id, turnId: wordOf(inner.turn_id),
    approvalId: approvalOf(inner.approval_id), questionId: wordOf(inner.call_id) || wordOf(inner.message_id) || '',
    status: wordOf(inner.status) };
}

// `onProjects(rows)`: called with each projects read's rows before the list takes them (open conversations follow
// their project and role, project-conversations.js `reconcile`).
function createProjectList({ manager, teamId, push = () => {}, log = () => {}, isHeld = () => false, onProjects = () => {},
  isViewing = () => false }) {
  let projects = null; // [{ id, name, root_revision, role }] once read
  let filesSupported = false;
  let conversations = []; // [{ session_id, title, project_id, updated_at? ... }] of known projects only
  let truncated = false;
  let projectsTruncated = false;
  let fresh = { projects: false, conversations: false };
  const activity = new Map(); // session id -> { approvals: Set<approval id>, running }
  const titles = new Map(); // session id -> { first: title as first listed (null while unlisted), reads }
  let events = 0;
  const reads = { projects: null, conversations: null };
  const again = { projects: false, conversations: false };
  const taken = { projects: 0, conversations: 0 }; // reads whose rows the list took
  let stopped = false;
  const mine = new Map(); // row 175: session id -> { turnId, streamId } of this member's own turn
  const told = new Set(); // row 175: notice keys pushed
  const waiting = new Map(); // row 175: session id -> Set<approval id> waiting for this member
  const seedWait = new Map(); // row 175 F9: session id -> approvals the list counted for this member, no id known yet
  let noticeSeq = 0;

  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };

  function view() {
    const counts = {};
    for (const [sessionId, entry] of activity) {
      const approvals = approvalCount(entry);
      if (entry.running || approvals > 0 || entry.questions > 0) {
        counts[sessionId] = { approvals, running: entry.running, ...(entry.questions > 0 ? { questions: entry.questions } : {}) };
      }
    }
    return { team_id: teamId, projects: projects ? projects.map((row) => ({ ...row })) : null, files_supported: filesSupported,
      projects_truncated: projectsTruncated, conversations: conversations.map((row) => ({ ...row })), conversations_truncated: truncated, activity: counts };
  }

  // One conversation's counts changed: that entry alone (fix 14).
  function tellActivity(sessionId) {
    if (stopped) return;
    const entry = activity.get(sessionId);
    try {
      push({ kind: 'activity', team_id: teamId, session_id: sessionId, approvals: entry ? approvalCount(entry) : 0,
        running: entry ? entry.running : false, ...(entry?.questions > 0 ? { questions: entry.questions } : {}) });
    } catch { say('WARN', 'team.projects.push_failed'); }
  }

  function tell() {
    if (stopped) return;
    try { push({ kind: 'projects', ...view() }); } catch { say('WARN', 'team.projects.push_failed'); }
  }

  function keepConversations(rows) {
    const known = new Set((projects || []).map((row) => row.id));
    return rows.filter((row) => typeof row.project_id === 'string' && known.has(row.project_id));
  }

  function watchTitle(sessionId, first) {
    if (titles.size >= MAX_ACTIVITY) titles.delete(titles.keys().next().value);
    const entry = { first, reads: 0 };
    titles.set(sessionId, entry);
    return entry;
  }

  // Each listed conversation's title as first listed; one watched while unlisted takes its first listed title now.
  function noteTitles() {
    for (const row of conversations) {
      const entry = titles.get(row.session_id);
      if (!entry) watchTitle(row.session_id, row.title);
      else if (entry.first === null) entry.first = row.title;
    }
  }

  // A turn was saved or a run ended: the title may have moved on the host (see the header).
  function titleMayMove(sessionId) {
    if (stopped || isHeld()) return;
    const row = conversations.find((entry) => entry.session_id === sessionId) || null;
    const entry = titles.get(sessionId) || watchTitle(sessionId, row ? row.title : null);
    if (row && entry.first !== null && row.title !== entry.first) return;
    if (entry.reads >= TITLE_READS) return;
    entry.reads += 1;
    events += 1;
    void read('conversations');
  }

  // One read of `kind` at a time; a read requested meanwhile runs once after it. An answer an event overtook
  // (`events` moved while it was out) is dropped and read again.
  function read(kind) {
    if (stopped || isHeld()) return Promise.resolve(null);
    if (reads[kind]) { again[kind] = true; return reads[kind]; }
    const sentAt = events;
    const operation = kind === 'projects' ? 'projects.list' : 'sessions.list';
    const running = (async () => {
      const answer = projectAnswer(operation, await manager.command(operation, {}));
      if (stopped) return answer;
      if (answer.ok !== true) {
        fresh[kind] = false;
        say('WARN', 'team.projects.read_failed', { kind, reason: answer.error.reason });
        return answer;
      }
      if (events !== sentAt) { again[kind] = true; return answer; }
      if (kind === 'projects') {
        try { onProjects(answer.projects); } catch { say('WARN', 'team.projects.reconcile_failed'); }
        projects = answer.projects;
        projectsTruncated = answer.truncated === true;
        if (projectsTruncated) say('WARN', 'team.projects.projects_truncated', { kept: projects.length });
        filesSupported = answer.files_supported;
        conversations = keepConversations(conversations);
      } else {
        conversations = keepConversations(answer.sessions);
        noteTitles();
        for (const row of conversations) { seedActivity(row); seedWaiting(row); }
        truncated = answer.truncated === true;
        if (truncated) say('WARN', 'team.projects.conversations_truncated', { kept: conversations.length });
      }
      fresh[kind] = true;
      taken[kind] += 1;
      tell();
      return answer;
    })();
    reads[kind] = running;
    void running.finally(() => {
      reads[kind] = null;
      if (again[kind] && !stopped) { again[kind] = false; void read(kind); }
    }).catch(() => {});
    return running;
  }

  // A read of `kind` whose rows the list took: an overtaken answer is followed by its re-read (read() starts it), up to
  // TAKE_TRIES times; a refusal is answered as it is; a list that events keep overtaking answers `team_not_connected`.
  async function readTaken(kind) {
    for (let tries = 0; tries < TAKE_TRIES; tries += 1) {
      const before = taken[kind];
      const answer = await read(kind);
      if (!answer || answer.ok !== true || taken[kind] !== before) return answer;
    }
    return invalidRequest('team_not_connected');
  }

  async function refresh() {
    const listed = await readTaken('projects');
    if (listed?.ok === true) await readTaken('conversations');
    return listed;
  }

  function activityOf(sessionId, create) {
    let entry = activity.get(sessionId);
    if (!entry && create) {
      if (activity.size >= MAX_ACTIVITY) activity.delete(activity.keys().next().value);
      entry = { approvals: new Set(), running: false, seeded: 0, questions: 0 };
      activity.set(sessionId, entry);
    }
    return entry || null;
  }

  function settle(sessionId, entry) {
    if (entry && !entry.running && approvalCount(entry) === 0 && entry.questions === 0) activity.delete(sessionId);
  }

  // Row 175 F9: one listed conversation's host counts (see the header). A row without `waiting` changes nothing.
  function seedActivity(row) {
    const counted = row.waiting;
    if (!counted) return;
    let entry = activityOf(row.session_id, false);
    if (!entry && (counted.approvals > 0 || counted.questions > 0)) entry = activityOf(row.session_id, true);
    if (!entry) return;
    if (entry.approvals.size === 0) entry.seeded = counted.approvals;
    entry.questions = counted.questions;
    settle(row.session_id, entry);
  }

  // Row 175 F9: the approvals waiting for this member as the list counts them, for a writer or admin of the project.
  function seedWaiting(row) {
    if (!row.waiting || waiting.get(row.session_id)?.size) return;
    const next = WRITERS.has(projectRoleOf(row.session_id)) ? row.waiting.approvals : 0;
    if (next === (seedWait.get(row.session_id) ?? 0)) return;
    if (next > 0) seedWait.set(row.session_id, next); else seedWait.delete(row.session_id);
    tellWaiting(row.session_id);
  }

  // Row 175 F9: a `decision_changed` naming a question batch takes one off the conversation's listed question count and
  // pushes that entry.
  function questionDecided(type, event) {
    if (type !== 'decision_changed' || !event || !isSessionId(event.session_id) || event.approval_id !== undefined
      || typeof event.question_ref !== 'string') return;
    const entry = activityOf(event.session_id, false);
    if (!entry || entry.questions === 0) return;
    entry.questions -= 1;
    settle(event.session_id, entry);
    tellActivity(event.session_id);
  }

  // True when the counted event (project-answers.js `countedEvent`) changed a count (fix 13: only the fields a count
  // needs are read).
  function countEvent(event) {
    if (!event) return false;
    const { kind } = event;
    if (RUN_START.has(kind)) { activityOf(event.session_id, true).running = true; return true; }
    if (RUN_END.has(kind)) {
      const entry = activityOf(event.session_id, false);
      if (!entry) return false;
      entry.running = false;
      entry.approvals.clear();
      entry.seeded = 0;
      entry.questions = 0;
      settle(event.session_id, entry);
      return true;
    }
    if (kind === 'tool_approval_needed' || kind === 'approval_unattended') {
      const entry = activityOf(event.session_id, true);
      entry.seeded = 0;
      entry.approvals.add(event.approval_id);
      return true;
    }
    // A decision, or an approval that timed out (its `tool_use` alone ends it).
    if (kind === 'decision_changed' || kind === 'tool_use') {
      const entry = activityOf(event.session_id, false);
      if (!entry) return false;
      // A live id goes; otherwise the decision answers one of the approvals the list read counted.
      if (!entry.approvals.delete(event.approval_id)) {
        if (entry.seeded === 0) return false;
        entry.seeded -= 1;
      }
      settle(event.session_id, entry);
      return true;
    }
    return false;
  }

  // A resync or a reconnect: counts an end may have missed are dropped (fix 16).
  function clearActivity() {
    clearWaiting();
    if (activity.size === 0) return;
    activity.clear();
    tell();
  }

  // ---------------------------------------------------------------- row 175: project activity notices

  const projectRoleOf = (sessionId) => {
    const projectId = conversations.find((row) => row.session_id === sessionId)?.project_id;
    return projectId ? (projects || []).find((row) => row.id === projectId)?.role ?? null : null;
  };

  function pushSafely(payload) {
    if (stopped) return;
    try { push(payload); } catch { say('WARN', 'team.projects.push_failed'); }
  }

  // One notice, once per key. The member's own turn tells even while its conversation is open (the window may be
  // minimized or behind another app; the desktop notifier's focus gate decides, as for a local chat's reply). An
  // unattended approval is not told while this member views it, and is then not marked told: one the host reports
  // again after the member left still reaches them.
  function notice(sessionId, kind, key) {
    if (told.has(key) || (kind === 'unattended' && isViewing(sessionId))) return;
    told.add(key);
    while (told.size > TOLD_MAX) told.delete(told.values().next().value);
    noticeSeq += 1;
    const row = conversations.find((entry) => entry.session_id === sessionId) || null;
    pushSafely({ kind: 'project_notice', team_id: teamId, session_id: sessionId, project_id: row ? row.project_id : null,
      title: row && typeof row.title === 'string' ? row.title : '', notice: kind, notice_id: String(noticeSeq) });
  }

  function tellWaiting(sessionId) {
    pushSafely({ kind: 'project_waiting', team_id: teamId, session_id: sessionId,
      count: (waiting.get(sessionId)?.size ?? 0) + (seedWait.get(sessionId) ?? 0) });
  }

  // A live approval event of the conversation drops the listed placeholder (row 175 F9); the live ids count from here.
  function addWaiting(sessionId, approvalId) {
    const seeded = seedWait.delete(sessionId);
    let set = waiting.get(sessionId);
    if (!set && waiting.size < MAX_ACTIVITY) {
      set = new Set();
      waiting.set(sessionId, set);
    }
    if (!set || set.has(approvalId) || set.size >= 64) { if (seeded) tellWaiting(sessionId); return; }
    set.add(approvalId);
    tellWaiting(sessionId);
  }

  function dropWaiting(sessionId, approvalId = null) {
    const seeded = seedWait.delete(sessionId);
    const set = waiting.get(sessionId);
    if (!set || (approvalId !== null && !set.delete(approvalId))) { if (seeded) tellWaiting(sessionId); return; }
    if (approvalId === null || set.size === 0) waiting.delete(sessionId);
    tellWaiting(sessionId);
  }

  function clearWaiting() {
    for (const sessionId of new Set([...waiting.keys(), ...seedWait.keys()])) dropWaiting(sessionId);
  }

  // team-projects.js: this app is sending a turn for the member in this conversation; the answer's turn id; a refusal.
  function sending(sessionId) {
    mine.delete(sessionId);
    mine.set(sessionId, { turnId: null, streamId: null });
    while (mine.size > MINE_MAX) mine.delete(mine.keys().next().value);
  }
  function sent(sessionId, turnId) {
    const entry = mine.get(sessionId);
    if (entry && !entry.streamId && wordOf(turnId)) entry.turnId = turnId;
  }
  function unsent(sessionId) {
    if (mine.get(sessionId)?.streamId === null) mine.delete(sessionId);
  }

  // This member's own turn's events (`mine`): the start binds its stream; the rest tell.
  function ownTurn(f) {
    const entry = mine.get(f.sessionId);
    if (!entry) return;
    if (f.kind === 'started') {
      if (!entry.streamId && (!entry.turnId || !f.turnId || entry.turnId === f.turnId)) entry.streamId = f.streamId;
      return;
    }
    if (entry.streamId !== f.streamId) return;
    const where = f.sessionId + ':' + f.streamId;
    if (f.kind === 'tool_approval_needed' && f.approvalId) { addWaiting(f.sessionId, f.approvalId); notice(f.sessionId, 'approval', 'approval:' + f.sessionId + ':' + f.approvalId); }
    else if (f.kind === 'question_batch') notice(f.sessionId, 'question', 'question:' + where + ':' + f.questionId);
    else if (RUN_END.has(f.kind)) {
      mine.delete(f.sessionId);
      if (f.kind === 'complete') notice(f.sessionId, 'finished', 'turn:' + where);
      else if (f.kind === 'error' || f.kind === 'failed') notice(f.sessionId, 'failed', 'turn:' + where);
    }
  }

  function noticeEvent(type, event) {
    const f = noticeFields(type, event);
    if (!f) return;
    if (f.kind === 'decision_changed') { dropWaiting(f.sessionId, f.approvalId); return; }
    // An approval that timed out ends with its `tool_use` alone (no decision_changed).
    if (f.kind === 'tool_use') { if (f.approvalId && f.status === 'timeout') dropWaiting(f.sessionId, f.approvalId); return; }
    if (f.kind === 'approval_unattended') {
      if (!WRITERS.has(projectRoleOf(f.sessionId))) return;
      addWaiting(f.sessionId, f.approvalId);
      notice(f.sessionId, 'unattended', 'approval:' + f.sessionId + ':' + f.approvalId);
      return;
    }
    if (RUN_END.has(f.kind)) dropWaiting(f.sessionId);
    ownTurn(f);
  }

  // Row 175 F13 (D8): a teammate asked this member to look at a conversation (the host sends it to them alone). Told
  // every time, even while it is open: the host limits asks per asker. Ids and the listed title only.
  function askedNotice(event) {
    const asked = checkedEvent('teammate_asked', event);
    if (!asked) { say('WARN', 'team.projects.event_refused', { type: 'teammate_asked' }); return; }
    noticeSeq += 1;
    const row = conversations.find((entry) => entry.session_id === asked.session_id) || null;
    pushSafely({ kind: 'project_notice', team_id: teamId, session_id: asked.session_id, project_id: asked.project_id,
      title: row && typeof row.title === 'string' ? row.title : '', notice: 'asked', notice_id: String(noticeSeq),
      asker_member_id: asked.asker_member_id, ...(asked.approval_id ? { approval_id: asked.approval_id } : {}) });
  }

  // A team host event (team-projects.js routes every event here).
  function onEvent(event) {
    if (stopped || !event || typeof event.event_type !== 'string') return;
    if (event.event_type === 'teammate_asked') { askedNotice(event); return; }
    const type = event.event_type;
    // Row 175: a change that starts a re-read marks the list stale meanwhile, so a call waits for the read in flight
    // instead of answering from the list it is replacing (the list is kept from connect now, not from the first call).
    if (type === 'resync_required') { events += 1; fresh = { projects: false, conversations: false }; clearActivity(); void refresh(); return; }
    if (type === 'team_project_changed') {
      const change = checkedProjectChange(event);
      if (!change) { say('WARN', 'team.projects.event_refused', { type }); return; }
      events += 1;
      fresh = { projects: false, conversations: false };
      if (change.reason === 'deleted' || change.reason === 'deleting') {
        const before = conversations.length;
        conversations = conversations.filter((row) => row.project_id !== change.project_id);
        if (change.reason === 'deleted' && projects) projects = projects.filter((row) => row.id !== change.project_id);
        if (conversations.length !== before || change.reason === 'deleted') tell();
      }
      void refresh();
      return;
    }
    if (type === 'session_changed') {
      const change = checkedEvent(type, event);
      if (change && (change.state === 'deleted' || change.reason === 'created' || change.reason === 'renamed')) {
        events += 1;
        if (change.state === 'deleted') {
          conversations = conversations.filter((row) => row.session_id !== change.session_id);
          activity.delete(change.session_id);
          titles.delete(change.session_id);
          mine.delete(change.session_id);
          dropWaiting(change.session_id);
          tell();
        }
        fresh.conversations = false;
        void read('conversations');
      } else if (change && change.reason === 'chat_saved') titleMayMove(change.session_id);
      return;
    }
    const counted = countedEvent(type, event);
    if (counted && RUN_END.has(counted.kind)) titleMayMove(counted.session_id);
    noticeEvent(type, event);
    questionDecided(type, event);
    if (countEvent(counted)) tellActivity(event.session_id);
  }

  return {
    refresh, onEvent, view, clearActivity, readConversations: () => readTaken('conversations'), sending, sent, unsent,
    current: () => projects !== null && fresh.projects && fresh.conversations,
    markStale() { fresh = { projects: false, conversations: false }; },
    knows: (projectId) => Boolean(projects && projects.some((row) => row.id === projectId)),
    projectOf: (sessionId) => conversations.find((row) => row.session_id === sessionId)?.project_id ?? null,
    conversationsOf: (projectId) => conversations.filter((row) => row.project_id === projectId).map((row) => ({ ...row })),
    // The renderer's counts for this team go to zero before the list stops (a replaced manager, a team gone offline).
    stop() { clearWaiting(); stopped = true; activity.clear(); titles.clear(); conversations = []; projects = null; mine.clear(); told.clear(); waiting.clear(); seedWait.clear(); },
    resources: () => ({ reads: (reads.projects ? 1 : 0) + (reads.conversations ? 1 : 0) }),
  };
}

module.exports = { createProjectList };
