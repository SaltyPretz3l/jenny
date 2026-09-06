/* renderer/chat/renderer-chat-scroll-coordinator.js
 * Sole native-scroll owner for the chat timeline. Coalesces input bursts,
 * classifies reader intent, maintains a detached-reader logical anchor, and
 * dispatches one immutable ScrollFrameSnapshot to scroll consumers per frame.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./chat-scroll-utils'));
    return;
  }
  root.rendererChatScrollCoordinator = factory(root.chatScrollUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scrollUtils) {
  'use strict';

  var FOLLOW_THRESHOLD = Number(scrollUtils.DEFAULT_SCROLL_FOLLOW_THRESHOLD) || 48;
  var USER_INTENT_WINDOW_MS = 180;
  var PROGRAMMATIC_MARKER_TTL_MS = 1000;
  var SLOW_FRAME_MS = 50;
  var DIAGNOSTIC_INTERVAL_MS = 5000;
  var TELEMETRY_INTERVAL_MS = 1000;
  var UNATTRIBUTED_JUMP_PX = 120;
  var MAX_TELEMETRY_ROW_KINDS = 12;
  var SCROLL_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar',
  ]);
  var DISPOSED_SNAPSHOT = Object.freeze({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    bottomDistance: 0,
    nearBottom: true,
    direction: 'none',
    userInitiated: false,
    programmaticReason: null,
    timestamp: 0,
  });

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function now(win) {
    var performanceRef = win && win.performance;
    return performanceRef && typeof performanceRef.now === 'function'
      ? performanceRef.now()
      : Date.now();
  }

  function consumesScrollKey(target) {
    if (!target) return false;
    var tagName = String(target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select', 'button', 'a', 'summary'].includes(tagName)) return true;
    if (target.isContentEditable === true) return true;
    return Boolean(target.closest && target.closest(
      'input, textarea, select, button, a, summary, [contenteditable="true"], [contenteditable=""]'
    ));
  }

  function createChatScrollCoordinator(deps) {
    var options = deps || {};
    var state = options.state || { ui: {} };
    if (!state.ui || typeof state.ui !== 'object') state.ui = {};
    var scrollContainer = options.scrollContainer || null;
    var timelineContainer = options.timelineContainer || scrollContainer;
    var win = options.window || (typeof window !== 'undefined' ? window : globalThis);
    var requestFrame = typeof options.requestFrame === 'function'
      ? options.requestFrame
      : function fallbackRequestFrame(callback) {
        if (win && typeof win.requestAnimationFrame === 'function') return win.requestAnimationFrame(callback);
        if (win && typeof win.setTimeout === 'function') {
          return win.setTimeout(function runFallbackFrame() { callback(now(win)); }, 16);
        }
        callback(now(win));
        return 0;
      };
    var cancelFrame = typeof options.cancelFrame === 'function'
      ? options.cancelFrame
      : function fallbackCancelFrame(handle) {
        if (win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(handle);
        else if (win && typeof win.clearTimeout === 'function') win.clearTimeout(handle);
      };
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    var isStreaming = typeof options.isStreaming === 'function' ? options.isStreaming : null;
    var renderJumpControls = typeof options.renderJumpControls === 'function'
      ? options.renderJumpControls
      : function noopRenderJumpControls() {};
    var contentGeneration = 0;
    var contentMutationObserver = null;
    var hasContentMutationObserver = false;
    var anchorRegistry = typeof scrollUtils.createLogicalScrollAnchorRegistry === 'function'
      ? scrollUtils.createLogicalScrollAnchorRegistry({
          cap: 2,
          threshold: FOLLOW_THRESHOLD,
          preferEntries: true,
          getContentGeneration: function getContentGeneration() { return contentGeneration; },
        })
      : null;

    var viewportController = null;
    var pinController = null;
    var unreadController = null;
    var wayfinderController = null;
    var timelineVirtualizer = null;
    var frameHandle = 0;
    var attached = false;
    var disposed = false;
    var pointerActive = false;
    var touchActive = false;
    var pendingUserIntent = false;
    var userIntentUntil = 0;
    var pendingProgrammaticReason = null;
    var programmaticMarkerArmedAt = 0;
    var lastScrollTop = finiteNumber(scrollContainer && scrollContainer.scrollTop, 0);
    var lastSnapshot = null;
    var detachListeners = [];
    var lastDiagnosticAt = -Infinity;
    var lastTelemetryAtByEvent = new Map();
    var lastAttributedMoveReason = null;
    var lastAttributedFrameAt = 0;
    var lastFrameContentGeneration = 0;
    var frameDurationSamples = [];
    var durationSortScratch = [];
    var p95DurationDirty = false;
    var stats = {
      frames: 0,
      scrollEvents: 0,
      inputEvents: 0,
      coalescedEvents: 0,
      userFrames: 0,
      malformedMetrics: 0,
      lastFrameDurationMs: 0,
      maxFrameDurationMs: 0,
      p95FrameDurationMs: 0,
      listenerCount: 0,
      pendingFrame: false,
      disposed: false,
    };
    var publishedStats = {};

    if (win && typeof win.MutationObserver === 'function' && timelineContainer) {
      try {
        contentMutationObserver = new win.MutationObserver(function handleTimelineMutation() {
          contentGeneration += 1;
        });
        contentMutationObserver.observe(timelineContainer, { childList: true, subtree: true });
        hasContentMutationObserver = true;
      } catch (_error) {
        try { contentMutationObserver?.disconnect?.(); } catch (_disconnectError) { /* best-effort */ }
        contentMutationObserver = null;
      }
    }

    function logRateLimited(eventName, details) {
      var timestamp = now(win);
      if (timestamp - lastDiagnosticAt < DIAGNOSTIC_INTERVAL_MS) return;
      lastDiagnosticAt = timestamp;
      try { appendClientLog('WARN', eventName, details || {}); } catch (_error) { /* best-effort */ }
    }

    function logTelemetry(level, eventName, details) {
      var timestamp = now(win);
      var lastTimestamp = lastTelemetryAtByEvent.get(eventName);
      if (lastTimestamp !== undefined && timestamp - lastTimestamp < TELEMETRY_INTERVAL_MS) return;
      lastTelemetryAtByEvent.set(eventName, timestamp);
      try { appendClientLog(level, eventName, details || {}); } catch (_error) { /* best-effort */ }
    }

    function readStreamingState() {
      try { return isStreaming ? isStreaming() === true : false; } catch (_error) { return false; }
    }

    function readViewportRowKinds() {
      if (!timelineContainer?.querySelectorAll || !scrollContainer?.getBoundingClientRect) return [];
      var viewportRect;
      var rows;
      try {
        viewportRect = scrollContainer.getBoundingClientRect();
        rows = timelineContainer.querySelectorAll('.chat-row[data-row-kind]');
      } catch (_error) {
        return [];
      }
      var kinds = [];
      var seen = new Set();
      for (var index = 0; index < rows.length && index < 200 && kinds.length < MAX_TELEMETRY_ROW_KINDS; index += 1) {
        var row = rows[index];
        var rect;
        try { rect = row?.getBoundingClientRect?.(); } catch (_error2) { rect = null; }
        if (!rect || rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) continue;
        var kind = String(row?.getAttribute?.('data-row-kind') || '').trim();
        if (!kind || seen.has(kind)) continue;
        seen.add(kind);
        kinds.push(kind);
      }
      return kinds;
    }

    function buildFrameTelemetryDetails(snapshot, context) {
      var details = context || {};
      var delta = finiteNumber(details.delta, 0);
      return {
        sessionId: String(state.currentSessionId || ''),
        jumpPx: Math.abs(delta),
        direction: snapshot.direction,
        followLatest: details.followLatest === true,
        reason: String(details.reason || 'marker_absent'),
        rowKinds: readViewportRowKinds(),
        frameDurationMs: Math.round(finiteNumber(details.duration, 0) * 100) / 100,
        renderedInFrame: details.renderedInFrame === true,
        caseTag: details.followLatest === true ? 'following_bottom' : 'scrolling_away',
      };
    }

    function publishStats(snapshot) {
      if (p95DurationDirty) {
        durationSortScratch.length = 0;
        for (var index = 0; index < frameDurationSamples.length; index += 1) {
          durationSortScratch.push(frameDurationSamples[index]);
        }
        durationSortScratch.sort(function sortDurations(left, right) { return left - right; });
        stats.p95FrameDurationMs = durationSortScratch[
          Math.max(0, Math.ceil(durationSortScratch.length * 0.95) - 1)
        ] || 0;
        p95DurationDirty = false;
      }
      publishedStats.frames = stats.frames;
      publishedStats.scrollEvents = stats.scrollEvents;
      publishedStats.inputEvents = stats.inputEvents;
      publishedStats.coalescedEvents = stats.coalescedEvents;
      publishedStats.userFrames = stats.userFrames;
      publishedStats.malformedMetrics = stats.malformedMetrics;
      publishedStats.lastFrameDurationMs = Math.round(stats.lastFrameDurationMs * 100) / 100;
      publishedStats.maxFrameDurationMs = Math.round(stats.maxFrameDurationMs * 100) / 100;
      publishedStats.p95FrameDurationMs = Math.round(stats.p95FrameDurationMs * 100) / 100;
      publishedStats.listenerCount = stats.listenerCount;
      publishedStats.pendingFrame = stats.pendingFrame;
      publishedStats.disposed = stats.disposed;
      publishedStats.nearBottom = snapshot ? snapshot.nearBottom === true : false;
      publishedStats.bottomDistance = snapshot ? Math.round(snapshot.bottomDistance) : 0;
      publishedStats.direction = snapshot ? snapshot.direction : 'none';
      state.ui.timelineScrollStats = publishedStats;
    }

    // Smooth-write invariant (spec 1b item 2, binding): every write that must
    // KEEP follow latched (anchor restores, clamp compensation) is an instant
    // scrollTop assignment consumed by one frame. All smooth multi-frame writes
    // today are navigation jumps that set followLatest:false, so the guard is
    // inert for their tail frames. Any FUTURE smooth programmatic write that
    // keeps follow latched must renew this marker per animation frame.
    function armProgrammaticMarker(reason) {
      pendingProgrammaticReason = String(reason || '').trim() || 'message_jump';
      programmaticMarkerArmedAt = now(win);
    }

    function readSnapshot(timestamp) {
      var rawTop = Number(scrollContainer && scrollContainer.scrollTop);
      var rawHeight = Number(scrollContainer && scrollContainer.scrollHeight);
      var rawClient = Number(scrollContainer && scrollContainer.clientHeight);
      if (!Number.isFinite(rawTop) || !Number.isFinite(rawHeight) || !Number.isFinite(rawClient)) {
        stats.malformedMetrics += 1;
        logRateLimited('chat.scroll_metrics_malformed', {
          invalidCount: stats.malformedMetrics,
        });
      }
      var scrollTop = Math.max(0, finiteNumber(rawTop, 0));
      var scrollHeight = Math.max(0, finiteNumber(rawHeight, 0));
      var clientHeight = Math.max(0, finiteNumber(rawClient, 0));
      var bottomDistance = Math.max(0, scrollHeight - (scrollTop + clientHeight));
      var direction = scrollTop > lastScrollTop ? 'down' : scrollTop < lastScrollTop ? 'up' : 'none';
      var intentIsFresh = userIntentUntil > 0 && timestamp <= userIntentUntil;
      var userInitiated = (pendingUserIntent && intentIsFresh)
        || pointerActive || touchActive || intentIsFresh;
      return Object.freeze({
        scrollTop: scrollTop,
        scrollHeight: scrollHeight,
        clientHeight: clientHeight,
        bottomDistance: bottomDistance,
        nearBottom: bottomDistance <= FOLLOW_THRESHOLD,
        direction: direction,
        userInitiated: userInitiated,
        programmaticReason: pendingProgrammaticReason
          && timestamp - programmaticMarkerArmedAt <= PROGRAMMATIC_MARKER_TTL_MS
          ? pendingProgrammaticReason
          : null,
        timestamp: timestamp,
      });
    }

    function safeDispatch(target, method, snapshot, eventName) {
      if (!target || typeof target[method] !== 'function') return;
      try {
        target[method](snapshot);
      } catch (_error) {
        logRateLimited('chat.scroll_consumer_failed', { consumer: eventName });
      }
    }

    function captureReaderAnchor(snapshot) {
      if (disposed || !anchorRegistry || !scrollContainer) return false;
      var current = snapshot || readSnapshot(now(win));
      if (current.nearBottom || state.ui.followLatest !== false) {
        anchorRegistry.clear('reader');
        return false;
      }
      return anchorRegistry.capture('reader', scrollContainer, timelineContainer || scrollContainer);
    }

    function restoreReaderAnchor() {
      if (disposed || !anchorRegistry || !scrollContainer || state.ui.followLatest !== false) return 'skipped';
      var outcome = anchorRegistry.restore('reader', scrollContainer, timelineContainer || scrollContainer);
      if (!['skipped', 'unavailable', 'missing'].includes(outcome)) {
        armProgrammaticMarker('anchor_restore');
      }
      return outcome;
    }

    function runFrame(timestamp) {
      if (disposed) return null;
      if (!hasContentMutationObserver) contentGeneration += 1;
      frameHandle = 0;
      stats.pendingFrame = false;
      var startedAt = now(win);
      var followLatestAtFrameStart = state.ui.followLatest !== false;
      var frameContentGeneration = contentGeneration;
      var renderedInFrame = hasContentMutationObserver
        && frameContentGeneration !== lastFrameContentGeneration;
      var snapshot = readSnapshot(finiteNumber(timestamp, startedAt));
      var fromTop = lastScrollTop;
      var delta = snapshot.scrollTop - fromTop;
      var attributionReason = snapshot.programmaticReason || 'marker_absent';
      var pendingTelemetry = null;
      if (delta !== 0) {
        // Consumption-based lifetime (spec 1b item 1): the marker is cleared by
        // the frame that consumes it — i.e. the frame that observes the write's
        // movement. A delta==0 frame (intent event, mutation-generation bump)
        // consumed nothing and must leave the marker for the movement frame;
        // the TTL check in readSnapshot stays the stuck-marker backstop.
        pendingProgrammaticReason = null;
        programmaticMarkerArmedAt = 0;
      }
      if (delta !== 0 && snapshot.programmaticReason) {
        var reason = snapshot.programmaticReason;
        if (reason !== 'live_follow' || lastAttributedMoveReason !== 'live_follow') {
          pendingTelemetry = {
            level: 'INFO',
            event: 'chat.scroll_move',
            details: {
              fromTop: fromTop,
              toTop: snapshot.scrollTop,
              delta: delta,
              streaming: readStreamingState(),
            },
          };
        }
        lastAttributedMoveReason = reason;
        lastAttributedFrameAt = startedAt;
      } else if (delta !== 0) {
        lastAttributedMoveReason = null;
        // A smooth programmatic reveal animates across many frames but the
        // marker is consumed by the first one; frames inside the marker-TTL
        // window after an attributed move are its settlement, not a mystery
        // jump, so the WARN stands down there (codex pre-land finding).
        var insideProgrammaticEcho = lastAttributedFrameAt > 0
          && (startedAt - lastAttributedFrameAt) <= PROGRAMMATIC_MARKER_TTL_MS;
        if (!snapshot.userInitiated && !insideProgrammaticEcho && Math.abs(delta) >= UNATTRIBUTED_JUMP_PX) {
          pendingTelemetry = {
            level: 'WARN',
            event: 'chat.scroll_jump_unattributed',
            details: {
              fromTop: fromTop,
              toTop: snapshot.scrollTop,
              delta: delta,
              scrollHeight: snapshot.scrollHeight,
              clientHeight: snapshot.clientHeight,
              streaming: readStreamingState(),
            },
          };
        }
      }
      if (snapshot.userInitiated) lastAttributedMoveReason = null;
      lastScrollTop = snapshot.scrollTop;
      lastSnapshot = snapshot;
      stats.frames += 1;
      if (snapshot.userInitiated) stats.userFrames += 1;

      safeDispatch(viewportController, 'syncThreadScrollState', snapshot, 'viewport');
      safeDispatch(unreadController, 'handleScroll', snapshot, 'unread');
      safeDispatch(pinController, 'handleScrollFrame', snapshot, 'pin');
      safeDispatch(wayfinderController, 'handleScroll', snapshot, 'wayfinder');
      try { renderJumpControls(snapshot); } catch (_error) {
        logRateLimited('chat.scroll_consumer_failed', { consumer: 'jump_controls' });
      }

      if (snapshot.nearBottom) anchorRegistry?.clear?.('reader');
      else captureReaderAnchor(snapshot);
      pendingUserIntent = false;
      var duration = Math.max(0, now(win) - startedAt);
      lastFrameContentGeneration = frameContentGeneration;
      stats.lastFrameDurationMs = duration;
      stats.maxFrameDurationMs = Math.max(stats.maxFrameDurationMs, duration);
      frameDurationSamples.push(duration);
      if (frameDurationSamples.length > 120) frameDurationSamples.shift();
      p95DurationDirty = true;
      var telemetryDetails = null;
      var emissionAt = now(win);
      var telemetryAllowed = pendingTelemetry && (lastTelemetryAtByEvent.get(pendingTelemetry.event) === undefined
        || emissionAt - lastTelemetryAtByEvent.get(pendingTelemetry.event) >= TELEMETRY_INTERVAL_MS);
      var diagnosticAllowed = duration > SLOW_FRAME_MS && emissionAt - lastDiagnosticAt >= DIAGNOSTIC_INTERVAL_MS;
      if (telemetryAllowed || diagnosticAllowed) {
        telemetryDetails = buildFrameTelemetryDetails(snapshot, {
          delta: delta,
          duration: duration,
          followLatest: followLatestAtFrameStart,
          reason: attributionReason,
          renderedInFrame: renderedInFrame,
        });
      }
      if (telemetryAllowed) {
        logTelemetry(pendingTelemetry.level, pendingTelemetry.event, {
          ...pendingTelemetry.details,
          ...telemetryDetails,
        });
      }
      if (diagnosticAllowed) {
        logRateLimited('chat.scroll_frame_slow', {
          durationMs: Math.round(duration),
          frameCount: stats.frames,
          ...(telemetryDetails || {}),
        });
      }
      publishStats(snapshot);
      return snapshot;
    }

    function scheduleFrame() {
      if (disposed || frameHandle) {
        if (frameHandle) stats.coalescedEvents += 1;
        return false;
      }
      frameHandle = requestFrame(runFrame);
      stats.pendingFrame = Boolean(frameHandle);
      publishStats(lastSnapshot);
      return Boolean(frameHandle);
    }

    function markUserIntent(source, event) {
      if (disposed) return;
      if (event && event.ctrlKey && source === 'wheel') return;
      pendingUserIntent = true;
      userIntentUntil = now(win) + USER_INTENT_WINDOW_MS;
      stats.inputEvents += 1;
      try { viewportController?.noteScrollInputIntent?.(); } catch (_error) {
        logRateLimited('chat.scroll_consumer_failed', { consumer: 'viewport_intent' });
      }
      scheduleFrame();
    }

    function handleNativeScroll() {
      if (disposed) return;
      stats.scrollEvents += 1;
      scheduleFrame();
    }

    function handleWheel(event) { markUserIntent('wheel', event); }
    function handlePointerDown(event) {
      if (event && event.isPrimary === false) return;
      var pointerType = String(event && event.pointerType || '').toLowerCase();
      // Mouse clicks on transcript controls are not scroll intent. Native
      // scrollbar drags target the scrolling element itself; touch scrolling
      // is also covered when browsers emit pointer events for the gesture.
      if (event?.target !== scrollContainer && pointerType !== 'touch') return;
      pointerActive = true;
      markUserIntent('pointer', event);
    }
    function handlePointerMove(event) {
      if (pointerActive) markUserIntent('pointer', event);
    }
    function handlePointerEnd() {
      pointerActive = false;
    }
    function handleTouchStart(event) {
      touchActive = true;
      markUserIntent('touch', event);
    }
    function handleTouchMove(event) {
      if (touchActive) markUserIntent('touch', event);
    }
    function handleTouchEnd() { touchActive = false; }
    function isChatSurfaceActive() {
      var live = globalThis.rendererChatSurfaceLiveUtils?.isChatSurfaceLive?.(state);
      return live ?? (!state.ui?.activeView || state.ui.activeView === 'chat');
    }
    function handleKeydown(event) {
      if (
        !event
        || event.defaultPrevented
        || !isChatSurfaceActive()
        || !SCROLL_KEYS.has(String(event.key || ''))
        || consumesScrollKey(event.target)
      ) return;
      markUserIntent('keyboard', event);
    }

    function registerManaged(registerListener, target, eventName, handler, listenerOptions) {
      if (!target) return;
      if (typeof registerListener === 'function') {
        registerListener(target, eventName, handler, listenerOptions);
        if (typeof target.removeEventListener === 'function') {
          detachListeners.push(function detachExternallyManagedListener() {
            target.removeEventListener(eventName, handler, listenerOptions);
          });
        }
        stats.listenerCount += 1;
        return;
      }
      if (typeof target.addEventListener !== 'function') return;
      target.addEventListener(eventName, handler, listenerOptions);
      detachListeners.push(function detachManagedListener() {
        target.removeEventListener(eventName, handler, listenerOptions);
      });
      stats.listenerCount += 1;
    }

    function detachAttachedListeners() {
      while (detachListeners.length) {
        try { detachListeners.pop()(); } catch (_error) { /* best-effort */ }
      }
      attached = false;
      stats.listenerCount = 0;
    }

    function attach(config) {
      if (disposed || attached || !scrollContainer) return function noopDetach() {};
      attached = true;
      var settings = config || {};
      var registerListener = settings.registerListener;
      var listenerOptions = settings.listenerOptions;
      var passiveOptions = settings.passiveListenerOptions
        || Object.assign({}, listenerOptions && typeof listenerOptions === 'object' ? listenerOptions : {}, {
          passive: true,
        });
      registerManaged(registerListener, scrollContainer, 'scroll', handleNativeScroll, passiveOptions);
      registerManaged(registerListener, scrollContainer, 'wheel', handleWheel, passiveOptions);
      registerManaged(registerListener, scrollContainer, 'pointerdown', handlePointerDown, passiveOptions);
      registerManaged(registerListener, scrollContainer, 'pointermove', handlePointerMove, passiveOptions);
      var pointerEndTarget = win && typeof win.addEventListener === 'function'
        ? win
        : (scrollContainer.ownerDocument || scrollContainer);
      registerManaged(registerListener, pointerEndTarget, 'pointerup', handlePointerEnd, passiveOptions);
      registerManaged(registerListener, pointerEndTarget, 'pointercancel', handlePointerEnd, passiveOptions);
      registerManaged(registerListener, scrollContainer, 'touchstart', handleTouchStart, passiveOptions);
      registerManaged(registerListener, scrollContainer, 'touchmove', handleTouchMove, passiveOptions);
      registerManaged(registerListener, scrollContainer, 'touchend', handleTouchEnd, passiveOptions);
      registerManaged(registerListener, scrollContainer, 'touchcancel', handleTouchEnd, passiveOptions);
      var keyTarget = win && typeof win.addEventListener === 'function' ? win : scrollContainer;
      registerManaged(registerListener, keyTarget, 'keydown', handleKeydown, listenerOptions);
      scheduleFrame();
      return function detachCoordinator() {
        // Event-utils owns signal-backed listener teardown. Direct listeners
        // are removed here so an isolated coordinator can be rebound safely.
        detachAttachedListeners();
      };
    }

    function noteExplicitNavigation(options) {
      if (disposed) return;
      var settings = options || {};
      armProgrammaticMarker(settings.reason);
      pendingUserIntent = false;
      userIntentUntil = 0;
      if (settings.followLatest === true) anchorRegistry?.clear?.('reader');
      else captureReaderAnchor();
    }

    function noteProgrammaticWrite(reason) {
      if (disposed) return;
      armProgrammaticMarker(reason);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      attached = false;
      pointerActive = false;
      touchActive = false;
      pendingUserIntent = false;
      userIntentUntil = 0;
      pendingProgrammaticReason = null;
      programmaticMarkerArmedAt = 0;
      lastTelemetryAtByEvent.clear();
      lastAttributedMoveReason = null;
      lastAttributedFrameAt = 0;
      lastFrameContentGeneration = 0;
      if (frameHandle) cancelFrame(frameHandle);
      frameHandle = 0;
      detachAttachedListeners();
      try { contentMutationObserver?.disconnect?.(); } catch (_error) { /* best-effort */ }
      contentMutationObserver = null;
      anchorRegistry?.dispose?.();
      viewportController = null;
      pinController = null;
      unreadController = null;
      wayfinderController = null;
      timelineVirtualizer = null;
      lastSnapshot = null;
      frameDurationSamples.length = 0;
      durationSortScratch.length = 0;
      p95DurationDirty = false;
      stats.listenerCount = 0;
      stats.pendingFrame = false;
      stats.disposed = true;
      publishStats(null);
    }

    return {
      attach: attach,
      captureReaderAnchor: captureReaderAnchor,
      dispose: dispose,
      handleNativeScroll: handleNativeScroll,
      markUserIntent: markUserIntent,
      noteExplicitNavigation: noteExplicitNavigation,
      noteProgrammaticWrite: noteProgrammaticWrite,
      readSnapshot: function readPublicSnapshot() {
        return disposed ? DISPOSED_SNAPSHOT : readSnapshot(now(win));
      },
      restoreReaderAnchor: restoreReaderAnchor,
      scheduleFrame: scheduleFrame,
      setPinController: function setPinController(next) { if (!disposed) pinController = next || null; },
      setTimelineVirtualizer: function setTimelineVirtualizer(next) {
        if (disposed) return;
        timelineVirtualizer = next || null;
        viewportController?.setTimelineVirtualizer?.(timelineVirtualizer);
      },
      setUnreadController: function setUnreadController(next) { if (!disposed) unreadController = next || null; },
      setViewportController: function setViewportController(next) {
        if (disposed) return;
        viewportController = next || null;
        viewportController?.setTimelineVirtualizer?.(timelineVirtualizer);
      },
      setWayfinderController: function setWayfinderController(next) { if (!disposed) wayfinderController = next || null; },
      getStats: function getStats() { return Object.assign({}, stats); },
      _internals: {
        runFrame: runFrame,
        isAttached: function isAttached() { return attached; },
        isDisposed: function isDisposed() { return disposed; },
      },
    };
  }

  return {
    FOLLOW_THRESHOLD: FOLLOW_THRESHOLD,
    createChatScrollCoordinator: createChatScrollCoordinator,
  };
});
