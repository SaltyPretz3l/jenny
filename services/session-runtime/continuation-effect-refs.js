'use strict';
const { createHash } = require('node:crypto');
const { stableJson } = require('./contracts');
const { normalizeCompletedEffects } = require('./continuation-contracts');
function fail() { throw new Error('runtime_continuation_effects_unproven'); }
function completedEffectRefs(events) {
  if (!Array.isArray(events) || events.length > 4096) fail();
  const refs = events.filter(event => event.kind === 'tool_result').map(event => {
    const payload = event.payload;
    if (typeof payload?.tool_output_summary !== 'string' || typeof payload.success !== 'boolean'
      || Object.hasOwn(payload.metadata || {}, 'workspace_change_set') || payload.trusted_attachment_refs?.length) fail();
    return { call_id: event.tool_call_id, tool_id: payload.tool_name, success: payload.success,
      result_sha256: createHash('sha256').update(payload.tool_output_summary).digest('hex') };
  });
  return normalizeCompletedEffects(refs);
}
function assertCompletedEffects(events, refs) {
  if (Buffer.byteLength(stableJson(events)) > 1024 * 1024
    || stableJson(completedEffectRefs(events)) !== stableJson(normalizeCompletedEffects(refs))) fail();
}
module.exports = { completedEffectRefs, assertCompletedEffects };
