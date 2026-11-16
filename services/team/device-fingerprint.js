'use strict';

// The fingerprint of this device's key for each team, by the host's own rule (server/team/team-views.js).
// Each seed read is zeroed at once; only the fingerprint is kept, per team, until `forget`. A key that cannot
// be read gives null and is asked again next time.

const { keyPairFromSeed } = require('../../server/team/ids');
const { fingerprintOf } = require('../../server/team/team-views');

function createDeviceFingerprints({ deviceKeys }) {
  const known = new Map();
  return {
    of(teamId) {
      if (known.has(teamId)) return known.get(teamId);
      let seed = null;
      let value;
      try {
        seed = deviceKeys.load(teamId);
        value = seed ? fingerprintOf(keyPairFromSeed(seed).publicKey) : null;
      } catch {
        value = null;
      } finally {
        seed?.fill?.(0);
      }
      if (value) known.set(teamId, value);
      return value;
    },
    forget(teamId) { known.delete(teamId); },
  };
}

module.exports = { createDeviceFingerprints };
