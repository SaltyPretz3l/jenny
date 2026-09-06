'use strict';

class NativeMcpInvocationBroker {
  constructor({ registry, maxPendingGlobal = 32, maxPendingPerContribution = 8 } = {}) {
    this._registry = registry;
    this._global = maxPendingGlobal;
    this._per = maxPendingPerContribution;
    this._pending = 0;
    this._byContribution = new Map();
  }

  async invoke(request) {
    const key = String(request?.contributionId || request?.toolName || 'unknown');
    const count = this._byContribution.get(key) || 0;
    if (this._pending >= this._global || count >= this._per) return { ok: false, reason: 'native_mcp_queue_full' };
    this._pending += 1;
    this._byContribution.set(key, count + 1);
    try { return await this._registry.invoke(request); }
    catch (_error) { return { ok: false, reason: 'native_mcp_invocation_failed' }; }
    finally {
      this._pending -= 1;
      const next = (this._byContribution.get(key) || 1) - 1;
      if (next) this._byContribution.set(key, next); else this._byContribution.delete(key);
    }
  }
}

module.exports = { NativeMcpInvocationBroker };
