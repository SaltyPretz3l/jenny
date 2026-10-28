'use strict';

/* Durable model-authored tasks backed by the existing Open Loops store.
 *
 * The sidecar reaches this Electron-owned tool through tool.execute_electron.
 * ShellConfigService remains the sole persistence owner; this module only
 * validates model input, performs identity-addressed mutations, and renders a
 * bounded plain-text result for the model. */

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');
const { normalizeProjectId } = require('../../projects/project-schema');
const {
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
} = require('../../shell-config-followups-schema');
const { manifestSchema } = require('./tool-result');

const TASK_SOURCE_KIND = 'agent_task';
const MAX_AGENT_TASKS = 200;
// Resolved agent tasks retained per project; older ones are pruned when a task resolves.
const MAX_RESOLVED_AGENT_TASKS = 200;
const TASK_STATUSES = Object.freeze(['active', 'resolved']);
const OPEN_TASK_STATUSES = Object.freeze(['active', 'deferred']);
const TASK_BOARD_ACTIONS = Object.freeze(['add', 'update', 'complete', 'list']);
const NOTES_EXCERPT_CHARS = 120;

function failure(reason, content, summary, errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED) {
  return {
    content,
    summary,
    isError: true,
    errorCode,
    metadata: { result_kind: 'task_board', status: 'failed', reason },
  };
}

function success(action, content, summary, extra = {}) {
  return {
    content,
    summary,
    isError: false,
    metadata: { result_kind: 'task_board', status: 'ok', action, ...extra },
  };
}

function oneLine(value) {
  return normalizeString(value).replace(/\s+/gu, ' ');
}

/* Tasks are scoped to the request's trusted project. A task whose stored
 * projectId is empty (not yet backfilled) belongs to no project and is hidden. */
function tasksIn(state, projectId) {
  const followUps = state?.followUps;
  return Array.isArray(followUps)
    ? followUps.filter((entry) => (
      entry?.sourceKind === TASK_SOURCE_KIND && entry.projectId === projectId
    ))
    : [];
}

// getState() clones the whole config, so each call reads it once and then
// works from the snapshot every store mutator already returns.
function readTasks(configService, projectId) {
  return tasksIn(configService.getState(), projectId);
}

function tasksAfterWrite(configService, returnedState, projectId) {
  return Array.isArray(returnedState?.followUps)
    ? tasksIn(returnedState, projectId)
    : readTasks(configService, projectId);
}

function findIn(tasks, id) {
  return tasks.find((entry) => entry.id === id) || null;
}

function requiredId(input, action) {
  const id = normalizeString(input?.id);
  return id
    ? { id }
    : { error: failure('id_required', `${action} requires a task id.`, 'Task id required') };
}

function normalizeStatus(value) {
  const status = normalizeString(value).toLowerCase();
  return TASK_STATUSES.includes(status) ? status : '';
}

function validateText(value, field, limit, { required = false } = {}) {
  if (value === undefined) {
    return required
      ? { error: failure(`${field}_required`, `${field} is required.`, `Task ${field} required`) }
      : { present: false, text: '' };
  }
  if (typeof value !== 'string') {
    return { error: failure(`invalid_${field}`, `${field} must be a string.`, `Invalid task ${field}`) };
  }
  const text = value.replace(/\0/gu, '').trim();
  if (required && !text) {
    return { error: failure(`${field}_required`, `${field} is required.`, `Task ${field} required`) };
  }
  if (text.length > limit) {
    return {
      error: failure(
        `${field}_too_long`,
        `${field} exceeds the ${limit} character limit.`,
        `Task ${field} too long`
      ),
    };
  }
  return { present: true, text };
}

// The excerpt lets the model see existing notes before an update replaces them.
function notesExcerpt(body) {
  const text = oneLine(body);
  if (!text) return '';
  const clipped = text.length > NOTES_EXCERPT_CHARS ? `${text.slice(0, NOTES_EXCERPT_CHARS - 1)}…` : text;
  return ` | notes=${clipped}`;
}

function renderTask(task) {
  return `- id=${task.id} | title=${oneLine(task.label)} | status=${task.status}`
    + `${notesExcerpt(task.body)} | sourceKind=${TASK_SOURCE_KIND}`;
}

// Resolution order, not creation order: the store stamps resolvedAt when a task
// is completed (updatedAt/createdAt stand in for legacy rows; ties keep store order).
const resolvedStamp = (task) => String(task.resolvedAt || task.updatedAt || task.createdAt || '');
const byResolvedAsc = (left, right) => (resolvedStamp(left) < resolvedStamp(right) ? -1 : resolvedStamp(left) > resolvedStamp(right) ? 1 : 0);

// Open tasks first (store order), then resolved tasks newest first, so a long
// resolved tail can never push the live work past the 200-row cap.
function orderForList(tasks) {
  const open = tasks.filter((task) => OPEN_TASK_STATUSES.includes(task.status));
  const rest = tasks.filter((task) => !OPEN_TASK_STATUSES.includes(task.status)).sort(byResolvedAsc).reverse();
  return open.concat(rest);
}

// The project's open-task cap, shared by add and by reopening a resolved task.
function openTaskLimitFailure(tasks) {
  const openCount = tasks.filter((task) => OPEN_TASK_STATUSES.includes(task.status)).length;
  if (openCount < MAX_AGENT_TASKS) return null;
  return failure(
    'task_limit_reached',
    `The task board is limited to ${MAX_AGENT_TASKS} open agent tasks in this project.`,
    'Task limit reached'
  );
}

// Bounded retained state: keep the newest MAX_RESOLVED_AGENT_TASKS resolved
// tasks of the project and delete the older ones. The 200 open-task cap plus
// this bound keeps a project's agent tasks finite. `keepId` is the task this
// very call resolved: it is never the one pruned, whatever its stamps say.
function pruneResolvedTasks(configService, tasks, keepId) {
  if (typeof configService?.deleteFollowUp !== 'function') return 0;
  const resolved = tasks
    .filter((task) => task.status === 'resolved' && task.id !== keepId).sort(byResolvedAsc);
  const excess = resolved.slice(0, Math.max(0, resolved.length + 1 - MAX_RESOLVED_AGENT_TASKS));
  for (const task of excess) configService.deleteFollowUp(task.id);
  return excess.length;
}

function listTasks(configService, projectId) {
  const tasks = orderForList(readTasks(configService, projectId));
  const visible = tasks.slice(0, MAX_AGENT_TASKS);
  const hiddenCount = tasks.length - visible.length;
  const lines = visible.map(renderTask);
  if (hiddenCount) lines.push(`... and ${hiddenCount} more`);
  return success(
    'list',
    lines.length ? lines.join('\n') : 'No agent tasks found.',
    `Listed ${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
    { count: tasks.length, project_id: projectId }
  );
}

function addTask(configService, projectId, input, sessionId) {
  if (normalizeString(input?.id)) {
    return failure('id_not_allowed', 'add generates the task id; omit id.', 'Task add rejected');
  }
  const tasks = readTasks(configService, projectId);
  const limit = openTaskLimitFailure(tasks);
  if (limit) return limit;
  const title = validateText(input?.title, 'title', MAX_FOLLOW_UP_LABEL_CHARS, { required: true });
  if (title.error) return title.error;
  const notes = validateText(input?.notes, 'notes', MAX_FOLLOW_UP_BODY_CHARS);
  if (notes.error) return notes.error;
  const status = input?.status === undefined ? 'active' : normalizeStatus(input.status);
  if (!status) {
    return failure('invalid_status', 'status must be active or resolved.', 'Invalid task status');
  }

  const beforeIds = new Set(tasks.map((task) => task.id));
  const state = configService.upsertFollowUp({
    label: title.text,
    body: notes.text,
    status,
    sessionId: normalizeString(sessionId),
    projectId,
    sourceKind: TASK_SOURCE_KIND,
  });
  const after = tasksIn(state, projectId);
  const created = after.find((entry) => !beforeIds.has(entry.id)) || null;
  if (!created) {
    return failure('persistence_failed', 'The task could not be persisted.', 'Task add failed');
  }
  // A task added already resolved is held to the same retained-history bound.
  if (created.status === 'resolved') pruneResolvedTasks(configService, after, created.id);
  return success(
    'add',
    `Added task "${oneLine(created.label)}" with id ${created.id}.`,
    'Added task',
    {
      task_id: created.id,
      task_title: oneLine(created.label).slice(0, 200),
      project_id: projectId,
    }
  );
}

function updateTask(configService, projectId, input) {
  const identity = requiredId(input, 'update');
  if (identity.error) return identity.error;
  const tasks = readTasks(configService, projectId);
  const existing = findIn(tasks, identity.id);
  if (!existing) {
    return failure('not_found', `No agent task with id "${identity.id}" exists.`, 'Task not found');
  }
  const title = validateText(input?.title, 'title', MAX_FOLLOW_UP_LABEL_CHARS);
  if (title.error) return title.error;
  // The store substitutes a placeholder label for a blank one, so refuse before any write.
  if (title.present && !title.text) {
    return failure('invalid_title', 'title must not be blank.', 'Invalid task title');
  }
  const notes = validateText(input?.notes, 'notes', MAX_FOLLOW_UP_BODY_CHARS);
  if (notes.error) return notes.error;
  const statusPresent = input?.status !== undefined;
  const status = statusPresent ? normalizeStatus(input.status) : '';
  if (statusPresent && !status) {
    return failure('invalid_status', 'status must be active or resolved.', 'Invalid task status');
  }
  if (!title.present && !notes.present && !statusPresent) {
    return failure('empty_update', 'update requires title, notes, or status.', 'Empty task update');
  }
  // A deferral is the user's call; the model may edit the task but not undo it.
  if (status === 'active' && existing.status === 'deferred') {
    return failure(
      'deferred_by_user',
      'The user deferred this task. Leave it deferred, or ask the user before reactivating it.',
      'Task is deferred'
    );
  }
  // Reopening a resolved task is an open task more: the same cap as add, before any write.
  if (status === 'active' && !OPEN_TASK_STATUSES.includes(existing.status)) {
    const limit = openTaskLimitFailure(tasks);
    if (limit) return limit;
  }

  const patch = {
    ...(title.present ? { label: title.text } : {}),
    ...(notes.present ? { body: notes.text } : {}),
  };
  let state = null;
  if (Object.keys(patch).length) state = configService.updateFollowUp(identity.id, patch);
  if (status === 'active') state = configService.activateFollowUp(identity.id);
  if (status === 'resolved') state = configService.resolveFollowUp(identity.id);
  const after = tasksAfterWrite(configService, state, projectId);
  if (status === 'resolved') pruneResolvedTasks(configService, after, identity.id);
  const updated = findIn(after, identity.id);
  if (!updated
    || (title.present && updated.label !== title.text)
    || (notes.present && updated.body !== notes.text)
    || (statusPresent && updated.status !== status)) {
    return failure('persistence_failed', 'The task update could not be persisted.', 'Task update failed');
  }
  return success(
    'update',
    `Updated task "${oneLine(updated.label)}" (id ${updated.id}, status ${updated.status}).`,
    'Updated task',
    { task_id: updated.id, project_id: projectId }
  );
}

function completeTask(configService, projectId, input) {
  const identity = requiredId(input, 'complete');
  if (identity.error) return identity.error;
  const existing = findIn(readTasks(configService, projectId), identity.id);
  if (!existing) {
    return failure('not_found', `No agent task with id "${identity.id}" exists.`, 'Task not found');
  }
  const after = tasksAfterWrite(configService, configService.resolveFollowUp(identity.id), projectId);
  pruneResolvedTasks(configService, after, identity.id);
  const completed = findIn(after, identity.id);
  if (completed?.status !== 'resolved') {
    return failure('persistence_failed', 'The task could not be completed.', 'Task completion failed');
  }
  return success(
    'complete',
    `Completed task "${oneLine(completed.label)}" (id ${completed.id}).`,
    'Completed task',
    { task_id: completed.id, project_id: projectId }
  );
}

const ACTION_HANDLERS = Object.freeze({ add: addTask, update: updateTask, complete: completeTask });

module.exports = {
  name: 'task_board',
  ...manifestSchema('task_board'),
  category: 'builtin',
  readOnly: false,
  workspaceRequired: false,

  summarize(input) {
    const action = typeof input?.action === 'string' ? input.action.trim().toLowerCase() : '';
    return `Task board: ${TASK_BOARD_ACTIONS.includes(action) ? action : 'action'}`;
  },

  async execute(input, context) {
    const configService = context?.configService;
    if (!configService || typeof configService.getState !== 'function'
      || typeof configService.upsertFollowUp !== 'function') {
      return failure('unavailable', 'The Open Loops store is unavailable.', 'Task board unavailable', TOOL_ERROR_CODES.DISABLED);
    }
    // The project comes from the trusted execution authority, never from model arguments.
    const projectId = normalizeProjectId(context?.projectAuthority?.project_id);
    if (!projectId) {
      return failure('project_unavailable', 'The chat has no project; tasks are unavailable.', 'Task board unavailable');
    }
    const action = normalizeString(input?.action).toLowerCase();
    try {
      if (action === 'list') return listTasks(configService, projectId);
      // Own keys only: 'constructor' must not resolve to Object.prototype.
      const handler = Object.hasOwn(ACTION_HANDLERS, action) ? ACTION_HANDLERS[action] : null;
      if (!handler) {
        return failure(
          'unsupported_action',
          `action must be one of: ${TASK_BOARD_ACTIONS.join(', ')}.`,
          'Unsupported task board action'
        );
      }
      return handler(configService, projectId, input || {}, context?.sessionId);
    } catch (error) {
      context?.logger?.('WARN', 'task_board.action_failed', {
        action,
        error_name: String(error?.name || 'Error').slice(0, 64),
      });
      return failure('action_failed', 'The task board action could not be completed.', 'Task board action failed');
    }
  },
};
