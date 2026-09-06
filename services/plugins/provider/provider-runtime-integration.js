'use strict';

class PluginProviderRuntimeIntegration {
  constructor({ onChanged = () => {}, log = () => {} } = {}) {
    this.onChanged = onChanged;
    this.log = log;
    this.current = null;
    this.descriptors = new Map();
  }

  prepare(compiled) {
    const version = compiled?.snapshot?.runtime_schema_version;
    if (!Number.isSafeInteger(version)) {
      return { ok: false, reason: 'provider_runtime_snapshot_invalid' };
    }
    if (version < 5) {
      return { ok: true, prepared: Object.freeze({
        generation_id: compiled.snapshot.active_generation_id,
        commit_epoch: compiled.snapshot.commit_epoch,
        descriptors: new Map(),
      }) };
    }
    if (version > 6) return { ok: false, reason: 'provider_runtime_snapshot_invalid' };
    const byId = new Map();
    for (const item of compiled.provider_descriptor_values || []) {
      if (byId.has(item.provider_id)) return { ok: false, reason: 'provider_id_duplicate' };
      byId.set(item.provider_id, item);
    }
    return { ok: true, prepared: Object.freeze({
      generation_id: compiled.snapshot.active_generation_id,
      commit_epoch: compiled.snapshot.commit_epoch,
      registry_revision: compiled.snapshot.registry_revision,
      dependency_graph_hash: compiled.snapshot.dependency_graph_hash,
      descriptors: byId,
    }) };
  }

  async commit(prepared) {
    this.current = { generation_id: prepared.generation_id, commit_epoch: prepared.commit_epoch,
      registry_revision: prepared.registry_revision,
      dependency_graph_hash: prepared.dependency_graph_hash };
    this.descriptors = new Map(prepared.descriptors);
    try { await this.onChanged(this.snapshot()); } catch (_error) {
      this.log('plugin.provider.reconfigure_failed', { reason_code: 'provider_reconfigure_failed' });
      return { ok: true, degraded: true };
    }
    return { ok: true };
  }

  resolve(providerId, authority = {}) {
    if (!this.current || authority.commit_epoch !== this.current.commit_epoch
      || (authority.generation_id && authority.generation_id !== this.current.generation_id)) return null;
    return this.descriptors.get(providerId) || null;
  }

  snapshot() {
    return { generation_id: this.current?.generation_id || null,
      commit_epoch: this.current?.commit_epoch || 0, providers: [...this.descriptors.keys()].sort() };
  }

  dispose() { this.current = null; this.descriptors.clear(); }
}

module.exports = { PluginProviderRuntimeIntegration };
