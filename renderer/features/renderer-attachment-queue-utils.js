(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAttachmentQueueUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

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
    let disposed = false;
    let nextOperationId = 0;
    const activeTokens = new Map();

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

    function renderAttachmentSurfaces() {
      renderAttachmentTray();
      try {
        renderComposerState();
      } catch (error) {
        appendClientLog('WARN', 'composer.attachment.render_failed', { message: String(error?.message || error) });
      }
    }

    function resetAttachmentQueue() {
      const queuedAttachments = Array.isArray(state.attachments?.queued) ? state.attachments.queued : [];
      state.attachments.queued = [];
      const releasableAssetPaths = filterReleasableAssetPaths(queuedAttachments
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean));
      if (releasableAssetPaths.length && windowRef.jennyShell?.attachments?.releaseAssets) {
        windowRef.jennyShell.attachments.releaseAssets(releasableAssetPaths).catch(() => {});
      }
      clearAttachmentNotice();
      renderAttachmentSurfaces();
    }

    function removeQueuedAttachment(attachmentId) {
      const targetId = String(attachmentId || '').trim();
      if (!targetId) {
        return;
      }
      const removed = [];
      state.attachments.queued = (Array.isArray(state.attachments?.queued) ? state.attachments.queued : []).filter(
        (entry) => {
          const matches = String(entry?.id || '').trim() === targetId;
          if (matches) {
            removed.push(entry);
          }
          return !matches;
        }
      );
      const releasableAssetPaths = filterReleasableAssetPaths(removed
        .map((entry) => String(entry?.assetPath || '').trim())
        .filter(Boolean));
      if (releasableAssetPaths.length && windowRef.jennyShell?.attachments?.releaseAssets) {
        windowRef.jennyShell.attachments.releaseAssets(releasableAssetPaths).catch(() => {});
      }
      renderAttachmentSurfaces();
    }

    function mergePreparedAttachments(payload) {
      const existingPaths = new Set(
        (Array.isArray(state.attachments?.queued) ? state.attachments.queued : [])
          .map((entry) => getAttachmentIdentityKey(entry))
          .filter(Boolean)
      );
      const startingCount = Array.isArray(state.attachments?.queued) ? state.attachments.queued.length : 0;
      const nextQueued = [...(Array.isArray(state.attachments?.queued) ? state.attachments.queued : [])];
      const discarded = [];
      let droppedForCapacity = 0;

      for (const entry of Array.isArray(payload?.accepted) ? payload.accepted : []) {
        const attachmentKey = getAttachmentIdentityKey(entry);
        if (attachmentKey && existingPaths.has(attachmentKey)) {
          discarded.push(entry);
          continue;
        }
        if (nextQueued.length >= 8) {
          droppedForCapacity += 1;
          discarded.push(entry);
          continue;
        }
        if (attachmentKey) {
          existingPaths.add(attachmentKey);
        }
        nextQueued.push(entry);
      }

      state.attachments.queued = nextQueued;
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
          title: 'Attachments Updated',
          tone,
          sticky: tone === 'warning',
          source: TOAST_SOURCE.attachments,
          dedupeKey: `${TOAST_SOURCE.attachments}:queue`,
        });
      }
      renderAttachmentSurfaces();
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
    function beginAttachmentToken() {
      if (disposed) { return null; }
      const base = windowRef.rendererComposerSessionStateController?.beginAttachmentOp?.() || {
        sessionId: String(state.currentSessionId || '').trim(),
        generation: 0,
      };
      const token = Object.freeze({ ...base, operationId: `attachment_${++nextOperationId}` });
      activeTokens.set(token.operationId, token);
      return token;
    }

    function cancelAttachmentToken(token) {
      const operationId = String(token?.operationId || '').trim();
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
      if (disposed || !activeToken || activeToken !== token) {
        releaseAssetEntries(payload?.accepted);
        return logRouted({ target: 'discarded', reason: disposed ? 'disposed' : 'stale_operation' });
      }
      activeTokens.delete(operationId);
      const controller = windowRef.rendererComposerSessionStateController;
      if (controller && token) {
        return logRouted(controller.commitAttachmentResult(token, payload, { mergeActive: mergePreparedAttachments }));
      }
      if (token?.sessionId && String(state.currentSessionId || '').trim() !== String(token.sessionId)) {
        releaseAssetEntries(payload?.accepted);
        return logRouted({ target: 'discarded', reason: 'origin_unavailable' });
      }
      mergePreparedAttachments(payload);
      return logRouted({ target: 'active' });
    }

    async function handleAttachmentPicker(token = beginAttachmentToken()) {
      try {
        const payload = await windowRef.jennyShell.attachments.pick();
        const routed = routeAttachmentResult(token, payload);
        if (!disposed && routed.target !== 'discarded') {
          closeComposerPopover({ restoreFocus: true });
        }
      } catch (error) {
        cancelAttachmentToken(token);
        throw error;
      }
    }

    async function prepareDroppedAttachments(paths, token = beginAttachmentToken()) {
      if (!Array.isArray(paths) || !paths.length) {
        cancelAttachmentToken(token);
        return;
      }
      try {
        const payload = await windowRef.jennyShell.attachments.prepare(paths);
        routeAttachmentResult(token, payload);
      } catch (error) {
        cancelAttachmentToken(token);
        throw error;
      }
    }

    async function queueInlineImageAttachment(payload, token = beginAttachmentToken()) {
      try {
        const saved = await windowRef.jennyShell.attachments.saveImageAsset(payload);
        routeAttachmentResult(token, { accepted: [saved], rejected: [] });
        return saved;
      } catch (error) {
        try { appendClientLog('WARN', 'composer.attachment.save_image_failed', { message: error?.message || String(error), mimeType: payload?.mimeType || '', sizeBytes: payload?.bytes?.byteLength ?? null }); } catch (_error) { /* noop */ }
        cancelAttachmentToken(token);
        throw error;
      }
    }

    function setDropActive(active) {
      state.attachments.dragDepth = active ? Math.max(state.attachments.dragDepth, 1) : 0;
      renderAttachmentTray();
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
      activeTokens.clear();
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
      setDropActive,
      suppressFileDropNavigation,
      getDroppedFilePaths,
      dispose,
    };
  }

  return { createAttachmentQueueController };
});
