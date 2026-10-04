'use strict';

// Windows 11 power throttling (EcoQoS) parks windowless test processes on the
// efficiency cores (a 7.7 s jsdom file took 45 s, 2026-10-03). run_ci.py keeps
// its own process tree opted out; this starts the same keeper as a helper
// process for a direct safe-runner run (npm test, test:affected), which used to
// get no opt-out at all. The helper exits by itself when this runner does, and
// a failure to start it only means the run stays throttled.

const path = require('path');
const { spawn } = require('child_process');

const ACTIVE_ENV_VAR = 'JENNY_POWER_KEEPER_ACTIVE';
const KEEPER_SCRIPT = path.join(__dirname, 'checks', 'power_throttling_keeper.py');

function startPowerKeeper({
  platform = process.platform,
  env = process.env,
  pid = process.pid,
  spawnImpl = spawn,
} = {}) {
  // An outer keeper (run_ci.py or a parent safe-runner) already covers this tree.
  if (platform !== 'win32' || env[ACTIVE_ENV_VAR] === '1') return null;
  let child;
  try {
    child = spawnImpl('python', [KEEPER_SCRIPT, '--root-pid', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    // `python` missing arrives as an async 'error'; a helper that dies arrives as
    // 'exit'. Either way the tree is no longer covered, so drop the marker and
    // let a nested runner start its own keeper.
    const uncover = () => { if (env[ACTIVE_ENV_VAR] === '1') delete env[ACTIVE_ENV_VAR]; };
    child.on('error', uncover);
    child.on('exit', uncover);
    child.unref();
  } catch {
    return null;
  }
  env[ACTIVE_ENV_VAR] = '1';
  return child;
}

module.exports = { ACTIVE_ENV_VAR, KEEPER_SCRIPT, startPowerKeeper };
