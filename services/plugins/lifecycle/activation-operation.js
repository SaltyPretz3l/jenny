'use strict';

// Stage-5 activation transaction. Remote MCP discovery remains Electron-owned;
// candidate publication is still all-or-nothing through the same commit seam.

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE } = require('../identity/authority-id');
const { safeModeRefusal } = require('../safe-mode');
const { runCommitSequence } = require('./commit-sequence');
const { wireCodeFor } = require('./operation-result');
const {
  CONTROL_PLANE_STAGE,
  DISABLED_ONLY_STATE,
  assertStagePermitsState,
} = require('./stage-gate');
const {
  DENY_CONSENT,
  buildRequestFingerprint,
  mintOperationId,
  rejectCallerOperationId,
  createEmitter,
  readAuthoritySnapshot,
  settle,
  refuse,
  cancellationRequested,
} = require('./install-operation');

const ACTIVATION_OPERATIONS = Object.freeze([
  'enable', 'disable', 'set_contribution', 'update_settings', 'quarantine',
]);

function targetStateFor(operation, currentState = DISABLED_ONLY_STATE) {
  if (operation === 'enable') return 'active';
  if (operation === 'disable') return DISABLED_ONLY_STATE;
  if (operation === 'quarantine') return 'quarantined';
  return currentState;
}

function deriveContributionStates(entry, dependencyMap = new Map(), { stage = CONTROL_PLANE_STAGE } = {}) {
  const active = entry.effective_state === 'active';
  const next = entry.contributions.map((item) => ({ ...item }));
  const byId = new Map(next.map((item) => [item.contribution_id, item]));
  for (let pass = 0; pass <= next.length; pass += 1) {
    let changed = false;
    for (const item of next) {
      const dependencyReady = (dependencyMap.get(item.contribution_id) || [])
        .every((id) => byId.get(id)?.effective_enabled === true);
      const mcpPermitted = item.kind !== 'mcp_descriptor' || stage >= 5;
      const effective = active && item.desired_enabled && mcpPermitted && dependencyReady;
      const blockedReason = effective ? 'none'
        : !mcpPermitted ? 'stage_forbidden'
          : !active ? 'master_disabled'
            : !dependencyReady ? 'dependency_disabled' : 'none';
      if (item.effective_enabled !== effective || item.blocked_reason !== blockedReason) changed = true;
      item.effective_enabled = effective;
      item.blocked_reason = blockedReason;
    }
    if (!changed) break;
  }
  return next;
}

function buildCandidatePlugins(plugins, {
  publisherId, pluginId, operation, dependencyMap = new Map(), stage = CONTROL_PLANE_STAGE,
}) {
  const targetState = targetStateFor(operation);
  return plugins.map((entry) => {
    if (entry.publisher_id !== publisherId || entry.plugin_id !== pluginId) return { ...entry };
    const candidate = { ...entry, desired_state: targetState, effective_state: targetState };
    if (Array.isArray(entry.contributions)) {
      candidate.contributions = deriveContributionStates(candidate, dependencyMap, { stage });
    }
    return candidate;
  });
}

function runtimeEnvelope(compiled) {
  return {
    envelope: {
      mode: 'plugin_runtime',
      plugin_runtime: {
        snapshot: compiled.snapshot,
        declarative_content: compiled.declarative_content,
      },
    },
    snapshot: compiled.snapshot,
  };
}

async function runActivationOperation(facade, baseDir, options = {}) {
  const {
    operation,
    publisherId,
    pluginId,
    requireConsent = DENY_CONSENT,
    newOperationId,
    clientRequestId = null,
    safeMode = { active: false, source: 'none' },
    now,
    createdAt = now,
    lifecycleEpoch = 0,
    generationId,
    policyGrantRef,
    dataSchemaRefs = [],
    progressLog = null,
    leaseDurationMs,
    isCanceled = null,
    compileCandidate,
    runtimeCoordinator,
    candidatePluginsFactory = null,
    dependencyMap = new Map(),
    stage = CONTROL_PLANE_STAGE,
  } = options;

  if (stage < 4) {
    return refuse('stage_gate', 'activation_stage_inert', PLUGIN_ERROR_CODES.FEATURE_DISABLED);
  }
  if (!ACTIVATION_OPERATIONS.includes(operation)) {
    return refuse('start', 'activation_operation_invalid', PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  }
  if (!PUBLISHER_ID_RE.test(String(publisherId || '')) || !PLUGIN_ID_RE.test(String(pluginId || ''))) {
    return refuse('start', 'plugin_identity_invalid', PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  }
  if (safeMode && safeMode.active) return safeModeRefusal(safeMode);
  const callerId = rejectCallerOperationId(options);
  if (!callerId.ok) return refuse('start', callerId.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  const minted = mintOperationId(newOperationId);
  if (!minted.ok) return refuse('start', minted.reason, PLUGIN_ERROR_CODES.POLICY_BLOCKED, { detail: minted.detail || null });
  const operationId = minted.operationId;

  const consent = await requireConsent({ operation, publisherId, pluginId, operationId });
  if (cancellationRequested(isCanceled)) {
    return refuse('canceled', 'operation_canceled', PLUGIN_ERROR_CODES.FEATURE_DISABLED, { operationId });
  }
  if (!consent || consent.ok !== true) {
    return refuse('consent', consent?.reason || 'consent_denied', consent?.code || PLUGIN_ERROR_CODES.CONSENT_REQUIRED, { operationId });
  }
  const snapshot = await readAuthoritySnapshot(facade, baseDir, { publisherId, pluginId });
  if (!snapshot.ok) return refuse('read_authority', snapshot.reason, wireCodeFor(snapshot.reason), { operationId });
  if (!snapshot.entry) return refuse('read_authority', 'plugin_not_installed', PLUGIN_ERROR_CODES.POLICY_BLOCKED, { operationId });
  if (typeof compileCandidate !== 'function' || !runtimeCoordinator || typeof runtimeCoordinator.prepare !== 'function') {
    return refuse('runtime', 'runtime_participant_unavailable', PLUGIN_ERROR_CODES.POLICY_BLOCKED, { operationId });
  }

  const targetState = targetStateFor(operation, snapshot.authorityState);
  const requestFingerprint = buildRequestFingerprint({
    operation,
    publisherId,
    pluginId,
    contentDigest: snapshot.entry.artifact_digest,
    clientRequestId,
    lifecycleEpoch,
  });
  const emitter = createEmitter({ operationId, lifecycleEpoch, binding: { commit_epoch: snapshot.commitEpoch }, log: progressLog });
  let candidateResult;
  try {
    candidateResult = typeof candidatePluginsFactory === 'function'
      ? await candidatePluginsFactory(snapshot)
      : buildCandidatePlugins(snapshot.plugins, {
        publisherId, pluginId, operation, dependencyMap, stage,
      });
  } catch (_error) {
    return refuse('compile', 'candidate_plugin_mutation_failed',
      PLUGIN_ERROR_CODES.POLICY_BLOCKED, { operationId });
  }
  if (candidateResult?.ok === false) {
    return refuse('compile', candidateResult.reason || 'candidate_plugin_mutation_invalid',
      candidateResult.code || PLUGIN_ERROR_CODES.POLICY_BLOCKED, { operationId });
  }
  const candidatePlugins = Array.isArray(candidateResult)
    ? candidateResult : candidateResult?.plugins;
  if (!Array.isArray(candidatePlugins)) {
    return refuse('compile', 'candidate_plugin_mutation_invalid', PLUGIN_ERROR_CODES.MANIFEST_INVALID, { operationId });
  }
  for (const entry of candidatePlugins) assertStagePermitsState(entry.effective_state, { stage });

  runtimeCoordinator.fence?.(operation);
  emitter.phase(now, 'preparing');
  let keepFenced = false;
  let priorRuntime = null;
  try {
    const priorCompiled = await compileCandidate({
      generation: snapshot.generation,
      pointer: snapshot.pointer,
      phase: 'prior_committed',
    });
    if (!priorCompiled?.ok) {
      return refuse('compile', priorCompiled?.reason || 'runtime_compile_failed', PLUGIN_ERROR_CODES.INTEGRITY_FAILED, { operationId });
    }
    priorRuntime = runtimeEnvelope(priorCompiled);
    const committed = await runCommitSequence(facade, baseDir, {
      operationId,
      requestFingerprint,
      lifecycleEpoch,
      generationId,
      createdAt,
      plugins: candidatePlugins,
      policyGrantRef,
      dataSchemaRefs,
      now,
      auditAction: operation === 'set_contribution' || operation === 'update_settings' ? 'update' : operation,
      auditActor: operation === 'quarantine'
        ? { kind: 'system', component: 'supervisor' } : { kind: 'user' },
      participantPrepare: async ({ generation, next_pointer: nextPointer }) => {
        const compiled = await compileCandidate({ generation, pointer: nextPointer, phase: 'candidate' });
        if (!compiled?.ok) return { ok: false, reason: compiled?.reason || 'runtime_compile_failed' };
        return runtimeCoordinator.prepare({ compiled, priorRuntime });
      },
      isCanceled,
      controlPlaneStage: stage,
      generationSchemaVersion: snapshot.generation.generation_schema_version,
      ...(snapshot.generation.lock_digest
        ? { lockDigest: snapshot.generation.lock_digest } : {}),
      ...(snapshot.generation.distribution_state_digest
        ? { distributionStateDigest: snapshot.generation.distribution_state_digest } : {}),
      ...(leaseDurationMs === undefined ? {} : { leaseDurationMs }),
    });
    keepFenced = committed.detail?.requiresReconciliation === true
      || committed.requiresReconciliation === true;
    const authorityStateBefore = snapshot.authorityState;
    if (!committed.ok) {
      const landed = committed.committed === true;
      const committedState = landed ? targetState : authorityStateBefore;
      emitter.terminal(now, landed ? 'indeterminate' : 'failed', false, committed.pointer?.generation_digest);
      return settle('commit', false, {
        operationId,
        requestFingerprint,
        status: landed ? 'indeterminate' : 'failed',
        authorityStateBefore,
        authorityStateAfter: committedState,
        authorityStateCommitted: committedState,
        cleanupStatus: 'not_required',
        cleanupTarget: landed ? { kind: 'generation', generation_id: committed.generationId } : { kind: DISABLED_ONLY_STATE },
        settledAt: now,
        failureReason: committed.reason,
      }, {
        operationId,
        wireCode: landed ? PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE : (wireCodeFor(committed.reason) || PLUGIN_ERROR_CODES.POLICY_BLOCKED),
        committed: landed,
        commitReason: committed.reason,
        requiresReconciliation: keepFenced,
      });
    }
    emitter.terminal(now, 'committed', false, committed.pointer.generation_digest);
    return settle('commit', true, {
      operationId,
      requestFingerprint,
      status: 'committed',
      authorityStateBefore,
      authorityStateAfter: targetState,
      authorityStateCommitted: targetState,
      cleanupStatus: 'not_required',
      cleanupTarget: { kind: 'generation', generation_id: committed.generationId },
      settledAt: now,
    }, {
      operationId,
      committed: true,
      requestedState: targetState,
      committedState: targetState,
      commitEpoch: committed.commitEpoch,
      revision: committed.revision,
      generationId: committed.generationId,
      attestation: committed.participant,
      progress: emitter.log,
    });
  } catch (_error) {
    keepFenced = true;
    emitter.terminal(now, 'indeterminate', false);
    return refuse(
      'runtime',
      'runtime_mutation_indeterminate',
      PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE,
      { operationId, requiresReconciliation: true }
    );
  } finally {
    if (!keepFenced) {
      try {
        runtimeCoordinator.unfence?.();
      } catch (_error) {
        // The committed/runtime authority remains safe; status stays fenced.
      }
    }
  }
}

module.exports = {
  ACTIVATION_OPERATIONS,
  targetStateFor,
  buildCandidatePlugins,
  deriveContributionStates,
  runActivationOperation,
};
