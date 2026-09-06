const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyOllamaCrash,
  isFatalOllamaStderrLine,
} = require('../services/backend/ollama-crash-diagnostics');

test('isFatalOllamaStderrLine flags fatal startup signatures only', () => {
  const fatal = [
    'Error: listen tcp 127.0.0.1:11434: bind: address already in use',
    'bind: Only one usage of each socket address (protocol/network address/port) is normally permitted',
    'CUDA error: out of memory',
    'failed to allocate 4096 MiB on device 0',
    'cudaMalloc failed: out of memory',
    'failed to load model from C:\\models\\foo.gguf',
    'error loading model: no such file or directory',
  ];
  for (const line of fatal) {
    assert.equal(isFatalOllamaStderrLine(line), true, `expected fatal: ${line}`);
  }

  const nonFatal = [
    '',
    'srv  load_model: loading model',
    'ggml_cuda_init: found 1 CUDA devices:',
    'ggml_cuda_init: failed to initialize CUDA backend', // graceful CPU fallback (WARN, not fatal)
    'common_memory_breakdown_print: CUDA0 ...',
    'system_info: n_threads = 10',
  ];
  for (const line of nonFatal) {
    assert.equal(isFatalOllamaStderrLine(line), false, `expected non-fatal: ${line}`);
  }
});

test('classifyOllamaCrash returns the first matching cause from a tail', () => {
  const portTail = [
    'time=... level=INFO msg="starting"',
    'Error: listen tcp 127.0.0.1:11434: bind: address already in use',
  ];
  assert.equal(classifyOllamaCrash(portTail).likelyCause, 'port_in_use');
  assert.match(classifyOllamaCrash(portTail).remediation, /port 11434/i);

  assert.equal(classifyOllamaCrash('CUDA error: out of memory').likelyCause, 'gpu');
  assert.equal(
    classifyOllamaCrash('error loading model: no such file').likelyCause,
    'model_load'
  );
});

test('classifyOllamaCrash returns null when nothing fatal is present', () => {
  assert.equal(classifyOllamaCrash(''), null);
  assert.equal(classifyOllamaCrash(null), null);
  assert.equal(
    classifyOllamaCrash(['srv  load_model: loading model', 'all slots are idle']),
    null
  );
});
