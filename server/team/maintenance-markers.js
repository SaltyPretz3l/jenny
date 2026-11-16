'use strict';

// The two markers the headless maintenance commands leave in the profile while a change is half done (slice 3-14):
// `.jenny-team-deleting` (a delete committed and not yet finished; it holds the team name the delete asks for) and
// `.jenny-team-restoring` (a restore began moving data into place). Its own module so the server start and
// `keygen.js` read them without the maintenance commands; the `team-keygen` verb itself now also asks
// `team-maintenance.js` `keygenRefusal` (a cut restore's staging), which loads them.

const fs = require('node:fs');
const path = require('node:path');

const DELETE_MARKER = '.jenny-team-deleting';
const RESTORE_MARKER = '.jenny-team-restoring';

const present = (file) => {
  try { fs.lstatSync(file); return true; } catch (error) { return error?.code !== 'ENOENT'; }
};

/** `team_delete_unfinished`, `team_restore_unfinished` or null for the profile `profile`. */
function unfinishedReason(profile) {
  if (present(path.join(profile, DELETE_MARKER))) return 'team_delete_unfinished';
  if (present(path.join(profile, RESTORE_MARKER))) return 'team_restore_unfinished';
  return null;
}

/**
 * The team host's start check on its locked profile (review round two, R09-F02): an unfinished delete or restore
 * refuses with the marker's word (the operator runs that command again), never a half-deleted or half-restored
 * team served; then an unfinished conversation import refuses as before. Throws an Error with `reason`.
 */
function assertStartable(profile) {
  const reason = unfinishedReason(profile);
  if (reason) throw Object.assign(new Error(reason), { reason });
  // Loaded here, not at the top: team-keygen loads this module and needs none of the import commands.
  require('../../services/host/maintenance-commands').assertImportComplete(profile);
}

module.exports = { DELETE_MARKER, RESTORE_MARKER, assertStartable, unfinishedReason };
