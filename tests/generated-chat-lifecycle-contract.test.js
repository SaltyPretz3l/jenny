'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const contract = require('../services/backend/generated-chat-lifecycle-contract');
const { assertChatStartIpcPayload } = require('../services/auxiliary-ipc-handlers');

test('generated identifiers are string-only, grammatical, and UTF-8 bounded', () => {
  assert.deepEqual(contract.normalizeIdentifier(' turn_1 '), {
    ok: true, value: 'turn_1', reason: null,
  });
  for (const malformed of [0, false, ['turn_1'], { id: 'turn_1' }, 'bad id', '会話']) {
    assert.equal(contract.normalizeIdentifier(malformed).ok, false);
  }
  assert.equal(contract.normalizeIdentifier('x'.repeat(129)).reason, 'identifier_too_large');
});

test('generated UTF-8 truncation preserves code points and byte units', () => {
  assert.equal(contract.truncateUtf8('会話abc', 7), '会話a');
  assert.equal(contract.truncateUtf8('😀abc', 5), '😀a');
  assert.equal(contract.truncateUtf8('éabc', 3), 'é');
});

test('generated structural sanitizer fails closed on depth, cycles, and bytes', () => {
  let deep = { leaf: true };
  for (let index = 0; index < 14; index += 1) deep = { child: deep };
  assert.equal(contract.sanitizeStructure(deep).reason, 'depth_budget_exceeded');
  const cycle = {};
  cycle.self = cycle;
  assert.equal(contract.sanitizeStructure(cycle).reason, 'cycle_detected');
  assert.equal(
    contract.sanitizeStructure({ text: '会'.repeat(33000) }).reason,
    'payload_byte_budget_exceeded'
  );
});

test('generated lifecycle validator accepts plain records across realms', () => {
  const foreign = vm.runInNewContext('({ prompt: "hello" })');

  assert.equal(contract.isPlainObject(foreign), true);
  assert.equal(contract.validateChatStartPayload(foreign).ok, true);
  assert.equal(contract.isPlainObject(Object.create(null)), true);
  assert.equal(contract.isPlainObject([]), false);
  assert.equal(contract.isPlainObject(new (class Example {})()), false);
});

test('generated terminal aliases fail unknown values closed', () => {
  assert.equal(contract.normalizeTerminalStatus('completed'), 'complete');
  assert.equal(contract.normalizeTerminalStatus('runtime-error'), 'error');
  assert.equal(contract.normalizeTerminalStatus('canceled'), 'cancelled');
  assert.equal(contract.normalizeTerminalStatus('future_status'), 'unknown');
});

test('chat IPC validator accepts renderer shape and rejects malformed payload before backend', () => {
  const payload = {
    sessionId: '', prompt: 'hello', traceId: 'trace_1', visiblePrompt: '',
    attachments: [], mentionContents: [], planMode: false,
    interactiveRoundCount: 0,
    contextPreferences: {}, activeFileContext: null, interactiveResponse: null,
    toolPreferences: {}, clientTiming: { send_started_at_ms: 1 },
  };
  assert.equal(assertChatStartIpcPayload(payload).prompt, 'hello');
  assert.throws(
    () => assertChatStartIpcPayload({ ...payload, traceId: { secret: 'do-not-log' } }),
    (error) => error.code === 'CMP-CHAT-0001' && error.path === '$.traceId'
  );
  assert.throws(
    () => assertChatStartIpcPayload({ ...payload, unknownOwnerField: true }),
    (error) => error.reason === 'unknown_field'
  );
  assert.throws(
    () => assertChatStartIpcPayload(payload, { requireEditedMessageId: true }),
    (error) => error.path === '$.editedMessageId'
  );
});

test('chat IPC validator accepts the error-card failure-retry payload shape', () => {
  // The error-card Retry path is the only sender that adds failureRetry; a
  // whitelist that omits it rejects every retry as unknown_field (owner-hit
  // 2026-08-31, logged as chat.ipc_payload_rejected).
  const payload = {
    sessionId: 'sess_1', prompt: 'hello', traceId: 'trace_1', visiblePrompt: 'hello',
    attachments: [], mentionContents: [], planMode: false,
    interactiveRoundCount: 0,
    contextPreferences: {}, activeFileContext: null, interactiveResponse: null,
    toolPreferences: {}, clientTiming: { send_started_at_ms: 1 },
    editedMessageId: 'user_stream_1', failureRetry: true,
  };
  const accepted = assertChatStartIpcPayload(payload, { requireEditedMessageId: true });
  assert.equal(accepted.failureRetry, true);
  assert.equal(accepted.editedMessageId, 'user_stream_1');
  assert.throws(
    () => assertChatStartIpcPayload({ ...payload, failureRetry: 'yes' }),
    (error) => error.reason === 'field_not_boolean' && error.path === '$.failureRetry'
  );
});

test('chat IPC validator rejects non-plain objects and bounds/redacts diagnostic paths', () => {
  const payload = { sessionId: '', prompt: 'hello' };
  for (const candidate of [new Date(), new Map(), new Set(), new Uint8Array([1])]) {
    const result = contract.validateChatStartPayload({
      ...payload,
      interactiveResponse: candidate,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'unsupported_object_type');
    assert.equal(result.error.path, '$.interactiveResponse');
  }

  const secretLookingKey = `secret_token_${'x'.repeat(200000)}`;
  const unknownResult = contract.validateChatStartPayload({
    ...payload,
    [secretLookingKey]: true,
  });
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.error.reason, 'unknown_field');
  assert.equal(unknownResult.error.path, '$.[unknown]');
  assert.equal(unknownResult.error.path.includes('secret'), false);
  assert.ok(Buffer.byteLength(unknownResult.error.path, 'utf8') <= 240);

  const nestedResult = contract.inspectStructure({
    activeFileContext: { [secretLookingKey]: Symbol('unsupported') },
  });
  assert.equal(nestedResult.ok, false);
  assert.equal(nestedResult.reason, 'unsupported_value_type');
  assert.equal(nestedResult.path.includes('secret'), false);
  assert.ok(Buffer.byteLength(nestedResult.path, 'utf8') <= 240);
});
