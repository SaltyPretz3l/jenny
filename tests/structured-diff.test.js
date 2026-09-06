'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_DIFF_BYTES,
  MAX_DIFF_HUNKS,
  MAX_DIFF_LINES,
  MAX_DIFF_LINE_CHARS,
  STRUCTURED_DIFF_CAP_TRUNCATION_REASONS,
  normalizeDiffInputText,
  sha256Text,
} = require('../services/tools/structured-diff');

test('structured diff caps retain the sidecar wire limits and truncation reasons', () => {
  assert.equal(MAX_DIFF_BYTES, 32 * 1024);
  assert.equal(MAX_DIFF_HUNKS, 64);
  assert.equal(MAX_DIFF_LINES, 200);
  assert.equal(MAX_DIFF_LINE_CHARS, 2000);
  assert.deepEqual(STRUCTURED_DIFF_CAP_TRUNCATION_REASONS, [
    'hunk_limit',
    'line_limit',
    'byte_limit',
  ]);
});

test('normalizeDiffInputText normalizes EOLs while preserving a BOM', () => {
  assert.equal(
    normalizeDiffInputText('\ufeffalpha\r\nbeta\rgamma\n'),
    '\ufeffalpha\nbeta\ngamma\n'
  );
});

test('sha256Text retains hashes used by sidecar before_hash values', () => {
  assert.equal(
    sha256Text(normalizeDiffInputText('alpha\r\n')),
    'sha256:b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060'
  );
  assert.equal(
    sha256Text(''),
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
});
