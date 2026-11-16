'use strict';

// A team its owner deleted, on a member's Jenny (slice 5-6, E61). When the host's `team_deleted` event arrives
// (server/team/team-deleted-notice.js) the team's manager is stopped and the team stays as a kept row,
// "deleted by its owner", with the owner's name and the date and one action, Remove this team. The saved
// membership is not removed by the notice: `<userData>/team/<team_id>/team-deleted.json` marks it, so at each
// start of Jenny the team is dialled once (a probe): if it answers, the team was restored and the mark goes;
// if the first try fails, the row goes back to "deleted". Remove this team removes the membership as for any row.
// A delete can still fail after the notice went out (a file held at the moves), so a marked team is also dialled
// again when the Team section or tab asks for the status, at most every RECHECK_MS (counted from the notice, since
// the server still answers in the moment between telling its members and stopping): the row stays "deleted" while
// that probe runs, and goes, with the mark, when the host answers.
// The mark holds a display name, a time and the team's name, never a key, address or id beyond the folder's.

const fs = require('node:fs');
const path = require('node:path');

const { clientFilePath } = require('./client-file');
const { writeJson } = require('../host/durable-json');
const { removeFileSync } = require('../fs-remove-no-follow');
const { isCleanText } = require('../../server/team/member-schema');

const MARK_FILE = 'team-deleted.json';
// A probe gives up at the first state that is neither connecting nor online.
const PROBING = new Set(['connecting', 'online']);
const RECHECK_MS = 10 * 60_000;

const markPath = (userDataPath, teamId) => path.join(path.dirname(clientFilePath(userDataPath, teamId)), MARK_FILE);

// The event's facts, checked, or null.
function noticeOf(event) {
  if (event?.event_type !== 'team_deleted') return null;
  if (!isCleanText(event.owner_name) || !Number.isSafeInteger(event.deleted_at) || event.deleted_at <= 0) return null;
  return { by: event.owner_name, at: event.deleted_at };
}

function createDeletedTeams({ userDataPath, log = () => {}, now = Date.now }) {
  // team id -> { by, at, team_name }: rows shown as deleted (no manager).
  const rows = new Map();
  // Teams whose manager is a probe of a marked team (at start, or a recheck of a row).
  const probing = new Map();
  // team id -> when its row was last dialled again.
  const checkedAt = new Map();

  function readMark(teamId) {
    try {
      const raw = fs.readFileSync(markPath(userDataPath, teamId), 'utf8');
      const value = raw.length <= 4096 ? JSON.parse(raw) : null;
      return value && typeof value === 'object' ? {
        by: isCleanText(value.by) ? value.by : null, at: Number.isSafeInteger(value.at) ? value.at : null,
        team_name: isCleanText(value.team_name) ? value.team_name : null,
      } : null;
    } catch {
      return null;
    }
  }

  /** Called when the notice arrives: writes the mark; answers the row's facts, or null when it is not a notice. */
  function noted(teamId, event, teamName) {
    const notice = noticeOf(event);
    if (!notice) return null;
    const facts = { ...notice, team_name: isCleanText(teamName) ? teamName : null };
    // The first recheck waits RECHECK_MS: the server tells its members before it stops, so it still answers now.
    checkedAt.set(teamId, now());
    try {
      writeJson(markPath(userDataPath, teamId), { schema_version: 1, ...facts });
    } catch {
      log('WARN', 'team.deleted.mark_failed', { team_id: teamId });
    }
    return facts;
  }

  /** At start: a marked team's facts (its manager then runs as a probe), or null. */
  function startProbe(teamId) {
    const facts = readMark(teamId);
    if (facts) probing.set(teamId, facts);
    return facts;
  }

  /**
   * After a probe's manager changed: 'restored' (online: the mark goes), 'deleted' (the first try failed: the
   * caller stops it and shows the row), or null (still trying, or not a probe).
   */
  function probeChanged(teamId, state) {
    const facts = probing.get(teamId);
    if (!facts) return null;
    if (state === 'online') {
      probing.delete(teamId);
      rows.delete(teamId);
      checkedAt.delete(teamId);
      try { removeFileSync(markPath(userDataPath, teamId)); } catch { /* the next start probes again */ }
      log('INFO', 'team.deleted.restored', { team_id: teamId });
      return 'restored';
    }
    if (PROBING.has(state)) return null;
    probing.delete(teamId);
    rows.set(teamId, facts);
    return 'deleted';
  }

  /** The deleted rows due a recheck at `at` (none dialled within RECHECK_MS, none probing now). */
  function due(at) {
    return [...rows.keys()].filter((teamId) => !probing.has(teamId) && !(at - (checkedAt.get(teamId) ?? -Infinity) < RECHECK_MS));
  }

  /** A row's recheck starts: its manager runs as a probe while the row still shows "deleted". */
  function recheck(teamId, at) {
    const facts = rows.get(teamId);
    if (!facts) return false;
    checkedAt.set(teamId, at);
    probing.set(teamId, facts);
    return true;
  }

  return {
    noted, startProbe, probeChanged, due, recheck,
    show: (teamId, facts) => { probing.delete(teamId); rows.set(teamId, facts); },
    has: (teamId) => rows.has(teamId),
    forget: (teamId) => { rows.delete(teamId); probing.delete(teamId); checkedAt.delete(teamId); },
    size: () => rows.size,
    rows: () => [...rows].map(([teamId, facts]) => ({ team_id: teamId, team_name: facts.team_name, state: 'deleted',
      reason: null, deleted_by: facts.by, deleted_at: facts.at })),
  };
}

module.exports = { MARK_FILE, RECHECK_MS, createDeletedTeams };
