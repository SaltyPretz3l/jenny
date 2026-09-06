/* renderer/shell/renderer-surface-gallery-utils.js — DEV-ONLY, nav-unlinked
   surface-effect review gallery (Background Effects v3, S5 slice W1c). No
   nav link, no shortcut: entry point is window.__jennySurfaceGallery.open(),
   gated by surface_effect_gallery. Builds its DOM programmatically. */
/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/action-button.js'),
      require('../inventory/select-field.js'),
      require('../inventory/number-input.js'),
    );
    return;
  }
  root.rendererSurfaceGalleryUtils = factory(
    root.inventoryActionButton,
    root.inventorySelectField,
    root.inventoryNumberInput,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, selectField, numberInput) {
  'use strict';

  var PHASES = ['idle', 'preflight', 'streaming', 'awaiting-user', 'settling', 'failed'];
  var MOTION_OPTIONS = ['calm', 'standard', 'expressive', 'reduced'];
  var VIEWPORT_PRESETS = [
    { id: 'gutter', label: 'Gutter (260×760)', width: 260, height: 760 },
    { id: 'standard', label: 'Standard (900×640)', width: 900, height: 640 },
    { id: 'ultrawide', label: 'Ultrawide (1600×700)', width: 1600, height: 700 },
  ];
  var DPR_OPTIONS = [1, 1.5, 2];
  var TIER_OPTIONS = ['auto', '1', '0.75', '0.55'];
  var IMPULSE_KINDS = [
    ['First token', 'first-token'], ['Tool start', 'tool-start'],
    ['Complete', 'complete'], ['Cancel', 'cancel'],
  ];
  // Foundation/Midnight + the 11 palette files; fallback if appearanceUtils isn't reachable.
  var FALLBACK_PALETTE_IDS = [
    'midnight', 'pewter', 'obsidian', 'darkroom', 'slate', 'paper', 'signal',
    'woolly', 'lexicon', 'rocko', 'jenny-day', 'jenny-night',
  ];
  var SWEEP_STEPS = 24;
  var PRESS_HOLD_MS = 900;

  function idOption(id) { return { value: id, label: id }; }

  function readRect(element) {
    if (element && typeof element.getBoundingClientRect === 'function') {
      var rect = element.getBoundingClientRect();
      return { left: rect.left || 0, top: rect.top || 0, width: rect.width || 0, height: rect.height || 0 };
    }
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  function clamp01(value) {
    var numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0;
  }

  // Deliberately duplicates the effectId -> factory map wired in renderer/app.js
  // (surfaceEffectManager's `factories`) -- the gallery re-reads the globals itself.
  function buildFactoryMap(windowRef) {
    return {
      'reactive-grid': windowRef.rendererReactiveGridUtils && windowRef.rendererReactiveGridUtils.createReactiveGridController,
      'playlist-scroll': windowRef.rendererPlaylistScrollUtils && windowRef.rendererPlaylistScrollUtils.createPlaylistScrollController,
      'atomic-burst': windowRef.rendererAtomicBurstUtils && windowRef.rendererAtomicBurstUtils.createAtomicBurstController,
      'circuit-trace': windowRef.rendererCircuitTraceUtils && windowRef.rendererCircuitTraceUtils.createCircuitTraceController,
      'context-weave': windowRef.rendererContextWeaveUtils && windowRef.rendererContextWeaveUtils.createContextWeaveController,
    };
  }

  // A pinned fake MediaQueryList; simulateChange() fires every listener.
  function createFakeMediaQueryList(initialMatches) {
    var listeners = [];
    var mql = {
      matches: Boolean(initialMatches),
      addEventListener: function (eventName, listener) {
        if (eventName === 'change' && listeners.indexOf(listener) === -1) listeners.push(listener);
      },
      removeEventListener: function (eventName, listener) {
        if (eventName !== 'change') return;
        var index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      },
      addListener: function (listener) { if (listeners.indexOf(listener) === -1) listeners.push(listener); },
      removeListener: function (listener) {
        var index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      },
      simulateChange: function (matches) {
        mql.matches = Boolean(matches);
        listeners.slice().forEach(function (listener) {
          try { listener({ matches: mql.matches }); } catch (_listenerErr) { /* the controller's problem, not the gallery's */ }
        });
      },
    };
    return mql;
  }

  // Wraps documentRef so documentRef.defaultView.devicePixelRatio (the
  // renderer-circuit-trace-core read pattern) observes the pinned DPR;
  // everything else delegates straight through to the real document/window.
  function createDprDocumentRef(baseDocumentRef, windowRef, dpr) {
    var proxiedWindow = new Proxy(windowRef, {
      get: function (target, prop, receiver) {
        if (prop === 'devicePixelRatio') return dpr;
        var value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return {
      get defaultView() { return proxiedWindow; },
      get visibilityState() { return baseDocumentRef.visibilityState; },
      get hidden() { return baseDocumentRef.hidden; },
      createElement: function () { return baseDocumentRef.createElement.apply(baseDocumentRef, arguments); },
      addEventListener: function () { return baseDocumentRef.addEventListener.apply(baseDocumentRef, arguments); },
      removeEventListener: function () { return baseDocumentRef.removeEventListener.apply(baseDocumentRef, arguments); },
      querySelector: function () { return baseDocumentRef.querySelector.apply(baseDocumentRef, arguments); },
    };
  }

  function installSurfaceEffectGallery(deps) {
    var windowRef = deps.windowRef;
    var documentRef = deps.documentRef;
    if (windowRef.__jennySurfaceGallery) return windowRef.__jennySurfaceGallery;
    var getEffectRegistry = typeof deps.getEffectRegistry === 'function' ? deps.getEffectRegistry : function () { return []; };
    var initialReducedMotion = Boolean(deps.reducedMotionQuery && deps.reducedMotionQuery.matches);

    var openState = false;
    var overlayEl = null;
    var stageEl = null;
    var controls = {};
    var trackedListeners = [];
    var savedPaletteValue;
    var savedMotionValue;
    var fakeMql = null;
    var activeController = null;
    var activeEntry = null;
    var currentEffectId = '';
    var currentPhase = 'idle';
    var currentEnergy = 0.2;
    var currentSeed = 1;
    var currentDpr = 1;
    var phaseRevisionCounter = 0;
    var impulseSequenceCounter = 0;
    var sweepRafId = 0;
    var pressHoldTimerId = 0;

    function logGalleryWarning(message) {
      if (windowRef.console && typeof windowRef.console.warn === 'function') {
        windowRef.console.warn('[surface-gallery] ' + message);
      }
    }

    function getRegistryEntries() {
      var raw;
      try { raw = getEffectRegistry() || []; } catch (_registryErr) { raw = []; }
      var list = Array.isArray(raw) ? raw : Object.values(raw);
      return list.filter(function (entry) { return entry && entry.id && entry.id !== 'none'; });
    }

    function findRegistryEntry(effectId) {
      var entries = getRegistryEntries();
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].id === effectId) return entries[i];
      }
      return null;
    }

    function getPaletteOptions() {
      var appearance = windowRef.appearanceUtils;
      if (appearance && typeof appearance.getPalettePresets === 'function') {
        try {
          var presets = appearance.getPalettePresets();
          var list = Array.isArray(presets) ? presets : Object.values(presets || {});
          var options = list.filter(function (p) { return p && p.id; })
            .map(function (p) { return { value: p.id, label: p.label || p.id }; });
          if (options.length) return options;
        } catch (_appearanceErr) { /* fall through to the hardcoded list */ }
      }
      return FALLBACK_PALETTE_IDS.map(idOption);
    }

    // ── DOM construction ──
    function addTrackedListener(target, type, handler) {
      target.addEventListener(type, handler);
      trackedListeners.push({ target: target, type: type, handler: handler });
    }

    function removeAllTrackedListeners() {
      trackedListeners.forEach(function (entry) { entry.target.removeEventListener(entry.type, entry.handler); });
      trackedListeners = [];
    }

    function buildGroup(doc, labelText) {
      var group = doc.createElement('div');
      group.className = 'surface-gallery-group';
      var label = doc.createElement('label');
      label.className = 'surface-gallery-label';
      label.textContent = labelText;
      group.appendChild(label);
      return group;
    }

    // Renders an inventory-primitive HTML string and returns its root element
    // (form controls are inventory-owned repo-wide; the gallery never builds
    // raw button/input/select markup itself).
    function renderPrimitive(doc, html) {
      var host = doc.createElement('div');
      host.innerHTML = html;
      return host.firstElementChild || host.firstChild;
    }

    function buildSelect(doc, group, options, onChange, ariaLabel) {
      var wrapper = renderPrimitive(doc, selectField({
        ariaLabel: ariaLabel || 'Gallery pin',
        className: 'surface-gallery-select-field',
        options: options.map(function (opt) { return { value: String(opt.value), label: String(opt.label) }; }),
      }));
      var select = wrapper.querySelector('.inv-select-field-control');
      addTrackedListener(select, 'change', function () { onChange(select.value); });
      group.appendChild(wrapper);
      return select;
    }

    function buildButton(doc, group, text, onClick) {
      var button = renderPrimitive(doc, actionButton({
        label: text,
        plain: true,
        className: 'surface-gallery-btn',
      }));
      addTrackedListener(button, 'click', onClick);
      group.appendChild(button);
      return button;
    }

    function buildNumberInput(doc, group, opts, onCommit) {
      var wrapper = renderPrimitive(doc, numberInput({
        ariaLabel: opts.ariaLabel,
        className: 'surface-gallery-number-field',
        min: opts.min,
        max: opts.max,
        step: opts.step,
        value: opts.value,
      }));
      var input = wrapper.querySelector('input');
      addTrackedListener(input, 'input', function () { onCommit(input.value); });
      addTrackedListener(input, 'change', function () { onCommit(input.value); });
      group.appendChild(wrapper);
      return input;
    }

    // Appends a labeled select-field group; stashes the element on controls[key].
    function addSelectGroup(doc, railEl, key, labelText, options, onChange) {
      var group = buildGroup(doc, labelText);
      controls[key] = buildSelect(doc, group, options, onChange, labelText);
      railEl.appendChild(group);
    }

    function buildPhaseGroup(doc, railEl) {
      var group = buildGroup(doc, 'Phase + energy (native only)');
      buildSelect(doc, group, PHASES.map(idOption), handlePhaseChange, 'Phase');
      buildNumberInput(doc, group, {
        ariaLabel: 'Target energy', min: 0, max: 1, step: 0.05, value: currentEnergy,
      }, handleEnergyChange);
      var impulseWrap = doc.createElement('div');
      impulseWrap.className = 'surface-gallery-impulse-row';
      IMPULSE_KINDS.forEach(function (pair) {
        buildButton(doc, impulseWrap, pair[0], function () { publishImpulse(pair[1]); });
      });
      group.appendChild(impulseWrap);
      railEl.appendChild(group);
    }

    function buildPointerGroup(doc, railEl) {
      var group = buildGroup(doc, 'Pointer (native only)');
      buildButton(doc, group, 'Sweep', runPointerSweep);
      buildButton(doc, group, 'Click', runPointerClick);
      buildButton(doc, group, 'Press & hold', runPointerPressHold);
      railEl.appendChild(group);
    }

    function buildOverlay() {
      var doc = documentRef;
      overlayEl = doc.createElement('section');
      overlayEl.className = 'surface-gallery';
      overlayEl.setAttribute('role', 'dialog');
      overlayEl.setAttribute('aria-label', 'Surface effect gallery');

      var railEl = doc.createElement('div');
      railEl.className = 'surface-gallery-rail';

      var closeBtn = renderPrimitive(doc, actionButton({
        label: 'Close gallery', plain: true, className: 'surface-gallery-close',
      }));
      addTrackedListener(closeBtn, 'click', close);
      railEl.appendChild(closeBtn);

      addSelectGroup(doc, railEl, 'effectSelect', 'Effect',
        getRegistryEntries().map(function (entry) { return { value: entry.id, label: entry.label || entry.id }; }),
        switchEffect);
      addSelectGroup(doc, railEl, 'paletteSelect', 'Palette', getPaletteOptions(), handlePaletteChange);
      addSelectGroup(doc, railEl, 'motionSelect', 'Motion', MOTION_OPTIONS.map(idOption), handleMotionChange);
      buildPhaseGroup(doc, railEl);
      buildPointerGroup(doc, railEl);
      addSelectGroup(doc, railEl, 'viewportSelect', 'Viewport',
        VIEWPORT_PRESETS.map(function (p) { return { value: p.id, label: p.label }; }), handleViewportChange);
      addSelectGroup(doc, railEl, 'dprSelect', 'DPR (native only)',
        DPR_OPTIONS.map(function (v) { return { value: v, label: String(v) + '×' }; }), handleDprChange);

      var seedGroup = buildGroup(doc, 'Seed (native only)');
      controls.seedInput = buildNumberInput(doc, seedGroup, {
        ariaLabel: 'Launch seed', min: 0, max: 0xffffffff, step: 1, value: currentSeed,
      }, handleSeedChange);
      railEl.appendChild(seedGroup);

      addSelectGroup(doc, railEl, 'tierSelect', 'Quality tier (native only)', TIER_OPTIONS.map(idOption), handleTierChange);

      var stageWrap = doc.createElement('div');
      stageWrap.className = 'surface-gallery-stage-wrap';
      stageEl = doc.createElement('div');
      stageEl.className = 'surface-gallery-stage';
      // [data-surface-input-block] keeps the app-wide surface-input router
      // from forwarding these pointer events to the live app's effect --
      // the gallery drives its bound controller directly via handleInput().
      stageEl.setAttribute('data-surface-input-block', '');
      stageWrap.appendChild(stageEl);

      overlayEl.appendChild(railEl);
      overlayEl.appendChild(stageWrap);
      doc.body.appendChild(overlayEl);
    }

    // ── Controller lifecycle ──
    function buildBindContext() {
      var rect = readRect(stageEl);
      return {
        generation: 1,
        staged: false,
        surface: 'chat',
        hosts: [{ element: stageEl, role: 'chat-left' }],
        layout: {
          revision: 1,
          sceneRect: rect,
          hostRects: [rect],
          interactionBlockRects: [],
          paintOcclusionRects: [],
          spawnAvoidanceRects: [],
        },
      };
    }

    function instantiateActiveController() {
      if (!currentEffectId || !activeEntry) {
        return;
      }
      var factoryFn = buildFactoryMap(windowRef)[currentEffectId];
      if (typeof factoryFn !== 'function') {
        logGalleryWarning('no loaded factory for effect id "' + currentEffectId + '"');
        return;
      }
      var controller;
      try {
        controller = factoryFn({
          documentRef: createDprDocumentRef(documentRef, windowRef, currentDpr),
          reducedMotionQuery: fakeMql,
          runtime: windowRef.rendererSurfaceEffectRuntime,
          rendererLaunchSeed: currentSeed,
          sceneRole: 'chat',
          effectId: currentEffectId,
          report: function (fault) { logGalleryWarning('fault: ' + JSON.stringify(fault)); },
        });
      } catch (factoryErr) {
        logGalleryWarning('factory threw for "' + currentEffectId + '": ' + factoryErr.message);
        return;
      }
      if (!controller) {
        logGalleryWarning('factory returned no controller for "' + currentEffectId + '"');
        return;
      }
      activeController = controller;
      // Set before bind so CSS token profiles can key off the active effect.
      stageEl.setAttribute('data-widget-modifier', currentEffectId);
      try {
        activeController.bind(buildBindContext());
      } catch (bindErr) {
        logGalleryWarning('bind threw for "' + currentEffectId + '": ' + bindErr.message);
      }
    }

    function disposeActiveController() {
      cancelPointerSweep();
      cancelPressHold();
      if (activeController && typeof activeController.dispose === 'function') {
        try { activeController.dispose(); } catch (disposeErr) { logGalleryWarning('dispose threw: ' + disposeErr.message); }
      }
      activeController = null;
      activeEntry = null;
      if (stageEl) stageEl.removeAttribute('data-widget-modifier');
    }

    function switchEffect(effectId) {
      disposeActiveController();
      currentEffectId = effectId;
      activeEntry = findRegistryEntry(effectId);
      instantiateActiveController();
    }

    function rebuildActiveController() {
      if (!currentEffectId) return;
      disposeActiveController();
      activeEntry = findRegistryEntry(currentEffectId);
      instantiateActiveController();
    }

    // ── Pins ──
    function republishTokens() {
      if (!activeController) return;
      try {
        if (typeof activeController.refresh === 'function') {
          activeController.refresh(buildBindContext());
        }
      } catch (refreshErr) {
        logGalleryWarning('token refresh threw: ' + refreshErr.message);
      }
    }

    function handlePaletteChange(value) {
      documentRef.documentElement.dataset.palette = value;
      republishTokens();
    }

    function handleMotionChange(value) {
      if (value === 'reduced') {
        fakeMql.simulateChange(true);
      } else {
        documentRef.documentElement.dataset.motion = value;
        fakeMql.simulateChange(false);
      }
      republishTokens();
    }

    function handlePhaseChange(value) { currentPhase = value; publishActivitySnapshot(); }
    function handleEnergyChange(value) { currentEnergy = clamp01(value); publishActivitySnapshot(); }

    function publishActivitySnapshot() {
      if (!activeController || typeof activeController.setActivity !== 'function') return;
      phaseRevisionCounter += 1;
      activeController.setActivity({
        scopeEpoch: 1, phase: currentPhase, phaseRevision: phaseRevisionCounter,
        targetEnergy: currentEnergy, attentionScale: 1,
      });
    }

    function publishImpulse(kind) {
      if (!activeController || typeof activeController.handleActivityImpulse !== 'function') return;
      impulseSequenceCounter += 1;
      activeController.handleActivityImpulse({
        scopeEpoch: 1, sequence: impulseSequenceCounter, kind: kind,
        timeStamp: (windowRef.performance && typeof windowRef.performance.now === 'function') ? windowRef.performance.now() : 0,
      });
    }

    function dispatchPointerInput(type, clientX, clientY, overrides) {
      if (!activeController || typeof activeController.handleInput !== 'function') return;
      var rect = readRect(stageEl);
      var localX = clientX - rect.left;
      var localY = clientY - rect.top;
      var payload = Object.assign({
        type: type, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0, pressure: 0,
        timeStamp: (windowRef.performance && typeof windowRef.performance.now === 'function') ? windowRef.performance.now() : 0,
        clientX: clientX, clientY: clientY, surfaceRole: 'chat-left',
        localX: localX, localY: localY, sceneX: localX, sceneY: localY, generation: 1,
      }, overrides || {});
      activeController.handleInput(payload);
    }

    function cancelPointerSweep() {
      if (sweepRafId) { windowRef.cancelAnimationFrame(sweepRafId); sweepRafId = 0; }
    }

    function runPointerSweep() {
      cancelPointerSweep();
      if (!activeController) return;
      var rect = readRect(stageEl);
      var marginX = Math.max(rect.width * 0.08, 2);
      var startX = rect.left + marginX;
      var endX = rect.left + rect.width - marginX;
      var midY = rect.top + rect.height / 2;
      var step = 0;
      function frame() {
        step += 1;
        var progress = Math.min(step / SWEEP_STEPS, 1);
        dispatchPointerInput('move', startX + (endX - startX) * progress, midY);
        sweepRafId = step < SWEEP_STEPS ? windowRef.requestAnimationFrame(frame) : 0;
      }
      sweepRafId = windowRef.requestAnimationFrame(frame);
    }

    function runPointerClick() {
      if (!activeController) return;
      var rect = readRect(stageEl);
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      dispatchPointerInput('press', cx, cy, { buttons: 1, pressure: 0.5 });
      dispatchPointerInput('release', cx, cy, { buttons: 0 });
      dispatchPointerInput('click', cx, cy, { buttons: 0 });
    }

    function cancelPressHold() {
      if (pressHoldTimerId) { windowRef.clearTimeout(pressHoldTimerId); pressHoldTimerId = 0; }
    }

    function runPointerPressHold() {
      cancelPressHold();
      if (!activeController) return;
      var rect = readRect(stageEl);
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      dispatchPointerInput('press', cx, cy, { buttons: 1, pressure: 0.6 });
      pressHoldTimerId = windowRef.setTimeout(function () {
        pressHoldTimerId = 0;
        dispatchPointerInput('release', cx, cy, { buttons: 0 });
      }, PRESS_HOLD_MS);
    }

    function handleViewportChange(value) {
      var preset = VIEWPORT_PRESETS.filter(function (p) { return p.id === value; })[0] || VIEWPORT_PRESETS[1];
      if (stageEl) {
        stageEl.style.width = preset.width + 'px';
        stageEl.style.height = preset.height + 'px';
      }
      if (activeController && typeof activeController.refresh === 'function') {
        try { activeController.refresh(buildBindContext()); } catch (refreshErr) { logGalleryWarning('viewport refresh threw: ' + refreshErr.message); }
      }
    }

    function handleDprChange(value) {
      var numeric = Number(value);
      currentDpr = DPR_OPTIONS.indexOf(numeric) !== -1 ? numeric : 1;
      rebuildActiveController();
    }

    function handleSeedChange(value) {
      var numeric = Number(value);
      currentSeed = Number.isFinite(numeric) ? numeric : 1;
      rebuildActiveController();
    }

    function handleTierChange(value) {
      if (!activeController) return;
      var internals = activeController._internals;
      if (!internals || typeof internals.setQualityOverride !== 'function') return;
      internals.setQualityOverride(value === 'auto' ? null : Number(value));
    }

    // ── open / close / dispose ──
    function restoreDatasetValue(key, value) {
      var dataset = documentRef.documentElement.dataset;
      if (value === undefined) { delete dataset[key]; } else { dataset[key] = value; }
    }

    function open() {
      if (openState) return;
      openState = true;
      controls = {};
      phaseRevisionCounter = 0;
      impulseSequenceCounter = 0;
      currentPhase = 'idle';
      currentEnergy = 0.2;
      currentSeed = 1;
      currentDpr = 1;
      fakeMql = createFakeMediaQueryList(initialReducedMotion);

      savedPaletteValue = documentRef.documentElement.dataset.palette;
      savedMotionValue = documentRef.documentElement.dataset.motion;

      buildOverlay();

      if (controls.paletteSelect) controls.paletteSelect.value = savedPaletteValue || 'midnight';
      if (controls.motionSelect) controls.motionSelect.value = savedMotionValue || 'standard';
      if (controls.dprSelect) controls.dprSelect.value = '1';
      if (controls.tierSelect) controls.tierSelect.value = 'auto';
      if (controls.viewportSelect) controls.viewportSelect.value = 'standard';
      handleViewportChange('standard');

      var entries = getRegistryEntries();
      if (entries.length) {
        if (controls.effectSelect) controls.effectSelect.value = entries[0].id;
        switchEffect(entries[0].id);
      }
    }

    function close() {
      if (!openState) return;
      disposeActiveController();
      cancelPointerSweep();
      cancelPressHold();
      restoreDatasetValue('palette', savedPaletteValue);
      restoreDatasetValue('motion', savedMotionValue);
      removeAllTrackedListeners();
      if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      overlayEl = null;
      stageEl = null;
      controls = {};
      fakeMql = null;
      currentEffectId = '';
      openState = false;
    }

    function isOpen() { return openState; }

    var api = { open: open, close: close, isOpen: isOpen, dispose: dispose };

    function registerGlobal() {
      windowRef.__jennySurfaceGallery = api;
    }

    function dispose() {
      close();
      if (windowRef.__jennySurfaceGallery === api) {
        delete windowRef.__jennySurfaceGallery;
      }
    }

    registerGlobal();
    if (typeof deps.registerCleanup === 'function') {
      deps.registerCleanup(dispose);
    }

    return api;
  }

  return {
    installSurfaceEffectGallery: installSurfaceEffectGallery,
    // Exported for registry-parity testing.
    buildFactoryMap: buildFactoryMap,
    FALLBACK_PALETTE_IDS: FALLBACK_PALETTE_IDS,
    PHASES: PHASES,
    MOTION_OPTIONS: MOTION_OPTIONS,
    VIEWPORT_PRESETS: VIEWPORT_PRESETS,
    DPR_OPTIONS: DPR_OPTIONS,
    TIER_OPTIONS: TIER_OPTIONS,
  };
});
