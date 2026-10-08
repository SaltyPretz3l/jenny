/* renderer/chat/renderer-composer-pane-drafts.js -- split view: which session's draft each pane's composer shows (UMD) */
/**
 * Astra pane findings P1: pane 1 could send another chat's draft. Draft
 * capture read only pane 0's #chatInput, so a pane whose session changed
 * (pane 1 switched to another chat, the panes swapped, pane 0 closed) kept the
 * text the previous session had typed and its Send posted it to the new one.
 *
 * The records stay renderer-composer-session-state.js's ONE session-keyed
 * store (text, selection, attachments, approved mentions); this module owns the binding between
 * a composer and the session whose draft it holds:
 *
 *   createLiveBinding()  pane 0's live composer (#chatInput and the live
 *       queue) holds the draft of the session a restore wrote or a live
 *       capture read. `restoredAhead`: openSession restores pane 0 BEFORE the
 *       pane layout names the incoming session (two panes, pane 0 focused), so
 *       until the layout catches up, a live capture for the session the layout
 *       still names must not read the incoming session's text into it.
 *   rebindLive(controller, prevId, nextId)  a layout change handed pane 0
 *       another session (swap, close, drag placement, the focused pane's
 *       legacy writer). A restore that already ran for it is kept; otherwise
 *       the live draft and queue go to the session the composer holds (the
 *       one a restore ran ahead for, else the one pane 0 showed) and the
 *       incoming session's record is restored.
 *   captureInput(record, input) / restoreInput(input, record, persistedText)
 *       a second pane's own textarea to and from its session's record, text
 *       selection and approved mentions (its attachment queue IS the record, W2-2b).
 *   writeInput(input, text, start, end)  the one textarea write both paths use.
 *
 * Pure over what it is handed: no DOM lookups, no state reads.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerPaneDrafts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const normalizeId = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).normalizeId;

  function writeInput(input, text, selectionStart, selectionEnd) {
    if (!input) return;
    input.value = String(text || '');
    if (typeof input.setSelectionRange !== 'function') return;
    try {
      const len = input.value.length;
      input.setSelectionRange(
        Math.min(Math.max(Number(selectionStart) || 0, 0), len),
        Math.min(Math.max(Number(selectionEnd) || 0, 0), len)
      );
    } catch (_error) {
      // Not every input-like element supports selection ranges.
    }
  }

  function createLiveBinding() {
    let liveSessionId = '';
    let restoredAhead = false;
    return {
      get: () => liveSessionId,
      isAhead: () => restoredAhead,
      // A live capture read the composer for `sessionId`.
      noteCapture(sessionId) {
        liveSessionId = normalizeId(sessionId);
        restoredAhead = false;
      },
      // A restore wrote `sessionId`'s draft while the layout names `queueSessionId` for pane 0.
      noteRestore(sessionId, queueSessionId) {
        liveSessionId = normalizeId(sessionId);
        restoredAhead = liveSessionId !== normalizeId(queueSessionId);
      },
      // True while a restore that ran ahead of the layout holds the composer
      // for another session than `sessionId` (a capture must not read it).
      heldForOther(sessionId, queueSessionId) {
        if (restoredAhead && normalizeId(queueSessionId) === liveSessionId) restoredAhead = false;
        return restoredAhead && liveSessionId !== normalizeId(sessionId);
      },
      forget(sessionId) {
        if (liveSessionId === normalizeId(sessionId)) liveSessionId = '';
      },
      clear() {
        liveSessionId = '';
        restoredAhead = false;
      },
      rekey(sourceSessionId, targetSessionId) {
        if (liveSessionId && liveSessionId === normalizeId(sourceSessionId)) liveSessionId = normalizeId(targetSessionId);
      },
    };
  }

  function rebindLive(controller, prevSessionId, nextSessionId) {
    const prevId = normalizeId(prevSessionId);
    const nextId = normalizeId(nextSessionId);
    if (!controller || prevId === nextId) return false;
    const binding = controller.liveBinding || null;
    const live = binding ? binding.get() : '';
    if (nextId && live === nextId) return false;
    // A restore that ran ahead of the layout (openSession still loading)
    // holds ANOTHER session's draft and queue: they go back to that session,
    // never to the session the layout still named for pane 0.
    const owner = binding && binding.isAhead() && live ? live : prevId;
    if (owner) controller.captureActive(owner, 'pane_layout', { live: true });
    controller.restoreForSession(nextId);
    return true;
  }

  // A user/composer mutation supersedes a send receipt's clear marker, the
  // rule captureActive applies to pane 0's live composer.
  function captureInput(record, input, mentions) {
    if (!record || !input) return null;
    const text = String(input.value || '');
    if (text !== String(record.text || '')) {
      record.draftRevision = (Number(record.draftRevision) || 0) + 1;
      record.sendReceiptId = '';
    }
    if (mentions && typeof mentions.exportRecords === 'function') record.mentions = mentions.exportRecords(input);
    record.text = text;
    record.selectionStart = Number.isFinite(input.selectionStart) ? input.selectionStart : text.length;
    record.selectionEnd = Number.isFinite(input.selectionEnd) ? input.selectionEnd : text.length;
    record.touchedAtMs = Date.now();
    return record;
  }

  // The record's draft, else the persisted one (a session never typed in this run).
  function restoreInput(input, record, persistedText, mentions) {
    if (!input) return false;
    const text = record ? String(record.text || '') : String(persistedText || '');
    writeInput(input, text, record ? record.selectionStart : text.length, record ? record.selectionEnd : text.length);
    if (mentions && typeof mentions.importRecords === 'function') mentions.importRecords(record && record.mentions, input);
    return true;
  }

  return { createLiveBinding, rebindLive, captureInput, restoreInput, writeInput };
});
