'use strict';

// `team-delete` (slice 3-14): deletes the team a stopped headless host holds, after its name is typed on the
// terminal exactly as the member store holds it (the config's name when there is no store; on a re-run after a
// cut, the name the first run's marker holds). No flag skips the question: a wrong name, an empty line, Ctrl-C or
// the end of input deletes nothing.
//
// Removed: every project folder, the trash, restore staging folders, the profile's stores (members and devices,
// audit logs, team chat, sessions, upload staging, the ready marker), then the key file LAST. Kept: the three
// volume roots (mount points), the projects root itself (the image makes it and the host refuses to start
// without it), the profile's lock file and owner marker, and the read-only config. Members are not told: the
// server is stopped, so no "deleted by its owner" notice reaches them (they see an unreachable host).
//
// Order: the terminal, the config and the profile lock; the profile, data volume and projects root each a real
// directory at its own real path (missing: `team_projects_root_missing`; a link: `team_delete_link`), so nothing is
// listed or removed through a linked root; a root that cannot be listed refuses (`team_delete_failed`), never read
// as empty; nothing to delete (no key file, store, project, trash, marker or a cut restore's staging) answers
// `team_not_deployed` before the question; the typed name; a link anywhere in the team's data or at the key file
// refuses with nothing touched (`team_delete_link`). Then the marker `.jenny-team-deleting` is written into the
// profile holding the name that was asked (not a secret), whole and synced with its folder: the commit point. A
// marker whose write fails is removed again (`team_delete_failed`, the team still starts), and one that cannot be
// removed either answers `team_delete_marker_left`. From there the delete goes on to
// the end, and a run that is cut or fails part way (`team_delete_failed`) leaves the marker, so the next
// `team-delete` finishes it, asking for the marker's name (the store, and with it a renamed team's name, may be
// gone by then).
// The key file goes after the data and before the marker. Output: counts and what was kept; never a path or a key.

const path = require('node:path');

const { readJsonFile, removeFileInside } = require('../../services/team/host/host-files');
const { MEMBERS_FILE } = require('./member-store');
const { isTerminalPair, readTerminalLine } = require('./tty-input');
const {
  DELETE_MARKER, RESTORE_MARKER, findLinks, hasTeam, refusal, removeMarker, removeTeamData, rootsReason, teamRoots,
  teamState, withTeamProfile, writeMarker,
} = require('./team-maintenance');

// The name the owner must type: an unfinished delete's marker's, else the member store's, else the config's.
function teamNameOf(roots, config) {
  try {
    const marked = readJsonFile(path.join(roots.profile, DELETE_MARKER))?.team_name;
    if (typeof marked === 'string' && marked.length > 0) return marked;
  } catch { /* no marker, or one from before it held the name */ }
  try {
    const name = readJsonFile(path.join(roots.profile, MEMBERS_FILE))?.team?.name;
    if (typeof name === 'string' && name.length > 0) return name;
  } catch { /* no store, or one that does not read: the config's name */ }
  return config.team.name;
}

/**
 * Deletes the team. Answers { ok, projects } or { ok: false, reason }. `cut(step)`: a test seam called after each
 * step ('marker', 'projects', 'trash', 'profile', 'key').
 */
async function deleteHostedTeam({
  configPath, output = process.stdout, input = process.stdin, promptOutput = process.stderr, logger = null,
  acquireProfileImpl, readLineImpl = readTerminalLine, cut = () => {},
} = {}) {
  if (!isTerminalPair(input, promptOutput)) return refusal('team_tty_required');
  return withTeamProfile({ configPath, acquireProfileImpl, logger, event: 'team.delete' }, async (config, say) => {
    const roots = teamRoots(config);
    const badRoot = rootsReason(roots, 'team_delete_link');
    if (badRoot) return refusal(badRoot);
    const state = teamState(roots);
    // A root that cannot be listed is never "0 project folders" (review sweep X4c-F01): nothing is asked or removed.
    if (state.unreadable) return refusal('team_delete_failed');
    if (!hasTeam(state) && !state.deleting && !state.restoring && !state.staging) return refusal('team_not_deployed');
    const expected = teamNameOf(roots, config);
    let typed;
    try {
      typed = await readLineImpl({ input, output: promptOutput, echo: true,
        prompt: `This deletes the team, its ${state.projects} project folders and its host key. Type the team name to delete it: ` });
    } catch {
      return refusal('team_delete_cancelled');
    }
    if (typed !== expected) return refusal('team_delete_name_mismatch');
    const links = await findLinks(roots);
    if (links === null) return refusal('team_delete_failed');
    if (links) return refusal('team_delete_link');
    const unmarked = writeMarker(roots, DELETE_MARKER, JSON.stringify({ team_name: expected }));
    if (unmarked) return refusal(unmarked === 'left' ? 'team_delete_marker_left' : 'team_delete_failed');
    cut('marker');
    const removed = await removeTeamData(roots, { cut });
    if (!removed.ok) return refusal('team_delete_failed');
    if (!removeFileInside(roots.secrets, roots.keyFile)) return refusal('team_delete_failed');
    cut('key');
    if (!removeMarker(roots, RESTORE_MARKER) || !removeMarker(roots, DELETE_MARKER)) return refusal('team_delete_failed');
    say('INFO', 'team.delete.done', { projects: state.projects });
    output.write(`Deleted the team: ${state.projects} project folders, the trash, the stores and the host key.\n`
      + 'Kept: the volumes, the empty projects folder, the profile lock and owner files, and team-host.json.\n'
      + 'Members were not told; their Jenny shows the team as unreachable.\n');
    return { ok: true, projects: state.projects };
  });
}

module.exports = { deleteHostedTeam };
