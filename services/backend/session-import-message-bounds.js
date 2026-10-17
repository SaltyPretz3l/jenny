/**
 * Message-level bounds for session import and archive restore.
 *
 * An imported message keeps only the top-level keys below and may not carry an
 * oversized string anywhere inside it. Session-level unknown keys are already
 * dropped by normalizeSession; message normalization spreads unknown keys
 * through, so import strips them here first.
 */

// Admitted top-level message keys.
// - Emitted by normalizeMessageFields / normalizeMessage (message-normalization.js,
//   electron-session-store.js), so every key exportSession writes survives restore.
// - turnId, parentStreamId: camelCase aliases normalizeMessageFields reads.
// - Persisted through the normalization spread by live writers, so real archives
//   carry them: terminal_status, error_code, retryable, category and the recovery_*
//   / next_action* fields (chat-stream-session-lifecycle.js failure rows via
//   chat-error-recovery.js; session-turn-actor.js interrupted rows), resumable_stop
//   (chat-stream-discarded-drafts.js), reasoning_phases (chat-transcript-phase-
//   collector.js) and plan_document (plan-document-events.js).
// - Legacy keys seen in release-compat fixtures or read by migrations/readers:
//   messageReactions (v12 migration), created_at, category, stream_error
//   (session-shadow-store.js, renderer turn tree), action_target_message_id and
//   target_message_id (v9 repair, turn-actor and terminal-repair readers).
const IMPORTED_MESSAGE_KEY_ALLOWLIST = Object.freeze(new Set([
  'id', 'role', 'kind', 'content', 'status', 'terminal_subcode', 'timestamp',
  'model_used', 'client_message_id', 'parent_stream_id', 'event_seq', 'turn_id',
  'phases', 'visible_segments', 'tool_steps', 'reasoning', 'attachments',
  'interactive_batch', 'tool_call', 'tool_result', 'proactive_suggestion', 'memory_note',
  'skill_invocation', 'plugin_operation', 'message_reactions', 'context_compactions',
  'context_compacted', 'discarded_drafts', 'finalizedAt', 'interactive_round_recap',
  'turnId', 'parentStreamId',
  'terminal_status', 'error_code', 'retryable', 'recovery_class', 'next_action',
  'next_action_label', 'recovery_title', 'recovery_hint', 'recovery_actions',
  'resumable_stop', 'completion_reason', 'completion_proposal_id', 'reasoning_phases', 'plan_document',
  // Addressed session messages (role:'context'): re-validated strictly by message normalization,
  // which drops any row whose envelope, content or id does not check out.
  'session_message', 'session_handoff', 'disposition',
  'messageReactions', 'created_at', 'category', 'stream_error',
  'action_target_message_id', 'target_message_id',
]));

const MAX_IMPORTED_MESSAGE_TEXT_CHARS = 2_000_000;
const MAX_IMPORTED_MESSAGE_FIELD_CHARS = 65_536;

// Paths (array indices collapsed to []) bounded by the text limit. content and
// tool_result.output_text are the model/tool output; the transcript fields mirror
// that output (content is the join of visible segment text) and the legacy
// pre-HB-012 tool_call.model_input_json carried raw model arguments, so a field
// cap tighter than content would reject legitimate long answers on restore.
const TEXT_LIMIT_PATHS = new Set([
  'content',
  'tool_result.output_text',
  'visible_segments[].text',
  'phases[].entries[].text',
  'reasoning.entries[].text',
  'tool_call.model_input_json',
]);

// Bounded by the attachment decoder at the asset-store limits instead.
const EXEMPT_PATHS = new Set(['attachments[]._exportedData', 'attachments[]._exportedMime']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripUnknownImportedMessageKeys(message) {
  const source = isPlainObject(message) ? message : {};
  const clean = {};
  const strippedKeys = [];
  for (const key of Object.keys(source)) {
    if (IMPORTED_MESSAGE_KEY_ALLOWLIST.has(key)) clean[key] = source[key];
    else strippedKeys.push(key);
  }
  return { message: clean, strippedKeys: strippedKeys.sort() };
}

function findOversizedImportedMessageString(message) {
  // Iterative depth-first walk: a crafted deeply nested payload cannot exhaust
  // the call stack. Children are pushed in reverse so they pop in key order.
  const stack = [{ value: message, path: '', shape: '' }];
  const seen = new Set();
  while (stack.length) {
    const { value, path, shape } = stack.pop();
    if (typeof value === 'string') {
      if (EXEMPT_PATHS.has(shape)) continue;
      const limit = TEXT_LIMIT_PATHS.has(shape)
        ? MAX_IMPORTED_MESSAGE_TEXT_CHARS
        : MAX_IMPORTED_MESSAGE_FIELD_CHARS;
      if (value.length > limit) return { path, length: value.length, limit };
      continue;
    }
    if (!Array.isArray(value) && !isPlainObject(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    const children = Array.isArray(value)
      ? value.map((item, index) => ({ value: item, path: `${path}[${index}]`, shape: `${shape}[]` }))
      : Object.keys(value).map((key) => ({
          value: value[key],
          path: path ? `${path}.${key}` : key,
          shape: shape ? `${shape}.${key}` : key,
        }));
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return null;
}

module.exports = {
  IMPORTED_MESSAGE_KEY_ALLOWLIST,
  MAX_IMPORTED_MESSAGE_TEXT_CHARS,
  MAX_IMPORTED_MESSAGE_FIELD_CHARS,
  stripUnknownImportedMessageKeys,
  findOversizedImportedMessageString,
};
