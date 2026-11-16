'use strict';

// Force local in the team service (row 123, owner decision E64; force-local-hold.js owns the gate). `hold` first ends
// a join or recovery dialling now (the join flow's `cancel`), then stops every live manager as a stopped held team
// stops, each remembered in memory with the name the host gave. A name that cannot be read is null and a stop that
// fails does not keep the other managers running; the step then fails, so the gate runs it again. `release` starts
// each team a hold stopped (or a held launch listed through addManager) from its file. Both push the snapshot.

function createServiceHold({ managers, heldTeams, nameOf, stopHeld, restoreHeld, cancelDial, push, isStopped, say }) {
  async function hold() {
    cancelDial();
    const stopped = await Promise.all([...managers].map(async ([teamId, manager]) => {
      heldTeams.note(teamId, nameOf(manager));
      try {
        await stopHeld(teamId, manager, { pause: true });
        return true;
      } catch {
        say('WARN', 'team.force_local.stop_failed', { team_id: teamId });
        return false;
      }
    }));
    push();
    if (stopped.includes(false)) throw new Error('team_force_local_hold_incomplete');
  }

  function release() {
    for (const teamId of heldTeams.take()) if (!isStopped()) restoreHeld(teamId);
    push();
  }

  return { hold, release };
}

module.exports = { createServiceHold };
