/* renderer/shell/renderer-settings-snapshot-poll.js
 *
 * UIUX-009: renderer-app-shell-bindings.js polls every 15s and every
 * successful poll re-renders Settings (renderer-lifecycle-utils.js ->
 * renderer-settings-utils.js). Several Settings subtrees are repainted via
 * innerHTML from last-known-persisted state -- a poll mid-edit silently
 * erases the node, its value, selection range, and focus (custom compaction
 * prompt textarea, web-search provider select + API-key password fields).
 *
 * Read-only Settings surfaces already avoid this via a signature-diffed
 * innerHTML guard (see renderer-settings-v2-surfaces.js's paintSlot: it skips
 * the rewrite when the source data signature is unchanged, which incidentally
 * preserves <details> open state). Editable form subtrees need the same
 * signature diff PLUS a check that never fires across an active focus or an
 * unsaved local draft -- that's what this sibling module adds:
 *
 *   - createSnapshotPoller: a coalesced, self-scheduling replacement for
 *     windowRef.setInterval. Never starts a new tick while the previous task
 *     is still in flight, and drops its own stale continuation if stopped
 *     mid-flight.
 *   - decidePatch / createSectionPatchGuard: a pure decision function (never
 *     patch across focus, a dirty draft, or an unchanged signature) plus a
 *     small stateful wrapper that resolves focus/dirty/signature from the
 *     real Settings DOM + live state, and reports a conflict (signature
 *     changed while a draft was dirty) at most once per stale signature so
 *     the caller can surface an inline notice.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsSnapshotPoll = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Stable string signature for an arbitrary list of primitives/objects, used
  // to detect "did the data that feeds this subtree actually change".
  function buildSignature(parts) {
    const list = Array.isArray(parts) ? parts : [parts];
    return list.map((part) => {
      if (part === null || part === undefined) return '';
      if (typeof part === 'object') {
        try {
          return JSON.stringify(part);
        } catch (_error) {
          return String(part);
        }
      }
      return String(part);
    }).join('|');
  }

  // Pure decision function -- directly unit-testable without any DOM. Never
  // replace a subtree that (a) contains the active focused element, (b) has
  // an unsaved local draft, or (c) is unchanged.
  function decidePatch(inputs) {
    const source = inputs || {};
    if (source.focusWithin) return false;
    if (source.dirtyDraft) return false;
    if (!source.signatureChanged) return false;
    return true;
  }

  // Coalesced self-scheduling poller. Replaces a raw windowRef.setInterval:
  // the next tick is only scheduled once the current task settles (so a slow
  // task never causes overlapping in-flight calls), and generation-guards its
  // own reschedule so stop() during an in-flight task doesn't resurrect a
  // timer afterward.
  function createSnapshotPoller(options) {
    const source = options || {};
    const windowRef = source.windowRef
      || (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
    const documentRef = source.documentRef || (windowRef && windowRef.document);
    const task = typeof source.task === 'function' ? source.task : function noopTask() { return Promise.resolve(); };
    const parsedInterval = Number(source.intervalMs);
    const intervalMs = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 15000;
    const onError = typeof source.onError === 'function' ? source.onError : function noopOnError() {};
    const autoStart = source.autoStart !== false;

    let generation = 0;
    let timerId = null;
    let inFlight = false;
    let stopped = false;
    let paused = Boolean(documentRef && documentRef.visibilityState === 'hidden');
    let visibilityListenerAttached = false;

    function scheduleNext() {
      if (stopped || paused || !windowRef || typeof windowRef.setTimeout !== 'function') return;
      timerId = windowRef.setTimeout(runOnce, intervalMs);
    }

    function runOnce() {
      timerId = null;
      if (stopped || inFlight) return;
      inFlight = true;
      const startedGeneration = (generation += 1);
      Promise.resolve()
        .then(() => task(startedGeneration))
        .catch((error) => onError(error))
        .then(() => {
          inFlight = false;
          // Drop this tick's own continuation if stop() fired mid-flight, or
          // if a newer generation has already started (defensive; runOnce is
          // re-entrancy-guarded above so this should only trip on stop()).
          if (stopped || startedGeneration !== generation) return;
          scheduleNext();
        });
    }

    function start() {
      if (stopped) return controller;
      if (timerId == null && !inFlight) scheduleNext();
      return controller;
    }

    function handleVisibilityChange() {
      if (documentRef && documentRef.visibilityState === 'hidden') {
        paused = true;
        if (timerId != null && windowRef && typeof windowRef.clearTimeout === 'function') {
          windowRef.clearTimeout(timerId);
        }
        timerId = null;
        return;
      }
      if (!paused) return;
      paused = false;
      runOnce();
    }

    function stop() {
      stopped = true;
      if (timerId != null && windowRef && typeof windowRef.clearTimeout === 'function') {
        windowRef.clearTimeout(timerId);
      }
      timerId = null;
      if (visibilityListenerAttached && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      visibilityListenerAttached = false;
    }

    const controller = {
      start,
      stop,
      isInFlight: function isInFlightFn() { return inFlight; },
      getGeneration: function getGenerationFn() { return generation; },
    };
    if (documentRef && typeof documentRef.addEventListener === 'function') {
      documentRef.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityListenerAttached = true;
    }
    if (autoStart) start();
    return controller;
  }

  // Stateful guard around decidePatch: resolves focusWithin/dirtyDraft from
  // the real DOM + live state for a named set of sections, and remembers the
  // last signature + last-painted field values a patch was approved for so
  // unrelated calls (poll-driven or action-driven) stay consistent.
  //
  // Dirty-draft detection deliberately compares the live DOM value against
  // the value LAST ACTUALLY PAINTED into that field -- not against the
  // current state. Comparing against current state would misfire on every
  // legitimate signature change: the DOM always lags one tick behind a fresh
  // signature by definition (that's the repaint this guard is deciding
  // whether to allow), so it would look "dirty" even with zero user input.
  // Comparing against the last paint isolates true user edits.
  //
  // sections[sectionId] = {
  //   containerId: string,                      // element id in the real
  //                                              // Settings DOM (see
  //                                              // renderer-settings-utils.js
  //                                              // section boundaries)
  //   container(doc): Element|null,              // alternative to containerId
  //   fieldSelector: string,                     // selector (scoped to the
  //                                              // container) for elements
  //                                              // that can hold in-progress
  //                                              // user input
  //   signature(state): string,
  //   fields: { [key]: (state) => string },      // pure extractors: what
  //                                              // SHOULD be painted for
  //                                              // each tracked field key
  //   fieldKeyForElement(fieldEl): string|null,   // maps a live DOM element
  //                                              // (matched by fieldSelector)
  //                                              // to one of the `fields`
  //                                              // keys, or null to exclude
  //   onConflict(sectionId): void,                // optional; called at most
  //                                              // once per stale signature
  //                                              // when a patch is skipped
  //                                              // because a dirty draft
  //                                              // collided with a changed
  //                                              // signature
  // }
  function createSectionPatchGuard(options) {
    const source = options || {};
    const state = source.state || {};
    const getDocument = typeof source.documentRef === 'function'
      ? source.documentRef
      : function defaultGetDocument() {
        return source.documentRef || (typeof document !== 'undefined' ? document : null);
      };
    const sections = source.sections && typeof source.sections === 'object' ? source.sections : {};

    const lastSignatureById = new Map();
    const lastPaintedByIdAndKey = new Map(); // sectionId -> Map(key -> value)
    const notifiedConflictSignatureById = new Map();

    function resolveContainer(sectionConfig) {
      const doc = getDocument();
      if (!doc) return null;
      if (typeof sectionConfig.container === 'function') return sectionConfig.container(doc);
      if (sectionConfig.containerId && typeof doc.getElementById === 'function') {
        return doc.getElementById(sectionConfig.containerId);
      }
      return null;
    }

    function isFocusWithin(container) {
      if (!container) return false;
      const doc = getDocument();
      const active = doc && doc.activeElement;
      return Boolean(active && typeof container.contains === 'function' && container.contains(active));
    }

    function isDirtyDraft(sectionId, container, sectionConfig) {
      if (!container || !sectionConfig.fieldSelector || typeof sectionConfig.fieldKeyForElement !== 'function') {
        return false;
      }
      if (typeof container.querySelectorAll !== 'function') return false;
      const lastPainted = lastPaintedByIdAndKey.get(sectionId);
      if (!lastPainted) return false; // nothing painted yet -- can't be dirty relative to nothing
      const fieldExtractors = sectionConfig.fields && typeof sectionConfig.fields === 'object' ? sectionConfig.fields : {};
      const fields = container.querySelectorAll(sectionConfig.fieldSelector);
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        const key = sectionConfig.fieldKeyForElement(field);
        if (key === null || key === undefined || !lastPainted.has(key)) continue;
        const liveValue = String(field.value == null ? '' : field.value);
        if (liveValue === lastPainted.get(key)) continue;
        // Diverges from the painted baseline -- but if it MATCHES what the
        // current state says should be painted, the user's edit was already
        // COMMITTED (the section's own save path: state updated, DOM already
        // showing the value). That is a self-save, not an unsaved draft;
        // treating it as dirty latched the section out of poll repaints
        // forever and fired a false "changed elsewhere" conflict right after
        // the user's own save (code-review finding). Only a live value that
        // matches NEITHER baseline nor current state is a real dirty draft.
        const extractor = fieldExtractors[key];
        if (typeof extractor === 'function' && liveValue === String(extractor(state) ?? '')) continue;
        return true;
      }
      return false;
    }

    function recordPaintedBaseline(sectionId, sectionConfig) {
      const fieldExtractors = sectionConfig.fields && typeof sectionConfig.fields === 'object' ? sectionConfig.fields : {};
      const snapshot = new Map();
      for (const key of Object.keys(fieldExtractors)) {
        snapshot.set(key, String(fieldExtractors[key](state) ?? ''));
      }
      lastPaintedByIdAndKey.set(sectionId, snapshot);
    }

    // Unknown sections are unguarded (always patch) so a caller can register
    // a section incrementally without silently freezing it.
    function shouldPatchSection(sectionId) {
      const sectionConfig = sections[sectionId];
      if (!sectionConfig) return true;
      const container = resolveContainer(sectionConfig);
      const focusWithin = isFocusWithin(container);
      const dirtyDraft = isDirtyDraft(sectionId, container, sectionConfig);
      const signature = typeof sectionConfig.signature === 'function' ? sectionConfig.signature(state) : '';
      const signatureChanged = lastSignatureById.get(sectionId) !== signature;
      const patch = decidePatch({ focusWithin, dirtyDraft, signatureChanged });
      if (patch) {
        lastSignatureById.set(sectionId, signature);
        recordPaintedBaseline(sectionId, sectionConfig);
        notifiedConflictSignatureById.delete(sectionId);
      } else if (dirtyDraft && signatureChanged && notifiedConflictSignatureById.get(sectionId) !== signature) {
        notifiedConflictSignatureById.set(sectionId, signature);
        if (typeof sectionConfig.onConflict === 'function') sectionConfig.onConflict(sectionId);
      }
      return patch;
    }

    return { shouldPatchSection };
  }

  return {
    buildSignature,
    decidePatch,
    createSnapshotPoller,
    createSectionPatchGuard,
  };
});
