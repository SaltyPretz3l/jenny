'use strict';

// Pure parts of the desktop team client (team-service.js), moved out whole when E64 needed its lines: the team id
// an invite names, the check of a main-process owner payload, the GPU sharing calls and the resource totals; slice 6-5
// moved the half-saved cleanup here and added the lazy model sharing wiring; review round two (R10-F02) the
// needs_repair reasons a status never heals.

const { removeMembership } = require('./client-file');
const { validatePayload } = require('./ipc-methods');
const { parseInvite } = require('../../server/team/invites');
const { invalidRequest, teamFailure } = require('./team-errors');

const JOIN_RATE_LIMIT_MS = 60_000;

// The team id an invite names, or null; the invite itself is never kept.
function parseTeamId(invite) {
  const parsed = parseInvite(invite);
  return parsed.ok ? parsed.team_id : null;
}

// Main-process callers only (the team host controller); the payload is checked like a join's.
function checkedOwnerPayload(payload) {
  const { extraAddresses = [], ...rest } = payload || {};
  const checked = validatePayload('join', rest);
  if (!checked.ok || !Array.isArray(extraAddresses) || extraAddresses.length > 4) return null;
  return { value: checked.value, extraAddresses: extraAddresses.filter((address) => typeof address === 'string') };
}

// Slice 4e: this PC's GPU sharing (team-sharing.js decides; the host's node.share row is the authority).
function shareCall(teamSharing, method, value) {
  if (!teamSharing) return invalidRequest('team_sharing_unavailable');
  if (method === 'shareStatus') return { ok: true, sharing: teamSharing.snapshot() };
  if (method === 'shareSet') return teamSharing.set(value.team_id, value.on, { confirmed: value.confirmed === true });
  if (method === 'sharePause') return teamSharing.pause(value.team_id, value.on, value.stop_running === true);
  return teamSharing.stopNow(value.team_id);
}

// True only when the manager held for the team itself says revoked; a missing or unreadable snapshot is not
// (moved out of team-service.js for slice 3-9's wiring lines).
function heldRevoked(managers, teamId) {
  const manager = managers.get(teamId);
  if (!manager) return false;
  try { return manager.snapshot().state === 'revoked'; } catch { return false; }
}

// Every manager's bridges, timers, sockets and streams, summed.
function resourceTotals(managers) {
  const totals = { managers: managers.size, bridges: 0, timers: 0, sockets: 0, streams: 0 };
  for (const manager of managers.values()) {
    const counts = manager.resources();
    for (const key of ['bridges', 'timers', 'sockets', 'streams']) totals[key] += counts[key];
  }
  return totals;
}

// needs_repair reasons a status does not heal from the file and Remove removes as they are: a recovery whose write
// failed (its file names a device the host revoked) and a file whose key is gone (left by a removal from before
// review round two, which removed the key first).
const STICKY_REPAIRS = new Set(['team_recover_local_save_failed', 'team_device_key_missing']);

// A team directory without its file is a leftover of a join or a removal cut short: key and directory go.
function cleanHalfSaved({ userDataPath, deviceKeys, teamId, log }) {
  removeMembership({ userDataPath, deviceKeys, teamId, log });
  log('INFO', 'team.half_saved.cleaned', { team_id: teamId });
}

// Slice 6-5: model sharing (team-models.js) is required on the first model call only; before it, and when the
// service never makes one, every lifecycle call is a no-op and nothing is loaded, read or timed. With the
// `team_model_sharing` kill switch off a call answers here and loads nothing either.
function lazyModels(deps) {
  let models = null;
  return {
    call(method, value) {
      if (!models && deps.enabled?.() === false) return teamFailure('MODEL_FAILED', 'team_model_sharing_off');
      return (models ??= require('./team-models').createTeamModels(deps)).call(method, value);
    },
    connectionChanged: (teamId, manager) => models?.connectionChanged(teamId, manager),
    drop: (teamId) => models?.drop(teamId),
    stopAll: () => models?.stopAll(),
    resources: () => models?.resources() || null,
  };
}

// Row 151 T3: team boards (team-board-clients.js) the same way: required on the first board call only.
function lazyBoards(deps) {
  let boards = null;
  return {
    call: (method, value) => (boards ??= require('./team-board-clients').createTeamBoardClients(deps)).call(method, value),
    connectionChanged: (teamId, manager) => boards?.connectionChanged(teamId, manager),
    drop: (teamId) => boards?.drop(teamId),
    stopAll: () => boards?.stopAll(),
    resources: () => boards?.resources() || null,
  };
}

module.exports = {
  JOIN_RATE_LIMIT_MS, STICKY_REPAIRS, checkedOwnerPayload, cleanHalfSaved, heldRevoked, lazyBoards, lazyModels, parseTeamId,
  resourceTotals,
  shareCall,
};
