'use strict';

// One-time (idempotent) project stamp for agent tasks created before tasks
// carried a projectId: each unstamped task takes its chat's current project,
// or General when the chat is gone or the task was added by hand. Runs at
// BackendService startup, after both stores are loaded; a stamped row is never
// touched, so a second run finds nothing and writes nothing.
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('../projects/project-schema');

const ZERO = Object.freeze({ stamped: 0, from_session: 0, general: 0 });

function resolveProjectId(followUp, sessionStore) {
  const sessionId = typeof followUp.sessionId === 'string' ? followUp.sessionId.trim() : '';
  if (!sessionId) return { projectId: GENERAL_PROJECT_ID, fromSession: false };
  const projectId = normalizeProjectId(sessionStore?.getSessionSummary?.(sessionId)?.project_id);
  return projectId
    ? { projectId, fromSession: true }
    : { projectId: GENERAL_PROJECT_ID, fromSession: false };
}

function backfillTaskBoardProjects({ configService, sessionStore, logger } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  try {
    const followUps = configService?.getState?.().followUps || [];
    const assignments = [];
    let fromSession = 0;
    for (const followUp of followUps) {
      if (followUp?.sourceKind !== 'agent_task' || followUp.projectId) continue;
      const { projectId, fromSession: live } = resolveProjectId(followUp, sessionStore);
      assignments.push({ id: followUp.id, projectId });
      if (live) fromSession += 1;
    }
    if (assignments.length === 0) return { ...ZERO };
    const { changed } = configService.stampFollowUpProjects(assignments);
    const counts = { stamped: changed, from_session: fromSession, general: assignments.length - fromSession };
    if (changed > 0) log('INFO', 'task_board.project_backfill', counts);
    return counts;
  } catch (error) {
    try {
      log('WARN', 'task_board.project_backfill_failed', { error: String(error?.message || error) });
    } catch (_logError) {
      // Logging must never break startup.
    }
    return { ...ZERO };
  }
}

module.exports = { backfillTaskBoardProjects };
