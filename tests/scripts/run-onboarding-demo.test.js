'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('onboarding launches through supported start.js with its isolated profile', () => {
  const file = path.resolve(__dirname, '../../scripts/dev/run-onboarding-demo.js');
  const localRequire = createRequire(file);
  const calls = [];
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { __dirname: path.dirname(file), console: { log() {}, error() {} },
    process: { env: { ELECTRON_RUN_AS_NODE: '1' }, execPath: 'node.exe', platform: 'win32', on() {}, exit() {} },
    require: name => {
      if (name === 'node:fs') return { rmSync() {} };
      if (name === 'electron') return 'electron.exe';
      if (name.includes('refresh-onboarding-shortcut')) return { refreshOnboardingShortcut: () => ({ ok: false }) };
      if (name === 'node:child_process') return { spawnSync() {}, spawn: (...args) => { calls.push(args); return new EventEmitter(); } };
      return localRequire(name);
    },
  });
  assert.equal(calls[0][0], 'node.exe');
  assert.equal(calls[0][1][0], path.resolve(path.dirname(file), '../../start.js'));
  assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[0][2].env.JENNY_ONBOARDING_DEMO, '1');
});
