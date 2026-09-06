const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeLogEntry, toPersistedMainLog } = require('../services/log-entry-normalizer');

test('normalizeLogEntry emits structured contract fields with safe defaults', () => {
  const entry = normalizeLogEntry({
    level: 'warn',
    event: 'renderer.global_error',
    details: {
      message: 'boom',
      session_id: 'session-1',
      callId: 'call-1',
    },
  }, {
    layer: 'renderer',
  });

  assert.equal(entry.layer, 'renderer');
  assert.equal(entry.level, 'WARN');
  assert.equal(entry.component, 'renderer.global_error'.split('.').slice(0, 2).join('.'));
  assert.equal(entry.event, 'renderer.global_error');
  assert.equal(entry.message, 'boom');
  assert.equal(entry.session_id, 'session-1');
  assert.equal(entry.tool_call_id, 'call-1');
  assert.equal(entry.redaction_mode, 'redacted');
  assert.equal(entry.schema_version, 1);
  assert.equal(typeof entry.data, 'object');
  assert.equal(entry.source, 'renderer');
});

test('normalizeLogEntry preserves provided correlation metadata', () => {
  const entry = normalizeLogEntry({
    level: 'ERROR',
    layer: 'electron',
    component: 'electron.main',
    event: 'electron.main.crash',
    message: 'fatal',
    trace_id: 'trace-1',
    request_id: 'req-1',
    session_id: 'session-2',
    tool_call_id: 'call-2',
    approval_id: 'approval-1',
    rpc_id: 'rpc-9',
    status: 'failed',
    duration_ms: 12.5,
    data: { reason: 'uncaughtException' },
    redaction_mode: 'redacted',
  });

  assert.equal(entry.trace_id, 'trace-1');
  assert.equal(entry.request_id, 'req-1');
  assert.equal(entry.session_id, 'session-2');
  assert.equal(entry.tool_call_id, 'call-2');
  assert.equal(entry.approval_id, 'approval-1');
  assert.equal(entry.rpc_id, 'rpc-9');
  assert.equal(entry.status, 'failed');
  assert.equal(entry.duration_ms, 12.5);
  assert.deepEqual(entry.data, { reason: 'uncaughtException' });
});

test('normalizeLogEntry redacts sensitive payload strings when redaction mode is redacted', () => {
  const entry = normalizeLogEntry({
    level: 'WARN',
    event: 'diagnostics.path_leak',
    message: 'failed under G:\\Users\\Jenny\\AppData\\Roaming\\jenny with bearer sk-testsecret123',
    details: {
      path: 'G:\\Users\\Jenny\\AppData\\Roaming\\jenny\\sessions.json',
      nested: {
        authorization: 'authorization=Bearer abcdef123456',
      },
    },
    data: {
      token: 'OPENAI_API_KEY=sk-your-placeholder-secretvalue',
      list: ['C:/Users/example/private/file.txt'],
    },
    redaction_mode: 'redacted',
  }, {
    redaction_prefixes: [
      'G:\\Users\\Jenny\\AppData\\Roaming\\jenny',
      'C:/Users/example/private',
    ],
  });

  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes('sk-testsecret123'), false);
  assert.equal(serialized.includes('sk-your-placeholder-secretvalue'), false);
  assert.equal(serialized.includes('abcdef123456'), false);
  assert.equal(serialized.includes('G:\\Users\\Jenny\\AppData\\Roaming\\jenny'), false);
  assert.equal(serialized.includes('C:/Users/example/private'), false);
  assert.match(entry.message, /\[redacted/);
  assert.match(entry.data.token, /\[redacted\]/);
  assert.match(entry.details.path, /\[redacted:path\]/);
});

test('normalizeLogEntry redacts cookie and DSN-shaped diagnostics through shared log contract rules', () => {
  const entry = normalizeLogEntry({
    level: 'ERROR',
    event: 'diagnostics.secret_leak',
    message: 'set-cookie: session=supersecret; Path=/',
    details: {
      cookie: 'session=supersecret',
      sentryDsn: 'https://public:private@example.invalid/1',
      nested: {
        message: 'cookie=anothersecret',
      },
    },
    redaction_mode: 'redacted',
  });

  const serialized = JSON.stringify(entry);
  assert.equal(serialized.includes('supersecret'), false);
  assert.equal(serialized.includes('anothersecret'), false);
  assert.equal(serialized.includes('private@example.invalid'), false);
  assert.match(entry.message, /\[redacted\]/);
  assert.equal(entry.details.cookie, '[redacted]');
  assert.equal(entry.details.sentryDsn, '[redacted]');
});

test('normalizeLogEntry redacts content previews and account email fields before persistence', () => {
  const entry = normalizeLogEntry({
    level: 'INFO',
    event: 'interactive.protocol_drift',
    details: {
      contentPreview: 'User asked for private medical details?',
      email: 'jenny.private@example.invalid',
      nested: {
        userEmail: 'nested.private@example.invalid',
      },
    },
    redaction_mode: 'redacted',
  });
  const persisted = toPersistedMainLog('INFO', entry);
  const serialized = JSON.stringify(persisted);

  assert.equal(serialized.includes('private medical details'), false);
  assert.equal(serialized.includes('jenny.private@example.invalid'), false);
  assert.equal(serialized.includes('nested.private@example.invalid'), false);
  assert.equal(persisted.details.contentPreview, '[redacted]');
  assert.equal(persisted.details.email, '[redacted]');
  assert.equal(persisted.details.nested.userEmail, '[redacted]');
});

test('normalizeLogEntry safely redacts circular array payloads', () => {
  const circular = ['before'];
  circular.push(circular);

  const entry = normalizeLogEntry({
    event: 'diagnostics.circular_payload',
    data: { circular },
    redaction_mode: 'redacted',
  });

  assert.deepEqual(entry.data.circular, ['before', '[redacted:circular]']);
});

test('normalizeLogEntry resolves structured Ollama stderr severity before persistence', () => {
  const entry = normalizeLogEntry({
    level: 'WARN',
    event: 'ollama.output',
    details: {
      stream: 'stderr',
      line: 'time=2026-04-29T16:23:17.695-05:00 level=INFO source=routes.go:1820 msg="Listening on 127.0.0.1:11434"',
    },
  });

  assert.equal(entry.level, 'INFO');

  const persisted = toPersistedMainLog('WARN', entry);
  assert.equal(persisted.level, 'INFO');
});

test('normalizeLogEntry promotes only string detail lines after explicit messages', () => {
  const cases = [
    [{ stream: 'stderr', line: 'llama_model_loader: loaded meta data' }, 'llama_model_loader: loaded meta data'],
    [{ line: 3 }, 'ollama.output'],
    [{ message: 'explicit', line: 'other' }, 'explicit'],
    [{ error: 'boom', line: 'other' }, 'boom'],
    [{}, 'ollama.output'],
  ];

  for (const [details, expected] of cases) {
    const entry = normalizeLogEntry({ event: 'ollama.output', details });
    assert.equal(entry.message, expected);
  }
});
