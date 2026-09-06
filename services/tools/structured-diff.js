/* services/tools/structured-diff.js - shared caps plus hash and normalization
 * helpers for structured diffs produced by the sidecar. */

'use strict';

const crypto = require('crypto');

const MAX_DIFF_BYTES = 32 * 1024;
const MAX_DIFF_HUNKS = 64;
const MAX_DIFF_LINES = 200;
const MAX_DIFF_LINE_CHARS = 2000;
const STRUCTURED_DIFF_CAP_TRUNCATION_REASONS = Object.freeze([
  'hunk_limit',
  'line_limit',
  'byte_limit',
]);

function normalizeDiffInputText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

module.exports = {
  MAX_DIFF_BYTES,
  MAX_DIFF_HUNKS,
  MAX_DIFF_LINES,
  MAX_DIFF_LINE_CHARS,
  STRUCTURED_DIFF_CAP_TRUNCATION_REASONS,
  // Shared with the pre-change snapshot store so snapshot keys are
  // byte-identical to the before_hash values this module emits in diffs.
  normalizeDiffInputText,
  sha256Text,
};
