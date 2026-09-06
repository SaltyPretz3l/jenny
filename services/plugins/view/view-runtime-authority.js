'use strict';

function refusal(reason) { return { ok: false, reason }; }
function keyOf(value) { return `${value.publisher_id}/${value.plugin_id}/${value.contribution_id}`; }

class PluginViewRuntimeAuthority {
  constructor({ host, log = () => {} } = {}) {
    if (!host || typeof host.commitGeneration !== 'function' || typeof host.destroyAll !== 'function') {
      throw new TypeError('plugin view authority requires a host');
    }
    this.host = host;
    this.log = log;
    this.current = null;
    this.disposed = false;
    this.authorityEpoch = 0;
    this.inFlightCommits = new Set();
  }

  prepare(compiled) {
    if (this.disposed) return refusal('view_authority_disposed');
    const snapshot = compiled?.snapshot;
    if (!Number.isSafeInteger(snapshot?.runtime_schema_version)) {
      return refusal('view_runtime_snapshot_invalid');
    }
    // Generations installed under V1-V4 remain valid after the store upgrades
    // to V5. They simply attest an empty Stage 7 view participant.
    if (snapshot.runtime_schema_version < 5) {
      return { ok: true, prepared: Object.freeze({
        generation_id: snapshot.active_generation_id,
        commit_epoch: snapshot.commit_epoch,
        descriptors: new Map(),
        assets: new Map(),
      }) };
    }
    if (snapshot.runtime_schema_version > 6) return refusal('view_runtime_snapshot_invalid');
    const views = Array.isArray(compiled.view_descriptors) ? compiled.view_descriptors : [];
    const descriptors = new Map();
    for (const view of views) {
      if (descriptors.has(keyOf(view))) return refusal('view_contribution_duplicate');
      descriptors.set(keyOf(view), view);
    }
    return { ok: true, prepared: Object.freeze({
      generation_id: snapshot.active_generation_id,
      commit_epoch: snapshot.commit_epoch,
      registry_revision: snapshot.registry_revision,
      dependency_graph_hash: snapshot.dependency_graph_hash,
      descriptors,
      assets: compiled.view_assets instanceof Map ? new Map(compiled.view_assets) : new Map(),
    }) };
  }

  async commit(prepared) {
    if (this.disposed) return refusal('view_authority_disposed');
    const epoch = this.authorityEpoch;
    const pending = this.host.commitGeneration(prepared);
    this.inFlightCommits.add(pending);
    let settled;
    try {
      settled = await pending;
    } finally {
      this.inFlightCommits.delete(pending);
    }
    if (this.disposed || epoch !== this.authorityEpoch) return refusal('view_authority_disposed');
    if (!settled?.ok) return refusal(settled?.reason || 'view_host_commit_failed');
    this.current = prepared;
    return { ok: true };
  }

  findDescriptor(identity) {
    if (!this.current || identity?.generation_id !== this.current.generation_id) return null;
    if (identity?.commit_epoch !== undefined
      && identity.commit_epoch !== this.current.commit_epoch) return null;
    return this.current.descriptors.get(keyOf(identity)) || null;
  }

  snapshot() {
    return {
      generation_id: this.current?.generation_id || null,
      commit_epoch: this.current?.commit_epoch || 0,
      active_views: this.current?.descriptors.size || 0,
    };
  }

  async hide(reason = 'generation_transition') {
    await this.host.destroyAll(reason);
    return { ok: true };
  }

  async dispose(reason = 'shutdown') {
    if (this.disposed) return;
    this.disposed = true;
    this.authorityEpoch += 1;
    this.current = null;
    await Promise.allSettled([...this.inFlightCommits]);
    await this.host.destroyAll(reason);
  }
}

module.exports = { PluginViewRuntimeAuthority };
