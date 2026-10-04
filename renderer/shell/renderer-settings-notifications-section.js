/* Settings › Notifications: desktop toasts while Jenny is in the background.
 * The preferences live under the persisted windowUi block (main gates and
 * shows the toasts; the renderer only edits the switches). Rows render from
 * their descriptors; writes go through the shared settings coordinator and
 * are adopted only after windowUi.updateSettings acknowledges the same object
 * back. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.rendererSettingsNotificationsSection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const ADAPTER_ID = 'windowUi.notifications';
  const NOTIFICATION_CATEGORIES = Object.freeze(['replies', 'failures', 'permissions', 'questions', 'reminders']);
  const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
    enabled: true,
    onlyWhenUnfocused: true,
    sound: true,
    replyPreview: false,
    categories: Object.freeze({ replies: true, failures: true, permissions: true, questions: true, reminders: true }),
  });

  function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function flag(value, fallback) { return typeof value === 'boolean' ? value : fallback; }
  function fieldModules() {
    const load = (path) => (typeof require === 'function' ? require(path) : null);
    return {
      descriptors: globalThis.rendererSettingsFieldDescriptors || load('./renderer-settings-field-descriptors'),
      binding: globalThis.rendererSettingsFieldBinding || load('./renderer-settings-field-binding'),
    };
  }

  /* Total: any input yields a full settings object; unknown keys are dropped. */
  function normalizeNotificationSettings(value) {
    const source = isRecord(value) ? value : {};
    const categorySource = isRecord(source.categories) ? source.categories : {};
    const categories = {};
    NOTIFICATION_CATEGORIES.forEach((category) => {
      categories[category] = flag(categorySource[category], DEFAULT_NOTIFICATION_SETTINGS.categories[category]);
    });
    return {
      enabled: flag(source.enabled, DEFAULT_NOTIFICATION_SETTINGS.enabled),
      onlyWhenUnfocused: flag(source.onlyWhenUnfocused, DEFAULT_NOTIFICATION_SETTINGS.onlyWhenUnfocused),
      sound: flag(source.sound, DEFAULT_NOTIFICATION_SETTINGS.sound),
      replyPreview: flag(source.replyPreview, DEFAULT_NOTIFICATION_SETTINGS.replyPreview),
      categories,
    };
  }

  function sameSettings(left, right) {
    return JSON.stringify(normalizeNotificationSettings(left)) === JSON.stringify(normalizeNotificationSettings(right));
  }
  // Normalizing fills a missing field with its default, so an echo counts only
  // when every written field (and category) actually came back.
  function hasEveryKey(echo, expected) {
    if (!isRecord(echo) || !isRecord(expected)) return false;
    return Object.keys(expected).every((key) => Object.prototype.hasOwnProperty.call(echo, key)
      && (!isRecord(expected[key]) || hasEveryKey(echo[key], expected[key])));
  }

  function readSettings(state) {
    return normalizeNotificationSettings(state?.ui?.notifications);
  }

  /* `container` is the card; the three lists are found inside it so the
   * markup keeps its headings in index.html with data-i18n like every card.
   * Every dependent switch is disabled while the master switch is off, and
   * the reply preview also while reply notifications are off. */
  function renderNotificationsSection({ container, state } = {}) {
    if (!container || typeof container.querySelector !== 'function') return;
    const toggleSwitch = globalThis.inventory?.toggleSwitch || globalThis.inventoryToggleSwitch?.toggleSwitch;
    const { binding, descriptors } = fieldModules();
    if (typeof toggleSwitch !== 'function' || !binding || !descriptors) return;
    const settings = readSettings(state);
    const off = settings.enabled !== true;
    const lists = { '#notificationsGeneralList': [], '#notificationsCategoryList': [], '#notificationsContentList': [] };
    descriptors.listSettingDescriptors({ adapterId: ADAPTER_ID }).forEach((descriptor) => {
      const reply = descriptor.key === 'replyPreview';
      const list = descriptor.key.startsWith('categories.') ? '#notificationsCategoryList' : (reply ? '#notificationsContentList' : '#notificationsGeneralList');
      const disabled = descriptor.key !== 'enabled' && (off || (reply && settings.categories.replies !== true));
      lists[list].push(binding.renderSettingRow(descriptor, binding.getPath(settings, descriptor.key), { inventory: { toggleSwitch }, disabled }));
    });
    Object.keys(lists).forEach((selector) => {
      const list = container.querySelector(selector);
      if (list) list.innerHTML = lists[selector].join('');
    });
  }

  function windowUiApi() { return (typeof window !== 'undefined' && window.jennyShell?.windowUi) || null; }

  /* Adapter for the shared coordinator (renderer-settings-field-binding.js):
   * optimistic whole-object writes, adopted only when windowUi.updateSettings
   * echoes the same object back; a refused batch rolls back its own keys. */
  function createNotificationsAdapter(live) {
    return {
      id: ADAPTER_ID,
      mode: 'object',
      optimistic: true,
      read: () => readSettings(live.state),
      normalize: normalizeNotificationSettings,
      write: (payload) => {
        const api = windowUiApi();
        if (typeof api?.updateSettings !== 'function') throw new Error(jt('settings.notifications.unavailable', 'Notification settings are unavailable.'));
        return api.updateSettings({ notifications: payload });
      },
      ack: (result, payload) => {
        if (!isRecord(result) || !hasEveryKey(result.notifications, payload) || !sameSettings(result.notifications, payload)) {
          throw new Error(jt('settings.notifications.saveFailed', 'Could not save notification settings. Your previous setting was restored.'));
        }
        return result.notifications;
      },
      apply: (next) => {
        if (!isRecord(live.state.ui)) live.state.ui = {};
        live.state.ui.notifications = next;
        live.rerender();
      },
      onError: (error) => live.showStatus(error?.message || String(error), true),
      onSettled: (ok) => { if (ok) live.showStatus('', false); },
    };
  }

  function bindNotificationsSection({ container, status, state, renderSettings, registerListener, listenerOptions, registry } = {}) {
    if (!container || !state || typeof registerListener !== 'function') return;
    const { binding, descriptors } = fieldModules();
    if (typeof binding?.bindSettingFields !== 'function' || typeof descriptors?.listSettingDescriptors !== 'function') return;
    const rerender = typeof renderSettings === 'function' ? renderSettings : function noop() {};
    const showStatus = (message, error) => {
      if (!status) return;
      status.textContent = message;
      status.dataset.state = error ? 'error' : '';
    };
    // One coordinator per app state across bind generations; the adapter reads
    // the current binding's callbacks through `live` (see the binding module).
    const shared = binding.sharedRegistryFor(state, ADAPTER_ID);
    Object.assign(shared.live, { state, rerender, showStatus });
    const adapterRegistry = registry || shared.registry;
    if (!adapterRegistry.has(ADAPTER_ID)) adapterRegistry.register(createNotificationsAdapter(shared.live));
    binding.bindSettingFields({
      container,
      descriptors: descriptors.listSettingDescriptors({ adapterId: ADAPTER_ID }),
      registry: adapterRegistry,
      registerListener,
      listenerOptions,
    });
  }

  return {
    NOTIFICATION_CATEGORIES,
    DEFAULT_NOTIFICATION_SETTINGS,
    normalizeNotificationSettings,
    renderNotificationsSection,
    createNotificationsAdapter,
    bindNotificationsSection,
  };
});
