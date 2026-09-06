const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BENIGN_OLLAMA_STDERR_PATTERNS,
  resolveOllamaOutputLevel,
} = require('../services/backend/ollama-stderr-level');

test('ollama stderr level module exports its benign pattern list', () => {
  assert.ok(Array.isArray(BENIGN_OLLAMA_STDERR_PATTERNS));
});

test('ollama output resolver treats normal llama.cpp stderr startup lines as informational', () => {
  const benignLines = [
    'load_backend: loaded CPU backend from C:\\Ollama\\cpu.dll',
    'ggml_cuda_init: GGML_CUDA_FORCE_MMQ:    no',
    'ggml_cuda_init: found 1 CUDA devices:',
    'Device 0: NVIDIA GeForce RTX 5070 Ti, compute capability 12.0, VMM: yes',
    'load_backend: loaded CUDA backend from C:\\Ollama\\cuda.dll',
    "srv  load_model: loading model 'C:\\Ollama\\models\\blobs\\sha256-deadbeef'",
  ];

  assert.deepEqual(
    benignLines.map((line) => resolveOllamaOutputLevel({
      line,
      stream: 'stderr',
      defaultLevel: 'WARN',
    })),
    ['INFO', 'INFO', 'INFO', 'INFO', 'INFO', 'INFO']
  );
  assert.equal(resolveOllamaOutputLevel({
    line: 'time=2026-05-15T12:40:00Z level=ERROR msg="runner failed"',
    stream: 'stderr',
    defaultLevel: 'WARN',
  }), 'ERROR');
  assert.equal(resolveOllamaOutputLevel({
    line: 'ggml_cuda_init: failed to initialize CUDA backend',
    stream: 'stderr',
    defaultLevel: 'WARN',
  }), 'WARN');
  // Clearly-fatal startup lines are escalated to ERROR so the cause is visible
  // in an error-level log view, not hidden at WARN below it.
  assert.equal(resolveOllamaOutputLevel({
    line: 'Error: listen tcp 127.0.0.1:11434: bind: address already in use',
    stream: 'stderr',
    defaultLevel: 'WARN',
  }), 'ERROR');
  assert.equal(resolveOllamaOutputLevel({
    line: 'CUDA error: out of memory',
    stream: 'stderr',
    defaultLevel: 'WARN',
  }), 'ERROR');
});

test('ollama output resolver treats routine per-request server/slot churn as informational', () => {
  // The embedded llama.cpp server floods stderr with these on every chat turn;
  // they carry no structured `level=` token and must not surface as WARN.
  const routineLines = [
    '[GIN] 2026/06/25 - 14:42:01 | 200 |   1.2s | 127.0.0.1 | POST     "/api/chat"',
    'srv  update_slots: all slots are idle',
    'srv  log_server_r: request: POST /api/chat 127.0.0.1 200',
    'slot launch_slot_: id  0 | task 0 | processing task',
    'slot update_slots: id  0 | task 0 | new prompt, n_ctx_slot = 4096',
    'slot release: id  0 | task 0 | stop processing: n_past = 128',
    'slot print_timing: id  0 | task 0 | prompt eval time = 42.00 ms',
  ];

  assert.deepEqual(
    routineLines.map((line) => resolveOllamaOutputLevel({
      line,
      stream: 'stderr',
      defaultLevel: 'WARN',
    })),
    routineLines.map(() => 'INFO')
  );

  // A genuinely-fatal line is escalated regardless of any prefix overlap, since
  // isFatalOllamaStderrLine() runs before the benign-prefix demotion.
  assert.equal(resolveOllamaOutputLevel({
    line: 'srv  load_model: failed to load model',
    stream: 'stderr',
    defaultLevel: 'WARN',
  }), 'ERROR');
});

test('ollama output resolver drops only successful Jenny polling access logs', () => {
  const resolve = (line) => resolveOllamaOutputLevel({
    line,
    stream: 'stderr',
    defaultLevel: 'WARN',
  });

  assert.equal(resolve(
    '[GIN] 2026/09/01 - 20:11:03 | 200 |     512.3µs |       127.0.0.1 | GET      "/api/tags"'
  ), null);
  assert.equal(resolve(
    '[GIN] 2026/09/01 - 20:11:03 | 200 |     512.3µs |       127.0.0.1 | POST     "/api/chat"'
  ), 'INFO');
  assert.equal(resolve(
    '[GIN] 2026/09/01 - 20:11:03 | 500 |     512.3µs |       127.0.0.1 | GET      "/api/tags"'
  ), 'INFO');
  assert.equal(resolve(
    '[GIN] 2026/09/01 - 20:11:03 | 204 |     512.3µs |       127.0.0.1 | GET      "/api/ps?x=1"'
  ), null);
  assert.equal(resolve('ordinary unstructured stderr line'), 'INFO');
});

test('ollama output resolver default-allows routine unstructured stderr with an anomaly backstop', () => {
  const routineLines = [
    'llama_model_loader: - kv  12:                       general.file_type u32              = 15',
    'print_info: arch             = qwen3',
    'srv    operator(): operator(): cleaning up before exit...',
    'slot   operator(): id  0 | task 1 | processing task',
    'cmn common_reaso: mode = deepseek-legacy, thinking = 1',
    'top_k = 20',
    'dry_multiplier = 0.000',
  ];

  assert.deepEqual(
    routineLines.map((line) => resolveOllamaOutputLevel({
      line,
      stream: 'stderr',
      defaultLevel: 'WARN',
    })),
    routineLines.map(() => 'INFO')
  );
  const anomalyLines = [
    'something unexpected: unable to map memory region',
    'llama_model_load: 3 errors while loading tensors',
    'main: warnings were emitted during load',
    'ggml: operation fails on this backend',
    'sampler chain: repeat_penalty failing to apply',
    'CUDA errno 2 while probing device',
  ];
  assert.deepEqual(
    anomalyLines.map((line) => resolveOllamaOutputLevel({
      line,
      stream: 'stderr',
      defaultLevel: 'WARN',
    })),
    anomalyLines.map(() => 'WARN')
  );
  assert.equal(resolveOllamaOutputLevel({
    line: 'ordinary stdout without a structured level',
    stream: 'stdout',
    defaultLevel: 'DEBUG',
  }), 'DEBUG');
});
