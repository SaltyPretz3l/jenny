'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ollamaBinaryPath,
  ollamaInstallDirs,
  ollamaUserInstallRoot,
} = require('../services/ollama-runtime-paths');

test('ollamaUserInstallRoot uses an absolute XDG data home', () => {
  assert.equal(ollamaUserInstallRoot({ XDG_DATA_HOME: '/xdg' }), '/xdg/jenny/ollama');
});

test('ollamaUserInstallRoot falls back to HOME local share', () => {
  assert.equal(
    ollamaUserInstallRoot({ HOME: '/home/u' }),
    '/home/u/.local/share/jenny/ollama'
  );
});

test('ollamaUserInstallRoot ignores a relative XDG data home', () => {
  assert.equal(
    ollamaUserInstallRoot({ XDG_DATA_HOME: 'relative', HOME: '/home/u' }),
    '/home/u/.local/share/jenny/ollama'
  );
});

test('ollamaUserInstallRoot returns empty when no home can be determined', () => {
  assert.equal(ollamaUserInstallRoot({ HOME: '' }, () => ''), '');
});

test('ollamaInstallDirs returns only the managed linux bin directory', () => {
  assert.deepEqual(
    ollamaInstallDirs('linux', { XDG_DATA_HOME: '/xdg' }),
    ['/xdg/jenny/ollama/bin']
  );
  assert.deepEqual(ollamaInstallDirs('darwin', { XDG_DATA_HOME: '/xdg' }), []);
});

test('ollamaBinaryPath resolves the managed linux executable only when present', () => {
  const expected = '/xdg/jenny/ollama/bin/ollama';
  const env = { XDG_DATA_HOME: '/xdg' };

  assert.equal(ollamaBinaryPath('linux', env, (candidate) => candidate === expected), expected);
  assert.equal(ollamaBinaryPath('linux', env, () => false), '');
});
