'use strict';

// Every reason word the member's shared-project client (row 123 slice 3-9) can answer a call with or push, closed:
// its own refusals and the host reasons its operations pass through. The renderer has a sentence for each
// (tests/renderer-settings-team-strings.test.js reads this list; the same test fails on a reason word in the client's
// source that is missing here). A lease push's `released` and `control_changed` are states, not failures.

const { LEASE_ENDING, VIEW_ENDING } = require('./project-conversations');

const CLIENT = Object.freeze([
  'team_request_invalid', 'team_answer_invalid', 'team_envelope_invalid', 'team_not_connected', 'team_not_found',
  'team_disposed', 'team_force_local', 'team_connection_stopped', 'team_conversation_limit', 'team_conversation_not_open',
  'team_conversation_open', 'team_transfer_busy', 'team_transfer_failed', 'team_upload_empty', 'team_upload_changed',
  'team_upload_unreadable', 'team_download_changed', 'team_download_folder_invalid', 'team_download_folder_not_empty',
  'team_download_write_failed',
  // Row 175 (F6): the box text kept on this PC cannot be written (the team's folder is gone or newer).
  'team_project_drafts_unavailable',
]);

const HOST = Object.freeze([
  'approval_unattended', 'approval_not_viewing', 'approval_prompter_unknown', 'backend_unavailable', 'control_turn_active',
  'decision_stale', 'disk_pressure', 'project_not_found', 'revision_conflict', 'role_forbidden', 'session_not_found',
  'team_rate_limit', 'team_project_busy', 'team_project_read_only', 'team_project_files_unavailable',
  'team_project_deleting', 'team_project_last_admin', 'team_project_limit', 'team_project_exists',
  'team_project_name_invalid', 'team_project_member_exists', 'team_project_role_capped', 'team_project_role_invalid',
  'team_project_path_invalid', 'team_project_quota', 'team_project_root_unavailable', 'team_upload_file_limit',
  'team_upload_size_limit', 'team_upload_manifest_invalid', 'team_upload_stale', 'team_upload_limit',
  'team_upload_hash_mismatch', 'team_upload_staging_failed', 'team_upload_target_exists',
  // Slice 3-10: "Always allowed" (team.project.rules.*, approval.resolve's `always` and its `always_result`).
  'team_rules_unavailable', 'team_rules_full', 'team_rules_invalid', 'team_rule_limit', 'team_rule_exists',
  'team_rule_request_limit', 'team_rule_request_not_found', 'team_rule_not_found', 'team_rule_folder_invalid',
  'team_rule_reason_invalid', 'team_rule_answer_invalid', 'team_rule_always_invalid', 'team_rule_tool_invalid',
  'team_rule_no_project', 'team_audit_unavailable',
  // Row 175 round 2b: regenerate, edit and resend, branch, ask a teammate, hand the seat, plan decisions.
  'team_turn_not_latest', 'team_redo_forbidden', 'session_active', 'runtime_unavailable', 'runtime_submission_refused',
  'operation_indeterminate', 'team_branch_refused', 'session_capacity', 'team_member_unavailable', 'team_hand_refused',
  'plan_decision_invalid', 'team_redo_attachments', 'application_turn_retry_refused', 'handoff_preparation_retry_refused',
]);

const PROJECT_REASONS = Object.freeze([...new Set([...CLIENT, ...HOST, ...LEASE_ENDING, ...VIEW_ENDING])]);

module.exports = { PROJECT_REASONS };
