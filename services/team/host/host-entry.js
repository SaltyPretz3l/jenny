'use strict';

// The entry of the team host child the desktop starts (slice 1f-2): Electron's
// utility process loads this file (through Node's ESM loader, so server/main.js's
// `require.main === module` guard would not fire) and hands it the arguments
// `--config <abs path>` and at most one of `--team-init` / `--team-recover`.
// The parent channel is `process.parentPort`; the key arrives on it, never in
// an argument or the environment. Once the host has stopped, or failed to
// start, the process exits on its own: a utility process whose channel is
// paused may otherwise linger and the supervisor would have to end it.

const { main } = require('../../../server/main');
const { log } = require('../../../server/host-core');

const EXIT_DELAY_MS = 250;

// The host's own arguments: from `--config` to the end (anything before them is not ours).
function hostArguments(argv) {
  const at = Array.isArray(argv) ? argv.indexOf('--config') : -1;
  return at < 0 ? [] : argv.slice(at);
}

function exitSoon() {
  setTimeout(() => process.exit(), EXIT_DELAY_MS);
}

function run(argv = process.argv) {
  return main(hostArguments(argv)).then((host) => {
    // `stopped` settles on every stop: the parent's, a lost lock, a failed transport.
    host.stopped?.then(exitSoon, exitSoon);
    return host;
  }, (error) => {
    log('ERROR', 'host.start_failed');
    process.exitCode = 1;
    exitSoon();
    return error;
  });
}

// Only ever loaded as the entry of the host child; nothing requires this file.
run();
