/* renderer/shell/renderer-viewport-scheduling-utils.js – viewport sync
   scheduling cluster extracted from renderer-viewport-utils.js (UMD).
   Owns the coalesced message-sync frame, the post-layout sync timer, the
   transient rAF/timeout registries, the approval-gap live-follow brake, and
   the pane's tail cushion (renderer-viewport-tail-cushion-utils.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportSchedulingUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Resolved per call: index.html loads the cushion after this script.
  function getTailCushionUtils() {
    return (typeof globalThis !== 'undefined' && globalThis.rendererViewportTailCushionUtils)
      || (typeof require === 'function' ? require('./renderer-viewport-tail-cushion-utils') : null) || {};
  }

  // Row 131: after a chat opens, the bottom stays pinned (instantly, never by
  // the streaming glide) while late height changes settle.
  const LANDING_HOLD_IDLE_MS = 400;
  const LANDING_HOLD_MAX_MS = 2000;

  function createViewportSchedulingUtils(deps) {
    const { state, readerAwayPauseReason } = deps;
    // The pane's own follow intent; default is the single-pane state.ui.followLatest.
    const followState = deps.followState || { get: () => state.ui.followLatest };
    const { chatTimeline, chatThreadScroll, composerWrap } = deps.dom || {};
    const ResizeObserverRef = deps.ResizeObserverRef
      || (typeof ResizeObserver === 'function' ? ResizeObserver : null);
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
      getSessionId = () => state.currentSessionId,
      isReaderReleaseHeld = () => false,
      getComposerSafeOffset = () => 0,
      appendClientLog = () => {},
    } = deps.callbacks || {};

    // Set while a visible approval gap holds live-follow back, and consumed
    // by the first sync after it clears. See the release in the sync frame.
    let approvalHoldReleasePending = false;
    let viewportSyncFrameHandle = 0;
    let pendingViewportSync = null;
    let postLayoutViewportSyncTimer = 0;
    let pendingPostLayoutViewportSync = null;
    // Session whose viewport last synced (null before the first sync) and the
    // one landing hold of this pane: { sessionId, observer, idleTimer, maxTimer, timelineHeight }.
    let lastSyncedSessionId = null;
    let landingHold = null;
    const transientViewportFrames = new Set();
    const transientViewportTimers = new Set();
    // HB-038: a shrink at the end of a followed live reply leaves blank room
    // instead of dropping the view (inert without a ResizeObserver, as in jsdom).
    const tailCushion = getTailCushionUtils().createViewportTailCushion?.({
      dom: { chatThreadScroll, chatTimeline },
      followState,
      getSessionId,
      isReaderReleaseHeld,
      getComposerSafeOffset,
      reducedMotionQuery,
      isStreaming: () => getScrollCoordinator()?.isStreaming?.() === true,
      noteProgrammaticWrite: (reason) => getScrollCoordinator()?.noteProgrammaticWrite?.(reason),
      requestFrame: requestViewportFrame,
      cancelFrame: cancelViewportFrame,
    }) || null;
    tailCushion?.attach();

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

    function startHoldTimer(callback, delayMs) {
      if (typeof window?.setTimeout !== 'function') return 0;
      const handle = window.setTimeout(callback, delayMs);
      if (handle && typeof handle === 'object' && typeof handle.unref === 'function') handle.unref();
      return handle;
    }

    function endLandingHold() {
      const hold = landingHold;
      if (!hold) return;
      landingHold = null;
      if (hold.idleTimer) window.clearTimeout(hold.idleTimer);
      if (hold.maxTimer) window.clearTimeout(hold.maxTimer);
      try { hold.observer?.disconnect?.(); } catch (_error) { /* observer already gone */ }
    }

    function armLandingHoldIdleTimer() {
      if (!landingHold) return;
      if (landingHold.idleTimer) window.clearTimeout(landingHold.idleTimer);
      landingHold.idleTimer = startHoldTimer(endLandingHold, LANDING_HOLD_IDLE_MS);
    }

    // The hold stays live only for a latched reader on the same chat with no
    // streamed reply; anything else releases it.
    function isLandingHoldLive() {
      if (!landingHold) return false;
      if (isDisposed() || followState.get() === false
        || String(getSessionId() || '') !== landingHold.sessionId
        || getScrollCoordinator()?.isStreaming?.() === true) {
        endLandingHold();
        return false;
      }
      return true;
    }

    function repinForLandingHold() {
      if (!isLandingHoldLive() || !chatThreadScroll) return false;
      const metrics = getScrollMetrics();
      const maximum = Math.max(0, (Number(metrics.scrollHeight) || 0) - (Number(metrics.clientHeight) || 0));
      if ((Number(metrics.scrollTop) || 0) < maximum - 1) snapThreadToBottom({ behavior: 'auto' });
      return true;
    }

    function readHoldTimelineHeight(entries) {
      const entry = Array.isArray(entries) ? entries[entries.length - 1] : null;
      const observed = Number(entry?.contentRect?.height);
      if (Number.isFinite(observed)) return observed;
      try { return Number(chatTimeline?.getBoundingClientRect?.().height) || 0; } catch (_error) { return 0; }
    }

    function handleLandingHoldResize(entries) {
      if (!landingHold) return;
      const height = readHoldTimelineHeight(entries);
      if (height === landingHold.timelineHeight) return;
      landingHold.timelineHeight = height;
      if (!isLandingHoldLive()) return;
      armLandingHoldIdleTimer();
      repinForLandingHold();
    }

    function beginLandingHold() {
      endLandingHold();
      landingHold = {
        sessionId: String(getSessionId() || ''),
        observer: null,
        idleTimer: 0,
        maxTimer: 0,
        timelineHeight: readHoldTimelineHeight(null),
      };
      if (ResizeObserverRef && chatTimeline) {
        try {
          landingHold.observer = new ResizeObserverRef(handleLandingHoldResize);
          landingHold.observer.observe(chatTimeline);
        } catch (_error) {
          landingHold.observer = null;
        }
      }
      armLandingHoldIdleTimer();
      landingHold.maxTimer = startHoldTimer(endLandingHold, LANDING_HOLD_MAX_MS);
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
          // The first sync for a session (or after boot) lands on the latest
          // message in one step; the streaming glide is for streamed growth.
          const sessionId = String(getSessionId() || '');
          const sessionChanged = sessionId !== lastSyncedSessionId;
          lastSyncedSessionId = sessionId;
          const landing = sessionChanged && followState.get() !== false && Boolean(chatThreadScroll);
          if (sessionChanged && !landing) endLandingHold();
          const forceBottom = Boolean(nextOptions.forceBottom) || landing;
          if (forceBottom) tailCushion?.drop('force_bottom');
          else tailCushion?.noteViewportSync();
          if (shouldAutoScrollThread({
            forceBottom,
            followLatest: followState.get(),
            thinkingAutoScroll: thinkingController.shouldAutoScroll(),
          })) {
            const pendingApprovalInView = !forceBottom
              && hasPendingApprovalGapInViewport(chatThreadScroll);
                if (chatThreadScroll && !pendingApprovalInView) {
                  // Releasing the approval brake must not double as a jump. The
                  // reader is sitting wherever they were reading the call they just
                  // approved, and this is the first sync allowed to scroll since the
                  // prompt appeared -- so it used to take them straight to
                  // scrollHeight - clientHeight. Spend the release on holding
                  // position; the next streaming sync follows normally.
                  if (approvalHoldReleasePending && !forceBottom) {
                    approvalHoldReleasePending = false;
                  } else if (forceBottom || reducedMotionQuery.matches) {
                    approvalHoldReleasePending = false;
                    snapThreadToBottom({ behavior: 'auto' });
                    if (landing) beginLandingHold();
                  } else if (!repinForLandingHold()) {
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
      endLandingHold();
      tailCushion?.dispose();
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
      noteReaderIntent() { tailCushion?.noteReaderIntent(); endLandingHold(); },
      tailCushion,
    };
  }

  return { createViewportSchedulingUtils };
});
