'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');
const {
  boundedString,
  invalidArguments,
  manifestSchema,
  plural,
  readStringArgument,
  serviceFailure,
  serviceUnavailable,
  summaryArgument,
} = require('../services/tools/builtin/tool-result');

test('serviceUnavailable and serviceFailure share one shape', () => {
  assert.deepEqual(serviceUnavailable('worktree_list', { label: 'Worktree list', content: 'Down.' }), {
    content: 'Down.',
    summary: 'Worktree list unavailable',
    isError: true,
    errorCode: TOOL_ERROR_CODES.DISABLED,
    metadata: { result_kind: 'worktree_list', reason: 'unavailable', unavailable: true },
  });
  const mapped = serviceFailure('automation_read', { reason: 'not_found' }, {
    label: 'Automation read', content: 'Missing.', metadata: { automation_id: 'a' },
  });
  assert.equal(mapped.content, 'Missing.');
  assert.equal(mapped.summary, 'Automation read failed');
  assert.equal(mapped.errorCode, TOOL_ERROR_CODES.EXECUTION_FAILED);
  assert.deepEqual(mapped.metadata, { result_kind: 'automation_read', reason: 'not_found', automation_id: 'a' });
  const coded = serviceFailure('x', { message: 'm', error_code: 'CMP-X', reason: 'r' }, { label: 'X' });
  assert.equal(coded.errorCode, 'CMP-X');
  assert.equal(serviceFailure('x', null, { label: 'X' }).content, 'X failed.');
  assert.equal(invalidArguments('x', { label: 'X', content: 'bad' }).metadata.reason, 'invalid_arguments');
});

test('readStringArgument never coerces non-strings and bounds length', () => {
  assert.deepEqual(readStringArgument({ a: ' v ' }, 'a', { required: true }), { value: 'v' });
  assert.deepEqual(readStringArgument({}, 'a'), { value: '' });
  assert.match(readStringArgument({}, 'a', { required: true }).error, /required/);
  assert.match(readStringArgument({ a: { b: 1 } }, 'a').error, /must be a string/);
  assert.match(readStringArgument({ a: 'xx' }, 'a', { maxLength: 1 }).error, /1 character limit/);
  assert.match(readStringArgument({ a: '  ' }, 'a', { required: true }).error, /required/);
  assert.equal(summaryArgument({ a: { toString: () => 'x' } }, 'a', 5), '');
  assert.equal(summaryArgument({ a: ' abcdefgh ' }, 'a', 3), 'abc');
});

test('boundedString clamps, plural counts and manifestSchema copies', () => {
  assert.equal(boundedString(' abc ', 2), 'ab');
  assert.equal(boundedString(7, 2), '');
  assert.equal(boundedString('  ', 2, { required: true }), null);
  assert.equal(plural(1, 'question'), '1 question');
  assert.equal(plural(3, 'question'), '3 questions');
  const schema = manifestSchema('worktree_list');
  schema.parameters.mutated = true;
  assert.equal(manifestSchema('worktree_list').parameters.mutated, undefined);
  assert.throws(() => manifestSchema('no_such_tool'), /missing from/);
});
