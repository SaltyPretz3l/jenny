'use strict';

// Force local for the team host this Jenny runs (row 123, owner decision E64; ../force-local-hold.js owns the gate).
// In memory only: whether the host ran (or was starting) when a hold began, and the owner's names it was last started
// with. A hold only ever sets that memory; a release clears it only once its start answered ok, so a release cut
// short (the mode on again, a start refused, busy or failed) leaves it for the next one, and a refused or failed
// restart is logged by its reason word. A Stop the owner presses forgets it. `interrupt` ends a start in flight at
// once, a release's own included, before the queued hold runs.

function createHostForceLocal({ held, hostState, stop, restart, interruptStart, push, say }) {
  let runAfterHold = false;
  let lastOwner = {};
  return {
    noteOwner({ display_name: displayName, label }) { lastOwner = { display_name: displayName, label }; },
    forget() { runAfterHold = false; },
    interrupt: interruptStart,
    async hold() {
      runAfterHold ||= ['running', 'starting'].includes(hostState());
      await stop();
      push();
    },
    async release() {
      if (runAfterHold && !held()) {
        const answer = await restart(lastOwner);
        if (answer?.ok === true) runAfterHold = false;
        else say('WARN', 'team.force_local.host_restart_failed', { reason: answer?.error?.reason || 'none' });
      }
      push();
    },
  };
}

module.exports = { createHostForceLocal };
