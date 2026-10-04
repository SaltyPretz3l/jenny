'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('capture prepares supported preload and launch arguments before Electron', async () => {
  const file = path.resolve(__dirname, '../../scripts/dev/capture-ui.js');
  const localRequire = createRequire(file);
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, __dirname: path.dirname(file), console,
    process: { env: { ELECTRON_RUN_AS_NODE: '1' } },
    require: name => {
      if (name === 'node:fs' || name === 'fs') return { mkdirSync() {}, mkdtempSync: () => '/scratch/capture', writeFileSync() {} };
      if (name.includes('build-preload')) return { buildPreloadBundle: () => { calls.push('build'); } };
      if (name === 'playwright-core') return { _electron: { launch: async options => { calls.push(options); throw new Error('fake launch'); } } };
      return localRequire(name);
    },
  });
  await assert.rejects(module.exports.runCapture(), /fake launch/);
  assert.equal(calls[0], 'build');
  assert.equal(calls[1].args[0], '.');
  assert.equal(calls[1].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[1].env.JENNY_AGENT_DEV, '1');
});
