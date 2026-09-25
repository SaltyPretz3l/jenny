'use strict';

const { stableJson } = require('./contracts');
const { exact, fail, sha } = require('./lineage-contracts');
const { rootDefinition, authorityFingerprint, assertRootStart, bindRootInferenceBudget } = require('./root-run-start');
const { createInferenceBudget } = require('./inference-budget');

const CHILD_KEYS = ['args_sha256', 'authority_fingerprint', 'parent_turn_id', 'parent_work_id',
  'root_run_id', 'root_work_id', 'schema_version', 'spawn_call_id'];

function assertAncestor(work, runtime) {
  if (!work || runtime.scheduler.cancellationFences.has(work.work_id) || ['failed', 'cancelled', 'needs_attention'].includes(work.status)
    || work.control_request?.kind === 'cancel') fail('runtime_child_ancestor_unavailable');
}
function resolveChildLineage(runtime, work) {
  const grant = work?.input?.child_run;
  if (!exact(work?.input, ['child_run', 'kind', 'request', 'route', 'schema_version'])
    || work.input.schema_version !== 1 || work.input.kind !== 'child_chat'
    || !exact(grant, CHILD_KEYS) || grant.schema_version !== 1 || !sha(grant.authority_fingerprint)
    || !sha(grant.args_sha256) || work.input.request?.runtimeChildReadOnly !== true) {
    fail('runtime_child_definition_invalid');
  }
  const rootWork = runtime.store.get(grant.root_work_id);
  assertAncestor(rootWork, runtime);
  const root = rootDefinition(rootWork);
  if (root?.schema_version !== 2 || root.root_run_id !== grant.root_run_id) fail('runtime_child_root_invalid');
  const lineage = runtime.lineageStore.get(root.root_run_id);
  if (lineage.cancelled || lineage.restored || lineage.root_work_id !== rootWork.work_id
    || lineage.root_turn_id !== rootWork.turn_id || lineage.root_session_id !== rootWork.session_id
    || lineage.project_id !== work.project_id || lineage.provider_id !== work.input.route?.provider_id
    || lineage.authority_fingerprint !== root.authority_fingerprint
    || stableJson(lineage.limits) !== stableJson(root.orchestration_limits)) fail('runtime_child_lineage_unavailable');
  const child = lineage.children.find(row => row.work_id === work.work_id);
  if (!child || child.state !== 'committed' || child.session_id !== work.session_id || child.turn_id !== work.turn_id
    || child.parent_work_id !== grant.parent_work_id || child.parent_turn_id !== grant.parent_turn_id
    || child.call_id !== grant.spawn_call_id || child.args_sha256 !== grant.args_sha256
    || child.submission_sha256 !== work.submission_hash || child.restored_submission_sha256 !== null) {
    fail('runtime_child_publication_unproven');
  }
  let parentId = child.parent_work_id;
  for (let depth = child.depth; depth > 0; depth--) {
    const parent = runtime.store.get(parentId);
    assertAncestor(parent, runtime);
    if (parentId === rootWork.work_id) return { rootWork, root, lineage, child };
    const ancestor = lineage.children.find(row => row.work_id === parentId && row.state === 'committed');
    if (!ancestor || ancestor.submission_sha256 !== parent.submission_hash) fail('runtime_child_ancestor_unavailable');
    parentId = ancestor.parent_work_id;
  }
  fail('runtime_child_ancestry_invalid');
}
function assertRuntimeWork(store, service, work, context) {
  if (work?.input?.kind !== 'child_chat') return assertRootStart(store, service, work, context);
  const { root, child } = resolveChildLineage(service.sessionRuntime, work);
  if (context.trusted.readOnly !== true || !context.request.runtimeChildReadOnly
    || authorityFingerprint(service, context) !== work.input.child_run.authority_fingerprint
    || stableJson(context.trusted.authority) !== stableJson(work.authority)) fail('runtime_child_authority_changed');
  if (context.lease && context.lease.identity.sessionIncarnation !== child.session_incarnation) {
    fail('runtime_child_session_changed');
  }
  const budget = store.get(root.root_run_id);
  if (budget.authority_fingerprint !== root.authority_fingerprint
    || stableJson(budget.limits) !== stableJson(root.limits)
    || stableJson(budget.allowed_provider_ids) !== stableJson(root.allowed_provider_ids)) fail('runtime_child_budget_changed');
  return root;
}
function bindRuntimeInferenceBudget(store, service, work, context) {
  if (work?.input?.kind !== 'child_chat') return bindRootInferenceBudget(store, service, work, context);
  const root = assertRuntimeWork(store, service, work, context);
  return createInferenceBudget({ store, rootRunId: root.root_run_id, workId: work.work_id,
    attemptId: work.attempt.attempt_id, providerId: context.route.provider_id,
    authorityFingerprint: root.authority_fingerprint });
}

module.exports = { assertAncestor, resolveChildLineage, assertRuntimeWork, bindRuntimeInferenceBudget };
