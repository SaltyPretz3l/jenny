'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');

class SessionProviderManager {
  constructor({ isAuthorityCurrent = () => true } = {}) {
    this._bindings = new Map();
    this._isCurrent = isAuthorityCurrent;
  }

  publish(authority, descriptors = []) {
    if (!this._isCurrent(authority)) return { ok: false, reason: 'managed_policy_authority_stale' };
    const key = this._key(authority);
    const next = new Map();
    for (const descriptor of descriptors) {
      const bindingKey = this._descriptorKey(descriptor);
      if (!bindingKey || next.has(bindingKey)) {
        return { ok: false, reason: 'session_provider_descriptor_rejected' };
      }
      next.set(bindingKey, Object.freeze({ ...descriptor }));
    }
    this._bindings.set(key, next);
    return { ok: true, count: next.size };
  }

  resolve(authority, identity, { requireContractV1 = false } = {}) {
    if (!this._isCurrent(authority)) return { ok: false, reason: 'managed_policy_authority_stale' };
    const key = this._key(authority);
    const requested = typeof identity === 'string'
      ? { contribution_id: identity } : (identity || {});
    const exactKey = this._descriptorKey(requested);
    let descriptor = exactKey ? this._bindings.get(key)?.get(exactKey) : null;
    if (!descriptor && requested.contribution_id
      && !requested.publisher_id && !requested.plugin_id) {
      const matches = [...(this._bindings.get(key)?.values() || [])].filter(
        (item) => item.contribution_id === requested.contribution_id
      );
      if (matches.length > 1) return { ok: false, reason: 'session_provider_ambiguous' };
      [descriptor] = matches;
    }
    if (!descriptor) return { ok: false, reason: 'session_provider_not_found' };
    if (requireContractV1) {
      const checked = validate('PluginSessionProviderDescriptorV1', descriptor);
      if (!checked.ok) return { ok: false, reason: 'session_provider_contract_incompatible' };
      return { ok: true, descriptor: checked.value };
    }
    return { ok: true, descriptor };
  }

  revokeGeneration(generationId) {
    for (const key of this._bindings.keys()) if (key.startsWith(`${generationId}\0`)) this._bindings.delete(key);
  }

  clear() { this._bindings.clear(); }

  _key(authority) {
    return `${authority.active_generation_id}\0${authority.commit_epoch}`
      + `\0${authority.registry_revision}\0${authority.dependency_graph_hash}`;
  }

  _descriptorKey(value = {}) {
    const publisherId = String(value.publisher_id || value.publisherId || '').trim();
    const pluginId = String(value.plugin_id || value.pluginId || '').trim();
    const contributionId = String(value.contribution_id || value.contributionId || '').trim();
    return publisherId && pluginId && contributionId
      ? `${publisherId}\0${pluginId}\0${contributionId}` : '';
  }
}

module.exports = { SessionProviderManager };
