'use strict';

// Row 129, A9: a refusal reaches the model with words, not only a reason code.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { jsonToolResult } = require('../services/tools/builtin/session-directory-tool-support');
const { proposalFailure } = require('../services/tools/builtin/propose-tool-support');

const body = (value) => JSON.parse(jsonToolResult('settings_get', 'Settings: read', value).content);

test('a common refusal reason gains a sentence that says what to do next', () => {
  const invalid = body({ ok: false, reason: 'invalid_input' });
  assert.equal(invalid.reason, 'invalid_input');
  assert.match(invalid.message, /arguments were not valid/);
  assert.match(invalid.message, /call it again/);

  assert.match(body({ ok: false, reason: 'unavailable' }).message, /Do not call it again this turn/);
  assert.match(body({ ok: false, reason: 'stale_operation' }).message, /nothing was done/);
  assert.match(body({ ok: false, reason: 'unknown_chat' }).message, /sessions_list/);
});

test('the result metadata and the ok path are unchanged', () => {
  const refused = jsonToolResult('settings_get', 'Settings: read', { ok: false, reason: 'disabled' });
  assert.equal(refused.isError, false);
  assert.deepEqual(refused.metadata, { result_kind: 'settings_get', status: 'refused', reason: 'disabled' });

  const value = { ok: true, settings: [] };
  assert.deepEqual(body(value), value);
});

test('a tool\'s own message and an unlisted reason are left alone', () => {
  const own = { ok: false, reason: 'invalid_input', message: 'key must be one of: theme' };
  assert.deepEqual(body(own), own);
  const detailed = { ok: false, reason: 'unavailable', detail: 'the terminal is closed' };
  assert.deepEqual(body(detailed), detailed);
  const unlisted = { ok: false, reason: 'self' };
  assert.deepEqual(body(unlisted), unlisted);
  // A reason name that is also an Object.prototype key must not pick up a stray value.
  assert.deepEqual(body({ ok: false, reason: 'constructor' }), { ok: false, reason: 'constructor' });
});

test('a proposal refusal names the argument or the fix, and keeps the code', () => {
  const field = proposalFailure('propose_command', 'invalid_request', { cause: 'field_cwd' });
  assert.match(field.content, /the 'cwd' argument is missing or not in the right form \(field_cwd\)/);
  assert.match(field.content, /call propose_command again/);

  const unchanged = proposalFailure('propose_git_action', 'invalid_request', { cause: 'path_not_changed' });
  assert.match(unchanged.content, /call git_status and list only paths it shows \(path_not_changed\)/);

  const other = proposalFailure('propose_command', 'invalid_request', { cause: 'too_long' });
  assert.match(other.content, /The arguments were invalid \(too_long\)\./);
  const none = proposalFailure('propose_command', 'invalid_request');
  assert.match(none.content, /The arguments were invalid\. Correct them/);
});
