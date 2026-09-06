'use strict';

/* Durable model-authored tasks backed by the existing Open Loops store.
 *
 * The sidecar reaches this Electron-owned tool through tool.execute_electron.
 * ShellConfigService remains the sole persistence owner; this module only
 * validates model input, performs identity-addressed mutations, and renders a
 * bounded plain-text result for the model. */

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');
const {
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
} = require('../../shell-config-followups-schema');

const TASK_SOURCE_KIND = 'agent_task';
const MAX_AGENT_TASKS = 200;
const TASK_STATUSES = Object.freeze(['active', 'resolved']);
const TASK_BOARD_ACTIONS = Object.freeze(['add', 'update', 'complete', 'list']);

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

function readTasks(configService) {
  const followUps = configService?.getState?.()?.followUps;
  return Array.isArray(followUps)
    ? followUps.filter((entry) => entry?.sourceKind === TASK_SOURCE_KIND)
    : [];
}

function findTask(configService, id) {
  const normalizedId = normalizeString(id);
  return normalizedId
    ? readTasks(configService).find((entry) => entry.id === normalizedId) || null
    : null;
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

function renderTask(task) {
  return `- id=${task.id} | title=${oneLine(task.label)} | status=${task.status}`
    + ` | sourceKind=${TASK_SOURCE_KIND}`;
}

function listTasks(configService) {
  const tasks = readTasks(configService);
  const visible = tasks.slice(0, MAX_AGENT_TASKS);
  const hiddenCount = tasks.length - visible.length;
  const lines = visible.map(renderTask);
  if (hiddenCount) lines.push(`... and ${hiddenCount} more`);
  return success(
    'list',
    lines.length ? lines.join('\n') : 'No agent tasks found.',
    `Listed ${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
    { count: tasks.length }
  );
}

function addTask(configService, input, sessionId) {
  if (normalizeString(input?.id)) {
    return failure('id_not_allowed', 'add generates the task id; omit id.', 'Task add rejected');
  }
  if (readTasks(configService).length >= MAX_AGENT_TASKS) {
    return failure(
      'task_limit_reached',
      `The task board is limited to ${MAX_AGENT_TASKS} agent tasks.`,
      'Task limit reached'
    );
  }
  const title = validateText(input?.title, 'title', MAX_FOLLOW_UP_LABEL_CHARS, { required: true });
  if (title.error) return title.error;
  const notes = validateText(input?.notes, 'notes', MAX_FOLLOW_UP_BODY_CHARS);
  if (notes.error) return notes.error;
  const status = input?.status === undefined ? 'active' : normalizeStatus(input.status);
  if (!status) {
    return failure('invalid_status', 'status must be active or resolved.', 'Invalid task status');
  }

  const beforeIds = new Set(readTasks(configService).map((task) => task.id));
  const state = configService.upsertFollowUp({
    label: title.text,
    body: notes.text,
    status,
    sessionId: normalizeString(sessionId),
    sourceKind: TASK_SOURCE_KIND,
  });
  const created = Array.isArray(state?.followUps)
    ? state.followUps.find((entry) => (
      entry?.sourceKind === TASK_SOURCE_KIND && !beforeIds.has(entry.id)
    )) || null
    : null;
  if (!created) {
    return failure('persistence_failed', 'The task could not be persisted.', 'Task add failed');
  }
  return success(
    'add',
    `Added task "${oneLine(created.label)}" with id ${created.id}.`,
    'Added task',
    { task_id: created.id, task_title: oneLine(created.label).slice(0, 200) }
  );
}

function updateTask(configService, input) {
  const identity = requiredId(input, 'update');
  if (identity.error) return identity.error;
  const existing = findTask(configService, identity.id);
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

  const patch = {
    ...(title.present ? { label: title.text } : {}),
    ...(notes.present ? { body: notes.text } : {}),
  };
  if (Object.keys(patch).length) configService.updateFollowUp(identity.id, patch);
  if (status === 'active') configService.activateFollowUp(identity.id);
  if (status === 'resolved') configService.resolveFollowUp(identity.id);
  const updated = findTask(configService, identity.id);
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
    { task_id: updated.id }
  );
}

function completeTask(configService, input) {
  const identity = requiredId(input, 'complete');
  if (identity.error) return identity.error;
  const existing = findTask(configService, identity.id);
  if (!existing) {
    return failure('not_found', `No agent task with id "${identity.id}" exists.`, 'Task not found');
  }
  configService.resolveFollowUp(identity.id);
  const completed = findTask(configService, identity.id);
  if (completed?.status !== 'resolved') {
    return failure('persistence_failed', 'The task could not be completed.', 'Task completion failed');
  }
  return success(
    'complete',
    `Completed task "${oneLine(completed.label)}" (id ${completed.id}).`,
    'Completed task',
    { task_id: completed.id }
  );
}

const ACTION_HANDLERS = Object.freeze({ add: addTask, update: updateTask, complete: completeTask });

module.exports = {
  name: 'task_board',
  description: 'Add, update, complete, or list durable model-authored tasks in the persisted Open Loops store. Mutations target one task id; add generates and returns a new id. The list action returns only agent_task records. When you finish work that a task tracks — including a session started from a task, whose brief names its task id — call complete with that id. Do not leave a finished task open.',
  category: 'builtin',
  readOnly: false,
  workspaceRequired: false,
  parameters: { type: 'object', properties: {}, required: ['action'] },

  summarize(input) {
    const action = normalizeString(input?.action);
    return `Task board: ${action || 'action'}`;
  },

  async execute(input, context) {
    const configService = context?.configService;
    if (!configService || typeof configService.getState !== 'function'
      || typeof configService.upsertFollowUp !== 'function') {
      return failure('unavailable', 'The Open Loops store is unavailable.', 'Task board unavailable', TOOL_ERROR_CODES.DISABLED);
    }
    const action = normalizeString(input?.action).toLowerCase();
    try {
      if (action === 'list') return listTasks(configService);
      const handler = ACTION_HANDLERS[action];
      if (!handler) {
        return failure(
          'unsupported_action',
          `action must be one of: ${TASK_BOARD_ACTIONS.join(', ')}.`,
          'Unsupported task board action'
        );
      }
      return handler(configService, input || {}, context?.sessionId);
    } catch (error) {
      context?.logger?.('WARN', 'task_board.action_failed', {
        action,
        error_name: String(error?.name || 'Error').slice(0, 64),
      });
      return failure('action_failed', 'The task board action could not be completed.', 'Task board action failed');
    }
  },
};
