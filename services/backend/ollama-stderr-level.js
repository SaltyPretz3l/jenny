// Classifies Ollama process output for structured logging. Unstructured stderr
// defaults to INFO because llama.cpp emits extensive routine chatter there;
// anomaly tokens preserve the caller's default level as a warning backstop.

const {
  resolveStructuredLogLevel,
} = require('./child-process-logging');
const {
  isFatalOllamaStderrLine,
} = require('./ollama-crash-diagnostics');

const BENIGN_OLLAMA_STDERR_PATTERNS = [
  /^load_backend:\s+loaded\s+.+\s+backend\s+from\s+/i,
  /^ggml_cuda_init:\s+GGML_CUDA_FORCE_(?:MMQ|CUBLAS):\s+\S+/i,
  /^ggml_cuda_init:\s+found\s+\d+\s+CUDA\s+devices?:/i,
  /^Device\s+\d+:\s+/i,
  // Boot/init + per-request server-loop churn from the embedded llama.cpp server,
  // all emitted on stderr without a structured `level=` token: the model-load
  // notice (`srv  load_model: loading model '<path>'`), the Gin HTTP access log,
  // the `srv  <fn>:` server-loop lifecycle (e.g. "update_slots: all slots are
  // idle"), and the `slot  <verb>:` per-slot lifecycle (launch/update/release/
  // print_timing). These are normal traffic, not warnings — a single chat turn
  // emits a flood of them, which otherwise sinks to the stderr-default WARN and
  // buries real signal in Diagnostics. Genuinely-fatal stderr (port bind,
  // CUDA/VRAM, model-load failure) is caught by isFatalOllamaStderrLine() *before*
  // this list and escalated to ERROR, so demoting the whole `srv`/`slot` prefix
  // space here cannot mask a fatal line.
  /^\[GIN\]\s/,
  /^(?:srv|slot|cmn)\s+\S+:/i,
];

const OLLAMA_STDERR_ANOMALY_TOKEN_PATTERN =
  /\b(?:err(?:or)?s?|errno|fail(?:s|ed|ing|ure|ures)?|warn(?:ing)?s?|cannot|unable|invalid|refused|denied|timeout|timed\s+out|deprecat\w*|retry|abort\w*|panic|fatal|corrupt\w*|missing|unsupported)\b/i;
const JENNY_OLLAMA_POLL_ACCESS_LOG_PATTERN =
  /^\[GIN\]\s+\S+\s+-\s+\S+\s+\|\s+2\d{2}\s+\|[^|]*\|[^|]*\|\s+(?:GET|HEAD)\s+"\/api\/(?:tags|version|ps)(?:\?[^"]*)?"\s*$/i;

function resolveOllamaOutputLevel({ line, stream, defaultLevel }) {
  if (stream !== 'stderr') {
    return defaultLevel;
  }
  const structuredLevel = resolveStructuredLogLevel({ line, defaultLevel });
  if (structuredLevel !== defaultLevel) {
    return structuredLevel;
  }
  const text = String(line || '').trim();
  // Clearly-fatal startup lines (port bind, CUDA/VRAM, model load) are emitted
  // by Ollama without a structured `level=` token, so they would otherwise sink
  // to the default WARN and be hidden in an error-level log view — the symptom
  // (`ollama.exited code:1`) is visible but the cause is not. Check these FIRST,
  // before the benign demotion below, so a fatal line that shares a routine
  // prefix (e.g. `srv  load_model: failed to load model`) still escalates.
  if (isFatalOllamaStderrLine(text)) {
    return 'ERROR';
  }
  if (JENNY_OLLAMA_POLL_ACCESS_LOG_PATTERN.test(text)) {
    return null;
  }
  if (BENIGN_OLLAMA_STDERR_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'INFO';
  }
  if (OLLAMA_STDERR_ANOMALY_TOKEN_PATTERN.test(text)) {
    return defaultLevel;
  }
  return 'INFO';
}

module.exports = {
  BENIGN_OLLAMA_STDERR_PATTERNS,
  resolveOllamaOutputLevel,
};
