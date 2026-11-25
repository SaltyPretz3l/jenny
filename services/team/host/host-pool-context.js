'use strict';

// The owner's cap on the pool's context length for the team this Jenny hosts (row 201, OD-5), behind
// `hostPoolContext { context_cap }`. Main process only, the local owner's own call: never a host operation, never
// something a member's client can send.
//
// - Auto (null, the default) follows the serving node's own bounded `context_length`, up to POOL_CONTEXT_AUTO; a cap from
//   POOL_CONTEXT_MIN lowers that. host-layout.js keeps it in `pool-context-cap.json` beside the config (writePoolContextCap
//   checks the bounds) and every config written afterwards carries it.
// - It applies at the host's next start: a running host is not restarted, because a restart would end the turns members
//   have running on the pool (hostInternet and hostFileTools restart because their setting cannot wait; this one can).
//   The page says so.
// - The host state carries `pool_context_cap: number|null`; the state is pushed after a save, so every window shows it and
//   the controller's push cache never serves the old one.

const { readPoolContextCap, writePoolContextCap } = require('./host-layout');
const { invalidRequest, teamFailure } = require('../team-errors');

const INVALID = 'team_pool_context_invalid';

/**
 * deps: `userDataPath`, `hostState()` (the public host state, for the answer), `pushState()` (every window), `running()`
 * (whether the host runs, for the log line), `say(level, event, fields)` and the seams `readCap`, `writeCap`.
 */
function createHostPoolContext({ userDataPath, hostState, pushState = () => {}, running = () => false, say = () => {},
  readCap = readPoolContextCap, writeCap = writePoolContextCap }) {
  /** The saved cap, or null (Auto). */
  const view = () => readCap(userDataPath);

  async function set(value) {
    if (!value || !Object.hasOwn(value, 'context_cap')) return invalidRequest(INVALID);
    const saved = writeCap(userDataPath, value.context_cap);
    if (!saved.ok) {
      if (saved.reason === INVALID) return invalidRequest(INVALID);
      say('WARN', 'team.host.pool_context_save_failed');
      return teamFailure('HOST_UNAVAILABLE', saved.reason);
    }
    say('INFO', 'team.host.pool_context_saved', { capped: value.context_cap !== null, running: running() });
    pushState();
    return { ok: true, host: hostState(), restarted: false };
  }

  return Object.freeze({ set, view });
}

module.exports = { createHostPoolContext };
