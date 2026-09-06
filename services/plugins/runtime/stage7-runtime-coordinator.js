'use strict';

function createStage7RuntimeCoordinator({ runtimeCoordinator, viewAuthority, providerRuntime } = {}) {
  if (!runtimeCoordinator || !viewAuthority || !providerRuntime) {
    throw new TypeError('stage7 coordinator requires sidecar, view, and provider participants');
  }

  async function prepare({ compiled, priorRuntime }) {
    const view = viewAuthority.prepare(compiled);
    if (!view.ok) return view;
    const provider = providerRuntime.prepare(compiled);
    if (!provider.ok) return provider;
    const runtime = await runtimeCoordinator.prepare({ compiled, priorRuntime });
    if (!runtime.ok) return runtime;
    return {
      ...runtime,
      commit: async () => {
        const runtimeCommitted = typeof runtime.commit === 'function'
          ? await runtime.commit() : { ok: true };
        if (!runtimeCommitted?.ok) return runtimeCommitted;
        const viewCommitted = await viewAuthority.commit(view.prepared);
        if (!viewCommitted.ok) return viewCommitted;
        const providerCommitted = await providerRuntime.commit(provider.prepared);
        return providerCommitted?.ok ? { ok: true, degraded: providerCommitted.degraded === true }
          : providerCommitted;
      },
    };
  }

  return Object.freeze({
    prepare,
    reconcileCompiled: async (compiled, reason) => {
      const view = viewAuthority.prepare(compiled);
      const provider = providerRuntime.prepare(compiled);
      if (!view.ok || !provider.ok) return !view.ok ? view : provider;
      await viewAuthority.hide('generation_reconcile');
      const sidecar = await runtimeCoordinator.reconcileCompiled?.(compiled, reason);
      if (!sidecar?.ok) return sidecar || { ok: false, reason: 'runtime_reconcile_unavailable' };
      const viewResult = await viewAuthority.commit(view.prepared);
      if (!viewResult.ok) return viewResult;
      return providerRuntime.commit(provider.prepared);
    },
    reconcile: (runtime, reason) => runtimeCoordinator.reconcile(runtime, reason),
    fence: (reason) => runtimeCoordinator.fence?.(reason),
    unfence: () => runtimeCoordinator.unfence?.(),
    degrade: (reason) => runtimeCoordinator.degrade?.(reason),
    getState: () => ({ ...runtimeCoordinator.getState?.(),
      view_runtime: viewAuthority.snapshot(), provider_runtime: providerRuntime.snapshot() }),
    detach: () => runtimeCoordinator.detach?.(),
  });
}

module.exports = { createStage7RuntimeCoordinator };
