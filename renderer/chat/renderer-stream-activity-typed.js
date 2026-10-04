/* renderer/chat/renderer-stream-activity-typed.js - what the activity row's typed state reads as, and who hears it change (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamActivityTyped = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  /* The activity row (renderer-stream-activity-row.js) owns the tracked entries.
     The timeline sprite reads their typed state (tool-input drafting,
     compaction, a wait) from here instead of from the row's DOM: a frozen
     snapshot per stream, and a callback that fires only when that snapshot's
     tuple changes, never on a heartbeat or an elapsed-time tick. */

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  // The tuple the sprite derives from. Checklist tools name the list work;
  // `waitState` is the waiting line's own classification ('stuck' or not).
  function readTypedActivity(entry) {
    const typed = entry && entry.typed;
    if (!typed) return null;
    return Object.freeze({
      kind: typed.kind,
      toolName: typed.kind === 'tool_input' ? typed.toolName : '',
      checklist: typed.checklist === true,
      waitState: typed.kind === 'waiting' ? typed.waitState : '',
    });
  }

  function typedActivityKey(entry) {
    const activity = readTypedActivity(entry);
    return activity ? [activity.kind, activity.toolName, activity.checklist, activity.waitState].join('\n') : '';
  }

  function createTypedActivityTracker(tracked) {
    const listeners = new Set();
    // entry -> the key its listeners last heard.
    const announced = new WeakMap();

    function announce(streamId, entry, key) {
      if (key) announced.set(entry, key);
      else announced.delete(entry);
      for (const listener of [...listeners]) {
        try { listener({ streamId, sessionId: entry.sessionId }); } catch (_error) { /* affordance only */ }
      }
    }

    return {
      // After an event settled: announce the stream's typed state if it changed.
      sync(streamId) {
        const entry = tracked.get(streamId);
        if (!entry) return;
        const key = typedActivityKey(entry);
        if (key !== (announced.get(entry) || '')) announce(streamId, entry, key);
      },
      // The entry is leaving the tracker: a typed state that was heard ends.
      release(streamId, entry) {
        if (announced.get(entry)) announce(streamId, entry, '');
      },
      queries: {
        getTypedActivity: (streamId) => readTypedActivity(tracked.get(normalizeId(streamId))),
        onTypedActivityChange(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      },
    };
  }

  return { createTypedActivityTracker };
});
