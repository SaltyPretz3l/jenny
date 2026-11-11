'use strict';

// Child process for tests/server/team-profile-lock.test.js: takes the hosted
// profile lock, prints `held` (or `refused:<code>`), then holds it until stdin
// closes. The parent stops it by the PID it started.

const { acquireProfileAsync } = require('../../../services/host/profile-ownership');

const [userDataPath, pythonExecutable = ''] = process.argv.slice(2);

acquireProfileAsync({ userDataPath, pythonExecutable }).then((held) => {
  process.stdout.write('held\n');
  process.stdin.resume();
  process.stdin.on('end', () => { held.release(); process.exit(0); });
}, (error) => {
  process.stdout.write(`refused:${error.code || error.message}\n`);
  process.exit(3);
});
