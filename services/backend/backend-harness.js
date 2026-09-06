const { API_VERSION } = require('./sidecar-client');

function buildEmptyHarnessSnapshot(options = {}) {
  return {
    generated_at: null,
    sections: [],
    filters: {
      include_recent_history: options?.include_recent_history !== false,
      recent_history_limit: Number.isInteger(options?.recent_history_limit) ? options.recent_history_limit : 5,
      include_disabled: options?.include_disabled !== false,
    },
    tools: { items: [], counts: { total: 0, enabled: 0, disabled: 0 } },
    memories: { approved: [], pending: [], counts: { approved: 0, pending: 0, provenance: { user_approved: 0, automatic: 0, unknown_legacy: 0 } } },
    skills: { items: [], scopes: [], counts: { total: 0, bundled: 0, user: 0, project: 0 } },
    runtime: {},
    workspace: { blockers: [] },
    shell: {},
  };
}

async function inspectHarness(service, options = {}) {
  if (!service.sidecarClient) {
    service._emitServiceLog('INFO', 'harness.inspect_skipped', {
      reason: 'sidecar_unavailable',
    });
    return buildEmptyHarnessSnapshot(options);
  }
  const phase = typeof service.sidecarManager?.getStatus === 'function'
    ? String(service.sidecarManager.getStatus()?.phase || '').trim().toLowerCase()
    : 'ready';
  if (phase !== 'ready') {
    service._emitServiceLog('INFO', 'harness.inspect_skipped', {
      reason: 'sidecar_not_ready',
      phase,
    });
    return buildEmptyHarnessSnapshot(options);
  }
  return service.sidecarClient.request('harness.inspect', {
    accept_version: API_VERSION,
    ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
  });
}

module.exports = {
  inspectHarness,
};
