/* renderer/chat/renderer-composer-session-state.js - Session-owned composer
 * ownership (UIUX-006): per-session record for the composer text, selection,
 * and attachment queue, mirroring the interactiveDraftsBySession lifecycle
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
    module.exports = factory();
    return;
  }
  root.rendererComposerSessionState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
    function captureActive(sessionId, reason) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId || !state) {
        return null;
      }
      const record = ensureRecord(state, normalizedSessionId);
      if (!record) {
        return null;
      }
      if (normalizeSessionId(state.currentSessionId) !== normalizedSessionId) {
        record.touchedAtMs = Date.now();
        log('DEBUG', 'composer.session_capture', {
          sessionId: normalizedSessionId.slice(0, 30),
          reason: String(reason || ''),
          attachmentCount: Array.isArray(record.attachments) ? record.attachments.length : 0,
        });
        return record;
      }
      const chatInput = getChatInput();
      const nextText = chatInput ? String(chatInput.value || '') : String(record.text || '');
      const nextSelectionStart = chatInput && Number.isFinite(chatInput.selectionStart)
        ? chatInput.selectionStart
        : nextText.length;
      const nextSelectionEnd = chatInput && Number.isFinite(chatInput.selectionEnd)
        ? chatInput.selectionEnd
        : nextText.length;
      // Attachments move BY REFERENCE out of the global queue into the
      // record: the origin session now owns them, so a later
      // resetAttachmentQueue() (logout, a live send elsewhere) must not
      // release assets this record still references.
      const nextAttachments = Array.isArray(state.attachments?.queued) ? state.attachments.queued : [];
      const draftChanged = nextText !== String(record.text || '')
        || nextAttachments !== record.attachments;
      record.text = nextText;
      record.selectionStart = nextSelectionStart;
      record.selectionEnd = nextSelectionEnd;
      record.attachments = nextAttachments;
      if (draftChanged) {
        record.draftRevision = (Number(record.draftRevision) || 0) + 1;
        // User/composer mutation supersedes an operation-owned clear marker.
        record.sendReceiptId = '';
      }
      record.touchedAtMs = Date.now();
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
      const persistedText = String((Array.isArray(state?.sessions)
        ? state.sessions.find((session) => normalizeSessionId(session?.id) === normalizedSessionId)?.composer_draft
        : '') || '');
      const record = (state && normalizedSessionId ? getRecord(state, normalizedSessionId) : null)
        || { ...emptyRecord(normalizedSessionId), text: persistedText,
          selectionStart: persistedText.length, selectionEnd: persistedText.length };
      record.generation = (Number(record.generation) || 0) + 1;
      if (state && normalizedSessionId) {
        ensureStore(state)?.set(normalizedSessionId, record);
      }
      if (chatInput) {
        chatInput.value = String(record.text || '');
        if (typeof chatInput.setSelectionRange === 'function') {
          try {
            const len = chatInput.value.length;
            const start = Math.min(Math.max(Number(record.selectionStart) || 0, 0), len);
            const end = Math.min(Math.max(Number(record.selectionEnd) || 0, 0), len);
            chatInput.setSelectionRange(start, end);
          } catch (_error) {
            // Not every input-like element supports selection ranges.
          }
        }
      }
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

    function beginAttachmentOp() {
      const sessionId = normalizeSessionId(state?.currentSessionId);
      const record = state && sessionId ? ensureRecord(state, sessionId) : null;
      return Object.freeze({ sessionId, generation: record ? Number(record.generation) || 0 : 0 });
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

    function isTokenActive(token) {
      if (!token || !state) {
        return false;
      }
      const currentSessionId = normalizeSessionId(state.currentSessionId);
      const record = getRecord(state, token.sessionId);
      const currentGeneration = record ? Number(record.generation) || 0 : 0;
      return token.sessionId === currentSessionId && Number(token.generation) === currentGeneration;
    }

    // options.mergeActive: called (with the raw payload) when the token still
    // targets the live session — the caller's own merge/toast/render path
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
          options.mergeActive(payload);
        }
        return { target: 'active' };
      }
      const originRecord = state ? getRecord(state, normalizedToken.sessionId) : null;
      if (originRecord) {
        const merged = mergeAttachmentsInto(originRecord.attachments, accepted);
        originRecord.attachments = merged.next;
        releaseDiscardedAssets(merged.discarded, merged.next);
        if (merged.addedCount > 0) {
          originRecord.draftRevision = (Number(originRecord.draftRevision) || 0) + 1;
          originRecord.sendReceiptId = '';
        }
        originRecord.touchedAtMs = Date.now();
        // The token is generation-stale (a background op resolved after this
        // session's record was rebuilt by restoreForSession), but the user
        // may have gone A -> B -> A while it was in flight, landing back on
        // THIS session before it resolved. isTokenActive() above already
        // said no (wrong generation), so without this the merged result sits
        // invisible in originRecord until the NEXT switch away and back. If
        // the origin session is the one currently on screen, re-point the
        // live queue to the merged array (mirrors what restoreForSession
        // does on a real switch) and render so it shows up now.
        if (state && normalizeSessionId(state.currentSessionId) === normalizedToken.sessionId) {
          if (!state.attachments || typeof state.attachments !== 'object') {
            state.attachments = {};
          }
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
      const isCurrent = normalizeSessionId(state.currentSessionId) === normalizedSessionId;
      const attachments = [
        ...(Array.isArray(record?.attachments) ? record.attachments : []),
        ...(isCurrent && Array.isArray(state.attachments?.queued) ? state.attachments.queued : []),
      ];
      if (record) store.delete(normalizedSessionId);
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
      has,
      restoreForSession,
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
    rekeyComposerSessionRecord,
    mergeAttachmentsInto,
    getAttachmentIdentityKey,
    ATTACHMENT_CAP,
  };
});
