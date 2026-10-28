/* renderer/shell/renderer-quick-settings-modal.js
 *
 * Tier D quick-settings modal (JENNY_UIUX_OVERHAUL_PLAN.md L91-94, resolved
 * decisions L123-138, hardening L146-181): a compact Ctrl/Cmd+, overlay over
 * a curated subset of the settings catalog -- palette, a current-model tuning
 * shortcut + force-local inference, text size + session opening. Same
 * inventory controls + write paths as the full settings page; this is a VIEW,
 * not a second store.
 *
 * DOM contract: styles/quick-settings.css documents the exact markup shape
 * (quick-settings-overlay/scrim/dialog/header/body/slot/row/row-label/
 * row-control/row-note/footer). Built lazily on first open(), appended once
 * to documentRef.body, reused after (hidden attribute toggles).
 *
 * Raw-HTML-primitive discipline: this file lives outside renderer/inventory,
 * so scripts/checks/check_no_raw_html_primitives.py forbids literal
 * form-control tag markup and matching createElement calls for those same
 * tag names here. Every interactive control is TRUSTED HTML from an
 * inventory builder (selectField/toggleSwitch/segmentedControl/actionButton)
 * assigned via innerHTML onto a plain structural host element.
 *
 * Overlay integration: renderer-overlay-manager.js owns Escape + focus-trap +
 * focus-restore + the inert background -- open()/close() just call
 * manager.open()/close() and the scrim/close button call close() directly.
 * The shell binds the manager before this modal (index.html loads it first);
 * without one the modal logs a WARN and opens with none of those.
 *
 * Persistence contracts (independent adapters -- NEVER cross-write):
 *   - appearance (palette + text size): adapters.appearance
 *     (createAppearanceAdapter, localStorage).
 *   - force-local inference: adapters.offline (createOfflineAdapter,
 *     offline.updateSettings IPC).
 *   - session opening: adapters.sessionOpen (sessionOpenPrefUtils).
 *   - runtimePrefs.getCurrent() reads the active session model only to scope
 *     the model tuning shortcut. Composer remains the sole model selector.
 *
 * Every dependency is injected via `deps`, with a globalThis-then-require()
 * production fallback mirroring renderer-settings-persistence-adapters.js /
 * renderer-status-chip-utils.js, so this module is fully testable with fake
 * deps and works unmodified from a plain <script> tag in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererQuickSettingsModalUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function resolveModule(deps, depKey, globalKey, modulePath) {
    return (deps && deps[depKey])
      || (root && root[globalKey])
      || (typeof require === 'function' ? safeRequire(modulePath) : null)
      || null;
  }

  function safeRequire(modulePath) {
    try {
      return require(modulePath);
    } catch (_error) {
      return null;
    }
  }

  function describeError(error) {
    if (error && typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return String(error == null ? jt('quickSettings.unknownError', 'unknown error') : error);
  }

  function noop() {}

  function createQuickSettingsModal(deps) {
    const options = deps || {};
    const documentRef = options.documentRef || (root && root.document) || null;
    const windowRef = options.windowRef || root || null;
    const state = options.state || {};
    const overlayManager = options.overlayManager || null;
    const adapters = options.adapters || {};
    const runtimePrefs = options.runtimePrefs || {};
    const getCurrentRuntimePreferences = typeof runtimePrefs.getCurrent === 'function'
      ? runtimePrefs.getCurrent
      : function fallbackGetCurrent() { return {}; };
    const openSettingsSection = typeof options.openSettingsSection === 'function'
      ? options.openSettingsSection
      : noop;
    const openModelTuning = typeof options.openModelTuning === 'function'
      ? options.openModelTuning
      : noop;
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : noop;
    const inertTargetsSource = options.inertTargets || [];

    const inventory = resolveModule(options, 'inventory', 'inventory', '../inventory');
    const appearanceUtils = resolveModule(options, 'appearanceUtils', 'appearanceUtils', '../shared/appearance-utils');
    const statusChipUtils = resolveModule(
      options, 'statusChipUtils', 'rendererStatusChipUtils', './renderer-status-chip-utils'
    );
    const OVERLAY_ID = 'quick-settings';

    let els = null;
    let opened = false;
    let registeredWithOverlayManager = false;
    let lifecycleGeneration = 0;
    let disposed = false;

    // One inventory builder's TRUSTED HTML, '' when the builder is absent.
    function inv(name, opts) {
      return inventory && inventory[name] ? inventory[name](opts) : '';
    }

    function resolveInertTargets() {
      let targets = inertTargetsSource;
      if (typeof targets === 'function') {
        try { targets = targets(); } catch (_error) { targets = []; }
      }
      if (!Array.isArray(targets)) targets = targets ? [targets] : [];
      return targets.filter((target, index) => target
        && typeof target.setAttribute === 'function'
        && targets.indexOf(target) === index);
    }

    // ── generic write-with-rollback-reflect helper ──
    // Every control's write goes through its OWN adapter (appearance / zoom /
    // offline) -- never merged. On failure the adapter has already rolled its
    // own cache back and rethrown; this just logs and re-renders the row so
    // the control reflects whatever the adapter now reads as current.
    function writeAdapterValue(adapter, nextValue, refreshRow, contextLabel) {
      if (!adapter || typeof adapter.write !== 'function') {
        return;
      }
      Promise.resolve(adapter.write(nextValue)).catch((error) => {
        appendClientLog('WARN', 'quick_settings.write_failed', {
          context: contextLabel,
          message: describeError(error),
        });
        try { refreshRow(); } catch (_e) { /* best-effort */ }
      });
    }

    function readAppearance() {
      if (adapters.appearance && typeof adapters.appearance.read === 'function') {
        try { return adapters.appearance.read(); } catch (_e) { /* fall through */ }
      }
      return appearanceUtils && typeof appearanceUtils.getDefaultAppearancePreferences === 'function'
        ? appearanceUtils.getDefaultAppearancePreferences()
        : {};
    }

    // ── DOM construction ──

    function buildInventoryHtml(el, html) {
      el.innerHTML = html || '';
      return el;
    }

    function buildRow(labelText, className) {
      const row = documentRef.createElement('div');
      row.className = className || 'quick-settings-row';
      const label = documentRef.createElement('span');
      label.className = 'quick-settings-row-label';
      label.textContent = labelText;
      const control = documentRef.createElement('div');
      control.className = 'quick-settings-row-control';
      row.appendChild(label);
      row.appendChild(control);
      return { row, label, control };
    }

    function buildAppearanceSlot() {
      const slotRoot = documentRef.createElement('section');
      slotRoot.className = 'quick-settings-slot';
      slotRoot.dataset.slot = 'appearance';
      const title = documentRef.createElement('h3');
      title.className = 'quick-settings-slot-title';
      title.textContent = jt('quickSettings.theme', 'Theme');
      const { row, control } = buildRow(jt('quickSettings.palette', 'Palette'));
      slotRoot.appendChild(title);
      slotRoot.appendChild(row);

      function render() {
        const presets = appearanceUtils && typeof appearanceUtils.getPalettePresets === 'function'
          ? appearanceUtils.getPalettePresets()
          : [];
        const current = readAppearance();
        buildInventoryHtml(control, inv('selectField', {
          id: 'quickSettingsPalette',
          ariaLabel: jt('quickSettings.palette', 'Palette'),
          value: current.paletteId,
          options: presets.map((p) => ({ value: p.id, label: p.label })),
        }));
        const selectEl = control.querySelector('select');
        if (selectEl) {
          selectEl.addEventListener('change', () => {
            writeAdapterValue(
              adapters.appearance,
              Object.assign({}, readAppearance(), { paletteId: selectEl.value }),
              render,
              'appearance-palette'
            );
          });
        }
      }

      return { root: slotRoot, render };
    }

    function buildModelSlot() {
      const slotRoot = documentRef.createElement('section');
      slotRoot.className = 'quick-settings-slot';
      slotRoot.dataset.slot = 'model';
      const title = documentRef.createElement('h3');
      title.className = 'quick-settings-slot-title';
      title.textContent = jt('quickSettings.modelRuntime', 'Model runtime');
      slotRoot.appendChild(title);

      const contextRow = buildRow(jt('quickSettings.modelProfile', 'Model profile'));
      slotRoot.appendChild(contextRow.row);
      const contextNote = documentRef.createElement('div');
      contextNote.className = 'quick-settings-row-note';
      slotRoot.appendChild(contextNote);

      const localOnlyRow = buildRow(jt('quickSettings.forceLocalInference', 'Force local inference'));
      localOnlyRow.label.id = 'quickSettingsLocalOnlyLabel';
      slotRoot.appendChild(localOnlyRow.row);
      // Do NOT install initToggleHandlers on this host: production's
      // renderer/inventory/index.js already delegates on `document`, and the
      // toggle handler flips RELATIVELY (no already-checked guard), so a
      // second install double-fires every click (checked:true then
      // checked:false = two conflicting offline IPC writes). Harnesses must
      // install the inventory handlers on their documentRef, exactly like
      // production does.

      const noteRow = documentRef.createElement('div');
      noteRow.className = 'quick-settings-row-note';
      const noteChip = documentRef.createElement('span');
      noteRow.appendChild(noteChip);
      slotRoot.appendChild(noteRow);
      function currentModelId() {
        const prefs = getCurrentRuntimePreferences() || {};
        return String(prefs.preferredModel || state?.status?.model || '').trim();
      }

      function renderContextWindow() {
        const modelId = currentModelId();
        const models = Array.isArray(state?.modelList?.data) ? state.modelList.data : [];
        const modelEntry = models.find((entry) => String(entry?.id || entry?.model || entry || '').trim() === modelId);
        const modelKnown = Boolean(modelId) && (
          Boolean(modelEntry)
          || String(state?.status?.model || '').trim() === modelId
        );
        const engineType = String(
          (modelEntry && typeof modelEntry === 'object' && (modelEntry.engine_type || modelEntry.engineType))
          || (String(state?.status?.model || '').trim() === modelId
            ? (state?.status?.engine || state?.status?.engine_type || state?.modelList?.engine_type)
            : '')
          || ''
        ).trim().toLowerCase();
        const tuningSupported = !engineType || ['ollama', 'vllm', 'openai-compatible'].includes(engineType);
        buildInventoryHtml(contextRow.control, tuningSupported ? inv('actionButton', {
          id: 'open-model-tuning', label: jt('quickSettings.tuneCurrentModel', 'Tune current model'), variant: 'secondary',
          disabled: !modelKnown, ariaLabel: jt('quickSettings.openCurrentModelTuning', 'Open current model tuning'),
          title: jt('quickSettings.openCurrentModelTuningTitle', 'Open per-model tuning for the current model'),
        }) : '');
        contextNote.textContent = !tuningSupported
          ? jt('quickSettings.engineOwnsGenerationControls', 'This engine owns its generation controls.')
          : modelKnown
          ? jt('quickSettings.opensModelLibraryProfile', 'Opens the authoritative per-model profile in Model Library.')
          : jt('quickSettings.selectModelFirst', 'Select a model first.');
      }

      contextRow.control.addEventListener('click', (event) => {
        const action = event.target?.closest?.('[data-action="open-model-tuning"]');
        const modelId = currentModelId();
        if (!action || !modelId || action.disabled) return;
        close();
        openModelTuning(modelId, documentRef?.activeElement || null);
      });

      function renderLocalOnly() {
        const offlineState = state && state.offline && typeof state.offline === 'object' ? state.offline : {};
        buildInventoryHtml(localOnlyRow.control, inv('toggleSwitch', {
          id: 'quickSettingsLocalOnly',
          // The row label names the switch; a second visible label repeated it.
          bare: true,
          labelledBy: 'quickSettingsLocalOnlyLabel',
          checked: offlineState.mode === 'local_only',
        }));
        renderReadinessNote(offlineState);
      }

      function renderReadinessNote(offlineState) {
        if (!statusChipUtils || typeof statusChipUtils.applyStatusChip !== 'function') {
          return;
        }
        const resolved = offlineState.resolved === true;
        const ok = offlineState.localChatReady === true;
        const chipState = !resolved ? 'loading' : (ok ? 'live' : 'error');
        const label = !resolved
          ? jt('quickSettings.checkingLocalInference', 'Checking local inference...')
          : (ok ? jt('quickSettings.localInferenceReady', 'Local inference ready') : jt('quickSettings.localInferenceBlocked', 'Local inference blocked'));
        const title = !resolved || ok ? '' : String(offlineState.summary || offlineState.unavailableReason || '');
        statusChipUtils.applyStatusChip(noteChip, { state: chipState, label, title });
      }

      localOnlyRow.control.addEventListener('inv-toggle-change', (event) => {
        const detail = (event && event.detail) || {};
        const nextMode = detail.checked ? 'local_only' : 'disabled';
        const previousOffline = adapters.offline && typeof adapters.offline.read === 'function'
          ? adapters.offline.read()
          : (state && state.offline) || {};
        writeAdapterValue(
          adapters.offline,
          { mode: nextMode, preferredLocalModel: previousOffline.preferredLocalModel || '' },
          renderLocalOnly,
          'offline-local-only'
        );
      });

      function render() {
        renderContextWindow();
        renderLocalOnly();
      }

      return { root: slotRoot, render, renderLocalOnly };
    }

    function buildDisplaySlot() {
      const slotRoot = documentRef.createElement('section');
      slotRoot.className = 'quick-settings-slot';
      slotRoot.dataset.slot = 'zoom';
      const title = documentRef.createElement('h3');
      title.className = 'quick-settings-slot-title';
      title.textContent = jt('quickSettings.display', 'Display');
      slotRoot.appendChild(title);

      const fontScaleRow = buildRow(jt('quickSettings.fontScale', 'Text size'));
      slotRoot.appendChild(fontScaleRow.row);
      const sessionOpenRow = buildRow(jt('quickSettings.sessionOpening', 'Session opening'));
      slotRoot.appendChild(sessionOpenRow.row);

      const fontScalePresets = appearanceUtils && typeof appearanceUtils.getFontScalePresets === 'function'
        ? appearanceUtils.getFontScalePresets()
        : [];
      const useSegmentedFontScale = fontScalePresets.length >= 2 && fontScalePresets.length <= 4;
      // No container-level initSegmentedHandlers either: the document-level
      // install from renderer/inventory/index.js covers this host. (Segmented
      // double-handling happens to be idempotent -- select() early-returns on
      // an already-checked option -- but the duplicate install is the same
      // latent pattern that made the toggle double-fire; see the model slot.)

      function renderFontScale() {
        const current = readAppearance();
        const options = fontScalePresets.map((p) => ({ value: p.id, label: p.label }));
        buildInventoryHtml(fontScaleRow.control, inv(useSegmentedFontScale ? 'segmentedControl' : 'selectField', {
          id: 'quickSettingsFontScale',
          ariaLabel: jt('quickSettings.fontScale', 'Text size'),
          value: current.fontScaleId,
          options,
        }));
        if (!useSegmentedFontScale) {
          const selectEl = fontScaleRow.control.querySelector('select');
          if (selectEl) {
            selectEl.addEventListener('change', () => {
              writeAdapterValue(
                adapters.appearance,
                Object.assign({}, readAppearance(), { fontScaleId: selectEl.value }),
                renderFontScale,
                'appearance-font-scale'
              );
            });
          }
        }
      }

      fontScaleRow.control.addEventListener('inv-segmented-change', (event) => {
        const nextValue = (event && event.detail && event.detail.value) || '';
        writeAdapterValue(
          adapters.appearance,
          Object.assign({}, readAppearance(), { fontScaleId: nextValue }),
          renderFontScale,
          'appearance-font-scale'
        );
      });

      function renderSessionOpen() {
        const checked = adapters.sessionOpen?.read?.() === true;
        buildInventoryHtml(sessionOpenRow.control, inv('toggleSwitch', {
          id: 'quickSettingsSessionsOpenInNewTab',
          label: jt('quickSettings.openSessionsInNewTab', 'Open sessions in a new tab'),
          checked,
        }));
      }
      sessionOpenRow.control.addEventListener('inv-toggle-change', (event) => {
        if (event.detail?.id !== 'quickSettingsSessionsOpenInNewTab') return;
        writeAdapterValue(adapters.sessionOpen, event.detail.checked === true, renderSessionOpen, 'session-open');
      });

      function render() {
        renderFontScale();
        renderSessionOpen();
      }

      return { root: slotRoot, render };
    }

    function buildDom() {
      const overlay = documentRef.createElement('div');
      overlay.className = 'quick-settings-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'quickSettingsTitle');
      overlay.hidden = true;

      const scrim = documentRef.createElement('div');
      scrim.className = 'quick-settings-scrim';
      scrim.setAttribute('aria-hidden', 'true');

      const dialog = documentRef.createElement('div');
      dialog.className = 'quick-settings-dialog';

      const header = documentRef.createElement('header');
      header.className = 'quick-settings-header';
      const heading = documentRef.createElement('h2');
      heading.id = 'quickSettingsTitle';
      heading.textContent = jt('quickSettings.title', 'Quick settings');
      const closeHost = documentRef.createElement('div');
      buildInventoryHtml(closeHost, inv('actionButton', {
        id: 'quick-settings-close',
        ariaLabel: jt('common.close', 'Close'),
        title: jt('quickSettings.close', 'Close quick settings'),
        plain: true,
        className: 'quick-settings-close',
      }));
      const closeButton = closeHost.firstElementChild;
      header.appendChild(heading);
      if (closeButton) header.appendChild(closeButton);

      const body = documentRef.createElement('div');
      body.className = 'quick-settings-body';
      const appearanceSlot = buildAppearanceSlot();
      const modelSlot = buildModelSlot();
      const displaySlot = buildDisplaySlot();
      body.appendChild(appearanceSlot.root);
      body.appendChild(modelSlot.root);
      body.appendChild(displaySlot.root);

      const footer = documentRef.createElement('footer');
      footer.className = 'quick-settings-footer';
      const allSettingsHost = documentRef.createElement('div');
      buildInventoryHtml(allSettingsHost, inv('actionButton', {
        id: 'quick-settings-all',
        label: jt('quickSettings.allSettings', 'All settings'),
        plain: true,
        className: 'quick-settings-all',
      }));
      const allSettingsButton = allSettingsHost.firstElementChild;
      if (allSettingsButton) footer.appendChild(allSettingsButton);

      dialog.appendChild(header);
      dialog.appendChild(body);
      dialog.appendChild(footer);
      overlay.appendChild(scrim);
      overlay.appendChild(dialog);

      scrim.addEventListener('click', () => close());
      if (closeButton) closeButton.addEventListener('click', () => close());
      if (allSettingsButton) {
        allSettingsButton.addEventListener('click', () => {
          close();
          try {
            openSettingsSection((state && state.ui && state.ui.activeSettingsSection) || 'models');
          } catch (_e) { /* best-effort */ }
        });
      }

      return {
        overlay, scrim, dialog, header, closeButton, body, footer, allSettingsButton,
        appearanceSlot, modelSlot, displaySlot,
      };
    }

    function ensureDom() {
      if (els) return els;
      els = buildDom();
      documentRef.body.appendChild(els.overlay);
      return els;
    }

    function refreshAll() {
      els.appearanceSlot.render();
      els.modelSlot.render();
      els.displaySlot.render();
    }

    // ── open / close / toggle ──
    function open() {
      if (disposed || !documentRef || opened) {
        return false;
      }
      lifecycleGeneration += 1;
      const openGeneration = lifecycleGeneration;
      const dom = ensureDom();
      refreshAll();
      dom.overlay.hidden = false;
      opened = true;
      registeredWithOverlayManager = typeof overlayManager?.open === 'function' && overlayManager.open({
        id: OVERLAY_ID,
        root: dom.dialog,
        onRequestClose: () => close(),
        inertTargets: resolveInertTargets(),
      }) === true;
      if (!registeredWithOverlayManager) {
        appendClientLog('WARN', 'quick_settings.overlay_manager_unavailable', { present: Boolean(overlayManager) });
      }
      const focusTarget = dom.body.querySelector('select, button, [tabindex]');
      Promise.resolve().then(() => {
        // A close() racing this microtask leaves the overlay hidden; don't
        // pull focus into it (overlayManager already restored focus).
        if (!focusTarget || !opened || disposed || lifecycleGeneration !== openGeneration) return;
        try { focusTarget.focus({ preventScroll: true }); }
        catch (_e) { try { focusTarget.focus(); } catch (_e2) { /* best-effort */ } }
      });
      try { appendClientLog('INFO', 'quick_settings.opened', {}); } catch (_e) { /* best-effort */ }
      return true;
    }

    function close() {
      if (!opened || !els) {
        return false;
      }
      lifecycleGeneration += 1;
      opened = false;
      els.overlay.hidden = true;
      if (registeredWithOverlayManager) overlayManager.close?.(OVERLAY_ID);
      registeredWithOverlayManager = false;
      return true;
    }

    function toggle() {
      if (opened) {
        close();
        return false;
      }
      return open();
    }

    function isOpen() {
      return opened;
    }

    function dispose() {
      if (disposed) return;
      if (opened) close();
      disposed = true;
      lifecycleGeneration += 1;
      if (els && els.overlay && typeof els.overlay.remove === 'function') els.overlay.remove();
      els = null;
    }

    return {
      open,
      close,
      toggle,
      isOpen,
      dispose,
    };
  }

  return { createQuickSettingsModal };
});
