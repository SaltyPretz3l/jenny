// Per-method request-timeout policy for sidecar JSON-RPC requests.

const SHUTDOWN_TIMEOUT_MS = 5000;

// Per-method request timeouts in milliseconds. A method absent from this table
// falls back to DEFAULT_REQUEST_TIMEOUT_MS; an explicit caller-supplied
// timeoutMs overrides both (see resolveRequestTimeoutMs).
const REQUEST_TIMEOUT_MS_BY_METHOD = Object.freeze({
  initialize: 10_000,
  'background.run': 10_000,
  'models.list': 10_000,
  // Sidecar _UNLOAD_TIMEOUT = 30s (ollama_shared.py) plus 5s headroom keeps
  // the sidecar first to return a typed failure.
  'models.unload': 35_000,
  'memory.status': 5_000,
  'memory.save': 10_000,
  'memory.list': 10_000,
  'memory.pending.list': 10_000,
  'memory.pending.delete': 10_000,
  'memory.pending.accept': 10_000,
  'memory.update': 10_000,
  'memory.delete': 10_000,
  'memory.undo': 10_000,
  'memory.restore': 10_000,
  'memory.archive_project': 10_000,
  'memory.purge_session': 10_000,
  'memory.export_session': 10_000,
  'memory.import_session': 10_000,
  'memory.chat_sessions': 10_000,
  'memory.clear_suppressions': 10_000,
  // Settings > Memory page (row 58 W4).
  'memory.erase': 10_000,
  'memory.operations': 10_000,
  'memory.recall': 1_500,
  // Background reflection: one bounded local generation (max_tokens 700).
  'memory.reflect': 120_000,
  // Row 58 W4: the conversation index (derived, sidecar-owned) and embed steps.
  'memory.embed_step': 8_000,
  'conversations.index_state': 10_000,
  'conversations.index_session': 15_000,
  'conversations.purge': 10_000,
  'conversations.search': 5_000,
  // One embed request started inside the 1.5 s step budget may run 30 s on a CPU embedder.
  'conversations.embed_step': 35_000,
  'suggestions.generate': 8_000,
  'commit.generate_message': 30_000,
  'hardware.profile': 10_000,
  'hardware.vram_usage': 5_000,
  'models.resident': 3_000,
  'models.ollama_blob': 3_000,
  'harness.inspect': 10_000,
  'harness.turn_diagnostic': 10_000,
  'mcp.inspect': 20_000,
  'mcp.prompt_get': 30_000,
  'workspace.list_change_sets': 60_000,
  'workspace.preflight_undo': 300_000,
  'workspace.undo_change_set': 300_000,
  'workspace.reapply_change_set': 300_000,
  'workspace.restore_trash_entry': 300_000,
  'workspace.abandon_restore': 60_000,
  // Plan Plus C4: up to 20 journaled edits, plus a full undo on a mid-call failure.
  'workspace.apply_suggested_changes': 120_000,
  'chat.send': 360_000,
  // A bounded command (<= 300 s) plus its approval wait, which the transport timer is suspended for.
  'command.execute_proposal': 360_000,
  shutdown: SHUTDOWN_TIMEOUT_MS,
});

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Resolve the effective timeout for a request. A finite, positive
// caller-supplied `timeoutMs` wins (truncated to >= 1ms); any other explicit
// value (0, null, NaN, negative) disables the timeout entirely. Wrapper
// destructuring commonly forwards `undefined`; that means "not supplied" and
// must retain the method default rather than silently disabling it.
function resolveRequestTimeoutMs(method, options = {}) {
  if (
    Object.prototype.hasOwnProperty.call(options, 'timeoutMs')
    && options.timeoutMs !== undefined
  ) {
    const parsed = Number(options.timeoutMs);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(Math.trunc(parsed), 1) : null;
  }
  const defaultTimeout = REQUEST_TIMEOUT_MS_BY_METHOD[String(method || '').trim()];
  return Number.isFinite(defaultTimeout) && defaultTimeout > 0 ? defaultTimeout : DEFAULT_REQUEST_TIMEOUT_MS;
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS_BY_METHOD,
  SHUTDOWN_TIMEOUT_MS,
  resolveRequestTimeoutMs,
};
