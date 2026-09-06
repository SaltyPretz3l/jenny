'use strict';

const { runActivationOperation } = require('../lifecycle/activation-operation');
const { readCommittedState } = require('../lifecycle/commit-sequence');
const { compileCurrentRuntimeSnapshot } = require('./declarative-compiler');

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

function requiresReconciliation(outcome) {
  return outcome?.requiresReconciliation === true
    || outcome?.detail?.requiresReconciliation === true
    || outcome?.result?.requires_reconciliation === true;
}

function createMutationSerializer(gate) {
  let tail = Promise.resolve();
  return function serializeMutation(body) {
    const predecessor = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    return predecessor.then(async () => {
      try {
        const gated = gate();
        return gated.ok ? await body() : gated;
      } finally {
        release();
      }
    });
  };
}

function createControlPlaneRuntime({
  facade,
  baseDir,
  verifyPackage,
  runtimeCoordinator,
  now,
  remoteMcpRuntime = null,
  privilegedRuntime = null,
} = {}) {
  const compileCandidate = ({ generation, pointer, phase }) => compileCurrentRuntimeSnapshot({
    facade,
    baseDir,
    generation,
    pointer,
    verifyPackage,
    now: now(),
    remoteMcpRuntime,
    compilePrivileged: privilegedRuntime?.compile,
    phase,
  });

  async function validateRecoveryCandidate({ generation, pointer }) {
    const compiled = await compileCandidate({ generation, pointer });
    return compiled.ok
      ? { ok: true }
      : { ok: false, reason: compiled.reason || 'runtime_compile_failed' };
  }

  async function rehydrate({ generation, pointer }) {
    if (!runtimeCoordinator) return { ok: false, reason: 'runtime_participant_unavailable' };
    const compiled = await compileCandidate({ generation, pointer });
    if (!compiled.ok) {
      runtimeCoordinator.degrade?.(compiled.reason || 'runtime_compile_failed');
      return compiled;
    }
    runtimeCoordinator.fence?.('rehydration');
    try {
      const result = typeof runtimeCoordinator.reconcileCompiled === 'function'
        ? await runtimeCoordinator.reconcileCompiled(compiled, 'restart_rehydration')
        : await runtimeCoordinator.reconcile(runtimeEnvelope(compiled), 'restart_rehydration');
      if (!result.ok) runtimeCoordinator.degrade?.(result.reason || 'runtime_rehydration_failed');
      return result;
    } finally {
      runtimeCoordinator.unfence?.();
    }
  }

  function activate(options) {
    return runActivationOperation(facade, baseDir, {
      ...options,
      compileCandidate,
      runtimeCoordinator,
      ...(options.candidatePluginsFactory || !remoteMcpRuntime
        ? {}
        : {
          candidatePluginsFactory: (snapshot) => remoteMcpRuntime.prepareCandidatePlugins({
            snapshot,
            operation: options.operation,
            publisherId: options.publisherId,
            pluginId: options.pluginId,
            generationId: options.generationId,
            commitEpoch: (snapshot.pointer?.commit_epoch || 0) + 1,
            dependencyMap: options.dependencyMap,
            stage: options.stage,
          }),
        }),
    });
  }

  async function activeUninstallParticipant({ generation, pointer }) {
    if (!runtimeCoordinator) return { ok: false, reason: 'runtime_participant_unavailable' };
    const priorCompiled = await compileCandidate({ generation, pointer });
    if (!priorCompiled.ok) return priorCompiled;
    const priorRuntime = runtimeEnvelope(priorCompiled);
    runtimeCoordinator.fence?.('uninstall');
    return {
      ok: true,
      participantPrepare: async ({ generation: candidate, next_pointer: nextPointer }) => {
        const compiled = await compileCandidate({ generation: candidate, pointer: nextPointer });
        if (!compiled.ok) return compiled;
        return runtimeCoordinator.prepare({ compiled, priorRuntime });
      },
      finish(outcome) {
        if (!requiresReconciliation(outcome)) runtimeCoordinator.unfence?.();
      },
    };
  }

  async function distributionParticipant() {
    if (!runtimeCoordinator) return { ok: false, reason: 'runtime_participant_unavailable' };
    const committed = await readCommittedState(facade, baseDir);
    let priorRuntime = null;
    if (committed.generation && committed.pointer) {
      const priorCompiled = await compileCandidate({
        generation: committed.generation,
        pointer: committed.pointer,
      });
      if (!priorCompiled.ok) return priorCompiled;
      priorRuntime = runtimeEnvelope(priorCompiled);
    }
    return {
      ok: true,
      participantPrepare: async ({ generation, next_pointer: nextPointer }) => {
        const compiled = await compileCandidate({ generation, pointer: nextPointer });
        if (!compiled.ok) return compiled;
        return runtimeCoordinator.prepare({ compiled, priorRuntime });
      },
    };
  }

  function state() {
    return runtimeCoordinator?.getState?.() || {
      runtime_status: 'inactive',
      runtime_reason_code: 'runtime_participant_unavailable',
    };
  }

  function dispose() {
    runtimeCoordinator?.detach?.();
  }

  return Object.freeze({
    activate,
    activeUninstallParticipant,
    distributionParticipant,
    compileCandidate,
    validateRecoveryCandidate,
    rehydrate,
    state,
    dispose,
  });
}

module.exports = {
  runtimeEnvelope,
  requiresReconciliation,
  createMutationSerializer,
  createControlPlaneRuntime,
};
