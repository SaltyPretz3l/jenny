'use strict';

function authorityKey(authority = {}) {
  return `${authority.active_generation_id || ''}\0${authority.commit_epoch || ''}\0${authority.registry_revision || ''}\0${authority.dependency_graph_hash || ''}`;
}

class NativeMcpRuntimeRegistry {
  constructor({ currentAuthority, acquireSession, releaseSession = null, invoke } = {}) {
    this._current = currentAuthority;
    this._acquire = acquireSession;
    this._release = releaseSession;
    this._invoke = invoke;
    this._bindings = new Map();
  }

  publish(authority, bindings = []) {
    const key = authorityKey(authority);
    const tools = new Map();
    for (const binding of bindings) {
      for (const tool of binding.tools || []) {
        if (tools.has(tool.namespaced_name)) return { ok: false, reason: 'native_mcp_tool_collision' };
        tools.set(tool.namespaced_name, Object.freeze({ binding, tool }));
      }
    }
    this._bindings.set(key, tools);
    return { ok: true, tool_count: tools.size };
  }

  clear() { this._bindings.clear(); }

  async invoke({ authority, toolName, arguments: args, signal }) {
    if (authorityKey(await this._current()) !== authorityKey(authority)) {
      return { ok: false, reason: 'native_mcp_authority_stale' };
    }
    const descriptor = this._bindings.get(authorityKey(authority))?.get(toolName);
    if (!descriptor) return { ok: false, reason: 'native_mcp_tool_not_found' };
    const session = await this._acquire(descriptor.binding, authority, signal);
    if (!session?.ok) return session;
    const active = session.session || session;
    if (authorityKey(await this._current()) !== authorityKey(authority)) {
      try { await this._release?.(descriptor.binding, authority, active); }
      catch (_error) { /* stale dispatch remains denied even when cleanup is deferred */ }
      return { ok: false, reason: 'native_mcp_authority_stale' };
    }
    const proof = { launch_receipt_id: active.launch_receipt_id, session_epoch: active.session_epoch };
    const result = await this._invoke({ descriptor, args, authority, proof, session: active, signal });
    if (authorityKey(await this._current()) !== authorityKey(authority)) {
      return { ok: false, reason: 'native_mcp_authority_stale' };
    }
    if (result?.proof?.launch_receipt_id !== proof.launch_receipt_id
      || result?.proof?.session_epoch !== proof.session_epoch) {
      return { ok: false, reason: 'native_mcp_session_proof_rejected' };
    }
    return result;
  }
}

module.exports = { authorityKey, NativeMcpRuntimeRegistry };
