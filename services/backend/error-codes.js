// Node-side peer registry for CMP-* error codes.
// Canonical full registry is documented in docs/operations/error-codes.md.
// Python-side constants live in sidecar/ai/error_codes.py.
// Codes defined here are emitted by Node-side modules (sidecar transport, interactive
// protocol, chat/loop transcript validation) and never raised by the sidecar Python
// process — keeping them in this module prevents string-literal drift across services/backend.

const SIDECAR_ERROR_CODES = Object.freeze({
  TIMEOUT: 'CMP-SIDECAR-0001',
  ABORTED: 'CMP-SIDECAR-0002',
  PROCESS_EXIT: 'CMP-SIDECAR-0003',
  TRANSPORT: 'CMP-SIDECAR-0004',
  RPC: 'CMP-SIDECAR-0005',
});

// Vocabulary contract: terminal_subcode tags emitted on assistant_error rows
// for managed-sidecar failure paths. These are the canonical strings consumed
// by recovery routing in chat-error-recovery.js — keep producers and the
// classifier in lockstep by importing from here rather than inlining literals.
const SIDECAR_TERMINAL_SUBCODES = Object.freeze({
  CRASH: 'sidecar_crash',
  RECONNECT_FAILED: 'sidecar_reconnect_failed',
  RECONNECT_IN_PROGRESS: 'sidecar_reconnect_in_progress',
  TURN_TIMEOUT: 'turn',
});

const INTERACTIVE_ERROR_CODES = Object.freeze({
  MIXED_TEXT_AND_BATCH: 'CMP-INTERACTIVE-0001',
  INVALID_BATCH_PAYLOAD: 'CMP-INTERACTIVE-0002',
  TEXT_AFTER_BATCH: 'CMP-INTERACTIVE-0003',
  // Wave F plan-proposal protocol (terminal sibling of the question batch).
  // Retired with the plan_proposal live path; numbers reserved.
  MIXED_TEXT_AND_PROPOSAL: 'CMP-INTERACTIVE-0004',
  INVALID_PROPOSAL_PAYLOAD: 'CMP-INTERACTIVE-0005',
  INVALID_CONTINUATION: 'CMP-INTERACTIVE-0006',
});

const CHAT_PROTOCOL_ERROR_CODES = Object.freeze({
  INVALID_PAYLOAD: 'CMP-CHAT-0001',
  REASONING_AFTER_VISIBLE: 'CMP-CHAT-0013',
});

const STREAM_ERROR_CODES = Object.freeze({
  REASONING_ONLY: 'CMP-STREAM-REASONING-ONLY',
  // Provider stream ended with no terminal evidence (EOF before Ollama's `done`
  // chunk or vLLM's [DONE] sentinel), or carried an in-band error frame.
  INCOMPLETE: 'CMP-STREAM-INCOMPLETE',
});

const AI_ERROR_CODES = Object.freeze({
  ENGINE_CONNECTION: 'CMP-AI-0002',
  RATE_LIMIT: 'CMP-AI-0003',
});

const CLOUD_ERROR_CODES = Object.freeze({
  RATE_LIMITED: 'CMP-CLOUD-1001',
  // HTTP_ERROR is every cloud non-2xx (401, 5xx, context_overflow), so it can
  // NEVER identify an expired credential on its own — pair it with
  // PROVIDER_CLASSIFICATIONS.INVALID_API_KEY, which the sidecar threads through
  // ToolExecutionFailure.error_details for exactly that reason.
  HTTP_ERROR: 'CMP-CLOUD-1003',
});

// Sidecar JSON-RPC protocol errors surfaced on error.rpc.data.code (not
// data.error_code — server_chat_workers.py builds this envelope by hand).
const PROTOCOL_ERROR_CODES = Object.freeze({
  DUPLICATE_REQUEST_ID: 'CMP-PROTO-0002',
});

// Provider-failure classifications carried on error.rpc.data.classification by
// the sidecar's ProviderHttpError branch. Not CMP codes — a separate vocabulary
// that discriminates WHICH failure a cloud provider_code stands for.
const PROVIDER_CLASSIFICATIONS = Object.freeze({
  INVALID_API_KEY: 'invalid_api_key',
});

const LOOP_PROTOCOL_ERROR_CODES = Object.freeze({
  MAX_ITERATIONS: 'CMP-LOOP-0001',
  INVALID_TOOL_CALL: 'CMP-LOOP-0002',
  // CMP-LOOP-0004 is permanently reserved and must not be reused because mixed
  // text plus tool_calls is legal.
  TEXT_AND_TOOL_CALLS: 'CMP-LOOP-0004',
  BUDGET_EXCEEDED: 'CMP-LOOP-0011',
  TOOL_INTERRUPTED: 'CMP-LOOP-0013',
  REPEATED_ERRORS: 'CMP-LOOP-0017',
  REPEATED_OBSERVATIONS: 'CMP-LOOP-0018',
  STUCK_SUSPECTED: 'CMP-LOOP-0019',
});

const HARNESS_ERROR_CODES = Object.freeze({
  TURN_NOT_FOUND: 'CMP-HARN-0001',
});

// Composer spellcheck context menu (services/main/spellcheck-menu-bridge.js).
// Both correction channels resolve { ok, code } rather than throwing across
// the preload seam, so these codes are the whole failure vocabulary.
const SPELLCHECK_ERROR_CODES = Object.freeze({
  INVALID_WORD: 'CMP-SPELL-0001',
  UNAVAILABLE: 'CMP-SPELL-0002',
  NATIVE_FAILED: 'CMP-SPELL-0003',
});

// Personality workspace (services/personality-workspace-service.js and its
// v2 -> v3 migration). Every personality IPC resolves a bounded
// { ok, code, failed } envelope rather than throwing across the preload seam,
// so these three are the whole failure vocabulary.
const PERSONALITY_ERROR_CODES = Object.freeze({
  SAVE_PARTIAL_FAILURE: 'CMP-PERS-0001',
  FILE_TOO_LARGE: 'CMP-PERS-0002',
  MIGRATION_ROLLED_BACK: 'CMP-PERS-0003',
});

const APPROVAL_ERROR_CODES = Object.freeze({
  REJECTED: 'CMP-APPROVAL-REJECTED',
});

const TOOL_ERROR_CODES = Object.freeze({
  APPROVAL_DENIED: 'CMP-TOOL-0001',
  DISABLED: 'CMP-TOOL-0002',
  UNKNOWN: 'CMP-TOOL-0005',
  COMMAND_BLOCKED: 'CMP-TOOL-0007',
  EXECUTION_FAILED: 'CMP-TOOL-0008',
  POLICY_DENIED: 'CMP-TOOL-0039',
  // Sibling call admitted into the turn budget but left outside the approval
  // resume window; emitted so the drop is explicit rather than silent.
  APPROVAL_WINDOW_DROPPED: 'CMP-TOOL-0042',
  // Sidecar settled the call before dispatch because its arguments were the
  // schema example placeholders the tool prompt shows, not real values.
  PLACEHOLDER_ARGUMENTS_REJECTED: 'CMP-TOOL-0044',
});

const PERSIST_ERROR_CODES = Object.freeze({
  IMPORT_PARSE_ERROR: 'CMP-PERSIST-0001',
  IMPORT_FORMAT_MISMATCH: 'CMP-PERSIST-0002',
  IMPORT_ATTACHMENT_FAILED: 'CMP-PERSIST-0003',
});

const ARTIFACT_ERROR_CODES = Object.freeze({
  WORKSPACE_ROOT_MISSING: 'CMP-ARTIFACT-0001',
  WORKSPACE_ROOT_UNAVAILABLE: 'CMP-ARTIFACT-0002',
  EXTENSION_INVALID: 'CMP-ARTIFACT-0003',
  PATH_OUTSIDE_ROOT: 'CMP-ARTIFACT-0004',
  PATH_OUTSIDE_SCRATCH: 'CMP-ARTIFACT-0005',
  REAL_PATH_ESCAPES: 'CMP-ARTIFACT-0006',
  NOT_EDITABLE: 'CMP-ARTIFACT-0007',
  OVERSIZED: 'CMP-ARTIFACT-0008',
  FILE_UNAVAILABLE: 'CMP-ARTIFACT-0009',
  NOT_FOUND: 'CMP-ARTIFACT-0010',
  REVEAL_UNAVAILABLE: 'CMP-ARTIFACT-0011',
  OPEN_UNAVAILABLE: 'CMP-ARTIFACT-0012',
  DANGEROUS_EXTENSION: 'CMP-ARTIFACT-0013',
  INVALID_SESSION: 'CMP-ARTIFACT-0014',
  INVALID_ARTIFACT_ID: 'CMP-ARTIFACT-0015',
  // The configured tools workspace root resolves to Jenny's own .jenny state
  // directory (e.g. persisted before the workspace-root-coordinator guard
  // existed). Every consumer appends its own .jenny/... suffix, so using it
  // as a root would materialize a doubled .jenny/.jenny/... tree.
  WORKSPACE_ROOT_STATE_DIR: 'CMP-ARTIFACT-0016',
});

// Workspace IDE page filesystem access (renderer-initiated, root-scoped).
// 0008-0009 are root-generation leases, 0013 is strict text encoding,
// 0021-0023 are atomic-write seams, 0030s are create/rename/delete, 0050s
// are search/watch, and 0060s are OS shell integration.
const WORKSPACE_FS_ERROR_CODES = Object.freeze({
  ROOT_MISSING: 'CMP-WORKSPACEFS-0001',
  // 0007: root is configured but absent/not a directory on disk. Mutators must
  // refuse with this instead of recreating the root via recursive mkdir.
  ROOT_INVALID: 'CMP-WORKSPACEFS-0007',
  ROOT_TRANSITIONING: 'CMP-WORKSPACEFS-0008',
  STALE_GENERATION: 'CMP-WORKSPACEFS-0009',
  PATH_INVALID: 'CMP-WORKSPACEFS-0002',
  PATH_OUTSIDE_ROOT: 'CMP-WORKSPACEFS-0003',
  NOT_FOUND: 'CMP-WORKSPACEFS-0004',
  NOT_A_FILE: 'CMP-WORKSPACEFS-0005',
  NOT_A_DIRECTORY: 'CMP-WORKSPACEFS-0006',
  BINARY: 'CMP-WORKSPACEFS-0010',
  TOO_LARGE: 'CMP-WORKSPACEFS-0011',
  IMAGE_TOO_LARGE: 'CMP-WORKSPACEFS-0012',
  UNSUPPORTED_ENCODING: 'CMP-WORKSPACEFS-0013',
  IMAGE_UNSUPPORTED: 'CMP-WORKSPACEFS-0014',
  WRITE_CONFLICT: 'CMP-WORKSPACEFS-0020',
  ATOMIC_WRITE_FAILED: 'CMP-WORKSPACEFS-0021',
  IO_FAILED: 'CMP-WORKSPACEFS-0022',
  WRITE_QUEUE_FULL: 'CMP-WORKSPACEFS-0023',
  EXISTS: 'CMP-WORKSPACEFS-0030',
  TRASH_FAILED: 'CMP-WORKSPACEFS-0040',
  WATCH_FAILED: 'CMP-WORKSPACEFS-0050',
  REVEAL_UNAVAILABLE: 'CMP-WORKSPACEFS-0060',
  OPEN_UNAVAILABLE: 'CMP-WORKSPACEFS-0061',
  OPEN_FAILED: 'CMP-WORKSPACEFS-0062',
});

// Workspace IDE integrated terminal (renderer-initiated, root-scoped cwd).
const TERMINAL_ERROR_CODES = Object.freeze({
  SPAWN_FAILED: 'CMP-TERMINAL-0001',
  ROOT_MISSING: 'CMP-TERMINAL-0002',
  NO_SESSION: 'CMP-TERMINAL-0003',
  // 0004: the @lydell/node-pty native module failed to load (missing prebuild
  // / electron ABI mismatch). Emitted only by the real ConPTY WorkspacePtyService
  // fail-soft path; the piped WorkspaceTerminalService never raises it.
  MODULE_LOAD_FAILED: 'CMP-TERMINAL-0004',
});

// Workspace IDE SCM foundation (renderer-initiated, root-scoped, default-off).
// 0001 root precondition, 0004 root is not the repository toplevel (destructive
// verbs refuse; carried on ok:false structured results, not raised),
// 0002-0003 path containment, 0010-0011 ref/range
// validation, 0020 commit-message validation, 0040 git subprocess failure.
// NOTE: "not a git repository", a disabled feature flag, and "nothing to
// commit" are NOT error codes - they degrade to clean structured results
// (isRepo:false / available:false / committed:false) and are never raised.
const WORKSPACE_GIT_ERROR_CODES = Object.freeze({
  ROOT_MISSING: 'CMP-GIT-0001',
  GIT_NOT_TOPLEVEL: 'CMP-GIT-0004',
  PATH_INVALID: 'CMP-GIT-0002',
  PATH_OUTSIDE_ROOT: 'CMP-GIT-0003',
  REF_INVALID: 'CMP-GIT-0010',
  LINE_RANGE_INVALID: 'CMP-GIT-0011',
  COMMIT_MESSAGE_EMPTY: 'CMP-GIT-0020',
  GIT_COMMAND_FAILED: 'CMP-GIT-0040',
});

// Workspace IDE Test Runner (renderer-initiated, root-scoped, default-off).
// 0001 root precondition, 0002 unknown config id, 0003 cwd escapes the workspace
// root (realpath containment), 0010 single-run lock, 0030 shell spawn failure.
// NOTE: a config whose suite ran and FAILED is NOT an error code - it degrades to
// a structured run record with status:'failed'; only the codes below are raised as
// a CMP envelope (or set on a run record's errorCode when the process never
// started, status:'error').
const WORKSPACE_TEST_RUNNER_ERROR_CODES = Object.freeze({
  ROOT_MISSING: 'CMP-TESTRUNNER-0001',
  CONFIG_NOT_FOUND: 'CMP-TESTRUNNER-0002',
  CWD_OUTSIDE_ROOT: 'CMP-TESTRUNNER-0003',
  // WIDE-032: saveConfigs refuses to persist a set that drops the config with an
  // active run, so its Stop control can never go stale/unreachable.
  CONFIG_ACTIVE_RUN: 'CMP-TESTRUNNER-0004',
  ALREADY_RUNNING: 'CMP-TESTRUNNER-0010',
  SPAWN_FAILED: 'CMP-TESTRUNNER-0030',
});

// Workspace IDE "Run scripts" task execution (UIUX-014: main-owned task
// identity/exit — renderer markers are never authoritative). 0001 root
// precondition, 0010 single-task lock, 0030 shell spawn failure, 0040 no
// matching active task (stale/unknown taskId on kill).
const RUN_TASK_ERROR_CODES = Object.freeze({
  ROOT_MISSING: 'CMP-RUNTASK-0001',
  ALREADY_RUNNING: 'CMP-RUNTASK-0010',
  SPAWN_FAILED: 'CMP-RUNTASK-0030',
  NO_TASK: 'CMP-RUNTASK-0040',
});

const PROACTIVE_ERROR_CODES = Object.freeze({
  REMINDER_INVALID: 'CMP-PROACTIVE-0001',
});

const MCP_ERROR_CODES = Object.freeze({
  CONFIG_INVALID: 'CMP-MCP-0001',
  SSE_DISABLED: 'CMP-MCP-0002',
  TOOL_NOT_FOUND: 'CMP-MCP-0003',
  SERVER_FAILED: 'CMP-MCP-0004',
  PROTOCOL_FAILED: 'CMP-MCP-0005',
  RESOURCE_UNSUPPORTED: 'CMP-MCP-0006',
  RESOURCE_NOT_FOUND: 'CMP-MCP-0007',
  RESOURCE_INVALID: 'CMP-MCP-0008',
  TOOL_SURFACE_CHANGED: 'CMP-MCP-0009',
});

// services/plugins/** must import these constants; inline CMP literals are
// policy-banned.
// Range allocations live in docs/operations/error-codes.md.
const PLUGIN_ERROR_CODES = Object.freeze({
  MANIFEST_INVALID: 'CMP-PLUGIN-0001',
  UNSUPPORTED_CONTRACT_VERSION: 'CMP-PLUGIN-0002',
  ARCHIVE_REJECTED: 'CMP-PLUGIN-0003',
  INTEGRITY_FAILED: 'CMP-PLUGIN-0004',
  SIGNATURE_INVALID: 'CMP-PLUGIN-0005',
  PUBLISHER_UNTRUSTED: 'CMP-PLUGIN-0006',
  GENERATION_INVALID: 'CMP-PLUGIN-0007',
  POINTER_CORRUPT: 'CMP-PLUGIN-0008',
  EPOCH_REGRESSION: 'CMP-PLUGIN-0009',
  LEASE_BUSY: 'CMP-PLUGIN-0010',
  EXPECTED_GENERATION_CONFLICT: 'CMP-PLUGIN-0011',
  IDEMPOTENCY_EXPIRED: 'CMP-PLUGIN-0012',
  OUTCOME_INDETERMINATE: 'CMP-PLUGIN-0013',
  FINGERPRINT_MISMATCH: 'CMP-PLUGIN-0014',
  POLICY_BLOCKED: 'CMP-PLUGIN-0015',
  QUARANTINED: 'CMP-PLUGIN-0016',
  DEPENDENCY_UNSATISFIED: 'CMP-PLUGIN-0017',
  DATA_INCOMPATIBLE: 'CMP-PLUGIN-0018',
  CLEANUP_PENDING_RESTART: 'CMP-PLUGIN-0019',
  CLEANUP_TERMINATION_FAILED: 'CMP-PLUGIN-0020',
  SAFE_MODE_ACTIVE: 'CMP-PLUGIN-0021',
  FEATURE_DISABLED: 'CMP-PLUGIN-0022',
  CONSENT_REQUIRED: 'CMP-PLUGIN-0023',
  CONSENT_ORIGIN_INVALID: 'CMP-PLUGIN-0024',
  STORE_WRITE_FAILED: 'CMP-PLUGIN-0025',
  SOURCE_UNAVAILABLE: 'CMP-PLUGIN-0026',
  UPDATE_METADATA_INVALID: 'CMP-PLUGIN-0027',
  ROLLBACK_OR_FREEZE_DETECTED: 'CMP-PLUGIN-0028',
  ADVISORY_BLOCKED: 'CMP-PLUGIN-0029',
  REMOTE_AUTH_REQUIRED: 'CMP-PLUGIN-0030',
  REMOTE_AUTH_FAILED: 'CMP-PLUGIN-0031',
  REMOTE_PROTOCOL_UNSUPPORTED: 'CMP-PLUGIN-0032',
  REMOTE_TRANSPORT_FAILED: 'CMP-PLUGIN-0033',
  OPERATION_CANCELLED: 'CMP-PLUGIN-0034',
  RESOURCE_LIMIT_EXCEEDED: 'CMP-PLUGIN-0035',
});

const COMPANION_ERROR_CODES = Object.freeze({
  FOLLOW_UP_INVALID: 'CMP-COMPANION-0001',
});

const DATA_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'CMP-DATA-0001',
  BUSY: 'CMP-DATA-0002',
  UNSAFE_PATH: 'CMP-DATA-0003',
  SOURCE_UNREADABLE: 'CMP-DATA-0004',
  INSUFFICIENT_SPACE: 'CMP-DATA-0005',
  AUTHENTICATION_FAILED: 'CMP-DATA-0006',
  ARCHIVE_CORRUPT: 'CMP-DATA-0007',
  UNSUPPORTED_VERSION: 'CMP-DATA-0008',
  RESTORE_CONFLICT: 'CMP-DATA-0009',
  CLEANUP_INCOMPLETE: 'CMP-DATA-0010',
});

const SETUP_ERROR_CODES = Object.freeze({
  ENDPOINT_INVALID: 'CMP-SETUP-0001',
  ENDPOINT_TIMEOUT: 'CMP-SETUP-0002',
  CONFIG_REFRESH_FAILED: 'CMP-SETUP-0003',
  TERMINATION_FAILED: 'CMP-SETUP-0004',
});

module.exports = {
  AI_ERROR_CODES,
  SIDECAR_ERROR_CODES,
  SIDECAR_TERMINAL_SUBCODES,
  APPROVAL_ERROR_CODES,
  CLOUD_ERROR_CODES,
  INTERACTIVE_ERROR_CODES,
  CHAT_PROTOCOL_ERROR_CODES,
  STREAM_ERROR_CODES,
  LOOP_PROTOCOL_ERROR_CODES,
  MCP_ERROR_CODES,
  COMPANION_ERROR_CODES,
  DATA_ERROR_CODES,
  SETUP_ERROR_CODES,
  SPELLCHECK_ERROR_CODES,
  HARNESS_ERROR_CODES,
  ARTIFACT_ERROR_CODES,
  PERSIST_ERROR_CODES,
  PERSONALITY_ERROR_CODES,
  PLUGIN_ERROR_CODES,
  PROACTIVE_ERROR_CODES,
  PROTOCOL_ERROR_CODES,
  PROVIDER_CLASSIFICATIONS,
  RUN_TASK_ERROR_CODES,
  TERMINAL_ERROR_CODES,
  TOOL_ERROR_CODES,
  WORKSPACE_FS_ERROR_CODES,
  WORKSPACE_GIT_ERROR_CODES,
  WORKSPACE_TEST_RUNNER_ERROR_CODES,
};
