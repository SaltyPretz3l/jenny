'use strict';

// Remove team for a row with no manager (a needs_repair row, a deleted row, a held one), extracted from
// team-service.js (at its size ceiling). A row whose file loads now starts its manager and the removal is refused (the
// caller refreshes and sees the team). Otherwise the order is the one every removal has (dropRevoked): the team's
// directory goes first, with its chat client and unsent drafts, and the device key only after it, so a directory that
// cannot be removed keeps the key and the row stays removable (a key gone first left a file nothing could open).

const { loadClientFile, removeMembership } = require('./client-file');
const { STICKY_REPAIRS } = require('./team-service-helpers');
const { failureOf, invalidRequest, teamFailure } = require('./team-errors');

/**
 * deps: `userDataPath`, `deviceKeys`, `repairs` (team id -> reason), `deleted` and `heldTeams` (the row sets: `has`,
 * `forget`), `chats` (`drop`), `drafts` (`forget`), `addManager(record)`, `push()`, `say`.
 */
function createRepairRemoval({ userDataPath, deviceKeys, repairs, deleted, heldTeams, chats, drafts, addManager, push, say }) {
  return function removeRepair(teamId) {
    const loaded = STICKY_REPAIRS.has(repairs.get(teamId)) || deleted.has(teamId) || heldTeams.has(teamId) ? null
      : loadClientFile(userDataPath, teamId);
    if (loaded && loaded.ok) {
      addManager(loaded.record);
      push();
      return invalidRequest('team_join_in_progress');
    }
    if (!removeMembership({ userDataPath, deviceKeys, teamId, key: false, log: say }).file) {
      return teamFailure('CONNECTION_FAILED', 'team_client_write_failed');
    }
    chats.drop(teamId); drafts.forget(teamId); // row 175 F6: a rejoin never gets the removed membership's box text back
    try {
      deviceKeys.remove(teamId);
    } catch (error) {
      return failureOf(error);
    }
    repairs.delete(teamId);
    deleted.forget(teamId);
    heldTeams.forget(teamId);
    push();
    return { ok: true };
  };
}

module.exports = { createRepairRemoval };
