'use strict';

// Deploy, Stop, Status and Recover for the team host this Jenny runs (slice 1f-2), behind the `team.host*` IPC methods.
// Main process only.
//
// Deploy: refuse a platform the host cannot run on and a secure store that is not ready (unavailable, basic_text), both
// before anything is spawned or written; then read the stored key over a saved config, else make a fresh one (E75), write
// the schema 3 config with real paths, start the host child with --team-init unless this Jenny already holds a
// membership of the key's team, and hand the one `owner_invite` to the member client's join with the owner's names and
// the loopback fallback address. A host whose store already has an owner says `owner_exists` and Deploy answers at
// once. Recover: restart the host with --team-recover and redeem the one invite through the member client's recovery
// path. A Stop pressed at any point before the child is started wins. The invite string stays in this process: it
// reaches no log, state snapshot, IPC answer or file. A state pushed to the renderer carries no address. Every refusal
// zeroes the seed it read. The host has no model (owner decision E19: none until Phase 4), so Deploy works whatever
// engine the desktop runs and the config names no model and no interpreter.
//
// Slice 5-3: `hostReconnectCode` answers the owner's reconnect code for the running host
// (services/team/reconnect-code.js) from the supervisor's addresses and the injected internet setting. It is read-only:
// no lock that Deploy or Recover holds, no state change, no write; the code is answered to the renderer for the owner
// to copy and never logged. A host method with no branch of its own answers `invalid_request`; it never falls through
// to Recover.
//
// The public state carries `reach` (the running host's verdict, else null) and `direct_port` (the saved config's). A
// lost host key: a profile that was deployed (host-layout.js `hostWasDeployed`) and has no stored key refuses Deploy
// and Recover with nothing written, instead of giving the team a new identity. The reason says whether the secure store
// set a damaged file aside; no path or file name is answered or logged.
//
// The owner's relay token is read before anything is written or forked and travels only in the child's `start`; it is
// never logged or answered.
//
// Slice 5-6: the public state adds `internet` (the owner's saved setting with `has_token`, never the token), `key` and
// `old_teams`; LIFECYCLE_METHODS (inventory, delete, start a new team, old teams, export, restore) run in
// host-lifecycle.js under `exclusive`, owner-checked there.
//
// The host child's `membership_changed` asks the team service to push its teams snapshot again (`pushState`): one push
// ROSTER_PUSH_MS after the first message, a later message opening a new window. The child's kind and member id go
// nowhere; a stopped, released or replaced run, or a disposed controller, pushes nothing.
//
// E64: while Force local is on (`gate`, ../force-local-hold.js) Deploy, Recover, the internet setting, Restore and
// Start a new team are refused at their entry, before any file is written or moved; the state carries `force_local`. A
// hold stops the child through Stop and remembers, in memory, that it ran; the release starts it as Start does
// (host-force-local.js). A start the mode cuts (checked again once the child is up and after the invite wait) stops the
// child and answers `team_host_stopped`.
//
// 6-7, row 123: hostModelRelay, hostFileTools (host-model-relay.js, host-file-tools.js); state model_relay, file_tools.
// Row 201 (OD-5): hostPoolContext (host-pool-context.js): the owner's cap on the pool's context length; state pool_context_cap.
const { deriveTeamId, keyPairFromSeed } = require('../../../server/team/ids');
const { HOST_METHODS, validatePayload } = require('../ipc-methods');
const { failureOf, invalidRequest, teamFailure } = require('../team-errors');
const { createHostKeyState, lostHostKey } = require('./host-key-state');
const { createHostKeyStore, createHostRelayTokenStore } = require('./host-key-store');
const {
  buildHostConfig, hostWasDeployed, pickDirectPort: defaultPickDirectPort, prepareHostLayout,
  probeDirectPort: defaultProbeDirectPort, readSavedHostConfig, savedDirectPort, savedInternet, savedTeamName,
  notDeployedReason, readHostConfigState, writeHostConfig, carryFileTools,
} = require('./host-layout');
const { createHostSupervisor } = require('./host-supervisor');
const { buildHostReconnectCode } = require('../reconnect-code');
const { readInternetSetting } = require('../../../server/team/invites');
const { internetFromPayload, internetView, tokenStepOf, withInternet } = require('./host-internet-setting');
const { createHostLifecycle } = require('./host-lifecycle');
const { readAutostart } = require('./host-autostart');
const { createHostModelRelay } = require('./host-model-relay');
const { createHostFileTools } = require('./host-file-tools');
const { createHostPoolContext } = require('./host-pool-context');
const { readInternetDraft, removeInternetDraft } = require('./host-restore');
const { forceLocalFailure } = require('../force-local-hold');
const { createHostForceLocal } = require('./host-force-local');

const HELD_METHODS = new Set(['hostDeploy', 'hostRecover', 'hostInternet', 'hostRestore', 'hostStartNew', 'hostModelRelay', 'hostFileTools']);
const LIFECYCLE_METHODS = new Set(['hostInventory', 'hostDelete', 'hostStartNew', 'hostOldDelete', 'hostOldShow', 'hostExport',
  'hostExportCancel', 'hostRestorePick', 'hostRestore', 'hostAutostart', 'hostSummary', 'hostOpenFolder']);

const OWNER_INVITE_WAIT_MS = 15_000;
const ROSTER_PUSH_MS = 250;
// A restart keeps its port: the old listener gets this many probes, this far apart, to let go.
const PORT_RETRIES = 5;
const PORT_RETRY_MS = 200;
const ACTIVE_STATES = new Set(['starting', 'running', 'stopping']);

const hostFailure = (reason) => teamFailure('HOST_UNAVAILABLE', reason);
// What a half-done `hostInternet` changed, on its failure answer: some of 'token' and 'setting'.
const withChanged = (failure, changed) => ({ ...failure, changed: [...changed] });

// Windows uses the named-pipe profile lock. Linux needs the flock helper, which a
// packaged app cannot hand to Python (it sits inside app.asar for the host);
// macOS has no hosted profile lock at all.
function platformSupported(platform, isPackaged) {
  if (platform === 'win32') return true;
  return platform === 'linux' && !isPackaged;
}

/**
 * `isPackaged` and `lockPython` are getters (asked on each Deploy); `lockPython` is the desktop sidecar's
 * interpreter, asked only from a source checkout (4a-5: the hosted sidecar's). `hostKeys` and `relayTokens` replace the
 * secure-store stores in tests, and `writeConfig` the config write. `internet` is the host's internet
 * joining setting as invites.js `inviteContent` takes it, for the reconnect code; by default it is
 * read from the saved config (null while off).
 */
function createHostController({
  userDataPath, getSecureStore, getTeamService = () => null, platform = process.platform, isPackaged = () => true,
  fork, entryPath, environment = {}, lockPython = () => null, pickDirectPort = defaultPickDirectPort, probeDirectPort = defaultProbeDirectPort, bounds = {}, sendState = () => {},
  log = () => {}, hostKeys = null, relayTokens = null, writeConfig = writeHostConfig, internet = null, pick = {}, now = Date.now,
  gate = null,
}) {
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const keys = hostKeys || createHostKeyStore({ getSecureStore });
  const tokens = relayTokens || createHostRelayTokenStore({ getSecureStore });
  const internetSetting = internet || savedInternetSetting;
  const storedKey = createHostKeyState({ userDataPath, keys });
  // The team service with the saved teams loaded: a membership is looked for (held, removed) only after that.
  async function loadedService() { const service = getTeamService(); await service?.startExisting?.(); return service; }
  async function held(teamId) { const service = await loadedService(); return Boolean(service) && service.holds(teamId) === true; }

  // Slice 5-6: delete, start a new team, old teams, export and restore (host-lifecycle.js), with this controller's parts.
  const lifecycle = createHostLifecycle({ userDataPath, pick, now, bounds, say, lockPython: () => sourcePython(),
    host: {
      keys, tokens, keyState: storedKey.state, running: () => supervisor.snapshot().state === 'running',
      stop: () => stopHost(), deploy: (value) => deploy(value),
      // A restored team starts as a member of it when this Jenny still holds the membership, else through Recover.
      start: async (who) => {
        storedKey.forget(); // the restore replaced the key: derive the team from it, not from the one read before
        const name = savedTeamName(readSavedHostConfig(userDataPath));
        const teamId = storedKey.teamId();
        return (await held(teamId)) ? deploy({ name, ...who }) : recover(who);
      },
      forgetMembership: async (teamId) => (await loadedService())?.handle('removeTeam', { team_id: teamId }) ?? null,
      state: () => publicHostState(supervisor.snapshot()), push: () => pushState(),
    } });
  // The lifecycle call holding the lock, pushed with the state so every page shows it busy (review item 14).
  let lifecycleOperation = null;

  // The saved setting for the reconnect code, with the mapped address the running host last told (null with
  // none). Main holds no token, so `relay_token` is null. A record the loader would refuse is refused here too.
  function savedInternetSetting() {
    const saved = readSavedHostConfig(userDataPath);
    const record = savedInternet(saved);
    if (!record) return null;
    return { direct_port: savedDirectPort(saved), mapped: supervisor.mapped?.() ?? null, public_address: record.public_address ?? null,
      relay_url: record.relay_url ?? null, relay_token: null };
  }

  // The state the renderer may see: no address, no key, no invite. `deployed` says a host config was
  // saved here before, so a new app session can tell a stopped team from none at all.
  function publicHostState(snapshot, { learn = false } = {}) {
    const { saved, reason: configReason } = readHostConfigState(userDataPath);
    if (learn) learnToken(saved);
    const deployed = savedTeamName(saved) !== null || configReason !== null; // X4b-F02: there and unreadable is deployed
    const internet = internetView(savedInternet(saved), () => tokenStored === true);
    return { state: snapshot.state, team_id: snapshot.team_id || (deployed ? storedKey.teamId() : null),
      team_name: lifecycle.teamName(saved) || snapshot.team_name, deployed, reason: snapshot.reason || configReason, since: snapshot.since,
      reach: snapshot.reach, direct_port: savedDirectPort(saved), internet, desktop_hosting: platformSupported(platform, packaged()),
      internet_draft: deployed ? readInternetDraft(userDataPath) : null, autostart: deployed && readAutostart(userDataPath),
      key: deployed ? storedKey.state() : null, old_teams: lifecycle.oldTeams(), operation: lifecycleOperation,
      owner: deployed && snapshot.state !== 'running' ? lifecycle.ownerHere(snapshot.since) : null,
      pool_context_cap: deployed ? poolContext.view() : null, // row 201 (OD-5): the owner's cap on the pool's context length, null is Auto
      ...(deployed ? { model_relay: modelRelay.view(saved, snapshot), file_tools: fileTools.view(saved, snapshot) } : {}), ...(gate?.held() === true ? { force_local: true } : {}) };
  }

  // Slice 5-6: whether a relay token is stored (the page knows only this, never the token). Learned from the
  // token reads and writes this controller makes anyway, and read on hostStatus while not known yet.
  let tokenStored = null;
  function learnToken(saved) {
    if (tokenStored !== null || !savedInternet(saved)?.relay_url) return;
    try { tokenStored = tokens.load() !== null; } catch { tokenStored = false; }
  }

  const supervisor = createHostSupervisor({ fork, entryPath, env: environment, bounds, log: say });
  // The last pushed state and what it was made from: a push whose only news is the verdict reuses it. Any state
  // written here (a hold, the autostart or relay setting) drops it, so the next quiet push is made from the state now.
  let lastPush = null;
  const pushState = () => { lastPush = null; try { sendState(publicHostState(supervisor.snapshot())); } catch { /* best effort */ } };
  const modelRelay = createHostModelRelay({ userDataPath, supervisor, writeConfig, hostState: () => publicHostState(supervisor.snapshot()), pushState, say });
  writeConfig = carryFileTools(modelRelay.carry(writeConfig), userDataPath); // a launch's fresh config keeps both settings
  const fileTools = createHostFileTools({ userDataPath, supervisor, platform, writeConfig, restart, generation: () => generation, hostState: () => publicHostState(supervisor.snapshot()), say });
  const poolContext = createHostPoolContext({ userDataPath, hostState: () => publicHostState(supervisor.snapshot()), pushState, say,
    running: () => supervisor.snapshot().state === 'running' });
  const forceLocal = createHostForceLocal({ held: () => gate?.held() === true, hostState: () => supervisor.snapshot().state,
    stop: () => stopHost(), push: pushState, say,
    restart: (owner) => {
      const name = disposed ? null : savedTeamName(readSavedHostConfig(userDataPath));
      return name ? exclusive(async () => { await lifecycle.sweep(); return deploy({ name, ...owner }); }) : hostFailure(notDeployedReason(userDataPath));
    },
    interruptStart: () => { generation += 1; dropRosterPush(); void supervisor.stop().catch(() => {}); } });
  // The project files report (`files`) is part of the key: it follows `ready`, so a cached state would hide it.
  const pushKey = (snapshot) => JSON.stringify([snapshot.state, snapshot.reason, snapshot.team_id, snapshot.team_name,
    snapshot.since, snapshot.files]);
  const unsubscribe = supervisor.onState((snapshot) => {
    try {
      const key = pushKey(snapshot);
      const host = lastPush?.key === key ? modelRelay.patch({ ...lastPush.host, reach: snapshot.reach }, snapshot) : publicHostState(snapshot);
      lastPush = { key, host };
      sendState(host);
    } catch { say('WARN', 'team.host.state_push_failed'); }
  });
  const ownerInviteMs = Number.isSafeInteger(bounds.ownerInviteMs) ? bounds.ownerInviteMs : OWNER_INVITE_WAIT_MS;
  const rosterPushMs = Number.isSafeInteger(bounds.rosterPushMs) ? bounds.rosterPushMs : ROSTER_PUSH_MS;
  const portRetries = Number.isSafeInteger(bounds.portRetries) ? bounds.portRetries : PORT_RETRIES;
  const portRetryMs = Number.isSafeInteger(bounds.portRetryMs) ? bounds.portRetryMs : PORT_RETRY_MS;
  let operation = null;
  let generation = 0;
  let disposed = false;
  // The launch whose child may still ask for a roster push, and the one pending push.
  let launches = 0;
  let rosterTimer = null;

  const packaged = () => isPackaged() !== false;
  const sourcePython = () => {
    if (packaged()) return null;
    const value = lockPython();
    return typeof value === 'string' && value ? value : null;
  };
  const cancelled = (startGeneration) => startGeneration !== generation || disposed || gate?.held() === true; // E64: a start in flight

  function dropRosterPush() {
    if (rosterTimer !== null) clearTimeout(rosterTimer);
    rosterTimer = null;
  }

  // The child of launch `ticket` says the roster changed: one push ROSTER_PUSH_MS after the first message of a
  // window, if that run is still the live one.
  function rosterChanged(ticket, startGeneration) {
    const live = () => ticket === launches && !cancelled(startGeneration) && ACTIVE_STATES.has(supervisor.snapshot().state);
    if (!live() || rosterTimer !== null) return;
    rosterTimer = setTimeout(() => {
      rosterTimer = null;
      try {
        if (live()) getTeamService()?.pushState?.();
      } catch { say('WARN', 'team.host.roster_push_failed'); }
    }, rosterPushMs);
    rosterTimer.unref?.();
  }

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

  // The saved direct port while it is free; otherwise a new one (saved with the config by the caller). With
  // `keepPort` (a restart) the saved port is probed a few times and never replaced: null when it stays taken.
  async function chooseDirectPort(savedConfig, keepPort) {
    const saved = savedDirectPort(savedConfig);
    if (saved !== null) {
      const tries = keepPort ? Math.max(1, portRetries) : 1;
      for (let attempt = 1; attempt <= tries; attempt += 1) {
        if (await probeDirectPort(saved)) return saved;
        if (attempt < tries) await new Promise((resolve) => { setTimeout(resolve, portRetryMs); });
      }
      if (keepPort) return null;
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

  // Writes the config and starts the host, unless a Stop came after `startGeneration` was taken. The saved
  // `internet` is carried into the new config as it was; with a relay in it, the owner's token is read first.
  async function launch({ startGeneration, seed, name, flag, owner, keepPort = false }) {
    let layout;
    let directPort;
    const { saved, reason: unreadable } = readHostConfigState(userDataPath);
    if (unreadable) { seed.fill(0); return hostFailure(unreadable); } // X4b-F02: a file that did not read is never rewritten
    const internet = savedInternet(saved);
    let relayToken = null;
    try {
      if (typeof internet?.relay_url === 'string') { relayToken = tokens.load(); tokenStored = relayToken !== null; }
    } catch (error) {
      seed.fill(0);
      return failureOf(error);
    }
    try {
      layout = prepareHostLayout(userDataPath);
      directPort = await chooseDirectPort(saved, keepPort);
      if (directPort !== null) writeConfig(layout, buildHostConfig({ layout, name, directPort, lockPython: sourcePython(), internet }));
    } catch {
      seed.fill(0);
      say('WARN', 'team.host.config_write_failed');
      return hostFailure('team_host_config_write_failed');
    }
    if (directPort === null) {
      seed.fill(0);
      say('WARN', 'team.host.direct_port_busy');
      return hostFailure('team_host_port_busy');
    }
    if (cancelled(startGeneration)) {
      seed.fill(0);
      return hostFailure('team_host_stopped');
    }
    let deliver;
    const invitePromise = new Promise((resolve) => { deliver = resolve; });
    launches += 1;
    dropRosterPush();
    const ticket = launches;
    const started = await supervisor.start({ args: ['--config', layout.configPath, ...(flag ? [flag] : [])],
      hostKey: seed, relayToken, teamName: name, onOwnerInvite: (invite) => deliver({ invite }),
      onOwnerExists: () => deliver({ exists: true }), onMembershipChanged: () => rosterChanged(ticket, startGeneration) });
    if (!started.ok) return started;
    if (cancelled(startGeneration)) return stopCut();
    const answer = (result) => ({ ok: true, host: publicHostState(supervisor.snapshot()), owner: result });
    if (!flag) return answer({ state: 'member', team_id: owner.teamId });
    const waited = await waitForInvite(invitePromise);
    if (cancelled(startGeneration)) return stopCut();
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

  // A start cut once its child was up: the child stops (E64, or a Stop pressed meanwhile).
  async function stopCut() {
    await supervisor.stop();
    return hostFailure('team_host_stopped');
  }

  async function deploy({ name, display_name: displayName, label }) {
    const startGeneration = generation;
    forceLocal.noteOwner({ display_name: displayName, label });
    if (!platformSupported(platform, packaged())) return hostFailure('team_host_platform_unavailable');
    if (ACTIVE_STATES.has(supervisor.snapshot().state)) return invalidRequest('team_host_busy');
    let seed = null;
    try {
      // A deployed profile only reads its key (a missing one is refused); else a fresh key replaces any found (E75).
      seed = hostWasDeployed(userDataPath) ? keys.load() : keys.create();
      if (!seed) throw lostHostKey(userDataPath);
      const teamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
      storedKey.note(teamId);
      const member = await held(teamId);
      return await launch({ startGeneration, seed, name, flag: member ? null : '--team-init',
        owner: { teamId, displayName, label, recover: false } });
    } catch (error) {
      seed?.fill(0);
      return failureOf(error);
    }
  }

  async function recover({ display_name: displayName, label }) {
    const startGeneration = generation;
    forceLocal.noteOwner({ display_name: displayName, label });
    if (!platformSupported(platform, packaged())) return hostFailure('team_host_platform_unavailable');
    let seed = null;
    try {
      seed = keys.load();
      const name = savedTeamName(readSavedHostConfig(userDataPath));
      if (!name) {
        seed?.fill(0);
        return hostFailure(notDeployedReason(userDataPath));
      }
      if (!seed) throw lostHostKey(userDataPath);
      const teamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
      storedKey.note(teamId);
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

  // A lifecycle call under the same lock, named in the pushed state while it runs.
  function lifecycleExclusive(method) {
    return (run) => exclusive(async () => {
      lifecycleOperation = method;
      pushState();
      try { return await run(); } finally { lifecycleOperation = null; pushState(); }
    });
  }

  async function stopHost() {
    generation += 1;
    dropRosterPush();
    const snapshot = await supervisor.stop();
    return { ok: true, host: publicHostState(snapshot) };
  }

  // Stops the running host and starts it again on the saved config and port, with no owner flag.
  async function restart(startGeneration, name) {
    await supervisor.stop();
    if (cancelled(startGeneration)) return hostFailure('team_host_stopped');
    let seed = null;
    try {
      seed = keys.load();
      if (!seed) throw lostHostKey(userDataPath);
      const teamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
      return await launch({ startGeneration, seed, name, flag: null, owner: { teamId }, keepPort: true });
    } catch (error) {
      seed?.fill(0);
      return failureOf(error);
    }
  }

  // Puts the stored token back as it was before a failed save; true when that worked.
  function restoreToken(previous) {
    try {
      if (previous === null) tokens.remove(); else tokens.save(previous);
      return true;
    } catch {
      return false;
    }
  }

  // The owner's internet joining setting. Every field is checked before anything is written. Then the token
  // (saved, removed or kept), then the setting; a setting that cannot be written puts the token back, and a
  // failure says in `changed` which of the two is not as it was. A running host restarts on the new setting.
  // A stored token that cannot be read is "previous unknown": it is still replaced or removed (else the owner
  // could never clear it), and a rollback removes it and counts the token as changed.
  async function setInternet(value) {
    const startGeneration = generation;
    const saved = readSavedHostConfig(userDataPath);
    const name = savedTeamName(saved);
    if (!name) return hostFailure(notDeployedReason(userDataPath));
    const next = internetFromPayload(value, savedDirectPort(saved));
    if (!next.ok) return next;
    const tokenStep = tokenStepOf(value, next.internet, savedInternet(saved));
    let previousToken = null;
    let previousKnown = true;
    if (tokenStep !== 'keep') {
      try {
        previousToken = tokens.load();
      } catch {
        previousKnown = false;
        say('WARN', 'team.host.relay_token_unreadable');
      }
      try {
        if (tokenStep === 'save') tokens.save(value.token);
        else if (previousToken !== null || !previousKnown) tokens.remove();
        tokenStored = tokenStep === 'save';
      } catch (error) {
        return failureOf(error);
      }
    }
    const tokenTouched = tokenStep === 'save' || previousToken !== null || !previousKnown;
    try {
      writeConfig(prepareHostLayout(userDataPath), withInternet(saved, next.internet));
    } catch {
      const restored = !tokenTouched || (restoreToken(previousToken) && previousKnown);
      tokenStored = null;
      say('WARN', 'team.host.internet_save_failed', { token_restored: restored });
      return withChanged(hostFailure('team_host_config_write_failed'), restored ? [] : ['token']);
    }
    const restarting = supervisor.snapshot().state === 'running';
    say('INFO', 'team.host.internet_saved', { enabled: next.internet !== null, relay: Boolean(next.internet?.relay_url),
      restart: restarting });
    if (!restarting) return { ok: true, host: publicHostState(supervisor.snapshot()), restarted: false };
    const restarted = await restart(startGeneration, name);
    if (!restarted.ok) return withChanged(restarted, tokenTouched ? ['token', 'setting'] : ['setting']);
    return { ok: true, host: restarted.host, restarted: true };
  }

  // The owner's reconnect code for the running host: the stored key and the supervisor's addresses.
  function reconnectCode() {
    const { state, addresses } = supervisor.snapshot();
    if (state !== 'running') return hostFailure('team_host_stopped');
    const setting = readInternetSetting(internetSetting);
    let seed = null;
    try {
      seed = keys.load();
      if (!seed) return hostFailure('team_host_not_deployed');
      const built = buildHostReconnectCode({ hostPublicKey: keyPairFromSeed(seed).publicKey, addresses,
        internet: setting });
      return built.ok ? { ok: true, code: built.code } : hostFailure(built.reason);
    } finally {
      seed?.fill(0);
    }
  }

  // `context.sender`: the asking window ({ id, once }), for the backup a window picked.
  async function handle(method, payload, context = {}) {
    if (!HOST_METHODS.includes(method)) return invalidRequest();
    const checked = validatePayload(method, payload);
    if (!checked.ok) return invalidRequest(method === 'hostPoolContext' ? 'team_pool_context_invalid' : undefined);
    if (method === 'hostStatus') return { ok: true, host: publicHostState(supervisor.snapshot(), { learn: true }) };
    if (disposed) return hostFailure('team_host_shutting_down');
    let answer;
    try {
      if (HELD_METHODS.has(method) && gate?.held() === true) answer = forceLocalFailure();
      else if (method === 'hostStop') { forceLocal.forget(); answer = await stopHost(); }
      else if (method === 'hostDeploy') answer = await exclusive(async () => { await lifecycle.sweep(); return deploy(checked.value); });
      else if (method === 'hostRecover') answer = await exclusive(() => recover(checked.value));
      else if (method === 'hostReconnectCode') answer = reconnectCode();
      else if (method === 'hostModelRelay') answer = await exclusive(() => modelRelay.set(checked.value));
      else if (method === 'hostFileTools') answer = await exclusive(() => fileTools.set(checked.value));
      else if (method === 'hostPoolContext') answer = await exclusive(() => poolContext.set(checked.value)); // row 201 (OD-5): applies at the next start
      else if (method === 'hostInternet') {
        answer = await exclusive(() => setInternet(checked.value));
        if (answer.ok && (checked.value.public_address || checked.value.relay_url)) removeInternetDraft(userDataPath);
      }
      else if (LIFECYCLE_METHODS.has(method)) {
        answer = await lifecycle.handle(method, checked.value, { exclusive: lifecycleExclusive(method), sender: context.sender ?? null });
        storedKey.forget(); // the key and the token may be gone, new or restored: read again
        tokenStored = null;
      }
      else answer = invalidRequest(); // closed by default (defence): no host method falls through to Recover
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
    dropRosterPush();
    await supervisor.stop();
    unsubscribe();
  }

  // What a delete, restore or export left when it stopped part way goes at start (host-sweep.js).
  lifecycle.sweep();
  return {
    handle, stop, snapshot: () => publicHostState(supervisor.snapshot()), resources: () => supervisor.resources(), pushState,
    holdForceLocal: forceLocal.hold, releaseForceLocal: forceLocal.release, interruptForceLocal: forceLocal.interrupt,
  };
}

module.exports = { createHostController };
