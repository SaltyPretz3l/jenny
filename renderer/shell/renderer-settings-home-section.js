/* Home Settings owns only app-wide Home behavior: the Scratchpad quick-capture
 * rows. Scratchpad presentation now lives beside the widget and session-opening
 * behavior lives in Quick Settings. Rows render from their descriptors; writes
 * go through the shared settings coordinator and are adopted only after an
 * acknowledged home.updateConfig response. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.rendererSettingsHomeSection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const asyncFence = globalThis.rendererAsyncFence
    || (typeof require === 'function' ? require('../shared/async-fence') : null);
  const { isCompleteHomeConfig, jsonValuesEqual } = globalThis.rendererDashboardScratchpadActions
    || (typeof require === 'function' ? require('../features/renderer-dashboard-scratchpad-actions') : null);
  const CAPTURE_MODES = ['append', 'overwrite'];
  const FIELD_IDS = ['homeScratchpadCaptureSelect', 'homeScratchpadGlobalCaptureToggle'];
  function homeApi() { return (typeof window !== 'undefined' && window.jennyShell?.home) || null; }
  function fieldModules() {
    const load = (path) => (typeof require === 'function' ? require(path) : null);
    return {
      descriptors: globalThis.rendererSettingsFieldDescriptors || load('./renderer-settings-field-descriptors'),
      binding: globalThis.rendererSettingsFieldBinding || load('./renderer-settings-field-binding'),
    };
  }
  function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function expectedHomeConfig(current, patch) {
    const expected = { ...current, ...patch };
    for (const key of ['widgets', 'scratchpad', 'calendar']) {
      if (isRecord(patch[key])) expected[key] = { ...current[key], ...patch[key] };
    }
    return expected;
  }
  function readSettings(homeConfig) {
    const settings = isRecord(homeConfig?.scratchpad?.settings) ? homeConfig.scratchpad.settings : {};
    return {
      captureMode: CAPTURE_MODES.includes(settings.captureMode) ? settings.captureMode : 'append',
      globalCapture: settings.globalCapture !== false,
    };
  }
  function renderHomeSection({ container, status, state } = {}) {
    const { binding, descriptors } = fieldModules();
    if (!container || !binding || !descriptors) return;
    const settings = readSettings(state?.homeConfig);
    container.innerHTML = FIELD_IDS.map((id) => {
      const descriptor = descriptors.getSettingDescriptor(id);
      return binding.renderSettingRow(descriptor, settings[descriptor.key]);
    }).join('');
    if (status && status.dataset.state !== 'error') {
      status.textContent = '';
      status.hidden = true;
      status.dataset.state = '';
    }
  }
  function acknowledgedPreference(config, expected) {
    return isCompleteHomeConfig(config) && jsonValuesEqual(config, expected);
  }
  function bindHomeSection({ container, status, state, renderSettings, registerListener, listenerOptions } = {}) {
    const { binding } = fieldModules();
    if (!container || !state || typeof registerListener !== 'function' || !binding) return;
    const rerender = typeof renderSettings === 'function' ? renderSettings : function noop() {};
    const bindingFence = asyncFence.createDisposalFence();
    const bindingSignal = listenerOptions?.signal;
    if (bindingSignal?.aborted) {
      bindingFence.dispose();
    } else if (typeof bindingSignal?.addEventListener === 'function') {
      const disposeBinding = () => bindingFence.dispose();
      bindingSignal.addEventListener('abort', disposeBinding, { once: true });
      bindingFence.onDispose(() => bindingSignal.removeEventListener('abort', disposeBinding));
    }
    let userTouched = false;
    const showStatus = (message, error) => {
      if (!status) return;
      status.textContent = message;
      status.hidden = !message;
      status.dataset.state = error ? 'error' : '';
    };
    const saveFailed = () => jt('settings.home.preferencesSaveFailed', 'Could not save Home preferences. Your previous setting was restored.');
    async function hydrate() {
      if (state.homeConfig || typeof homeApi()?.getConfig !== 'function') return;
      const config = await homeApi().getConfig();
      if (isCompleteHomeConfig(config)) state.homeConfig = config;
    }
    /* After-ack patch adapter: a batch patches scratchpad.settings on top of
     * the hydrated siblings; `ack` keeps the whole acknowledged config for
     * `apply` to adopt, so a refused batch leaves state.homeConfig untouched. */
    let expected = null;
    let acknowledged = null;
    // One coordinator per app state across bind generations; the per-binding
    // status line, re-render and hydration guard are reached through `live`.
    const shared = binding.sharedRegistryFor(state, 'home');
    const live = Object.assign(shared.live, { rerender, showStatus, markTouched: () => { userTouched = true; } });
    const registry = shared.registry;
    if (!registry.has('home')) registry.register({
      id: 'home',
      mode: 'patch',
      optimistic: false,
      read: () => readSettings(state.homeConfig),
      normalize: (settings) => readSettings({ scratchpad: { settings } }),
      write: async (payload) => {
        live.markTouched();
        const api = homeApi();
        if (typeof api?.updateConfig !== 'function') {
          throw Object.assign(new Error(jt('settings.home.preferencesUnavailable', 'Home preferences are unavailable.')), { code: 'home_unavailable' });
        }
        await hydrate();
        const patch = { scratchpad: { settings: { ...(state.homeConfig?.scratchpad?.settings || {}), ...payload } } };
        expected = expectedHomeConfig(state.homeConfig, patch);
        live.showStatus(jt('settings.home.preferencesSaving', 'Saving Home preferences…'), false);
        return api.updateConfig(patch);
      },
      ack: (config) => {
        if (!acknowledgedPreference(config, expected)) throw new Error(saveFailed());
        acknowledged = config;
        return readSettings(config);
      },
      apply: () => {
        if (acknowledged) state.homeConfig = acknowledged;
        acknowledged = null;
        live.rerender();
      },
      onError: (error) => live.showStatus(error?.code === 'home_unavailable' ? error.message : saveFailed(), true),
      onSettled: (ok) => { if (ok) live.showStatus('', false); },
    });
    binding.bindSettingFields({ container, ids: FIELD_IDS, registry, registerListener, listenerOptions });
    if (!state.homeConfig && typeof homeApi()?.getConfig === 'function') {
      Promise.resolve(homeApi().getConfig()).then((config) => {
        if (bindingFence.isDisposed()) return;
        if (!userTouched && isCompleteHomeConfig(config)) { state.homeConfig = config; rerender(); }
      }).catch(() => {
        if (!bindingFence.isDisposed()) showStatus(jt('settings.home.preferencesLoadFailed', 'Could not load Home preferences.'), true);
      });
    }
  }
  return { bindHomeSection, renderHomeSection };
});
