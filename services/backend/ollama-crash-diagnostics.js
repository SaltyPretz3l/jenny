// Classification of Ollama startup-crash stderr so a code-1 exit becomes
// self-diagnosing. Kept as a pure sibling module (no I/O, no process state) so
// it stays unit-testable and out of the already-large ollama-process-manager.
//
// Two consumers:
//   - resolveOllamaOutputLevel() escalates a clearly-fatal stderr line to ERROR
//     so the *cause* is visible in an error-level log view (not just the
//     `ollama.exited code:1` symptom).
//   - the exit handler / cleanup path calls classifyOllamaCrash() on the
//     captured stderr tail to attach a likelyCause + remediation to the durable
//     ERROR event and to the user-facing preflight error message.

// Order matters: first match wins in classifyOllamaCrash(). Each entry maps a
// fatal stderr signature to a stable cause id and a short, actionable remedy.
const FATAL_OLLAMA_STDERR_PATTERNS = [
  {
    likelyCause: 'port_in_use',
    // POSIX ("address already in use") and Windows ("Only one usage of each
    // socket address...") bind-failure phrasings.
    pattern: /bind:.*(address already in use|Only one usage of each socket address)/i,
    remediation:
      'Another process is already using port 11434. Close the other Ollama instance (e.g. the Ollama desktop app or a stray "ollama serve") and retry.',
  },
  {
    likelyCause: 'gpu',
    // Genuinely-fatal GPU signatures only. A bare "ggml_cuda" token would also
    // match the benign `ggml_cuda_init:` boot lines and the WARN-level
    // "failed to initialize CUDA backend" (graceful CPU fallback), so it is
    // intentionally excluded.
    pattern: /CUDA error|out of memory|failed to allocate|cudaMalloc/i,
    remediation:
      'The GPU could not initialize or ran out of memory. Free VRAM (close other GPU apps/models) or pick a smaller model, then retry.',
  },
  {
    likelyCause: 'model_load',
    pattern: /failed to load model|no such file|model .* not found|error loading model/i,
    remediation:
      'The model could not be loaded. Verify the model is pulled and the OLLAMA_MODELS path is reachable, then retry.',
  },
];

function isFatalOllamaStderrLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return false;
  }
  return FATAL_OLLAMA_STDERR_PATTERNS.some((entry) => entry.pattern.test(text));
}

// Scan a captured stderr tail (array of lines or a single joined string) and
// return the first matching cause, or null when nothing fatal is recognized.
function classifyOllamaCrash(stderrTail) {
  const lines = Array.isArray(stderrTail)
    ? stderrTail
    : String(stderrTail || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const text = String(rawLine || '').trim();
    if (!text) {
      continue;
    }
    for (const entry of FATAL_OLLAMA_STDERR_PATTERNS) {
      if (entry.pattern.test(text)) {
        return { likelyCause: entry.likelyCause, remediation: entry.remediation };
      }
    }
  }
  return null;
}

module.exports = {
  FATAL_OLLAMA_STDERR_PATTERNS,
  isFatalOllamaStderrLine,
  classifyOllamaCrash,
};
