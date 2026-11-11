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

const { createDeviceKeyStore } = require('./device-key-store');
const { listTeamIds, loadClientFile, removeMembership, saveClientFile, teamDirExists } = require('./client-file');
const { createConnectionManager } = require('./connection-manager');
const { HOST_OPERATIONS, hostParams, validatePayload } = require('./ipc-methods');
const { createJoin } = require('./join-flow');
const { parseInvite } = require('../../server/team/invites');
const { failureOf, invalidRequest, isFailureAnswer, teamFailure } = require('./team-errors');

const MAX_TEAMS = 4;

// The team id an invite names, or null; the invite itself is never kept.
function parseTeamId(invite) {
  const parsed = parseInvite(invite);
  return parsed.ok ? parsed.team_id : null;
}
const JOIN_RATE_LIMIT_MS = 60_000;

function createTeamService({
  userDataPath, getSecureStore, sendState = () => {}, spawnChild, appVersion, protocolVersion, log = () => {},
  timers, backoff, pendingPollMs, requestTimeoutMs, now = Date.now, createBridge,
}) {
  const deviceKeys = createDeviceKeyStore({ getSecureStore });
  const managers = new Map();
  const joinLimits = new Map();
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const flow = createJoin({ deviceKeys, userDataPath, spawnChild, appVersion, protocolVersion, requestTimeoutMs,
    createBridge, now, log: say });
  let stopped = false;
  let started = false;
  let joining = null;

  function snapshot() {
    return { teams: [...managers.values()].map((manager) => manager.snapshot()) };
  }

  function push() {
    if (stopped) return;
    try { sendState(snapshot()); } catch { say('WARN', 'team.state_push_failed'); }
  }

  function addManager(record) {
    // A join and the deferred start can interleave: never run two managers for one team.
    if (managers.has(record.team_id)) return managers.get(record.team_id);
    const manager = createConnectionManager({
      record, deviceKeys, saveRecord: (next) => saveClientFile(userDataPath, next), onChange: push, log: say,
      spawnChild, appVersion, protocolVersion, requestTimeoutMs, now, createBridge, timers, backoff, pendingPollMs,
    });
    managers.set(record.team_id, manager);
    manager.start();
    return manager;
  }

  // Loads every saved team once; a file that does not load is skipped and left as it is.
  async function startExisting() {
    if (stopped || started) return;
    started = true;
    for (const teamId of listTeamIds(userDataPath)) {
      if (managers.size >= MAX_TEAMS) break;
      if (managers.has(teamId)) continue;
      const loaded = loadClientFile(userDataPath, teamId);
      if (!loaded.ok) { say('WARN', 'team.client_file.skipped', { team_id: teamId, reason: loaded.reason }); continue; }
      addManager(loaded.record);
    }
    push();
  }

  // Drops a team this Jenny no longer belongs to, but only while `manager` is still the one held for it.
  function forget(teamId, manager, { key = true } = {}) {
    if (managers.get(teamId) !== manager) return;
    removeMembership({ userDataPath, deviceKeys, teamId, key, log: say });
    managers.delete(teamId);
    push();
  }

  async function runJoin({ invite, display_name: displayName, label }, extraAddresses = []) {
    await startExisting();
    let teamId = null;
    const result = await flow.join({ invite, displayName, label, extraAddresses }, {
      admit(id) {
        teamId = id;
        if (managers.has(id)) return invalidRequest('team_already_joined');
        if (managers.size >= MAX_TEAMS) return invalidRequest('team_limit_reached');
        const limit = joinLimits.get(id);
        if (limit && now() < limit.until) return limit.answer;
        return null;
      },
      writeRecord: (record) => saveClientFile(userDataPath, record),
    });
    if (!result.ok) {
      if (teamId && isFailureAnswer(result) && result.error.reason === 'team_rate_limit') {
        joinLimits.set(teamId, { until: now() + JOIN_RATE_LIMIT_MS, answer: result });
      }
      return result;
    }
    if (stopped) {
      // Stopped between the write and here: the join made this key and file, so it removes them.
      removeMembership({ userDataPath, deviceKeys, teamId: result.record.team_id, log: say });
      return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    }
    const manager = addManager(result.record);
    push();
    return { ok: true, team: manager.snapshot() };
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

  async function runRecover({ invite, display_name: displayName, label }, extraAddresses) {
    await startExisting();
    const teamId = parseTeamId(invite);
    if (!teamId) return teamFailure('INVITE_MALFORMED', 'team_invite_malformed');
    const held = managers.get(teamId) || null;
    if (held) {
      await held.stop();
      if (managers.get(teamId) === held) managers.delete(teamId);
    }
    if (!held && managers.size >= MAX_TEAMS) return invalidRequest('team_limit_reached');
    const result = await flow.recover({ invite, displayName, label, extraAddresses },
      { writeRecord: (record) => saveClientFile(userDataPath, record) });
    if (stopped) return result.ok ? teamFailure('HOST_STOPPED', 'team_connection_stopped') : result;
    if (!result.ok) {
      // A refused redeem changed nothing local: the stopped manager comes back from its unchanged
      // file. After an accepted redeem that this device failed to save, the old device is revoked
      // on the host, so its manager stays stopped until Recover runs again.
      if (held && result.error.reason !== 'team_recover_local_save_failed') {
        const loaded = loadClientFile(userDataPath, teamId);
        if (loaded.ok) addManager(loaded.record);
      }
      push();
      return result;
    }
    const manager = addManager(result.record);
    push();
    return { ok: true, team: manager.snapshot() };
  }

  // Main-process callers only (the team host controller); the payload is checked like a join's.
  function checkedOwnerPayload(payload) {
    const { extraAddresses = [], ...rest } = payload || {};
    const checked = validatePayload('join', rest);
    if (!checked.ok || !Array.isArray(extraAddresses) || extraAddresses.length > 4) return null;
    return { value: checked.value, extraAddresses: extraAddresses.filter((address) => typeof address === 'string') };
  }

  async function ownerJoin(payload) {
    const checked = checkedOwnerPayload(payload);
    if (!checked) return invalidRequest();
    if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    return exclusive(() => runJoin(checked.value, checked.extraAddresses));
  }

  async function ownerRecover(payload) {
    const checked = checkedOwnerPayload(payload);
    if (!checked) return invalidRequest();
    if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    return exclusive(() => runRecover(checked.value, checked.extraAddresses));
  }

  /** True when this Jenny holds a key, a directory or a manager for the team; throws when the secure store is unavailable. */
  function holds(teamId) {
    return managers.has(teamId) || flow.alreadyHeld(teamId);
  }

  async function removeTeam(teamId) {
    const manager = managers.get(teamId);
    if (!manager) return invalidRequest('team_not_found');
    try {
      deviceKeys.remove(teamId);
    } catch (error) {
      return failureOf(error);
    }
    await manager.stop();
    forget(teamId, manager, { key: false });
    return { ok: true };
  }

  async function run(method, value) {
    if (method === 'join') return join(value);
    if (method === 'status') return { ok: true, ...snapshot() };
    if (method === 'removeTeam') return removeTeam(value.team_id);
    const manager = managers.get(value.team_id);
    if (!manager) return invalidRequest('team_not_found');
    if (method === 'leave') {
      const answer = await manager.leave();
      if (answer.ok !== true) return answer;
      forget(value.team_id, manager);
      return { ok: true };
    }
    if (method === 'deviceRevoke' && manager.isOwnDevice(value.device_id)) {
      return manager.revokeOwnDevice(hostParams(value));
    }
    return manager.command(HOST_OPERATIONS[method], hostParams(value));
  }

  async function handle(method, payload) {
    const checked = validatePayload(method, payload);
    if (!checked.ok) return invalidRequest();
    if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
    let answer;
    try {
      answer = await run(method, checked.value);
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
    const all = [...managers.values()];
    managers.clear();
    await Promise.all([joining, ...all.map((manager) => manager.stop())]);
  }

  function resources() {
    const totals = { managers: managers.size, bridges: 0, timers: 0, sockets: 0, streams: 0 };
    for (const manager of managers.values()) {
      const counts = manager.resources();
      for (const key of ['bridges', 'timers', 'sockets', 'streams']) totals[key] += counts[key];
    }
    return totals;
  }

  return { handle, startExisting, stopAll, snapshot, resources, holds, ownerJoin, ownerRecover };
}

module.exports = { createTeamService };
