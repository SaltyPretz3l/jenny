'use strict';

// Holds a CLI profile lock in a separate process for tests/cli-host/profile-lock.test.js:
// prints `held` once the lock is acquired, then waits for stdin to close (or a kill) so the
// parent can observe the busy refusal and the release on process death.

const { acquireCliProfile } = require('../../services/cli-host/profile-lock');

const [userDataPath, pythonExecutable = ''] = process.argv.slice(2);

acquireCliProfile({ userDataPath, pythonExecutable }).then((held) => {
  process.stdout.write(`held:${held.kind}\n`);
  process.stdin.resume();
  process.stdin.on('end', () => { held.release(); process.exit(0); });
}, (error) => {
  process.stdout.write(`refused:${error.reason || error.code}\n`);
  process.exit(3);
});
