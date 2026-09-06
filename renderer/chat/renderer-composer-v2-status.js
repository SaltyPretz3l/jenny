(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerV2Status = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function createComposerV2StatusController(deps) {
    const { state } = deps;
    const {
      appendClientLog,
      getRendererElapsedMs,
    } = deps.callbacks;
    function getMultiStreamController() {
      return globalThis.rendererMultiStreamController || null;
    }

    function getCurrentSessionId() {
      return String(state.currentSessionId || '').trim();
    }

    function syncLegacyBusySnapshots() {
      const multiStreamController = getMultiStreamController();
      if (!multiStreamController) {
        return;
      }
      const currentSessionId = getCurrentSessionId();
      const streamingSessionIds = multiStreamController.getStreamingSessionIds();
      const activeSessionId = multiStreamController.isSessionStreaming(currentSessionId)
        ? currentSessionId
        : String(streamingSessionIds[0] || '').trim();
      state.activeStreamSessionId = activeSessionId;
      state.activeStreamId = activeSessionId
        ? String(multiStreamController.getStreamIdForSession(activeSessionId) || '').trim()
        : '';
      const preflightSessionId = multiStreamController.getPreflight?.(currentSessionId)
        ? currentSessionId
        : String(multiStreamController.getPreflightSessionIds?.()[0] || '').trim();
      state.sendPreflight = preflightSessionId
        ? (multiStreamController.getPreflight?.(preflightSessionId) || null)
        : null;
    }

    function buildAttachmentBudget(entries) {
      const accepted = [];
      const skipped = [];
      let remaining = 40_000;

      for (const entry of Array.isArray(entries) ? entries : []) {
        if (String(entry?.kind || '').trim() === 'image' || String(entry?.kind || '').trim() === 'audio') {
          accepted.push({
            ...entry,
            budgetTruncated: false,
          });
          continue;
        }
        const text = String(entry && entry.text ? entry.text : '');
        if (!text) {
          skipped.push({
            ...entry,
            skippedReason: 'Attachment content is empty.',
          });
          continue;
        }
        if (remaining <= 0) {
          skipped.push({
            ...entry,
            skippedReason: 'Total attachment budget exhausted.',
          });
          continue;
        }
        if (text.length <= remaining) {
          accepted.push({
            ...entry,
            budgetTruncated: false,
          });
          remaining -= text.length;
          continue;
        }
        const truncatedText = `${text.slice(0, remaining).trimEnd()}\n...[truncated]`;
        accepted.push({
          ...entry,
          text: truncatedText,
          truncated: true,
          budgetTruncated: true,
        });
        remaining = 0;
      }

      return {
        accepted,
        skipped,
      };
    }

    function summarizeAttachmentPreparation(payload) {
      const parts = [];
      const accepted = Array.isArray(payload && payload.accepted) ? payload.accepted : [];
      const rejected = Array.isArray(payload && payload.rejected) ? payload.rejected : [];
      if (accepted.some((entry) => entry.truncated)) {
        parts.push('Some attachments were truncated to fit the per-file limit.');
      }
      if (rejected.length) {
        parts.push(rejected[0].reason || 'Some attachments could not be added.');
      }
      return parts.join(' ');
    }

    function buildAttachmentToastMessage(payload, droppedForCapacity, addedCount) {
      const parts = [];
      const resolvedDropped = Number(droppedForCapacity) || 0;
      const resolvedAdded = Number(addedCount) || 0;

      if (resolvedAdded > 0) {
        parts.push(`Added ${resolvedAdded} attachment${resolvedAdded === 1 ? '' : 's'}.`);
      }

      const summary = summarizeAttachmentPreparation(payload);
      if (summary) {
        parts.push(summary);
      }

      if (resolvedDropped > 0) {
        parts.push(
          `${resolvedDropped} attachment${resolvedDropped === 1 ? '' : 's'} skipped because the queue is full.`
        );
      }

      return parts.join(' ').trim();
    }

    function setAttachmentNotice(message) {
      state.attachments.notice = String(message || '').trim();
    }

    function clearAttachmentNotice() {
      state.attachments.notice = '';
    }

    function normalizeComposerNoticeTone(value) {
      const token = String(value || '').trim().toLowerCase();
      if (token === 'pending' || token === 'success' || token === 'warning' || token === 'danger') {
        return token;
      }
      return 'default';
    }

    function setComposerStatusNotice(message, options) {
      const resolvedOptions = options || {};
      const nextMessage = String(message || '').trim();
      const owner = String(resolvedOptions.owner || '').trim();
      const timestamp = Number.isFinite(Number(resolvedOptions.at)) ? Number(resolvedOptions.at) : Date.now();
      if (
        state.ui.composerStatusNotice &&
        Number(state.ui.composerStatusNoticeAt || 0) > timestamp &&
        state.ui.composerStatusNoticeOwner !== owner
      ) {
        return;
      }
      state.ui.composerStatusNotice = nextMessage;
      state.ui.composerStatusNoticeAt = timestamp;
      state.ui.composerStatusNoticeOwner = owner;
      state.ui.composerStatusNoticeTone = normalizeComposerNoticeTone(resolvedOptions.tone);
      state.ui.composerStatusNoticeSpinner = resolvedOptions.spinner === true;
      state.ui.composerStatusNoticeBadgeText = String(resolvedOptions.badgeText || '').trim();
    }

    function clearComposerStatusNotice(options) {
      const resolvedOptions = options || {};
      const owner = String(resolvedOptions.owner || '').trim();
      if (owner && state.ui.composerStatusNoticeOwner && state.ui.composerStatusNoticeOwner !== owner) {
        return;
      }
      state.ui.composerStatusNotice = '';
      state.ui.composerStatusNoticeAt = 0;
      state.ui.composerStatusNoticeOwner = '';
      state.ui.composerStatusNoticeTone = 'default';
      state.ui.composerStatusNoticeSpinner = false;
      state.ui.composerStatusNoticeBadgeText = '';
    }

    function getActiveSendPreflight() {
      const multiStreamController = getMultiStreamController();
      if (multiStreamController?.getPreflight) {
        syncLegacyBusySnapshots();
        return multiStreamController.getPreflight(getCurrentSessionId()) || null;
      }
      return state.sendPreflight && typeof state.sendPreflight === 'object'
        ? state.sendPreflight
        : null;
    }

    function isSendPreflightPending() {
      return Boolean(getActiveSendPreflight()?.pending);
    }

    function getStreamingSessionIds() {
      const multiStreamController = getMultiStreamController();
      if (multiStreamController?.getStreamingSessionIds) {
        syncLegacyBusySnapshots();
        return multiStreamController.getStreamingSessionIds();
      }
      const activeSessionId = String(state.activeStreamSessionId || '').trim();
      return activeSessionId ? [activeSessionId] : [];
    }

    function getActiveStreamSessionId() {
      return String(getStreamingSessionIds()[0] || '').trim();
    }

    function isAnySendBusy() {
      const multiStreamController = getMultiStreamController();
      if (multiStreamController?.isAnySendBusy) {
        syncLegacyBusySnapshots();
        return multiStreamController.isAnySendBusy();
      }
      return isSendPreflightPending() || Boolean(String(state.activeStreamId || '').trim());
    }

    function isSessionStreaming(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const multiStreamController = getMultiStreamController();
      if (!normalizedSessionId) {
        return false;
      }
      if (multiStreamController?.isSessionStreaming) {
        syncLegacyBusySnapshots();
        return multiStreamController.isSessionStreaming(normalizedSessionId);
      }
      return normalizedSessionId === getActiveStreamSessionId() && Boolean(String(state.activeStreamId || '').trim());
    }

    function hasPendingToolApprovalForSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return false;
      }
      for (const approval of state.pendingToolApprovals.values()) {
        if (String(approval?.sessionId || '').trim() === normalizedSessionId) {
          return true;
        }
      }
      return false;
    }

    function isSendBusy() {
      if (globalThis.rendererCompactionCoordinator?.getCompactionActivity?.(state, getCurrentSessionId())?.pending === true) {
        return true;
      }
      const multiStreamController = getMultiStreamController();
      if (multiStreamController) {
        const currentSessionId = getCurrentSessionId();
        // Mirror the send gate (streaming | preflight | terminal-post-work) so
        // the composer shows the "Queue" affordance during post-work instead of
        // a "Send" that silently queues.
        return Boolean(currentSessionId && multiStreamController.isSessionSendBusy(currentSessionId));
      }
      return isAnySendBusy();
    }

    return {
      buildAttachmentBudget,
      summarizeAttachmentPreparation,
      buildAttachmentToastMessage,
      setAttachmentNotice,
      clearAttachmentNotice,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      getActiveSendPreflight,
      isSendPreflightPending,
      getStreamingSessionIds,
      getActiveStreamSessionId,
      isAnySendBusy,
      isSessionStreaming,
      hasPendingToolApprovalForSession,
      isSendBusy,
    };
  }

  return { createComposerV2StatusController };
});
