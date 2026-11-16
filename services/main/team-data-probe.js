'use strict';

// Is there team data on disk? (row 123, E50). With the `team` flag on and no team data the renderer
// loads nothing of the team feature until the user's first Join, Deploy or Recover is answered. This check
// needs no team module: it looks for a team-named entry under <userData>/team, the host config and the host
// profile's member store, and a team set aside after a lost key (`team-host-old-<17 digits>`, so its Delete
// row stays reachable after the new team is deleted), and opens no file. A check that cannot tell answers "there is data"; only
// ENOENT and ENOTDIR mean "not there". The names below are pinned equal to those the team modules use
// (services/team/client-file.js, services/team/host/host-layout.js, server/team/member-store.js) by
// tests/team-off.test.js.

const fs = require('node:fs');
const path = require('node:path');

const TEAM_DIR = 'team';
const TEAM_DIR_NAME = /^team_[A-Za-z0-9_-]{1,64}$/u;
const HOST_DIR = 'team-host';
const HOST_CONFIG = 'host-config.json';
const HOST_PROFILE = 'profile';
const HOST_MEMBERS = 'team-members.json';
const OLD_HOST_NAME = /^team-host-old-\d{17}$/u;

const absent = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

// Any entry with a team name counts: a link, junction or file of that name is one this check cannot tell.
function namedThere(dir, pattern) {
  try {
    return fs.readdirSync(dir).some((name) => pattern.test(name));
  } catch (error) {
    return !absent(error);
  }
}

function fileThere(file) {
  try {
    fs.statSync(file);
    return true;
  } catch (error) {
    return !absent(error);
  }
}

function hasTeamData(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath) return true;
  return namedThere(path.join(userDataPath, TEAM_DIR), TEAM_DIR_NAME)
    || namedThere(userDataPath, OLD_HOST_NAME)
    || fileThere(path.join(userDataPath, HOST_DIR, HOST_CONFIG))
    || fileThere(path.join(userDataPath, HOST_DIR, HOST_PROFILE, HOST_MEMBERS));
}

// Read on every call while the answer is no; once yes in this process it stays yes with no read.
function createTeamDataProbe(getUserDataPath) {
  let seen = false;
  return () => {
    if (seen) return true;
    let userDataPath;
    try { userDataPath = getUserDataPath(); } catch { return true; }
    seen = hasTeamData(userDataPath);
    return seen;
  };
}

module.exports = { TEAM_DIR, TEAM_DIR_NAME, OLD_HOST_NAME, HOST_DIR, HOST_CONFIG, HOST_PROFILE, HOST_MEMBERS, hasTeamData, createTeamDataProbe };
