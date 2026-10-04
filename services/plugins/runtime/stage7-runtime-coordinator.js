'use strict';

const { runtimeEnvelope } = require('./runtime-envelope');

function createStage7RuntimeCoordinator({ runtimeCoordinator, viewAuthority } = {}) {
  if (!runtimeCoordinator || !viewAuthority) {
    throw new TypeError('stage7 coordinator requires sidecar and view participants');
  }

  async function prepare({ compiled, priorRuntime }) {
    const view = viewAuthority.prepare(compiled);
    if (!view.ok) return view;
    const runtime = await runtimeCoordinator.prepare({ compiled, priorRuntime });
    if (!runtime.ok) return runtime;
    return {
      ...runtime,
      commit: async () => {
        const runtimeCommitted = typeof runtime.commit === 'function'
          ? await runtime.commit() : { ok: true };
        if (!runtimeCommitted?.ok) return runtimeCommitted;
        const viewCommitted = await viewAuthority.commit(view.prepared);
        return viewCommitted.ok ? { ok: true, degraded: false } : viewCommitted;
      },
    };
  }

  return Object.freeze({
    prepare,
    reconcileCompiled: async (compiled, reason) => {
      const view = viewAuthority.prepare(compiled);
      if (!view.ok) return view;
      await viewAuthority.hide('generation_reconcile');
      // The sidecar participant reconciles an envelope, not compiled content.
      const sidecar = typeof runtimeCoordinator.reconcile === 'function'
        ? await runtimeCoordinator.reconcile(runtimeEnvelope(compiled), reason) : null;
      if (!sidecar?.ok) return sidecar || { ok: false, reason: 'runtime_reconcile_unavailable' };
      const viewResult = await viewAuthority.commit(view.prepared);
      return viewResult.ok ? { ok: true } : viewResult;
    },
    reconcile: (runtime, reason) => runtimeCoordinator.reconcile(runtime, reason),
    fence: (reason) => runtimeCoordinator.fence?.(reason),
    unfence: () => runtimeCoordinator.unfence?.(),
    degrade: (reason) => runtimeCoordinator.degrade?.(reason),
    getState: () => ({ ...runtimeCoordinator.getState?.(),
      view_runtime: viewAuthority.snapshot() }),
    detach: () => runtimeCoordinator.detach?.(),
  });
}

module.exports = { createStage7RuntimeCoordinator };
