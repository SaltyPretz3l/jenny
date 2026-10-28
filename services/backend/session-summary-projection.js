'use strict';

const { summarizeCompactionSnapshot } = require('./session-compaction-snapshot');
const { normalizeSpawnedFrom, isCoordinationContainerFrozen } = require('./session-coordination-records');
const { countFailedOutbox, countUnreadInbox } = require('./session-mail-records');
const { normalizeSessionRole } = require('./primary-session');

// Renderer-facing projection of a normalized session record (the "summary"
// carried by the session index and every `sessions:*` IPC reply). Extracted
// from ElectronSessionStore._toSummary so the projection has one reviewable
// owner and the store file stays under the size ceiling.
//
// The allowlist is the contract: only fields named here cross to the renderer.
// Message bodies, turn events, active-turn bookkeeping, and the compaction
// snapshot's replacement content deliberately never appear — `compaction_context`
// is the bounded projection of that snapshot, and `context_usage` is the
// bounded last-authoritative-reading seed for the composer context ring.
function buildSessionSummary(session) {
  const origin = normalizeSpawnedFrom(session.spawned_from);
  return {
    id: session.id,
    project_id: session.project_id,
    title: session.title,
    session_type: session.session_type,
    plugin_session: session.plugin_session ? {
      publisher_id: session.plugin_session.publisher_id,
      plugin_id: session.plugin_session.plugin_id,
      provider_contribution_id: session.plugin_session.provider_contribution_id,
      view_contribution_id: session.plugin_session.view_contribution_id,
      provider_name: session.plugin_session.provider_name,
      icon_token: session.plugin_session.icon_token,
      plugin_version_at_creation: session.plugin_session.plugin_version_at_creation,
      state_schema_version: session.plugin_session.state_schema_version,
      state_revision: session.plugin_session.state_revision,
    } : null,
    diagnostic_mode: session.diagnostic_mode,
    diagnostic_run_id: session.diagnostic_run_id,
    diagnostic_provider: session.diagnostic_provider,
    diagnostic_model: session.diagnostic_model,
    created_at: session.created_at,
    updated_at: session.updated_at,
    session_start_date: session.session_start_date,
    message_count: session.message_count,
    last_message_preview: session.last_message_preview,
    last_model_used: session.last_model_used,
    preferred_model: session.preferred_model,
    reasoning_effort: session.reasoning_effort,
    conversation_mode: session.conversation_mode,
    pending_question_batch: session.pending_question_batch,
    pending_plan_proposal: session.pending_plan_proposal || null,
    interactive_sequence_state: session.interactive_sequence_state,
    interactive_round_count: session.interactive_round_count,
    plan_mode: session.plan_mode,
    run_mode: session.run_mode,
    pre_plan_run_mode: session.pre_plan_run_mode,
    lockdown: session.lockdown === true,
    pinned: session.pinned === true,
    archived_at: session.archived_at || null,
    context_preferences: session.context_preferences,
    tool_category_overrides: session.tool_category_overrides,
    tool_connection_overrides: session.tool_connection_overrides,
    compaction_context: summarizeCompactionSnapshot(session.compaction_snapshot),
    context_usage: session.context_usage || null,
    linked_session_ids: session.linked_session_ids,
    linked_task_id: session.linked_task_id || '',
    branch_origin: session.branch_origin || null,
    spawned_from: origin?.schema_version === 1 ? {
      parent_session_id: origin.parent_session_id, proposal_id: origin.proposal_id, created_at: origin.created_at,
    } : null,
    coordination_revision: Number.isSafeInteger(session.coordination_revision) && session.coordination_revision >= 0
      ? session.coordination_revision : null,
    children_expanded: typeof session.workspace_view?.children_expanded === 'boolean'
      ? session.workspace_view.children_expanded : null,
    session_incarnation: typeof session.session_incarnation === 'string' && session.session_incarnation
      ? session.session_incarnation : null,
    // A linked child's "Report back to the original chat" switch; null for any other chat or a frozen container.
    reporting_enabled: origin?.schema_version === 1 && !isCoordinationContainerFrozen(session.session_mail)
      ? session.session_mail?.reporting_enabled === true : null,
    // Inbox messages the user has not seen yet; 0 when there is no mail or the container is frozen.
    unread_message_count: isCoordinationContainerFrozen(session.session_mail) ? 0 : countUnreadInbox(session.session_mail),
    // Sent messages that could not be delivered (the "Needs you" row); 0 when there is no mail or the container is frozen.
    failed_delivery_count: isCoordinationContainerFrozen(session.session_mail) ? 0 : countFailedOutbox(session.session_mail),
    // Addressed messages bind both incarnations; an imported or legacy chat gets one on its first turn.
    messaging_addressable: Boolean(String(session.session_incarnation || '').trim()),
    // Row 69: 'primary' on the profile's one Jenny chat, null on every other chat.
    session_role: normalizeSessionRole(session.session_role),
  };
}

module.exports = { buildSessionSummary };
