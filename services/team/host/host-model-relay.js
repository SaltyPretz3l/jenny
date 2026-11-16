'use strict';

// The owner's model relay setting for the team this Jenny hosts (row 123 slice 6-7; TEAM_MODEL_SHARING_SPEC
// "6-7 as built"), behind `hostModelRelay { flowing }`: 0 turns model sharing off on this host, 1 to 4 is how many
// models pass through this PC at once. Main process only, the local owner's own call: never a host operation, never
// something a member's client can send.
//
// - Saved as `team.model_relay_flowing` in the host's config (server/config.js reads it at start), and carried into
//   every config a launch writes afresh (`carry`), so it survives Stop and Start.
// - Applied to a running host at once over the parent channel (host-supervisor.js `setModelRelay`, then the host's
//   model-relay-link.js); no restart. When the host comes up it is sent the saved value, which also covers a setting
//   saved while it was starting; its answer starts the passing count. Once per run and value.
// - The host state carries `model_relay: { flowing, passing, live }` for a deployed team: the saved setting, the
//   transfers flowing through the relay now (0 while stopped) and whether the running host reported them. No member,
//   name, file, hash or path.

const { readSavedHostConfig, savedTeamName, prepareHostLayout } = require('./host-layout');
const { MAX_RELAY_FLOWING } = require('../../../server/team/parent-channel');
const { invalidRequest, teamFailure } = require('../team-errors');

const hostFailure = (reason) => teamFailure('HOST_UNAVAILABLE', reason);

// The relay's default (model-manifest.js MODEL_TRANSFER_LIMITS.flowingPerHost; server/config.js's default too).
const DEFAULT_FLOWING = 2;
const KEY = 'model_relay_flowing';

const validFlowing = (n) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_RELAY_FLOWING;

/** The saved setting, or the default when the config names none (or one the host would refuse). */
function savedFlowing(saved) {
  const value = saved && saved.team && typeof saved.team === 'object' ? saved.team[KEY] : undefined;
  return validFlowing(value) ? value : DEFAULT_FLOWING;
}

/** The saved config with the team block's setting replaced; everything else as it was. */
function withFlowing(saved, flowing) {
  return { ...saved, team: { ...saved.team, [KEY]: flowing } };
}

/**
 * deps: `userDataPath`, `supervisor` (setModelRelay, onState), `writeConfig(layout, config)`, `hostState()` (the public
 * host state, for the answer), `pushState()`, `say(level, event, fields)`, `readSaved` (a seam).
 */
function createHostModelRelay({ userDataPath, supervisor, writeConfig, hostState, pushState = () => {}, say = () => {},
  readSaved = readSavedHostConfig }) {
  let sentFor = '';
  // The saved setting as last read or written here: a tell or a quiet push reads no file. A full host state (`view`)
  // reads the config anyway and refreshes it, so a restore or a new deploy is picked up there.
  let held = null;
  function savedNow() {
    if (held === null) { try { held = savedFlowing(readSaved(userDataPath)); } catch { return DEFAULT_FLOWING; } }
    return held;
  }

  // A host that is running is sent the saved setting (it holds the file's value from its start), once per run and value.
  supervisor.onState((snapshot) => {
    if (!snapshot || snapshot.state !== 'running') return;
    const want = savedNow();
    const key = `${snapshot.since}:${want}`;
    if ((snapshot.relay && snapshot.relay.flowing === want) || sentFor === key) return;
    sentFor = key;
    supervisor.setModelRelay(want);
  });

  /** `{ flowing, passing, live }` for a deployed team, else null. */
  function view(saved, snapshot) {
    if (savedTeamName(saved) === null) return null;
    held = savedFlowing(saved);
    const relay = snapshot && snapshot.state === 'running' ? snapshot.relay : null;
    return { flowing: held, passing: relay ? relay.passing : 0, live: Boolean(relay) };
  }

  /** A pushed state reused from the last one (a quiet change): the setting as it is now (what the running host
   * reported, else the saved one) and its passing count, never the setting the reused state was built with. */
  function patch(host, snapshot) {
    if (!host || !host.model_relay) return host;
    const relay = snapshot && snapshot.state === 'running' ? snapshot.relay : null;
    const flowing = relay && validFlowing(relay.flowing) ? relay.flowing : savedNow();
    return { ...host, model_relay: { flowing, passing: relay ? relay.passing : 0, live: Boolean(relay) } };
  }

  function set(value) {
    if (!value || !validFlowing(value.flowing)) return invalidRequest();
    const saved = readSaved(userDataPath);
    if (savedTeamName(saved) === null) return hostFailure('team_host_not_deployed');
    try {
      writeConfig(prepareHostLayout(userDataPath), withFlowing(saved, value.flowing));
    } catch {
      say('WARN', 'team.host.model_relay_save_failed');
      return hostFailure('team_host_config_write_failed');
    }
    held = value.flowing;
    const applied = supervisor.setModelRelay(value.flowing);
    say('INFO', 'team.host.model_relay_saved', { flowing: value.flowing, applied });
    pushState();
    return { ok: true, host: hostState() };
  }

  /** A config writer that keeps the saved setting in a config written afresh (a launch's buildHostConfig). */
  function carry(write) {
    return (layout, config) => {
      let next = config;
      try {
        const saved = readSaved(userDataPath);
        const kept = saved && saved.team && typeof saved.team === 'object' ? saved.team[KEY] : undefined;
        if (validFlowing(kept) && config && config.team && !Object.hasOwn(config.team, KEY)) next = withFlowing(config, kept);
      } catch { /* nothing saved to keep */ }
      return write(layout, next);
    };
  }

  return Object.freeze({ set, view, patch, carry });
}

module.exports = { DEFAULT_FLOWING, createHostModelRelay, savedFlowing };
