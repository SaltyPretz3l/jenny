/* Daybook layout controller: owns the Home rail's WIDTH (the vertical
 * separator between the main widget column and the rail) and the rail
 * scratchpad's HEIGHT (the corner grip, which drives both axes at once).
 *
 * Persistence contract: a live drag only writes the CSS custom property and
 * the textarea's rows — nothing hits the bridge until pointerup. Keyboard
 * adjustments debounce so a held arrow key does not spam home.updateConfig.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererDashboardDaybook = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};

  // Mirrors services/home-config-schema.js: HOME_LAYOUT_RAIL_WIDTH_MIN /
  // _MAX / _DEFAULT. Renderer modules load as plain <script> tags and cannot
  // require() a service, so the bounds are duplicated here on purpose; the
  // service re-clamps every write, so a drift can only ever be cosmetic.
  const RAIL_WIDTH_MIN = 280;
  const RAIL_WIDTH_MAX = 720;
  const RAIL_WIDTH_DEFAULT = 360;
  // Mirrors the scratchpad settings.rows bounds in the same schema file.
  const RAIL_ROWS_MIN = 3;
  const RAIL_ROWS_MAX = 30;
  const RAIL_ROWS_DEFAULT = 6;
  const RAIL_KEY_STEP = 16;
  // Approximate rendered line box of the rail textarea; the grip converts
  // vertical pointer travel into whole rows with it.
  const RAIL_ROW_PX = 22;
  const KEY_PERSIST_DEBOUNCE_MS = 250;
  const RAIL_TEXTAREA_SELECTOR = '#homeScratchpadInput';
  const ASK_REGION_SELECTOR = '.home-info-strip__ask';
  const ASK_FIELD_SELECTOR = '[data-home-ask-input="1"]';
  const ASK_SEND_SELECTOR = '.home-ask__send';
  // The ask-config panel. Escape has to know whether it is open BEFORE it
  // decides what Escape means (F3).
  const ASK_PANEL_SELECTOR = '.home-ask__panel';

  function noop() {}

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function clampWidth(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) {
      return RAIL_WIDTH_DEFAULT;
    }
    return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(raw)));
  }

  function clampRows(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) {
      return RAIL_ROWS_DEFAULT;
    }
    return Math.min(RAIL_ROWS_MAX, Math.max(RAIL_ROWS_MIN, Math.trunc(raw)));
  }

  function createDaybookController(deps = {}) {
    const dom = deps.dom || {};
    const homeDaybook = dom.homeDaybook || null;
    const homeDashboardRail = dom.homeDashboardRail || null;
    const homeRailResizer = dom.homeRailResizer || null;
    const homeRailGrip = dom.homeRailGrip || null;
    const homeInfoStrip = dom.homeInfoStrip || null;
    // Owner document of the wrapper first — this module never reads an ambient
    // `document`, so it works under any JSDOM harness.
    const documentRef = (homeDaybook && homeDaybook.ownerDocument)
      || deps.documentRef
      || windowRef.document
      || null;
    const eventTarget = documentRef?.defaultView || windowRef;
    const shell = deps.shell || null;
    const getHomeConfig = typeof deps.getHomeConfig === 'function'
      ? deps.getHomeConfig
      : function defaultGetHomeConfig() { return null; };
    const onConfigApplied = typeof deps.onConfigApplied === 'function' ? deps.onConfigApplied : noop;
    // Handed the pill's text on Enter; returns true when it consumed it (the
    // manager reuses the scratchpad's append-below-draft + navigate helper).
    const onAsk = typeof deps.onAsk === 'function' ? deps.onAsk : null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const setTimeoutImpl = deps.setTimeoutImpl
      || function defaultSetTimeout(fn, ms) { return setTimeout(fn, ms); };
    const clearTimeoutImpl = deps.clearTimeoutImpl
      || function defaultClearTimeout(timer) { clearTimeout(timer); };

    let railWidth = clampWidth(asObject(getHomeConfig()?.layout)?.railWidth);
    let dragState = null;
    let persistTimer = null;
    const fence = asyncFence.createDisposalFence();

    function railTextarea() {
      return homeDashboardRail?.querySelector?.(RAIL_TEXTAREA_SELECTOR) || null;
    }

    function currentRows() {
      const textarea = railTextarea();
      if (textarea && Number.isFinite(Number(textarea.rows))) {
        return clampRows(textarea.rows);
      }
      return clampRows(asObject(asObject(getHomeConfig()?.scratchpad)?.settings)?.rows);
    }

    function applyWidth(width) {
      homeDaybook?.style?.setProperty?.('--home-rail-width', `${width}px`);
      if (homeRailResizer?.setAttribute) {
        homeRailResizer.setAttribute('aria-valuenow', String(width));
        homeRailResizer.setAttribute('aria-valuemin', String(RAIL_WIDTH_MIN));
        homeRailResizer.setAttribute('aria-valuemax', String(RAIL_WIDTH_MAX));
      }
    }

    function applyRows(rows) {
      const textarea = railTextarea();
      if (textarea) {
        textarea.rows = rows;
      }
    }

    function updateConfigFn() {
      const fn = shell?.home?.updateConfig;
      return typeof fn === 'function' ? fn : null;
    }

    function settleConfig(promise, logCode) {
      Promise.resolve(promise)
        .then((config) => {
          if (config && !fence.isDisposed()) {
            onConfigApplied(config);
          }
        })
        .catch((error) => {
          appendClientLog('WARN', logCode, { message: String(error?.message || error || '') });
        });
    }

    function persistWidth(width) {
      const updateConfig = updateConfigFn();
      if (!updateConfig) {
        return;
      }
      // `layout` holds exactly one field, so a one-level-deep merge of the
      // whole section is lossless here.
      settleConfig(updateConfig({ layout: { railWidth: width } }), 'home.rail_width_persist_failed');
    }

    function persistRows(rows) {
      const updateConfig = updateConfigFn();
      if (!updateConfig) {
        return;
      }
      // updateHomeConfig merges ONE level deep: sending {scratchpad:{settings:
      // {rows}}} would replace the entire settings object and silently drop
      // font / captureMode / markdown / globalCapture (and notes / pins with
      // it). Spread both levels off the live config instead.
      const scratchpad = asObject(getHomeConfig()?.scratchpad) || {};
      const settings = asObject(scratchpad.settings) || {};
      settleConfig(
        updateConfig({ scratchpad: { ...scratchpad, settings: { ...settings, rows } } }),
        'home.rail_rows_persist_failed'
      );
    }

    function cancelPersistTimer() {
      if (persistTimer) {
        clearTimeoutImpl(persistTimer);
        persistTimer = null;
      }
    }

    function schedulePersistWidth() {
      cancelPersistTimer();
      if (fence.isDisposed()) {
        return;
      }
      persistTimer = setTimeoutImpl(() => {
        persistTimer = null;
        persistWidth(railWidth);
      }, KEY_PERSIST_DEBOUNCE_MS);
    }

    function handlePointerMove(event) {
      if (!dragState) {
        return;
      }
      // The rail is the RIGHT-hand column, so dragging the separator LEFT
      // (negative dx) grows it.
      const dx = (Number(event?.clientX) || 0) - dragState.startX;
      railWidth = clampWidth(dragState.startWidth - dx);
      applyWidth(railWidth);
      if (dragState.rows) {
        const dy = (Number(event?.clientY) || 0) - dragState.startY;
        dragState.currentRows = clampRows(dragState.startRows + Math.round(dy / RAIL_ROW_PX));
        applyRows(dragState.currentRows);
      }
      event?.preventDefault?.();
    }

    function endDrag(event) {
      if (!dragState) {
        return;
      }
      const finished = dragState;
      dragState = null;
      eventTarget?.removeEventListener?.('pointermove', handlePointerMove);
      eventTarget?.removeEventListener?.('pointerup', endDrag);
      eventTarget?.removeEventListener?.('pointercancel', endDrag);
      homeDaybook?.classList?.remove?.('is-resizing');
      try {
        finished.target?.releasePointerCapture?.(event?.pointerId ?? finished.pointerId);
      } catch (_error) {
        /* pointer capture is best-effort (absent in jsdom) */
      }
      if (fence.isDisposed()) {
        return;
      }
      // Persist ON POINTERUP ONLY — the whole drag is one write.
      if (railWidth !== finished.startWidth) {
        persistWidth(railWidth);
      }
      if (finished.rows && finished.currentRows !== finished.startRows) {
        persistRows(finished.currentRows);
      }
    }

    function beginDrag(event, target, withRows) {
      if (typeof event?.button === 'number' && event.button !== 0) {
        return;
      }
      cancelPersistTimer();
      const startRows = currentRows();
      dragState = {
        startX: Number(event?.clientX) || 0,
        startY: Number(event?.clientY) || 0,
        startWidth: railWidth,
        startRows,
        currentRows: startRows,
        rows: withRows === true,
        target,
        pointerId: event?.pointerId,
      };
      try {
        target?.setPointerCapture?.(event.pointerId);
      } catch (_error) {
        /* pointer capture is best-effort (absent in jsdom) */
      }
      eventTarget?.addEventListener?.('pointermove', handlePointerMove);
      eventTarget?.addEventListener?.('pointerup', endDrag);
      eventTarget?.addEventListener?.('pointercancel', endDrag);
      homeDaybook?.classList?.add?.('is-resizing');
      event?.preventDefault?.();
    }

    function handleResizerPointerDown(event) {
      beginDrag(event, homeRailResizer, false);
    }

    function handleGripPointerDown(event) {
      beginDrag(event, homeRailGrip, true);
    }

    // Arrow keys move the SEPARATOR, so ArrowLeft widens the right-hand rail
    // and ArrowRight narrows it. Home restores the schema default.
    function handleResizerKeydown(event) {
      const key = String(event?.key || '');
      let next;
      if (key === 'ArrowLeft') {
        next = railWidth + RAIL_KEY_STEP;
      } else if (key === 'ArrowRight') {
        next = railWidth - RAIL_KEY_STEP;
      } else if (key === 'Home') {
        next = RAIL_WIDTH_DEFAULT;
      } else {
        return;
      }
      event?.preventDefault?.();
      const clamped = clampWidth(next);
      if (clamped === railWidth) {
        return;
      }
      railWidth = clamped;
      applyWidth(railWidth);
      schedulePersistWidth();
    }

    /* Hero ask line (delegated off the info strip, which survives the strip's
     * 30s chrome repaint):
     *   Enter             - start a NEW chat carrying the draft and SEND.
     *   Shift+Enter       - insert a newline; the field autosizes.
     *   Ctrl/Cmd+Enter    - same new chat + config, but prefill only.
     *   empty Enter       - navigate + focus only, nothing written.
     *   Escape            - close the settings panel if it is open, otherwise
     *                       blur. It NEVER destroys typed text.
     *   click the send    - the same path as Enter, so there is exactly one
     *                       submit path rather than a keyboard-only feature.
     * The field clears only once onAsk reports success: a rejected create or an
     * unreachable send must leave the user's text exactly where they typed it.
     */
    let askInFlight = false;

    function askRegionOf(node) {
      return node?.closest?.(ASK_REGION_SELECTOR) || null;
    }

    /* Auto-grow the field to its content and flag whether it holds any: reset
     * the height so the box collapses to the rows="1" floor, then take the
     * measured scrollHeight. The stylesheet's max-height is the 4-line ceiling,
     * past which the field scrolls internally. The filled flag is what swaps
     * the hint out for the send button, so EVERY value change - typed or
     * programmatic - has to come through here. */
    function refreshAskField(target) {
      if (!target) {
        return;
      }
      if (target.style) {
        target.style.height = 'auto';
        const measured = Number(target.scrollHeight);
        if (Number.isFinite(measured) && measured > 0) {
          target.style.height = `${measured}px`;
        }
      }
      const region = askRegionOf(target);
      if (!region?.dataset) {
        return;
      }
      if (String(target.value || '').length > 0) {
        region.dataset.askFilled = '1';
      } else {
        delete region.dataset.askFilled;
      }
    }

    /* One flag, three consumers: the latch below, the CSS busy state, and the
     * field itself. readOnly (not disabled) keeps the text visible and the
     * caret where it was, so a failed send hands the question straight back. */
    function setAskBusy(region, target, busy) {
      askInFlight = busy === true;
      if (target) {
        target.readOnly = askInFlight;
      }
      if (!region?.dataset) {
        return;
      }
      if (askInFlight) {
        region.dataset.askBusy = '1';
      } else {
        delete region.dataset.askBusy;
      }
    }

    function clearIfUnchanged(target, text) {
      if (!fence.isDisposed() && String(target.value || '') === text) {
        target.value = '';
        // Shrink back to one row: no input event fires for a programmatic write.
        refreshAskField(target);
      }
    }

    /* The ONE submit path. The in-flight latch is set BEFORE onAsk runs and
     * cleared on every exit - resolve, reject, AND a synchronous throw - so a
     * second Enter (or a send click) during the two IPC round-trips inside
     * startAsk cannot create a second session (F1). */
    function submitAsk(target, options) {
      if (!onAsk || !target || askInFlight) {
        return;
      }
      const region = askRegionOf(target);
      const text = String(target.value || '');
      setAskBusy(region, target, true);
      let outcome;
      try {
        outcome = onAsk(text, options);
      } catch (_error) {
        setAskBusy(region, target, false);
        return;
      }
      if (outcome && typeof outcome.then === 'function') {
        outcome.then(
          fence.guard((settled) => {
            setAskBusy(region, target, false);
            if (settled !== false) clearIfUnchanged(target, text);
          }),
          fence.guard(() => { setAskBusy(region, target, false); })
        );
        return;
      }
      setAskBusy(region, target, false);
      if (outcome !== false) {
        clearIfUnchanged(target, text);
      }
    }

    function handleAskKeydown(event) {
      const target = event?.target;
      if (target?.dataset?.homeAskInput !== '1') {
        return;
      }
      const key = String(event.key || '');
      if (key === 'Escape') {
        // The popover primitive installs its own document-level Escape-to-close
        // that runs AFTER this delegated handler, so an open panel is left to
        // it. Either way the draft is never touched.
        const panel = askRegionOf(target)?.querySelector?.(ASK_PANEL_SELECTOR) || null;
        if (panel && panel.hidden !== true) {
          return;
        }
        target.blur?.();
        return;
      }
      if (key !== 'Enter') {
        return;
      }
      if (event.shiftKey === true) {
        // Let the textarea insert the newline itself; the `input` listener
        // below autosizes once the character actually exists (a keydown fires
        // before it does).
        return;
      }
      event.preventDefault?.();
      submitAsk(target, { send: !(event.ctrlKey === true || event.metaKey === true) });
    }

    function handleAskInput(event) {
      const target = event?.target;
      if (target?.dataset?.homeAskInput !== '1') {
        return;
      }
      refreshAskField(target);
    }

    function handleAskClick(event) {
      const trigger = event?.target?.closest?.(ASK_SEND_SELECTOR);
      if (!trigger) {
        return;
      }
      event.preventDefault?.();
      const field = askRegionOf(trigger)?.querySelector?.(ASK_FIELD_SELECTOR) || null;
      submitAsk(field, { send: true });
    }

    // Re-reads the persisted width off live config; called from the manager's
    // paint so an echoed config (or another window's write) lands visually.
    function syncFromConfig() {
      if (dragState) {
        return railWidth;
      }
      railWidth = clampWidth(asObject(getHomeConfig()?.layout)?.railWidth);
      applyWidth(railWidth);
      return railWidth;
    }

    function dispose() {
      fence.dispose();
      const askTarget = homeInfoStrip?.querySelector?.(ASK_FIELD_SELECTOR) || null;
      setAskBusy(askRegionOf(askTarget), askTarget, false);
      cancelPersistTimer();
      if (dragState) {
        const finished = dragState;
        dragState = null;
        eventTarget?.removeEventListener?.('pointermove', handlePointerMove);
        eventTarget?.removeEventListener?.('pointerup', endDrag);
        eventTarget?.removeEventListener?.('pointercancel', endDrag);
        homeDaybook?.classList?.remove?.('is-resizing');
        try {
          finished.target?.releasePointerCapture?.(finished.pointerId);
        } catch (_error) {
          /* best-effort */
        }
      }
      homeRailResizer?.removeEventListener?.('pointerdown', handleResizerPointerDown);
      homeRailResizer?.removeEventListener?.('keydown', handleResizerKeydown);
      homeRailGrip?.removeEventListener?.('pointerdown', handleGripPointerDown);
      homeInfoStrip?.removeEventListener?.('keydown', handleAskKeydown);
      homeInfoStrip?.removeEventListener?.('input', handleAskInput);
      homeInfoStrip?.removeEventListener?.('click', handleAskClick);
    }

    homeRailResizer?.addEventListener?.('pointerdown', handleResizerPointerDown);
    homeRailResizer?.addEventListener?.('keydown', handleResizerKeydown);
    homeRailGrip?.addEventListener?.('pointerdown', handleGripPointerDown);
    homeInfoStrip?.addEventListener?.('keydown', handleAskKeydown);
    homeInfoStrip?.addEventListener?.('input', handleAskInput);
    homeInfoStrip?.addEventListener?.('click', handleAskClick);
    applyWidth(railWidth);

    return {
      syncFromConfig,
      dispose,
    };
  }

  return {
    createDaybookController,
    RAIL_WIDTH_MIN,
    RAIL_WIDTH_MAX,
    RAIL_WIDTH_DEFAULT,
    RAIL_ROW_PX,
  };
});
