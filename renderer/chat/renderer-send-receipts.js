/* renderer/chat/renderer-send-receipts.js -- immutable send-operation receipts (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendReceipts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_FAILED_PAYLOADS = 64;
  const MAX_RELEASED_ASSET_PATHS = 2048;
  let nextReceiptSequence = 0;

  function clone(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return null;
    seen.add(value);
    const result = Array.isArray(value) ? [] : {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
      result[key] = clone(entry, seen);
    }
    seen.delete(value);
    return result;
  }

  function deepFreeze(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
  }

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function assetPaths(attachments) {
    return [...new Set((Array.isArray(attachments) ? attachments : [])
      .map((entry) => String(entry?.assetPath || '').trim())
      .filter(Boolean))];
  }

  function createSendReceiptStore(deps) {
    const state = deps?.state || {};
    const chatInput = deps?.chatInput || null;
    const getComposerController = typeof deps?.getComposerController === 'function'
      ? deps.getComposerController
      : () => null;
    const releaseAssets = typeof deps?.releaseAssets === 'function' ? deps.releaseAssets : () => {};
    const log = typeof deps?.log === 'function' ? deps.log : () => {};
    if (!(state.failedSendPayloadsById instanceof Map)) state.failedSendPayloadsById = new Map();
    const activeReceipts = new Map();
    const releasedAssetPaths = new Set();
    let disposed = false;

    function retainedAssetPaths(options = {}) {
      const retained = new Set();
      const currentSessionId = normalizeId(state.currentSessionId);
      const addAttachments = (attachments) => {
        for (const path of assetPaths(attachments)) retained.add(path);
      };
      addAttachments(state.attachments?.queued);
      if (state.composerSessionState instanceof Map) {
        for (const [sessionId, record] of state.composerSessionState.entries()) {
          // The live queue is authoritative for the current session. Its
          // record can still point at the array that preceded a remove/clear.
          if (normalizeId(sessionId) !== currentSessionId) addAttachments(record?.attachments);
        }
      }
      for (const payload of state.failedSendPayloadsById.values()) addAttachments(payload?.attachments);
      if (state.sendOutboxBySession instanceof Map) {
        for (const queue of state.sendOutboxBySession.values()) {
          for (const entry of Array.isArray(queue) ? queue : []) {
            if (entry?.attachmentOwner === 'outbox'
              || (options.retainSendReceiptOutbox !== false && entry?.attachmentOwner === 'send_receipt')) {
              addAttachments(entry.attachments);
            }
          }
        }
      }
      return retained;
    }

    function filterReleasableAssetPaths(paths, options = {}) {
      const retained = retainedAssetPaths(options);
      return [...new Set((Array.isArray(paths) ? paths : [])
        .map((path) => String(path || '').trim())
        .filter((path) => path && !retained.has(path) && !releasedAssetPaths.has(path)))];
    }

    function getRecord(sessionId) {
      return state.composerSessionState instanceof Map
        ? state.composerSessionState.get(normalizeId(sessionId)) || null
        : null;
    }

    function ensureFallbackRecord(sessionId) {
      if (!(state.composerSessionState instanceof Map)) state.composerSessionState = new Map();
      const id = normalizeId(sessionId);
      let record = state.composerSessionState.get(id) || null;
      if (!record) {
        record = {
          sessionId: id,
          text: '',
          selectionStart: 0,
          selectionEnd: 0,
          attachments: [],
          generation: 0,
          draftRevision: 0,
          sendReceiptId: '',
          touchedAtMs: 0,
        };
        state.composerSessionState.set(id, record);
      }
      return record;
    }

    function releaseOwnedAttachments(attachments, options = {}) {
      const pending = filterReleasableAssetPaths(assetPaths(attachments), options);
      if (!pending.length) return false;
      for (const path of pending) {
        releasedAssetPaths.add(path);
        if (releasedAssetPaths.size > MAX_RELEASED_ASSET_PATHS) {
          releasedAssetPaths.delete(releasedAssetPaths.values().next().value);
        }
      }
      try {
        const result = releaseAssets(pending);
        result?.catch?.(() => {});
      } catch (_error) {
        // Asset release is best-effort at this renderer edge. Electron retains
        // canonical managed-asset safety and later cleanup remains available.
      }
      return true;
    }

    function captureOrigin(sessionId, reason) {
      const controller = getComposerController();
      if (controller?.captureActive) return controller.captureActive(sessionId, reason);
      const record = ensureFallbackRecord(sessionId);
      const liveSessionId = normalizeId(state.currentSessionId);
      if (!liveSessionId || liveSessionId === normalizeId(sessionId)) {
        const text = String(chatInput?.value || '');
        const attachments = Array.isArray(state.attachments?.queued) ? state.attachments.queued : [];
        if (text !== String(record.text || '') || attachments !== record.attachments) {
          record.draftRevision = (Number(record.draftRevision) || 0) + 1;
          record.sendReceiptId = '';
        }
        record.text = text;
        record.selectionStart = Number.isFinite(chatInput?.selectionStart) ? chatInput.selectionStart : text.length;
        record.selectionEnd = Number.isFinite(chatInput?.selectionEnd) ? chatInput.selectionEnd : text.length;
        record.attachments = attachments;
        record.touchedAtMs = Date.now();
      }
      return record;
    }

    function begin(payload, options = {}) {
      if (disposed) return null;
      const sessionId = normalizeId(payload?.sessionId);
      if (!sessionId) return null;
      const record = captureOrigin(sessionId, 'send_receipt_begin');
      const id = `send_receipt_${Date.now().toString(36)}_${(++nextReceiptSequence).toString(36)}`;
      const immutablePayload = deepFreeze(clone({
        ...payload,
        sessionId,
        attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
      }));
      const receipt = Object.freeze({
        id,
        originSessionId: sessionId,
        rendererGeneration: Number(record?.generation) || 0,
        draftRevision: Number(record?.draftRevision) || 0,
        consumeDraft: options.consumeDraft === true,
        restoreOnFailure: options.restoreOnFailure !== false,
        recordFailedPayload: options.recordFailedPayload !== false,
        failedPayloadId: normalizeId(options.failedPayloadId),
        payload: immutablePayload,
      });
      activeReceipts.set(id, { receipt, settled: false });

      if (record && receipt.consumeDraft) {
        record.sendReceiptId = id;
        record.text = '';
        record.selectionStart = 0;
        record.selectionEnd = 0;
        record.attachments = [];
        record.touchedAtMs = Date.now();
      }
      const liveSessionId = normalizeId(state.currentSessionId);
      if (receipt.consumeDraft
        && (!liveSessionId || liveSessionId === sessionId)
        && Number(record?.generation || 0) === receipt.rendererGeneration) {
        if (chatInput) chatInput.value = '';
        if (!state.attachments || typeof state.attachments !== 'object') state.attachments = {};
        state.attachments.queued = record?.attachments || [];
      }
      log('DEBUG', 'chat.send_receipt_created', {
        sessionId: sessionId.slice(0, 30),
        receiptId: id,
        rendererGeneration: receipt.rendererGeneration,
        draftRevision: receipt.draftRevision,
        attachmentCount: immutablePayload.attachments.length,
      });
      return receipt;
    }

    function seal(receipt, patch) {
      const active = receipt ? activeReceipts.get(receipt.id) : null;
      if (!active || active.settled || disposed) return null;
      const sealedReceipt = Object.freeze({
        ...receipt,
        payload: deepFreeze(clone({ ...receipt.payload, ...(patch || {}) })),
      });
      activeReceipts.set(receipt.id, { ...active, receipt: sealedReceipt, settled: false });
      return sealedReceipt;
    }

    function transferAttachmentsToCanonicalHistory(receipt) {
      const active = receipt ? activeReceipts.get(receipt.id) : null;
      if (!active || active.settled || disposed) return false;
      active.canonicalAttachmentOwner = true;
      return true;
    }

    function resolveRecord(receipt, sessionIdOverride) {
      return getRecord(normalizeId(sessionIdOverride) || receipt.originSessionId);
    }

    function syncLiveRevision(receipt, sessionIdOverride) {
      const sessionId = normalizeId(sessionIdOverride) || receipt.originSessionId;
      const record = resolveRecord(receipt, sessionId);
      const liveSessionId = normalizeId(state.currentSessionId);
      if ((!liveSessionId || liveSessionId === sessionId)
        && Number(record?.generation || 0) === receipt.rendererGeneration) {
        captureOrigin(sessionId, 'send_receipt_settle');
      }
      return resolveRecord(receipt, sessionId);
    }

    function isReceiptCurrent(receipt, record) {
      return Boolean(record
        && record.sendReceiptId === receipt.id
        && Number(record.generation || 0) === receipt.rendererGeneration
        && Number(record.draftRevision || 0) === receipt.draftRevision);
    }

    function restoreDraft(receipt, sessionIdOverride) {
      if (!receipt || disposed || !activeReceipts.has(receipt.id)) return false;
      const sessionId = normalizeId(sessionIdOverride) || receipt.originSessionId;
      const record = syncLiveRevision(receipt, sessionId);
      if (!receipt.consumeDraft || receipt.restoreOnFailure === false || !isReceiptCurrent(receipt, record)) return false;
      record.text = String(receipt.payload.visiblePrompt ?? receipt.payload.prompt ?? '');
      record.selectionStart = record.text.length;
      record.selectionEnd = record.text.length;
      record.attachments = clone(receipt.payload.attachments) || [];
      record.sendReceiptId = '';
      record.touchedAtMs = Date.now();
      const liveSessionId = normalizeId(state.currentSessionId);
      if (!liveSessionId || liveSessionId === sessionId) {
        if (chatInput) chatInput.value = record.text;
        if (!state.attachments || typeof state.attachments !== 'object') state.attachments = {};
        state.attachments.queued = record.attachments;
      }
      return true;
    }

    function buildFailedPayload(receipt, retryable, sessionIdOverride) {
      const existing = receipt.failedPayloadId
        ? state.failedSendPayloadsById.get(receipt.failedPayloadId) || null
        : null;
      const id = receipt.failedPayloadId
        || `failed_payload_${Date.now().toString(36)}_${(++nextReceiptSequence).toString(36)}`;
      const payload = deepFreeze(clone({
        ...(existing || receipt.payload),
        id,
        sessionId: normalizeId(sessionIdOverride) || receipt.originSessionId,
        retryable: retryable !== false,
        // The failed-payload receipt retains managed assets even when the
        // composer also displays borrowed references. This keeps exact Retry
        // valid after the user edits, clears, or sends the restored draft.
        attachmentOwner: 'failed_payload',
        failedAt: new Date().toISOString(),
      }));
      state.failedSendPayloadsById.delete(id);
      state.failedSendPayloadsById.set(id, payload);
      while (state.failedSendPayloadsById.size > MAX_FAILED_PAYLOADS) {
        const oldest = state.failedSendPayloadsById.entries().next().value;
        if (!oldest) break;
        const [oldestId, oldestPayload] = oldest;
        state.failedSendPayloadsById.delete(oldestId);
        if (oldestPayload?.attachmentOwner === 'failed_payload') {
          releaseOwnedAttachments(oldestPayload.attachments);
        }
        log('WARN', 'chat.failed_payload_evicted', {
          failedPayloadId: String(oldestId).slice(0, 50),
          retainedCount: state.failedSendPayloadsById.size,
        });
      }
      return payload;
    }

    function settleFailed(receipt, options = {}) {
      const active = receipt ? activeReceipts.get(receipt.id) : null;
      if (!active || disposed) {
        return { ignored: true, restoredToComposer: false, failedPayload: null };
      }
      if (active.canonicalAttachmentOwner) {
        const record = resolveRecord(receipt, options.sessionId);
        if (record?.sendReceiptId === receipt.id) record.sendReceiptId = '';
        activeReceipts.delete(receipt.id);
        if (receipt.failedPayloadId) state.failedSendPayloadsById.delete(receipt.failedPayloadId);
        log('WARN', 'chat.send_receipt_failed_after_accept', {
          sessionId: normalizeId(options.sessionId || receipt.originSessionId).slice(0, 30),
          receiptId: receipt.id,
          attachmentCount: receipt.payload.attachments.length,
        });
        return {
          ignored: false,
          restoredToComposer: false,
          failedPayload: null,
          canonicalAccepted: true,
        };
      }
      const restoredToComposer = restoreDraft(receipt, options.sessionId);
      const record = resolveRecord(receipt, options.sessionId);
      if (record?.sendReceiptId === receipt.id) record.sendReceiptId = '';
      activeReceipts.delete(receipt.id);
      const failedPayload = receipt.recordFailedPayload
        ? buildFailedPayload(receipt, options.retryable !== false, options.sessionId)
        : null;
      if (!failedPayload) releaseOwnedAttachments(receipt.payload.attachments);
      log('INFO', 'chat.send_receipt_failed', {
        sessionId: receipt.originSessionId.slice(0, 30),
        receiptId: receipt.id,
        failedPayloadId: failedPayload?.id || '',
        restoredToComposer,
        attachmentCount: receipt.payload.attachments.length,
      });
      return { ignored: false, restoredToComposer, failedPayload };
    }

    function settleAccepted(receipt, options = {}) {
      if (!receipt || disposed || !activeReceipts.has(receipt.id)) return { ignored: true };
      const record = resolveRecord(receipt, options.sessionId);
      if (record?.sendReceiptId === receipt.id) record.sendReceiptId = '';
      activeReceipts.delete(receipt.id);
      if (receipt.failedPayloadId) state.failedSendPayloadsById.delete(receipt.failedPayloadId);
      log('DEBUG', 'chat.send_receipt_accepted', {
        sessionId: normalizeId(options.sessionId || receipt.originSessionId).slice(0, 30),
        receiptId: receipt.id,
        attachmentCount: receipt.payload.attachments.length,
      });
      return { ignored: false };
    }

    function getFailedPayload(payloadId) {
      return state.failedSendPayloadsById.get(normalizeId(payloadId)) || null;
    }

    function getRetryAvailability(payloadId) {
      if (disposed) return { available: false, reason: 'Retry is unavailable because the chat controller was closed.' };
      const payload = getFailedPayload(payloadId);
      if (!payload) return { available: false, reason: 'The original failed payload is no longer available.' };
      if (payload.retryable === false) return { available: false, reason: 'This failure is not retryable.' };
      return { available: true, reason: '' };
    }

    function dismissFailedPayload(payloadId) {
      const payload = getFailedPayload(payloadId);
      if (!payload) return false;
      state.failedSendPayloadsById.delete(payload.id);
      if (payload.attachmentOwner === 'failed_payload') releaseOwnedAttachments(payload.attachments);
      return true;
    }

    function clearFailedPayloads(sessionId = '') {
      const normalizedSessionId = normalizeId(sessionId);
      const removed = [];
      for (const [payloadId, payload] of state.failedSendPayloadsById.entries()) {
        if (normalizedSessionId && normalizeId(payload?.sessionId) !== normalizedSessionId) continue;
        state.failedSendPayloadsById.delete(payloadId);
        removed.push(payload);
      }
      for (const payload of removed) {
        if (payload?.attachmentOwner === 'failed_payload') releaseOwnedAttachments(payload.attachments);
      }
      return removed.length;
    }

    function isDisposed() {
      return disposed;
    }

    function isPending(receipt) {
      return Boolean(receipt && !disposed && activeReceipts.has(receipt.id));
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const { receipt, canonicalAttachmentOwner } of activeReceipts.values()) {
        if (receipt.consumeDraft && !canonicalAttachmentOwner) {
          releaseOwnedAttachments(receipt.payload.attachments, { retainSendReceiptOutbox: false });
        }
      }
      activeReceipts.clear();
      clearFailedPayloads();
      if (state.sendReceiptController === api) state.sendReceiptController = null;
    }

    const api = {
      begin,
      clearFailedPayloads,
      dismissFailedPayload,
      dispose,
      filterReleasableAssetPaths,
      getFailedPayload,
      getRetryAvailability,
      isDisposed,
      isPending,
      restoreDraft,
      seal,
      settleAccepted,
      settleFailed,
      transferAttachmentsToCanonicalHistory,
    };
    state.sendReceiptController = api;
    return api;
  }

  return { createSendReceiptStore };
});
