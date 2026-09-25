'use strict';

const { createHash } = require('node:crypto');
const { stableJson, validId } = require('./contracts');
const { createInferenceBudget } = require('./inference-budget');
const { validLineageLimits } = require('./lineage-contracts');
const { validTerminalTombstone } = require('./terminal-retention-contract');
const COUNTERS = ['inference_requests', 'input_tokens', 'output_tokens'];
const ROOT_KEYS = ['allowed_provider_ids', 'authority_fingerprint', 'limits', 'root_run_id', 'schema_version'];

function validLimits(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === COUNTERS.join(',')
    && COUNTERS.every(key => Number.isSafeInteger(value[key]) && value[key] > 0
      && value[key] <= 1_000_000_000_000));
}
function validStart(value) {
  return Boolean(value && typeof value === 'object'
    && Object.keys(value).sort().join(',') === 'limits,purpose'
    && typeof value.purpose === 'string' && value.purpose.trim()
    && value.purpose.length <= 256 && validLimits(value.limits));
}
function digest(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function authorityFingerprint(service, context) {
  const { authority_revision: _revision, ...execution } = service.sessionExecutionAuthority.toExecutionContext(context.binding);
  return digest({ execution, mode: context.trusted.mode, read_only: context.trusted.readOnly,
    tool_preferences: context.request.toolPreferences || null });
}
function captureRootStart(service, prepared, idempotencyKey, start, existingWork = null) {
  if (!validStart(start) || !validId(idempotencyKey)) throw new TypeError('runtime_start_invalid');
  const retained = existingWork?.input?.original_kind === 'root_chat' && validTerminalTombstone(existingWork);
  const existing = existingWork ? rootDefinition(retained
    ? { ...existingWork, input: { ...existingWork.input, schema_version: 1, kind: 'root_chat' } } : existingWork) : null;
  const lane = service.sessionRuntime?.lanes?.snapshot().configured?.[prepared.route.resource_class];
  const orchestration = existing?.orchestration_limits || {
    descendants: lane?.descendants, descendant_depth: lane?.descendant_depth,
  };
  const legacy = existing?.schema_version === 1;
  if (!legacy && !validLineageLimits(orchestration)) throw new Error('runtime_start_orchestration_limits_unavailable');
  return { ...prepared.input, kind: 'root_chat', root_run: { schema_version: legacy ? 1 : 2,
    ...(!legacy ? { orchestration_limits: { ...orchestration } } : {}),
    root_run_id: `rootrun_${digest(idempotencyKey)}`,
    authority_fingerprint: authorityFingerprint(service, prepared),
    allowed_provider_ids: [prepared.route.provider_id], limits: { ...start.limits } } };
}
function rootDefinition(work) {
  const root = work?.input?.root_run;
  if (work?.input?.kind === 'immediate_chat' && root === undefined) return null;
  if (work?.input?.schema_version !== 1 || work.input.kind !== 'root_chat'
    || !root || Object.keys(root).sort().join(',') !== (root.schema_version === 2
      ? [...ROOT_KEYS, 'orchestration_limits'].sort() : ROOT_KEYS).join(',')
    || ![1, 2].includes(root.schema_version)
    || (root.schema_version === 2 && !validLineageLimits(root.orchestration_limits)) || root.root_run_id !== `rootrun_${digest(work.idempotency_key)}`
    || !/^[a-f0-9]{64}$/u.test(root.authority_fingerprint) || !validLimits(root.limits)
    || !Array.isArray(root.allowed_provider_ids) || root.allowed_provider_ids.length !== 1
    || root.allowed_provider_ids[0] !== work.input.route?.provider_id) {
    throw new Error('runtime_root_definition_invalid');
  }
  return root;
}
function ensureRootStart(store, work) {
  const root = rootDefinition(work);
  if (!root) throw new Error('runtime_root_definition_missing');
  return store.create({ rootRunId: root.root_run_id, authorityFingerprint: root.authority_fingerprint,
    allowedProviderIds: root.allowed_provider_ids, limits: root.limits });
}
function assertRootStart(store, service, work, context) {
  const root = rootDefinition(work);
  if (!root) return null;
  if (root.authority_fingerprint !== authorityFingerprint(service, context)) {
    throw new Error('runtime_root_authority_changed');
  }
  const durable = store?.get(root.root_run_id);
  if (!durable || durable.authority_fingerprint !== root.authority_fingerprint
    || stableJson(durable.allowed_provider_ids) !== stableJson(root.allowed_provider_ids)
    || stableJson(durable.limits) !== stableJson(root.limits)) {
    throw new Error('runtime_root_budget_unavailable');
  }
  return root;
}
function bindRootInferenceBudget(store, service, work, context) {
  const root = assertRootStart(store, service, work, context);
  return root ? createInferenceBudget({ store, rootRunId: root.root_run_id, workId: work.work_id,
    attemptId: work.attempt.attempt_id, providerId: context.route.provider_id,
    authorityFingerprint: root.authority_fingerprint }) : null;
}

module.exports = { rootDefinition, authorityFingerprint, validStart, captureRootStart, ensureRootStart, assertRootStart, bindRootInferenceBudget };
