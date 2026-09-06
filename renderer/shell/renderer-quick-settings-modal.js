/* renderer/shell/renderer-quick-settings-modal.js
 *
 * Tier D quick-settings modal (JENNY_UIUX_OVERHAUL_PLAN.md L91-94, resolved
 * decisions L123-138, hardening L146-181): a compact Ctrl/Cmd+, overlay over
 * a curated subset of the settings catalog -- theme/palette, model context +
 * force-local inference, font-scale + chat-zoom. Same inventory controls + write paths
 * as the full settings page; this is a VIEW, not a second store.
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
 * focus-restore -- open()/close() just call manager.open()/close() and the
 * scrim/close button call close() directly. If overlayManager is absent
 * (older wiring / a harness that never built one), a local guarded Escape
 * keydown on documentRef is the fallback (no other Escape handling here).
 *
 * Persistence contracts (three independent adapters -- NEVER cross-write):
 *   - appearance (palette + font-scale): adapters.appearance
 *     (createAppearanceAdapter, localStorage).
 *   - chat zoom: adapters.zoom (createZoomAdapter, chatUi.updateSettings IPC).
 *   - force-local inference: adapters.offline (createOfflineAdapter,
 *     offline.updateSettings IPC).
 *   - runtimePrefs.getCurrent() reads the active session model only to scope
 *     model-specific context tuning. Composer remains the sole model selector.
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
    return String(error == null ? 'unknown error' : error);
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
    const chatZoomUtils = resolveModule(options, 'chatZoomUtils', 'chatZoomUtils', '../chat/chat-zoom-utils');
    const statusChipUtils = resolveModule(
      options, 'statusChipUtils', 'rendererStatusChipUtils', './renderer-status-chip-utils'
    );
    const OVERLAY_ID = 'quick-settings';

    let els = null;
    let opened = false;
    let fallbackEscapeAttached = false;
    let registeredWithOverlayManager = false;
    let lifecycleGeneration = 0;
    let disposed = false;
    let fallbackInertRecords = [];

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

    function applyFallbackInert(targets) {
      fallbackInertRecords = targets.map((target) => {
        const hadAttribute = target.hasAttribute('inert');
        const hasProperty = 'inert' in target;
        const record = {
          target,
          hadAttribute,
          attributeValue: hadAttribute ? target.getAttribute('inert') : null,
          hasProperty,
          propertyValue: hasProperty ? Boolean(target.inert) : false,
        };
        if (hasProperty) target.inert = true;
        else target.setAttribute('inert', '');
        return record;
      });
    }

    function restoreFallbackInert() {
      fallbackInertRecords.forEach((record) => {
        if (record.hasProperty) record.target.inert = record.propertyValue;
        if (record.hadAttribute) {
          record.target.setAttribute('inert', record.attributeValue == null ? '' : record.attributeValue);
        } else {
          record.target.removeAttribute('inert');
        }
      });
      fallbackInertRecords = [];
    }

    // ── flag gate ──
    function isFeatureEnabled() {
      const flags = state && state.features && state.features.featureFlags;
      return !flags || flags.quick_settings !== false;
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
      return { row, control };
    }

    function buildAppearanceSlot() {
      const slotRoot = documentRef.createElement('section');
      slotRoot.className = 'quick-settings-slot';
      slotRoot.dataset.slot = 'appearance';
      const title = documentRef.createElement('h3');
      title.className = 'quick-settings-slot-title';
      title.textContent = 'Theme';
      const { row, control } = buildRow('Palette');
      slotRoot.appendChild(title);
      slotRoot.appendChild(row);

      function render() {
        const presets = appearanceUtils && typeof appearanceUtils.getPalettePresets === 'function'
          ? appearanceUtils.getPalettePresets()
          : [];
        const current = readAppearance();
        buildInventoryHtml(control, inventory && inventory.selectField ? inventory.selectField({
          id: 'quickSettingsPalette',
          ariaLabel: 'Palette',
          value: current.paletteId,
          options: presets.map((p) => ({ value: p.id, label: p.label })),
        }) : '');
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
      title.textContent = 'Model runtime';
      slotRoot.appendChild(title);

      const contextRow = buildRow('Model profile');
      slotRoot.appendChild(contextRow.row);
      const contextNote = documentRef.createElement('div');
      contextNote.className = 'quick-settings-row-note';
      slotRoot.appendChild(contextNote);

      const localOnlyRow = buildRow('Force local inference');
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
        buildInventoryHtml(contextRow.control, tuningSupported && inventory && inventory.actionButton ? inventory.actionButton({
          id: 'open-model-tuning', label: 'Tune current model', variant: 'secondary',
          disabled: !modelKnown, ariaLabel: 'Open current model tuning',
          title: 'Open per-model tuning for the current model',
        }) : '');
        contextNote.textContent = !tuningSupported
          ? 'This engine owns its generation controls.'
          : modelKnown
          ? 'Opens the authoritative per-model profile in Model Library.'
          : 'Select a model first.';
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
        buildInventoryHtml(localOnlyRow.control, inventory && inventory.toggleSwitch ? inventory.toggleSwitch({
           id: 'quickSettingsLocalOnly',
           label: 'Force local inference',
          checked: offlineState.mode === 'local_only',
        }) : '');
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
          ? 'Checking local inference...'
          : (ok ? 'Local inference ready' : 'Local inference blocked');
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
      title.textContent = 'Display';
      slotRoot.appendChild(title);

      const fontScaleRow = buildRow('Font scale');
      slotRoot.appendChild(fontScaleRow.row);
      const chatZoomRow = buildRow('Chat zoom');
      slotRoot.appendChild(chatZoomRow.row);
      const sessionOpenRow = buildRow('Session opening');
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
        const html = useSegmentedFontScale
          ? (inventory && inventory.segmentedControl ? inventory.segmentedControl({
            id: 'quickSettingsFontScale',
            ariaLabel: 'Font scale',
            value: current.fontScaleId,
            options,
          }) : '')
          : (inventory && inventory.selectField ? inventory.selectField({
            id: 'quickSettingsFontScale',
            ariaLabel: 'Font scale',
            value: current.fontScaleId,
            options,
          }) : '');
        buildInventoryHtml(fontScaleRow.control, html);
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

      function renderChatZoom() {
        const zoomOptions = chatZoomUtils && typeof chatZoomUtils.getChatZoomOptions === 'function'
          ? chatZoomUtils.getChatZoomOptions().map((o) => ({ value: String(o.value), label: o.label }))
          : [];
        const currentZoom = adapters.zoom && typeof adapters.zoom.read === 'function'
          ? adapters.zoom.read()
          : (chatZoomUtils && typeof chatZoomUtils.getDefaultChatZoomPercent === 'function'
            ? chatZoomUtils.getDefaultChatZoomPercent()
            : 100);
        buildInventoryHtml(chatZoomRow.control, inventory && inventory.selectField ? inventory.selectField({
          id: 'quickSettingsChatZoom',
          ariaLabel: 'Chat zoom',
          value: String(currentZoom),
          options: zoomOptions,
        }) : '');
        const selectEl = chatZoomRow.control.querySelector('select');
        if (selectEl) {
          selectEl.addEventListener('change', () => {
            writeAdapterValue(adapters.zoom, Number(selectEl.value), renderChatZoom, 'chat-zoom');
          });
        }
      }

      function renderSessionOpen() {
        const checked = adapters.sessionOpen?.read?.() === true;
        buildInventoryHtml(sessionOpenRow.control, inventory?.toggleSwitch ? inventory.toggleSwitch({
          id: 'quickSettingsSessionsOpenInNewTab',
          label: 'Open sessions in a new tab',
          checked,
        }) : '');
      }
      sessionOpenRow.control.addEventListener('inv-toggle-change', (event) => {
        if (event.detail?.id !== 'quickSettingsSessionsOpenInNewTab') return;
        writeAdapterValue(adapters.sessionOpen, event.detail.checked === true, renderSessionOpen, 'session-open');
      });

      function render() {
        renderFontScale();
        renderChatZoom();
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
      heading.textContent = 'Quick settings';
      const closeHost = documentRef.createElement('div');
      buildInventoryHtml(closeHost, inventory && inventory.actionButton ? inventory.actionButton({
        id: 'quick-settings-close',
        ariaLabel: 'Close',
        title: 'Close quick settings',
        plain: true,
        className: 'quick-settings-close',
      }) : '');
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
      buildInventoryHtml(allSettingsHost, inventory && inventory.actionButton ? inventory.actionButton({
        id: 'quick-settings-all',
        label: 'All settings',
        plain: true,
        className: 'quick-settings-all',
      }) : '');
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

    // ── fallback Escape (only wired when overlayManager is absent) ──
    function handleFallbackEscape(event) {
      if (!opened) return;
      if (event.defaultPrevented) return;
      if (event.isComposing) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    }

    function attachFallbackEscape() {
      if (fallbackEscapeAttached || !documentRef) return;
      documentRef.addEventListener('keydown', handleFallbackEscape, true);
      fallbackEscapeAttached = true;
    }

    function detachFallbackEscape() {
      if (!fallbackEscapeAttached || !documentRef) return;
      documentRef.removeEventListener('keydown', handleFallbackEscape, true);
      fallbackEscapeAttached = false;
    }

    // ── open / close / toggle ──
    function open() {
      if (disposed || !documentRef || !isFeatureEnabled() || opened) {
        return false;
      }
      lifecycleGeneration += 1;
      const openGeneration = lifecycleGeneration;
      const dom = ensureDom();
      refreshAll();
      dom.overlay.hidden = false;
      opened = true;
      const inertTargets = resolveInertTargets();
      if (overlayManager && typeof overlayManager.open === 'function') {
        registeredWithOverlayManager = overlayManager.open({
          id: OVERLAY_ID,
          root: dom.dialog,
          onRequestClose: () => close(),
          inertTargets,
        }) === true;
      }
      if (!registeredWithOverlayManager) {
        applyFallbackInert(inertTargets);
        attachFallbackEscape();
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
      detachFallbackEscape();
      if (registeredWithOverlayManager && overlayManager && typeof overlayManager.close === 'function') {
        overlayManager.close(OVERLAY_ID);
      } else {
        restoreFallbackInert();
      }
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
      detachFallbackEscape();
      if (registeredWithOverlayManager && overlayManager && typeof overlayManager.close === 'function') {
        overlayManager.close(OVERLAY_ID);
      } else {
        restoreFallbackInert();
      }
      registeredWithOverlayManager = false;
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
