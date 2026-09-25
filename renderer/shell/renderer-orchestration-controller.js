(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(
    require('./renderer-orchestration-view'), require('../shared/async-fence'));
  else root.rendererOrchestrationController = factory(root.rendererOrchestrationView, root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (view, asyncFence) {
  'use strict';
  function createController(options = {}) {
    const windowRef = options.windowRef || globalThis;
    const state = options.state || {};
    const host = options.host || windowRef.document?.getElementById('sessionOrchestrationMount');
    const api = options.api || windowRef.jennyShell?.sessionRuntime;
    const fence = asyncFence.createDisposalFence();
    const gate = asyncFence.createGenerationGate();
    const model = { snapshot: null, detail: null, draft: {}, busy: false, cursor: null, message: '' };
    let selected = '';
    let timer = null;
    let reading = false;
    let bound = false;
    let startReceipt = null;
    let expectedLimits = null;
    let expectedEdit = null;
    const visible = options.isVisible || (() => state.ui?.activeView === 'settings' && state.ui?.activeSettingsSection === 'runtime');
    const current = token => !fence.isDisposed() && gate.isCurrent(token);
    function render() {
      if (fence.isDisposed() || !visible()) return;
      model.sessionId = String(state.currentSessionId || '');
      model.sessionLabel = (state.sessions || []).find(row => row.id === model.sessionId)?.title || model.sessionId;
      model.externalBusy = options.controlsBlocked?.() === true;
      model.startAllowed = options.canStart?.() !== false;
      model.workControlAllowed = options.canControlWork?.(model.detail?.work) !== false;
      view.render(host, model);
    }
    function configured() {
      return { ...model.snapshot.lanes.configured_limits, resources: model.snapshot.resources.configured_limits };
    }
    async function readDetail(token, page = {}) {
      if (!selected) return;
      const result = await api.getWork({ work_id: selected, ...page });
      if (!current(token)) return;
      if (result?.ok !== true) throw new Error('detail_unavailable');
      model.detail = result;
    }
    async function refresh() {
      if (fence.isDisposed() || !visible() || reading || model.busy) return;
      reading = true;
      const token = gate.capture();
      try {
        const result = await api.getSnapshot({ limit: 25, cursor: model.cursor });
        if (!current(token)) return;
        if (result?.ok !== true) {
          if (result?.error?.reason === 'runtime_snapshot_cursor_stale') model.cursor = null;
          throw new Error('snapshot_unavailable');
        }
        model.snapshot = result;
        for (const work of result.work) state.runtimeSendController?.reconcileWork?.(work);
        await readDetail(token);
      } catch (_error) {
        if (current(token)) model.message = view.labels().unavailable;
      } finally { reading = false; render(); }
    }
    function number(value) {
      if (!/^\d+$/.test(String(value))) throw new Error('invalid_number');
      const n = Number(value);
      if (!Number.isSafeInteger(n)) throw new Error('invalid_number');
      return n;
    }
    function startPayload() {
      const limits = Object.fromEntries(['inference_requests', 'input_tokens', 'output_tokens'].map((key, i) =>
        [key, number(model.draft[`start_${key}`] ?? [8, 32768, 8192][i])]));
      const payload = { session_id: String(state.currentSessionId || ''), purpose: model.draft.purpose || '',
        prompt: model.draft.prompt || '', limits };
      if (!payload.session_id || !payload.purpose.trim() || !payload.prompt.trim() || Object.values(limits).some(n => n < 1)) throw new Error('invalid_start');
      const fingerprint = JSON.stringify(payload);
      if (!startReceipt || startReceipt.fingerprint !== fingerprint) startReceipt = {
        fingerprint, payload: { ...payload, idempotency_key: `desktop_start_${windowRef.crypto.randomUUID()}` } };
      return startReceipt.payload;
    }
    function limitsPayload() {
      const expected = expectedLimits || configured();
      const patch = {};
      for (const [group, values] of Object.entries(expected)) {
        for (const key of Object.keys(values)) {
          const draftKey = `limit_${group}_${key}`;
          if (model.draft[draftKey] !== undefined) {
            patch[group] ||= {};
            patch[group][key] = number(model.draft[draftKey]);
          }
        }
      }
      return { expected_limits: expected, patch };
    }
    function mutation(action) {
      const work = model.detail?.work;
      const cas = { work_id: work?.work_id, expected_revision: work?.revision };
      if (action === 'start') return api.start(startPayload());
      if (action === 'limits') return api.updateLimits(limitsPayload());
      if (action === 'edit') return api.updatePending({ ...cas, expected_revision: expectedEdit ?? cas.expected_revision, prompt: model.draft.edit || '' });
      if (['pause', 'resume', 'cancel'].includes(action) && work) return api[action](cas);
      throw new Error('invalid_action');
    }
    function accepted(action, result) {
      model.message = result.status === 'requested' && action === 'cancel' ? view.labels().requested : '';
      if (action === 'start') {
        selected = result.work_id;
        model.detail = null;
        model.cursor = null;
        model.draft.purpose = '';
        model.draft.prompt = '';
        startReceipt = null;
      }
      if (action === 'limits') {
        expectedLimits = null;
        for (const key of Object.keys(model.draft)) if (key.startsWith('limit_')) delete model.draft[key];
      }
      if (action === 'edit') { expectedEdit = null; delete model.draft.edit; }
    }
    async function mutate(action) {
      if (model.busy || fence.isDisposed()) return;
      gate.bump();
      const token = gate.capture();
      model.busy = true;
      render();
      try {
        const result = await mutation(action);
        if (!current(token)) return;
        if (result?.ok !== true) throw new Error('mutation_refused');
        accepted(action, result);
      } catch (_error) { if (current(token)) model.message = view.labels().failedAction; }
      finally {
        model.busy = false;
        if (current(token)) { render(); await refresh(); }
      }
    }
    async function inspect(workId, page = {}) {
      gate.bump();
      const token = gate.capture();
      if (selected !== workId) { model.detail = null; delete model.draft.edit; expectedEdit = null; }
      selected = workId;
      model.busy = true;
      render();
      try { await readDetail(token, page); }
      catch (_error) { if (current(token)) model.message = view.labels().unavailable; }
      finally { if (current(token)) { model.busy = false; render(); } }
    }
    async function open() {
      const token = gate.capture();
      const sessionId = model.detail?.work?.session_id;
      if (!sessionId || !current(token)) return;
      // This explicit click changes view now. A later transcript load must not
      // pull the user back from navigation performed while it was loading.
      options.setActiveView?.('chat');
      try { await options.openSession?.(sessionId); }
      catch (_error) { if (current(token)) { model.message = view.labels().unavailable; render(); } }
    }
    function onInput(event) {
      const key = event.target?.dataset?.draft;
      if (!key || !host.contains(event.target) || model.busy) return;
      if (key.startsWith('limit_') && !expectedLimits && model.snapshot) expectedLimits = configured();
      if (key === 'edit' && expectedEdit === null) expectedEdit = model.detail?.work.revision;
      model.draft[key] = event.target.value;
    }
    function onClick(event) {
      const target = event.target?.closest?.('[data-action]');
      if (!target || !host.contains(target) || target.disabled || model.busy) return;
      const action = String(target.dataset.action || '').replace(/^runtime-/, '');
      if (action === 'inspect') { void inspect(target.dataset.workId); return; }
      if (action === 'children') { void inspect(selected, { child_offset: model.detail.coordination.next_child_offset,
        lineage_revision: model.detail.coordination.lineage_revision }); return; }
      if (['refresh', 'first', 'next'].includes(action)) {
        gate.bump();
        if (action === 'next') model.cursor = model.snapshot?.next_cursor;
        else model.cursor = null;
        if (action === 'refresh') {
          expectedLimits = null; expectedEdit = null;
          for (const key of Object.keys(model.draft)) if (key.startsWith('limit_') || key === 'edit') delete model.draft[key];
        }
        model.message = '';
        void refresh(); return;
      }
      if (action === 'open') { void open(); return; }
      void mutate(action);
    }
    function poll() {
      if (fence.isDisposed()) return;
      void refresh();
      timer = windowRef.setTimeout(poll, 2000);
    }
    function bind() {
      if (bound || fence.isDisposed() || !host) return;
      bound = true;
      host.addEventListener('input', onInput);
      host.addEventListener('click', onClick);
      render(); poll();
    }
    function dispose() {
      fence.dispose(); gate.bump(); windowRef.clearTimeout(timer);
      host?.removeEventListener('input', onInput); host?.removeEventListener('click', onClick);
    }
    return { bind, dispose, refresh, inspect, render, getState: () => model };
  }
  return { createController };
});
