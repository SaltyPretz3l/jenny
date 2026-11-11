'use strict';

// Where the desktop keeps the team host it runs (slice 1f-2), and the schema 3
// config it writes for it:
//
//   <userData>/team-host/host-config.json   the config the host reads (--config)
//   <userData>/team-host/profile/           the host profile (its own owner marker and lock)
//   <userData>/team-host/secrets/           exists and stays empty: the key travels on the channel
//   <userData>/team-host/runtime/           the hosted sidecar's home
//
// Every path written is the real path (`fs.realpathSync.native`), so a
// junction, an 8.3 short name or a `subst` drive cannot fail the host's path
// guard. The config holds no key and no secret (`key_source: parent_channel`).
// `team-host` is deliberately not a known profile child: the desktop cleanup and
// the uninstaller keep it (it holds a team's membership) and report it as unknown.

const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('../../host/durable-json');

const HOST_DIR_NAME = 'team-host';
const CONFIG_NAME = 'host-config.json';
const CONFIG_MAX_BYTES = 128 * 1024;

function hostRootOf(userDataPath) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new TypeError('The team host needs an absolute user data path.');
  }
  return path.join(userDataPath, HOST_DIR_NAME);
}

/** Creates the four places and returns their real paths. */
function prepareHostLayout(userDataPath) {
  const root = hostRootOf(userDataPath);
  const real = (target) => {
    fs.mkdirSync(target, { recursive: true });
    return fs.realpathSync.native(target);
  };
  const rootPath = real(root);
  return Object.freeze({
    root: rootPath,
    configPath: path.join(rootPath, CONFIG_NAME),
    profile: real(path.join(rootPath, 'profile')),
    secrets: real(path.join(rootPath, 'secrets')),
    runtime: real(path.join(rootPath, 'runtime')),
  });
}

/** The saved config, or null when there is none or it does not read; never throws. Reads only when the directory exists. */
function readSavedHostConfig(userDataPath) {
  const file = path.join(hostRootOf(userDataPath), CONFIG_NAME);
  try {
    const value = readJson(file, { maxBytes: CONFIG_MAX_BYTES });
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function savedDirectPort(saved) {
  const port = saved?.team?.direct_port;
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function savedTeamName(saved) {
  const name = saved?.team?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * The schema 3 team config with no model endpoint (E19: no model until Phase 4). `lockPython`
 * only on Linux from a source checkout: the profile lock there runs `profile_lock.py`, and the
 * loader's default interpreter is the Docker image's. No sidecar is ever started with it.
 */
function buildHostConfig({ layout, name, directPort, lockPython = null }) {
  return {
    schema_version: 3,
    host_mode: 'server',
    host_execution_policy_version: 1,
    listen_host: '127.0.0.1',
    port: 0,
    user_data_path: layout.profile,
    secrets_dir: layout.secrets,
    runtime_home: layout.runtime,
    workspace_root: null,
    ...(lockPython ? { python_executable: lockPython } : {}),
    team: { name, key_source: 'parent_channel', direct_port: directPort },
  };
}

/** Atomic and durable (temp file, fsync, rename). */
function writeHostConfig(layout, config) {
  writeJson(layout.configPath, config);
}

/**
 * A free UDP port for the host's direct (QUIC) socket, chosen once and kept in the
 * config so members' saved addresses survive a host restart. Bound on loopback
 * only for the probe, so choosing it opens nothing on a real interface.
 */
function pickDirectPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (error) => { socket.close(); reject(error); });
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

/**
 * True when `port` can be bound on loopback right now (another process may have
 * taken a saved port). Loopback only, like the pick, so the probe opens nothing
 * on a real interface; a holder bound to one other interface is not seen.
 */
function probeDirectPort(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => { socket.close(); resolve(false); });
    socket.bind(port, '127.0.0.1', () => socket.close(() => resolve(true)));
  });
}

module.exports = {
  buildHostConfig, pickDirectPort, prepareHostLayout, probeDirectPort, readSavedHostConfig, savedDirectPort, savedTeamName,
  writeHostConfig,
};
