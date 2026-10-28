const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_EXACT_SECRETS,
  clearExactSecretsForTests,
  redactExactSecrets,
  redactExactSecretsInValue,
  registerExactSecret,
  registeredExactSecretCount,
} = require('../services/backend/exact-secret-redaction');
const { normalizeLogEntry } = require('../services/log-entry-normalizer');
const { redactExportSecrets } = require('../services/backend/transcript-export-redaction');
const { sanitizeToolSummary } = require('../services/backend/tool-loop-input-sanitization');

// No known secret shape: only the exact-value registry can catch it.
const KEY = 'QWxwaGFCZXRhR2FtbWFEZWx0YQ9z7';

test.afterEach(() => clearExactSecretsForTests());

test('a shapeless key survives the shape redactors until it is registered', () => {
  assert.equal(redactExactSecrets(`key ${KEY}`), `key ${KEY}`);
  assert.equal(registerExactSecret(KEY), true);
  assert.equal(redactExactSecrets(`key ${KEY} and ${KEY}`), 'key [redacted:api-key] and [redacted:api-key]');
  assert.deepEqual(redactExactSecretsInValue({ a: [KEY], [KEY]: 1, n: 2 }), {
    a: ['[redacted:api-key]'], '[redacted:api-key]': 1, n: 2,
  });
});

test('log entries, exported transcripts and tool summaries drop a registered key', () => {
  registerExactSecret(KEY);
  const entry = normalizeLogEntry({ event: 'engine.error', message: `failed ${KEY}`, details: { body: `x ${KEY}` } });
  assert.ok(!JSON.stringify(entry).includes(KEY));
  assert.ok(!redactExportSecrets(`said ${KEY}`).includes(KEY));
  assert.ok(!sanitizeToolSummary(`ran with ${KEY}`).includes(KEY));
});

test('short values are not registered and the registry is bounded', () => {
  assert.equal(registerExactSecret('short'), false);
  assert.equal(registerExactSecret(42), false);
  for (let index = 0; index < MAX_EXACT_SECRETS + 5; index += 1) {
    registerExactSecret(`synthetic-key-value-${index}`);
  }
  assert.equal(registeredExactSecretCount(), MAX_EXACT_SECRETS);
  assert.equal(redactExactSecrets('synthetic-key-value-0 '), 'synthetic-key-value-0 ');
});

test('the longest registered key wins when one contains another', () => {
  registerExactSecret('abcdefghijklmnop');
  registerExactSecret('abcdefghijklmnop-and-more');
  assert.equal(redactExactSecrets('abcdefghijklmnop-and-more'), '[redacted:api-key]');
});
