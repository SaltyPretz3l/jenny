'use strict';
const { stableJson } = require('../session-runtime/contracts');
const { assertRuntimeContinuationProtocol } = require('../session-runtime/inference-protocol');
function releaseRuntimeMutation(service, work, checkpoint, assertCleanup) {
  const owner = service.sessionRuntime?.mutationJournalProof;
  const args = { work, reference: checkpoint.mutation_ref, decision: checkpoint.decision,
    completedRefs: checkpoint.completed_effect_refs, allowReleased: true };
  if (!owner || assertCleanup() !== true) return false;
  const proof = owner.verify(args);
  if (proof.released) return true;
  assertRuntimeContinuationProtocol(service.sidecarClient);
  return service.sidecarClient.request('workspace.release_runtime_checkpoint', {
    accept_version: '2026-08-17', schema_version: 1, checkpoint,
    workspace_root: work.authority.root_path, device_id: String(work.authority.device_id),
    inode: String(work.authority.inode),
  }, { timeoutMs: 15000 }).then(result => {
    if (result?.schema_version !== 1 || result.status !== 'released'
      || stableJson(result.binding) !== stableJson(proof.binding)) return false;
    return assertCleanup() === true && owner.verify(args).released === true;
  });
}
module.exports = { releaseRuntimeMutation };
