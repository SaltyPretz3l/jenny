const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeLogEntry, toPersistedMainLog } = require('../services/log-entry-normalizer');

test('normalizer defaults invalid envelope names and preserves dotted names and identifiers', () => {
  const invalid = normalizeLogEntry({ event: 'bad event "quoted"', component: 'bad component', status: 'token=sk-test-SYNTHETIC123', level: 'LOUD' });
  assert.equal(invalid.event, 'electron.event');
  assert.equal(invalid.component, 'electron.event');
  assert.equal(invalid.status, 'unknown');
  assert.equal(normalizeLogEntry({}).status, 'ok');
  assert.equal(normalizeLogEntry({ status: 'interrupted' }).status, 'interrupted');
  // A well-formed status token can still be secret-shaped.
  const secretStatus = normalizeLogEntry({ status: 'tok_syntheticsecret123' });
  assert.equal(secretStatus.status, 'unknown');
  assert.equal(JSON.stringify(toPersistedMainLog('INFO', secretStatus)).includes('syntheticsecret'), false);
  assert.equal(invalid.level, 'INFO');
  const valid = normalizeLogEntry({
    event: 'sidecar.runtime.complete', component: 'sidecar.runtime',
    trace_id: 'b7a5cd07-7e36-4810-8142-07cf13ea147a', stream_id: 'stream-123',
    agent_id: 'agent-1', entry_id: 'run:42', status: 'degraded',
  });
  assert.equal(valid.event, 'sidecar.runtime.complete');
  assert.equal(valid.component, 'sidecar.runtime');
  assert.equal(valid.trace_id, 'b7a5cd07-7e36-4810-8142-07cf13ea147a');
  assert.equal(valid.stream_id, 'stream-123');
  assert.equal(valid.agent_id, 'agent-1');
  assert.equal(valid.entry_id, 'run:42');
  assert.equal(toPersistedMainLog('INFO', valid).stream_id, 'stream-123');
});

test('normalizer drops invalid identifiers without trimming or coercion and keeps numeric ids typed', () => {
  for (const value of [' id ', 'id=42', '"id"', 'sk-test-SYNTHETIC123', 'x'.repeat(161), 42]) {
    const entry = normalizeLogEntry({
      trace_id: value, request_id: value, session_id: value, tool_call_id: value,
      agent_id: value, stream_id: value, id: value, entry_id: value, origin_entry_id: value, run_id: value,
    });
    for (const key of ['trace_id', 'request_id', 'session_id', 'tool_call_id', 'agent_id', 'stream_id', 'id', 'entry_id', 'origin_entry_id', 'run_id']) {
      assert.equal(entry[key] ?? null, null, `${key}: ${value}`);
    }
  }
  const entry = normalizeLogEntry({ approval_id: 0, rpc_id: 42 });
  assert.equal(entry.approval_id, 0);
  assert.equal(entry.rpc_id, 42);
  // Electron approval ids are string tokens; they survive when identifier-shaped.
  assert.equal(normalizeLogEntry({ approval_id: 'approval-1' }).approval_id, 'approval-1');
  assert.equal(normalizeLogEntry({ rpc_id: 'rpc-7' }).rpc_id, 'rpc-7');
  const invalid = normalizeLogEntry({ approval_id: 'token=sk-test-SYNTHETIC123', rpc_id: 1.5 });
  assert.equal(invalid.approval_id, null);
  assert.equal(invalid.rpc_id, null);
});

test('normalizer drops secret-bearing and overlong dynamic keys in data and details', () => {
  const secret = 'token=sk-test-SYNTHETIC123';
  for (const redactionMode of ['redacted', 'sanitized_snippets', 'unredacted']) {
    const entry = normalizeLogEntry({
      redaction_mode: redactionMode, message: secret,
      data: { nested: { [secret]: 'value', ['x'.repeat(65)]: 1, ['x'.repeat(64)]: 2 } },
      details: { [secret]: 'value', ['y'.repeat(65)]: 1, safe: true },
    });
    assert.deepEqual(entry.data.nested, { ['x'.repeat(64)]: 2 });
    assert.equal(entry.details.safe, true);
    assert.equal(Object.hasOwn(entry.details, secret), false);
    assert.equal(Object.hasOwn(entry.details, 'y'.repeat(65)), false);
    assert.doesNotMatch(JSON.stringify(entry), /SYNTHETIC123/);
  }
});

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
    approval_id: 1,
    rpc_id: 9,
    status: 'failed',
    duration_ms: 12.5,
    data: { reason: 'uncaughtException' },
    redaction_mode: 'redacted',
  });

  assert.equal(entry.trace_id, 'trace-1');
  assert.equal(entry.request_id, 'req-1');
  assert.equal(entry.session_id, 'session-2');
  assert.equal(entry.tool_call_id, 'call-2');
  assert.equal(entry.approval_id, 1);
  assert.equal(entry.rpc_id, 9);
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
