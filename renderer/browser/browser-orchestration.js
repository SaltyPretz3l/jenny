/* Browser authorization and transport adapter for the shared runtime inspector. */
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
      let sessionId = payload.session_id;
      if (!['start', 'updateLimits'].includes(method)) {
        const detail = await read('getWork', { work_id: payload.work_id });
        sessionId = detail?.work?.session_id;
      }
      if (captured !== currentIdentity() || app.disposed || !app.state.authenticated) return { ok: false };
      if (method !== 'updateLimits' && !canControl(sessionId)) return { ok: false };
      const { session_id: _session, idempotency_key: requestId, ...params } = payload;
      const result = await app._command(`sessionRuntime.${method}`, { params,
        ...(method === 'updateLimits' ? {} : { sessionId, controlGeneration: app.state.control.generation,
          expectedRevision: app.state.snapshot?.session?.revision }),
        ...(requestId ? { requestId } : {}) });
      return result?.ok ? result.runtime : result;
    }
    const api = Object.fromEntries(['getSnapshot', 'getWork', 'getResult'].map(method => [method, params => read(method, params)]));
    for (const method of ['start', 'pause', 'resume', 'cancel', 'updatePending', 'updateLimits']) {
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
        controller = orchestration.createController({ host, state, api,
          windowRef: host.ownerDocument.defaultView,
          isVisible: () => !app.disposed && app.state.authenticated && app.state.runtimeOpen === true,
          controlsBlocked: () => app.state.mutationPending === true,
          canStart: () => canControl(app.state.selectedSessionId),
          canControlWork: work => canControl(work?.session_id),
          openSession: sessionId => app.selectSession(sessionId) });
        controller.bind();
      } else controller.render();
    }
    function toggle() { app.state.runtimeOpen = !app.state.runtimeOpen; app.render(); }
    return { render, toggle, dispose, api };
  }
  return { attachBrowserOrchestration };
});
