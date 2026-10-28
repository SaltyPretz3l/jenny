'use strict';

// Row 73: /handoff from the primary Jenny chat is scoped to one project. Its
// transcript spans every project, so the note is drafted about the chosen one
// only and the new chat opens there on its own (never linked under the primary;
// the backend still refuses a linked handoff from it). This module owns the
// project choices, the suggested project and the names of other work the
// renderer flags when a note mentions them. Reads only; never throws.

const { GENERAL_PROJECT_ID } = require('../projects/project-schema');
const { isPrimaryRole } = require('./primary-session');

// The newest transcript rows scanned for the chat Jenny looked at last.
const SUGGESTION_SCAN_ROWS = 400;
const MAX_NAME_CHARS = 80;
const MAX_OTHER_NAMES = 200;
// A shorter name, or a title every profile has, would flag ordinary words.
const MIN_FLAGGED_NAME_CHARS = 4;
const GENERIC_TITLE_RE = /^(?:new chat|untitled(?: chat)?|jenny)$/i;
// Tools whose input names one chat: that chat's project is the one Jenny looked at.
const SESSION_INPUT_KEYS = Object.freeze({
  session_status: 'session_id',
  session_transcript: 'session_id',
  session_stop: 'session_id',
  session_message: 'destination_session_id',
});

function attempt(fn, fallback) {
  try {
    return fn();
  } catch (_error) {
    return fallback;
  }
}

function boundedName(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return name ? name.slice(0, MAX_NAME_CHARS) : '';
}

/** Every project, as `{ id, name }`, by name with General last. */
function listHandoffProjects(service) {
  const projects = attempt(() => service.projectService?.list?.(), null);
  return (Array.isArray(projects) ? projects : [])
    .map((project) => ({ id: typeof project?.id === 'string' ? project.id : '', name: boundedName(project?.name) }))
    .filter((project) => project.id && project.name)
    .sort((left, right) => (left.id === GENERAL_PROJECT_ID) - (right.id === GENERAL_PROJECT_ID)
      || left.name.localeCompare(right.name));
}

// A chat without a project reads as General, as everywhere else.
const projectOf = (summary) => summary.project_id || GENERAL_PROJECT_ID;

function chatProject(store, sessionId, projectIds) {
  const summary = attempt(() => store.peekSessionSummary?.(sessionId), null);
  const projectId = summary && !isPrimaryRole(summary) ? projectOf(summary) : null;
  return projectIds.has(projectId) ? projectId : null;
}

/**
 * The project the primary chat looked at most recently: the newest tool call
 * naming a chat or a project, else the project of the most recently active
 * ordinary chat. Null when neither names a known project.
 */
function suggestHandoffProject(service, primarySessionId, projects) {
  const store = service.sessionStore;
  const projectIds = new Set(projects.map((project) => project.id));
  const messages = attempt(() => store.peekSessionMessages?.(primarySessionId), null);
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1, seen = 0; index >= 0 && seen < SUGGESTION_SCAN_ROWS; index -= 1, seen += 1) {
    const call = rows[index]?.kind === 'tool_use' ? rows[index].tool_call : null;
    const input = call && call.input && typeof call.input === 'object' ? call.input : null;
    if (!input) continue;
    if (projectIds.has(input.project_id)) return input.project_id;
    const key = SESSION_INPUT_KEYS[call.tool_name];
    const projectId = key ? chatProject(store, input[key], projectIds) : null;
    if (projectId) return projectId;
  }
  const summaries = attempt(() => store.listSessions?.(), null);
  const recent = (Array.isArray(summaries) ? summaries : [])
    .find((summary) => summary && !isPrimaryRole(summary) && !summary.archived_at && projectIds.has(projectOf(summary)));
  return recent ? projectOf(recent) : null;
}

/**
 * Names of work outside `projectId` (other projects' names, other chats'
 * titles) that the dialog flags when a note mentions them. General's name and
 * generic titles are left out: they read as ordinary words.
 */
function otherWorkNames(service, projectId, projects) {
  const chosen = projects.find((project) => project.id === projectId);
  const skip = new Set([chosen ? chosen.name.toLowerCase() : '']);
  const names = [];
  const add = (value) => {
    const name = boundedName(value);
    const key = name.toLowerCase();
    if (names.length >= MAX_OTHER_NAMES || name.length < MIN_FLAGGED_NAME_CHARS || GENERIC_TITLE_RE.test(name) || skip.has(key)) return;
    skip.add(key);
    names.push(name);
  };
  for (const project of projects) {
    if (project.id !== projectId && project.id !== GENERAL_PROJECT_ID) add(project.name);
  }
  const summaries = attempt(() => service.sessionStore.listSessions?.(), null);
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (summary && !isPrimaryRole(summary) && projectOf(summary) !== projectId) add(summary.title);
  }
  return names;
}

/**
 * The scope of a primary-chat handoff: `{ ok: true, project, otherNames }` for a
 * known `projectId`, otherwise `{ ok: false, reason, projects, suggestedProjectId }`
 * with reason `project_required` (none named) or `project_invalid`.
 */
function resolvePrimaryHandoffScope(service, primarySessionId, projectId) {
  const projects = listHandoffProjects(service);
  const requested = typeof projectId === 'string' ? projectId.trim() : '';
  const project = requested ? projects.find((entry) => entry.id === requested) : null;
  if (project) return { ok: true, project, otherNames: otherWorkNames(service, project.id, projects) };
  return {
    ok: false,
    reason: requested ? 'project_invalid' : 'project_required',
    projects,
    suggestedProjectId: suggestHandoffProject(service, primarySessionId, projects),
  };
}

module.exports = {
  listHandoffProjects,
  otherWorkNames,
  resolvePrimaryHandoffScope,
  suggestHandoffProject,
};
