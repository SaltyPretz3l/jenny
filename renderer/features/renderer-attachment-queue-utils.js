/* renderer/features/renderer-attachment-queue-utils.js - the attachment queue controller (UMD).
 * Split view W2-2b: the optional trailing `sessionId` argument (resetAttachmentQueue,
 * removeQueuedAttachment, beginAttachmentToken, mergePreparedAttachments) names a pane's session and
 * routes the queue read/write through the session-keyed helpers of renderer-composer-session-state.js;
 * omitted, it is the live queue (pane 0's) through today's direct path. A session other
 * than the live queue's re-renders through its pane (renderSessionAttachments) instead of pane 0's
 * tray, notice and composer.
 * Row 153: an op that has the names of what it is preparing (a drop, a paste, a screen capture)
 * lists them in `state.attachmentPending` ({ operationId, sessionId, kind, name }) until it settles,
 * so the tray can hold a placeholder for each; the picker's single IPC call has no names to show. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAttachmentQueueUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createAttachmentQueueController(deps) {
    const state = deps?.state || {};
    const windowRef = deps?.windowRef || window;
    const TOAST_SOURCE = deps?.constants?.TOAST_SOURCE || {};
    const callbacks = deps?.callbacks || {};
    const clearAttachmentNotice = callbacks.clearAttachmentNotice || (() => {});
    const buildAttachmentToastMessage = callbacks.buildAttachmentToastMessage || (() => '');
    const showToastMessage = callbacks.showToastMessage || (() => {});
    const renderAttachmentTray = callbacks.renderAttachmentTray || (() => {});
    const renderComposerState = callbacks.renderComposerState || (() => {});
    const closeComposerPopover = callbacks.closeComposerPopover || (() => {});
    const appendClientLog = callbacks.appendClientLog || (() => {});
    const renderSessionAttachments = callbacks.renderSessionAttachments
      || ((sessionId) => windowRef.rendererAppPaneComposition?.getPaneComposition?.()?.renderSessionPane?.(sessionId, 'composer'));
    let disposed = false;
    let nextOperationId = 0;
    const activeTokens = new Map();
    const paneTokens = new WeakSet(); // W2-2b: ops begun by another pane's bindings

    function pendingList() {
      return Array.isArray(state.attachmentPending) ? state.attachmentPending : [];
    }

    // Repaints the tray an op's placeholders show in: its pane's for another pane's op, else the live one.
    function renderTokenSurface(token) {
      const sessionId = paneTokens.has(token) ? String(token?.sessionId || '').trim() : undefined;
      if (!isLiveQueue(sessionId)) { renderSessionAttachments(sessionId); return; }
      renderAttachmentTray();
    }

    // Placeholders for an op's items; `items` are { kind: 'image' | 'file', name }.
    function markAttachmentPending(token, items) {
      const operationId = String(token?.operationId || '').trim();
      const sessionId = String(token?.sessionId || '').trim();
      const list = (Array.isArray(items) ? items : []).filter((item) => item && String(item.name || '').trim());
      if (disposed || !operationId || !sessionId || !activeTokens.has(operationId) || !list.length) return;
      state.attachmentPending = pendingList().concat(list.map((item) => ({
        operationId, sessionId, kind: item.kind === 'image' ? 'image' : 'file', name: String(item.name).trim(),
      })));
      renderTokenSurface(token);
    }

    // Drops an op's placeholders; true when there were any (the caller re-renders).
    function clearAttachmentPending(token) {
      const operationId = String(token?.operationId || '').trim();
      const before = pendingList();
      if (!operationId || !before.some((entry) => entry.operationId === operationId)) return false;
      state.attachmentPending = before.filter((entry) => entry.operationId !== operationId);
      return true;
    }

    function settlePending(token) {
      if (clearAttachmentPending(token) && !disposed) renderTokenSurface(token);
    }

    function pendingItemsFor(dropped) {
      return dropped.map((entry) => {
        const name = typeof entry === 'string' ? entry.trim().split(/[\\/]/).pop() : String(entry?.name || '').trim();
        const type = typeof entry === 'string' ? '' : String(entry?.type || '');
        return { kind: type.startsWith('image/') || IMAGE_NAME.test(name) ? 'image' : 'file', name };
      });
    }

    function filterReleasableAssetPaths(paths) {
      const controller = state.sendReceiptController;
      return typeof controller?.filterReleasableAssetPaths === 'function'
        ? controller.filterReleasableAssetPaths(paths)
        : paths;
    }

    function releaseAssetEntries(entries) {
      const assetPaths = filterReleasableAssetPaths([...new Set((Array.isArray(entries) ? entries : [])
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean))]);
      if (assetPaths.length && windowRef.jennyShell?.attachments?.releaseAssets) {
        windowRef.jennyShell.attachments.releaseAssets(assetPaths).catch(() => {});
      }
    }

    function getAttachmentIdentityKey(entry) {
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      return String(entry.path || entry.assetPath || entry.id || '').trim();
    }

    function queueHelpers() {
      return windowRef.rendererComposerSessionState || globalThis.rendererComposerSessionState
        || (typeof require === 'function' ? require('../chat/renderer-composer-session-state') : null);
    }

    function isLiveQueue(sessionId) {
      const helpers = queueHelpers();
      return sessionId === undefined || !helpers || helpers.isLiveQueueSession(state, sessionId);
    }

    function readQueue(sessionId) {
      if (sessionId !== undefined && queueHelpers()) return queueHelpers().getQueuedAttachments(state, sessionId);
      return Array.isArray(state.attachments?.queued) ? state.attachments.queued : [];
    }

    function writeQueue(sessionId, list) {
      if (sessionId !== undefined && queueHelpers()) {
        queueHelpers().setQueuedAttachments(state, sessionId, list);
        return;
      }
      state.attachments.queued = list;
    }

    function renderAttachmentSurfaces(sessionId) {
      if (!isLiveQueue(sessionId)) {
        renderSessionAttachments(String(sessionId || '').trim());
        return;
      }
      renderAttachmentTray();
      try {
        renderComposerState();
      } catch (error) {
        appendClientLog('WARN', 'composer.attachment.render_failed', { message: String(error?.message || error) });
      }
    }

    function resetAttachmentQueue(sessionId) {
      const queuedAttachments = readQueue(sessionId);
      writeQueue(sessionId, []);
      const releasableAssetPaths = filterReleasableAssetPaths(queuedAttachments
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean));
      if (releasableAssetPaths.length && windowRef.jennyShell?.attachments?.releaseAssets) {
        windowRef.jennyShell.attachments.releaseAssets(releasableAssetPaths).catch(() => {});
      }
      if (isLiveQueue(sessionId)) clearAttachmentNotice();
      renderAttachmentSurfaces(sessionId);
    }

    function removeQueuedAttachment(attachmentId, sessionId) {
      const targetId = String(attachmentId || '').trim();
      if (!targetId) {
        return;
      }
      const removed = [];
      writeQueue(sessionId, readQueue(sessionId).filter(
        (entry) => {
          const matches = String(entry?.id || '').trim() === targetId;
          if (matches) {
            removed.push(entry);
          }
          return !matches;
        }
      ));
      const releasableAssetPaths = filterReleasableAssetPaths(removed
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean));
      if (releasableAssetPaths.length && windowRef.jennyShell?.attachments?.releaseAssets) {
        windowRef.jennyShell.attachments.releaseAssets(releasableAssetPaths).catch(() => {});
      }
      renderAttachmentSurfaces(sessionId);
    }

    function mergePreparedAttachments(payload, sessionId) {
      const currentQueue = readQueue(sessionId);
      const existingPaths = new Set(
        currentQueue
          .map((entry) => getAttachmentIdentityKey(entry))
          .filter(Boolean)
      );
      const startingCount = currentQueue.length;
      const nextQueued = [...currentQueue];
      const discarded = [];
      let droppedForCapacity = 0;

      for (const entry of Array.isArray(payload?.accepted) ? payload.accepted : []) {
        const attachmentKey = getAttachmentIdentityKey(entry);
        if (attachmentKey && existingPaths.has(attachmentKey)) {
          discarded.push(entry);
          continue;
        }
        if (nextQueued.length >= (Number(queueHelpers()?.ATTACHMENT_CAP) || 8)) {
          droppedForCapacity += 1;
          discarded.push(entry);
          continue;
        }
        if (attachmentKey) {
          existingPaths.add(attachmentKey);
        }
        nextQueued.push(entry);
      }

      writeQueue(sessionId, nextQueued);
      const retainedAssetPaths = new Set(nextQueued
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean));
      releaseAssetEntries(discarded.filter(
        (entry) => !retainedAssetPaths.has(String(entry?.assetPath || '').trim())
      ));
      const addedCount = Math.max(nextQueued.length - startingCount, 0);
      const attachmentToastMessage = buildAttachmentToastMessage(payload, droppedForCapacity, addedCount);
      if (attachmentToastMessage) {
        const hasRejectedAttachments =
          Array.isArray(payload?.rejected) && payload.rejected.length > 0;
        const tone =
          droppedForCapacity > 0 || hasRejectedAttachments
            ? 'warning'
            : 'success';
        showToastMessage(attachmentToastMessage, {
          title: jt('attachments.queue.updatedTitle', 'Attachments Updated'),
          tone,
          sticky: tone === 'warning',
          source: TOAST_SOURCE.attachments,
          dedupeKey: `${TOAST_SOURCE.attachments}:queue`,
        });
      }
      renderAttachmentSurfaces(sessionId);
    }

    // UIUX-006: each async attachment op is stamped with a {sessionId,
    // generation} token for the session it started in. If the session the
    // user is LOOKING AT (and its composer-record generation) moved on
    // before the op resolves, the result must not land in whatever session
    // now happens to be live — it is routed back to its origin session's
    // record (or released if that session is gone) by the composer-session
    // controller. Absent that controller (older/test callers), an op may
    // merge only while its origin is still active; otherwise its assets are
    // released rather than mutating the newly active session.
    function beginAttachmentToken(sessionId) {
      if (disposed) { return null; }
      const base = windowRef.rendererComposerSessionStateController?.beginAttachmentOp?.(sessionId) || {
        sessionId: String((sessionId === undefined ? state.currentSessionId : sessionId) || '').trim(),
        generation: 0,
      };
      const token = Object.freeze({ ...base, operationId: `attachment_${++nextOperationId}` });
      activeTokens.set(token.operationId, token);
      if (sessionId !== undefined && !isLiveQueue(sessionId)) paneTokens.add(token);
      return token;
    }

    function cancelAttachmentToken(token) {
      const operationId = String(token?.operationId || '').trim();
      settlePending(token);
      return operationId ? activeTokens.delete(operationId) : false;
    }

    function routeAttachmentResult(token, payload) {
      const operationId = String(token?.operationId || '').trim();
      const acceptedCount = payload?.accepted?.length || 0;
      const rejectedCount = payload?.rejected?.length || 0;
      const logRouted = (routed) => {
        try {
          appendClientLog(routed?.target === 'discarded' ? 'WARN' : 'DEBUG', 'composer.attachment.routed', {
            target: routed?.target || '', routeReason: routed?.reason || '', operationId, acceptedCount, rejectedCount,
          });
        } catch (_error) { /* noop */ }
        return routed;
      };
      const activeToken = operationId ? activeTokens.get(operationId) : null;
      // The placeholders go first, so the merge's own render shows the real items in their place.
      const hadPending = clearAttachmentPending(token);
      if (disposed || !activeToken || activeToken !== token) {
        if (hadPending && !disposed) renderTokenSurface(token);
        releaseAssetEntries(payload?.accepted);
        return logRouted({ target: 'discarded', reason: disposed ? 'disposed' : 'stale_operation' });
      }
      activeTokens.delete(operationId);
      const controller = windowRef.rendererComposerSessionStateController;
      if (controller && token) {
        const routed = controller.commitAttachmentResult(token, payload, { mergeActive: mergePreparedAttachments });
        // A result kept for (or dropped from) another session still clears this op's placeholders on screen.
        if (hadPending && routed?.target !== 'active') renderTokenSurface(token);
        return logRouted(routed);
      }
      if (token?.sessionId && String(state.currentSessionId || '').trim() !== String(token.sessionId)) {
        if (hadPending) renderTokenSurface(token);
        releaseAssetEntries(payload?.accepted);
        return logRouted({ target: 'discarded', reason: 'origin_unavailable' });
      }
      mergePreparedAttachments(payload);
      return logRouted({ target: 'active' });
    }

    async function handleAttachmentPicker(token = beginAttachmentToken()) {
      try {
        const payload = await windowRef.jennyShell.attachments.pick({ session_id: token?.sessionId || '' });
        const routed = routeAttachmentResult(token, payload);
        // Pane 0's settings popover (and its focus restore) is not another pane's.
        if (!disposed && routed.target !== 'discarded' && !paneTokens.has(token)) {
          closeComposerPopover({ restoreFocus: true });
        }
      } catch (error) {
        cancelAttachmentToken(token);
        throw error;
      }
    }

    // `dropped` holds path strings or the dropped File objects. Files go to the
    // preload's prepareDroppedFiles, which resolves them itself, so a drop from
    // outside the workspace attaches like a picker selection; path strings (and
    // Files when that bridge is missing) keep the workspace-root rules.
    async function prepareDroppedAttachments(dropped, token = beginAttachmentToken()) {
      if (!Array.isArray(dropped) || !dropped.length) {
        cancelAttachmentToken(token);
        return;
      }
      const attachments = windowRef.jennyShell.attachments;
      const files = dropped.filter((entry) => entry && typeof entry === 'object');
      const useFiles = files.length > 0 && typeof attachments.prepareDroppedFiles === 'function';
      const paths = useFiles ? [] : dropped.map((entry) => (typeof entry === 'string'
        ? entry.trim()
        : String((typeof attachments.getPathForFile === 'function' && attachments.getPathForFile(entry)) || '').trim()))
        .filter(Boolean);
      if (!useFiles && !paths.length) {
        cancelAttachmentToken(token);
        return;
      }
      markAttachmentPending(token, pendingItemsFor(dropped));
      try {
        const scope = { session_id: token?.sessionId || '' };
        const payload = useFiles
          ? await attachments.prepareDroppedFiles(files, scope)
          : await attachments.prepare(paths, scope);
        routeAttachmentResult(token, payload);
      } catch (error) {
        cancelAttachmentToken(token);
        throw error;
      }
    }

    async function queueInlineImageAttachment(payload, token = beginAttachmentToken()) {
      markAttachmentPending(token, [{ kind: 'image', name: payload?.displayName }]);
      try {
        const saved = await windowRef.jennyShell.attachments.saveImageAsset(payload, { session_id: token?.sessionId || '' });
        routeAttachmentResult(token, { accepted: [saved], rejected: [] });
        return saved;
      } catch (error) {
        try { appendClientLog('WARN', 'composer.attachment.save_image_failed', { message: error?.message || String(error), mimeType: payload?.mimeType || '', sizeBytes: payload?.bytes?.byteLength ?? null }); } catch (_error) { /* noop */ }
        cancelAttachmentToken(token);
        throw error;
      }
    }

    // A picture made by the app (the sketch "Mark up" question) takes the pasted image's path, with its checks:
    // the queue's image and total caps here, the type and size checks of saveImageAsset. The vision gate is
    // read through resolveActiveVision so the caller can leave the picture out for a model that takes none.
    function resolveActiveVision() {
      const gate = windowRef.rendererComposerVisionGate || globalThis.rendererComposerVisionGate || null;
      const session = (Array.isArray(state.sessions) ? state.sessions : []).find((entry) => entry && entry.id === state.currentSessionId);
      const preferredModel = String((session ? session.preferred_model : state.runtimeDraft?.preferredModel) || '').trim();
      return gate?.resolveActiveModelVision?.(state, { preferredModel }) || { supported: null, modelLabel: '' };
    }

    async function attachPicture({ bytes, mimeType, displayName } = {}) {
      const queued = readQueue();
      const maxImages = (windowRef.rendererComposerVisionGate || globalThis.rendererComposerVisionGate)?.MAX_IMAGE_ATTACHMENTS ?? 4;
      if (queued.length >= 8 || queued.filter((entry) => entry?.kind === 'image').length >= maxImages) return { ok: false, reason: 'too_many' };
      try {
        await queueInlineImageAttachment({ bytes, mimeType: mimeType || 'image/png', displayName, sourceKind: 'capture' });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: /byte limit/i.test(String(error?.message || '')) ? 'too_large' : 'failed' };
      }
    }

    // Lazy feature modules reach the composer through this one object (windowRef.rendererComposerPictures).
    const pictures = Object.freeze({ resolveVision: resolveActiveVision, attachPicture });
    try { windowRef.rendererComposerPictures = pictures; } catch (_error) { /* a frozen test window */ }

    // dragenter and dragover both call this many times a second; only a change of drop state renders.
    function setDropActive(active) {
      const wasActive = state.attachments.dragDepth > 0;
      state.attachments.dragDepth = active ? Math.max(state.attachments.dragDepth, 1) : 0;
      if (wasActive !== Boolean(active)) renderAttachmentTray();
    }

    function suppressFileDropNavigation(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    function getDroppedFilePaths(event) {
      const files = event.dataTransfer && event.dataTransfer.files ? [...event.dataTransfer.files] : [];
      // File.path was removed by Electron (32+); only the preload-side
      // webUtils.getPathForFile bridge can resolve a dropped File to a path.
      const getPathForFile = windowRef.jennyShell?.attachments?.getPathForFile;
      if (typeof getPathForFile !== 'function') {
        return [];
      }
      return files
        .map((file) => String(getPathForFile(file) || '').trim())
        .filter(Boolean);
    }

    function dispose() {
      disposed = true;
      const ours = new Set(activeTokens.keys());
      state.attachmentPending = pendingList().filter((entry) => !ours.has(entry.operationId));
      activeTokens.clear();
      try { if (windowRef.rendererComposerPictures === pictures) windowRef.rendererComposerPictures = null; } catch (_error) { /* a frozen test window */ }
    }

    return {
      resetAttachmentQueue,
      removeQueuedAttachment,
      mergePreparedAttachments,
      beginAttachmentToken,
      cancelAttachmentToken,
      handleAttachmentPicker,
      prepareDroppedAttachments,
      queueInlineImageAttachment,
      attachPicture,
      resolveActiveVision,
      setDropActive,
      suppressFileDropNavigation,
      getDroppedFilePaths,
      dispose,
    };
  }

  return { createAttachmentQueueController };
});
