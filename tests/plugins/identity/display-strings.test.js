'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_DISPLAY_STRING_UTF8_BYTES,
  hasForbiddenCodepoint,
  normalizeForReservedLabelCheck,
  validateDisplayString,
} = require('../../../services/plugins/identity/display-strings.js');

test('validateDisplayString accepts an ordinary Unicode name', () => {
  const result = validateDisplayString('Caf\u00e9 \u65e5\u672c\u8a9e');
  assert.deepEqual(result, { ok: true, value: 'Caf\u00e9 \u65e5\u672c\u8a9e' });
});

test('validateDisplayString accepts a name that merely contains a reserved word as a substring', () => {
  const result = validateDisplayString("Jennyfer's Toolbox");
  assert.equal(result.ok, true);
});

test('validateDisplayString rejects a non-string value', () => {
  const result = validateDisplayString(42);
  assert.deepEqual(result, { ok: false, code: 'not_string' });
});

test('validateDisplayString rejects an empty string', () => {
  const result = validateDisplayString('');
  assert.deepEqual(result, { ok: false, code: 'empty_display_string' });
});

test('validateDisplayString rejects a string over the byte budget', () => {
  const value = 'x'.repeat(MAX_DISPLAY_STRING_UTF8_BYTES + 1);
  const result = validateDisplayString(value);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'display_string_too_long');
  assert.equal(result.byte_count, MAX_DISPLAY_STRING_UTF8_BYTES + 1);
});

test('validateDisplayString accepts a string exactly at the byte budget boundary', () => {
  const value = 'x'.repeat(MAX_DISPLAY_STRING_UTF8_BYTES);
  const result = validateDisplayString(value);
  assert.equal(result.ok, true);
});

test('validateDisplayString rejects a control character', () => {
  const result = validateDisplayString(`Acme${String.fromCharCode(0x01)}Labs`);
  assert.deepEqual(result, { ok: false, code: 'forbidden_codepoint' });
});

test('validateDisplayString rejects a bidi override character', () => {
  const result = validateDisplayString(`Acme${String.fromCodePoint(0x202e)}Labs`);
  assert.deepEqual(result, { ok: false, code: 'forbidden_codepoint' });
});

test('validateDisplayString rejects a zero-width character', () => {
  const result = validateDisplayString(`Acme${String.fromCodePoint(0x200b)}Labs`);
  assert.deepEqual(result, { ok: false, code: 'forbidden_codepoint' });
});

test('validateDisplayString rejects a non-NFC-normalized (NFD) string', () => {
  const decomposed = `Caf${'e'}${String.fromCodePoint(0x0301)}`; // e + combining acute
  const result = validateDisplayString(decomposed);
  assert.deepEqual(result, { ok: false, code: 'not_nfc_normalized' });
});

test('validateDisplayString rejects an exact reserved label', () => {
  const result = validateDisplayString('Jenny');
  assert.deepEqual(result, { ok: false, code: 'reserved_display_label' });
});

test('validateDisplayString rejects a reserved label regardless of case and surrounding whitespace', () => {
  const result = validateDisplayString('  JENNY  ');
  assert.deepEqual(result, { ok: false, code: 'reserved_display_label' });
});

test('validateDisplayString rejects a multi-word reserved label with collapsed internal whitespace', () => {
  const result = validateDisplayString('Official   Jenny');
  assert.deepEqual(result, { ok: false, code: 'reserved_display_label' });
});

test('hasForbiddenCodepoint is false for ordinary printable Unicode text', () => {
  assert.equal(hasForbiddenCodepoint('Acme Labs 日本語'), false);
});

test('normalizeForReservedLabelCheck lowercases, trims, and collapses whitespace', () => {
  assert.equal(normalizeForReservedLabelCheck('  Jenny   Core '), 'jenny core');
});
