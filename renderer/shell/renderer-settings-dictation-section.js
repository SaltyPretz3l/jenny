/* Settings > Dictation (row 84). One switch (the `dictation` feature flag,
 * bound through the shared features adapter like spell check), the microphone
 * (windowUi.dictation.deviceId, '' = the system default), the fixed shortcut,
 * and the speech model row in the PDF add-on's grammar: status, then Download,
 * Cancel or Remove, with progress while it downloads. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsDictationSection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const MB = 1000 * 1000;
  const WORKING = new Set(['downloading', 'verifying']);

  // Module state shared by render and bind generations of the one Settings page.
  const live = { model: null, devices: null, confirmRemove: false, error: '', unsubscribe: null, rerender: () => {} };

  // Main reports a reason code (dictation-model-service.js); the words live here.
  function problemText(reason) {
    switch (reason) {
      case 'checksum_mismatch':
      case 'size_mismatch':
      case 'byte_overflow': return jt('settings.dictation.model.problem.damaged', 'The download was damaged. Try again.');
      case 'insufficient_disk_space': return jt('settings.dictation.model.problem.disk', 'Not enough free disk space for the 673 MB model.');
      case 'download_in_progress': return jt('settings.dictation.model.problem.busy', 'Cancel the download first.');
      case 'path_rejected': return jt('settings.dictation.model.problem.folder', 'The model folder could not be used.');
      default: return jt('settings.dictation.model.problem.network', 'The download stopped. Check your connection and try again.');
    }
  }

  function api() { return (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.dictation) || null; }
  function windowUiApi() { return (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.windowUi) || null; }
  function fieldModules() {
    const load = (path) => (typeof require === 'function' ? require(path) : null);
    return {
      descriptors: globalThis.rendererSettingsFieldDescriptors || load('./renderer-settings-field-descriptors'),
      binding: globalThis.rendererSettingsFieldBinding || load('./renderer-settings-field-binding'),
      surfaces: globalThis.rendererSettingsV2Surfaces || load('./renderer-settings-v2-surfaces'),
    };
  }
  function inv() { return globalThis.inventory || {}; }

  function readDeviceId(state) {
    const value = state && state.ui && state.ui.dictation && state.ui.dictation.deviceId;
    return typeof value === 'string' ? value : '';
  }

  // Labels only appear once the microphone has been used in this window; until
  // then the list shows numbered entries. Never prompts for the microphone.
  function refreshDevices() {
    const media = typeof navigator !== 'undefined' && navigator.mediaDevices;
    if (!media || typeof media.enumerateDevices !== 'function') return Promise.resolve();
    return media.enumerateDevices().then((list) => {
      let n = 0;
      live.devices = list.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d) => { n += 1; return { value: d.deviceId, label: d.label || jt('settings.dictation.microphoneNumbered', 'Microphone {n}', { n }) }; });
      live.rerender();
    }).catch(() => {});
  }

  function microphoneRow(state) {
    const selected = readDeviceId(state);
    const options = [{ value: '', label: jt('settings.dictation.microphoneDefault', 'System default') }].concat(live.devices || []);
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({ value: selected, label: jt('settings.dictation.microphoneMissing', 'Saved microphone (not connected)') });
    }
    return inv().settingsField({
      id: 'dictationMicrophoneRow', variant: 'row', labelFor: 'dictationMicrophoneSelect',
      label: jt('settings.dictation.microphone', 'Microphone'),
      help: jt('settings.dictation.microphoneHelp', 'Used only while you hold the mic or the shortcut.'),
      helpId: 'dictationMicrophoneHelp',
      controlHtml: inv().selectField({ id: 'dictationMicrophoneSelect', ariaLabel: jt('settings.dictation.microphone', 'Microphone'), value: selected, options, describedBy: 'dictationMicrophoneHelp' }),
    });
  }

  function shortcutRow() {
    return inv().settingsField({
      id: 'dictationShortcutRow', variant: 'row',
      label: jt('settings.dictation.shortcut', 'Shortcut'),
      help: jt('settings.dictation.shortcutHelp', 'Hold to talk while Jenny has focus. A quick press or a click on the mic starts hands-free.'),
      controlHtml: '<kbd class="settings-dictation-kbd">Ctrl+Space</kbd>',
    });
  }

  function modelStatus(model) {
    const kind = model && model.state;
    if (kind === 'ready') return { label: jt('settings.dictation.model.ready', 'Ready'), state: 'ready' };
    if (kind === 'downloading') {
      return { label: jt('settings.dictation.model.downloading', '{done} of {total} MB', { done: Math.round((Number(model.downloadedBytes) || 0) / MB), total: Math.round((Number(model.totalBytes) || 0) / MB) }) };
    }
    if (kind === 'verifying') return { label: jt('settings.dictation.model.verifying', 'Checking…') };
    if (kind === 'failed') return { label: jt('settings.dictation.model.failed', 'Failed'), state: 'blocked' };
    return { label: jt('settings.dictation.model.notInstalled', 'Not installed') };
  }

  function button(id, label, variant) {
    return inv().actionButton({ domId: id, label, variant: variant || 'secondary', size: 'sm' });
  }

  function modelRow(model) {
    const kind = model && model.state;
    const status = modelStatus(model);
    const statusHtml = '<span class="settings-page-status" role="status"' + (status.state ? ' data-state="' + status.state + '"' : '') + '>'
      + (status.state === 'ready' ? '<span class="settings-page-status-dot" aria-hidden="true"></span>' : '') + escapeHtml(status.label) + '</span>';
    let actions = '';
    if (live.confirmRemove && kind === 'ready') {
      actions = button('dictationModelRemoveConfirm', jt('settings.dictation.model.removeConfirm', 'Remove'), 'danger') + button('dictationModelRemoveCancel', jt('settings.dictation.model.keep', 'Keep'));
    } else if (kind === 'ready') {
      actions = button('dictationModelRemove', jt('settings.dictation.model.remove', 'Remove'), 'ghost');
    } else if (WORKING.has(kind)) {
      actions = button('dictationModelCancel', jt('settings.dictation.model.cancel', 'Cancel'), 'ghost');
    } else if (model) {
      actions = button('dictationModelDownload', kind === 'failed' ? jt('settings.dictation.model.retry', 'Try again') : jt('settings.dictation.model.download', 'Download'));
    }
    const row = inv().settingsField({
      id: 'dictationModelRow', variant: 'row',
      label: jt('settings.dictation.model.name', 'Parakeet v3 (multilingual)'),
      help: jt('settings.dictation.model.help', 'Runs on your processor. 673 MB. Understands English and 24 other European languages, detected automatically.'),
      controlHtml: statusHtml + actions,
    });
    const notes = [];
    if (live.confirmRemove && kind === 'ready') notes.push(jt('settings.dictation.model.removeNote', 'Dictation stops working until you download the model again.'));
    if (kind === 'failed') notes.push(problemText(model.error && model.error.reason));
    if (live.error) notes.push(live.error);
    return row + notes.map((text) => '<p class="settings-field-note" role="status">' + escapeHtml(text) + '</p>').join('');
  }

  function renderDictationSection({ container, state } = {}) {
    if (!container || typeof container.querySelector !== 'function' || typeof inv().settingsField !== 'function') return;
    const { binding, descriptors, surfaces } = fieldModules();
    const toggleSwitch = inv().toggleSwitch || globalThis.inventoryToggleSwitch?.toggleSwitch;
    const general = container.querySelector('#dictationGeneralList');
    const model = container.querySelector('#dictationModelList');
    const paint = (slot, html) => { if (!slot) return; if (surfaces?.paintSlot) surfaces.paintSlot(slot, html); else slot.innerHTML = html; };
    const toggle = descriptors?.getSettingDescriptor?.('dictationEnabledToggle');
    const enabled = state?.features?.featureFlags?.dictation !== false;
    const toggleHtml = toggle && binding && typeof toggleSwitch === 'function'
      ? binding.renderSettingRow(toggle, enabled, { inventory: { toggleSwitch, settingsField: inv().settingsField } }) : '';
    paint(general, toggleHtml + microphoneRow(state) + shortcutRow());
    paint(model, modelRow(live.model));
    // The flag may have just changed here: show or hide the composer mics now.
    globalThis.rendererDictationLive?.syncAvailability?.();
  }

  function bindDictationSection({ container, state, registerListener, listenerOptions } = {}) {
    if (!container || !state || typeof registerListener !== 'function') return;
    // Section-local, like the PDF add-on: download progress lands four times a
    // second and must not re-render the whole Settings page each time.
    live.rerender = () => renderDictationSection({ container, state });
    const bridge = api();
    if (bridge && !live.unsubscribe) {
      Promise.resolve(bridge.getState?.()).then((next) => { if (next) { live.model = next; live.rerender(); } }).catch(() => {});
      const unsubscribe = bridge.onChanged?.((next) => { if (next) { live.model = next; live.rerender(); } });
      live.unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : () => {};
    }
    if (!live.devices) void refreshDevices();
    const run = (promise) => Promise.resolve(promise).then((result) => {
      live.error = result && result.ok === false ? problemText(result.reason) : '';
      live.rerender();
    }).catch(() => { live.error = problemText(''); live.rerender(); });
    registerListener(container, 'click', (event) => {
      const id = event.target && event.target.closest && event.target.closest('button[id^="dictationModel"]')?.id;
      if (!id || !bridge) return;
      live.error = '';
      if (id === 'dictationModelDownload') run(bridge.setup());
      else if (id === 'dictationModelCancel') run(bridge.cancel());
      else if (id === 'dictationModelRemove') { live.confirmRemove = true; live.rerender(); }
      else if (id === 'dictationModelRemoveCancel') { live.confirmRemove = false; live.rerender(); }
      else if (id === 'dictationModelRemoveConfirm') { live.confirmRemove = false; run(bridge.remove()); }
    }, listenerOptions);
    registerListener(container, 'change', (event) => {
      if (!event.target || event.target.id !== 'dictationMicrophoneSelect') return;
      const deviceId = String(event.target.value || '');
      const ui = windowUiApi();
      if (typeof ui?.updateSettings !== 'function') return;
      Promise.resolve(ui.updateSettings({ dictation: { deviceId } })).then((result) => {
        const saved = result && result.dictation && typeof result.dictation.deviceId === 'string' ? result.dictation.deviceId : deviceId;
        if (!state.ui || typeof state.ui !== 'object') state.ui = {};
        state.ui.dictation = { ...(state.ui.dictation || {}), deviceId: saved };
        live.rerender();
      }).catch(() => { live.error = jt('settings.dictation.microphone.saveFailed', 'The microphone choice could not be saved.'); live.rerender(); });
    }, listenerOptions);
  }

  function disposeDictationSection() {
    if (live.unsubscribe) { try { live.unsubscribe(); } catch (_error) { /* best effort */ } }
    live.unsubscribe = null;
    live.rerender = () => {};
  }

  return { renderDictationSection, bindDictationSection, disposeDictationSection, _live: live };
});
