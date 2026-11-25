'use strict';

// C5: the canonical chat body (server/team/engine-request-fields.js). Pure; no sockets.

const assert = require('node:assert/strict');
const test = require('node:test');

const { ALLOWED_FIELDS, REQUEST_FIELD_REASON, canonicalChatBody } = require('../../server/team/engine-request-fields');

const messages = [{ role: 'user', content: 'hello' }];

test('a Jenny request passes whole, as a new object', () => {
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
  const input = { model: 'alpha', messages, stream: true, stream_options: { include_usage: true }, temperature: 0.2,
    top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.1, frequency_penalty: 0, repeat_penalty: 1.1, max_tokens: 512,
    max_completion_tokens: 600, seed: -3, stop: ['</s>'], tools, tool_choice: 'auto', parallel_tool_calls: false,
    response_format: { type: 'json_object' }, reasoning_effort: 'high', thinking_budget_tokens: 4096,
    chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'high' } };
  const result = canonicalChatBody(input);
  assert.equal(result.ok, true);
  assert.notEqual(result.body, input, 'a new object, never the caller\'s');
  assert.deepEqual(result.body, input);
  assert.deepEqual(Object.keys(result.body).sort(), Object.keys(input).sort());
  result.body.model = 'changed';
  assert.equal(input.model, 'alpha', 'the input is untouched');
});

test('a case variant of an allowed key is refused, whatever its spelling', () => {
  for (const key of ['Stream', 'MODEL', 'Messages', 'Reasoning_Effort', 'Chat_Template_Kwargs', 'N', 'Stream_Options',
    'top_K', 'ſtream', 'top_K']) {
    const result = canonicalChatBody({ model: 'alpha', messages, [key]: true });
    assert.deepEqual(result, { ok: false, reason: REQUEST_FIELD_REASON }, key);
  }
  assert.equal(REQUEST_FIELD_REASON, 'team_request_field_invalid');
  assert.deepEqual(canonicalChatBody({ Stream: true }), { ok: false, reason: 'team_request_field_invalid' }, 'even without the canonical key');
});

test('n is forced to 1 and every engine knob and unknown key is dropped', () => {
  const result = canonicalChatBody({ model: 'alpha', messages, n: 50, options: { num_ctx: 1048576 }, keep_alive: 0, slot_id: 2,
    lora: [{ id: 0, scale: 1 }], grammar: 'root ::= x', Options: { num_gpu: 0 }, image_url: 'x', user: 'u', logit_bias: { 1: 5 },
    cache_prompt: true, json_schema: {}, __proto__: { polluted: true } });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.body).sort(), ['messages', 'model', 'n']);
  assert.equal(result.body.n, 1);
  assert.equal(result.body.polluted, undefined);
});

test('a value of the wrong type is dropped, never forwarded; nested objects keep only what Jenny reads', () => {
  const result = canonicalChatBody({ model: 7, messages: 'hi', stream: 'true', temperature: Infinity, top_k: 1.5, max_tokens: '64',
    stop: [1], tool_choice: 3, response_format: [], reasoning_effort: 4,
    stream_options: { include_usage: true, extra: 1 }, chat_template_kwargs: { enable_thinking: 'yes', reasoning_effort: 'low',
      Enable_Thinking: false, other: 1 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.body, { stream_options: { include_usage: true }, chat_template_kwargs: { reasoning_effort: 'low' } });
  assert.deepEqual(canonicalChatBody({ stream_options: 5, chat_template_kwargs: null, model: 'a' }).body, { model: 'a' });
});

test('a body that is not a plain object is refused', () => {
  for (const value of [null, undefined, [], 'text', 3]) assert.equal(canonicalChatBody(value).ok, false);
});

test('the allowlist is lower case and holds the fields the pool\'s own thinking fit reads', () => {
  for (const field of ALLOWED_FIELDS) assert.equal(field, field.toLowerCase());
  for (const field of ['model', 'messages', 'stream', 'stream_options', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
    'stop', 'tools', 'tool_choice', 'response_format', 'seed', 'presence_penalty', 'frequency_penalty', 'reasoning_effort',
    'thinking_budget_tokens', 'chat_template_kwargs', 'n']) assert.ok(ALLOWED_FIELDS.has(field), field);
  for (const field of ['options', 'keep_alive', 'slot_id', 'lora', 'grammar']) assert.equal(ALLOWED_FIELDS.has(field), false, field);
});

test('C5: a key inside messages spelt with capitals is refused (Ollama folds nested keys too)', () => {
  const part = (key) => ({ model: 'alpha', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { [key]: { url: 'data:x' } }] }] });
  for (const key of ['Image_Url', 'IMAGE_URL', 'image_URL']) {
    assert.deepEqual(canonicalChatBody(part(key)), { ok: false, reason: REQUEST_FIELD_REASON }, key);
  }
  assert.equal(canonicalChatBody({ model: 'a', messages: [{ Role: 'user', content: 'hi' }] }).ok, false, 'a message key');
  assert.equal(canonicalChatBody(part('image_url')).ok, true, 'the lower-case part is taken');
  let deep = { url: 'x' };
  for (let i = 0; i < 10; i += 1) deep = { inner: deep };
  assert.equal(canonicalChatBody({ model: 'a', messages: [{ role: 'user', content: [deep] }] }).ok, false, 'past the depth bound');
});
