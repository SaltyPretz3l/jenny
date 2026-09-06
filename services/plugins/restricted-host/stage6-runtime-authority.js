'use strict';

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');

function refusal(reason, retryable = false) {
  return { ok: false, code: PLUGIN_ERROR_CODES.POLICY_BLOCKED, reason, retryable };
}

function descriptorName(descriptor) {
  return String(descriptor?.namespaced_name || '');
}

class Stage6RuntimeAuthority {
  constructor({ diagnostics = null } = {}) {
    this._diagnostics = diagnostics;
    this._controller = null;
    this._generation = null;
    this._descriptors = new Map();
    this._components = new Map();
    this._disposed = false;
  }

  bindInvocationController(controller) {
    if (this._controller && this._controller !== controller) {
      throw new Error('stage6_invocation_controller_already_bound');
    }
    this._controller = controller;
  }

  prepare(compiled) {
    const runtimeVersion = compiled?.snapshot?.runtime_schema_version;
    const legacySnapshot = Number.isInteger(runtimeVersion) && runtimeVersion >= 1 && runtimeVersion <= 3;
    const descriptors = legacySnapshot ? [] : compiled?.restricted_descriptors;
    const components = legacySnapshot ? new Map() : compiled?.restricted_components;
    // Stage 7 composes this restricted-host participant with the view/provider
    // participants, so a V5 snapshot still has to publish (or explicitly
    // withdraw) its restricted contribution set. Future contracts remain
    // fail-closed until their owning stage updates this bound.
    if (!Number.isInteger(runtimeVersion) || runtimeVersion < 1 || runtimeVersion > 6
      || !Array.isArray(descriptors) || !(components instanceof Map)) {
      return refusal('restricted_runtime_compile_result_invalid');
    }
    const byName = new Map();
    const componentCopies = new Map();
    for (const descriptor of descriptors) {
      const name = descriptorName(descriptor);
      const bytes = components.get(descriptor?.component_digest);
      if (!name || byName.has(name) || !Buffer.isBuffer(bytes)) {
        return refusal('restricted_runtime_compile_result_invalid');
      }
      byName.set(name, descriptor);
      componentCopies.set(descriptor.component_digest, Buffer.from(bytes));
    }
    return {
      ok: true,
      prepared: Object.freeze({
        generation_id: compiled.snapshot.active_generation_id,
        commit_epoch: compiled.snapshot.commit_epoch,
        registry_revision: compiled.snapshot.registry_revision,
        dependency_graph_hash: compiled.snapshot.dependency_graph_hash,
        descriptors: byName,
        components: componentCopies,
      }),
    };
  }

  async commit(prepared) {
    if (this._disposed || !prepared?.descriptors || !prepared?.components) {
      return refusal('restricted_runtime_authority_disposed');
    }
    const priorGeneration = this._generation;
    this._generation = Object.freeze({
      generation_id: prepared.generation_id,
      commit_epoch: prepared.commit_epoch,
      registry_revision: prepared.registry_revision,
      dependency_graph_hash: prepared.dependency_graph_hash,
    });
    this._descriptors = prepared.descriptors;
    this._components = prepared.components;
    if (priorGeneration?.generation_id
      && priorGeneration.generation_id !== this._generation.generation_id) {
      try {
        await this._controller?.revokeGeneration?.(priorGeneration.generation_id);
      } catch (_error) {
        this._diagnostics?.record('WARN', 'prior_generation_cleanup_failed', {}, {
          reason_code: 'restricted_prior_generation_cleanup_failed',
        });
      }
    }
    this._diagnostics?.record('INFO', 'authority_published', {}, {
      active_contributions: this._descriptors.size,
      commit_epoch: this._generation.commit_epoch,
    });
    return { ok: true };
  }

  currentForDescriptor(descriptor, invocation = {}) {
    const current = this._descriptors.get(descriptorName(descriptor));
    if (!current || current !== descriptor || this._disposed) return null;
    return {
      ...current,
      lifecycle_state: 'active',
      stage6_enabled: true,
      revoked: false,
      quarantined: false,
      revocation_generation: this._generation?.commit_epoch || 0,
      argument_hash: invocation.argument_hash,
    };
  }

  loadComponentBytes(descriptor) {
    const current = this._descriptors.get(descriptorName(descriptor));
    const bytes = current === descriptor
      ? this._components.get(descriptor.component_digest) : null;
    return Buffer.isBuffer(bytes)
      ? { ok: true, bytes: Buffer.from(bytes) }
      : refusal('restricted_component_unavailable');
  }

  execute(toolName, args, context = {}) {
    if (this._disposed || !this._controller) return refusal('restricted_runtime_unavailable');
    const descriptor = this._descriptors.get(String(toolName || ''));
    if (!descriptor) return refusal('restricted_tool_unknown');
    return this._controller.invoke(descriptor, args, context);
  }

  snapshot() {
    return {
      generation_id: this._generation?.generation_id || null,
      commit_epoch: this._generation?.commit_epoch || 0,
      active_contributions: this._descriptors.size,
    };
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._descriptors = new Map();
    this._components = new Map();
    this._generation = null;
    await this._controller?.dispose?.();
  }
}

function createStage6RuntimeCoordinator({ runtimeCoordinator, restrictedAuthority } = {}) {
  if (!runtimeCoordinator || !restrictedAuthority) {
    throw new TypeError('stage6 runtime coordinator requires both participants');
  }

  async function prepare({ compiled, priorRuntime }) {
    const local = restrictedAuthority.prepare(compiled);
    if (!local.ok) return local;
    const sidecar = await runtimeCoordinator.prepare({ compiled, priorRuntime });
    if (!sidecar.ok) return sidecar;
    return {
      ...sidecar,
      commit: async () => {
        const settled = typeof sidecar.commit === 'function'
          ? await sidecar.commit() : { ok: true };
        if (!settled?.ok) return settled;
        return restrictedAuthority.commit(local.prepared);
      },
    };
  }

  async function reconcileCompiled(compiled, reason) {
    const local = restrictedAuthority.prepare(compiled);
    if (!local.ok) return local;
    const envelope = {
      mode: 'plugin_runtime',
      plugin_runtime: {
        snapshot: compiled.snapshot,
        declarative_content: compiled.declarative_content,
      },
    };
    const sidecar = await runtimeCoordinator.reconcile(
      { envelope, snapshot: compiled.snapshot },
      reason
    );
    if (!sidecar.ok) return sidecar;
    const committed = await restrictedAuthority.commit(local.prepared);
    return committed.ok ? sidecar : committed;
  }

  return Object.freeze({
    prepare,
    reconcileCompiled,
    reconcile: (runtime, reason) => runtimeCoordinator.reconcile(runtime, reason),
    fence: (reason) => runtimeCoordinator.fence?.(reason),
    unfence: () => runtimeCoordinator.unfence?.(),
    degrade: (reason) => runtimeCoordinator.degrade?.(reason),
    getState: () => ({
      ...runtimeCoordinator.getState?.(),
      restricted_runtime: restrictedAuthority.snapshot(),
    }),
    detach: () => runtimeCoordinator.detach?.(),
  });
}

module.exports = {
  Stage6RuntimeAuthority,
  createStage6RuntimeCoordinator,
};
