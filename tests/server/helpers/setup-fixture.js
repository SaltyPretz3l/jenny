'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { defaultSource } = require('../../../server/setup');
function setupFixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['config', 'profile', 'secrets', 'workspace', 'runtime']) {
    fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  }
  const source = { ...defaultSource(), user_data_path: path.join(root, 'profile'),
    workspace_root: null, secrets_dir: path.join(root, 'secrets'),
    runtime_home: path.join(root, 'runtime'), python_executable: process.execPath };
  return { root, source, configPath: path.join(root, 'config', 'host.json') };
}
module.exports = { setupFixture };
