/* renderer/shell/renderer-viewport-scheduling-utils.js – viewport sync
   scheduling cluster extracted from renderer-viewport-utils.js (UMD).
   Owns the coalesced message-sync frame, the post-layout sync timer, the
   transient rAF/timeout registries, and the approval-gap live-follow brake. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportSchedulingUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createViewportSchedulingUtils(deps) {
    const { state, readerAwayPauseReason } = deps;
    // The pane's own follow intent; default is the single-pane state.ui.followLatest.
    const followState = deps.followState || { get: () => state.ui.followLatest };
    const { chatTimeline, chatThreadScroll, composerWrap } = deps.dom || {};
    const {
      thinkingController,
      reducedMotionQuery,
    } = deps.controllers || {};
    const {
      requestViewportFrame,
      cancelViewportFrame,
      isDisposed = () => false,
      getScrollCoordinator = () => null,
      shouldAutoScrollThread,
      getCurrentSessionMessages,
      getScrollMetrics,
      syncThreadScrollState,
      syncRenderedThinkingPanels,
      snapThreadToBottom,
      startLiveStreamingFollow,
      cancelLiveStreamingFollow,
      updateComposerSafeOffset,
      updateAssistantSpritePosition,
      appendClientLog = () => {},
    } = deps.callbacks || {};

    // Set while a visible approval gap holds live-follow back, and consumed
    // by the first sync after it clears. See the release in the sync frame.
    let approvalHoldReleasePending = false;
    let viewportSyncFrameHandle = 0;
    let pendingViewportSync = null;
    let postLayoutViewportSyncTimer = 0;
    let pendingPostLayoutViewportSync = null;
    const transientViewportFrames = new Set();
    const transientViewportTimers = new Set();

    // The scroll container runs behind the floating composer (the thread pads
    // its tail by --composer-safe-offset), so the reader-visible band ends at
    // the composer's top edge, not at the container's bottom.
    function readReaderVisibleBottom(scrollRect) {
      let composerRect;
      try { composerRect = composerWrap?.getBoundingClientRect?.() || null; } catch (_error) { composerRect = null; }
      const composerTop = Number(composerRect?.top);
      if (!composerRect || !(Number(composerRect.height) > 0) || !Number.isFinite(composerTop)) {
        return scrollRect.bottom;
      }
      return Math.max(scrollRect.top, Math.min(scrollRect.bottom, composerTop));
    }

    // The element whose bottom edge carries a pending decision's actions. A plan
    // proposal's approval row is a 1px marker at the TOP of its card, so the
    // card's actions host (Build it / Keep planning) stands in for it.
    const PENDING_DECISION_EDGE_SELECTOR = '.approval-gap-row[data-approval-status="pending"]:not([data-approval-resolved="true"]):not([data-approval-variant="plan"]), '
      + '[data-plan-document][data-plan-state="pending"]:not([data-plan-submitting="true"]) [data-plan-actions]';

    // Brake only while a pending prompt's bottom edge (where its Allow/Deny
    // actions sit) is on screen. A prompt that has only peeked in, or sits under
    // the composer, must keep follow running so it scrolls into view.
    function hasPendingApprovalGapInViewport(scrollContainer) {
      if (!scrollContainer || typeof scrollContainer.querySelectorAll !== 'function') {
        return false;
      }
      const rows = scrollContainer.querySelectorAll(PENDING_DECISION_EDGE_SELECTOR);
      if (!rows || rows.length === 0) return false;
      let scrollRect;
      try {
        scrollRect = scrollContainer.getBoundingClientRect();
      } catch (_error) {
        return false;
      }
      const visibleBottom = readReaderVisibleBottom(scrollRect);
      for (const row of rows) {
        let rowRect;
        try { rowRect = row.getBoundingClientRect(); } catch (_error) { continue; }
        if (!rowRect) continue;
        if (rowRect.bottom > scrollRect.top && rowRect.bottom <= visibleBottom) return true;
      }
      return false;
    }

    function scheduleTransientViewportFrame(callback) {
      if (isDisposed() || typeof callback !== 'function') return 0;
      let handle = 0;
      let firedSynchronously = false;
      handle = requestViewportFrame((timestamp) => {
        firedSynchronously = true;
        if (handle) transientViewportFrames.delete(handle);
        if (!isDisposed()) callback(timestamp);
      });
      if (!firedSynchronously && handle) transientViewportFrames.add(handle);
      return handle;
    }

    function scheduleTransientViewportTimer(callback, delayMs) {
      if (isDisposed() || typeof callback !== 'function' || typeof window?.setTimeout !== 'function') return 0;
      let handle = 0;
      let firedSynchronously = false;
      handle = window.setTimeout(() => {
        firedSynchronously = true;
        if (handle) transientViewportTimers.delete(handle);
        if (!isDisposed()) callback();
      }, delayMs);
      if (!firedSynchronously && handle) transientViewportTimers.add(handle);
      return handle;
    }

    function scheduleMessageViewportSync(messages, options = {}) {
      if (isDisposed()) return;
      pendingViewportSync = {
        messages,
        options: { ...options },
      };
      if (viewportSyncFrameHandle) {
        return;
      }
      viewportSyncFrameHandle = requestViewportFrame(() => {
        if (isDisposed()) {
          viewportSyncFrameHandle = 0;
          pendingViewportSync = null;
          return;
        }
        const nextSync = pendingViewportSync;
        viewportSyncFrameHandle = 0;
        pendingViewportSync = null;
        if (!nextSync) {
          return;
        }
        try {
          const nextMessages = nextSync.messages;
          const nextOptions = nextSync.options || {};
          const isScopedPatch = Boolean(nextOptions.patchedRoot);
          if (!isScopedPatch || nextOptions.requiresShellGeometry === true) {
            updateComposerSafeOffset({
              preserveSurfaceEffectWidths: nextOptions.preserveSurfaceEffectWidths === true,
            });
          }
          if (followState.get() === false) {
            getScrollCoordinator()?.restoreReaderAnchor?.();
          }
          if (shouldAutoScrollThread({
            forceBottom: nextOptions.forceBottom,
            followLatest: followState.get(),
            thinkingAutoScroll: thinkingController.shouldAutoScroll(),
          })) {
            const pendingApprovalInView = !nextOptions.forceBottom
              && hasPendingApprovalGapInViewport(chatThreadScroll);
                if (chatThreadScroll && !pendingApprovalInView) {
                  // Releasing the approval brake must not double as a jump. The
                  // reader is sitting wherever they were reading the call they just
                  // approved, and this is the first sync allowed to scroll since the
                  // prompt appeared -- so it used to take them straight to
                  // scrollHeight - clientHeight. Spend the release on holding
                  // position; the next streaming sync follows normally.
                  if (approvalHoldReleasePending && !nextOptions.forceBottom) {
                    approvalHoldReleasePending = false;
                  } else if (nextOptions.forceBottom || reducedMotionQuery.matches) {
                    approvalHoldReleasePending = false;
                    snapThreadToBottom({ behavior: 'auto' });
                  } else {
                    startLiveStreamingFollow();
                  }
                } else if (pendingApprovalInView) {
                  approvalHoldReleasePending = true;
                  cancelLiveStreamingFollow();
                }
          } else {
            cancelLiveStreamingFollow();
          }
          if (!nextOptions.preserveFollowLatest) {
            syncThreadScrollState({
              ...getScrollMetrics(),
              userInitiated: false,
            });
          } else if (followState.get() !== false) {
            thinkingController.resumeAutoScroll(readerAwayPauseReason);
          }
          syncRenderedThinkingPanels(nextOptions.patchedRoot || chatTimeline);
          if (followState.get() === false) {
            getScrollCoordinator()?.restoreReaderAnchor?.();
          }
          updateAssistantSpritePosition(nextMessages);
        } catch (error) {
          appendClientLog('ERROR', 'viewport.sync_error', { message: String(error?.message || '') });
        }
      });
    }

    function schedulePostLayoutViewportSync(options = {}) {
      if (isDisposed()) return;
      const nextOptions = options || {};
      const delayMs = Math.max(Number(nextOptions.delayMs) || 0, 0);
      const syncOptions = nextOptions.syncOptions && typeof nextOptions.syncOptions === 'object'
        ? { ...nextOptions.syncOptions }
        : {};
      const resolveMessages = typeof nextOptions.resolveMessages === 'function'
        ? nextOptions.resolveMessages
        : getCurrentSessionMessages;

      if (delayMs <= 0) {
        scheduleMessageViewportSync(resolveMessages(), syncOptions);
        return;
      }

      pendingPostLayoutViewportSync = {
        resolveMessages,
        syncOptions,
      };
      if (postLayoutViewportSyncTimer) {
        window.clearTimeout(postLayoutViewportSyncTimer);
      }
      postLayoutViewportSyncTimer = window.setTimeout(() => {
        if (isDisposed()) {
          postLayoutViewportSyncTimer = 0;
          pendingPostLayoutViewportSync = null;
          return;
        }
        const nextSync = pendingPostLayoutViewportSync;
        postLayoutViewportSyncTimer = 0;
        pendingPostLayoutViewportSync = null;
        if (!nextSync) {
          return;
        }
        scheduleMessageViewportSync(nextSync.resolveMessages(), nextSync.syncOptions);
      }, delayMs);
    }

    function disposeViewportScheduling() {
      cancelViewportFrame(viewportSyncFrameHandle);
      viewportSyncFrameHandle = 0;
      pendingViewportSync = null;
      if (postLayoutViewportSyncTimer) {
        window.clearTimeout(postLayoutViewportSyncTimer);
      }
      postLayoutViewportSyncTimer = 0;
      pendingPostLayoutViewportSync = null;
      for (const handle of transientViewportFrames) cancelViewportFrame(handle);
      transientViewportFrames.clear();
      for (const handle of transientViewportTimers) window.clearTimeout(handle);
      transientViewportTimers.clear();
    }

    return {
      scheduleTransientViewportFrame,
      scheduleTransientViewportTimer,
      scheduleMessageViewportSync,
      schedulePostLayoutViewportSync,
      disposeViewportScheduling,
    };
  }

  return { createViewportSchedulingUtils };
});
