'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareVersions,
  evaluateOllamaVersion,
} = require('../services/ollama-version-policy');

test('Ollama version policy accepts current/newer versions and rejects old ones', () => {
  assert.equal(compareVersions('0.32.1', '0.30.10'), 1);
  assert.equal(compareVersions('0.30.10-rc.1', '0.30.10'), -1);
  assert.equal(compareVersions('0.30.10-rc.10', '0.30.10-rc.2'), 1);
  assert.equal(evaluateOllamaVersion('0.30.10').versionSupported, true);
  assert.equal(evaluateOllamaVersion('0.30.10-rc.1').versionSupported, false);
  assert.deepEqual(evaluateOllamaVersion('0.20.4'), {
    minimumVersion: '0.30.10',
    versionSupported: false,
    upgradeRequired: true,
    versionStatus: 'outdated',
  });
});

test('malformed or missing versions remain unverified, never silently supported', () => {
  assert.equal(compareVersions('unknown', '0.30.10'), null);
  assert.equal(compareVersions(`0.${'9'.repeat(130)}.1`, '0.30.10'), null);
  assert.equal(compareVersions('0.30.10-rc.01', '0.30.10'), null);
  assert.equal(compareVersions('0.30.10-rc..1', '0.30.10'), null);
  assert.deepEqual(evaluateOllamaVersion(''), {
    minimumVersion: '0.30.10',
    versionSupported: false,
    upgradeRequired: false,
    versionStatus: 'unverified',
  });
});

test('a serving probe accepts an unparseable version without claiming verification', () => {
  assert.deepEqual(evaluateOllamaVersion('development', '0.30.10', { serving: true }), {
    minimumVersion: '0.30.10',
    versionSupported: true,
    upgradeRequired: false,
    versionStatus: 'serving_unverified',
  });
});
