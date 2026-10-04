/* renderer/chat/renderer-composer-session-state.js - Session-owned composer
 * ownership (UIUX-006): per-session record for the composer text, selection,
 * approved mentions and attachment queue, mirroring the interactiveDraftsBySession lifecycle
 * (Map + touch timestamps + rekey + stale-session GC) and the
 * queuedSendBySession restore mechanics (renderer-send-utils.js). Without
 * this, #chatInput and state.attachments.queued are GLOBAL singletons: a
 * session switch silently discards the outgoing session's typed text and
 * releases its queued attachment assets (openSession's unconditional
 * resetAttachmentQueue()).
 *
 * Exposed as a factory (createComposerSessionState) for the higher-level
 * capture/restore/attachment-token behavior, plus pure Map helpers for rekeying
 * composer session records and merging attachments.
 *
 * Split view W2-2b: the LIVE queue (state.attachments.queued, #attachmentTray)
 * is the session pane 0 shows, getQueueSessionId: currentSessionId with one
 * pane; with two, currentSessionId follows focus. The session-keyed queue
 * helpers alias it for that session and act on the session's record (created on
 * the first write) for any other: pane 1's queue is its session's record.
 * Which session each pane's composer holds: renderer-composer-pane-drafts.js.
 *
 * IME decision (grounded fact: no compositionstart/end listeners exist
 * anywhere in the renderer today): captureActive is invoked from the plain
 * 'input' listener and from session-switch, and simply reads
 * chatInput.value/selectionStart/selectionEnd as-is — a capture mid-IME-
 * composition may snapshot a half-composed candidate string, which is
 * accepted (restoring it verbatim on return is still better than losing the
 * draft outright).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-pane-visibility-utils'), require('./renderer-composer-pane-drafts'));
    return;
  }
  root.rendererComposerSessionState = factory(root.rendererPaneVisibilityUtils, root.rendererComposerPaneDrafts);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (paneVisibilityUtils, paneDrafts) {
  'use strict';

  const ATTACHMENT_CAP = 8;

  function normalizeSessionId(sessionId) {
    return String(sessionId || '').trim();
  }

  function getAttachmentIdentityKey(entry) {
    if (!entry || typeof entry !== 'object') {
      return '';
    }
    return String(entry.path || entry.assetPath || entry.id || '').trim();
  }

  function ensureStore(state) {
    if (!state || typeof state !== 'object') {
      return null;
    }
    if (!(state.composerSessionState instanceof Map)) {
      state.composerSessionState = new Map();
    }
    return state.composerSessionState;
  }

  function emptyRecord(sessionId) {
    return {
      sessionId,
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
      attachments: [],
      generation: 0,
      draftRevision: 0,
      sendReceiptId: '',
      touchedAtMs: 0,
    };
  }

  function getRecord(state, sessionId) {
    const store = ensureStore(state);
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!store || !normalizedSessionId) {
      return null;
    }
    return store.get(normalizedSessionId) || null;
  }

  function ensureRecord(state, sessionId) {
    const store = ensureStore(state);
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!store || !normalizedSessionId) {
      return null;
    }
    let record = store.get(normalizedSessionId);
    if (!record) {
      record = emptyRecord(normalizedSessionId);
      store.set(normalizedSessionId, record);
    }
    return record;
  }

  function resolvePaneSession(state, paneId) {
    const utils = paneVisibilityUtils || globalThis.rendererPaneVisibilityUtils;
    if (utils && typeof utils.resolvePaneSessionId === 'function') return utils.resolvePaneSessionId(state, paneId);
    return paneId === 0 ? normalizeSessionId(state?.currentSessionId) : '';
  }

  function getQueueSessionId(state) { return resolvePaneSession(state, 0); } // W2-2b: pane 0's owns the live queue

  function isLiveQueueSession(state, sessionId) {
    const id = normalizeSessionId(sessionId);
    return !id || id === getQueueSessionId(state);
  }

  // A pane other than pane 0 shows `sessionId` (with its own composer and queue).
  function isInOtherPane(state, sessionId) {
    const id = normalizeSessionId(sessionId);
    const count = Array.isArray(state?.panes?.panes) ? state.panes.panes.length : 1;
    for (let paneId = 1; id && paneId < count; paneId += 1) {
      if (resolvePaneSession(state, paneId) === id) return true;
    }
    return false;
  }

  function persistedDraft(state, sessionId) {
    return String((Array.isArray(state?.sessions) ? state.sessions : []).find((session) => normalizeSessionId(session?.id) === normalizeSessionId(sessionId))?.composer_draft || '');
  }

  // A record created by a queue write keeps the persisted draft restoreForSession would seed.
  function ensureQueueRecord(state, sessionId) {
    const existing = getRecord(state, sessionId);
    if (existing) return existing;
    const record = ensureRecord(state, sessionId);
    const persisted = persistedDraft(state, record?.sessionId);
    if (record && persisted) Object.assign(record, { text: persisted, selectionStart: persisted.length, selectionEnd: persisted.length });
    return record;
  }

  function getQueuedAttachments(state, sessionId) {
    if (isLiveQueueSession(state, sessionId)) {
      return Array.isArray(state?.attachments?.queued) ? state.attachments.queued : [];
    }
    const record = getRecord(state, sessionId);
    return Array.isArray(record?.attachments) ? record.attachments : [];
  }

  function setQueuedAttachments(state, sessionId, list) {
    const next = Array.isArray(list) ? list : [];
    if (!state) return next;
    if (isLiveQueueSession(state, sessionId)) {
      if (!state.attachments || typeof state.attachments !== 'object') state.attachments = {};
      state.attachments.queued = next;
      return next;
    }
    const record = ensureQueueRecord(state, sessionId);
    // A queue write is a draft mutation (captureActive's rule for the live queue).
    if (record) Object.assign(record, { attachments: next, draftRevision: (Number(record.draftRevision) || 0) + 1, sendReceiptId: '', touchedAtMs: Date.now() });
    return next;
  }

  function appendQueuedAttachments(state, sessionId, entries) {
    const merged = mergeAttachmentsInto(getQueuedAttachments(state, sessionId), entries);
    setQueuedAttachments(state, sessionId, merged.next);
    return merged;
  }

  function removeQueuedAttachment(state, sessionId, attachmentId) {
    const targetId = String(attachmentId || '').trim();
    const removed = [];
    const next = getQueuedAttachments(state, sessionId).filter((entry) => {
      const matches = Boolean(targetId) && String(entry?.id || '').trim() === targetId;
      if (matches) removed.push(entry);
      return !matches;
    });
    setQueuedAttachments(state, sessionId, next);
    return removed;
  }

  function clearQueuedAttachments(state, sessionId) {
    const previous = getQueuedAttachments(state, sessionId);
    setQueuedAttachments(state, sessionId, []);
    return previous;
  }

  // Shared cap-8 + identity-dedupe merge core (mirrors
  // renderer-attachment-queue-utils.js's mergePreparedAttachments dedupe
  // rules) parameterized by target list so it can merge into either the live
  // queue or a backgrounded session's record.
  function mergeAttachmentsInto(existingList, accepted, cap = ATTACHMENT_CAP) {
    const baseList = Array.isArray(existingList) ? existingList : [];
    const existingKeys = new Set(baseList.map(getAttachmentIdentityKey).filter(Boolean));
    const next = [...baseList];
    let droppedForCapacity = 0;
    let addedCount = 0;
    const discarded = [];
    for (const entry of Array.isArray(accepted) ? accepted : []) {
      const key = getAttachmentIdentityKey(entry);
      if (key && existingKeys.has(key)) {
        discarded.push(entry);
        continue;
      }
      if (next.length >= cap) {
        droppedForCapacity += 1;
        discarded.push(entry);
        continue;
      }
      if (key) {
        existingKeys.add(key);
      }
      next.push(entry);
      addedCount += 1;
    }
    return { next, droppedForCapacity, addedCount, discarded };
  }

  // Follows rekeySessionState's contract (interactiveDraftsBySession-style):
  // an optimistic local session id migrating to its server-assigned id must
  // carry the composer record forward, or a draft/attachment typed during
  // the optimistic window vanishes the moment the id resolves.
  function rekeyComposerSessionRecord(state, sourceSessionId, targetSessionId) {
    const store = ensureStore(state);
    const normalizedSource = normalizeSessionId(sourceSessionId);
    const normalizedTarget = normalizeSessionId(targetSessionId);
    if (!store || !normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) {
      return false;
    }
    if (!store.has(normalizedSource)) {
      return false;
    }
    const record = store.get(normalizedSource);
    store.delete(normalizedSource);
    if (!store.has(normalizedTarget)) {
      store.set(normalizedTarget, { ...record, sessionId: normalizedTarget });
    }
    return true;
  }

  function createComposerSessionState(deps) {
    const state = deps && deps.state;
    const getChatInput = typeof deps?.getChatInput === 'function' ? deps.getChatInput : () => null;
    const log = typeof deps?.log === 'function' ? deps.log : () => {};
    const releaseAssets = typeof deps?.releaseAssets === 'function' ? deps.releaseAssets : () => {};
    const renderAttachmentTray = typeof deps?.renderAttachmentTray === 'function' ? deps.renderAttachmentTray : () => {};
    const syncComposerVisualState = typeof deps?.syncComposerVisualState === 'function' ? deps.syncComposerVisualState : () => {};
    const getMentionController = deps?.getMentionController || (() => globalThis.rendererIdeMentionAutocomplete);
    const liveBinding = paneDrafts.createLiveBinding(); // the session whose draft #chatInput + the live queue hold

    function releaseDiscardedAssets(discarded, retainedAttachments) {
      const retainedAssetPaths = new Set((Array.isArray(retainedAttachments) ? retainedAttachments : [])
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean));
      const discardedAssetPaths = (Array.isArray(discarded) ? discarded : [])
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter((assetPath) => assetPath && !retainedAssetPaths.has(assetPath));
      const releasableAssetPaths = typeof state?.sendReceiptController?.filterReleasableAssetPaths === 'function'
        ? state.sendReceiptController.filterReleasableAssetPaths(discardedAssetPaths)
        : discardedAssetPaths;
      if (releasableAssetPaths.length) {
        releaseAssets(releasableAssetPaths);
      }
    }

    // captureActive/restoreForSession/beginAttachmentOp all take the target
    // sessionId as an explicit argument rather than reading
    // state.currentSessionId themselves — a capture that re-read the "current"
    // session id after an async gap (or after the caller already flipped it)
    // would silently snapshot the WRONG session, exactly the bug this module
    // exists to fix.
    // options.live (rebindLive): read the live composer although the layout already names another pane-0 session.
    function captureActive(sessionId, reason, options) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId || !state) {
        return null;
      }
      const record = ensureRecord(state, normalizedSessionId);
      if (!record) {
        return null;
      }
      const queueSessionId = getQueueSessionId(state);
      if (options?.live !== true && (queueSessionId !== normalizedSessionId || liveBinding.heldForOther(normalizedSessionId, queueSessionId))) {
        record.touchedAtMs = Date.now();
        log('DEBUG', 'composer.session_capture', {
          sessionId: normalizedSessionId.slice(0, 30),
          reason: String(reason || ''),
          attachmentCount: Array.isArray(record.attachments) ? record.attachments.length : 0,
        });
        return record;
      }
      const previousRevision = Number(record.draftRevision) || 0;
      paneDrafts.captureInput(record, getChatInput(), getMentionController());
      // Attachments move BY REFERENCE out of the global queue into the
      // record: the origin session now owns them, so a later
      // resetAttachmentQueue() (logout, a live send elsewhere) must not
      // release assets this record still references.
      const nextAttachments = Array.isArray(state.attachments?.queued) ? state.attachments.queued : [];
      // captureInput already counts a text change; a queue-only change counts once too.
      if (nextAttachments !== record.attachments && (Number(record.draftRevision) || 0) === previousRevision) {
        record.draftRevision = (Number(record.draftRevision) || 0) + 1;
        // User/composer mutation supersedes an operation-owned clear marker.
        record.sendReceiptId = '';
      }
      record.attachments = nextAttachments;
      record.touchedAtMs = Date.now();
      liveBinding.noteCapture(normalizedSessionId);
      log('DEBUG', 'composer.session_capture', {
        sessionId: normalizedSessionId.slice(0, 30),
        reason: String(reason || ''),
        attachmentCount: record.attachments.length,
      });
      return record;
    }

    function restoreForSession(sessionId) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      const chatInput = getChatInput();
      const persistedText = persistedDraft(state, normalizedSessionId);
      const record = (state && normalizedSessionId ? getRecord(state, normalizedSessionId) : null)
        || { ...emptyRecord(normalizedSessionId), text: persistedText,
          selectionStart: persistedText.length, selectionEnd: persistedText.length };
      record.generation = (Number(record.generation) || 0) + 1;
      if (state && normalizedSessionId) {
        ensureStore(state)?.set(normalizedSessionId, record);
      }
      paneDrafts.restoreInput(chatInput, record, persistedText, getMentionController());
      liveBinding.noteRestore(normalizedSessionId, getQueueSessionId(state));
      if (state) {
        if (!state.attachments || typeof state.attachments !== 'object') {
          state.attachments = {};
        }
        state.attachments.queued = Array.isArray(record.attachments) ? record.attachments : [];
      }
      renderAttachmentTray();
      syncComposerVisualState();
      return { sessionId: normalizedSessionId, generation: record.generation };
    }

    function has(sessionId) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      return Boolean(normalizedSessionId && ensureStore(state)?.has(normalizedSessionId));
    }

    // W2-2b: `sessionId` names a pane's session (pane 1's bindings); the
    // default is the live queue's, pane 0's (currentSessionId with one pane).
    function beginAttachmentOp(sessionId) {
      const targetSessionId = normalizeSessionId(sessionId === undefined ? getQueueSessionId(state) : sessionId);
      const ensure = isLiveQueueSession(state, targetSessionId) ? ensureRecord : ensureQueueRecord;
      const record = state && targetSessionId ? ensure(state, targetSessionId) : null;
      return Object.freeze({ sessionId: targetSessionId, generation: record ? Number(record.generation) || 0 : 0 });
    }

    function beginDraftOp(sessionId) {
      const normalizedSessionId = normalizeSessionId(sessionId || state?.currentSessionId);
      const record = state && normalizedSessionId ? captureActive(normalizedSessionId, 'draft_operation_begin') : null;
      if (!record) {
        return null;
      }
      return Object.freeze({
        sessionId: normalizedSessionId,
        generation: Number(record.generation) || 0,
        draftRevision: Number(record.draftRevision) || 0,
        text: String(record.text || ''),
      });
    }

    function consumeDraftOp(receipt) {
      const sessionId = normalizeSessionId(receipt?.sessionId);
      if (!sessionId || !state) {
        return { consumed: false, live: false };
      }
      if (normalizeSessionId(state.currentSessionId) === sessionId) {
        captureActive(sessionId, 'draft_operation_reconcile');
      }
      const record = getRecord(state, sessionId);
      if (
        !record
        || Number(record.generation) !== Number(receipt.generation)
        || Number(record.draftRevision) !== Number(receipt.draftRevision)
        || String(record.text || '') !== String(receipt.text || '')
      ) {
        return { consumed: false, live: false };
      }
      record.text = '';
      record.selectionStart = 0;
      record.selectionEnd = 0;
      record.draftRevision = (Number(record.draftRevision) || 0) + 1;
      record.sendReceiptId = '';
      record.touchedAtMs = Date.now();
      const live = normalizeSessionId(state.currentSessionId) === sessionId;
      if (live) {
        const chatInput = getChatInput();
        if (chatInput) {
          chatInput.value = '';
          if (typeof chatInput.setSelectionRange === 'function') {
            try { chatInput.setSelectionRange(0, 0); } catch (_error) { /* unsupported input */ }
          }
        }
      }
      return { consumed: true, live };
    }

    // Active = the token's session still shows in a pane (pane 0's live queue,
    // or another pane's own queue) at the generation the op began in.
    function isTokenActive(token) {
      if (!token || !state) {
        return false;
      }
      const record = getRecord(state, token.sessionId);
      const currentGeneration = record ? Number(record.generation) || 0 : 0;
      return (holdsLiveQueue(token.sessionId) || isInOtherPane(state, token.sessionId))
        && Number(token.generation) === currentGeneration;
    }

    // Pane 0's live queue is `sessionId`'s: the layout names it AND the live composer holds it (no restore ran ahead).
    function holdsLiveQueue(sessionId) {
      const queueSessionId = getQueueSessionId(state);
      return sessionId === queueSessionId && !liveBinding.heldForOther(sessionId, queueSessionId);
    }

    // options.mergeActive: called (with the raw payload and the token's session)
    // when the token still targets a session on screen — the caller's own merge/toast/render path
    // (e.g. renderer-attachment-queue-utils.js's mergePreparedAttachments)
    // runs unchanged. Any other outcome (a background session's record, or no
    // record at all) is handled entirely here.
    function commitAttachmentResult(token, payload, options = {}) {
      const normalizedToken = token && typeof token === 'object'
        ? token
        : { sessionId: '', generation: -1 };
      const accepted = Array.isArray(payload?.accepted) ? payload.accepted : [];
      if (isTokenActive(normalizedToken)) {
        if (typeof options.mergeActive === 'function') {
          options.mergeActive(payload, normalizedToken.sessionId);
        }
        return { target: 'active' };
      }
      const originRecord = state ? getRecord(state, normalizedToken.sessionId) : null;
      if (originRecord) {
        // The base is the session's CURRENT queue: the live array while pane 0
        // holds it (its record may still point at an older one), else the record.
        const live = holdsLiveQueue(normalizedToken.sessionId);
        const merged = mergeAttachmentsInto(live ? state.attachments?.queued : originRecord.attachments, accepted);
        originRecord.attachments = merged.next;
        releaseDiscardedAssets(merged.discarded, merged.next);
        if (merged.addedCount > 0) {
          originRecord.draftRevision = (Number(originRecord.draftRevision) || 0) + 1;
          originRecord.sendReceiptId = '';
        }
        originRecord.touchedAtMs = Date.now();
        // A generation-stale token (A -> B -> A while it was in flight) whose
        // session holds the live queue again shows now, in step with the record.
        if (live) {
          if (!state.attachments || typeof state.attachments !== 'object') state.attachments = {};
          state.attachments.queued = merged.next;
          renderAttachmentTray();
        }
        log('INFO', 'composer.attachment_result_deferred', {
          sessionId: normalizedToken.sessionId.slice(0, 30),
          addedCount: merged.addedCount,
          droppedForCapacity: merged.droppedForCapacity,
        });
        return { target: 'origin', addedCount: merged.addedCount, droppedForCapacity: merged.droppedForCapacity };
      }
      const assetPaths = accepted.map((entry) => String(entry?.assetPath || '').trim()).filter(Boolean);
      const releasableAssetPaths = typeof state.sendReceiptController?.filterReleasableAssetPaths === 'function'
        ? state.sendReceiptController.filterReleasableAssetPaths(assetPaths)
        : assetPaths;
      if (releasableAssetPaths.length) {
        releaseAssets(releasableAssetPaths);
      }
      log('INFO', 'composer.attachment_result_discarded', {
        sessionId: normalizedToken.sessionId.slice(0, 30),
        discardedCount: accepted.length,
      });
      return { target: 'discarded' };
    }

    function dropSession(sessionId) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!state || !normalizedSessionId) return false;
      const store = ensureStore(state);
      const record = store?.get(normalizedSessionId) || null;
      const isCurrent = getQueueSessionId(state) === normalizedSessionId;
      const attachments = [
        ...(Array.isArray(record?.attachments) ? record.attachments : []),
        ...(isCurrent && Array.isArray(state.attachments?.queued) ? state.attachments.queued : []),
      ];
      if (record) store.delete(normalizedSessionId);
      liveBinding.forget(normalizedSessionId);
      if (isCurrent) {
        if (!state.attachments || typeof state.attachments !== 'object') state.attachments = {};
        state.attachments.queued = [];
      }
      const assetPaths = [...new Set(attachments
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean))];
      const releasableAssetPaths = typeof state.sendReceiptController?.filterReleasableAssetPaths === 'function'
        ? state.sendReceiptController.filterReleasableAssetPaths(assetPaths)
        : assetPaths;
      if (releasableAssetPaths.length) releaseAssets(releasableAssetPaths);
      if (isCurrent) {
        renderAttachmentTray();
        syncComposerVisualState();
      }
      return Boolean(record || isCurrent);
    }

    function clearAll() {
      if (!state) return 0;
      const store = ensureStore(state);
      const paths = new Set((Array.isArray(state.attachments?.queued) ? state.attachments.queued : [])
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean));
      for (const record of store?.values?.() || []) {
        for (const entry of Array.isArray(record?.attachments) ? record.attachments : []) {
          const assetPath = String(entry?.assetPath || '').trim();
          if (assetPath) paths.add(assetPath);
        }
      }
      const recordCount = store?.size || 0;
      store?.clear?.();
      liveBinding.clear();
      if (!state.attachments || typeof state.attachments !== 'object') state.attachments = {};
      state.attachments.queued = [];
      const releasableAssetPaths = typeof state.sendReceiptController?.filterReleasableAssetPaths === 'function'
        ? state.sendReceiptController.filterReleasableAssetPaths([...paths])
        : [...paths];
      if (releasableAssetPaths.length) releaseAssets(releasableAssetPaths);
      renderAttachmentTray();
      syncComposerVisualState();
      return recordCount;
    }

    function rekeySession(sourceSessionId, targetSessionId) {
      const store = ensureStore(state);
      const sourceId = normalizeSessionId(sourceSessionId);
      const targetId = normalizeSessionId(targetSessionId);
      liveBinding.rekey(sourceId, targetId); // the same chat: the live composer keeps holding it
      if (!store || !sourceId || !targetId || sourceId === targetId || !store.has(sourceId)) {
        return false;
      }
      const targetRecord = store.get(targetId);
      if (!targetRecord) {
        return rekeyComposerSessionRecord(state, sourceId, targetId);
      }
      const sourceRecord = store.get(sourceId);
      const merged = mergeAttachmentsInto(targetRecord.attachments, sourceRecord?.attachments);
      targetRecord.attachments = merged.next;
      if (merged.addedCount > 0) {
        targetRecord.draftRevision = (Number(targetRecord.draftRevision) || 0) + 1;
        targetRecord.sendReceiptId = '';
      }
      targetRecord.touchedAtMs = Date.now();
      store.delete(sourceId);
      releaseDiscardedAssets(merged.discarded, merged.next);
      return true;
    }

    return {
      captureActive,
      getQueueSessionId: () => getQueueSessionId(state),
      getQueuedAttachments: (sessionId) => getQueuedAttachments(state, sessionId),
      setQueuedAttachments: (sessionId, list) => setQueuedAttachments(state, sessionId, list),
      appendQueuedAttachments: (sessionId, entries) => appendQueuedAttachments(state, sessionId, entries),
      removeQueuedAttachment: (sessionId, attachmentId) => removeQueuedAttachment(state, sessionId, attachmentId),
      clearQueuedAttachments: (sessionId) => clearQueuedAttachments(state, sessionId),
      has,
      restoreForSession,
      liveBinding, // renderer-composer-pane-drafts.js rebindLive
      capturePaneDraft: (sessionId, input) => paneDrafts.captureInput(input && normalizeSessionId(sessionId) ? ensureQueueRecord(state, sessionId) : null, input, getMentionController()),
      restorePaneDraft: (sessionId, input) => paneDrafts.restoreInput(input, getRecord(state, sessionId), persistedDraft(state, sessionId), getMentionController()),
      beginAttachmentOp,
      beginDraftOp,
      clearAll,
      consumeDraftOp,
      commitAttachmentResult,
      dropSession,
      rekeySession,
    };
  }

  return {
    createComposerSessionState,
    getQueueSessionId,
    isLiveQueueSession,
    getQueuedAttachments,
    setQueuedAttachments,
    appendQueuedAttachments,
    removeQueuedAttachment,
    clearQueuedAttachments,
    rekeyComposerSessionRecord,
    mergeAttachmentsInto,
    getAttachmentIdentityKey,
    ATTACHMENT_CAP,
  };
});
