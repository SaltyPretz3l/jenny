'use strict';

// `jenny doctor --team`: the checks a PC runs before its first team test (the
// checklist "Team: getting a second PC ready"). Each team row passes or fails;
// a row that cannot tell fails. The two manual rows carry their instruction and
// never change the exit code. Every outside effect is injected. Loaded only for
// --team (cli/doctor.js).

const fs = require('node:fs');
const path = require('node:path');

const { buildFeatureFlags } = require('../services/feature-flags');
const { createCliHost, hostComposition } = require('../services/cli-host/host');
const { acquireCliProfile, CLI_PROFILE_ERROR_CODES } = require('../services/cli-host/profile-lock');
const { hostLaunchOptions, lockOptions } = require('../services/cli-host/runtime-layout');
const { PROBE_TIMEOUT_MS, probeBridgeVersion, resolveBridgeBinary } = require('../server/team/transport/bridge-binary');
const { check } = require('./doctor');
const { CLOSE_TIMEOUT_MS, withTimeout } = require('./print');

// The protocol in the team bridge's version line. No JavaScript constant
// checks it (the control channel speaks JSON lines with no version field), so
// this is the number in the bridge crate's VERSION_LINE (src/lib.rs under
// native/); a test holds the two equal.
const BRIDGE_PROTOCOL = 1;
// PROTOCOL_VERSION in services/team/team-session.js, which does not export it
// (a test holds the two equal).
const TEAM_PROTOCOL_VERSION = 1;
const MODEL_TIMEOUT_MS = 30_000;
// The free space the profile's drive must have before a team test.
const MIN_FREE_GIB = 20;
const GIB = 1024 ** 3;
const CHECKLIST = 'checklist "Team: getting a second PC ready"';

function teamFlagRow(env) {
  const on = buildFeatureFlags(env).team === true;
  return check('team_flag', on, on ? 'the Team feature is on'
    : 'off: JENNY_ENABLE_TEAM=0 is set; remove it for this command and for the Jenny app, then restart the app');
}

const BRIDGE_FAILURES = Object.freeze({
  not_found: 'the team bridge was not found in this install (sidecar folder)',
  not_started: 'the team bridge could not be started',
  bad_line: 'the team bridge printed something other than its protocol line',
  timeout: `the team bridge gave no answer within ${PROBE_TIMEOUT_MS / 1000} s and was stopped`,
});

function bridgeDetail(read, matches) {
  if (matches) return read.line;
  if (read.ok) return `the team bridge speaks protocol ${read.protocol}; this build expects ${BRIDGE_PROTOCOL}`;
  if (read.reason === 'exited') return `the team bridge's --version run exited with code ${read.code}`;
  return BRIDGE_FAILURES[read.reason];
}

function versionsNote(appVersion, protocol) {
  if (!appVersion) return ' (the app version could not be read, so the two PCs cannot be compared)';
  return protocol !== null && protocol !== BRIDGE_PROTOCOL ? ` (this build expects ${BRIDGE_PROTOCOL})` : '';
}

async function bridgeRows({ runtime, appVersion, resolveBinary, probeBridge, spawnChild, timers }) {
  const binaryPath = resolveBinary({ resourcesPath: runtime.resourcesPath || '', root: runtime.root });
  let read = { ok: false, reason: 'not_found' };
  if (binaryPath) {
    try { read = await probeBridge({ binaryPath, spawnChild, timers }); } catch (_error) { read = { ok: false, reason: 'not_started' }; }
  }
  const protocol = read.ok ? read.protocol : null;
  const matches = protocol === BRIDGE_PROTOCOL;
  return [
    check('team_bridge', matches, bridgeDetail(read, matches)),
    check('team_versions', matches && Boolean(appVersion),
      `app ${appVersion || 'unknown'}, team protocol ${TEAM_PROTOCOL_VERSION}, bridge protocol ${protocol ?? 'unknown'}`
      + versionsNote(appVersion, protocol)),
  ];
}

function freeDiskRow({ profilePath, statfs }) {
  let free = NaN;
  try {
    const stats = statfs(profilePath);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch (_error) { /* reported below */ }
  if (!Number.isFinite(free)) return check('team_free_disk', false, 'the free space on the profile\'s drive could not be read');
  const gib = free / GIB;
  return check('team_free_disk', gib >= MIN_FREE_GIB,
    `${gib.toFixed(1)} GiB free on the profile's drive (needs ${MIN_FREE_GIB} GiB)`);
}

const MODEL_FAILURES = Object.freeze({
  unused: 'this CLI profile has not been used yet: run `jenny sessions list` in your project folder once, then this again',
  no_root: 'the folder this CLI profile last worked in is gone: run `jenny sessions list` in your project folder once, then this again',
  busy: 'the CLI profile is in use by another jenny command: close it, then run this again',
  start: 'the sidecar did not start: run plain `jenny doctor` and fix what it reports',
  engine: 'the engine did not answer: start it, then run this again',
});

// The probe's answer or a FAIL at MODEL_TIMEOUT_MS; then the probe is stopped,
// and a stop that does not confirm the sidecar exited fails the row whatever
// the answer was. The command stops nothing by name: a pid is for the person.
async function engineModelRow({ settings, runtime, startModelProbe, timers }) {
  const engine = settings.engine;
  let probe;
  try {
    probe = startModelProbe({ settings, runtime });
  } catch (_error) {
    return check('team_engine_model', false, `${engine}: ${MODEL_FAILURES.start}`);
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = timers.setTimeout(() => resolve({ timedOut: true }), MODEL_TIMEOUT_MS);
  });
  const answer = await Promise.race([
    probe.result.then((count) => ({ count }), (error) => ({ failed: MODEL_FAILURES[error?.stage] ? error.stage : 'start' })),
    timeout,
  ]);
  timers.clearTimeout(timer);
  let stopped = null;
  try { stopped = await probe.stop(); } catch (_error) { /* unconfirmed, reported below */ }
  if (stopped?.exited !== true) {
    const pid = Number.isSafeInteger(stopped?.pid) && stopped.pid > 0 ? ` (pid ${stopped.pid})` : '';
    return check('team_engine_model', false,
      `${engine}: the sidecar did not confirm it stopped, so a Jenny sidecar may still be running${pid}: check Task Manager`);
  }
  if (answer.timedOut) {
    return check('team_engine_model', false, `${engine}: no answer within ${MODEL_TIMEOUT_MS / 1000} s`
      + ' (a first sidecar start on a new PC can take that long, or the engine is silent): run this again');
  }
  if (answer.failed) return check('team_engine_model', false, `${engine}: ${MODEL_FAILURES[answer.failed]}`);
  const count = Number.isSafeInteger(answer.count) ? answer.count : 0;
  return check('team_engine_model', count > 0, `${engine}, ${count} model${count === 1 ? '' : 's'}`);
}

function stageError(stage) {
  return Object.assign(new Error(stage), { stage });
}

// The folder the profile already works in. Handing the composition that root
// keeps it from rewriting shell-config.json; a profile with none has never been
// used by the CLI and is refused rather than created.
function storedWorkspaceRoot(profilePath) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(profilePath, 'shell-config.json'), 'utf8'));
  } catch (_error) {
    throw stageError('unused');
  }
  const root = state?.toolsWorkspaceRoot;
  try {
    if (typeof root === 'string' && root !== '' && fs.statSync(root).isDirectory()) return root;
  } catch (_error) { /* reported below */ }
  throw stageError('no_root');
}

const CLI_HOST = Object.freeze({ acquireCliProfile, createCliHost, hostComposition, closeTimeoutMs: CLOSE_TIMEOUT_MS });

// The real probe: the CLI's own host (print mode's composition) under the
// profile lock, its sidecar started, the engine asked for its models. Resolves
// to the model count or rejects with a `stage`. `stop()` closes the host and
// answers `{ exited: true }` only when the composition confirmed the sidecar
// exited, else `{ exited: false, pid }`; the lock is released either way. The
// seam is `host`: createCliHost's port (`start`, `close`) and hostComposition's
// `backend.listModelsForEngine`.
function startCliModelProbe({ settings, runtime }, host = CLI_HOST) {
  let held = null;
  let port = null;
  let stopping = null;
  const stop = () => (stopping ||= (async () => {
    try {
      if (!port) return { exited: true };
      const closed = await withTimeout(port.close(), host.closeTimeoutMs, () => null);
      return closed?.sidecar_exited === true ? { exited: true } : { exited: false, pid: closed?.pid };
    } finally {
      held?.release();
    }
  })());
  const result = (async () => {
    const workspaceRoot = storedWorkspaceRoot(settings.profilePath);
    try {
      held = await host.acquireCliProfile({ userDataPath: settings.profilePath, ...lockOptions(runtime) });
    } catch (error) {
      throw stageError(error?.code === CLI_PROFILE_ERROR_CODES.BUSY ? 'busy' : 'start');
    }
    if (stopping) { held.release(); throw stageError('start'); }
    try {
      port = host.createCliHost({
        profilePath: settings.profilePath, workspaceRoot, ...hostLaunchOptions(runtime),
        engine: { type: settings.engine, model: settings.model },
        permissions: { allowedTools: [], disallowedTools: [], permissionMode: 'plan' },
        logger: () => {},
      });
      await port.start();
    } catch (_error) {
      throw stageError('start');
    }
    let listed;
    try { listed = await host.hostComposition(port).backend.listModelsForEngine(settings.engine); } catch (_error) { listed = null; }
    if (listed?.available === false || !Array.isArray(listed?.data)) throw stageError('engine');
    return listed.data.length;
  })();
  return { result, stop };
}

const DEFAULTS = Object.freeze({
  resolveBinary: resolveBridgeBinary,
  probeBridge: probeBridgeVersion,
  timers: { setTimeout, clearTimeout },
  statfs: (target) => fs.statfsSync(target),
  startModelProbe: (args) => startCliModelProbe(args),
});

const MANUAL = Object.freeze([
  Object.freeze({ name: 'team_firewall',
    detail: `when Windows asks, allow Jenny on Private networks only (${CHECKLIST}, Firewall)` }),
  Object.freeze({ name: 'team_port_mapping',
    detail: `a member PC needs no port mapping; only a host taking members over the internet does (${CHECKLIST}, Port mapping)` }),
]);

// The team rows and the manual rows, in the order the checklist lists them.
async function runTeamDoctor({ settings, env, appVersion, runtime, deps = {} }) {
  const effects = { ...DEFAULTS, ...deps };
  const checks = [
    teamFlagRow(env),
    ...await bridgeRows({ runtime, appVersion, ...effects }),
    freeDiskRow({ profilePath: settings.profilePath, statfs: effects.statfs }),
    await engineModelRow({ settings, runtime, startModelProbe: effects.startModelProbe, timers: effects.timers }),
  ];
  return { checks, manual: MANUAL.map((entry) => ({ ...entry })) };
}

module.exports = { BRIDGE_PROTOCOL, MODEL_TIMEOUT_MS, TEAM_PROTOCOL_VERSION, runTeamDoctor, startCliModelProbe };
