'use strict';

const { createHash } = require('node:crypto');
const { isRuntimeRoute } = require('./lanes');
const { stableJson, normalizeAuthority } = require('./contracts');
const { normalizeContinuationContext } = require('./continuation-contracts');

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

// Only the admitted application attempt can mint these wire references. No
// provider URL, selected UI engine, or model-provided identity is consulted.
function buildAdmittedContinuationContext({ work, attempt, route, executionContext } = {}) {
  const authority = normalizeAuthority(work?.authority);
  if (!work || work.status !== 'running' || !attempt || !authority || !executionContext || !isRuntimeRoute(route)
    || stableJson(work.attempt) !== stableJson(attempt)
    || stableJson(work.input?.route) !== stableJson(route)
    || work.project_id !== authority.project_id
    || executionContext?.authority_revision !== attempt.authority_revision
    || Object.keys(authority).some(key => executionContext[key] !== authority[key])) {
    throw new Error('runtime_continuation_context_fence_conflict');
  }
  const routeDigest = sha256(route);
  const context = normalizeContinuationContext({ schema_version: 1,
    work_id: work.work_id, turn_id: work.turn_id, source_attempt: attempt,
    authority: { project_id: authority.project_id, root_id: authority.root_id,
      root_revision: authority.root_revision, sha256: sha256(authority) },
    route: { route_id: `route_${routeDigest}`, route_revision: route.configuration_revision,
      sha256: routeDigest },
  });
  return Object.freeze({ ...context, source_attempt: Object.freeze(context.source_attempt),
    authority: Object.freeze(context.authority), route: Object.freeze(context.route) });
}

module.exports = { buildAdmittedContinuationContext };
