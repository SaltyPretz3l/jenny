'use strict';

// What the desktop host controller knows about the stored host key, without ever keeping it (extracted from
// host-controller.js, which sits at its size ceiling): the team id derived from the key (cached, never the seed), the
// key's state for the page, and the refusal a lost key gets. Every buffer `keys.load()` returns is zeroed in a
// `finally`, whatever the path out.

const fs = require('node:fs');

const { deriveTeamId, keyPairFromSeed } = require('../../../server/team/ids');
const { TeamError } = require('../team-errors');
const { parsePreservedCorruptName } = require('../../backend/corrupt-file-preserve');
const { hostWasDeployed } = require('./host-layout');

// The secure store's file is `<userData>/secure-state.json` (services/backend/backend-service.js); a damaged one
// is set aside beside it under a name `parsePreservedCorruptName` reads.
const SECURE_STORE_FILE = 'secure-state.json';

// The refusal for a deployed profile whose host key is gone.
function lostHostKey(userDataPath) {
  let setAside = false;
  try {
    setAside = fs.readdirSync(userDataPath).some((name) => parsePreservedCorruptName(name)?.baseName === SECURE_STORE_FILE);
  } catch { /* none seen */ }
  return new TeamError('DEVICE_KEY_UNAVAILABLE', setAside ? 'team_host_key_set_aside' : 'team_host_key_missing');
}

/** `keys`: the host key store (`load()`). */
function createHostKeyState({ userDataPath, keys }) {
  // The team id of the stored host key, once read (slice 1g-1); only a derived id is kept, never the seed.
  let storedTeamId = null;

  // Read lazily, only for a deployed profile whose running host does not name its team; a failing
  // store gives null and is asked again next time. The seed is zeroed as soon as the id is derived.
  function teamId() {
    if (storedTeamId) return storedTeamId;
    let seed = null;
    try {
      seed = keys.load();
      if (seed) storedTeamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
    } catch {
      return null;
    } finally {
      seed?.fill(0);
    }
    return storedTeamId;
  }

  // Slice 5-6 (finding 4): the key's state without pressing Start. Null for a profile that never hosted a team;
  // 'ok', 'missing', 'set_aside' (the secure store set a damaged file aside), or 'unknown' (the store cannot say).
  function state() {
    if (!hostWasDeployed(userDataPath)) return null;
    let seed = null;
    try {
      if (teamId()) return 'ok';
      seed = keys.load();
      if (seed !== null) return 'unknown';
    } catch {
      return 'unknown';
    } finally {
      seed?.fill(0);
    }
    return lostHostKey(userDataPath).reason === 'team_host_key_set_aside' ? 'set_aside' : 'missing';
  }

  return {
    teamId, state,
    /** A deploy or a recover just derived `id` from the key it holds. */
    note(id) { storedTeamId = id; },
    /** The key may be gone, new or restored: read it again. */
    forget() { storedTeamId = null; },
  };
}

module.exports = { createHostKeyState, lostHostKey };
