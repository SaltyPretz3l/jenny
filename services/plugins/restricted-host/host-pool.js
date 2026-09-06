'use strict';

const MAX_HOSTS_GLOBAL = 4;
const MAX_HOSTS_PER_PLUGIN = 1;

function hostKey(descriptor) { return `${descriptor.publisher_id}\0${descriptor.plugin_id}\0${descriptor.contribution_id}\0${descriptor.generation_id}\0${descriptor.commit_epoch}`; }
function pluginKey(descriptor) { return `${descriptor.publisher_id}\0${descriptor.plugin_id}`; }

class RestrictedHostPool {
  constructor({ supervisor, loadComponentBytes, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this._supervisor = supervisor; this._loadComponentBytes = loadComponentBytes;
    this._wait = wait;
    this._hosts = new Map(); this._starting = new Map();
    this._revokedGenerations = new Set(); this._disposed = false;
  }

  async acquire(descriptor) {
    if (this._disposed) return { ok: false, reason: 'restricted_host_pool_disposed' };
    if (this._revokedGenerations.has(descriptor.generation_id)) {
      return { ok: false, reason: 'restricted_generation_revoked' };
    }
    const key = hostKey(descriptor);
    const existing = this._hosts.get(key);
    if (existing && existing.alive !== false) return { ok: true, host: existing, reused: true };
    this._hosts.delete(key);
    const restartDelayMs = Number.isInteger(existing?.restart_delay_ms)
      ? existing.restart_delay_ms : 0;
    if (this._starting.has(key)) return this._starting.get(key).promise;
    if (this._hosts.size + this._starting.size >= MAX_HOSTS_GLOBAL) return { ok: false, reason: 'restricted_host_global_limit' };
    const perPlugin = [...this._hosts.keys(), ...this._starting.keys()]
      .filter((candidate) => candidate.startsWith(`${pluginKey(descriptor)}\0`)).length;
    if (perPlugin >= MAX_HOSTS_PER_PLUGIN) return { ok: false, reason: 'restricted_host_plugin_limit' };
    const controller = new AbortController();
    const record = { descriptor, controller, promise: null };
    const start = (async () => {
      if (restartDelayMs > 0) await this._wait(restartDelayMs);
      if (this._disposed || controller.signal.aborted
        || this._revokedGenerations.has(descriptor.generation_id)) {
        return { ok: false, reason: this._disposed
          ? 'restricted_host_pool_disposed' : 'restricted_generation_revoked' };
      }
      const component = await this._loadComponentBytes(descriptor);
      if (!component?.ok || !Buffer.isBuffer(component.bytes)) return { ok: false, reason: component?.reason || 'restricted_component_unavailable' };
      if (controller.signal.aborted || this._revokedGenerations.has(descriptor.generation_id)) {
        return { ok: false, reason: 'restricted_generation_revoked' };
      }
      const result = await this._supervisor.start(
        descriptor, component.bytes, { signal: controller.signal }
      );
      if (result.ok && (controller.signal.aborted
        || this._revokedGenerations.has(descriptor.generation_id))) {
        await result.host.shutdown();
        return { ok: false, reason: 'restricted_generation_revoked' };
      }
      if (result.ok) this._hosts.set(key, result.host);
      return result;
    })().finally(() => this._starting.delete(key));
    record.promise = start;
    this._starting.set(key, record);
    return start;
  }

  async invalidate(descriptor) {
    const key = hostKey(descriptor); const host = this._hosts.get(key);
    this._hosts.delete(key); if (host) await host.shutdown();
  }

  async revokeGeneration(generationId) {
    this._revokedGenerations.add(generationId);
    const starting = [...this._starting.values()]
      .filter((record) => record.descriptor.generation_id === generationId);
    for (const record of starting) record.controller.abort();
    const matches = [...this._hosts].filter(([, host]) => host.identity.generation_id === generationId);
    for (const [key, host] of matches) { this._hosts.delete(key); await host.shutdown(); }
    return matches.length + starting.length;
  }

  snapshot() { return { active_hosts: this._hosts.size, starting_hosts: this._starting.size }; }
  async dispose() { this._disposed = true; for (const record of this._starting.values()) record.controller.abort(); await Promise.all([...this._hosts.values()].map((host) => host.shutdown())); this._hosts.clear(); await this._supervisor.dispose(); }
}

module.exports = { MAX_HOSTS_GLOBAL, MAX_HOSTS_PER_PLUGIN, hostKey, RestrictedHostPool };
