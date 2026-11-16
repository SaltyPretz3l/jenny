'use strict';

// The desktop team client (row 123, slice 1f-1): at most four teams, one
// connection manager each, the join flow, and the `team.*` IPC methods mapped
// onto one host operation each. Payloads are validated before anything is sent.
// Every state change is pushed as a full snapshot of all teams; a snapshot holds
// ids, names, states and reasons, never a key, a secret or an address. Logs
// carry method names, team ids, states and reasons only. A join first loads the
// saved teams, so it always sees every membership this Jenny has. `stopAll`
// stops a join in progress (which then cleans up what it created) and every
// manager, and waits for both.
//
// Slice 1f-2 adds three main-process calls for the team host this Jenny runs,
// never reachable from the renderer: `holds` (does this Jenny hold a membership
// of that team), `ownerJoin` (the first-owner invite, with the loopback
// fallback addresses) and `ownerRecover` (a recovery invite: the team's manager
// is stopped first and restarted from its unchanged file when recovery fails).
//
// Slice 2a-4b composes the team chat clients (team-chat.js): the `chat*`
// methods go to them unchecked here (team-chat.js checks each payload once),
// their pushes to `sendChat`; leave and Remove team drop a team's chat client,
// a revoked state empties its drafts and outbox, and a recovery fails the
// outbox entries the old device already sent.
//
// Slice 5-3: `teamReconnectCode` applies a pasted reconnect code to one team
// (reconnect-apply.js), serialized with joins and recoveries; a method with no
// host operation answers `invalid_request` and never reaches a manager's command.
//
// Member-side saved-team fixes (owner decision E47: shown, never hidden): a
// saved team whose file exists and does not load is a `needs_repair` row (team
// id and reason only) with no manager and no chat; so is a held team that was
// stopped and could not start again. A row counts toward the limit, each
// `status` reads its file again (not while a recovery or removal of it runs, and
// not after a recovery whose write failed) and starts a manager once it loads,
// and `removeTeam` removes it. A directory without its file is cleaned at start
// only. The saved file never replaces one it could not read, and a new device
// id goes in one write with the outbox's unconfirmed marks (client-file.js),
// after an accepted recovery or when the host names another device. While a
// removal or a leave of a team is awaiting, a recover, a reconnect code and a
// join for it are refused.
//
// E49: host answers and snapshot facts leave rebuilt and checked (admin-answers.js).
//
// Two-PC findings: a row not yet `active` carries `device_fingerprint` (device-fingerprint.js); `pushState` re-sends the snapshot.
// A join for a team held in the terminal revoked state replaces it (removed like Remove team) and runs as a first join.
// Slice 4b member wiring: every manager change goes to `teamEngine` (team-engine.js), which runs that team's engine port.
// Slice 4e: every manager change also goes to `teamSharing` (node/team-sharing.js, this PC's GPU) and the pool view
// (node/pool-view.js, the team's GPUs); both ride the state push (`sharing`, `pools`) and leave with their team.
// Slice 5-6: a team its owner deleted (the host's `team_deleted` event) is a kept `deleted` row with no manager, and a
// marked team is probed once at each start (team-deleted.js); Remove this team removes it like a needs_repair row.
// E64 (force-local-hold.js): while held addManager, the one choke point, builds nothing and notes the team as a
// `force_local` row the release starts from its file (team-service-hold.js); a join or recovery reads the gate before
// each dial, and one the host accepted first is kept and answers ok, held.
// Slice 3-9: shared projects (team-projects.js) take every manager change like the pool view; their pushes go to `sendProject`.
// Slice 6-5: model sharing (team-models.js, required on the first model call) likewise; its pushes go to `sendModel`. Row 151 T3: team boards (team-board-clients.js, first board call) the same, to `sendBoard`.
// Review round two (R10-F02): Remove team takes the order dropRevoked has, and a file whose key is gone is a needs_repair row.

const { adminAnswer, checkedTeam } = require('./admin-answers');
const { createDeviceFingerprints } = require('./device-fingerprint');
const { createDeviceKeyStore } = require('./device-key-store');
const {
  clientFileProblem, listTeamIds, loadClientFile, removeMembership, saveClientFile, saveDeviceRecord,
} = require('./client-file');
const { createConnectionManager } = require('./connection-manager');
const { createDeletedTeams } = require('./team-deleted');
const {
  HOST_OPERATIONS, POOL_OPERATIONS, PROJECT_OPERATIONS, SHARE_METHODS, hostParams, isBoardMethod, isChatMethod, isModelMethod, validatePayload,
} = require('./ipc-methods');
const { createPoolView } = require('./node/pool-view');
const { MAX_TEAMS, createTeamChats } = require('./team-chat');
const { createJoin } = require('./join-flow');
const { applyTeamReconnectCode } = require('./reconnect-apply');
const { JOIN_RATE_LIMIT_MS, STICKY_REPAIRS, checkedOwnerPayload, cleanHalfSaved, heldRevoked, lazyBoards, lazyModels, parseTeamId,
  resourceTotals, shareCall } = require('./team-service-helpers');
const { createTeamProjects } = require('./team-projects');
const { isId } = require('../../server/team/ids');
const { isCleanText } = require('../../server/team/member-schema');
const { failureAnswer, failureOf, invalidRequest, teamFailure } = require('./team-errors');
const { createHeldTeams, forceLocalFailure } = require('./force-local-hold');
const { createServiceHold } = require('./team-service-hold');


function createTeamService({
  userDataPath, getSecureStore, sendState = () => {}, spawnChild, appVersion, protocolVersion, log = () => {},
  timers, backoff, pendingPollMs, requestTimeoutMs, now = Date.now, createBridge, sendChat = () => {}, chatTimers,
  createManager = createConnectionManager, // a test seam for a manager's stop
  teamEngine = null, teamSharing = null, gate = null, sendProject = () => {}, projectOptions = {}, chatAttachmentOptions = {},
  sendModel = () => {}, modelOptions = {}, sendBoard = () => {}, boardOptions = {}, refusedCooldownMs, // the host bridge's refused-key cooldown (bridge-link.js)
}) {
  const deviceKeys = createDeviceKeyStore({ getSecureStore });
  const fingerprints = createDeviceFingerprints({ deviceKeys });
  const managers = new Map();
  const joinLimits = new Map();
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const flow = createJoin({ deviceKeys, userDataPath, spawnChild, appVersion, protocolVersion, requestTimeoutMs,
    createBridge, now, log: say, refusedCooldownMs });
  let stopped = false;
  let started = false;
  let joining = null;
  // The team whose manager a recovery or a reconnect code is replacing (one at a time, under `exclusive`):
  // removeTeam and leave for it are refused until that run returns.
  let replacing = null;
  // Saved teams whose file exists and does not load: team id -> reason (a needs_repair row).
  const repairs = new Map();
  // Teams whose removeTeam or leave is awaiting: a recover, a reconnect code and a join for them are refused.
  const removing = new Set();
  const deleted = createDeletedTeams({ userDataPath, log: say, now });
  const heldTeams = createHeldTeams();
  const isHeld = () => gate?.held() === true;
  const halt = () => (isHeld() ? forceLocalFailure() : null);
  const heldAnswer = (teamId) => ({ ok: true, team: heldTeams.rows(true).find((row) => row.team_id === teamId) });
  const heldCount = () => managers.size + repairs.size + deleted.size() + heldTeams.size();
  const chats = createTeamChats({ userDataPath, log: say, now, ...(chatTimers ? { timers: chatTimers } : {}),
    sendChat: (payload) => { if (!stopped) sendChat(payload); }, attachmentOptions: chatAttachmentOptions });
  // The manager copies its record; only adoptDevice hands over the live one, which a label repair updates.
  const ownRecords = new WeakMap();
  const labelTried = new WeakSet();
  const pools = createPoolView({ log: say, onChange: () => push() });
  const projects = createTeamProjects({ log: say, isHeld, push: (payload) => { if (!stopped) sendProject(payload); }, ...projectOptions });
  const models = lazyModels({ userDataPath, managerOf: (teamId) => managers.get(teamId) || null, isHeld, log: say, ...modelOptions,
    push: (payload) => { if (!stopped) sendModel(payload); } });
  const boards = lazyBoards({ managerOf: (teamId) => managers.get(teamId) || null, isHeld, log: say, ...boardOptions, push: (payload) => { if (!stopped) sendBoard(payload); } });
  teamSharing?.attach({ onChange: () => push() });

  function snapshot() {
    const rows = [...repairs].map(([teamId, reason]) => ({ team_id: teamId, state: 'needs_repair', reason }));
    const live = [...managers.values()].filter((manager) => !deleted.has(manager.teamId));
    const forceLocal = isHeld();
    const held = heldTeams.rows(forceLocal).filter((row) => !deleted.has(row.team_id)); // the deleted row wins
    return { teams: [...live.map(teamOf), ...rows, ...deleted.rows(), ...held], sharing: teamSharing ? teamSharing.snapshot() : null,
      pools: pools.snapshot(), ...(forceLocal ? { force_local: true } : {}) };
  }

  // The name a manager's host gave, checked; null when it cannot be read.
  const nameOf = (manager) => { try { const name = manager.snapshot().team_name; return isCleanText(name) ? name : null; } catch { return null; } };

  // A manager's snapshot as it leaves the service: the facts it took from the host checked.
  function teamOf(manager) {
    const row = manager.snapshot();
    // Only a member the owner has not let in is shown the key: an active team costs no secure-store read.
    return checkedTeam({ ...row, device_fingerprint: row.member_state === 'active' ? null : fingerprints.of(row.team_id) });
  }

  function push() {
    if (stopped) return;
    try { sendState(snapshot()); } catch { say('WARN', 'team.state_push_failed'); }
  }

  // `name`: the team's name when the caller knows it (a held team is listed by it).
  function addManager(record, name = null) {
    // A join and the deferred start can interleave: never run two managers for one team.
    if (managers.has(record.team_id)) return managers.get(record.team_id);
    repairs.delete(record.team_id);
    if (isHeld()) { heldTeams.note(record.team_id, name); return null; }
    fingerprints.forget(record.team_id);
    const manager = createManager({
      record, deviceKeys, saveRecord: (next) => saveClientFile(userDataPath, next), log: say,
      adoptDevice: (own, deviceId) => { ownRecords.set(manager, own); return adoptDevice(own, deviceId); },
      onChange: () => {
        if (probeEnded(record.team_id, manager) || keyGone(record.team_id, manager)) return;
        push(); chats.connectionChanged(record.team_id); teamEngine?.connectionChanged(record.team_id, manager);
        pools.connectionChanged(record.team_id, manager); teamSharing?.connectionChanged(record.team_id, manager);
        projects.connectionChanged(record.team_id, manager); models.connectionChanged(record.team_id, manager); boards.connectionChanged(record.team_id, manager);
      },
      spawnChild, appVersion, protocolVersion, requestTimeoutMs, now, createBridge, timers, backoff, pendingPollMs, refusedCooldownMs,
    });
    managers.set(record.team_id, manager);
    manager.onEvent((event) => onNotice(record.team_id, manager, event));
    chats.attach(record.team_id, manager, { revoked: record.state_seen === 'revoked' });
    manager.start();
    return manager;
  }

  // The owner deleted the team: the row stays, deleted, and its manager stops (team-deleted.js).
  function onNotice(teamId, manager, event) {
    if (event?.event_type !== 'team_deleted' || managers.get(teamId) !== manager) return;
    const facts = deleted.noted(teamId, event, manager.snapshot().team_name);
    if (!facts) return;
    deleted.show(teamId, facts);
    void stopHeld(teamId, manager).then(push, push);
  }

  // A marked team's start-up probe whose first try failed shows its deleted row again; true when it ended.
  function probeEnded(teamId, manager) {
    if (deleted.probeChanged(teamId, manager.snapshot().state) !== 'deleted') return false;
    void stopHeld(teamId, manager).then(push, push);
    return true;
  }

  // A manager that found no key for its file (a removal from before review round two took the key first): it stops
  // and the team is a needs_repair row, which offers Remove (R10-F02). True when it ended.
  function keyGone(teamId, manager) {
    const row = manager.snapshot();
    if (row.state !== 'offline' || row.reason !== 'team_device_key_missing' || managers.get(teamId) !== manager) return false;
    void stopHeld(teamId, manager).then(() => { if (!stopped && !managers.has(teamId)) repairs.set(teamId, row.reason); push(); }, push);
    return true;
  }

  // The host names this device by another id than the saved one (a recovery whose write never happened):
  // the chat client lets go, then the new id and the outbox marks are one write, before the manager goes on.
  // `record` is the manager's own; false keeps it from going on (it retries later), as does a status that
  // names no device.
  function adoptDevice(record, deviceId) {
    if (deviceId === record.device_id) return true;
    if (!isId('device', deviceId)) { say('WARN', 'team.device.unnamed', { team_id: record.team_id }); return false; }
    const saved = chats.rewrite(record.team_id, () => saveDeviceRecord(userDataPath, { ...record, device_id: deviceId }));
    say(saved.ok ? 'INFO' : 'WARN', 'team.device.adopted', { team_id: record.team_id, ok: saved.ok,
      ...(saved.ok ? { count: saved.count } : { reason: saved.reason }) });
    if (saved.ok) record.device_id = deviceId;
    return saved.ok;
  }

  // A record saved without a label takes this device's own one from a device list answer: one attempt per manager.
  function repairLabel(manager, answer) {
    const own = ownRecords.get(manager);
    if (stopped || answer.ok !== true || !own || own.label !== undefined || labelTried.has(manager)
      || managers.get(own.team_id) !== manager || removing.has(own.team_id) || replacing === own.team_id) return;
    const row = answer.devices.find((device) => device.member_id === own.member_id && manager.isOwnDevice(device.device_id));
    // adminAnswer already checked the label; this is the second line of defence.
    if (!row || !isCleanText(row.label)) return;
    labelTried.add(manager);
    const saved = saveClientFile(userDataPath, { ...own, label: row.label });
    say(saved.ok ? 'INFO' : 'WARN', 'team.label.repaired', { team_id: own.team_id, ok: saved.ok,
      ...(saved.ok ? {} : { reason: saved.reason }) });
    if (!saved.ok) return;
    own.label = row.label;
    push();
  }

  // Loads every saved team once; a file that does not load is a needs_repair row, left as it is.
  async function startExisting() {
    if (stopped || started) return;
    started = true;
    for (const teamId of listTeamIds(userDataPath)) {
      if (managers.has(teamId) || repairs.has(teamId)) continue;
      const loaded = loadClientFile(userDataPath, teamId);
      if (!loaded.ok && loaded.reason === 'team_client_missing') { cleanHalfSaved({ userDataPath, deviceKeys, teamId, log: say }); continue; }
      if (heldCount() >= MAX_TEAMS) { say('WARN', 'team.client_file.skipped', { team_id: teamId, reason: 'team_limit_reached' }); continue; }
      if (loaded.ok) { deleted.startProbe(teamId); addManager(loaded.record); continue; }
      repairs.set(teamId, loaded.reason);
      say('WARN', 'team.client_file.needs_repair', { team_id: teamId, reason: loaded.reason });
    }
    push();
  }

  // Each status reads every needs_repair file again: one that loads now starts its manager, any other read
  // only changes the row's reason. A recovery or a removal of the team decides for itself, and a row left by a
  // recovery whose write failed waits for the next Reclaim (its file names a device the host revoked).
  function healRepairs() {
    let changed = false;
    for (const [teamId, reason] of [...repairs]) {
      if (replacing === teamId || removing.has(teamId) || STICKY_REPAIRS.has(reason)) continue;
      const loaded = loadClientFile(userDataPath, teamId);
      if (!loaded.ok && loaded.reason === reason) continue;
      changed = true;
      if (loaded.ok) addManager(loaded.record);
      else repairs.set(teamId, loaded.reason);
    }
    if (changed) push();
  }

  // A held team that was stopped and has no manager now: it starts again from its file, or stays listed as a
  // needs_repair row with the load's reason (or with `reason` when one is given). `name` as for addManager.
  function restoreHeld(teamId, reason = null, name = null) {
    if (managers.has(teamId)) return;
    const loaded = reason ? null : loadClientFile(userDataPath, teamId);
    if (loaded && loaded.ok) addManager(loaded.record, name);
    else repairs.set(teamId, reason || loaded.reason);
  }

  // Drops a team this Jenny no longer belongs to, but only while `manager` is still the one held for it:
  // answers removeMembership's result, or null when it is not.
  function forget(teamId, manager, { key = true } = {}) {
    if (managers.get(teamId) !== manager) return null;
    chats.drop(teamId);
    void teamEngine?.drop(teamId);
    pools.drop(teamId); projects.drop(teamId); models.drop(teamId); boards.drop(teamId);
    teamSharing?.drop(teamId);
    const removed = removeMembership({ userDataPath, deviceKeys, teamId, key, log: say });
    managers.delete(teamId);
    push();
    return removed;
  }

  // Removes a membership (a revoked one a join replaces, or any one Remove team removes), in an order where nothing irreversible
  // happens before the step that can fail: the manager stops, then the team directory goes (with the chat
  // client and cache), then the key and relay token. A stop that rejects or that the app's stop overtakes
  // changes nothing on disk, so the row stays revoked (now or at the next start). A directory that cannot be
  // removed keeps the key: the team comes back from its file (revoked again) or as a needs_repair row, both
  // with Remove. A key store that refuses last leaves only a key with no directory, which the next join
  // removes. Answers null once the team is gone. `event`: the log line that says how it went.
  async function dropRevoked(teamId, event = 'team.join.revoked_replaced') {
    const manager = managers.get(teamId);
    if (!deviceKeys.available()) return teamFailure('DEVICE_KEY_UNAVAILABLE', 'team_device_key_unavailable');
    try {
      await manager.stop();
    } catch (error) {
      return failureOf(error);
    }
    if (stopped || managers.get(teamId) !== manager) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    const removed = forget(teamId, manager, { key: false });
    say('INFO', event, { team_id: teamId, ok: removed.file });
    if (!removed.file) {
      restoreHeld(teamId);
      push();
      return teamFailure('CONNECTION_FAILED', 'team_client_write_failed');
    }
    try {
      deviceKeys.remove(teamId);
    } catch (error) {
      return failureOf(error);
    }
    return null;
  }

  // A team held revoked: the limits are checked, then the old membership goes before the first join runs,
  // with the team marked as being replaced throughout. A redeem that then fails leaves no row (accepted:
  // a revoked row had nothing left but its Remove button).
  async function runJoin(payload, extraAddresses = []) {
    await startExisting();
    const teamId = parseTeamId(payload.invite);
    if (!teamId || !heldRevoked(managers, teamId)) return firstJoin(payload, extraAddresses);
    if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    if (removing.has(teamId)) return invalidRequest('team_join_in_progress');
    const limit = joinLimits.get(teamId);
    if (limit && now() < limit.until) return limit.answer;
    return replacingTeam(teamId, async () => (await dropRevoked(teamId)) || firstJoin(payload, extraAddresses));
  }

  async function firstJoin({ invite, display_name: displayName, label }, extraAddresses) {
    let teamId = null;
    const result = await flow.join({ invite, displayName, label, extraAddresses }, {
      admit(id) {
        teamId = id;
        if (removing.has(id)) return invalidRequest('team_join_in_progress');
        if (managers.has(id) || repairs.has(id)) return invalidRequest('team_already_joined');
        if (heldCount() >= MAX_TEAMS) return invalidRequest('team_limit_reached');
        const limit = joinLimits.get(id);
        if (limit && now() < limit.until) return limit.answer;
        return null;
      },
      writeRecord: (record) => saveClientFile(userDataPath, record),
      halt,
    });
    if (!result.ok) {
      const failed = failureAnswer(result);
      if (teamId && failed.error.reason === 'team_rate_limit') {
        joinLimits.set(teamId, { until: now() + JOIN_RATE_LIMIT_MS, answer: failed });
      }
      return failed;
    }
    if (stopped) {
      // Stopped between the write and here: the join made this key and file, so it removes them.
      removeMembership({ userDataPath, deviceKeys, teamId: result.record.team_id, log: say });
      return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    }
    const manager = addManager(result.record, isCleanText(result.team_name) ? result.team_name : null);
    push();
    return manager ? { ok: true, team: teamOf(manager) } : heldAnswer(result.record.team_id);
  }

  // One join or recovery at a time.
  async function exclusive(run) {
    if (joining) return invalidRequest('team_join_in_progress');
    joining = run().catch((error) => failureOf(error));
    try {
      return await joining;
    } finally {
      joining = null;
    }
  }

  function join(payload) {
    return exclusive(() => runJoin(payload));
  }

  // Stops the manager held for a team and releases it and its chat client. `pause` (E64) drops sharing (no write) before
  // the link dies and stops the engine port without reporting the team gone, so the chosen team model stays chosen.
  async function stopHeld(teamId, manager, { pause = false } = {}) {
    const sharingFirst = pause && managers.get(teamId) === manager;
    if (sharingFirst) teamSharing?.drop(teamId);
    await manager.stop();
    if (managers.get(teamId) === manager) {
      managers.delete(teamId);
      pools.drop(teamId); projects.drop(teamId); models.drop(teamId); boards.drop(teamId);
      if (!sharingFirst) teamSharing?.drop(teamId);
      await teamEngine?.drop(teamId, { quiet: pause });
    }
    chats.detach(teamId);
  }

  const forceLocal = createServiceHold({ managers, heldTeams, nameOf, stopHeld, restoreHeld, cancelDial: () => flow.cancel(),
    push, isStopped: () => stopped, say });

  // Runs `run` with `teamId` marked as being replaced.
  async function replacingTeam(teamId, run) {
    replacing = teamId;
    try { return await run(); } finally { replacing = null; }
  }

  // Runs a removal or a leave of `teamId` (one at a time per team) with it marked as being removed.
  async function removingTeam(teamId, run) {
    if (removing.has(teamId)) return invalidRequest('team_join_in_progress');
    removing.add(teamId);
    try { return await run(); } finally { removing.delete(teamId); }
  }

  async function runRecover({ invite, display_name: displayName, label }, extraAddresses) {
    await startExisting();
    const teamId = parseTeamId(invite);
    if (!teamId) return teamFailure('INVITE_MALFORMED', 'team_invite_malformed');
    if (removing.has(teamId)) return invalidRequest('team_join_in_progress');
    return replacingTeam(teamId, () => recoverTeam(teamId, { invite, displayName, label, extraAddresses }));
  }

  async function recoverTeam(teamId, { invite, displayName, label, extraAddresses }) {
    const held = managers.get(teamId) || null;
    const name = held ? nameOf(held) : null;
    if (held) await stopHeld(teamId, held);
    if (!held && !repairs.has(teamId) && heldCount() >= MAX_TEAMS) return invalidRequest('team_limit_reached');
    // The new device id and the outbox marks are one write, made whatever `stopped` says (the chat client
    // let go in stopHeld); a file that could not take that write refuses the recovery before the redeem.
    const result = await flow.recover({ invite, displayName, label, extraAddresses }, {
      checkFile: (id) => clientFileProblem(userDataPath, id),
      writeRecord: (record) => saveDeviceRecord(userDataPath, record),
      halt,
    });
    if (stopped) return result.ok ? teamFailure('HOST_STOPPED', 'team_connection_stopped') : failureAnswer(result);
    if (!result.ok) {
      // A refused redeem changed nothing local: the team comes back from its unchanged file (a
      // needs_repair row when it no longer loads). After an accepted redeem that this device failed to
      // save, the old device is revoked on the host: the team is a row with that reason until Reclaim
      // runs again or it is removed.
      const failed = failureAnswer(result);
      const saveFailed = failed.error.reason === 'team_recover_local_save_failed';
      if (held || repairs.has(teamId)) restoreHeld(teamId, saveFailed ? failed.error.reason : null, name);
      push();
      return failed;
    }
    const manager = addManager(result.record, isCleanText(result.team_name) ? result.team_name : name);
    push();
    return manager ? { ok: true, team: teamOf(manager) } : heldAnswer(teamId);
  }

  // A pasted reconnect code: the team's manager is stopped, the file rewritten and a manager started from it.
  async function runReconnect({ team_id: teamId, code }) {
    if (removing.has(teamId)) return invalidRequest('team_join_in_progress');
    const held = managers.get(teamId);
    if (!held) return invalidRequest('team_not_found');
    const name = nameOf(held);
    const answer = await replacingTeam(teamId, () => applyTeamReconnectCode({ userDataPath, teamId, code,
      stop: () => stopHeld(teamId, held),
      start: (record) => {
        if (!stopped) { if (record) addManager(record, name); else restoreHeld(teamId); }
        push();
      } }));
    if (stopped) return answer.ok ? teamFailure('HOST_STOPPED', 'team_connection_stopped') : answer;
    if (answer.ok && !managers.has(teamId)) return heldTeams.has(teamId) ? heldAnswer(teamId) : forceLocalFailure();
    return answer.ok ? { ok: true, team: teamOf(managers.get(teamId)) } : answer;
  }

  async function ownerJoin(payload) {
    const checked = checkedOwnerPayload(payload);
    if (!checked) return invalidRequest();
    if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    if (isHeld()) return forceLocalFailure();
    return exclusive(() => runJoin(checked.value, checked.extraAddresses));
  }

  async function ownerRecover(payload) {
    const checked = checkedOwnerPayload(payload);
    if (!checked) return invalidRequest();
    if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    if (isHeld()) return forceLocalFailure();
    return exclusive(() => runRecover(checked.value, checked.extraAddresses));
  }

  /** True when this Jenny holds a key, a directory or a manager for the team; throws when the secure store is unavailable. */
  function holds(teamId) {
    return managers.has(teamId) || deleted.has(teamId) || flow.alreadyHeld(teamId);
  }

  // A needs_repair row: its file is read once more. One that loads now starts its manager and the removal is
  // refused (the caller refreshes and sees the team); otherwise its key and directory are removed. A row with a
  // sticky reason (STICKY_REPAIRS) is removed as it is.
  function removeRepair(teamId) {
    const loaded = STICKY_REPAIRS.has(repairs.get(teamId)) || deleted.has(teamId) || heldTeams.has(teamId) ? null
      : loadClientFile(userDataPath, teamId);
    if (loaded && loaded.ok) {
      addManager(loaded.record);
      push();
      return invalidRequest('team_join_in_progress');
    }
    try {
      deviceKeys.remove(teamId);
    } catch (error) {
      return failureOf(error);
    }
    if (!removeMembership({ userDataPath, deviceKeys, teamId, key: false, log: say }).file) {
      return teamFailure('CONNECTION_FAILED', 'team_client_write_failed');
    }
    repairs.delete(teamId);
    deleted.forget(teamId);
    heldTeams.forget(teamId);
    push();
    return { ok: true };
  }

  // A deleted row is dialled again (team-deleted.js): a delete that failed after its notice clears itself.
  function recheckDeleted() {
    const due = deleted.due(now());
    if (due.length === 0 || isHeld()) return; // E64: no probe while held, and the row's recheck time is not spent
    for (const teamId of due) {
      const loaded = managers.has(teamId) ? null : loadClientFile(userDataPath, teamId);
      if (loaded?.ok && deleted.recheck(teamId, now())) addManager(loaded.record);
    }
  }

  async function removeTeam(teamId) {
    if (replacing === teamId) return invalidRequest('team_join_in_progress');
    if (deleted.has(teamId) && managers.has(teamId)) await stopHeld(teamId, managers.get(teamId));
    if (repairs.has(teamId) || deleted.has(teamId) || heldTeams.has(teamId)) return removeRepair(teamId);
    const manager = managers.get(teamId);
    if (!manager) return invalidRequest('team_not_found');
    return removingTeam(teamId, async () => (await dropRevoked(teamId, 'team.remove.finished')) || { ok: true });
  }

  async function run(method, value) {
    // E64: a call that dials or sends to a team is refused while held; status, removal and shareStatus still answer.
    if ((['join', 'teamReconnectCode'].includes(method) || Object.hasOwn(POOL_OPERATIONS, method) || Object.hasOwn(PROJECT_OPERATIONS, method)
      || Object.hasOwn(HOST_OPERATIONS, method) || (method === 'shareSet' && value.on === true)) && isHeld()) return forceLocalFailure();
    if (method === 'join') return join(value);
    if (method === 'status') { healRepairs(); recheckDeleted(); return { ok: true, ...snapshot() }; }
    if (method === 'removeTeam') return removeTeam(value.team_id);
    if (method === 'teamReconnectCode') return exclusive(() => runReconnect(value));
    if (SHARE_METHODS.includes(method)) return shareCall(teamSharing, method, value);
    if (Object.hasOwn(POOL_OPERATIONS, method)) return managers.has(value.team_id) ? pools.call(method, value) : invalidRequest('team_not_found');
    if (Object.hasOwn(PROJECT_OPERATIONS, method)) return managers.has(value.team_id) ? projects.call(method, value) : invalidRequest('team_not_found');
    if (isModelMethod(method)) return models.call(method, value); // team-models.js answers off, held and unknown teams itself
    if (isBoardMethod(method)) return boards.call(method, value); // team-board-clients.js answers held and unknown teams itself
    // Closed by default (defence): a method with no host operation never reaches a manager.
    if (!Object.hasOwn(HOST_OPERATIONS, method)) return invalidRequest();
    if (method === 'leave' && replacing === value.team_id) return invalidRequest('team_join_in_progress');
    const manager = managers.get(value.team_id);
    if (!manager) return invalidRequest('team_not_found');
    if (method === 'leave') {
      return removingTeam(value.team_id, async () => {
        const answer = await manager.leave();
        if (answer.ok !== true) return adminAnswer(HOST_OPERATIONS.leave, answer);
        forget(value.team_id, manager);
        return { ok: true };
      });
    }
    if (method === 'deviceRevoke' && manager.isOwnDevice(value.device_id)) {
      return adminAnswer(HOST_OPERATIONS.deviceRevoke, await manager.revokeOwnDevice(hostParams(value)));
    }
    const answer = adminAnswer(HOST_OPERATIONS[method], await manager.command(HOST_OPERATIONS[method], hostParams(value)));
    if (method === 'deviceList') repairLabel(manager, answer);
    return answer;
  }

  async function handle(method, payload) {
    const chat = isChatMethod(method);
    const checked = chat ? null : validatePayload(method, payload);
    if (checked && !checked.ok) return invalidRequest();
    if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    let answer;
    try {
      answer = chat ? await chats.handle(method, payload) : await run(method, checked.value);
    } catch (error) {
      answer = failureOf(error);
    }
    say('INFO', 'team.ipc.answered', { method, ok: answer.ok === true,
      ...(answer.ok === true ? {} : { reason: answer.error?.reason || 'none' }) });
    return answer;
  }

  async function stopAll() {
    stopped = true;
    flow.abort();
    // Sharing first, while the connections can still carry its unregister (at most 3 s: team-sharing.js stopAll).
    await teamSharing?.stopAll();
    pools.stopAll();
    const all = [...managers.values()];
    managers.clear();
    await Promise.all([joining, chats.stopAll(), teamEngine?.stopAll(), projects.stopAll(), models.stopAll(), boards.stopAll(), ...all.map((manager) => manager.stop())]);
  }

  return {
    handle, startExisting, stopAll, snapshot, resources: () => resourceTotals(managers), holds, ownerJoin, ownerRecover, pushState: push,
    holdForceLocal: forceLocal.hold, releaseForceLocal: forceLocal.release, interruptForceLocal: () => flow.cancel(),
    // Chat clients and cached messages (team-chat.js); kept apart from `resources()`, whose shape is pinned.
    chatResources: () => chats.resources(),
    engineResources: () => teamEngine?.resources() || null, projectResources: () => projects.resources(), // team-engine.js, team-projects.js
    flushChat: () => chats.flush(), modelResources: () => models.resources(), boardResources: () => boards.resources(), // null before the first model or board call
  };
}

module.exports = { createTeamService };
