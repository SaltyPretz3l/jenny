'use strict';

/**
 * The port behind `app_view` (row 94 P3): the Jenny chat asks the app to move the user's view (Settings at a
 * section, a chat, a project file at a line, the terminal, Activity, a chat's detail panel, close, split, the
 * sidebar). Modelled on services/workspace-presentation-service.js:
 * - `requestView` re-checks the wire shape and sends ONE `appView.onRequest` push to the main window. It never
 *   waits for the renderer, so the tool's answer is "requested", never "opened".
 * - The renderer (renderer/shell/renderer-app-view-controller.js) applies a request at once only while the user is
 *   idle on the Jenny chat; otherwise it holds it behind the "Jenny wants to open…" chip. It reports each decision
 *   on `appView.reportOutcome`, accepted only for request ids issued here.
 * - Outcomes queue for the session's next request; context assembly joins them into the existing
 *   `workspace_presentation` context block, so the protocol's block vocabulary stays closed.
 * - `appView.reportLayout` keeps the renderer's last layout (ids and booleans only) for the `state` action.
 * Nothing here writes settings, chats or files.
 */

const fs = require('fs');
const nodePath = require('path');

const { toRelativePosix } = require('./shared/workspace-tool-helpers');
const { ToolPathPolicy } = require('./tools/tool-path-policy');

const ACTIONS = Object.freeze(['settings', 'chat', 'file', 'terminal', 'activity', 'chat_panel', 'close', 'split', 'sidebar']);
// Mirrors SETTINGS_SECTION_DEFINITIONS in renderer/shell/renderer-settings-section-registry.js (pinned by
// tests/app-view-service.test.js; the renderer UMD and services cannot share an import).
const SETTINGS_SECTIONS = Object.freeze(['readiness', 'models', 'offline', 'context', 'tools', 'skills', 'memories',
  'personality', 'appearance', 'editor', 'home', 'notifications', 'jennyChat', 'dictation', 'runtime', 'usage',
  'extensions', 'account', 'dataPrivacy', 'aboutUpdates', 'advanced', 'runtimeLimits', 'team']);
// Mirrors the surfaces of renderer/features/renderer-chat-workspace-detail.js.
const CHAT_PANEL_SURFACES = Object.freeze(['outputs', 'changes', 'background_tasks', 'context', 'environment']);
const ACTIVITY_PANES = Object.freeze(['activity', 'permissions']);
const CLOSE_PANES = Object.freeze(['chat_panel', 'preview', 'terminal', 'split']);
const VIEWS = Object.freeze(['chat', 'ide', 'settings', 'home', 'logs', 'other']);
const DECISION_TEXT = Object.freeze({
  shown: 'opened',
  shown_by_user: 'opened after the user clicked Open on the prompt',
  prompted: 'held behind a "Jenny wants to open…" prompt because the user was busy; not opened yet',
  dismissed: 'not opened: the user dismissed the prompt',
  superseded: 'not opened: a newer request replaced it',
  rejected: 'not opened: the app could not open it (that surface is off, missing or refused)',
  dropped: 'not opened: the user left the Jenny chat first',
});
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const REQUEST_ID_RE = /^apv-[a-z0-9]+-\d+$/;
const MAX_LINE = 1_000_000;
const MAX_PATH_CHARS = 1024;
const MAX_TRACKED_PER_SESSION = 32;
const MAX_TRACKED = 256;
const MAX_NOTE_ENTRIES = 8;
const MAX_SPLIT_IDS = 2;

const refusal = (reason) => ({ ok: false, reason });
const sessionId = (value) => (typeof value === 'string' && SESSION_ID_RE.test(value) ? value : '');

// Workspace-relative POSIX only (toRelativePosix: no drive, scheme, leading slash or `..`), bounded, no controls.
function relativePath(value) {
  return typeof value === 'string' && value.length <= MAX_PATH_CHARS && !/\p{Cc}/u.test(value) ? toRelativePosix(value) : '';
}

// The push payload for one action, or null when the target does not fit its closed shape.
function payloadFor(action, target = {}) {
  const t = target && typeof target === 'object' ? target : {};
  switch (action) {
    case 'settings': return SETTINGS_SECTIONS.includes(t.section) ? { section: t.section } : null;
    case 'chat':
    case 'split': return sessionId(t.session_id) ? { session_id: t.session_id } : null;
    case 'file': {
      const path = relativePath(t.path);
      const line = t.line === undefined ? null : t.line;
      if (!path || (line !== null && !(Number.isSafeInteger(line) && line >= 1 && line <= MAX_LINE))) return null;
      return line === null ? { path } : { path, line };
    }
    case 'terminal': return {};
    case 'activity': return ACTIVITY_PANES.includes(t.pane) ? { pane: t.pane } : null;
    case 'chat_panel': return sessionId(t.session_id) && CHAT_PANEL_SURFACES.includes(t.surface)
      ? { session_id: t.session_id, surface: t.surface } : null;
    case 'close': return CLOSE_PANES.includes(t.pane) ? { pane: t.pane } : null;
    case 'sidebar': return typeof t.collapsed === 'boolean' ? { collapsed: t.collapsed } : null;
    default: return null;
  }
}

// What the outcome note names (never a title or file content).
function labelFor(action, payload) {
  switch (action) {
    case 'settings': return `Settings > ${payload.section}`;
    case 'file': return payload.line ? `${payload.path}:${payload.line}` : payload.path;
    case 'chat': case 'split': return `${action === 'split' ? 'split view with ' : ''}chat ${payload.session_id}`;
    case 'activity': return payload.pane === 'permissions' ? 'Activity > Permissions' : 'Activity';
    case 'chat_panel': return `the ${payload.surface} panel of chat ${payload.session_id}`;
    case 'close': return `closing the ${payload.pane}`;
    case 'sidebar': return payload.collapsed ? 'collapsing the sidebar' : 'expanding the sidebar';
    default: return 'the terminal';
  }
}

function createAppViewService({
  sendBridgeEvent = () => {}, isRendererAvailable = () => true, featureFlags = () => ({}), primarySessionId = () => null,
  hostMode = () => 'desktop',
  projectService = () => null, projectApplicationService = () => null, fsPromises = fs.promises,
  now = () => Date.now(), log = () => {},
} = {}) {
  const read = (getter) => { try { return typeof getter === 'function' ? getter() : getter; } catch (_error) { return null; } };
  const tracked = new Map(); // request_id -> { sessionId, label }
  const notes = new Map(); // session_id -> string[]
  const pathPolicy = new ToolPathPolicy({ fs: fsPromises, path: nodePath });
  let layout = null;
  let sequence = 0;

  function enabled() {
    const flags = read(featureFlags) || {};
    return flags.primary_chat !== false && flags.primary_app_view !== false && read(hostMode) !== 'server';
  }

  function isPrimary(id) {
    const primary = read(primarySessionId);
    return typeof id === 'string' && Boolean(id) && id === primary;
  }

  /** `{ok: true}` for the live primary caller while the tool is on; the tool asks first, before any lookup. */
  function admit({ session_id: callerId } = {}) {
    if (!enabled()) return refusal('disabled');
    return isPrimary(callerId) ? { ok: true } : refusal('not_allowed');
  }

  function track(requestId, entry) {
    const mine = [...tracked.entries()].filter(([, value]) => value.sessionId === entry.sessionId);
    if (mine.length >= MAX_TRACKED_PER_SESSION) tracked.delete(mine[0][0]);
    if (tracked.size >= MAX_TRACKED) tracked.delete(tracked.keys().next().value);
    tracked.set(requestId, entry);
  }

  /** One push for the live primary caller; `{delivered, request_id}` or a refusal. */
  function requestView({ session_id: callerId, action, target } = {}) {
    const admitted = admit({ session_id: callerId });
    if (!admitted.ok) return admitted;
    if (!ACTIONS.includes(action)) return refusal('invalid_input');
    const payload = payloadFor(action, target);
    if (!payload) return refusal('invalid_input');
    // No window (closed to the tray): nothing could show it, and no outcome would ever come back.
    if (!read(isRendererAvailable)) return refusal('unavailable');
    sequence += 1;
    const requestId = `apv-${now().toString(36)}-${sequence}`;
    try {
      sendBridgeEvent('appView.onRequest', { request_id: requestId, caller_session_id: callerId, action, ...payload });
    } catch (_error) {
      log('WARN', 'app_view.dispatch_failed', { action });
      return refusal('unavailable');
    }
    track(requestId, { sessionId: callerId, label: labelFor(action, payload) });
    return { ok: true, delivered: true, request_id: requestId };
  }

  /** The renderer's decision for one request this service issued. */
  function recordOutcome(payload = {}) {
    const requestId = typeof payload?.request_id === 'string' && REQUEST_ID_RE.test(payload.request_id) ? payload.request_id : '';
    const entry = requestId ? tracked.get(requestId) : null;
    const text = Object.hasOwn(DECISION_TEXT, String(payload?.decision)) ? DECISION_TEXT[payload.decision] : '';
    if (!entry || !text) return refusal('unknown_request');
    // A prompted request stays tracked: its later Open, dismiss or supersede is still its own report.
    if (payload.decision !== 'prompted') tracked.delete(requestId);
    const queue = notes.get(entry.sessionId) || [];
    queue.push(`- ${entry.label}: ${text}`);
    notes.set(entry.sessionId, queue.slice(-MAX_NOTE_ENTRIES));
    return { ok: true };
  }

  /** The note for the session's next request (once), or ''. */
  function consumeOutcomeNote(id) {
    const queue = notes.get(id);
    if (!queue?.length) return '';
    notes.delete(id);
    return `What the app did with your app_view requests:\n${queue.join('\n')}`;
  }

  /** The renderer's current layout: ids and booleans only. */
  function reportLayout(payload = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const split = Array.isArray(p.split_session_ids) ? p.split_session_ids.map(sessionId).filter(Boolean).slice(0, MAX_SPLIT_IDS) : [];
    layout = {
      active_view: VIEWS.includes(p.active_view) ? p.active_view : 'other',
      current_session_id: sessionId(p.current_session_id) || null,
      split_session_ids: split,
      sidebar_collapsed: p.sidebar_collapsed === true,
      chat_panel_open: p.chat_panel_open === true,
      preview_open: p.preview_open === true,
      terminal_open: p.terminal_open === true,
    };
    return { ok: true };
  }

  function state({ session_id: callerId } = {}) {
    const admitted = admit({ session_id: callerId });
    if (!admitted.ok) return admitted;
    return layout ? { ok: true, layout: { ...layout } } : refusal('unavailable');
  }

  // `{ path }` (project-relative POSIX) for a regular file inside the project's folder, which must be the folder
  // the IDE has open now (the renderer opens a relative path against the IDE's own root).
  async function resolveProjectFile({ project_id: projectId, path } = {}) {
    const relative = relativePath(path);
    if (!relative) return refusal('invalid_input');
    const project = typeof projectId === 'string' && projectId ? read(() => read(projectService)?.get?.(projectId)) : null;
    if (!project) return refusal('unknown_project');
    if (!project.root_path) return refusal('no_folder');
    const projects = read(projectApplicationService);
    let current;
    try { current = await projects?.isCurrentProject?.(project) === true; } catch (_error) { current = false; }
    if (!current) return refusal('project_not_open');
    // The shared realpath containment (symlink/junction escape, Windows case); its escape error carries no code.
    let target;
    try {
      target = await pathPolicy.assertInsideRoot(nodePath.resolve(project.root_path, relative), { workingDirectory: project.root_path });
    } catch (error) {
      if (!error?.code) return refusal('outside_folder');
      return refusal(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unavailable');
    }
    let stat;
    try { stat = await fsPromises.stat(target); } catch (_error) { return refusal('missing'); }
    if (!stat.isFile()) return refusal('not_a_file');
    return { ok: true, path: relative };
  }

  return { admit, consumeOutcomeNote, enabled, recordOutcome, reportLayout, requestView, resolveProjectFile, state };
}

module.exports = { ACTIONS, ACTIVITY_PANES, CHAT_PANEL_SURFACES, CLOSE_PANES, SETTINGS_SECTIONS, createAppViewService };
