'use strict';

// Deploy, Stop, Status and Recover for the team host this Jenny runs (slice
// 1f-2), behind the `team.host*` IPC methods. Main process only.
//
// Deploy: refuse a platform the host cannot run on and a secure store that is
// not ready (unavailable, basic_text), both before anything is spawned or
// written; then take the stored host key or make one
// (one read, never overwrite), write the schema 3 config with real paths, start
// the host child with --team-init unless this Jenny already holds a membership
// of the key's team, and hand the one `owner_invite` to the member client's join
// with the owner's names and the loopback fallback address. A host whose store
// already has an owner says `owner_exists` and Deploy answers at once. Recover:
// restart the host with --team-recover and redeem the one invite through the
// member client's recovery path. A Stop pressed at any point before the child is
// started wins. The invite string stays in this process: it reaches no log,
// state snapshot, IPC answer or file. A state pushed to the renderer carries no
// address. Every refusal zeroes the seed it read. The host has no model (owner
// decision E19: none until Phase 4), so Deploy works whatever engine the
// desktop runs and the config names no model and no interpreter.

const { deriveTeamId, keyPairFromSeed } = require('../../../server/team/ids');
const { HOST_METHODS, validatePayload } = require('../ipc-methods');
const { failureOf, invalidRequest, teamFailure } = require('../team-errors');
const { createHostKeyStore } = require('./host-key-store');
const {
  buildHostConfig, pickDirectPort: defaultPickDirectPort, prepareHostLayout, probeDirectPort: defaultProbeDirectPort,
  readSavedHostConfig, savedDirectPort, savedTeamName, writeHostConfig,
} = require('./host-layout');
const { createHostSupervisor } = require('./host-supervisor');

const OWNER_INVITE_WAIT_MS = 15_000;
const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);

const hostFailure = (reason) => teamFailure('HOST_UNAVAILABLE', reason);

// Windows uses the named-pipe profile lock. Linux needs the flock helper, which a
// packaged app cannot hand to Python (it sits inside app.asar for the host);
// macOS has no hosted profile lock at all.
function platformSupported(platform, isPackaged) {
  if (platform === 'win32') return true;
  return platform === 'linux' && !isPackaged;
}

/**
 * `isPackaged` and `lockPython` are getters (asked on each Deploy); `lockPython` is the Linux
 * profile lock's interpreter and is never asked on Windows. `hostKeys` replaces the secure-store
 * key store in tests.
 */
function createHostController({
  userDataPath, getSecureStore, getTeamService = () => null, platform = process.platform, isPackaged = () => true,
  fork, entryPath, environment = {}, lockPython = () => null, pickDirectPort = defaultPickDirectPort, probeDirectPort = defaultProbeDirectPort, bounds = {}, sendState = () => {},
  log = () => {}, hostKeys = null,
}) {
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const keys = hostKeys || createHostKeyStore({ getSecureStore });
  // The team id of the stored host key, once read (slice 1g-1); only a derived id is kept, never the seed.
  let storedTeamId = null;

  // Read lazily, only for a deployed profile whose running host does not name its team; a failing
  // store gives null and is asked again next time. The seed is zeroed as soon as the id is derived.
  function teamIdOfStoredKey() {
    if (storedTeamId) return storedTeamId;
    let seed = null;
    try {
      seed = keys.load();
      if (seed) storedTeamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
    } catch {
      return null;
    } finally {
      seed?.fill(0);
    }
    return storedTeamId;
  }

  // The state the renderer may see: no address, no key, no invite. `deployed` says a host config was
  // saved here before, so a new app session can tell a stopped team from none at all.
  function publicHostState(snapshot) {
    const savedName = savedTeamName(readSavedHostConfig(userDataPath));
    const deployed = savedName !== null;
    return { state: snapshot.state, team_id: snapshot.team_id || (deployed ? teamIdOfStoredKey() : null),
      team_name: snapshot.team_name || savedName, deployed, reason: snapshot.reason, since: snapshot.since };
  }

  const supervisor = createHostSupervisor({ fork, entryPath, env: environment, bounds, log: say });
  const unsubscribe = supervisor.onState((snapshot) => {
    try { sendState(publicHostState(snapshot)); } catch { say('WARN', 'team.host.state_push_failed'); }
  });
  const ownerInviteMs = Number.isSafeInteger(bounds.ownerInviteMs) ? bounds.ownerInviteMs : OWNER_INVITE_WAIT_MS;
  let operation = null;
  let generation = 0;
  let disposed = false;

  const packaged = () => isPackaged() !== false;
  const linuxLockPython = () => {
    if (platform !== 'linux' || packaged()) return null;
    const value = lockPython();
    return typeof value === 'string' && value ? value : null;
  };
  const cancelled = (startGeneration) => startGeneration !== generation || disposed;

  // Waits for the one owner invite (or `owner_exists`), or the host failing, or the bound.
  function waitForInvite(invitePromise) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stopWatching();
        resolve(value);
      };
      const timer = setTimeout(() => finish({ missing: true }), ownerInviteMs);
      const stopWatching = supervisor.onState((snapshot) => {
        if (snapshot.state === 'failed' || snapshot.state === 'stopped' || snapshot.state === 'stopping') {
          finish({ failed: snapshot.reason || 'team_host_stopped' });
        }
      });
      invitePromise.then(finish);
      const now = supervisor.snapshot();
      if (now.state !== 'running') finish({ failed: now.reason || 'team_host_stopped' });
    });
  }

  // The saved direct port while it is free; otherwise a new one (saved with the config by the caller).
  async function chooseDirectPort() {
    const saved = savedDirectPort(readSavedHostConfig(userDataPath));
    if (saved !== null) {
      if (await probeDirectPort(saved)) return saved;
      say('WARN', 'team.host.direct_port_replaced');
    }
    return pickDirectPort();
  }

  async function joinOwner({ invite, directPort, owner }) {
    const service = getTeamService();
    if (!service) return hostFailure('team_owner_join_unavailable');
    const payload = { invite, display_name: owner.displayName, label: owner.label,
      extraAddresses: [`127.0.0.1:${directPort}`] };
    try {
      return owner.recover ? await service.ownerRecover(payload) : await service.ownerJoin(payload);
    } catch (error) {
      return failureOf(error);
    } finally {
      payload.invite = null;
    }
  }

  // Writes the config and starts the host, unless a Stop came after `startGeneration` was taken.
  async function launch({ startGeneration, seed, name, flag, owner }) {
    let layout;
    let directPort;
    try {
      layout = prepareHostLayout(userDataPath);
      directPort = await chooseDirectPort();
      writeHostConfig(layout, buildHostConfig({ layout, name, directPort, lockPython: linuxLockPython() }));
    } catch {
      seed.fill(0);
      say('WARN', 'team.host.config_write_failed');
      return hostFailure('team_host_config_write_failed');
    }
    if (cancelled(startGeneration)) {
      seed.fill(0);
      return hostFailure('team_host_stopped');
    }
    let deliver;
    const invitePromise = new Promise((resolve) => { deliver = resolve; });
    const started = await supervisor.start({ args: ['--config', layout.configPath, ...(flag ? [flag] : [])],
      hostKey: seed, teamName: name, onOwnerInvite: (invite) => deliver({ invite }),
      onOwnerExists: () => deliver({ exists: true }) });
    if (!started.ok) return started;
    const answer = (result) => ({ ok: true, host: publicHostState(supervisor.snapshot()), owner: result });
    if (!flag) return answer({ state: 'member', team_id: owner.teamId });
    const waited = await waitForInvite(invitePromise);
    if (waited.failed) return hostFailure(waited.failed);
    if (waited.missing || waited.exists) {
      const reason = waited.exists ? 'team_owner_recover_needed' : 'team_owner_invite_missing';
      return answer({ state: 'failed', error: hostFailure(reason).error });
    }
    const joined = await joinOwner({ invite: waited.invite, directPort, owner });
    waited.invite = null;
    say('INFO', 'team.host.owner_join', { recover: owner.recover === true, ok: joined.ok === true,
      ...(joined.ok ? {} : { reason: joined.error?.reason || 'none' }) });
    return answer(joined.ok
      ? { state: owner.recover ? 'recovered' : 'joined', team_id: joined.team?.team_id ?? owner.teamId }
      : { state: 'failed', error: { code: joined.error.code, reason: joined.error.reason } });
  }

  async function deploy({ name, display_name: displayName, label }) {
    const startGeneration = generation;
    if (!platformSupported(platform, packaged())) return hostFailure('team_host_platform_unavailable');
    if (ACTIVE_STATES.has(supervisor.snapshot().state)) return invalidRequest('team_host_busy');
    let seed = null;
    try {
      seed = keys.loadOrCreate().seed;
      const teamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
      storedTeamId = teamId;
      const service = getTeamService();
      const member = Boolean(service) && service.holds(teamId) === true;
      return await launch({ startGeneration, seed, name, flag: member ? null : '--team-init',
        owner: { teamId, displayName, label, recover: false } });
    } catch (error) {
      seed?.fill(0);
      return failureOf(error);
    }
  }

  async function recover({ display_name: displayName, label }) {
    const startGeneration = generation;
    if (!platformSupported(platform, packaged())) return hostFailure('team_host_platform_unavailable');
    let seed = null;
    try {
      seed = keys.load();
      const name = savedTeamName(readSavedHostConfig(userDataPath));
      if (!seed || !name) {
        seed?.fill(0);
        return hostFailure('team_host_not_deployed');
      }
      const teamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
      storedTeamId = teamId;
      if (ACTIVE_STATES.has(supervisor.snapshot().state)) await supervisor.stop();
      return await launch({ startGeneration, seed, name, flag: '--team-recover',
        owner: { teamId, displayName, label, recover: true } });
    } catch (error) {
      seed?.fill(0);
      return failureOf(error);
    }
  }

  // One Deploy or Recover at a time; Stop and Status always answer.
  async function exclusive(run) {
    if (operation) return invalidRequest('team_host_busy');
    operation = run();
    try { return await operation; } finally { operation = null; }
  }

  async function stopHost() {
    generation += 1;
    const snapshot = await supervisor.stop();
    return { ok: true, host: publicHostState(snapshot) };
  }

  async function handle(method, payload) {
    if (!HOST_METHODS.includes(method)) return invalidRequest();
    const checked = validatePayload(method, payload);
    if (!checked.ok) return invalidRequest();
    if (method === 'hostStatus') return { ok: true, host: publicHostState(supervisor.snapshot()) };
    if (disposed) return hostFailure('team_host_shutting_down');
    let answer;
    try {
      if (method === 'hostStop') answer = await stopHost();
      else if (method === 'hostDeploy') answer = await exclusive(() => deploy(checked.value));
      else answer = await exclusive(() => recover(checked.value));
    } catch (error) {
      answer = failureOf(error);
    }
    say('INFO', 'team.host.ipc.answered', { method, ok: answer.ok === true,
      ...(answer.ok === true ? {} : { reason: answer.error?.reason || 'none' }) });
    return answer;
  }

  // The app's shutdown task: the same stop path, then nothing is left.
  async function stop() {
    disposed = true;
    generation += 1;
    await supervisor.stop();
    unsubscribe();
  }

  return {
    handle, stop, snapshot: () => publicHostState(supervisor.snapshot()), resources: () => supervisor.resources(),
  };
}

module.exports = { createHostController };
