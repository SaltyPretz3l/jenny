/* renderer/shell/renderer-overlay-manager.js
 *
 * The shared stack arbitrates Escape and focus trapping for managed overlays.
 * The command palette remains outside it.
 *
 * Contract
 * --------
 * `createOverlayManager({ documentRef })` returns:
 *   - open(entry): entry = { id, root, onRequestClose, restoreFocusTo?, trapFocus?, inertTargets? }
 *       - id (string, required, unique): re-opening an id already on the
 *         stack is a no-op that returns false.
 *       - root (Element, required): the overlay's outermost container --
 *         used only to scope the Tab focus trap. The manager never touches
 *         its contents.
 *       - onRequestClose(reason): required. Called by the manager when
 *         Escape (reason 'escape') or the owner's own backdrop wiring
 *         (reason 'backdrop', see below) asks the overlay to close. The
 *         OWNER performs whatever teardown/animation it needs and MUST then
 *         call manager.close(id) itself -- the manager never removes an
 *         entry on its own initiative.
 *       - restoreFocusTo (Element, optional): defaults to
 *         documentRef.activeElement captured at open() time.
 *       - fallbackFocusTo (Element, optional): where close() sends focus if
 *         restoreFocusTo has gone missing by close time -- removed from the
 *         document, or no longer focusable (e.g. a list row deleted or
 *         re-rendered by a virtualizer while the overlay was open; see
 *         UIUX-018's origin-restore requirement). Checked via `.isConnected`
 *         when available. If omitted and restoreFocusTo is gone, close()
 *         does not force focus anywhere (the platform's own default-focus
 *         behavior applies) -- callers that care about a deterministic
 *         landing spot (e.g. a stable app-shell region) should supply one.
 *       - trapFocus (boolean, default true).
 *       - inertTargets (Element|Element[], optional): background regions made
 *         inert while this entry is open. Nested overlays are reference
 *         counted and each target's prior inert state is restored exactly.
 *     Pushes onto an internal stack; the stack's LAST entry is the
 *     innermost/topmost overlay. Lazily installs exactly ONE capture-phase
 *     `keydown` listener on documentRef when the stack goes 0 -> 1, and
 *     removes it when the stack goes 1 -> 0.
 *   - close(id): removes that entry (from any position, though normally the
 *     top) and restores focus to its restoreFocusTo (try
 *     `focus({ preventScroll: true })`, fall back to plain `focus()`).
 *     Returns true/false.
 *   - isOpen(id?): with an id, whether that entry is on the stack; with no
 *     id, whether the stack is non-empty.
 *   - getDepth(): current stack size.
 *   - dispose(): removes the document listener, releases all inert targets,
 *     and permanently closes the manager without restoring focus.
 *
 * Escape rule (the core of "one overlay manager"): on a capture-phase
 * keydown Escape --
 *   - if event.defaultPrevented, do nothing (an inner component, e.g. an
 *     autocomplete popover, already preempted by calling preventDefault
 *     from its own earlier-registered document-capture listener);
 *   - if event.isComposing, do nothing (IME composition eating Escape);
 *   - otherwise preventDefault + stopPropagation and call ONLY the top
 *     entry's onRequestClose('escape'). One Escape peels exactly one layer,
 *     innermost first.
 *
 * Focus trap: while the TOP entry has trapFocus !== false, Tab/Shift+Tab
 * cycles within its `root` across visible (offsetParent !== null),
 * non-disabled focusables -- same selector/approach as
 * renderer/inventory/help-overlay.js's getFocusable(), inlined here rather
 * than required from an inventory module (this is a shell-tier primitive).
 * An entry below the top never traps, even if it asked for trapFocus.
 *
 * Backdrop: this module owns NO scrim markup. Owners wire their own scrim's
 * click handler to call `onRequestClose('backdrop')` and then `manager.close(id)`
 * exactly like the Escape path -- the manager just doesn't know backdrops
 * exist.
 *
 * No body scroll lock, BY DECISION: Jenny is an Electron app whose window-level
 * `body` never scrolls (every panel owns its own internal scroll region), so
 * there is nothing for a body-scroll-lock to protect against here. Do not
 * add one without re-checking that assumption.
 *
 * z-index contract for consumers: overlays registered with this manager
 * should sit at `calc(var(--z-overlay) + 6)` or higher (above the command
 * palette's `calc(var(--z-overlay) + 5)`, see styles/foundation.css) and
 * MUST derive from the foundation z-index ladder (--z-popover/--z-toast/
 * --z-overlay in styles/foundation.css), never a hardcoded number.
 * styles/chat-help-overlay-v2.css used to hardcode 9001 (UIUX-019); it now
 * derives from the same ladder tier as quick-settings (+6) since
 * renderer/inventory/help-overlay.js registers with this manager.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererOverlayManagerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Exported (see the return below) so overlays that must hand-roll a trap on
  // a fallback path when this manager is not
  // mounted — share one definition of "focusable" instead of drifting from it.
  const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function createOverlayManager(deps) {
    const options = deps || {};
    const doc = options.documentRef || (typeof document !== 'undefined' ? document : null);

    // Stack of live entries; stack[stack.length - 1] is the innermost/top.
    const stack = [];
    const inertTargetState = new Map();
    let listenerInstalled = false;
    let disposed = false;

    function topEntry() {
      return stack.length ? stack[stack.length - 1] : null;
    }

    function findIndexById(id) {
      for (let i = 0; i < stack.length; i += 1) {
        if (stack[i].id === id) return i;
      }
      return -1;
    }

    function getFocusable(rootEl) {
      if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
      return Array.prototype.slice.call(rootEl.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter((el) => el && el.offsetParent !== null);
    }

    function handleTabKey(event, entry) {
      if (!entry || entry.trapFocus === false) return;
      const focusable = getFocusable(entry.root);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = doc ? doc.activeElement : null;
      if (event.shiftKey) {
        if (activeEl === first || !entry.root.contains(activeEl)) {
          event.preventDefault();
          try { last.focus(); } catch (_e) { /* ignore */ }
        }
      } else if (activeEl === last || !entry.root.contains(activeEl)) {
        event.preventDefault();
        try { first.focus(); } catch (_e) { /* ignore */ }
      }
    }

    function handleKeydown(event) {
      const top = topEntry();
      if (!top) return;
      const key = String(event.key || '');
      if (key === 'Escape') {
        if (event.defaultPrevented) return;
        if (event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        try { top.onRequestClose('escape'); } catch (_e) { /* swallow: owner's problem to surface */ }
        return;
      }
      if (key === 'Tab') {
        handleTabKey(event, top);
      }
    }

    function ensureListener() {
      if (listenerInstalled || !doc) return;
      doc.addEventListener('keydown', handleKeydown, true);
      listenerInstalled = true;
    }

    function teardownListenerIfEmpty() {
      if (stack.length || !listenerInstalled || !doc) return;
      doc.removeEventListener('keydown', handleKeydown, true);
      listenerInstalled = false;
    }

    function normalizeInertTargets(value) {
      let targets = value;
      if (typeof targets === 'function') {
        try { targets = targets(); } catch (_error) { targets = []; }
      }
      if (!Array.isArray(targets)) targets = targets ? [targets] : [];
      return targets.filter((target, index) => target
        && typeof target.setAttribute === 'function'
        && targets.indexOf(target) === index);
    }

    function acquireInertTargets(targets) {
      targets.forEach((target) => {
        const current = inertTargetState.get(target);
        if (current) {
          current.count += 1;
          return;
        }
        const hasAttribute = typeof target.hasAttribute === 'function' && target.hasAttribute('inert');
        const attributeValue = hasAttribute && typeof target.getAttribute === 'function'
          ? target.getAttribute('inert')
          : null;
        const hasProperty = 'inert' in target;
        const propertyValue = hasProperty ? Boolean(target.inert) : false;
        inertTargetState.set(target, {
          count: 1,
          hasAttribute,
          attributeValue,
          hasProperty,
          propertyValue,
        });
        if (hasProperty) target.inert = true;
        else target.setAttribute('inert', '');
      });
    }

    function releaseInertTargets(targets) {
      targets.forEach((target) => {
        const current = inertTargetState.get(target);
        if (!current) return;
        current.count -= 1;
        if (current.count > 0) return;
        inertTargetState.delete(target);
        if (current.hasProperty) target.inert = current.propertyValue;
        if (current.hasAttribute) {
          target.setAttribute('inert', current.attributeValue == null ? '' : current.attributeValue);
        } else if (typeof target.removeAttribute === 'function') {
          target.removeAttribute('inert');
        }
      });
    }

    function open(entry) {
      const conf = entry || {};
      const id = String(conf.id || '').trim();
      if (disposed) return false;
      if (!id || !conf.root || typeof conf.onRequestClose !== 'function') return false;
      if (findIndexById(id) !== -1) return false; // reopening the same id is a no-op
      const restoreFocusTo = conf.restoreFocusTo || (doc ? doc.activeElement : null) || null;
      const inertTargets = normalizeInertTargets(conf.inertTargets);
      stack.push({
        id,
        root: conf.root,
        onRequestClose: conf.onRequestClose,
        restoreFocusTo,
        // Re-render resilience (GUI finding 2026-07-20): renderers rebuild
        // chrome (sidebar strips, status rows) while an overlay is open, which
        // detaches the saved node and silently dropped the restore. Capture
        // the id so close() can re-resolve the same logical control.
        restoreFocusId: (restoreFocusTo && typeof restoreFocusTo.id === 'string' && restoreFocusTo.id) || '',
        fallbackFocusTo: conf.fallbackFocusTo || null,
        trapFocus: conf.trapFocus !== false,
        inertTargets,
      });
      acquireInertTargets(inertTargets);
      ensureListener();
      return true;
    }

    function isUsableFocusTarget(el) {
      if (!el || typeof el.focus !== 'function') return false;
      // isConnected is standard DOM; skip the check rather than reject the
      // target on an environment that lacks it.
      return el.isConnected !== false;
    }

    function focusTarget(el) {
      try { el.focus({ preventScroll: true }); }
      catch (_e) { try { el.focus(); } catch (_e2) { /* ignore */ } }
    }

    function close(id) {
      const index = findIndexById(id);
      if (index === -1) return false;
      const wasTop = index === stack.length - 1;
      const [removed] = stack.splice(index, 1);
      releaseInertTargets(removed.inertTargets || []);
      // Restoring focus for a non-top close would yank focus out of the
      // still-open top overlay; only the top entry hands focus back.
      if (wasTop) {
        if (isUsableFocusTarget(removed.restoreFocusTo)) {
          focusTarget(removed.restoreFocusTo);
        } else {
          // The saved node was detached (chrome re-rendered while the overlay
          // was open): re-resolve the same logical control by id before
          // falling back, instead of silently leaving focus on the root.
          const revived = removed.restoreFocusId && doc
            ? doc.getElementById(removed.restoreFocusId)
            : null;
          if (isUsableFocusTarget(revived)) {
            focusTarget(revived);
          } else if (isUsableFocusTarget(removed.fallbackFocusTo)) {
            // The invoker is gone for good -- land on the caller's documented
            // fallback instead of wherever the platform happened to put it.
            focusTarget(removed.fallbackFocusTo);
          }
        }
      }
      teardownListenerIfEmpty();
      return true;
    }

    function isOpen(id) {
      if (id === undefined) return stack.length > 0;
      return findIndexById(id) !== -1;
    }

    function getDepth() {
      return stack.length;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      while (stack.length) {
        const removed = stack.pop();
        releaseInertTargets(removed.inertTargets || []);
      }
      if (listenerInstalled && doc) {
        doc.removeEventListener('keydown', handleKeydown, true);
      }
      listenerInstalled = false;
    }

    return {
      open,
      close,
      isOpen,
      getDepth,
      dispose,
    };
  }

  return { createOverlayManager, FOCUSABLE_SELECTOR };
});
