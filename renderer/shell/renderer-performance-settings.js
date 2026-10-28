/* renderer/shell/renderer-performance-settings.js - Settings > Appearance: the two performance rows (UMD).

   Row 59 checkpoint 6. "Show performance in the session rail" (show_counter) and "GPU memory
   warnings" (gpu_warnings_enabled) live in shell-config performanceTelemetry and are read and written
   only through window.jennyShell.performance (getSnapshot / updateSettings / onChanged); nothing is
   stored in the renderer. This module owns:
     - a tiny per-window store of the two booleans, hydrated by getSnapshot and kept current by the
       bridge's settings invalidations;
     - the Settings adapter ("performance", patch mode) the shared field binding writes through: one
       updateSettings call per batch, acknowledged only when the echoed settings match the edit;
     - mountRows(section, mountSettingRow): the Appearance card's hook, which also reveals the group
       only when the bridge exists (absent bridge = the group stays hidden, nothing errors).
   The wire names double as descriptor keys (renderer-settings-field-descriptors.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererPerformanceSettings = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;
  // The bridge scopes every snapshot to a session id; these settings are host-wide, so a fixed id asks for no chat.
  const HOST_SESSION_ID = null; // host scope: settings + GPU, no inference
  const KEYS = Object.freeze(['show_counter', 'gpu_warnings_enabled']);
  const DEFAULTS = Object.freeze({ show_counter: false, gpu_warnings_enabled: true });
  const ROWS = Object.freeze([
    { id: 'performanceShowCounterToggle', key: 'show_counter' },
    { id: 'performanceGpuWarningsToggle', key: 'gpu_warnings_enabled' },
  ]);
  const GROUP_ID = 'appearancePerformanceGroup';

  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  function pickBooleans(source) {
    const out = {};
    if (!isObject(source)) return out;
    KEYS.forEach((key) => { if (typeof source[key] === 'boolean') out[key] = source[key]; });
    return out;
  }

  function createStore(windowRef) {
    const win = windowRef || root;
    const listeners = new Set();
    let values = { ...DEFAULTS };
    let hydrated = false;
    let hydrating = false;
    let invalidated = false; // a settings invalidation arrived while a snapshot was in flight
    let edits = 0; // bumped by every set() from an edit or an acknowledgement
    let unsubscribe = null;
    let disposed = false;

    const bridge = () => {
      const api = win && win.jennyShell && win.jennyShell.performance;
      return api && typeof api.getSnapshot === 'function' ? api : null;
    };
    const emit = () => listeners.forEach((listener) => { try { listener(values); } catch (_error) { /* a listener never breaks the store */ } });

    function merge(next) {
      const merged = { ...values, ...pickBooleans(next) };
      const changed = KEYS.some((key) => merged[key] !== values[key]);
      values = merged;
      if (changed) emit();
      return values;
    }
    function set(next) {
      edits += 1;
      return merge(next);
    }

    // One snapshot in flight at a time. A snapshot requested before an edit or an
    // acknowledgement landed is older than the value it would overwrite, so it is
    // dropped and asked again; so is one that an invalidation overtook.
    async function refresh() {
      const api = bridge();
      if (!api || disposed) return values;
      if (hydrating) { invalidated = true; return values; }
      hydrating = true;
      try {
        do {
          invalidated = false;
          const asked = edits;
          const response = await api.getSnapshot({ schema_version: SCHEMA_VERSION, session_id: HOST_SESSION_ID });
          if (disposed) break;
          if (asked !== edits) invalidated = true;
          else if (isObject(response) && response.ok === true && isObject(response.settings)) {
            hydrated = true;
            merge(response.settings);
          }
        } while (invalidated);
      } catch (_error) { /* the rows keep their last value; the next invalidation retries */ } finally { hydrating = false; }
      return values;
    }

    // First use: hydrate once and follow settings invalidations (the only scope this store cares about).
    function start() {
      if (hydrated || hydrating || disposed || unsubscribe) return;
      const api = bridge();
      if (!api) return;
      if (typeof api.onChanged === 'function') {
        try {
          const release = api.onChanged((event) => { if (isObject(event) && event.scope === 'settings') void refresh(); });
          if (typeof release === 'function') unsubscribe = release;
        } catch (_error) { /* an invalidation feed is optional */ }
      }
      void refresh();
    }

    function dispose() {
      disposed = true;
      listeners.clear();
      try { if (unsubscribe) unsubscribe(); } catch (_error) { /* best-effort teardown */ }
      unsubscribe = null;
    }

    return {
      bridge, get: () => values, set, refresh, start, dispose,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
  }

  const stores = new WeakMap();
  const boundSections = new WeakSet();
  function storeFor(windowRef) {
    const win = windowRef || root;
    let store = stores.get(win);
    if (!store) { store = createStore(win); stores.set(win, store); }
    return store;
  }

  /* The adapter the field binding registers (id "performance"). Patch mode: a batch is the changed
     booleans only; the echo must confirm every one of them or the edit is rolled back and reported. */
  function createAdapter({ store = storeFor(root), confirmError } = {}) {
    const fail = () => (typeof confirmError === 'function' ? confirmError() : new Error('The saved setting could not be confirmed.'));
    return {
      id: 'performance',
      mode: 'patch',
      optimistic: true,
      read: () => ({ ...store.get() }),
      normalize: (source) => ({ ...DEFAULTS, ...pickBooleans(source) }),
      write: (patch) => {
        const api = store.bridge();
        const changes = pickBooleans(patch);
        if (!api || typeof api.updateSettings !== 'function' || !Object.keys(changes).length) throw fail();
        return api.updateSettings({ schema_version: SCHEMA_VERSION, ...changes });
      },
      ack: (result, patch) => {
        const echoed = isObject(result) && result.ok === true && isObject(result.settings) ? pickBooleans(result.settings) : null;
        if (!echoed || Object.keys(pickBooleans(patch)).some((key) => echoed[key] !== patch[key])) throw fail();
        store.set(echoed);
        return { ...DEFAULTS, ...echoed };
      },
      apply: (next) => { store.set(next); },
    };
  }

  /* Called from the Appearance card's render with the card element and its row mounter. Reveals the
     group when the bridge exists, hydrates once, and re-mounts the two rows when the store changes. */
  function mountRows(section, mountSettingRow, windowRef) {
    const store = storeFor(windowRef);
    const group = section && typeof section.querySelector === 'function' ? section.querySelector(`#${GROUP_ID}`) : null;
    const available = Boolean(store.bridge());
    if (group) group.hidden = !available;
    if (!available || typeof mountSettingRow !== 'function') return false;
    store.start();
    const mount = () => ROWS.forEach((row) => mountSettingRow(section, row.id, store.get()[row.key]));
    mount();
    if (!boundSections.has(section)) {
      boundSections.add(section);
      store.subscribe(mount);
    }
    return true;
  }

  return { HOST_SESSION_ID, KEYS, DEFAULTS, GROUP_ID, createStore, storeFor, createAdapter, mountRows };
});
