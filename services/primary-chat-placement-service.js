'use strict';

/* services/primary-chat-placement-service.js - the port behind the Jenny chat's `project_create` and
 * `projects_list` tools and Activity's Undo of a created project (row 94 P2,
 * docs/plans/APP_CONTROL_P2_CHAT_PLACEMENT_2026-11-02.md).
 *
 * Invariant: a folder is bound only after the user saw it on the card. The approval path calls
 * `prepareCard` under the tool call id (chat-stream-tool-approval.js); it canonicalizes the folder, applies
 * services/agent-folder-policy.js and refuses a folder that resolves somewhere else (a junction, a symlink),
 * so the folder on the card is exactly the folder bound. A refused request never reaches a card: the approval
 * path ends it with the reason for the model. `create` writes only when that call's card exists and its name
 * and folder are the ones shown, and re-runs every check; a failed bind removes the new, empty project.
 * Each created project is one `chat_changed` history row (action `project_create`, field `project`, on the
 * calling chat), so Activity's Undo rides the row 94 P1 route into `undoCreate`, which removes the project
 * record (never the folder) while it is still empty and still bound once.
 *
 * Composition-root style: dependencies are injected getters; a missing or throwing one is a refusal
 * (`unavailable`), never a throw. Writes and undo are serialized. Answers carry stable reasons only.
 */

const os = require('os');
const { randomBytes } = require('crypto');
const { canonicalizeProjectRootAsync } = require('./projects/project-service');
const { workspaceRootId } = require('./workspace-root-identity');
const { agentFolderRefusal } = require('./agent-folder-policy');

const LIMITS = Object.freeze({ name_chars: 80, folder_chars: 1024, list_max: 50 });
const CARD_TTL_MS = 30 * 60 * 1000;
const CARDS_MAX = 16;
// A folder on a dead network host can stall realpath for seconds; the check gives up and refuses instead.
const CANONICALIZE_TIMEOUT_MS = 2000;
// Control and invisible (format) characters, which no project name may carry.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/u;
const CREATE_REASONS = Object.freeze({ capacity_exceeded: 'limit_reached', invalid_name: 'invalid_input', folder_already_project: 'exists' });

const refusal = (reason, extra = {}) => ({ ok: false, reason, ...extra });

function read(getter) {
  try { return typeof getter === 'function' ? getter() || null : null; } catch (_error) { return null; }
}

function attempt(fn, fallback) {
  try { return fn(); } catch (_error) { return fallback; }
}

function cleanName(value) {
  if (typeof value !== 'string' || INVISIBLE_RE.test(value)) return '';
  const name = value.replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= LIMITS.name_chars ? name : '';
}

function createPrimaryChatPlacementService({
  projectApplicationService = () => null, projectService = () => null, sessionStore = () => null,
  controls = () => null, featureFlags = () => ({}), primarySessionId = () => null, hostMode = () => 'desktop',
  emitSessionsChanged = () => {}, protectedPaths = () => [],
  platform = process.platform, env = process.env, homedir = () => os.homedir(), canonicalize = canonicalizeProjectRootAsync,
  canonicalizeTimeoutMs = CANONICALIZE_TIMEOUT_MS,
  now = () => Date.now(), createId = () => `sc_${randomBytes(16).toString('hex')}`, log = () => {},
} = {}) {
  let tail = Promise.resolve();
  const cards = new Map(); // `${session_id}\n${tool_call_id}` -> { name, folder, rootId, at }

  const enabled = () => {
    const flags = read(featureFlags) || {};
    return flags.primary_chat !== false && flags.primary_chat_placement !== false && read(hostMode) !== 'server';
  };
  const isPrimary = (sessionId) => typeof sessionId === 'string' && sessionId !== '' && read(primarySessionId) === sessionId;
  const note = (level, event, details) => { try { log(level, event, details); } catch (_error) { /* never changes an answer */ } };
  const rootIdOf = (folder) => workspaceRootId(folder, { platform });
  // A spelling compared as the card shows it: only a trailing separator, and on Windows case and slash direction,
  // are not a different folder. `..`, `.`, a junction or an 8.3 name are, so the card never names one folder and binds another.
  const spelled = (value) => {
    const trimmed = String(value).trim().replace(/[\\/]+$/, '');
    return platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
  };
  const sessions = () => attempt(() => read(sessionStore)?.listSessions?.() ?? null, null);

  function serialize(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  }

  // ---------- the folder check (card and apply share it) ----------

  // The async canonical path, never blocking the main process; a probe past the timeout reads `timeout`.
  async function resolveFolder(folder) {
    let timer = null;
    const expired = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), canonicalizeTimeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => canonicalize(folder)), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  // `{ canonical, rootId }` for a folder the model may bind, or a refusal carrying what the model needs next.
  async function checkFolder(folder) {
    if (typeof folder !== 'string' || !folder.trim() || folder.length > LIMITS.folder_chars || INVISIBLE_RE.test(folder)) {
      return refusal('invalid_input');
    }
    let canonical;
    try {
      canonical = await resolveFolder(folder);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return refusal('missing');
      return refusal(error?.code === 'invalid_root' ? 'invalid_folder' : 'unavailable');
    }
    if (!canonical) return refusal('invalid_input');
    const policy = agentFolderRefusal(canonical, { platform, env, homedir: read(homedir) || '', protectedPaths: read(protectedPaths) || [] });
    if (policy) return refusal(policy);
    const rootId = rootIdOf(canonical);
    // The card shows the model's spelling; it must name the folder that gets bound.
    if (spelled(folder) !== spelled(canonical)) return refusal('resolves_elsewhere', { folder: canonical });
    const listed = attempt(() => read(projectService)?.list?.(), null);
    if (!Array.isArray(listed)) return refusal('unavailable');
    const owner = listed.find((project) => project?.root_id === rootId);
    if (owner) return refusal('exists', { project_id: owner.id, project_name: String(owner.name || '') });
    return { ok: true, canonical, rootId };
  }

  async function checkRequest({ name, folder }) {
    const cleaned = cleanName(name);
    if (!cleaned) return refusal('invalid_input');
    const checked = await checkFolder(folder);
    return checked.ok ? { ...checked, name: cleaned } : checked;
  }

  // ---------- the card ----------

  function pruneCards() {
    const cutoff = now() - CARD_TTL_MS;
    for (const [key, card] of cards) if (card.at < cutoff) cards.delete(key);
    while (cards.size > CARDS_MAX) cards.delete(cards.keys().next().value);
  }

  /** Called by the approval path before the card: remembers what the card shows under this call, or refuses. */
  async function prepareCard({ session_id: sessionId, tool_call_id: callId, name, folder } = {}) {
    if (!enabled()) return refusal('disabled');
    if (!isPrimary(sessionId)) return refusal('not_allowed');
    if (typeof callId !== 'string' || !callId) return refusal('unavailable');
    const checked = await checkRequest({ name, folder });
    if (!checked.ok) return checked;
    pruneCards();
    cards.set(`${sessionId}\n${callId}`, { name, folder, rootId: checked.rootId, at: now() });
    return { ok: true, name: checked.name, folder: checked.canonical };
  }

  // ---------- create ----------

  function rollback(projectId) {
    const removed = attempt(() => read(projectService)?.remove?.(projectId), null);
    if (removed?.ok !== true) note('WARN', 'primary_chat_placement.rollback_failed', {});
  }

  /** The tool's write: only under this call's card, with the name and folder it showed, re-checked now. */
  function create({ caller_session_id: callerId, tool_call_id: callId, name, folder } = {}) {
    return serialize(async () => {
      if (!enabled()) return refusal('disabled');
      if (!isPrimary(callerId)) return refusal('not_allowed');
      const key = `${callerId}\n${callId}`;
      pruneCards();
      const card = typeof callId === 'string' ? cards.get(key) : null;
      cards.delete(key); // one card, one attempt
      if (!card || card.name !== name || card.folder !== folder) return refusal('stale');
      const checked = await checkRequest({ name, folder });
      if (!checked.ok) return checked;
      if (checked.rootId !== card.rootId) return refusal('stale');
      const projects = read(projectApplicationService);
      if (typeof projects?.createProject !== 'function' || typeof projects.bindProjectRoot !== 'function') return refusal('unavailable');
      const created = attempt(() => projects.createProject({ name: checked.name }), null);
      const projectId = created?.ok === true ? created.project?.id : null;
      if (!projectId) return refusal(CREATE_REASONS[created?.error?.reason] || 'unavailable');
      const bound = attempt(() => projects.bindProjectRoot({ project_id: projectId, root_path: checked.canonical, expected_root_revision: 0 }), null);
      if (bound?.ok !== true) {
        rollback(projectId);
        const reason = CREATE_REASONS[bound?.error?.reason] || 'unavailable';
        if (reason !== 'exists') return refusal(reason);
        const again = await checkFolder(folder); // the project that took the folder meanwhile
        return again.ok ? refusal('unavailable') : again;
      }
      // bindRoot resolves the folder again; a link swapped since the check would bind a folder nobody checked.
      if (rootIdOf(bound.project?.root_path || '') !== checked.rootId) {
        rollback(projectId);
        return refusal('stale');
      }
      const changeId = createId();
      const recorded = attempt(() => read(controls)?.recordChatChange?.({
        change_id: changeId, session_id: callerId, action: 'project_create', field: 'project', before: null, after: projectId,
      }) === true, false);
      if (!recorded) note('WARN', 'primary_chat_placement.history_write_failed', {});
      attempt(() => emitSessionsChanged({ session_ids: [callerId], projects_changed: true }), null);
      return { ok: true, ...(recorded ? { change_id: changeId } : {}), project_id: projectId, name: checked.name, folder: checked.canonical };
    });
  }

  // ---------- list ----------

  /** `projects_list`: every project with its folder state and unarchived chat count, latest activity first. */
  async function list({ caller_session_id: callerId } = {}) {
    if (!enabled()) return refusal('disabled');
    if (!isPrimary(callerId)) return refusal('not_allowed');
    const projects = read(projectApplicationService);
    let listed;
    try { listed = await projects?.listProjectsWithStatus?.(); } catch (_error) { listed = null; }
    const all = sessions();
    if (listed?.ok !== true || !Array.isArray(listed.projects) || !Array.isArray(all)) return refusal('unavailable');
    const stats = new Map();
    for (const summary of all) {
      if (!summary?.project_id || summary.archived_at || summary.session_role === 'primary') continue;
      const entry = stats.get(summary.project_id) || { count: 0, last: '' };
      entry.count += 1;
      const at = String(summary.updated_at || '');
      if (at > entry.last) entry.last = at;
      stats.set(summary.project_id, entry);
    }
    const rows = listed.projects.filter((project) => typeof project?.id === 'string').map((project) => {
      const stat = stats.get(project.id) || { count: 0, last: '' };
      const folder = typeof project.root_path === 'string' && project.root_path ? project.root_path.slice(0, LIMITS.folder_chars) : null;
      return {
        id: project.id, name: String(project.name || ''), folder,
        folder_state: !folder ? 'none' : project.folder_exists === false ? 'missing' : 'ok',
        chat_count: stat.count, last_activity_at: stat.last || String(project.updated_at || '') || null,
        is_workspace: project.is_current === true,
      };
    });
    rows.sort((left, right) => String(right.last_activity_at || '').localeCompare(String(left.last_activity_at || '')));
    return { ok: true, projects: rows.slice(0, LIMITS.list_max), total: rows.length };
  }

  // ---------- undo ----------

  /** Activity's Undo of a `project_create` row: remove the project record while it is empty and bound once. */
  function undoCreate(entry) {
    return serialize(async () => {
      if (!enabled()) return refusal('disabled');
      const projectId = entry?.action === 'project_create' && entry.field === 'project' ? entry.after : null;
      if (typeof projectId !== 'string' || !projectId) return refusal('unknown');
      const project = attempt(() => read(projectService)?.get?.(projectId), undefined);
      if (project === undefined) return refusal('unavailable');
      if (!project) return refusal('unknown'); // already deleted
      if (project.root_revision !== 1 || !project.root_path) return refusal('changed_since');
      const all = sessions();
      if (!Array.isArray(all)) return refusal('unavailable');
      if (all.some((summary) => summary?.project_id === projectId)) return refusal('changed_since');
      const projects = read(projectApplicationService);
      if (typeof projects?.deleteProject !== 'function') return refusal('unavailable');
      let removed;
      try { removed = await projects.deleteProject({ project_id: projectId }); } catch (_error) { removed = null; }
      if (removed?.ok !== true) return refusal('unavailable');
      attempt(() => emitSessionsChanged({ session_ids: [String(entry.session_id || '')], projects_changed: true }), null);
      return { ok: true };
    });
  }

  return { create, enabled, list, prepareCard, undoCreate };
}

module.exports = { createPrimaryChatPlacementService, LIMITS };
