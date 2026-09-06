(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportLiveFollowUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LIVE_FOLLOW_SETTLE_PX = 1;
  const LIVE_FOLLOW_RESPONSE_MS = 120;
  const LIVE_FOLLOW_MIN_STEP_PX = 2;
  const LIVE_FOLLOW_USER_OVERRIDE_PX = 24;
  const LIVE_FOLLOW_USER_INTENT_WINDOW_MS = 300;

  function createViewportLiveFollowUtils(deps) {
    const settings = deps || {};
    const state = settings.state || { ui: {} };
    const chatThreadScroll = settings.chatThreadScroll || null;
    const noteProgrammaticWrite = typeof settings.noteProgrammaticWrite === 'function'
      ? settings.noteProgrammaticWrite : null;
    const requestViewportFrame = typeof settings.requestViewportFrame === 'function'
      ? settings.requestViewportFrame
      : function fallbackRequestViewportFrame(callback) {
        if (typeof requestAnimationFrame === 'function') {
          return requestAnimationFrame(callback);
        }
        return 0;
      };
    const cancelViewportFrame = typeof settings.cancelViewportFrame === 'function'
      ? settings.cancelViewportFrame
      : function fallbackCancelViewportFrame(handle) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(handle);
        }
      };
    const liveFollowRuntime = {
      frameHandle: 0,
      targetScrollTop: 0,
      lastTimestamp: 0,
      active: false,
      lastProgrammaticScrollTop: 0,
      lastUserIntentAt: 0,
    };

    function getLiveFollowTargetScrollTop() {
      if (!chatThreadScroll) {
        return 0;
      }
      return Math.max(
        Math.round((Number(chatThreadScroll.scrollHeight) || 0) - (Number(chatThreadScroll.clientHeight) || 0)),
        0
      );
    }

    function cancelLiveStreamingFollow() {
      liveFollowRuntime.active = false;
      liveFollowRuntime.targetScrollTop = 0;
      liveFollowRuntime.lastTimestamp = 0;
      liveFollowRuntime.lastProgrammaticScrollTop = 0;
      liveFollowRuntime.lastUserIntentAt = 0;
      if (liveFollowRuntime.frameHandle) {
        cancelViewportFrame(liveFollowRuntime.frameHandle);
      }
      liveFollowRuntime.frameHandle = 0;
    }

    // A real upward user scroll past the override tolerance releases follow
    // outright: stop the animator AND flip followLatest immediately, rather
    // than leaving followLatest stale-true until a later syncThreadScrollState()
    // call happens to observe the runtime is no longer active. Without the
    // immediate write-through, shouldAutoScrollThread()'s next decision (which
    // gates on followLatest) would still read true and call
    // startLiveStreamingFollow() again, re-anchoring to the user's scrolled-
    // away position and reproducing the latch bug one call later.
    function releaseFollowForUserScrollAway() {
      cancelLiveStreamingFollow();
      state.ui.followLatest = false;
    }

    function scheduleLiveStreamingFollowFrame() {
      if (liveFollowRuntime.frameHandle || !liveFollowRuntime.active) {
        return;
      }
      liveFollowRuntime.frameHandle = requestViewportFrame((timestamp) => {
        liveFollowRuntime.frameHandle = 0;
        stepLiveStreamingFollow(timestamp);
      });
    }

    function noteUserScrollIntent() {
      liveFollowRuntime.lastUserIntentAt = Date.now();
    }

    function hasRecentUserScrollIntent() {
      return liveFollowRuntime.lastUserIntentAt > 0
        && Date.now() - liveFollowRuntime.lastUserIntentAt <= LIVE_FOLLOW_USER_INTENT_WINDOW_MS;
    }

    // Advance the baseline for normal growth. A separate clamp handles a
    // legitimate maximum-scroll decrease so shrink cannot masquerade as an
    // upward reader gesture.
    function advanceProgrammaticScrollTop(nextScrollTop) {
      liveFollowRuntime.lastProgrammaticScrollTop = Math.max(
        liveFollowRuntime.lastProgrammaticScrollTop || 0,
        Number(nextScrollTop) || 0
      );
    }

    function clampProgrammaticScrollTop(maxScrollTop) {
      const maximum = Math.max(0, Number(maxScrollTop) || 0);
      liveFollowRuntime.lastProgrammaticScrollTop = Math.min(
        liveFollowRuntime.lastProgrammaticScrollTop || 0,
        maximum
      );
    }

    function stepLiveStreamingFollow(timestamp) {
      if (!liveFollowRuntime.active || !chatThreadScroll || state.ui.followLatest === false) {
        cancelLiveStreamingFollow();
        return;
      }
      const currentScrollTop = Number(chatThreadScroll.scrollTop) || 0;
      const targetScrollTop = getLiveFollowTargetScrollTop();
      clampProgrammaticScrollTop(targetScrollTop);
      const priorProgrammaticScrollTop = liveFollowRuntime.lastProgrammaticScrollTop || 0;
      /* The animator's own recurring frame loop reaches this point directly
         (not just via startLiveStreamingFollow). If the user has scrolled up
         past the override tolerance since the animator's last known position,
         that is a genuine scroll-away, not the animator's own trailing lag -
         stop advancing and release follow instead of dragging the viewport
         back toward the bottom and re-anchoring the baseline from that
         programmatic move (which would mask the scroll-away on the next
         tolerance check). */
      if (
        hasRecentUserScrollIntent()
        && currentScrollTop < priorProgrammaticScrollTop - LIVE_FOLLOW_USER_OVERRIDE_PX
      ) {
        releaseFollowForUserScrollAway();
        return;
      }
      liveFollowRuntime.targetScrollTop = targetScrollTop;
      const remaining = targetScrollTop - currentScrollTop;
      if (Math.abs(remaining) <= LIVE_FOLLOW_SETTLE_PX) {
        noteProgrammaticWrite?.('live_follow');
        chatThreadScroll.scrollTop = targetScrollTop;
        cancelLiveStreamingFollow();
        return;
      }
      const nextTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : 0;
      const lastTimestamp = liveFollowRuntime.lastTimestamp || 0;
      const elapsedMs = lastTimestamp > 0
        ? Math.max(nextTimestamp - lastTimestamp, 0)
        : 16;
      liveFollowRuntime.lastTimestamp = nextTimestamp || (lastTimestamp + elapsedMs);
      const alpha = Math.min(Math.max(elapsedMs / LIVE_FOLLOW_RESPONSE_MS, 0.12), 0.45);
      const stepPx = Math.max(Math.abs(remaining) * alpha, LIVE_FOLLOW_MIN_STEP_PX);
      noteProgrammaticWrite?.('live_follow');
      chatThreadScroll.scrollTop = remaining > 0
        ? Math.min(currentScrollTop + stepPx, targetScrollTop)
        : Math.max(currentScrollTop - stepPx, targetScrollTop);
      advanceProgrammaticScrollTop(chatThreadScroll.scrollTop);
      scheduleLiveStreamingFollowFrame();
    }

    function startLiveStreamingFollow() {
      if (!chatThreadScroll) {
        return;
      }
      const currentScrollTop = Number(chatThreadScroll.scrollTop) || 0;
      const targetScrollTop = getLiveFollowTargetScrollTop();
      if (liveFollowRuntime.active) {
        clampProgrammaticScrollTop(targetScrollTop);
        const priorProgrammaticScrollTop = liveFollowRuntime.lastProgrammaticScrollTop || 0;
        /* Already following: if the user has scrolled up past the override
           tolerance since the animator's last known position, this is a
           genuine scroll-away, not the animator's own trailing lag. Release
           follow instead of re-anchoring/stepping - otherwise the synchronous
           stepLiveStreamingFollow() call below would drag the viewport back
           toward the bottom on this very call, and then overwrite
           lastProgrammaticScrollTop from that just-moved position, closing
           the gap the tolerance check relies on to detect the scroll-away. */
        if (
          hasRecentUserScrollIntent()
          && currentScrollTop < priorProgrammaticScrollTop - LIVE_FOLLOW_USER_OVERRIDE_PX
        ) {
          releaseFollowForUserScrollAway();
          return;
        }
        // Otherwise, never regress the baseline upward toward the user's
        // current position - only allow it to advance downward.
        advanceProgrammaticScrollTop(currentScrollTop);
      } else {
        if (
          hasRecentUserScrollIntent()
          && currentScrollTop < targetScrollTop - LIVE_FOLLOW_USER_OVERRIDE_PX
        ) {
          releaseFollowForUserScrollAway();
          return;
        }
        liveFollowRuntime.lastProgrammaticScrollTop = currentScrollTop;
      }
      liveFollowRuntime.active = true;
      liveFollowRuntime.targetScrollTop = targetScrollTop;
      stepLiveStreamingFollow();
    }

    function snapThreadToBottom({ behavior = 'auto' } = {}) {
      if (!chatThreadScroll) {
        return;
      }
      cancelLiveStreamingFollow();
      const sentinel = chatThreadScroll.querySelector('.chat-thread-scroll-sentinel');
      if (sentinel) {
        noteProgrammaticWrite?.('live_follow');
        sentinel.scrollIntoView({ behavior, block: 'end', inline: 'nearest' });
        return;
      }
      const targetScrollTop = getLiveFollowTargetScrollTop();
      if (behavior && behavior !== 'auto') {
        noteProgrammaticWrite?.('live_follow');
        chatThreadScroll.scrollTo({
          top: targetScrollTop,
          behavior,
        });
        return;
      }
      noteProgrammaticWrite?.('live_follow');
      chatThreadScroll.scrollTop = targetScrollTop;
    }

    return {
      liveFollowRuntime,
      noteUserScrollIntent,
      clampProgrammaticScrollTop,
      getLiveFollowTargetScrollTop,
      cancelLiveStreamingFollow,
      startLiveStreamingFollow,
      snapThreadToBottom,
    };
  }

  return {
    LIVE_FOLLOW_USER_OVERRIDE_PX,
    createViewportLiveFollowUtils,
  };
});
