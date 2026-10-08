/* renderer/shell/renderer-orchestration-controller.js - one poller for Diagnostics › Runs and Runtime limits.
 *
 * Desktop mounts the two views separately (Diagnostics › Runs since
 * 2026-10-03, Settings › Developer › Runtime limits); the hosted client mounts
 * both in one panel. Either way one controller reads one snapshot per tick and
 * hands it to both views. The poll runs only while the window is visible and
 * at least one view is on screen; it resumes on visibilitychange, when the
 * settings shell shows a section (resume(), reached through the section
 * refresher), when Diagnostics paints its Runs tab (wake()), or when a host is
 * shown again by a display toggle (the hosted panel's ResizeObserver).
 * Owner rule (2026-09-20): only the composer starts work. Nothing here starts it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(
    require('./renderer-runs-view'), require('./renderer-runtime-limits-view'), require('../shared/async-fence'));
  else root.rendererOrchestrationController = factory(root.rendererRunsView, root.rendererRuntimeLimitsView, root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (runsView, limitsView, asyncFence) {
  'use strict';
  const POLL_MS = 2000;
  const PROJECTS_TTL_MS = 30000;
  const RESET_ARM_MS = 5000;

  function localMidnight(now) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return date.valueOf();
  }

  function createController(options = {}) {
    const windowRef = options.windowRef || globalThis;
    const doc = options.documentRef || windowRef.document;
    const state = options.state || {};
    const api = options.api || windowRef.jennyShell?.sessionRuntime;
    const now = options.now || (() => Date.now());
    const snapshotView = options.snapshotView === 'page' ? 'page' : 'runs';
    const fence = asyncFence.createDisposalFence();
    const gate = asyncFence.createGenerationGate();
    const hosts = { runs: null, limits: null };
    const views = { runs: null, limits: null };
    const observers = { runs: null, limits: null };
    const model = { snapshot: null, loaded: false, detail: null, draft: {}, busy: false, selected: '',
      readError: '', actionMessage: '', actionWorkId: '', limitErrors: {}, limitWrites: {}, limitRestore: {},
      limitsResetArmed: false, confirmStop: '',
      finishedOpen: false, pausedEarlierOpen: false, filterOpen: false, projectFilter: '', projects: [] };
    let timer = null;
    let reading = false;
    let expectedEdit = null;
    // Limits: the configured limits shown when each edit began (by draft key,
    // or 'reset'): the compare-and-swap expectation its write carries.
    const limitExpect = {};
    let limitsChain = Promise.resolve();
    let limitsEpoch = 0;
    let resetTimer = null;
    const lastSignature = { runs: '', limits: '' };
    let projectsReadAt = -Infinity;
    let projectsReading = false;
    const sectionVisible = options.isSectionVisible || ((kind) => (kind === 'runs'
      ? state.ui?.activeView === 'logs' && state.ui?.logs?.activeTab === 'runs'
      : state.ui?.activeView === 'settings' && state.ui?.activeSettingsSection === 'advanced'));
    const documentVisible = () => !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
    const visible = kind => Boolean(hosts[kind]) && documentVisible() && sectionVisible(kind) !== false;
    const anyVisible = () => visible('runs') || visible('limits');
    const current = token => !fence.isDisposed() && gate.isCurrent(token);
    const runsLabels = () => runsView.labels();

    function findItem(workId) {
      const row = (model.snapshot?.work || []).find(item => item.work_id === workId);
      if (model.detail?.work?.work_id === workId) return { ...(row || {}), ...model.detail.work };
      return row || null;
    }
    function projectsList() {
      const sync = options.getProjects?.();
      return Array.isArray(sync) ? sync : model.projects;
    }
    function viewModel() {
      return { ...model, projects: projectsList(), sessions: state.sessions || [], now: now(),
        finishedSince: localMidnight(now()), busy: model.busy || options.controlsBlocked?.() === true,
        canControl: work => options.canControlWork?.(work) !== false };
    }
    function signature(vm) {
      const titles = (vm.sessions || []).filter(row => (vm.snapshot?.work || []).some(item => item.session_id === (row.id || row.session_id)))
        .map(row => [row.id || row.session_id, row.title]);
      return JSON.stringify([vm.snapshot, vm.detail, vm.loaded, vm.readError, vm.actionMessage, vm.limitErrors,
        vm.limitWrites, vm.limitsResetArmed,
        vm.selected, vm.confirmStop, vm.finishedOpen, vm.pausedEarlierOpen, vm.filterOpen, vm.projectFilter, vm.busy, titles,
        (vm.projects || []).map(project => [project.id, project.name]), Math.floor(vm.now / 60000), vm.finishedSince,
        vm.snapshot ? (vm.snapshot.work || []).map(item => vm.canControl(item)) : null, vm.draft.edit === undefined,
        // Limit drafts change without typing too (a settled write clears them).
        Object.entries(vm.draft).filter(([key]) => key.startsWith('limit_'))]);
    }
    // Skip the whole render when nothing a person could see has changed.
    // Each view keeps its own last signature: a hidden view is not painted, and
    // is painted once when it is shown again.
    function render() {
      if (fence.isDisposed()) return;
      const vm = viewModel();
      const next = signature(vm);
      for (const kind of ['runs', 'limits']) {
        if (!views[kind] || !visible(kind)) { lastSignature[kind] = ''; continue; }
        if (next === lastSignature[kind]) continue;
        lastSignature[kind] = next;
        views[kind].update(vm);
      }
    }
    function invalidate() { lastSignature.runs = ''; lastSignature.limits = ''; }

    async function readDetail(token, page = {}) {
      if (!model.selected) return;
      const result = await api.getWork({ work_id: model.selected, ...page });
      if (!current(token)) return;
      if (result?.ok !== true) {
        // Work that left the list (retired, or another day's) is let go, not
        // reported as a broken page on every poll.
        if (!(model.snapshot?.work || []).some(item => item.work_id === model.selected)) {
          model.selected = ''; model.detail = null; delete model.draft.edit; expectedEdit = null;
          return;
        }
        throw new Error('detail_unavailable');
      }
      model.detail = result;
    }
    async function readProjects() {
      if (projectsReading || typeof options.listProjects !== 'function' || now() - projectsReadAt < PROJECTS_TTL_MS) return;
      projectsReading = true;
      projectsReadAt = now();
      try {
        const payload = await options.listProjects();
        const list = Array.isArray(payload) ? payload : Array.isArray(payload?.projects) ? payload.projects : [];
        if (!fence.isDisposed()) model.projects = list.filter(project => project && typeof project.id === 'string')
          .map(project => ({ id: project.id, name: String(project.name || '') }));
      } catch (_error) { /* names fall back to "Project" */ }
      finally { projectsReading = false; }
    }
    function snapshotRequest() {
      if (snapshotView === 'page') return { limit: 100, cursor: null };
      return { view: 'runs', limit: 100, finished_since: new Date(localMidnight(now())).toISOString() };
    }
    async function refresh() {
      if (fence.isDisposed() || !anyVisible() || reading || model.busy) return;
      reading = true;
      const token = gate.capture();
      const epoch = limitsEpoch;
      try {
        const result = await api.getSnapshot(snapshotRequest());
        if (!current(token)) return;
        // A read that crossed a limits write may predate it; the next tick reads again.
        if (epoch !== limitsEpoch) return;
        if (result?.ok !== true) throw new Error('snapshot_unavailable');
        model.snapshot = result;
        model.loaded = true;
        // "Stop requested…" speaks about one run: it goes once that run is done or gone (N6).
        if (model.actionWorkId && !result.work.some(item => item.work_id === model.actionWorkId
          && runsView.groupOf(item) !== 'finished')) { model.actionMessage = ''; model.actionWorkId = ''; }
        for (const work of result.work) state.runtimeSendController?.reconcileWork?.(work);
        await readDetail(token);
        if (!current(token)) return;
        // A successful read clears the read error (R2).
        model.readError = '';
        await readProjects();
      } catch (_error) {
        if (current(token)) { model.loaded = true; model.readError = runsLabels().unavailable; }
      // A refused field is forced to the configured value through this render,
      // then the restore flags go (the next poll must not overwrite typing).
      } finally { reading = false; render(); model.limitRestore = {}; }
    }

    function shownLimits() {
      return { ...model.snapshot.lanes.configured_limits, resources: model.snapshot.resources.configured_limits };
    }
    const configured = () => JSON.parse(JSON.stringify(shownLimits()));
    function mutation(action, workId) {
      const work = findItem(workId);
      if (!work) throw new Error('work_missing');
      const cas = { work_id: work.work_id, expected_revision: work.revision };
      if (action === 'edit') return api.updatePending({ ...cas, expected_revision: expectedEdit ?? cas.expected_revision, prompt: model.draft.edit || '' });
      if (['pause', 'resume', 'cancel'].includes(action)) return api[action](cas);
      throw new Error('invalid_action');
    }
    function accepted(action, result, workId) {
      const stopRequested = action === 'cancel' && result.status === 'requested';
      model.actionMessage = stopRequested ? runsLabels().stopRequested : '';
      model.actionWorkId = stopRequested ? workId : '';
      if (action === 'cancel') model.confirmStop = '';
      if (action === 'edit') { expectedEdit = null; delete model.draft.edit; }
    }
    async function mutate(action, workId = model.selected) {
      if (model.busy || fence.isDisposed()) return;
      gate.bump();
      const token = gate.capture();
      model.busy = true;
      model.actionMessage = ''; model.actionWorkId = '';
      render();
      try {
        const result = await mutation(action, workId);
        if (!current(token)) return;
        if (result?.ok !== true) throw new Error('mutation_refused');
        accepted(action, result, workId);
      } catch (_error) {
        if (!current(token)) return;
        model.actionMessage = runsLabels().failedAction;
      } finally {
        model.busy = false;
        if (current(token)) { render(); await refresh(); }
      }
    }
    async function inspect(workId, page = {}) {
      gate.bump();
      const token = gate.capture();
      if (model.selected !== workId) { model.detail = null; delete model.draft.edit; expectedEdit = null; }
      model.selected = workId;
      model.confirmStop = '';
      render();
      // A read failure is a read error: the next successful poll clears it (R2).
      try { await readDetail(token, page); } catch (_error) { if (current(token)) model.readError = runsLabels().unavailable; }
      finally { if (current(token)) render(); }
    }
    function deselect() {
      gate.bump();
      model.selected = ''; model.detail = null; delete model.draft.edit; expectedEdit = null;
      render();
    }
    async function openChat(workId) {
      const work = findItem(workId);
      const sessionId = work?.session_id;
      if (!sessionId) return;
      // This explicit click changes view now. A later transcript load must not
      // pull the person back from navigation performed while it was loading.
      options.setActiveView?.('chat');
      try { await options.openSession?.(sessionId, { turnId: work.turn_id }); }
      catch (_error) { if (!fence.isDisposed()) { model.actionMessage = runsLabels().unavailable; render(); } }
    }
    function focusAfter(kind, key) {
      views[kind]?.focusKey?.(key);
    }

    // The expectation is what the person sees when editing begins: captured on
    // focus, before a poll can move the configured values behind a focused field,
    // and dropped again when focus leaves without an edit.
    function onFocusIn(event) {
      const key = event.target?.dataset?.draft;
      if (key?.startsWith('limit_') && !limitExpect[key] && model.snapshot && !model.busy) limitExpect[key] = configured();
    }
    function onFocusOut(event) {
      const key = event.target?.dataset?.draft;
      if (!key?.startsWith('limit_') || model.limitWrites[key]) return;
      // A value that failed its check is never written: leaving the field puts
      // back the one in effect, so no field shows a number the runtime is not using.
      if (model.draft[key] !== undefined && model.limitErrors[key]) {
        delete model.draft[key];
        model.limitErrors = { ...model.limitErrors };
        delete model.limitErrors[key];
        render();
      }
      if (model.draft[key] === undefined) delete limitExpect[key];
    }
    function onInput(event) {
      const key = event.target?.dataset?.draft;
      if (!key || model.busy) return;
      if (key.startsWith('limit_')) {
        if (!limitExpect[key] && model.snapshot) limitExpect[key] = configured();
        checkLimit(key, event.target.value);
      }
      if (key === 'edit' && expectedEdit === null) {
        // Check the save against the revision the box was showing, not a newer one read since.
        const shown = Number.parseInt(event.target.dataset.revision, 10);
        expectedEdit = Number.isSafeInteger(shown) ? shown : model.detail?.work?.revision ?? null;
      }
      model.draft[key] = event.target.value;
      if (key.startsWith('limit_')) render();
    }
    function checkLimit(key, raw) {
      const entry = limitsView.fields().find(item => item.draftKey === key);
      const checked = entry ? limitsView.validate(entry, raw, model.snapshot) : { ok: false };
      model.limitErrors = { ...model.limitErrors };
      if (checked.ok) delete model.limitErrors[key]; else if (entry) model.limitErrors[key] = checked.error;
      return { entry, ...checked };
    }
    // One write per committed change (Revert writes one default, Reset every
    // differing key). Writes queue, so each is built after the previous one
    // settles; an acknowledged write moves the other pending expectations
    // forward, and a refused one is shown on its fields, never retried.
    function writeLimits(expectKey, changes, refocus = '') {
      limitExpect[expectKey] ||= configured();
      for (const { entry } of changes) { model.limitWrites[entry.draftKey] = true; delete model.limitErrors[entry.draftKey]; }
      render();
      const step = async () => {
        const patch = {};
        for (const { entry, value } of changes) (patch[entry.group] ||= {})[entry.key] = value;
        limitsEpoch += 1;
        // Acknowledged from the echo only: the persister returns the whole saved set.
        let saved;
        try { saved = echoedLimits(await api.updateLimits({ expected_limits: limitExpect[expectKey], patch }), patch); }
        catch (_error) { saved = null; }
        const ok = saved !== null;
        limitsEpoch += 1;
        delete limitExpect[expectKey];
        if (fence.isDisposed()) return;
        if (ok && model.snapshot) {
          for (const target of [shownLimits(), ...Object.values(limitExpect)]) {
            for (const [group, values] of Object.entries(saved)) Object.assign(target[group], values);
          }
        }
        for (const { entry } of changes) {
          delete model.limitWrites[entry.draftKey];
          delete model.draft[entry.draftKey];
          if (!ok) { model.limitErrors[entry.draftKey] = limitsView.labels().failed; model.limitRestore[entry.draftKey] = true; }
        }
        render();
        // Disabling the field for the write can drop keyboard focus: give it back.
        if (refocus && (!doc?.activeElement || doc.activeElement === doc.body)) focusAfter('limits', refocus);
        void refresh();
      };
      limitsChain = limitsChain.then(step, step);
    }
    // The written keys must all come back as whole numbers; anything else is a refusal.
    function echoedLimits(result, patch) {
      const echo = result?.ok === true ? result.configured_limits : null;
      if (!echo || typeof echo !== 'object') return null;
      const saved = {};
      for (const [group, values] of Object.entries(patch)) {
        for (const key of Object.keys(values)) {
          const value = echo[group]?.[key];
          if (!Number.isInteger(value)) return null;
          (saved[group] ||= {})[key] = value;
        }
      }
      return saved;
    }
    function onChange(event) {
      const key = event.target?.dataset?.draft;
      if (!key?.startsWith('limit_') || model.busy || !model.snapshot || model.limitWrites[key]) return;
      const checked = checkLimit(key, event.target.value);
      if (checked.ok && checked.value !== limitsView.configuredValue(model.snapshot, checked.entry)) {
        writeLimits(key, [{ entry: checked.entry, value: checked.value }], doc?.activeElement === event.target ? key : '');
        return;
      }
      if (checked.ok) { delete model.draft[key]; delete limitExpect[key]; }
      render();
    }
    function revertLimit(target) {
      const entry = limitsView.fields().find(item => `runtime_${item.draftKey}` === target.dataset.settingRevert);
      const value = entry && limitsView.defaultValue(model.snapshot, entry);
      if (Number.isInteger(value)) writeLimits(entry.draftKey, [{ entry, value }]);
    }
    function disarmReset() {
      if (resetTimer !== null) windowRef.clearTimeout(resetTimer);
      resetTimer = null;
      model.limitsResetArmed = false;
    }
    // Two steps: the first click arms, a second within 5 s writes the defaults.
    function resetLimits() {
      if (!model.limitsResetArmed) {
        model.limitsResetArmed = true;
        resetTimer = windowRef.setTimeout(() => { resetTimer = null; disarmReset(); render(); }, RESET_ARM_MS);
        render();
        return;
      }
      return resetLimitsToDefaults();
    }
    // Resolves false when a limit could not be reset (limits that never loaded, a locked window, or a refused write).
    function resetLimitsToDefaults() {
      disarmReset();
      if (!model.snapshot) return Promise.resolve(false);
      const changes = limitsView.fields().filter(entry => limitsView.isModified(model.snapshot, entry))
        .map(entry => ({ entry, value: limitsView.defaultValue(model.snapshot, entry) }));
      if (!changes.length) { render(); return Promise.resolve(true); }
      if (model.snapshot.read_only || model.snapshot.closing || model.busy) return Promise.resolve(false);
      writeLimits('reset', changes);
      return limitsChain.then(() => !changes.some(({ entry }) => model.limitErrors[entry.draftKey]));
    }
    function onClick(event) {
      const target = event.target?.closest?.('[data-action]');
      if (!target || target.disabled || model.busy) return;
      const action = String(target.dataset.action || '');
      const workId = target.dataset.workId || '';
      if (action !== 'runs-filter' && action !== 'runs-filter-pick' && model.filterOpen) { model.filterOpen = false; }
      switch (action) {
        case 'runs-select': if (model.selected === workId) deselect(); else void inspect(workId); return;
        case 'runs-child': void inspect(workId); return;
        case 'runs-children-next': void inspect(model.selected, { child_offset: model.detail?.coordination?.next_child_offset,
          lineage_revision: model.detail?.coordination?.lineage_revision }); return;
        case 'runs-open': void openChat(workId); return;
        case 'runs-resume': void mutate('resume', workId); return;
        case 'runs-pause': void mutate('pause', workId); return;
        case 'runs-withdraw': void mutate('cancel', workId); return;
        case 'runs-stop': model.confirmStop = workId; render(); focusAfter('runs', `${workId}:stop-confirm`); return;
        case 'runs-stop-keep': model.confirmStop = ''; render(); focusAfter('runs', `${workId}:stop`); return;
        case 'runs-stop-confirm': void mutate('cancel', workId); return;
        case 'runs-edit': void mutate('edit', workId); return;
        case 'runs-finished-toggle': model.finishedOpen = !model.finishedOpen; render(); return;
        case 'runs-paused-earlier-toggle': model.pausedEarlierOpen = !model.pausedEarlierOpen; render(); return;
        case 'runs-filter': model.filterOpen = !model.filterOpen; render();
          if (model.filterOpen) focusAfter('runs', `filter:${model.projectFilter || 'all'}`); return;
        case 'runs-filter-pick': model.projectFilter = String(target.dataset.projectId || ''); model.filterOpen = false;
          render(); focusAfter('runs', 'filter'); return;
        case 'limits-reset': resetLimits(); return;
        case 'limits-revert': revertLimit(target); return;
        default: render();
      }
    }
    function onKeydown(event) {
      const item = event.target?.closest?.('[role="menuitemradio"]');
      if (item && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const items = [...item.parentNode.querySelectorAll('[role="menuitemradio"]')];
        const index = items.indexOf(item);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
        event.preventDefault?.();
        return;
      }
      if (event.key !== 'Escape' || event.currentTarget === hosts.limits) return;
      if (model.filterOpen) { model.filterOpen = false; render(); focusAfter('runs', 'filter'); event.preventDefault?.(); return; }
      if (model.confirmStop) { const id = model.confirmStop; model.confirmStop = ''; render(); focusAfter('runs', `${id}:stop`); event.preventDefault?.(); }
    }

    function tick() {
      timer = null;
      if (fence.isDisposed() || !anyVisible()) return; // stopped; wake() restarts it
      void refresh();
      timer = windowRef.setTimeout(tick, POLL_MS);
    }
    function wake() {
      if (fence.isDisposed()) return;
      if (timer === null && anyVisible()) { invalidate(); tick(); return; }
      render();
    }
    // The settings shell showed a section: a switch back to the Settings view,
    // or a section pick. That view hides with content-visibility, so a host
    // keeps its size and the ResizeObserver never fires on the way back (F6,
    // 2026-09-27 gate). A stopped poll restarts, and a pending one reads now:
    // the page never shows counts from before it was hidden for a whole tick.
    function resume() {
      if (fence.isDisposed() || !anyVisible()) return;
      if (timer !== null) windowRef.clearTimeout(timer);
      timer = null;
      invalidate();
      tick();
    }
    function attach(kind, host) {
      if (fence.isDisposed() || !host || !['runs', 'limits'].includes(kind) || hosts[kind] === host) return;
      detach(kind);
      hosts[kind] = host;
      views[kind] = kind === 'runs' ? runsView.createRunsView(host)
        : host.hasAttribute('data-limits-lines') ? limitsView.createLimitLines(host) : limitsView.createLimitsView(host);
      host.addEventListener('focusin', onFocusIn);
      host.addEventListener('focusout', onFocusOut);
      host.addEventListener('input', onInput);
      host.addEventListener('change', onChange);
      host.addEventListener('click', onClick);
      host.addEventListener('keydown', onKeydown);
      // A section shown again (display toggled) resizes from 0: that is the wake-up.
      if (typeof windowRef.ResizeObserver === 'function') {
        observers[kind] = new windowRef.ResizeObserver(() => wake());
        observers[kind].observe(host);
      }
      invalidate();
      wake();
    }
    function detach(kind) {
      const host = hosts[kind];
      if (!host) return;
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      host.removeEventListener('input', onInput);
      host.removeEventListener('change', onChange);
      host.removeEventListener('click', onClick);
      host.removeEventListener('keydown', onKeydown);
      observers[kind]?.disconnect?.();
      observers[kind] = null;
      views[kind]?.dispose?.();
      views[kind] = null;
      hosts[kind] = null;
    }
    function onVisibility() { if (documentVisible()) wake(); }
    let bound = false;
    function bind() {
      if (bound || fence.isDisposed()) return;
      bound = true;
      doc?.addEventListener?.('visibilitychange', onVisibility);
      if (options.runsHost) attach('runs', options.runsHost);
      if (options.limitsHost) attach('limits', options.limitsHost);
      wake();
    }
    function dispose() {
      fence.dispose(); gate.bump();
      disarmReset();
      if (timer !== null) windowRef.clearTimeout(timer);
      timer = null;
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      detach('runs'); detach('limits');
    }
    return { bind, attach, detach, dispose, refresh, inspect, wake, resume, resetLimitsToDefaults, render: () => wake(), getState: () => model,
      isPolling: () => timer !== null, hasHosts: () => Boolean(hosts.runs || hosts.limits) };
  }
  return { createController, localMidnight };
});
