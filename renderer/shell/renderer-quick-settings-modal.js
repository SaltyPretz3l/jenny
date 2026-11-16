/* renderer/shell/renderer-quick-settings-modal.js
 *
 * Quick settings (Ctrl/Cmd+,): a compact overlay over a curated subset of the
 * settings catalog. Three groups: Appearance (theme swatches, text size, Wide
 * transcript), Model (current model + Tune link, Force local with a live
 * status line) and Chats (open in a new tab). A VIEW over the existing write
 * paths, not a second store. styles/quick-settings.css documents the markup.
 *
 * Raw-HTML-primitive discipline: scripts/checks/check_no_raw_html_primitives.py
 * forbids literal form-control markup here, so every interactive control is
 * TRUSTED HTML from an inventory builder assigned via innerHTML onto a plain
 * host element. The overlay manager owns Escape, the focus trap, focus restore
 * and the inert background.
 *
 * Adapters never cross-write: appearance (palette + text size), offline
 * (force local), sessionOpen. chatWidth ({read, toggle}) is the one Wide
 * transcript toggle owned by the shell controllers. runtimePrefs.getCurrent()
 * only scopes the Tune link; the composer stays the sole model selector.
 *
 * Every dependency is injected via `deps`, with a globalThis-then-require()
 * production fallback, so the module is testable with fakes and loads from a
 * plain <script> tag.
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
    const fnOrNoop = (value) => (typeof value === 'function' ? value : noop);
    const openSettingsSection = fnOrNoop(options.openSettingsSection);
    const openModelTuning = fnOrNoop(options.openModelTuning);
    const appendClientLog = fnOrNoop(options.appendClientLog);
    const onOpen = fnOrNoop(options.onOpen);
    const onOfflineWritten = fnOrNoop(options.onOfflineWritten);
    const inertTargetsSource = options.inertTargets || [];

    const inventory = resolveModule(options, 'inventory', 'inventory', '../inventory');
    const appearanceUtils = resolveModule(options, 'appearanceUtils', 'appearanceUtils', '../shared/appearance-utils');
    const statusChipUtils = resolveModule(
      options, 'statusChipUtils', 'rendererStatusChipUtils', './renderer-status-chip-utils'
    );
    const offlineUtils = resolveModule(options, 'offlineUtils', 'rendererOfflineUtils', '../features/renderer-offline-utils');
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

    // Each control writes through its OWN adapter. On failure the adapter has
    // already rolled back; this logs and re-renders the row from its value.
    function writeAdapterValue(adapter, nextValue, refreshRow, contextLabel, onWritten) {
      if (!adapter || typeof adapter.write !== 'function') return;
      Promise.resolve(adapter.write(nextValue)).then(() => { try { onWritten?.(); } catch (_e) { /* best-effort */ } }, (error) => {
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

    function buildInventoryHtml(el, html) {
      el.innerHTML = html || '';
      return el;
    }

    function buildButton(opts) {
      return buildInventoryHtml(documentRef.createElement('div'), inv('actionButton', opts)).firstElementChild
        || documentRef.createElement('span');
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

    function buildSlot(slotName, titleText) {
      const slotRoot = documentRef.createElement('section');
      slotRoot.className = 'quick-settings-slot';
      slotRoot.dataset.slot = slotName;
      const title = documentRef.createElement('h3');
      title.className = 'quick-settings-slot-title';
      title.textContent = titleText;
      slotRoot.appendChild(title);
      return slotRoot;
    }

    // In-place switch sync keeps focus; a full re-render is the fallback.
    function syncSwitch(host, checked, renderFull) {
      const track = host.querySelector('[data-inv-toggle]');
      const setChecked = inventory && inventory.toggleSwitch && inventory.toggleSwitch.setChecked;
      if (track && typeof setChecked === 'function') setChecked(track, checked);
      else renderFull();
    }

    // Dark palettes first, then light, the first light one starting a new group.
    function paletteOptions(presets) {
      const ordered = presets.filter((p) => p.scheme !== 'light').concat(presets.filter((p) => p.scheme === 'light'));
      const firstLightId = (presets.find((p) => p.scheme === 'light') || {}).id;
      return ordered.map((p) => {
        const colors = typeof appearanceUtils.resolvePaletteBootColors === 'function'
          ? appearanceUtils.resolvePaletteBootColors(p.id)
          : null;
        const pair = colors ? [colors.bg, colors.accent] : null;
        const option = { value: p.id, label: p.label };
        if (pair) option.swatch = pair;
        if (p.id === firstLightId && ordered[0] !== p) option.groupStart = true;
        return option;
      });
    }

    function buildAppearanceSlot() {
      const slotRoot = buildSlot('appearance', jt('quickSettings.appearance', 'Appearance'));
      const themeRow = buildRow(jt('quickSettings.theme', 'Theme'));
      themeRow.row.classList.add('quick-settings-row--stacked');
      const themeValue = documentRef.createElement('span');
      themeValue.className = 'quick-settings-row-value';
      themeRow.label.appendChild(themeValue);
      const fontScaleRow = buildRow(jt('quickSettings.fontScale', 'Text size'));
      const wideRow = buildRow(jt('quickSettings.wideTranscript', 'Wide transcript'));
      wideRow.label.id = 'quickSettingsWideLabel';
      slotRoot.append(themeRow.row, fontScaleRow.row, wideRow.row);

      const presets = appearanceUtils && typeof appearanceUtils.getPalettePresets === 'function'
        ? appearanceUtils.getPalettePresets()
        : [];
      const fontScalePresets = appearanceUtils && typeof appearanceUtils.getFontScalePresets === 'function'
        ? appearanceUtils.getFontScalePresets()
        : [];
      // No container-level install of the inventory toggle/segmented handlers: the
      // document-level install (renderer/inventory/index.js) covers these hosts, and
      // the toggle handler flips relatively, so a second install double-fires.

      function showPaletteLabel(paletteId) {
        const preset = presets.find((p) => p.id === paletteId);
        themeValue.textContent = preset ? preset.label : '';
      }

      function renderTheme() {
        const current = readAppearance();
        buildInventoryHtml(themeRow.control, inv('segmentedControl', {
          id: 'quickSettingsPalette',
          ariaLabel: jt('quickSettings.theme', 'Theme'),
          value: current.paletteId,
          options: paletteOptions(presets),
        }));
        showPaletteLabel(current.paletteId);
      }

      themeRow.control.addEventListener('inv-segmented-change', (event) => {
        const paletteId = (event && event.detail && event.detail.value) || '';
        // The swatch the user is on keeps focus; only the value label follows.
        showPaletteLabel(paletteId);
        writeAdapterValue(
          adapters.appearance,
          Object.assign({}, readAppearance(), { paletteId }),
          renderTheme,
          'appearance-palette'
        );
      });

      function renderFontScale() {
        const current = readAppearance();
        buildInventoryHtml(fontScaleRow.control, inv('segmentedControl', {
          id: 'quickSettingsFontScale',
          ariaLabel: jt('quickSettings.fontScale', 'Text size'),
          value: current.fontScaleId,
          options: fontScalePresets.map((p) => ({ value: p.id, label: p.label })),
        }));
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

      // The shell owns the one Wide toggle; read at click time, never cached.
      const chatWidth = options.chatWidth || null;
      const canToggleWide = () => (typeof chatWidth?.available === 'function' ? chatWidth.available() === true : typeof chatWidth?.toggle === 'function');
      const readWide = () => typeof chatWidth?.read === 'function' && chatWidth.read() === true;

      function renderWide() {
        buildInventoryHtml(wideRow.control, inv('toggleSwitch', {
          id: 'quickSettingsWideTranscript',
          bare: true,
          labelledBy: 'quickSettingsWideLabel',
          checked: readWide(),
          disabled: !canToggleWide(),
          tooltip: canToggleWide() ? undefined : jt('quickSettings.wideTranscriptUnavailable', 'Open a chat to use this'),
        }));
      }

      wideRow.control.addEventListener('inv-toggle-change', (event) => {
        if (!canToggleWide() || event.detail?.id !== 'quickSettingsWideTranscript') return;
        try { chatWidth.toggle(); } catch (error) { appendClientLog('WARN', 'quick_settings.write_failed', { context: 'chat-width', message: describeError(error) }); }
        syncSwitch(wideRow.control, readWide(), renderWide);
      });

      return {
        root: slotRoot,
        render() { renderTheme(); renderFontScale(); renderWide(); },
      };
    }

    function buildModelSlot() {
      const slotRoot = buildSlot('model', jt('quickSettings.model', 'Model'));

      const modelRow = buildRow('');
      modelRow.label.classList.add('quick-settings-model-name');
      const localOnlyRow = buildRow(jt('quickSettings.forceLocalInference', 'Force local inference'));
      localOnlyRow.label.id = 'quickSettingsLocalOnlyLabel';
      const noteRow = documentRef.createElement('div');
      noteRow.className = 'quick-settings-row-note';
      const noteChip = documentRef.createElement('span');
      const noteLink = documentRef.createElement('span');
      noteRow.append(noteChip, noteLink);
      // E64: the owner's sentence under the switch, only while the Team feature applies.
      const teamNoteRow = documentRef.createElement('div');
      teamNoteRow.className = 'quick-settings-row-note';
      slotRoot.append(modelRow.row, localOnlyRow.row, noteRow, teamNoteRow);

      function currentModelId() {
        const prefs = getCurrentRuntimePreferences() || {};
        return String(prefs.preferredModel || state?.status?.model || '').trim();
      }

      function renderModel() {
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
        modelRow.label.textContent = modelId || jt('quickSettings.noModel', 'No model selected');
        if (modelId) modelRow.label.setAttribute('title', modelId); else modelRow.label.removeAttribute('title');
        modelRow.label.toggleAttribute('data-empty', !modelId);
        const title = !tuningSupported
          ? jt('quickSettings.engineOwnsGenerationControls', 'This engine owns its generation controls.')
          : (modelKnown
            ? jt('quickSettings.openCurrentModelTuningTitle', 'Open per-model tuning for the current model')
            : jt('quickSettings.pickModelFirst', 'Pick a model in the composer first'));
        buildInventoryHtml(modelRow.control, inv('actionButton', {
          id: 'open-model-tuning', label: jt('quickSettings.tune', 'Tune'), plain: true, className: 'quick-settings-link',
          disabled: !modelKnown || !tuningSupported,
          ariaLabel: jt('quickSettings.openCurrentModelTuning', 'Open current model tuning'),
          title,
        }));
      }

      modelRow.control.addEventListener('click', (event) => {
        const action = event.target?.closest?.('[data-action="open-model-tuning"]');
        const modelId = currentModelId();
        if (!action || !modelId || action.disabled) return;
        close();
        openModelTuning(modelId, documentRef?.activeElement || null);
      });

      noteLink.addEventListener('click', (event) => {
        if (!event.target?.closest?.('[data-action="quick-settings-open-models"]')) return;
        close();
        try { openSettingsSection('models'); } catch (_e) { /* best-effort */ }
      });

      function offlineSnapshot() {
        return state && state.offline && typeof state.offline === 'object' ? state.offline : {};
      }

      function renderLocalOnlySwitch() {
        buildInventoryHtml(localOnlyRow.control, inv('toggleSwitch', {
          id: 'quickSettingsLocalOnly',
          // The row label names the switch; a second visible label repeated it.
          bare: true,
          labelledBy: 'quickSettingsLocalOnlyLabel',
          checked: offlineSnapshot().mode === 'local_only',
        }));
      }

      // One status line: what the local engine is doing now, and a way out when it blocks chat.
      function renderStatusLine(offlineState) {
        teamNoteRow.textContent = offlineUtils?.forceLocalTeamNote?.(state) || '';
        teamNoteRow.hidden = !teamNoteRow.textContent;
        if (!statusChipUtils || typeof statusChipUtils.applyStatusChip !== 'function') return;
        const resolved = offlineState.resolved === true;
        const ready = offlineState.localChatReady === true;
        const forced = offlineState.mode === 'local_only';
        let chipState = 'loading';
        let label = jt('quickSettings.localChecking', 'Checking the local engine…');
        if (resolved && ready) {
          chipState = 'live';
          label = jt('quickSettings.localReady', 'Local engine ready');
        } else if (resolved) {
          chipState = 'error';
          label = forced
            ? jt('quickSettings.localUnreachableBlocking', 'The local engine is not reachable, so chats will not send while this is on.')
            : jt('quickSettings.localUnreachable', 'Local engine not reachable');
        }
        const title = resolved && !ready ? String(offlineState.summary || offlineState.unavailableReason || '') : '';
        statusChipUtils.applyStatusChip(noteChip, { state: chipState, label, title });
        buildInventoryHtml(noteLink, resolved && !ready && forced ? inv('actionButton', {
          id: 'quick-settings-open-models', label: jt('quickSettings.openModels', 'Open Models'), plain: true, className: 'quick-settings-link',
        }) : '');
      }

      function renderLocalOnly() {
        renderLocalOnlySwitch();
        renderStatusLine(offlineSnapshot());
      }

      // A live repaint after a state change must not replace a focused switch.
      function refreshOffline() {
        syncSwitch(localOnlyRow.control, offlineSnapshot().mode === 'local_only', renderLocalOnlySwitch);
        renderStatusLine(offlineSnapshot());
      }

      localOnlyRow.control.addEventListener('inv-toggle-change', (event) => {
        const detail = (event && event.detail) || {};
        const nextMode = detail.checked ? 'local_only' : 'disabled';
        const previousOffline = adapters.offline && typeof adapters.offline.read === 'function'
          ? adapters.offline.read()
          : (state && state.offline) || {};
        const write = () => writeAdapterValue(adapters.offline, { mode: nextMode, preferredLocalModel: previousOffline.preferredLocalModel || '' },
          renderLocalOnly, 'offline-local-only', () => { refreshOffline(); onOfflineWritten(); });
        // E64: turning it on asks first while this PC's team server runs; Cancel draws the switch back off.
        if (nextMode !== 'local_only' || !offlineUtils?.confirmForceLocal || !offlineUtils.teamApplies?.(state)) { write(); return; }
        Promise.resolve(offlineUtils.confirmForceLocal({ state, win: windowRef || undefined })).then((go) => { if (go) write(); else renderLocalOnly(); }, () => renderLocalOnly());
      });

      return { root: slotRoot, render() { renderModel(); renderLocalOnly(); }, refreshOffline };
    }

    function buildChatsSlot() {
      const slotRoot = buildSlot('chats', jt('quickSettings.chats', 'Chats'));
      const sessionOpenRow = buildRow(jt('quickSettings.openChatsInNewTab', 'Open chats in a new tab'));
      sessionOpenRow.label.id = 'quickSettingsSessionsLabel';
      slotRoot.appendChild(sessionOpenRow.row);

      function renderSessionOpen() {
        buildInventoryHtml(sessionOpenRow.control, inv('toggleSwitch', {
          id: 'quickSettingsSessionsOpenInNewTab',
          bare: true,
          labelledBy: 'quickSettingsSessionsLabel',
          checked: adapters.sessionOpen?.read?.() === true,
        }));
      }
      sessionOpenRow.control.addEventListener('inv-toggle-change', (event) => {
        if (event.detail?.id !== 'quickSettingsSessionsOpenInNewTab') return;
        writeAdapterValue(adapters.sessionOpen, event.detail.checked === true, renderSessionOpen, 'session-open');
      });

      return { root: slotRoot, render: renderSessionOpen };
    }

    function buildChordHint() {
      const chord = documentRef.createElement('span');
      chord.className = 'quick-settings-chord';
      const isMac = /Mac/i.test(String(windowRef?.navigator?.platform || ''));
      const modKey = documentRef.createElement('kbd');
      modKey.textContent = isMac ? '⌘' : jt('quickSettings.ctrlKey', 'Ctrl');
      const comma = documentRef.createElement('kbd');
      comma.textContent = ',';
      chord.append(modKey, '+', comma, ' ' + jt('quickSettings.chordHint', 'opens and closes this'));
      return chord;
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
      const closeButton = buildButton({
        id: 'quick-settings-close',
        ariaLabel: jt('common.close', 'Close'),
        title: jt('quickSettings.close', 'Close quick settings'),
        plain: true,
        className: 'quick-settings-close',
      });
      header.append(heading, closeButton);

      const body = documentRef.createElement('div');
      body.className = 'quick-settings-body';
      const appearanceSlot = buildAppearanceSlot();
      const modelSlot = buildModelSlot();
      const chatsSlot = buildChatsSlot();
      body.append(appearanceSlot.root, modelSlot.root, chatsSlot.root);

      const footer = documentRef.createElement('footer');
      footer.className = 'quick-settings-footer';
      const allSettingsButton = buildButton({
        id: 'quick-settings-all',
        label: jt('quickSettings.allSettings', 'All settings'),
        plain: true,
        className: 'quick-settings-link',
      });
      footer.append(allSettingsButton, buildChordHint());

      dialog.append(header, body, footer);
      overlay.append(scrim, dialog);

      scrim.addEventListener('click', () => close());
      closeButton.addEventListener('click', () => close());
      allSettingsButton.addEventListener('click', () => {
        close();
        try { openSettingsSection((state && state.ui && state.ui.activeSettingsSection) || 'models'); } catch (_e) { /* best-effort */ }
      });

      return {
        overlay, scrim, dialog, header, closeButton, body, footer, allSettingsButton,
        appearanceSlot, modelSlot, chatsSlot,
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
      els.chatsSlot.render();
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
      try { onOpen(); } catch (_e) { /* best-effort */ }
      registeredWithOverlayManager = typeof overlayManager?.open === 'function' && overlayManager.open({
        id: OVERLAY_ID,
        root: dom.dialog,
        onRequestClose: () => close(),
        inertTargets: resolveInertTargets(),
      }) === true;
      if (!registeredWithOverlayManager) {
        appendClientLog('WARN', 'quick_settings.overlay_manager_unavailable', { present: Boolean(overlayManager) });
      }
      const focusTarget = dom.body.querySelector('[role="radio"][aria-checked="true"]')
        || dom.body.querySelector('button:not(:disabled), [tabindex]');
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
      if (opened) { close(); return false; }
      return open();
    }

    function isOpen() { return opened; }
    // Repaint the Force local row and status line from state.offline while open.
    function refreshOffline() {
      if (opened && els) els.modelSlot.refreshOffline();
    }

    function dispose() {
      if (disposed) return;
      if (opened) close();
      disposed = true;
      lifecycleGeneration += 1;
      if (els && els.overlay && typeof els.overlay.remove === 'function') els.overlay.remove();
      els = null;
    }

    return { open, close, toggle, isOpen, refreshOffline, dispose };
  }

  return { createQuickSettingsModal };
});
