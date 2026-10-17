/**
 * renderer/features/renderer-side-panel-motion.js
 *
 * Side-panel column motion with the reading text reflowing once (UMD), row 59
 * checkpoint 1 (chat workspace parity spec, "Panel motion").
 *
 * The side panel's column grows from 0 to its width (open) or collapses back
 * (close) while the reading text keeps one width, so the transcript reflows at
 * a single point instead of on every frame. Both existing panels use this
 * (the artifact review panel through its keyframes, the chat context panel
 * through its width transition); this module owns only the orchestration.
 *
 * Mechanism, for the headless layout gate and for styles/context-panel.css:
 *
 *   #chatView[data-panel-motion]   "measuring" | "opening" | "closing"
 *       measuring  the end state is applied with no motion so it can be measured
 *       opening    the column grows (open) ; closing  the column collapses
 *   #chatView  --side-panel-content-width: <px>
 *       the panel's final content width. The panel's children are held at it
 *       for the duration, so panel content never reflows during the motion.
 *   .chat-pane  --chat-measure-lock: <px>
 *       on every visible pane for the duration: both the timeline measure and
 *       the composer use exactly this width (the cross-slice contract with
 *       styles/chat-*.css). Open locks the measure the pane has when the panel
 *       is fully open, so the text reflows once at the start and then only
 *       glides. Close locks the current measure and releases it when the
 *       column has fully collapsed, so it reflows once at the end.
 *
 * The reader position uses the scroll coordinator's own captureReaderAnchor /
 * restoreReaderAnchor (no second anchoring path), called around each reflow
 * point: open = before the lock is applied / after it is applied; close =
 * before the lock is released / after it is released. A reader who is following
 * the latest output keeps following (the coordinator models that: it holds no
 * anchor then and its restore is a no-op).
 *
 * Nothing animates when `animate` is not wanted by the caller, with reduced
 * motion, or with a zero-duration motion token: the end state is applied at
 * once, still as one reflow with anchor capture and restore. A re-toggle
 * mid-motion cancels it (the lock is released) and the caller snaps to the new
 * state; dispose and a session switch do the same.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSidePanelMotion = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MOTION_ATTRIBUTE = 'panelMotion';
  const MEASURE_LOCK_PROPERTY = '--chat-measure-lock';
  const CONTENT_WIDTH_PROPERTY = '--side-panel-content-width';
  const DURATION_TOKEN = '--motion-duration-regular';
  const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
  // Fallback after the duration: a missed animationend / transitionend must
  // never leave the lock held.
  const FALLBACK_SLACK_MS = 50;

  // One motion at a time per host: starting one cancels the other panel's.
  const activeByHost = new WeakMap();

  function parseDurationMs(raw) {
    const match = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/i.exec(String(raw || ''));
    if (!match) return 0;
    const value = Number.parseFloat(match[1]);
    return Math.max(0, match[2].toLowerCase() === 's' ? value * 1000 : value);
  }

  function createSidePanelMotion(options) {
    const { chatView, getCoordinators = () => [], getDurationMs = null, isReducedMotion = null } = options || {};
    const win = options?.win || chatView?.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);

    // active: { phase, panel, onEnd, timer, locked, finish } while a motion runs.
    let active = null;
    let disposed = false;

    function coordinators() {
      try { return (getCoordinators() || []).filter(Boolean); } catch (_error) { return []; }
    }
    function captureAnchors() {
      for (const coordinator of coordinators()) {
        try { coordinator.captureReaderAnchor?.(); } catch (_error) { /* a coordinator mid-dispose */ }
      }
    }
    function restoreAnchors() {
      for (const coordinator of coordinators()) {
        try { coordinator.restoreReaderAnchor?.(); } catch (_error) { /* a coordinator mid-dispose */ }
      }
    }
    function forceLayout() {
      if (chatView && typeof chatView.offsetWidth === 'number') void chatView.offsetWidth;
    }
    function setPhase(phase) {
      if (chatView?.dataset) chatView.dataset[MOTION_ATTRIBUTE] = phase;
    }
    function clearPhase() {
      if (chatView?.dataset) delete chatView.dataset[MOTION_ATTRIBUTE];
    }

    function durationMs() {
      if (typeof getDurationMs === 'function') return Math.max(0, Number(getDurationMs()) || 0);
      if (!chatView || typeof win?.getComputedStyle !== 'function') return 0;
      return parseDurationMs(win.getComputedStyle(chatView).getPropertyValue(DURATION_TOKEN));
    }
    function reducedMotion() {
      if (typeof isReducedMotion === 'function') return isReducedMotion() === true;
      return win?.matchMedia?.(REDUCED_MOTION_QUERY)?.matches === true;
    }
    function motionWanted(panel) {
      return !disposed && Boolean(chatView && panel) && !reducedMotion() && durationMs() > 0;
    }

    // The width a pane's reading column has right now: the timeline's own box is
    // the measure (the composer can be held wider by its 320px floor in the
    // narrowest split pane, so it is not read here).
    function measureVisiblePanes() {
      const measures = [];
      const panes = chatView?.querySelectorAll ? Array.from(chatView.querySelectorAll('.chat-pane')) : [];
      for (const pane of panes) {
        const timeline = pane.querySelector?.('[data-chat-node="chatTimeline"]');
        const width = Number(timeline?.getBoundingClientRect?.().width) || 0;
        if (width > 0) measures.push([pane, Math.round(width * 100) / 100]);
      }
      return measures;
    }
    function applyLocks(measures) {
      for (const [pane, width] of measures) pane.style?.setProperty?.(MEASURE_LOCK_PROPERTY, `${width}px`);
      return measures.map(([pane]) => pane);
    }
    function setContentWidth(panel) {
      const width = Number(panel?.clientWidth) || 0;
      if (width > 0) chatView.style?.setProperty?.(CONTENT_WIDTH_PROPERTY, `${width}px`);
    }
    function releaseLocks(panes) {
      for (const pane of panes || []) pane.style?.removeProperty?.(MEASURE_LOCK_PROPERTY);
      chatView?.style?.removeProperty?.(CONTENT_WIDTH_PROPERTY);
    }

    // Stop listening and timing without touching the DOM state.
    function teardown(entry) {
      if (!entry) return;
      if (entry.timer !== null && typeof win?.clearTimeout === 'function') win.clearTimeout(entry.timer);
      entry.timer = null;
      if (entry.panel && entry.onEnd) {
        entry.panel.removeEventListener?.('animationend', entry.onEnd);
        entry.panel.removeEventListener?.('transitionend', entry.onEnd);
      }
      entry.onEnd = null;
    }

    function claimHost() {
      const other = activeByHost.get(chatView);
      if (other && other !== api) other.cancel();
      activeByHost.set(chatView, api);
    }

    // Run `finish` once, from the first of the panel's own end event or the timeout.
    function armEnd(entry, finish) {
      entry.finish = finish;
      entry.onEnd = (event) => { if (event.target === entry.panel) finish(); };
      entry.panel.addEventListener?.('animationend', entry.onEnd);
      entry.panel.addEventListener?.('transitionend', entry.onEnd);
      if (typeof win?.setTimeout === 'function') {
        entry.timer = win.setTimeout(finish, durationMs() + FALLBACK_SLACK_MS);
      }
    }

    function runInstant(applyEnd) {
      captureAnchors();
      applyEnd();
      forceLayout();
      restoreAnchors();
      return false;
    }

    /**
     * Open. `applyEnd` applies the fully-open DOM state. `applyStart` (panels
     * driven by a CSS transition) restores the closed state, because a
     * transition needs the start state rendered before it begins; panels driven
     * by keyframes omit it (their `from` frame is the start state).
     * Returns true when a motion started.
     */
    function open({ panel, applyEnd, applyStart = null }) {
      cancel();
      if (!motionWanted(panel)) return runInstant(applyEnd);
      claimHost();
      captureAnchors();
      setPhase('measuring');
      applyEnd();
      forceLayout();
      const measures = measureVisiblePanes();
      setContentWidth(panel);
      if (applyStart) { applyStart(); forceLayout(); }
      const locked = applyLocks(measures);
      setPhase('opening');
      if (applyStart) applyEnd();
      forceLayout();
      restoreAnchors();
      const entry = { phase: 'opening', panel, locked, timer: null, onEnd: null, finish: null };
      active = entry;
      armEnd(entry, () => {
        if (active !== entry) return;
        active = null;
        teardown(entry);
        // The lock equals the measure the open pane now has, so releasing it is
        // a no-op reflow; the anchor still brackets it.
        captureAnchors();
        releaseLocks(entry.locked);
        clearPhase();
        forceLayout();
        restoreAnchors();
      });
      return true;
    }

    /**
     * Close. `applyEnd` applies the closed DOM state. With `deferEnd` (panels
     * whose keyframes must keep the panel visible) it runs when the column has
     * collapsed; otherwise it runs now and the panel's transition plays.
     * Returns true when a motion started.
     */
    function close({ panel, applyEnd, deferEnd = false }) {
      cancel();
      if (!motionWanted(panel) || !(Number(panel.clientWidth) > 0)) return runInstant(applyEnd);
      claimHost();
      const locked = applyLocks(measureVisiblePanes());
      setContentWidth(panel);
      setPhase('closing');
      if (!deferEnd) applyEnd();
      forceLayout();
      // A deferred end not yet applied: a cancel (re-toggle, the other panel claiming the host) applies it.
      const entry = { phase: 'closing', panel, locked, timer: null, onEnd: null, finish: null, pendingEnd: deferEnd ? applyEnd : null };
      active = entry;
      armEnd(entry, () => {
        if (active !== entry) return;
        active = null;
        teardown(entry);
        // The reflow point: capture, collapse the column, release the lock, restore.
        captureAnchors();
        entry.pendingEnd = null;
        if (deferEnd) applyEnd();
        releaseLocks(entry.locked);
        clearPhase();
        forceLayout();
        restoreAnchors();
      });
      return true;
    }

    // A re-toggle mid-motion, a session switch: release the lock and snap. The
    // caller applies whichever state it wants next.
    function cancel() {
      const entry = active;
      if (!entry) return false;
      active = null;
      teardown(entry);
      captureAnchors();
      const pendingEnd = entry.pendingEnd;
      entry.pendingEnd = null;
      if (typeof pendingEnd === 'function') pendingEnd();
      releaseLocks(entry.locked);
      clearPhase();
      forceLayout();
      restoreAnchors();
      return true;
    }

    function dispose() {
      disposed = true;
      const entry = active;
      active = null;
      teardown(entry);
      if (entry) {
        releaseLocks(entry.locked);
        clearPhase();
      }
      if (chatView && activeByHost.get(chatView) === api) activeByHost.delete(chatView);
    }

    const api = {
      open,
      close,
      cancel,
      dispose,
      // 'idle' | 'opening' | 'closing'
      state: () => (active ? active.phase : 'idle'),
    };
    return api;
  }

  return { createSidePanelMotion, parseDurationMs };
});
