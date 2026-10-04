/* renderer/chat/renderer-chat-ctrl-wheel-gate.js -- Ctrl-gated non-passive wheel zoom listener (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatCtrlWheelGate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A non-passive wheel listener makes Chromium wait for the main thread
  // before it can scroll, so an always-on Ctrl+wheel zoom listener turned
  // every long render task into wheel jank while a turn streamed
  // (timeline-perf 2026-09-30). The non-passive listener is attached only
  // while Ctrl is held.
  //
  // One Ctrl-held tracker per window. Pane 0 installs its listeners through
  // its own registerListener (so they dispose with pane 0); other panes look
  // the tracker up. `held` mirrors the modifier so a subscriber that binds
  // mid-hold starts in the right state; a window blur (alt-tab with Ctrl down)
  // releases it. Ctrl pressed before the window had focus never produced a
  // keydown here: pointer and wheel events carry the modifier, so they
  // re-sync the state (passive: neither can delay a scroll; a first
  // Ctrl+wheel tick seen this way scrolls once, the next one zooms).
  //
  // The tracker object outlives pane 0's listeners: a release (pane 0
  // dispose) drops `held` so every subscriber detaches its non-passive
  // listener, keeps the subscriptions, and the next install re-registers the
  // window listeners on the same object, so a second pane bound across a
  // pane-0 re-bind keeps working (Astra finding, timeline-perf 2026-09-30).
  const ctrlKeyTrackers = new WeakMap();

  function getOrCreateTracker(windowRef) {
    const existing = ctrlKeyTrackers.get(windowRef);
    if (existing) return existing;
    const subscribers = new Set();
    const tracker = {
      held: false,
      installed: false,
      subscribe(subscriber) {
        subscribers.add(subscriber);
        return () => { subscribers.delete(subscriber); };
      },
      setHeld(held) {
        if (tracker.held === held) return;
        tracker.held = held;
        for (const subscriber of subscribers) {
          try { (held ? subscriber.onDown : subscriber.onUp)?.(); } catch (_error) { /* one subscriber must not block the rest */ }
        }
      },
      notifyInstalled() {
        for (const subscriber of subscribers) {
          try { subscriber.onInstall?.(); } catch (_error) { /* one subscriber must not block the rest */ }
        }
      },
    };
    ctrlKeyTrackers.set(windowRef, tracker);
    return tracker;
  }

  function installCtrlKeyTracker(windowRef, registerListener, listenerOptions) {
    if (!windowRef || typeof windowRef.addEventListener !== 'function' || typeof registerListener !== 'function') {
      return null;
    }
    const tracker = getOrCreateTracker(windowRef);
    if (tracker.installed) return tracker;
    tracker.installed = true;
    tracker.notifyInstalled();
    const setHeld = (held) => tracker.setHeld(held);
    registerListener(windowRef, 'keydown', (event) => { if (event.key === 'Control' || event.ctrlKey) setHeld(true); }, listenerOptions);
    registerListener(windowRef, 'keyup', (event) => { if (event.key === 'Control' || !event.ctrlKey) setHeld(false); }, listenerOptions);
    registerListener(windowRef, 'blur', () => setHeld(false), listenerOptions);
    const passiveOptions = { ...(listenerOptions || {}), passive: true };
    registerListener(windowRef, 'pointermove', (event) => setHeld(event.ctrlKey === true), passiveOptions);
    registerListener(windowRef, 'wheel', (event) => setHeld(event.ctrlKey === true), passiveOptions);
    return tracker;
  }

  // The window's tracker for a pane that does not own the window listeners;
  // created on demand so a pane bound before pane 0 is subscribed by the time
  // pane 0 installs the listeners (`installed` says whether they exist yet).
  function getCtrlKeyTracker(windowRef) {
    return windowRef && typeof windowRef.addEventListener === 'function' ? getOrCreateTracker(windowRef) : null;
  }

  // Pane 0's dispose: its window listeners are gone with its abort signal, so
  // nothing can release Ctrl any more. Drop `held` (every subscriber detaches)
  // and let the next install re-register the listeners.
  function releaseCtrlKeyTracker(windowRef) {
    const tracker = windowRef ? ctrlKeyTrackers.get(windowRef) : null;
    if (!tracker) return;
    tracker.installed = false;
    tracker.setHeld(false);
  }

  // Binds `onWheel` on `chatView` as a non-passive wheel listener that exists
  // only while Ctrl is held. Pane 0 (`documentLevel`) owns the window-level
  // tracker; another pane subscribes to it. A pane bound before the tracker's
  // listeners exist keeps the always-on listener until they do, then migrates
  // to the gate. Without a usable window the always-on listener stays.
  function bindCtrlGatedWheelZoom(options) {
    const {
      chatView, windowRef, documentLevel, registerListener, listenerOptions, addCleanup, bindAbortController, onWheel,
    } = options || {};
    if (!chatView || typeof chatView.addEventListener !== 'function' || typeof onWheel !== 'function') return false;
    const cleanup = typeof addCleanup === 'function' ? addCleanup : () => {};
    let attached = false;
    const attach = () => {
      if (attached) return;
      attached = true;
      chatView.addEventListener('wheel', onWheel, { passive: false });
    };
    const detach = () => {
      if (!attached) return;
      attached = false;
      chatView.removeEventListener('wheel', onWheel);
    };
    const tracker = documentLevel
      ? installCtrlKeyTracker(windowRef, registerListener, listenerOptions)
      : getCtrlKeyTracker(windowRef);
    if (!tracker) {
      registerListener(chatView, 'wheel', onWheel, bindAbortController
        ? { signal: bindAbortController.signal, passive: false }
        : { passive: false });
      return false;
    }
    let gated = tracker.installed;
    cleanup(tracker.subscribe({
      onDown: () => { if (gated) attach(); },
      onUp: () => { if (gated) detach(); },
      onInstall: () => {
        gated = true;
        if (!tracker.held) detach();
      },
    }));
    if (!gated || tracker.held) attach();
    cleanup(detach);
    return gated;
  }

  return {
    bindCtrlGatedWheelZoom,
    getCtrlKeyTracker,
    installCtrlKeyTracker,
    releaseCtrlKeyTracker,
  };
});
