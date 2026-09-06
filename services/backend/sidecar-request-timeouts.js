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
  'memory.suggest': 5_000,
  'memory.status': 5_000,
  'memory.save': 10_000,
  'memory.list': 10_000,
  'memory.pending.list': 10_000,
  'memory.pending.delete': 10_000,
  'memory.update': 10_000,
  'memory.delete': 10_000,
  'memory.recall': 1_500,
  'memory.recall_recent': 1_500,
  'suggestions.generate': 8_000,
  'commit.generate_message': 30_000,
  'inline.complete': 4_000, // short cap; renderer debounces + cancels stale rounds
  'inline.loaded_models': 3_000, // cheap /api/ps read for the completion menu
  'inline.unload': 10_000, // keep_alive:0 evict of a specific FIM model
  'hardware.profile': 10_000,
  'hardware.vram_usage': 5_000,
  'models.resident': 3_000,
  'models.ollama_blob': 3_000,
  'harness.inspect': 10_000,
  'harness.turn_diagnostic': 10_000,
  'mcp.inspect': 20_000,
  'workspace.list_change_sets': 60_000,
  'workspace.preflight_undo': 300_000,
  'workspace.undo_change_set': 300_000,
  'workspace.restore_trash_entry': 300_000,
  'workspace.abandon_restore': 60_000,
  'chat.send': 360_000,
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
