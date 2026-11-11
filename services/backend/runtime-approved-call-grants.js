'use strict';

const { createHash } = require('node:crypto');
const { stableJson } = require('../session-runtime/contracts');

// A person's Allow on a call that then parked on a busy resource. Electron owns
// consent, so the answer stays here: memory only, never a checkpoint or the
// disk, bound to the exact call and spent by the one resume it is taken for.
// An app restart empties it and the resumed call asks again.
const MAX_ENTRIES = 64;

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

function createApprovedCallGrants() {
  const answered = new Map();
  const parked = new Map();
  return Object.freeze({
    noteApproved({ streamId, callId, toolName, input }) {
      remember(answered, `${streamId}\0${callId}`, { toolName, inputDigest: digest(input) });
    },
    // Promote only when what was approved is exactly what parked.
    park({ streamId, call, visibleInput, effectiveArgsSha256, checkpointId }) {
      const key = `${streamId}\0${call.call_id}`;
      const answer = answered.get(key);
      answered.delete(key);
      if (!answer || answer.toolName !== call.tool_id || answer.inputDigest !== digest(visibleInput)) return false;
      remember(parked, checkpointId, Object.freeze({
        call: Object.freeze({ call_id: call.call_id, tool_id: call.tool_id, effective_args_sha256: effectiveArgsSha256 }),
        input: visibleInput,
      }));
      return true;
    },
    take(checkpointId) {
      const grant = parked.get(checkpointId) || null;
      parked.delete(checkpointId);
      return grant;
    },
  });
}

module.exports = { createApprovedCallGrants };
