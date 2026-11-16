'use strict';

// The member's `teamReconnectCode` (TEAM_INTERNET_SPEC I9, slice 5-3): a pasted
// reconnect code moves where one team is dialled, never who its host is. The
// code is checked against the saved membership first (reconnect-code.js
// `applyReconnectCode`: the host key and team id the client file already holds
// are the identity check), so a malformed code or another host's code stops
// nothing and writes nothing. A valid one stops that team's connection manager,
// so a running manager never writes its old addresses back, applies the code to
// the file as it is after the stop, and starts a manager from the saved file.
// When the write fails, a manager comes back only from a file that loads now:
// a file removed meanwhile (the team was removed) starts nothing. Main process
// only; the code reaches no log, failure or host request.

const { loadClientFile } = require('./client-file');
const { applyReconnectCode, writeReconnectCode } = require('./reconnect-code');
const { teamFailure } = require('./team-errors');

/**
 * `stop()` stops and releases the team's manager; `start(record)` starts a new one from `record`, and
 * `start(null)` starts none (the caller still pushes its snapshot). `write` is a test seam.
 * Resolves { ok: true } or a failure answer (reason words only).
 */
async function applyTeamReconnectCode({ userDataPath, teamId, code, stop, start, write = writeReconnectCode }) {
  const loaded = loadClientFile(userDataPath, teamId);
  if (!loaded.ok) return teamFailure('CONNECTION_FAILED', loaded.reason);
  const checked = applyReconnectCode(loaded.record, code);
  if (!checked.ok) return checked;
  await stop();
  let written;
  try {
    written = write({ userDataPath, teamId, code });
  } catch {
    written = teamFailure('CONNECTION_FAILED', 'team_client_write_failed');
  }
  if (written.ok) {
    start(written.record);
    return { ok: true };
  }
  const current = loadClientFile(userDataPath, teamId);
  start(current.ok ? current.record : null);
  return written;
}

module.exports = { applyTeamReconnectCode };
