/* Browser authorization and transport adapter for the shared Runs + Runtime limits controller. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shell/renderer-orchestration-controller'));
  else root.jennyBrowserOrchestration = factory(root.rendererOrchestrationController);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (orchestration) {
  'use strict';
  function attachBrowserOrchestration(app) {
    let controller = null; let host = null; let identity = '';
    const state = { get currentSessionId() { return app.state.selectedSessionId; },
      get sessions() { return (app.state.sessions || []).map(row => ({ ...row, id: row.session_id })); } };
    const currentIdentity = () => `${app.authGeneration}:${app.bridge?.clientId || ''}`;
    const canControl = sessionId => Boolean(sessionId && sessionId === app.state.selectedSessionId
      && app.state.control?.owned && !app.state.snapshotPending && !app.state.snapshotUnavailable);
    const read = async (method, params) => {
      const result = await app._command(`sessionRuntime.${method}`, { params }, { quiet: true });
      return result?.ok ? result.runtime : result;
    };
    async function mutate(method, payload) {
      const captured = currentIdentity();
      let sessionId = null;
      if (method !== 'updateLimits') {
        const detail = await read('getWork', { work_id: payload.work_id });
        sessionId = detail?.work?.session_id;
      }
      if (captured !== currentIdentity() || app.disposed || !app.state.authenticated) return { ok: false };
      if (method !== 'updateLimits' && !canControl(sessionId)) return { ok: false };
      const { session_id: _session, ...params } = payload;
      const result = await app._command(`sessionRuntime.${method}`, { params,
        ...(method === 'updateLimits' ? {} : { sessionId, controlGeneration: app.state.control.generation,
          expectedRevision: app.state.snapshot?.session?.revision }) });
      return result?.ok ? result.runtime : result;
    }
    const api = Object.fromEntries(['getSnapshot', 'getWork', 'getResult'].map(method => [method, params => read(method, params)]));
    // No Start: only the composer starts work (owner rule 2026-09-20).
    for (const method of ['pause', 'resume', 'cancel', 'updatePending', 'updateLimits']) {
      api[method] = payload => mutate(method, payload);
    }
    function dispose() { controller?.dispose(); controller = null; host = null; identity = ''; }
    function render() {
      const nextHost = app.root?.querySelector('[data-browser-runtime]');
      const nextIdentity = currentIdentity();
      if (host !== nextHost || identity !== nextIdentity || !app.state.authenticated) dispose();
      if (!nextHost || !app.state.authenticated || app.disposed) return;
      host = nextHost; identity = nextIdentity;
      host.hidden = app.state.runtimeOpen !== true;
      const toggle = app.root.querySelector('[data-action="runtime-toggle"]');
      toggle?.setAttribute('aria-expanded', String(!host.hidden));
      if (host.hidden) return;
      if (!controller) {
        host.innerHTML = '<div class="browser-runs" data-browser-runs></div><div class="browser-runtime-limits" data-browser-limits></div>';
        const windowRef = host.ownerDocument.defaultView;
        controller = orchestration.createController({ state, api, windowRef, documentRef: host.ownerDocument,
          runsHost: host.querySelector('[data-browser-runs]'), limitsHost: host.querySelector('[data-browser-limits]'),
          isSectionVisible: () => !app.disposed && app.state.authenticated && app.state.runtimeOpen === true,
          controlsBlocked: () => app.state.mutationPending === true,
          canControlWork: work => canControl(work?.session_id),
          getProjects: () => app.state.projects || [],
          openSession: sessionId => app.selectSession(sessionId) });
        controller.bind();
      } else controller.render();
    }
    function toggle() { app.state.runtimeOpen = !app.state.runtimeOpen; app.render(); }
    return { render, toggle, dispose, api };
  }
  return { attachBrowserOrchestration };
});
