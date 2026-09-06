/* Home Settings owns only app-wide Home behavior. Scratchpad presentation now
 * lives beside the widget and session-opening behavior lives in Quick Settings.
 * Writes are adopted only after an acknowledged home.updateConfig response. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.rendererSettingsHomeSection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const asyncFence = globalThis.rendererAsyncFence
    || (typeof require === 'function' ? require('../shared/async-fence') : null);
  const CAPTURE_MODES = ['append', 'overwrite'];
  const TOGGLE_PREFS = {
    homeScratchpadGlobalCaptureToggle: 'globalCapture',
    homeContextualTipsToggle: 'showContextualTips',
  };
  function homeApi() { return (typeof window !== 'undefined' && window.jennyShell?.home) || null; }
  function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function jsonValuesEqual(left, right) {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length
        && left.every((value, index) => jsonValuesEqual(value, right[index]));
    }
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
        && jsonValuesEqual(left[key], right[key]));
  }
  function expectedHomeConfig(current, patch) {
    const expected = { ...current, ...patch };
    for (const key of ['weather', 'widgets', 'scratchpad', 'calendar']) {
      if (isRecord(patch[key])) expected[key] = { ...current[key], ...patch[key] };
    }
    return expected;
  }
  function isCompleteHomeConfig(config) {
    return isRecord(config)
      && Array.isArray(config.links)
      && isRecord(config.weather)
      && isRecord(config.widgets)
      && isRecord(config.scratchpad)
      && Array.isArray(config.scratchpad.notes)
      && typeof config.scratchpad.activeNoteId === 'string'
      && isRecord(config.scratchpad.settings)
      && Array.isArray(config.scratchpad.pins)
      && isRecord(config.calendar)
      && typeof config.focusMode === 'boolean'
      && typeof config.showContextualTips === 'boolean';
  }
  function readSettings(state) {
    const home = state?.homeConfig && typeof state.homeConfig === 'object' ? state.homeConfig : {};
    const settings = home.scratchpad?.settings && typeof home.scratchpad.settings === 'object'
      ? home.scratchpad.settings : {};
    return {
      captureMode: CAPTURE_MODES.includes(settings.captureMode) ? settings.captureMode : 'append',
      globalCapture: settings.globalCapture !== false,
      showContextualTips: home.showContextualTips !== false,
    };
  }
  function renderHomeSection({ container, badge, status, state } = {}) {
    if (!container) return;
    const selectField = globalThis.inventory?.selectField || globalThis.inventorySelectField;
    const toggleSwitch = globalThis.inventory?.toggleSwitch || globalThis.inventoryToggleSwitch?.toggleSwitch;
    if (typeof selectField !== 'function' || typeof toggleSwitch !== 'function') return;
    const settings = readSettings(state);
    container.innerHTML = [
      selectField({ id: 'homeScratchpadCaptureSelect', label: 'Quick-capture mode', value: settings.captureMode,
        options: [{ value: 'append', label: 'Append a timestamped line' }, { value: 'overwrite', label: 'Replace the note' }],
        ariaLabel: 'Quick-capture mode', dataset: { 'home-pref': 'captureMode' } }),
      toggleSwitch({ id: 'homeScratchpadGlobalCaptureToggle',
        label: 'Ctrl+Shift+Space quick capture (while Jenny is focused)', checked: settings.globalCapture }),
      toggleSwitch({ id: 'homeContextualTipsToggle', label: 'Show contextual tips',
        checked: settings.showContextualTips }),
    ].join('');
    if (badge) badge.textContent = 'Home';
    if (status && status.dataset.state !== 'error') {
      status.textContent = 'Home preferences are saved across restarts.';
      status.dataset.state = '';
    }
  }
  function acknowledgedPreference(config, expected) {
    return isCompleteHomeConfig(config) && jsonValuesEqual(config, expected);
  }
  function bindHomeSection({ container, status, state, renderSettings, registerListener, listenerOptions } = {}) {
    if (!container || !state || typeof registerListener !== 'function') return;
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
    let writeQueue = Promise.resolve();
    const showStatus = (message, error) => {
      if (!status) return;
      status.textContent = message;
      status.dataset.state = error ? 'error' : '';
    };
    async function hydrate() {
      if (state.homeConfig || typeof homeApi()?.getConfig !== 'function') return;
      const config = await homeApi().getConfig();
      if (isCompleteHomeConfig(config)) state.homeConfig = config;
    }
    async function persistPref(pref, value, api) {
      if (typeof api?.updateConfig !== 'function') {
        showStatus('Home preferences are unavailable.', true); rerender(); return;
      }
      try {
        await hydrate();
        const scratchpad = state.homeConfig?.scratchpad || {};
        let patch = null;
        if (pref === 'captureMode' && CAPTURE_MODES.includes(value)) {
          patch = { scratchpad: { settings: { ...(scratchpad.settings || {}), captureMode: value } } };
        } else if (pref === 'globalCapture') {
          patch = { scratchpad: { settings: { ...(scratchpad.settings || {}), globalCapture: value === true } } };
        } else if (pref === 'showContextualTips') {
          patch = { showContextualTips: value === true };
        }
        if (!patch) { rerender(); return; }
        showStatus('Saving Home preferences…', false);
        const expected = expectedHomeConfig(state.homeConfig, patch);
        const config = await api.updateConfig(patch);
        if (!acknowledgedPreference(config, expected)) throw new Error('Mismatched acknowledgement');
        state.homeConfig = config;
        showStatus('Home preferences saved.', false);
        rerender();
      } catch (_error) {
        showStatus('Could not save Home preferences. Your previous setting was restored.', true);
        rerender();
      }
    }
    function applyPref(pref, value) {
      userTouched = true;
      const api = homeApi();
      writeQueue = writeQueue.then(
        () => persistPref(pref, value, api),
        () => persistPref(pref, value, api),
      );
      return writeQueue;
    }
    registerListener(container, 'change', (event) => {
      const select = event.target?.closest?.('[data-home-pref]');
      if (select) void applyPref(select.getAttribute('data-home-pref'), select.value);
    }, listenerOptions);
    registerListener(container, 'inv-toggle-change', (event) => {
      const pref = TOGGLE_PREFS[event.detail?.id];
      if (pref) void applyPref(pref, event.detail?.checked === true);
    }, listenerOptions);
    if (!state.homeConfig && typeof homeApi()?.getConfig === 'function') {
      Promise.resolve(homeApi().getConfig()).then((config) => {
        if (bindingFence.isDisposed()) return;
        if (!userTouched && isCompleteHomeConfig(config)) { state.homeConfig = config; rerender(); }
      }).catch(() => {
        if (!bindingFence.isDisposed()) showStatus('Could not load Home preferences.', true);
      });
    }
  }
  return { bindHomeSection, renderHomeSection, readSettings, TOGGLE_PREFS };
});
