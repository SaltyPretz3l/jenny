'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Trusted composition input, never a browser or model supplied path. Python
// opens its startup log before initialize, so this must happen before spawn.
function hostedSidecarEnvironment(environment, runtimeHome) {
  if (!path.isAbsolute(runtimeHome)) throw new Error('invalid_runtime_home');
  try {
    fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(runtimeHome);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync(runtimeHome) !== path.resolve(runtimeHome)) throw new Error('invalid_runtime_home');
    fs.accessSync(runtimeHome, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (_error) {
    throw new Error('invalid_runtime_home', { cause: _error });
  }
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (/^JENNY_/i.test(key) || /^(PYTHONPATH|PYTHONHOME)$/i.test(key)) delete result[key];
  }
  return {
    ...result, HOME: runtimeHome, USERPROFILE: runtimeHome,
    XDG_CACHE_HOME: path.join(runtimeHome, '.cache'),
    XDG_CONFIG_HOME: path.join(runtimeHome, '.config'),
    XDG_DATA_HOME: path.join(runtimeHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(runtimeHome, '.local', 'state'),
  };
}

module.exports = { hostedSidecarEnvironment };
