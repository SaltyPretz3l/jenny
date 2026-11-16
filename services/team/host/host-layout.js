'use strict';

// Where the desktop keeps the team host it runs (slice 1f-2), and the schema 3
// config it writes for it:
//
//   <userData>/team-host/host-config.json   the config the host reads (--config)
//   <userData>/team-host/profile/           the host profile (its own owner marker and lock)
//   <userData>/team-host/secrets/           exists and stays empty: the key travels on the channel
//   <userData>/team-host/runtime/           the hosted sidecar's home
//   <userData>/team-host/projects/          the team's project folders (the config's projects_root)
//   <userData>/team-host/trash/             deleted project folders until the sweep (not in the config)
//   <userData>/team-host/logs/              the host child's own log lines (host-log.js; not in the config)
//
// Every path written is the real path (`fs.realpathSync.native`), so a
// junction, an 8.3 short name or a `subst` drive cannot fail the host's path
// guard. The config holds no key and no secret (`key_source: parent_channel`).
// The team block's `internet` is carried through unchanged; the relay token is
// never in the config (it lives in the secure store).
// `team-host` is deliberately not a known profile child: the desktop cleanup and
// the uninstaller keep it (it holds a team's membership) and report it as unknown.

const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('../../host/durable-json');
const { MEMBERS_FILE } = require('../../../server/team/member-store');
const { deleteMarked } = require('./host-sweep');

const HOST_DIR_NAME = 'team-host';
const CONFIG_NAME = 'host-config.json';
const PROFILE_DIR_NAME = 'profile';
const LOGS_DIR_NAME = 'logs';
const CONFIG_MAX_BYTES = 128 * 1024;
// The schemas server/config.js loads; Deploy writes 3. A newer one is refused there and never rewritten here.
const KNOWN_SCHEMAS = new Set([1, 2, 3]);
const CONFIG_UNREADABLE = 'team_host_config_unreadable';

function hostRootOf(userDataPath) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new TypeError('The team host needs an absolute user data path.');
  }
  return path.join(userDataPath, HOST_DIR_NAME);
}

/**
 * Creates the seven places and returns their real paths. A `team-host` that carries a committed delete's mark is a
 * delete for the sweep to finish, never a place for a new or restarted team (R09-F01): `team_delete_unfinished`.
 */
function prepareHostLayout(userDataPath) {
  const root = hostRootOf(userDataPath);
  if (deleteMarked(root)) throw Object.assign(new Error('team_delete_unfinished'), { reason: 'team_delete_unfinished' });
  const real = (target) => {
    fs.mkdirSync(target, { recursive: true });
    return fs.realpathSync.native(target);
  };
  const rootPath = real(root);
  return Object.freeze({
    root: rootPath,
    configPath: path.join(rootPath, CONFIG_NAME),
    profile: real(path.join(rootPath, PROFILE_DIR_NAME)),
    secrets: real(path.join(rootPath, 'secrets')),
    runtime: real(path.join(rootPath, 'runtime')),
    projects: real(path.join(rootPath, 'projects')),
    trash: real(path.join(rootPath, 'trash')),
    logs: real(path.join(rootPath, LOGS_DIR_NAME)),
  });
}

/**
 * The saved config three ways (review sweeps, second run, X4b-F02 and first-run X4-F07): `{ saved, reason }` with
 * `saved` the config that read (schema 1 to 3, as the host's loader takes them) or null, and `reason` null or
 * CONFIG_UNREADABLE for a file that is there and does not read (torn, not JSON, over the cap, a second link, a read
 * that failed, or a schema this Jenny does not know, a newer one included). Only an absent file is "not deployed";
 * nothing may rewrite a file that answers the reason. Never throws.
 */
function readHostConfigState(userDataPath) {
  const file = path.join(hostRootOf(userDataPath), CONFIG_NAME);
  try {
    const value = readJson(file, { maxBytes: CONFIG_MAX_BYTES }); // null only for ENOENT; any other root throws
    if (value === null) return { saved: null, reason: null };
    if (KNOWN_SCHEMAS.has(value.schema_version)) return { saved: value, reason: null };
  } catch (error) {
    if (error?.code === 'ENOTDIR') return { saved: null, reason: null };
  }
  return { saved: null, reason: CONFIG_UNREADABLE };
}

/** The saved config that read, or null (none there, or it does not read: readHostConfigState says which). */
function readSavedHostConfig(userDataPath) {
  return readHostConfigState(userDataPath).saved;
}

/** The refusal word for a call that needs a saved config and has none: unreadable or not deployed. */
function notDeployedReason(userDataPath) {
  return readHostConfigState(userDataPath).reason || 'team_host_not_deployed';
}

// True only when the path is positively not there; any other outcome, an error included, is "there".
function positivelyAbsent(file) {
  try {
    fs.statSync(file);
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  }
  return false;
}

/**
 * Whether this profile hosted a team before: the config file or the host profile's member store file
 * is there, or the check could not tell. Neither file is opened, so a damaged config still counts.
 */
function hostWasDeployed(userDataPath) {
  const root = hostRootOf(userDataPath);
  return !positivelyAbsent(path.join(root, CONFIG_NAME)) || !positivelyAbsent(path.join(root, PROFILE_DIR_NAME, MEMBERS_FILE));
}

function savedDirectPort(saved) {
  const port = saved?.team?.direct_port;
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The saved team block's `internet` record as written, or null (off). The host's loader judges it. */
function savedInternet(saved) {
  const internet = saved?.team?.internet;
  return internet !== null && typeof internet === 'object' && !Array.isArray(internet) ? internet : null;
}

function savedTeamName(saved) {
  const name = saved?.team?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** The pool's context length cap on every host Deploy writes (slice 4a-5); no setting changes it. */
const DEPLOY_POOL_CONTEXT_LENGTH = 32768;

/**
 * The schema 3 team config. Slice 4a-5 (E65): the GPU pool is always on (`team.pool`), so the host
 * starts its sidecar on the pool gateway; members' Jennys, the owner's included, share GPUs into it.
 * No `model_endpoint`, ever (the loader refuses one beside `pool`). `lockPython` only from a source
 * checkout: the desktop sidecar's interpreter runs the hosted sidecar there (the loader's default
 * is the Docker image's) and, on Linux, `profile_lock.py`; a packaged app runs its packaged sidecar.
 * A path with no file behind it is not written: the host then reports its model unavailable.
 */
function buildHostConfig({ layout, name, directPort, lockPython = null, internet = null }) {
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
    ...(lockPython && fs.existsSync(lockPython) ? { python_executable: lockPython } : {}),
    team: { name, key_source: 'parent_channel', direct_port: directPort, projects_root: layout.projects,
      ...(internet ? { internet } : {}), pool: { context_length: DEPLOY_POOL_CONTEXT_LENGTH } },
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
  DEPLOY_POOL_CONTEXT_LENGTH, LOGS_DIR_NAME, buildHostConfig, hostWasDeployed, notDeployedReason, pickDirectPort,
  prepareHostLayout, probeDirectPort, readHostConfigState, readSavedHostConfig, savedDirectPort, savedInternet, savedTeamName,
  writeHostConfig,
};
