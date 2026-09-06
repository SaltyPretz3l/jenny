/* renderer/shell/renderer-settings-persistence-adapters.js
 *
 * Adapter contract: read -> normalize -> optimistic apply -> write ->
 * reconcile/rollback. Dependencies are injected through the spec. Failures
 * roll back optimistic state and rethrow.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSettingsPersistenceAdapters = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function identity(value) {
    return value;
  }

  function noopLog() {}

  function describeError(error) {
    if (error && typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return String(error);
  }

  // Cheap structural equality for the "did the reconciled value differ from
  // what we optimistically applied" check. Adapter values here are plain
  // JSON-serializable data (numbers, flat preference objects) so
  // JSON.stringify comparison is sufficient and avoids pulling in a deep-
  // equal dependency for a pure-logic module.
  function valuesEqual(a, b) {
    if (a === b) {
      return true;
    }
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (_error) {
      return false;
    }
  }

  function validateSettingsAdapterSpec(spec) {
    if (!spec || typeof spec !== 'object') {
      throw new TypeError('createSettingsAdapter(spec): spec must be an object');
    }
    if (typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new TypeError('createSettingsAdapter(spec): spec.id must be a non-empty string');
    }
    if (typeof spec.read !== 'function') {
      throw new TypeError(`createSettingsAdapter("${spec.id}"): spec.read must be a function`);
    }
    if (typeof spec.write !== 'function') {
      throw new TypeError(`createSettingsAdapter("${spec.id}"): spec.write must be a function`);
    }
    if (typeof spec.getDefault !== 'function') {
      throw new TypeError(`createSettingsAdapter("${spec.id}"): spec.getDefault must be a function`);
    }
    if (spec.normalize !== undefined && typeof spec.normalize !== 'function') {
      throw new TypeError(`createSettingsAdapter("${spec.id}"): spec.normalize must be a function when provided`);
    }
    if (spec.redact !== undefined && typeof spec.redact !== 'function') {
      throw new TypeError(`createSettingsAdapter("${spec.id}"): spec.redact must be a function when provided`);
    }
    if (spec.apply !== undefined && typeof spec.apply !== 'function') {
      throw new TypeError(`createSettingsAdapter("${spec.id}"): spec.apply must be a function when provided`);
    }
    if (spec.log !== undefined && typeof spec.log !== 'function') {
      throw new TypeError(`createSettingsAdapter("${spec.id}"): spec.log must be a function when provided`);
    }
  }

  /**
   * Wrap a domain read/write pair into a settings adapter with the
   * read -> normalize -> write -> default -> redact -> rollback contract.
   *
   * @param {object} spec
   * @param {string} spec.id - stable adapter id, used in error/log messages.
   * @param {function} spec.read - () => raw stored value (sync).
   * @param {function} [spec.normalize] - (raw) => normalized value. Defaults
   *   to identity.
   * @param {function} spec.write - (normalizedValue) => (writtenValue |
   *   Promise<writtenValue> | undefined). May be sync or async. A returned
   *   value is normalized and used as the reconciled final value; returning
   *   undefined means "the input value was written as-is".
   * @param {function} spec.getDefault - () => default value for this section.
   * @param {function} [spec.redact] - (value) => a copy safe to display/log
   *   (e.g. with secrets stripped). Defaults to identity.
   * @param {function} [spec.apply] - (value) => void, optional optimistic
   *   apply hook (DOM/state mutation) called before and, on reconciliation,
   *   after the write.
   * @param {function} [spec.log] - (message) => void, optional; called with
   *   a useful message on write failure, before rollback and rethrow.
   * @returns {{ id: string, read: function, normalize: function,
   *   getDefault: function, redact: function, write: function }}
   */
  // Default listEditableKeys(): the allowlisted top-level keys for a JSON-
  // editor slice, derived from getDefault()'s own keys (a plain object's key
  // set is exactly "the fields this section owns"). A spec.listEditableKeys
  // override lets a section narrow (or otherwise compute) the allowlist
  // instead of exposing every default key.
  function defaultListEditableKeys(getDefault) {
    return function listEditableKeys() {
      let value;
      try {
        value = getDefault();
      } catch (_error) {
        return [];
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value);
      }
      return [];
    };
  }

  /**
   * UIUX-028 (adversarial-audit hardening): settle-group tracker for
   * overlapping writes on one owner. The naive per-write `previous` snapshot
   * is contaminated under overlap: read() reflects the prior write's
   * un-persisted optimistic apply, so when several in-flight writes FAIL the
   * newest write's rollback target is a value that was never persisted
   * anywhere. This tracker captures the true baseline once, when the group
   * OPENS (nothing in flight => applied == persisted), and resolves the
   * group only when the LAST in-flight write settles: the persisted final
   * value is the newest successful write's result (the authoritative backend
   * serializes same-window IPC writes in submission order), or the pre-group
   * baseline when every write failed.
   */
  function createWriteGroup() {
    let generation = 0;
    let inFlight = 0;
    let baseline;
    let successes = [];

    function open(readBaseline) {
      generation += 1;
      if (inFlight === 0) {
        baseline = readBaseline();
        successes = [];
      }
      inFlight += 1;
      return generation;
    }

    function isNewest(token) {
      return token === generation;
    }

    // Returns null while other writes are still in flight (resolution is
    // DEFERRED -- a mid-group rollback can only target a contaminated
    // snapshot); when the last write settles, returns { value } holding
    // what actually persisted.
    function settle(token, ok, value) {
      if (ok) {
        successes.push({ token, value });
      }
      inFlight -= 1;
      if (inFlight > 0) {
        return null;
      }
      let final = baseline;
      let best = -1;
      for (const success of successes) {
        if (success.token > best) {
          best = success.token;
          final = success.value;
        }
      }
      successes = [];
      return { value: final };
    }

    return { open: open, isNewest: isNewest, settle: settle };
  }

  function createSettingsAdapter(spec) {
    validateSettingsAdapterSpec(spec);

    const id = spec.id;
    const normalize = spec.normalize || identity;
    const redact = spec.redact || identity;
    const apply = typeof spec.apply === 'function' ? spec.apply : null;
    const log = typeof spec.log === 'function' ? spec.log : noopLog;

    function read() {
      return spec.read();
    }

    function getDefault() {
      return spec.getDefault();
    }

    const listEditableKeys = typeof spec.listEditableKeys === 'function'
      ? spec.listEditableKeys
      : defaultListEditableKeys(getDefault);

    // UIUX-028(b): overlapping write() calls on the same adapter (e.g. a
    // Quick Settings control clicked twice fast) race independently over the
    // network/IPC. Two hazards: an OLDER write's late completion clobbering
    // the newer applied value, and (adversarial-audit finding) a rollback
    // targeting a per-write `previous` snapshot that under overlap holds the
    // prior write's un-persisted optimistic value. The write group solves
    // both: the newest write's success reconciles immediately (it is
    // authoritative), everything else defers to the group-close resolution,
    // which rolls to the newest successful value or the true pre-group
    // baseline. Each write's promise still resolves/rejects normally so the
    // caller (logging, toasts) is unaffected.
    const writeGroup = createWriteGroup();
    let lastApplied;

    function applyValue(value) {
      apply(value); // may throw; callers handle
      lastApplied = value;
    }

    function reconcileGroupClose(closed) {
      if (!closed || !apply || valuesEqual(closed.value, lastApplied)) {
        return;
      }
      try {
        applyValue(closed.value);
      } catch (error) {
        log(`settings adapter "${id}" rollback apply failed: ${describeError(error)}`);
      }
    }

    function write(value) {
      const next = normalize(value);

      let previous;
      try {
        previous = normalize(read());
      } catch (_error) {
        previous = getDefault();
      }
      const token = writeGroup.open(() => previous);

      if (apply) {
        // The optimistic apply gets the same rollback + log treatment as a
        // failed write: a partial DOM mutation must not strand and the error
        // must surface as a rejection, never a synchronous throw.
        try {
          applyValue(next);
        } catch (error) {
          reconcileGroupClose(writeGroup.settle(token, false));
          log(`settings adapter "${id}" optimistic apply failed: ${describeError(error)}`);
          return Promise.reject(error);
        }
      }

      return Promise.resolve()
        .then(() => spec.write(next))
        .then((result) => {
          const finalValue = result === undefined ? next : normalize(result);
          const closed = writeGroup.settle(token, true, finalValue);
          const shouldReconcile = Boolean(apply)
            && (Boolean(closed) || writeGroup.isNewest(token));
          const reconciledValue = closed ? closed.value : finalValue;
          if (shouldReconcile && !valuesEqual(reconciledValue, lastApplied)) {
            try {
              applyValue(reconciledValue);
            } catch (error) {
              log(`settings adapter "${id}" reconciliation apply failed: ${describeError(error)}`);
            }
          }
          return finalValue;
        })
        .catch((error) => {
          // Rollback (via the group close) must never mask the original
          // write failure: a throwing apply() is logged inside
          // reconcileGroupClose, then the write error still surfaces.
          reconcileGroupClose(writeGroup.settle(token, false));
          log(`settings adapter "${id}" write failed: ${describeError(error)}`);
          throw error;
        });
    }

    return {
      id: id,
      read: read,
      normalize: normalize,
      getDefault: getDefault,
      redact: redact,
      write: write,
      listEditableKeys: listEditableKeys,
    };
  }

  function resolveAppearanceUtils(deps) {
    return (deps && deps.appearanceUtils)
      || (root && root.appearanceUtils)
      || (typeof require === 'function' ? require('../shared/appearance-utils') : null)
      || null;
  }

  /**
   * Proof adapter #1: appearance preferences over an injected localStorage-
   * shaped `storage`. Thin wrapper around renderer/shared/appearance-utils.js
   * -- reuses its read/write/normalize/default, does not reimplement them.
   *
   * @param {object} deps
   * @param {{ getItem: function, setItem: function }} deps.storage
   * @param {object} [deps.appearanceUtils] - test seam; defaults to the
   *   shared appearance-utils module (via globalThis or require()).
   * @param {function} [deps.log]
   */
  function createAppearanceAdapter(deps) {
    const settings = deps || {};
    const storage = settings.storage;
    const appearanceUtils = resolveAppearanceUtils(settings);
    if (!appearanceUtils) {
      throw new TypeError('createAppearanceAdapter(deps): appearance-utils module could not be resolved');
    }
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new TypeError('createAppearanceAdapter(deps): deps.storage must be a localStorage-shaped object');
    }

    return createSettingsAdapter({
      id: 'appearance',
      read: () => appearanceUtils.loadAppearancePreferences(storage),
      normalize: (raw) => appearanceUtils.normalizeAppearancePreferences(raw),
      write: (value) => appearanceUtils.saveAppearancePreferences(storage, value),
      getDefault: () => appearanceUtils.getDefaultAppearancePreferences(),
      // No secrets in appearance preferences (palette/typography/motion ids);
      // redact is lossless identity.
      redact: identity,
      apply: typeof settings.applyAppearance === 'function' ? settings.applyAppearance : undefined,
      log: settings.log,
    });
  }

  function resolveChatZoomUtils(deps) {
    return (deps && deps.chatZoomUtils)
      || (root && root.chatZoomUtils)
      || (typeof require === 'function' ? require('../chat/chat-zoom-utils') : null)
      || null;
  }

  /**
   * Proof adapter #2: chat zoom percent. Mirrors the optimistic+rollback
   * precedent in applyChatZoomPercent()
   * (renderer/shell/renderer-lifecycle-appearance-utils.js:100-129): apply
   * the new value immediately, persist via IPC, reconcile to whatever
   * zoomPercent the persisted response carries, and roll back to the
   * previous value on failure. The clamp bounds are the real
   * normalizeChatZoomPercent from renderer/chat/chat-zoom-utils.js (85-135,
   * step 5, default 100) -- not reinvented here.
   *
   * @param {object} deps
   * @param {function} deps.updateSettings - ({ zoomPercent }) =>
   *   Promise<{ zoomPercent }> | { zoomPercent } | undefined. The IPC call
   *   (e.g. windowObject.jennyShell.chatUi.updateSettings).
   * @param {function} deps.getCurrent - () => current zoom percent.
   * @param {function} [deps.applyZoom] - (percent) => void, optimistic
   *   DOM/state apply hook (e.g. applyChatZoomToDocument).
   * @param {function} [deps.log]
   * @param {object} [deps.chatZoomUtils] - test seam; defaults to the shared
   *   chat-zoom-utils module (via globalThis or require()).
   */
  function createZoomAdapter(deps) {
    const settings = deps || {};
    const chatZoomUtils = resolveChatZoomUtils(settings);
    if (!chatZoomUtils) {
      throw new TypeError('createZoomAdapter(deps): chat-zoom-utils module could not be resolved');
    }
    if (typeof settings.updateSettings !== 'function') {
      throw new TypeError('createZoomAdapter(deps): deps.updateSettings must be a function');
    }
    if (typeof settings.getCurrent !== 'function') {
      throw new TypeError('createZoomAdapter(deps): deps.getCurrent must be a function');
    }

    const normalizeZoom = chatZoomUtils.normalizeChatZoomPercent;
    const getDefaultZoom = chatZoomUtils.getDefaultChatZoomPercent;

    return createSettingsAdapter({
      id: 'chatZoom',
      read: () => settings.getCurrent(),
      normalize: (raw) => normalizeZoom(raw),
      write: (value) => Promise.resolve(settings.updateSettings({ zoomPercent: value }))
        .then((response) => {
          const persisted = response && response.zoomPercent !== undefined
            ? response.zoomPercent
            : value;
          return normalizeZoom(persisted);
        }),
      getDefault: () => normalizeZoom(getDefaultZoom()),
      redact: identity,
      apply: typeof settings.applyZoom === 'function' ? settings.applyZoom : undefined,
      log: settings.log,
    });
  }

  // Legal offline-intelligence mode values (services/shell-config-state.js
  // DEFAULT_OFFLINE_INTELLIGENCE + normalizeOfflineMode, :70-73/:123-127):
  // 'local_only' or 'disabled' (anything else coerces to 'disabled'). Kept as
  // a small self-contained normalizer here rather than requiring the
  // services/ module -- the renderer bundle loads via plain <script> tags
  // (no bundler), so a services/ backend module is not require()-able in the
  // browser; the two-line mode/preferredLocalModel shape is simple enough
  // that duplicating the services-layer contract locally is safer than
  // reaching across the process boundary.
  function normalizeOfflineSlice(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const mode = String(source.mode || '').trim().toLowerCase() === 'local_only'
      ? 'local_only'
      : 'disabled';
    const preferredLocalModel = String(
      source.preferredLocalModel || source.preferred_local_model || ''
    ).trim();
    return { mode: mode, preferredLocalModel: preferredLocalModel };
  }

  /**
   * Proof adapter #3: offline-intelligence mode + preferred local model, over
   * IPC (window.jennyShell.offline.updateSettings). The IPC response echoes
   * the FULL recomputed live offline state (services/offline-intelligence-
   * service.js:443-449 returns getState(), which includes readiness fields
   * like localChatReady/summary/localCatalog) -- normalize projects that
   * echo down to the two editable keys so a stray readiness field can never
   * leak into the JSON-editor slice or get written back as if it were
   * user-owned config.
   *
   * @param {object} deps
   * @param {function} deps.updateSettings - (patch) => Promise<offlineState> |
   *   offlineState. The IPC call (e.g. windowObject.jennyShell.offline.updateSettings).
   * @param {function} deps.getCurrent - () => current offline state, already
   *   projected/normalized by the caller (production: the renderer's cached
   *   `state.offline`).
   * @param {function} [deps.apply] - (value) => void, optional optimistic
   *   apply hook.
   * @param {function} [deps.log]
   */
  function createOfflineAdapter(deps) {
    const settings = deps || {};
    if (typeof settings.updateSettings !== 'function') {
      throw new TypeError('createOfflineAdapter(deps): deps.updateSettings must be a function');
    }
    if (typeof settings.getCurrent !== 'function') {
      throw new TypeError('createOfflineAdapter(deps): deps.getCurrent must be a function');
    }

    return createSettingsAdapter({
      id: 'offline',
      read: () => settings.getCurrent(),
      normalize: (raw) => normalizeOfflineSlice(raw),
      write: (value) => Promise.resolve(settings.updateSettings({
        mode: value.mode,
        preferredLocalModel: value.preferredLocalModel,
      })).then((response) => normalizeOfflineSlice(response)),
      // Matches DEFAULT_OFFLINE_INTELLIGENCE (services/shell-config-state.js:70-73).
      getDefault: () => ({ mode: 'disabled', preferredLocalModel: '' }),
      // No secrets in mode/preferredLocalModel; redact is lossless identity.
      redact: identity,
      apply: typeof settings.apply === 'function' ? settings.apply : undefined,
      log: settings.log,
    });
  }

  return {
    createSettingsAdapter: createSettingsAdapter,
    createWriteGroup: createWriteGroup,
    createAppearanceAdapter: createAppearanceAdapter,
    createZoomAdapter: createZoomAdapter,
    createOfflineAdapter: createOfflineAdapter,
  };
});
