/**
 * Application runtime inspection and explicit Send/resume operations.
 * Inspection never authorizes work. Submit/resume require a trusted sender.
 * Wire fields remain snake_case through preload and renderer boundaries.
 *
 * @typedef {Object} RuntimeSnapshotRequest
 * @property {string} [project_id]
 * @property {string} [session_id]
 * @property {string|null} [cursor] Revision-bound opaque pagination cursor.
 * @property {number} [limit] Integer from 1 to 100.
 */

/**
 * @typedef {Object} RuntimeWorkRequest
 * @property {string} work_id
 * @property {number} [child_offset] Bounded direct-child page offset, 0..512.
 * @property {number} [lineage_revision] Required revision for subsequent child pages.
 */

/**
 * @typedef {Object} RuntimeWorkSummary
 * @property {string} work_id
 * @property {string} turn_id Canonical logical turn reference.
 * @property {string} session_id Canonical transcript reference.
 * @property {string} project_id
 * @property {string} purpose
 * @property {'pending'|'running'|'paused'|'needs_attention'|'completed'|'failed'|'cancelled'} status
 * @property {number} revision
 * @property {number} submission_sequence
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} RuntimeApplicationError
 * @property {false} ok
 * @property {{code: string, reason: string}} error Stable reason; never raw caught error text.
 */

/**
 * @typedef {Object} RuntimeSubmissionRequest
 * @property {string} idempotency_key Stable client retry identity (1-128 token characters).
 * @property {string} session_id Existing canonical chat session.
 * @property {string} prompt Nonempty new user input.
 * @property {string} [visible_prompt]
 * @property {string} [preferred_model]
 * @property {string} [reasoning_effort]
 * @property {Array<Object>} [attachments] Canonical attachment descriptors/receipts.
 * @property {boolean} [plan_mode]
 * @property {Object} [context_preferences]
 * @property {Object} [active_file_context]
 * @property {Array<Object>} [mention_contents]
 * @property {Object} [tool_preferences]
 * @property {string} [approval_mode]
 * @property {Object} [debug_options]
 * @property {Object} [plugin_command_invocation]
 * @property {Object} [skill_invocation]
 */

/**
 * @typedef {RuntimeSubmissionRequest & {purpose: string, limits: {inference_requests: number, input_tokens: number, output_tokens: number}}} RuntimeStartRequest
 * Explicit Start requires all three finite positive integer limits (at most 1e12 each).
 * Purpose is nonempty and at most 256 characters; authority and root IDs are application-owned.
 */

/**
 * @typedef {Object} RuntimeSubmissionResult
 * @property {true} ok
 * @property {boolean} created False for an identical durable retry; never resumes work.
 * @property {string} work_id
 * @property {string} [root_run_id] Present only for explicit Start; stable across duplicate retries.
 * @property {string} turn_id
 * @property {string} session_id
 * @property {string} project_id
 * @property {number} revision
 * @property {string} status Durable status at acknowledgement; stream identity is absent.
 */

/**
 * @typedef {Object} RuntimeResumeRequest
 * Used by explicit resume, cancel and pause; pause returns requested until safe settlement.
 * @property {string} work_id
 * @property {number} expected_revision Positive current work revision.
 */

/**
 * @typedef {RuntimeResumeRequest & {prompt: string}} RuntimePendingUpdateRequest
 * Updates only never-attempted pending/paused instructions. Preserves authority and
 * root grants; changes the current submission hash, so the original Send conflicts.
 * Paused edits never resume work.
 */
/**
 * @typedef {Object} RuntimeLimitsUpdateRequest
 * @property {Object} expected_limits Exact configured local/cloud/resource limits.
 * @property {Object} patch Closed sessionRuntime configuration patch.
 * Persists before applying admission limits; existing leases remain held.
 */
/**
 * @typedef {Object} RuntimeResultRequest
 * @property {string} work_id
 * Returns a canonical session/turn reference only for terminal work; no result body.
 */
/**
 * Runtime work detail includes a bounded coordination projection: direct children
 * (50/page), parent/root references, charged/limit counters, checkpoint progress,
 * pause/resource/dependency wait reason, editability and confirmed cleanup state.
 * Checkpoint bodies, prompts, grants and authority fingerprints are never exposed.
 * Managed started events carry runtimeAdmission with work_id, turn_id, session_id,
 * stream_id, user_message_id and idempotency_key. Reconcile this exact identity in
 * the ordered stream mailbox before content; a submission acknowledgement has no stream.
 */
module.exports = {};
