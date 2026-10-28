'use strict';

// Scope of the conversations_* tools (row 58, widened by row 69). An ordinary
// chat sees its own trusted project; the profile's primary Jenny chat sees every
// project. The widening is derived only from trusted state: the live call
// binding (checkLiveCall) must name the caller, and the caller's canonical
// summary must carry session_role 'primary'. Tool arguments never widen it.
// The hidden-chat exclusions (caller, lockdown, opt-out, plugin, diagnostic,
// runtime child, empty) hold in every scope, and the primary chat itself (whose
// transcript spans every project) is never a result.

const { normalizeProjectId } = require('../../projects/project-schema');
const { visibleChatPredicate } = require('../../backend/memory-reflection-eligibility');
const { isPrimaryRole, primaryChatEnabled } = require('../../backend/primary-session');
const { projectIdOf } = require('./conversation-text');
const { checkLiveCall } = require('./propose-tool-support');

// -> { all_projects, project_id } (project_id null when there is no trusted project).
function resolveConversationsScope(context, callerSummary) {
  const projectId = normalizeProjectId(context?.projectAuthority?.project_id) || null;
  if (!projectId || !primaryChatEnabled(context?.backendService?.featureFlags) || !isPrimaryRole(callerSummary)) {
    return { all_projects: false, project_id: projectId };
  }
  const live = checkLiveCall(context);
  return { all_projects: live.ok === true && callerSummary.id === live.sessionId, project_id: projectId };
}

// The lineage-backed predicate is built on first use, so a call that finds
// no candidate (empty search, unknown id) never exports the lineage snapshot.
function visibleFilter(service, scope, callerSessionId) {
  let visibleChat = null;
  return summary => Boolean(summary) && summary.id !== callerSessionId && !summary.lockdown
    && !isPrimaryRole(summary)
    && (scope.all_projects === true || projectIdOf(summary.project_id) === scope.project_id)
    && summary.message_count > 0
    && (visibleChat ||= visibleChatPredicate(service))(summary);
}

module.exports = { resolveConversationsScope, visibleFilter };
