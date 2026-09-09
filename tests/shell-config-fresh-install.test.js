'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONFIG_VERSION,
  ShellConfigService,
} = require('../services/shell-config-service');

function makeUserData(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-fresh-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return userDataPath;
}

test('ShellConfigService reports a missing config file as a fresh install', (t) => {
  const service = new ShellConfigService({ userDataPath: makeUserData(t) });

  assert.equal(service.isFreshInstall(), true);
});

test('ShellConfigService reports a pre-existing versioned config as non-fresh', (t) => {
  const userDataPath = makeUserData(t);
  fs.writeFileSync(
    path.join(userDataPath, 'shell-config.json'),
    JSON.stringify({ version: CONFIG_VERSION }),
    'utf8'
  );

  const service = new ShellConfigService({ userDataPath });

  assert.equal(service.isFreshInstall(), false);
});
