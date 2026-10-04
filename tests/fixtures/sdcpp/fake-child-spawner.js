'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sanitizeSpawnEnv } = require('../../../services/backend/sanitize-spawn-env');

const args = process.argv.slice(2);
const pidFile = args[args.indexOf('--pid-file') + 1];
const output = args[args.indexOf('-o') + 1];
const child = spawn(process.execPath, [path.join(__dirname, 'fake-sd-cli.js'),
  '-o', output, '--mode', 'hang'], {
  detached: true, windowsHide: true, stdio: 'ignore', env: sanitizeSpawnEnv(process.env),
});
child.on('error', (error) => {
  process.stderr.write(`spawn_error:${error.code}\n`);
  process.exitCode = 1;
});
fs.writeFileSync(pidFile, String(child.pid));
child.unref();
setTimeout(() => { process.exitCode = 0; }, 2500);
