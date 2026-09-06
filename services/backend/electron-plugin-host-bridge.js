'use strict';

const OPERATIONS = new Set(['start', 'stream_ack', 'cancel', 'close']);

function createElectronPluginHostBridge({ currentAuthority, streamBroker } = {}) {
  return async function onPluginHostRequest(params = {}) {
    if (!OPERATIONS.has(params.operation)) return { ok: false, reason: 'plugin_host_operation_rejected' };
    const authority = params.authority;
    const current = await currentAuthority();
    if (!authority || authority.active_generation_id !== current.active_generation_id
      || authority.commit_epoch !== current.commit_epoch
      || authority.registry_revision !== current.registry_revision
      || authority.dependency_graph_hash !== current.dependency_graph_hash) {
      return { ok: false, reason: 'plugin_host_authority_stale' };
    }
    if (params.operation === 'start') return streamBroker.start(params);
    if (params.operation === 'stream_ack') return streamBroker.acknowledge(params);
    if (params.operation === 'cancel') return streamBroker.cancel(params);
    return streamBroker.cancel({ ...params, reason: 'closed' });
  };
}

module.exports = { createElectronPluginHostBridge };
