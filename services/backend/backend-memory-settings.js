'use strict';

// Settings > Memory page plumbing (agentic memory v2, row 58 W4). Every call
// names the project of the row or tab the user acted on in Settings (the user
// owns every project); no other request field is authority. Answers are
// `{ ok, ... }` shapes; memory text reaches the renderer only inside returned
// rows and never reaches a log.

const { ensureArray, isPlainObject } = require('../value-utils');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('../projects/project-schema');
const {
  OPERATION_ID_PATTERN,
  REASON_PATTERN,
  clearMemorySuppressions,
  requestMemoryRpc,
  summarizeMemoryWrite,
} = require('./backend-memory');

const MAX_PROJECT_ID_CHARS = 128;
const LIST_PAGE_SIZE = 250;
const MAX_ARCHIVED_ROWS = 2_000;
const MAX_EXPORT_ROWS = 10_000;
const MAX_OPERATIONS = 50;
const MAX_ALWAYS_ON_LINES = 64;
const MAX_TIMESTAMP_CHARS = 64;
const ERASE_STATUSES = new Set(['erased', 'not_found']);
const INVALID = Object.freeze({ ok: false, reason: 'invalid' });
const UNAVAILABLE = Object.freeze({ ok: false, reason: 'sidecar_unavailable' });
const ISO_DAY = /^(\d{4}-\d{2}-\d{2})T/u;

// A Settings project id: a valid project id of at most 128 chars, or `null`
// where the call allows "every project". '' means invalid.
function settingsProjectId(value, { allowNull = false } = {}) {
  if (value === null) return allowNull ? null : '';
  if (typeof value !== 'string' || value.length > MAX_PROJECT_ID_CHARS) return '';
  return normalizeProjectId(value);
}

function memoryIdOf(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

// One Settings RPC. A thrown request becomes `{ ok: false, reason }` with a
// token reason; only the method and that token are logged.
async function settingsRpc(service, method, params) {
  try {
    return { payload: await requestMemoryRpc(service, method, params) };
  } catch (error) {
    const raw = String(error?.reason || '');
    const reason = REASON_PATTERN.test(raw) ? raw : 'request_failed';
    service._emitServiceLog?.('WARN', 'memory.settings_request_failed', { method, reason });
    return { failure: { ok: false, reason } };
  }
}

// The write outcome Settings sees: the summarized result plus the row it wrote.
function writeOutcome(payload) {
  return {
    ok: true,
    ...summarizeMemoryWrite(payload),
    ...(isPlainObject(payload?.memory) ? { memory: payload.memory } : {}),
  };
}

async function pagedList(service, params, maxRows) {
  const memories = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    const page = await settingsRpc(service, 'memory.list', { ...params, cursor, limit: LIST_PAGE_SIZE });
    if (page.failure) return page;
    memories.push(...ensureArray(page.payload?.memories).filter(isPlainObject));
    cursor = String(page.payload?.next_cursor || '').trim() || null;
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
  } while (cursor && memories.length < maxRows);
  return { memories: memories.slice(0, maxRows) };
}

async function listArchivedMemories(service, { projectId } = {}) {
  const project = settingsProjectId(projectId);
  if (!project) return INVALID;
  if (!service.sidecarClient) return UNAVAILABLE;
  const listed = await pagedList(service, { status: 'archived', scope: 'project', project_id: project }, MAX_ARCHIVED_ROWS);
  return listed.failure || { ok: true, memories: listed.memories };
}

// `targetProjectId` (the page's "Restore to…") restores a deleted project's
// row into another project; it must name a different valid project.
async function restoreArchivedMemory(service, { projectId, memoryId, targetProjectId } = {}) {
  const project = settingsProjectId(projectId);
  const id = memoryIdOf(memoryId);
  if (!project || !id) return INVALID;
  const params = { project_id: project, memory_id: id };
  if (targetProjectId !== undefined) {
    const target = settingsProjectId(targetProjectId);
    if (!target || target === project) return INVALID;
    params.target_project_id = target;
  }
  if (!service.sidecarClient) return UNAVAILABLE;
  const answer = await settingsRpc(service, 'memory.restore', params);
  return answer.failure || writeOutcome(answer.payload);
}

async function eraseMemory(service, { projectId, memoryId } = {}) {
  const project = settingsProjectId(projectId);
  const id = memoryIdOf(memoryId);
  if (!project || !id) return INVALID;
  if (!service.sidecarClient) return UNAVAILABLE;
  const answer = await settingsRpc(service, 'memory.erase', { project_id: project, memory_id: id });
  if (answer.failure) return answer.failure;
  const status = answer.payload?.status;
  return ERASE_STATUSES.has(status) ? { ok: true, status } : { ok: false, reason: 'unexpected_reply' };
}

// `projectId: null` clears every project's forgotten list.
async function clearForgottenMemories(service, { projectId } = {}) {
  const project = settingsProjectId(projectId, { allowNull: true });
  if (project === '') return INVALID;
  if (!service.sidecarClient) return UNAVAILABLE;
  try {
    return { ok: true, ...(await clearMemorySuppressions(service, project)) };
  } catch (error) {
    const raw = String(error?.reason || '');
    const reason = REASON_PATTERN.test(raw) ? raw : 'request_failed';
    service._emitServiceLog?.('WARN', 'memory.settings_request_failed', { method: 'memory.clear_suppressions', reason });
    return { ok: false, reason };
  }
}

const tokenOf = value => (typeof value === 'string' && REASON_PATTERN.test(value) ? value : '');
const countOrNull = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const timestampOrNull = value => (typeof value === 'string' && value.length <= MAX_TIMESTAMP_CHARS ? value : null);

// The ledger fields Settings shows; anything else (before/after rows) stays out.
function operationRow(row) {
  if (!isPlainObject(row) || typeof row.operation_id !== 'string' || !OPERATION_ID_PATTERN.test(row.operation_id)) {
    return null;
  }
  return {
    operation_id: row.operation_id,
    op: tokenOf(row.op),
    origin: tokenOf(row.origin),
    memory_id: countOrNull(row.memory_id),
    result_revision: countOrNull(row.result_revision),
    created_at: timestampOrNull(row.created_at),
    expires_at: timestampOrNull(row.expires_at),
    undone_at: timestampOrNull(row.undone_at),
    ...(typeof row.undoable === 'boolean' ? { undoable: row.undoable } : {}),
  };
}

async function listMemoryOperations(service, { projectId } = {}) {
  const project = settingsProjectId(projectId);
  if (!project) return INVALID;
  if (!service.sidecarClient) return UNAVAILABLE;
  const answer = await settingsRpc(service, 'memory.operations', { project_id: project, limit: MAX_OPERATIONS });
  if (answer.failure) return answer.failure;
  const operations = ensureArray(answer.payload?.operations).map(operationRow).filter(Boolean);
  return { ok: true, operations: operations.slice(0, MAX_OPERATIONS) };
}

// An `always_on_full` refusal carries the current always-on lines so Settings
// can say what fills the budget.
async function setMemoryAlwaysOn(service, { projectId, memoryId, alwaysOn, expectedRevision } = {}) {
  const project = settingsProjectId(projectId);
  const id = memoryIdOf(memoryId);
  const revisionValid = expectedRevision === undefined || expectedRevision === null || memoryIdOf(expectedRevision) > 0;
  if (!project || !id || typeof alwaysOn !== 'boolean' || !revisionValid) return INVALID;
  if (!service.sidecarClient) return UNAVAILABLE;
  const answer = await settingsRpc(service, 'memory.update', {
    project_id: project,
    memory_id: id,
    always_on: alwaysOn,
    ...(memoryIdOf(expectedRevision) ? { expected_revision: expectedRevision } : {}),
  });
  if (answer.failure) return answer.failure;
  const outcome = writeOutcome(answer.payload);
  if (Array.isArray(answer.payload?.always_on_lines)) {
    outcome.always_on_lines = answer.payload.always_on_lines
      .filter(line => typeof line === 'string').slice(0, MAX_ALWAYS_ON_LINES);
  }
  return outcome;
}

// --- Markdown export ---------------------------------------------------------

function localDay(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function projectLabel(service, projectId) {
  if (projectId === GENERAL_PROJECT_ID) return 'General';
  try {
    const name = service.projectService?.get?.(projectId)?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : projectId;
  } catch (_error) {
    return projectId;
  }
}

function chatTitle(service, sessionId) {
  try {
    const title = service.sessionStore?.getSessionSummary?.(sessionId)?.title;
    return typeof title === 'string' && title.trim() ? title.trim() : '';
  } catch (_error) {
    return '';
  }
}

const oneLine = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

// `- **<Kind>** <text> (always on) _(origin, YYYY-MM-DD)_`: no ids, no excerpts.
function exportLine(row) {
  const kind = oneLine(row.lesson_kind);
  const label = kind ? `**${kind.charAt(0).toUpperCase()}${kind.slice(1)}** ` : '';
  const day = ISO_DAY.exec(String(row.created_at || ''))?.[1];
  const details = [oneLine(row.origin), day].filter(Boolean).join(', ');
  return `- ${label}${oneLine(row.lesson_text)}${row.always_on === true ? ' (always on)' : ''}${details ? ` _(${details})_` : ''}`;
}

function projectSection(service, projectId, rows) {
  const lines = [`## ${projectLabel(service, projectId)}`, ''];
  const shared = rows.filter(row => !row.scope_session_id);
  if (shared.length) lines.push(...shared.map(exportLine), '');
  const chats = new Map();
  for (const row of rows.filter(entry => entry.scope_session_id)) {
    const title = chatTitle(service, String(row.scope_session_id));
    if (!chats.has(title)) chats.set(title, []);
    chats.get(title).push(row);
  }
  if (!chats.size) return lines;
  lines.push('### Chat notes', '');
  // Notes of a chat with no known title come first, without a heading.
  const titles = [...chats.keys()].sort((left, right) => {
    if (!left || !right) return left ? 1 : -1;
    return left.localeCompare(right);
  });
  for (const title of titles) {
    if (title) lines.push(`#### ${title}`, '');
    lines.push(...chats.get(title).map(exportLine), '');
  }
  return lines;
}

function buildMemoriesMarkdown(service, rows) {
  if (!rows.length) return '# Jenny memories\n\n_No memories yet._\n';
  const byProject = new Map();
  for (const row of [...rows].sort((left, right) => (Number(left.id) || 0) - (Number(right.id) || 0))) {
    const projectId = String(row.project_id || GENERAL_PROJECT_ID);
    if (!byProject.has(projectId)) byProject.set(projectId, []);
    byProject.get(projectId).push(row);
  }
  const order = [...byProject.keys()].sort((left, right) => {
    if (left === GENERAL_PROJECT_ID || right === GENERAL_PROJECT_ID) return left === GENERAL_PROJECT_ID ? -1 : 1;
    return projectLabel(service, left).localeCompare(projectLabel(service, right));
  });
  const lines = ['# Jenny memories', ''];
  for (const projectId of order) lines.push(...projectSection(service, projectId, byProject.get(projectId)));
  return lines.join('\n');
}

// The active rows as Markdown (`projectId: null` = every project); main saves it.
async function exportMemoriesMarkdown(service, { projectId } = {}, { now = () => new Date() } = {}) {
  const project = settingsProjectId(projectId, { allowNull: true });
  if (project === '') return INVALID;
  if (!service.sidecarClient) return UNAVAILABLE;
  const scope = project === null ? { scope: 'all' } : { scope: 'project', project_id: project };
  const listed = await pagedList(service, scope, MAX_EXPORT_ROWS);
  if (listed.failure) return listed.failure;
  return {
    ok: true,
    markdown: buildMemoriesMarkdown(service, listed.memories),
    defaultName: `jenny-memories-${localDay(now())}.md`,
  };
}

module.exports = {
  buildMemoriesMarkdown,
  clearForgottenMemories,
  eraseMemory,
  exportMemoriesMarkdown,
  listArchivedMemories,
  listMemoryOperations,
  restoreArchivedMemory,
  setMemoryAlwaysOn,
};
