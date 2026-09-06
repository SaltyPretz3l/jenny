const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDetectPayload,
} = require('../renderer/services/renderer-setup-service');

test('normalizeDetectPayload preserves supported Ollama version-policy fields', () => {
  assert.deepEqual(normalizeDetectPayload({
    installed: true,
    running: true,
    version: '0.12.3',
    installPath: '/usr/bin/ollama',
    source: 'path',
    versionSupported: true,
    upgradeRequired: false,
    versionStatus: 'supported',
    minimumVersion: '0.11.0',
  }), {
    installed: true,
    running: true,
    version: '0.12.3',
    installPath: '/usr/bin/ollama',
    source: 'path',
    versionSupported: true,
    upgradeRequired: false,
    versionStatus: 'supported',
    minimumVersion: '0.11.0',
  });
});

test('normalizeDetectPayload preserves outdated Ollama version-policy fields', () => {
  const result = normalizeDetectPayload({
    versionSupported: false,
    upgradeRequired: true,
    versionStatus: 'outdated',
    minimumVersion: '0.11.0',
  });

  assert.equal(result.versionSupported, false);
  assert.equal(result.upgradeRequired, true);
  assert.equal(result.versionStatus, 'outdated');
  assert.equal(result.minimumVersion, '0.11.0');
});

test('normalizeDetectPayload defaults omitted Ollama version-policy fields safely', () => {
  assert.deepEqual(normalizeDetectPayload(null), {
    installed: false,
    running: false,
    version: '',
    installPath: '',
    source: 'none',
    versionSupported: false,
    upgradeRequired: false,
    versionStatus: '',
    minimumVersion: '',
  });
});

test('normalizeDetectPayload rejects truthy non-boolean version-policy flags', () => {
  const result = normalizeDetectPayload({
    versionSupported: 'true',
    upgradeRequired: 1,
    versionStatus: 42,
    minimumVersion: ['0.11.0'],
  });

  assert.equal(result.versionSupported, false);
  assert.equal(result.upgradeRequired, false);
  assert.equal(result.versionStatus, '42');
  assert.equal(result.minimumVersion, '0.11.0');
});
