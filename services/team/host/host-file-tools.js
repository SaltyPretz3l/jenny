'use strict';

// The owner's project files setting for the team this Jenny hosts (row 123, the team host file tools plan,
// slice 3), behind `hostFileTools { on }`. Main process only, the local owner's own call: never a host operation, never
// something a member's client can send.
//
// - Saved as `team.file_tools` in the host's config (server/config.js reads it at start; off unless `true`). Turning it
//   off writes `false`, so the launch writer's carry (host-layout.js `carryFileTools`) never puts a saved `true` back.
//   Deploy, restore and import write none (I11).
// - Applies at the next host start (D6): a running host restarts on it, as `hostInternet` does. Refused while a turn
//   runs on the host (the host child's `file_tools.turns`, file-tools-link.js), and on Windows while
//   server/config.js TEAM_FILE_TOOLS_WINDOWS_REVIEWED is false (true since W14 passed, 2026-11-17; never set here).
// - The host state carries `file_tools: { on, state, reason }` for a deployed team. `state` is 'unavailable' (this
//   platform cannot turn it on yet), 'off', 'saved' (on, applies at the next start), 'starting' (running, no report
//   yet), 'working' or 'not_working' (the worker's reason word). Closed words only: no path, member or file.

const { notDeployedReason, prepareHostLayout, readSavedHostConfig, savedTeamName } = require('./host-layout');
const { TEAM_FILE_TOOLS_WINDOWS_REVIEWED } = require('../../../server/config');
const { invalidRequest, teamFailure } = require('../team-errors');

const hostFailure = (reason) => teamFailure('HOST_UNAVAILABLE', reason);
const WINDOWS_UNREVIEWED = 'team_file_tools_windows_unreviewed';
const GENERIC_REASON = 'file_access_unavailable';
const BUSY_STATES = new Set(['starting', 'stopping']);

/** Whether the saved config turns project files on. */
function savedOn(saved) {
  return saved?.team?.file_tools === true;
}

/** The saved config with the team block's setting stated; everything else as it was. */
function withFileTools(saved, on) {
  return { ...saved, team: { ...saved.team, file_tools: on } };
}

/**
 * deps: `userDataPath`, `supervisor` (snapshot), `writeConfig(layout, config)`, `restart(startGeneration, name)` and
 * `generation()` (the controller's restart and its stop generation), `hostState()` (the public host state, for the
 * answer), `say(level, event, fields)`, and the seams `readSaved`, `platform`, `windowsReviewed`.
 */
function createHostFileTools({ userDataPath, supervisor, writeConfig, restart, generation, hostState, say = () => {},
  readSaved = readSavedHostConfig, platform = process.platform, windowsReviewed = TEAM_FILE_TOOLS_WINDOWS_REVIEWED }) {
  const platformAllows = () => platform !== 'win32' || windowsReviewed === true;

  /** `{ on, state, reason }` for a deployed team, from the saved config and the supervisor's snapshot. */
  function view(saved, snapshot) {
    const on = savedOn(saved);
    if (!platformAllows()) return { on, state: 'unavailable', reason: WINDOWS_UNREVIEWED };
    if (!on) return { on, state: 'off', reason: null };
    if (!snapshot || snapshot.state !== 'running') return { on, state: 'saved', reason: null };
    const files = snapshot.files;
    if (!files) return { on, state: 'starting', reason: null };
    if (files.on !== true) return { on, state: 'saved', reason: null }; // saved after this run started
    if (files.available === true) return { on, state: 'working', reason: null };
    return { on, state: 'not_working', reason: files.reason || GENERIC_REASON };
  }

  async function set(value) {
    if (!value || typeof value.on !== 'boolean') return invalidRequest();
    const startGeneration = generation();
    const saved = readSaved(userDataPath);
    const name = savedTeamName(saved);
    if (!name) return hostFailure(notDeployedReason(userDataPath));
    if (value.on && !platformAllows()) return hostFailure(WINDOWS_UNREVIEWED);
    const snapshot = supervisor.snapshot();
    if (BUSY_STATES.has(snapshot.state)) return invalidRequest('team_host_busy');
    const running = snapshot.state === 'running';
    if (running && snapshot.files && snapshot.files.turns > 0) return hostFailure('team_host_turn_running');
    if (savedOn(saved) === value.on) return { ok: true, host: hostState(), restarted: false };
    try {
      writeConfig(prepareHostLayout(userDataPath), withFileTools(saved, value.on));
    } catch {
      say('WARN', 'team.host.file_tools_save_failed');
      return hostFailure('team_host_config_write_failed');
    }
    say('INFO', 'team.host.file_tools_saved', { on: value.on, restart: running });
    if (!running) return { ok: true, host: hostState(), restarted: false };
    const restarted = await restart(startGeneration, name);
    if (!restarted.ok) return restarted;
    return { ok: true, host: restarted.host, restarted: true };
  }

  return Object.freeze({ set, view });
}

module.exports = { createHostFileTools, savedOn };
