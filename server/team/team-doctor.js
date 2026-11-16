'use strict';

// `node server/cli.js team-doctor --config <path>` (slice 3-11): the checks that apply to a team host,
// run in its container with the server stopped (the setup service) or running (`exec`). The Docker setup
// doctor (server/setup.js) is for a single-owner host and does not understand a team config, so this
// says so in its first line. Read only: no profile lock, nothing written. It prints status words, never
// a path, the key or an invite; a refusal, or a failed check (`team_check_failed`, after the rows), is
// one reason word for the CLI to print.

const fs = require('node:fs');

const { loadHostConfig } = require('../config');
const { FileSecretStore, TEAM_HOST_SECRET_FILES } = require('../file-secret-store');
const { PUBLIC_KEY_BYTES, decodeBase64url } = require('./ids');
const { isReadyMarkerLive } = require('./ready-marker');
const { probeBridgeVersion, resolveBridgeBinary } = require('./transport/bridge-binary');

const BRIDGE_PROTOCOL = 1;
const BRIDGE_FAILURES = Object.freeze({
  not_found: 'not found in this image or checkout; build it with npm run build:team-bridge',
  not_started: 'could not be started (a binary for another platform?)',
  bad_line: 'printed something other than its protocol line',
  timeout: 'gave no answer and was stopped',
});

// True when the host key file decodes to a key, as the team host reads it; the bytes are wiped at once.
function hostKeyPresent(config) {
  let seed = null;
  try {
    seed = decodeBase64url(new FileSecretStore({ directory: config.secretsDir, files: TEAM_HOST_SECRET_FILES })
      .get('team_host_key'), PUBLIC_KEY_BYTES);
    return Boolean(seed);
  } catch {
    return false;
  } finally {
    seed?.fill(0);
  }
}

function projectsRootRow(root) {
  if (!root) return { ok: true, text: 'not configured (no shared project folders)' };
  let present;
  try { present = fs.lstatSync(root).isDirectory(); } catch { present = false; }
  return present ? { ok: true, text: 'present' }
    : { ok: false, text: 'missing (team_projects_root_missing); create projects/ in the data volume' };
}

async function bridgeRow({ resolveBinary, probeBridge }) {
  let read = { ok: false, reason: 'not_found' };
  try {
    const binaryPath = resolveBinary();
    if (binaryPath) read = await probeBridge({ binaryPath });
  } catch { read = { ok: false, reason: 'not_started' }; }
  if (read.ok && read.protocol === BRIDGE_PROTOCOL) return { ok: true, text: read.line };
  if (read.ok) return { ok: false, text: `speaks protocol ${read.protocol}; this build expects ${BRIDGE_PROTOCOL}` };
  if (read.reason === 'exited') return { ok: false, text: `its --version run exited with code ${read.code}` };
  return { ok: false, text: BRIDGE_FAILURES[read.reason] ?? BRIDGE_FAILURES.not_started };
}

async function runTeamDoctor({
  configPath, output = process.stdout, loadConfig = loadHostConfig, resolveBinary = resolveBridgeBinary,
  probeBridge = probeBridgeVersion, isLive = isReadyMarkerLive,
} = {}) {
  let config;
  try { config = loadConfig(configPath); } catch (error) {
    return { ok: false, reason: typeof error?.reason === 'string' ? error.reason : 'config_invalid' };
  }
  if (!config.team) return { ok: false, reason: 'team_config_required' };
  const say = (line) => output.write(`${line}\n`);
  const { keySource } = config.team;
  say(`Configuration: team host (key source ${keySource}); the Docker setup doctor does not apply to it.`);
  const key = keySource === 'secret_file'
    ? (hostKeyPresent(config) ? { ok: true, text: 'present' }
      : { ok: false, text: 'missing or invalid; run team-keygen with the team server stopped' })
    : { ok: true, text: 'held by the desktop app (parent channel)' };
  say(`Host key file: ${key.text}`);
  const root = projectsRootRow(config.team.projectsRoot ?? null);
  say(`Projects root: ${root.text}`);
  const bridge = await bridgeRow({ resolveBinary, probeBridge });
  say(`Team bridge: ${bridge.text}`);
  let live;
  try { live = isLive({ userDataPath: config.userDataPath }) === true; } catch { live = false; }
  say(`Team server: ${live ? 'running and ready' : 'not running, or not ready yet'}`);
  return key.ok && root.ok && bridge.ok ? { ok: true } : { ok: false, reason: 'team_check_failed' };
}

module.exports = { runTeamDoctor };
