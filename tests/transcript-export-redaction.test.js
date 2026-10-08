'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  REDACTED_SECRET_TOKEN,
  redactExportSecrets,
  redactExportSecretsInValue,
  redactTranscriptPaths,
  redactTranscriptExportContent,
} = require('../services/backend/transcript-export-redaction');

describe('export secret redaction', () => {
  it('redacts every value family at its minimum length, repeatedly', () => {
    assert.equal(REDACTED_SECRET_TOKEN, '[redacted:secret]');
    const secrets = [
      'bEaReR abCD09._~+/=', 'sk-proj-abcDEF_1', 'sk-abcDEF-1',
      ...['p', 'o', 'u', 's', 'r'].map((letter) => `gh${letter}_${'A'.repeat(20)}`),
      ...['sk', 'pk', 'tok', 'ghp', 'gho'].map((prefix) => `${prefix}_abcDEF_1`),
    ];
    const text = secrets.join(' ');
    const expected = secrets.map(() => REDACTED_SECRET_TOKEN).join(' ');
    assert.equal(redactExportSecrets(text), expected);
    assert.equal(redactExportSecrets(text), expected);
  });

  it('redacts JSON-quoted keys and HTTP Basic credentials', () => {
    assert.equal(redactExportSecrets('{"api_key":"abcdefghijklmnop","note":"x"}'),
      `{"api_key":"${REDACTED_SECRET_TOKEN}","note":"x"}`);
    assert.equal(redactExportSecrets('{ "password" : "hunter2hunter2" }'),
      `{ "password" : "${REDACTED_SECRET_TOKEN}" }`);
    assert.equal(redactExportSecrets('Authorization: Basic dXNlcjpwYXNz'),
      `Authorization: ${REDACTED_SECRET_TOKEN}`);
    assert.equal(redactExportSecrets('basic plan'), 'basic plan');
  });

  it('preserves assignment keys, separators and quotes while replacing values', () => {
    const keys = ['authorization', 'api_key', 'api-key', 'apikey', 'x-api-key',
      'access_token', 'access-token', 'accesstoken', 'refresh_token', 'refresh-token',
      'refreshtoken', 'client_secret', 'client-secret', 'clientsecret', 'secret', 'password'];
    for (const key of keys) {
      const text = `${key.toUpperCase()} : "abcdefgh", ${key}='supersecretvalue'}`;
      const expected = `${key.toUpperCase()} : "[redacted:secret]", ${key}='[redacted:secret]'}`;
      assert.equal(redactExportSecrets(text), expected);
      assert.equal(redactExportSecrets(expected), expected, 'redaction is idempotent');
    }
    assert.equal(redactExportSecrets('api_key=sk-proj-abcDEF_1'), 'api_key=[redacted:secret]');
    assert.equal(redactExportSecrets('password=abc{defghijk'), 'password=abc{defghijk');
  });

  it('keeps ordinary prose, routes, paths, base64 and below-threshold values intact', () => {
    const texts = ['/api/users', 'A normal sentence about the weather.',
      'C:/Users/Jenny/private/file.txt', 'c3ludGhldGljIG1lZGlhIGJ5dGVz',
      'data:image/png;base64,c3ludGhldGljIG1lZGlhIGJ5dGVz',
      'Bearer abcdefghijk sk-abcdefg pk_abcdefg ghu_abcdefghijklmnopqrs api_key=abcdefg',
      'wordsk-abcdefgh wordtok_abcdefgh'];
    for (const text of texts) assert.equal(redactExportSecrets(text), text);
  });

  it('walks nested values, redacts exact sensitive keys and preserves other types', () => {
    const keys = ['authorization', 'API_KEY', 'api-key', 'ApiKey', 'x-api-key',
      'ACCESS_TOKEN', 'refresh-token', 'client_secret', 'password', 'secret'];
    const source = Object.fromEntries(keys.map((key) => [key, 'x']));
    source.nested = [{ text: 'sk-abcdefgh', password: '', secret: 42, authorization: false,
      access_token: { text: 'pk_abcdefgh' }, api_key_description: 'ordinary text' }, null];
    const date = new Date('2026-01-01T00:00:00Z');
    source.date = date;
    const redacted = redactExportSecretsInValue(source);
    for (const key of keys) assert.equal(redacted[key], REDACTED_SECRET_TOKEN);
    assert.deepEqual(redacted.nested, [{ text: REDACTED_SECRET_TOKEN, password: '', secret: 42,
      authorization: false, access_token: { text: REDACTED_SECRET_TOKEN },
      api_key_description: 'ordinary text' }, null]);
    assert.equal(redacted.date, date);
    assert.notEqual(redacted, source);
    assert.equal(source.API_KEY, 'x');
    assert.equal(source.nested[0].text, 'sk-abcdefgh');
    assert.equal(redactExportSecretsInValue(undefined), undefined);
  });

  it('copies media and asset paths through and keeps keys as safe own properties', () => {
    const source = JSON.parse('{"__proto__":{"text":"sk-abcdefgh"},"sk-abcdefgh":"plain"}');
    source._exportedData = 'c3ludGhldGljIG1lZGlhIGJ5dGVz';
    source.assetPath = 'C:/managed/sk-abcdefgh.png';
    source.nested = { _exportedData: 'sk-abcdefgh', assetPath: 'pk_abcdefgh' };
    const redacted = redactExportSecretsInValue(source);
    assert.equal(redacted._exportedData, source._exportedData);
    assert.equal(redacted.assetPath, source.assetPath);
    assert.deepEqual(redacted.nested, source.nested);
    assert.equal(Object.getPrototypeOf(redacted), Object.prototype);
    assert.ok(Object.hasOwn(redacted, '__proto__'));
    assert.deepEqual(redacted.__proto__, { text: REDACTED_SECRET_TOKEN });
    assert.equal(redacted['sk-abcdefgh'], 'plain');
  });

  it('keeps path anonymisation separate from secret redaction', () => {
    const text = 'sk-abcdefgh /home/jenny/private/file.txt /api/users';
    const expected = 'sk-abcdefgh [redacted:path]/file.txt /api/users';
    assert.equal(redactTranscriptPaths(text), expected);
    assert.equal(redactTranscriptExportContent(text, 'text'), expected);
    assert.deepEqual(JSON.parse(redactTranscriptExportContent(JSON.stringify({ text }), 'session-json')),
      { text: expected });
  });
});
