// W1 §1.6: Electron forwards the structured tool-result fields it already
// persists — is_error, error_code, name — plus a compact versioned
// tool_envelope object sourced from persisted tool_result.metadata, while the
// raw-output_text invariant holds: content is NEVER framed on this side.
// Framing (envelope text, untrusted wrapper) is authored exclusively by the
// sidecar's shared renderer; Electron persists and replays fields only.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertToolResultToProviderMessage,
} = require('../services/backend/chat-stream-reasoning');

const ENVELOPE_METADATA_KEYS = [
  'failure_class',
  'effects',
  'precondition_id',
  'remediation',
  'failed_phase',
  'phase_timings_json',
  'trace_id',
  'idempotency_key',
];

function errorRow(overrides = {}) {
  return {
    role: 'tool',
    tool_result: {
      call_id: 'call_7',
      tool_name: 'read_file',
      output_text: 'boom: no such file',
      summary: 'read_file failed',
      is_error: true,
      error_code: 'CMP-TOOL-0004',
      duration_ms: 41,
      metadata: {
        failure_class: 'not_found',
        effects: 'none',
        failed_phase: 'execute',
        trace_id: 't_1.call_7',
        // to_error_data stringifies, so persisted metadata carries text.
        elapsed_ms: '41',
        category: 'tool',
        internal_only_key: 'never-forwarded',
      },
      ...overrides,
    },
  };
}

test('error rows forward name, is_error, and error_code', () => {
  const message = convertToolResultToProviderMessage(errorRow());
  assert.equal(message.role, 'tool');
  assert.equal(message.tool_call_id, 'call_7');
  assert.equal(message.name, 'read_file');
  assert.equal(message.is_error, true);
  assert.equal(message.error_code, 'CMP-TOOL-0004');
});

test('the versioned tool_envelope carries whitelisted metadata plus metadata elapsed_ms', () => {
  const message = convertToolResultToProviderMessage(errorRow());
  const envelope = message.tool_envelope;
  assert.ok(envelope && typeof envelope === 'object');
  assert.equal(envelope.v, 1);
  assert.equal(envelope.failure_class, 'not_found');
  assert.equal(envelope.effects, 'none');
  assert.equal(envelope.failed_phase, 'execute');
  assert.equal(envelope.trace_id, 't_1.call_7');
  assert.equal(envelope.elapsed_ms, 41);
  // Only the whitelist crosses the wire.
  assert.equal('internal_only_key' in envelope, false);
  assert.equal('category' in envelope, false);
  for (const key of Object.keys(envelope)) {
    assert.ok(
      key === 'v' || key === 'elapsed_ms' || ENVELOPE_METADATA_KEYS.includes(key),
      `unexpected forwarded envelope key: ${key}`
    );
  }
});

test('raw-output_text invariant: content is the persisted text, never framed', () => {
  const message = convertToolResultToProviderMessage(errorRow());
  assert.equal(message.content, 'boom: no such file');
  assert.equal(message.content.includes('<untrusted_tool_output>'), false);
  assert.equal(message.content.includes('## Tool Result'), false);
});

test('success rows stay lean: no is_error, no error_code, name still present', () => {
  const message = convertToolResultToProviderMessage(
    errorRow({ is_error: false, error_code: '', metadata: {} })
  );
  assert.equal(message.name, 'read_file');
  assert.equal('is_error' in message, false);
  assert.equal('error_code' in message, false);
  const envelope = message.tool_envelope;
  assert.ok(envelope && typeof envelope === 'object');
  // elapsed_ms comes ONLY from persisted metadata (the in-turn envelope's
  // source), never from Electron-measured duration_ms — so a bare metadata
  // object forwards a bare envelope even though duration_ms is present.
  assert.deepEqual(Object.keys(envelope), ['v']);
});

test('rows with no metadata and no duration forward no fabricated envelope fields', () => {
  const message = convertToolResultToProviderMessage({
    role: 'tool',
    tool_result: {
      call_id: 'call_9',
      tool_name: 'glob',
      output_text: 'a.txt',
      is_error: false,
      error_code: '',
    },
  });
  assert.equal(message.content, 'a.txt');
  if (message.tool_envelope) {
    assert.deepEqual(Object.keys(message.tool_envelope), ['v']);
  }
});

test('harness-snapshot summarization keeps working (stay-green)', () => {
  const message = convertToolResultToProviderMessage({
    role: 'tool',
    tool_result: {
      call_id: 'call_h',
      tool_name: 'jenny_status',
      output_text: '{"big": "snapshot"}',
      summary: 'Harness snapshot',
      metadata: { result_kind: 'harness_snapshot' },
    },
  });
  assert.match(message.content, /completed in a prior turn/);
});

test('rows without a call_id are still rejected', () => {
  assert.equal(
    convertToolResultToProviderMessage({ role: 'tool', tool_result: { output_text: 'x' } }),
    null
  );
});
