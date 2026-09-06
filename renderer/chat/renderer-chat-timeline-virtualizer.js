/* renderer/chat/renderer-chat-timeline-virtualizer.js
 * Long-thread strategy controller. JS DOM-windowing, CSS content visibility,
 * and fully mounted rendering are mutually exclusive.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-chat-keyboard-utils'),
      require('./renderer-chat-timeline-virtualizer-entry-store')
    );
    return;
  }
  root.rendererChatTimelineVirtualizer = factory(
    root.rendererChatKeyboardUtils,
    root.rendererChatTimelineVirtualizerEntryStore
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (keyboardUtils, entryStoreUtils) {
  'use strict';

  var longThreadBudget = (typeof globalThis !== 'undefined' && globalThis.rendererRenderPipelineProjectionCacheUtils)
    || (typeof require === 'function' ? require('./renderer-render-pipeline-projection-cache') : null)
    || {};
  var LONG_THREAD_BUDGETS = longThreadBudget.BUDGETS || {
    virtualizedMarkupEntries: 160,
    targetMaterializedArticles: 160,
  };
  var getChatEntries = keyboardUtils && typeof keyboardUtils.getChatEntries === 'function'
    ? keyboardUtils.getChatEntries
    : function fallbackGetChatEntries(timeline) {
      return timeline?.querySelectorAll ? Array.from(timeline.querySelectorAll('.chat-entry')) : [];
    };

  var VIRT_THRESHOLD = 80;
  var DEFAULT_ROOT_MARGIN = '2000px 0px';
  var MAX_UNMOUNTS_PER_FRAME = 64;
  var MAX_UNMOUNT_WORK_MS = 8;
  // The count cap protects clocks that do not advance during a work chunk.
  var MAX_INTERSECTION_LEAVES_PER_FRAME = 8192;
  var MAX_INTERSECTION_WORK_MS = 8;
  var MAX_SYNC_INTERSECTION_RECORDS = 256;
  var SLOW_CALLBACK_MS = 50;
  var DIAGNOSTIC_INTERVAL_MS = 5000;
  var STRATEGY_DOM_WINDOW = 'dom-window';
  var STRATEGY_CONTENT_VISIBILITY = 'content-visibility';
  var STRATEGY_NONE = 'none';

  function createTimelineVirtualizer(deps) {
    var options = deps || {};
    var chatTimeline = options.chatTimeline || null;
    var chatThreadScroll = options.chatThreadScroll || null;
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (doc && doc.defaultView) || (typeof globalThis !== 'undefined' ? globalThis : null);
    var getActiveTurnRootMessageId = typeof options.getActiveTurnRootMessageId === 'function'
      ? options.getActiveTurnRootMessageId
      : function emptyActiveRoot() { return ''; };
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    var onStatsChange = typeof options.onStatsChange === 'function' ? options.onStatsChange : null;
    var captureReaderAnchor = typeof options.captureReaderAnchor === 'function'
      ? options.captureReaderAnchor
      : function noopCaptureReaderAnchor() {};
    var noteProgrammaticWrite = typeof options.noteProgrammaticWrite === 'function'
      ? options.noteProgrammaticWrite
      : null;
    var restoreReaderAnchor = typeof options.restoreReaderAnchor === 'function'
      ? options.restoreReaderAnchor
      : function noopRestoreReaderAnchor() {};
    var requestCanonicalRerender = typeof options.requestCanonicalRerender === 'function'
      ? options.requestCanonicalRerender
      : null;
    var boundsEnabled = options.boundsEnabled !== false;
    var contentVisibilityEnabled = options.contentVisibilityEnabled === true;
    var threshold = Number.isFinite(Number(options.threshold))
      ? Math.max(0, Number(options.threshold))
      : VIRT_THRESHOLD;
    var configuredRootMargin = typeof options.rootMargin === 'string' && options.rootMargin
      ? options.rootMargin
      : '';

    var observedEntries = new Set();
    var visibilityByEntry = new WeakMap();
    var pendingIntersectionBatches = [];
    var pendingIntersectionRecordCount = 0;
    var intersectionSequence = 0;
    var latestIntersectionEnterByEntry = new WeakMap();
    var unmountQueue = new Map();
    var observer = null;
    var observerRootMargin = '';
    var observerFallbackReason = '';
    var observerGeneration = 0;
    var unmountFrame = 0;
    var intersectionFrame = 0;
    var resizeTimer = null;
    var resizeObserver = null;
    var layoutAxisObserver = null;
    var layoutEpoch = 0;
    var layoutWidth = 0;
    var measuredDensityEpoch = -1;
    var measuredAverageHeight = 0;
    var strategy = STRATEGY_NONE;
    var fallbackReason = '';
    var disposed = false;
    var canonicalRerenderFrame = 0;
    var layoutSignature = '';
    var lastDiagnosticAtByEvent = new Map();
    var stats = {
      articles: 0,
      observerFallbacks: 0,
      observeFailures: 0,
      materializedHighWater: 0,
      queueDepth: 0,
      lastCallbackDurationMs: 0,
      maxCallbackDurationMs: 0,
      lastBatchRecords: 0,
      pinnedExemptions: { streaming: 0, activeRoot: 0, focused: 0, approval: 0, liveState: 0, fallback: 0 },
      statefulPinnedEntries: 0,
    };

    function now() {
      return win?.performance?.now ? win.performance.now() : Date.now();
    }

    function logRateLimited(level, eventName, details) {
      var timestamp = now();
      var lastTimestamp = lastDiagnosticAtByEvent.get(eventName);
      if (lastTimestamp !== undefined && timestamp - lastTimestamp < DIAGNOSTIC_INTERVAL_MS) return;
      lastDiagnosticAtByEvent.set(eventName, timestamp);
      try { appendClientLog(level, eventName, details || {}); } catch (_error) { /* best-effort */ }
    }

    function getEntries() {
      return getChatEntries(chatTimeline);
    }

    function getLayoutWidth() {
      var direct = Number(chatThreadScroll?.clientWidth) || Number(chatTimeline?.clientWidth) || 0;
      if (direct > 0) return direct;
      try {
        return Math.max(0, Number((chatThreadScroll || chatTimeline)?.getBoundingClientRect?.().width) || 0);
      } catch (_error) {
        return 0;
      }
    }

    function getLayout() {
      return { epoch: layoutEpoch, width: layoutWidth || getLayoutWidth() };
    }

    function setStrategy(nextStrategy, reason) {
      var normalized = nextStrategy || STRATEGY_NONE;
      var changed = strategy !== normalized || fallbackReason !== String(reason || '');
      strategy = normalized;
      fallbackReason = String(reason || '');
      chatTimeline?.setAttribute?.('data-timeline-render-strategy', strategy);
      if (changed) {
        try {
          appendClientLog('INFO', 'chat.timeline_virtualizer_strategy', {
            strategy: strategy,
            reason: fallbackReason || 'selected',
            articleCount: stats.articles,
            threshold: threshold,
          });
        } catch (_error) { /* best-effort */ }
      }
    }

    function getPinReason(entryEl) {
      if (!entryEl) return 'invalid';
      if (entryEl.getAttribute?.('data-virtualizer-fallback') === 'true') return 'fallback';
      if (entryEl.querySelector?.('.chat-bubble-streaming')) return 'streaming';
      var activeRootId = String(getActiveTurnRootMessageId() || '').trim();
      if (activeRootId) {
        var rootEl = entryEl.closest?.('.chat-thread-root');
        if (rootEl?.getAttribute?.('data-thread-message-id') === activeRootId) return 'activeRoot';
      }
      var activeEl = doc && doc.activeElement;
      if (activeEl && (activeEl === entryEl || entryEl.contains?.(activeEl))) return 'focused';
      if (entryEl.querySelector?.(
        '.approval-gap-row, .tool-approval-block, [data-approval-id], [data-approval-state="pending"]'
      )) return 'approval';
      if (entryStore?.hasLiveState?.(entryEl)) return 'liveState';
      return '';
    }

    function isPinned(entryEl) {
      return Boolean(getPinReason(entryEl));
    }

    function measureHeight(entryEl) {
      if (!entryEl || typeof entryEl.getBoundingClientRect !== 'function') return 0;
      try {
        var height = Math.max(0, Number(entryEl.getBoundingClientRect().height) || 0);
        return Math.round(height * 1000) / 1000;
      }
      catch (_error) { return 0; }
    }

    function scheduleCanonicalRerender() {
      if (disposed || canonicalRerenderFrame || !requestCanonicalRerender) return;
      var requestFrame = win && typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : null;
      if (!requestFrame) {
        try { requestCanonicalRerender(); }
        catch (_error) {
          logRateLimited('WARN', 'chat.timeline_virtualizer_rerender_failed', { phase: 'immediate' });
        }
        finally { entryStore?.acknowledgeCanonicalRerender?.(); }
        return;
      }
      canonicalRerenderFrame = requestFrame(function runCanonicalRerender() {
        canonicalRerenderFrame = 0;
        if (!disposed) {
          try { requestCanonicalRerender(); }
          catch (_error) {
            logRateLimited('WARN', 'chat.timeline_virtualizer_rerender_failed', { phase: 'scheduled' });
          }
          finally { entryStore?.acknowledgeCanonicalRerender?.(); }
        }
      });
    }

    var entryStore = entryStoreUtils?.createTimelineVirtualizerEntryStore?.({
      chatTimeline: chatTimeline,
      document: doc,
      boundsEnabled: boundsEnabled,
      budgets: LONG_THREAD_BUDGETS,
      requestEntryMarkup: options.requestEntryMarkup,
      requestCanonicalRerender: scheduleCanonicalRerender,
      onAfterMount: options.onAfterMount,
      appendClientLog: appendClientLog,
    });
    if (!entryStore) throw new Error('timeline virtualizer entry store is unavailable');

    function getCurrentBudgetStats() {
      var storeStats = entryStore.getStats();
      var materialized = Math.max(0, stats.articles - storeStats.virtualizedEntries);
      var uniquePinnedCount = Object.values(stats.pinnedExemptions)
        .reduce(function sum(total, value) { return total + value; }, 0);
      var nonStatefulPinnedCount = uniquePinnedCount - stats.pinnedExemptions.liveState;
      var statefulOverflow = Math.min(
        stats.pinnedExemptions.liveState,
        Math.max(0, materialized - LONG_THREAD_BUDGETS.targetMaterializedArticles - nonStatefulPinnedCount)
      );
      stats.materializedHighWater = Math.max(stats.materializedHighWater, materialized);
      return {
        enabled: boundsEnabled,
        strategy: strategy,
        fallbackReason: fallbackReason,
        articles: stats.articles,
        materializedArticles: materialized,
        normalMaterializedArticles: Math.max(0, materialized
          - uniquePinnedCount),
        targetMaterializedArticles: LONG_THREAD_BUDGETS.targetMaterializedArticles,
        materializedHighWater: stats.materializedHighWater,
        serializedMarkupEntries: storeStats.serializedMarkupEntries,
        serializedMarkupCap: storeStats.serializedMarkupCap,
        statefulPinnedEntries: stats.statefulPinnedEntries,
        statefulOverflow: statefulOverflow,
        rebuiltMarkupCount: storeStats.rebuiltMarkupCount,
        rebuildFailureCount: storeStats.rebuildFailureCount,
        pinnedExemptions: Object.assign({}, stats.pinnedExemptions),
        observers: (observer ? 1 : 0) + (resizeObserver ? 1 : 0) + (layoutAxisObserver ? 1 : 0),
        observerGeneration: observerGeneration,
        observerFallbacks: stats.observerFallbacks,
        observeFailures: stats.observeFailures,
        queueDepth: pendingIntersectionRecordCount + unmountQueue.size,
        lastBatchRecords: stats.lastBatchRecords,
        lastCallbackDurationMs: Math.round(stats.lastCallbackDurationMs * 100) / 100,
        maxCallbackDurationMs: Math.round(stats.maxCallbackDurationMs * 100) / 100,
        scheduledLayoutTasks: resizeTimer == null ? 0 : 1,
      };
    }

    function publishStats(reason) {
      stats.queueDepth = pendingIntersectionRecordCount + unmountQueue.size;
      if (!onStatsChange) return;
      try { onStatsChange(getCurrentBudgetStats(), reason || 'update'); } catch (_error) { /* best-effort */ }
    }

    function captureIfDetached() {
      try { captureReaderAnchor(); } catch (_error) { /* best-effort */ }
    }

    function restoreIfDetached() {
      try { noteProgrammaticWrite?.('virtualizer'); } catch (_error) { /* best-effort */ }
      try { restoreReaderAnchor(); } catch (_error) { /* best-effort */ }
    }

    function mountEntryContents(entryEl) {
      if (!entryEl || disposed || !entryStore.has(entryEl)) {
        return { ok: false, reason: 'not_virtualized' };
      }
      var result = entryStore.mount(entryEl, getLayout());
      if (result.ok && result.layoutInvalidated) {
        // Force the restored row to settle at its real height before anchor
        // compensation; no retained stale min-height survives this mount.
        measureHeight(entryEl);
      }
      return result;
    }

    function mountEntry(entryEl) {
      if (!entryEl || disposed || !entryStore.has(entryEl)) return false;
      captureIfDetached();
      var result;
      try {
        result = mountEntryContents(entryEl);
      } finally {
        restoreIfDetached();
      }
      publishStats(result.ok ? 'mount' : result.reason);
      return result.ok;
    }

    function unmountEntry(entryEl) {
      if (!entryEl || disposed || entryStore.has(entryEl) || isPinned(entryEl)) return false;
      var height = measureHeight(entryEl);
      if (height <= 0) return false;
      var result = entryStore.applyUnmount(entryEl, height, getLayout());
      return result.ok;
    }

    function cancelUnmountFrame() {
      if (!unmountFrame) return;
      try { win?.cancelAnimationFrame?.(unmountFrame); } catch (_error) { /* best-effort */ }
      unmountFrame = 0;
    }

    function processUnmountQueue() {
      unmountFrame = 0;
      if (disposed || strategy !== STRATEGY_DOM_WINDOW) {
        unmountQueue.clear();
        publishStats('queue_cancelled');
        return;
      }
      var startedAt = now();
      var processed = 0;
      var didUnmount = false;
      var iterator = unmountQueue.keys();
      var next = iterator.next();
      while (!next.done && processed < MAX_UNMOUNTS_PER_FRAME && now() - startedAt < MAX_UNMOUNT_WORK_MS) {
        var entryEl = next.value;
        unmountQueue.delete(entryEl);
        if (visibilityByEntry.get(entryEl) === false && unmountEntry(entryEl)) didUnmount = true;
        processed += 1;
        next = iterator.next();
      }
      if (didUnmount) {
        // Spec 1b item 4 (binding): a large unmount can shrink scrollHeight
        // below scrollTop + clientHeight, letting the browser clamp scrollTop
        // with no restore write to attribute (restore is skipped while follow
        // is latched). The virtualizer knows its own mutations — attribute the
        // batch regardless of whether a restore ran.
        try { noteProgrammaticWrite?.('virtualizer'); } catch (_error) { /* best-effort */ }
      }
      if (unmountQueue.size > 0) scheduleUnmountWork();
      publishStats('unmount_batch');
    }

    function scheduleUnmountWork() {
      if (disposed || unmountFrame || unmountQueue.size === 0) return;
      if (win && typeof win.requestAnimationFrame === 'function') {
        unmountFrame = win.requestAnimationFrame(processUnmountQueue);
      } else {
        processUnmountQueue();
      }
    }

    function cancelIntersectionFrame() {
      if (!intersectionFrame) return;
      try { win?.cancelAnimationFrame?.(intersectionFrame); } catch (_error) { /* best-effort */ }
      intersectionFrame = 0;
    }

    function recordIntersectionDuration(startedAt, recordCount, phase, details) {
      var duration = Math.max(0, now() - startedAt);
      stats.lastCallbackDurationMs = duration;
      stats.maxCallbackDurationMs = Math.max(stats.maxCallbackDurationMs, duration);
      if (duration > SLOW_CALLBACK_MS) {
        logRateLimited('WARN', 'chat.timeline_virtualizer_slow_batch', Object.assign({
          durationMs: Math.round(duration),
          recordCount: recordCount,
          queueDepth: pendingIntersectionRecordCount + unmountQueue.size,
          phase: phase,
        }, details || {}));
      }
    }
    function processIntersectionLeave(target, generation) {
      if (!target || disposed || generation !== observerGeneration) return;
      visibilityByEntry.set(target, false);
      // Large observer batches mostly contain placeholders that are already
      // offscreen. Avoid serializing each placeholder's innerHTML merely to
      // reconfirm it has not morphed; a keyed morph strips the ownership
      // marker, and entering/rebuild performs the complete integrity check.
      if (entryStore.has(target)
          && target.getAttribute?.('data-virtualized') !== 'true') {
        entryStore.dropIfMorphed(target);
      }
      if (!entryStore.has(target) && !isPinned(target)) unmountQueue.set(target, true);
    }
    function processIntersectionEnter(target, generation, sequence, anchorState) {
      if (!target || disposed || generation !== observerGeneration) return false;
      latestIntersectionEnterByEntry.set(target, sequence);
      visibilityByEntry.set(target, true);
      entryStore.dropIfMorphed(target);
      unmountQueue.delete(target);
      if (!entryStore.has(target)) return false;
      if (!anchorState.captured) {
        captureIfDetached();
        anchorState.captured = true;
      }
      return mountEntryContents(target).ok;
    }
    function processIntersectionLeaveQueue() {
      intersectionFrame = 0;
      if (disposed) {
        pendingIntersectionBatches.length = 0;
        pendingIntersectionRecordCount = 0;
        publishStats('intersection_queue_cancelled');
        return;
      }
      var startedAt = now();
      var processed = 0;
      var enteringRecords = 0;
      var mountedRecords = 0;
      var anchorState = { captured: false };
      var canYield = Boolean(win && typeof win.requestAnimationFrame === 'function');
      try {
        while (pendingIntersectionBatches.length > 0
            && (!canYield || processed < MAX_INTERSECTION_LEAVES_PER_FRAME)
            && (!canYield || now() - startedAt < MAX_INTERSECTION_WORK_MS)) {
          var batch = pendingIntersectionBatches[0];
          var record = batch.records[batch.index];
          batch.index += 1;
          pendingIntersectionRecordCount = Math.max(0, pendingIntersectionRecordCount - 1);
          if (batch.index >= batch.records.length) pendingIntersectionBatches.shift();
          var target = record && record.target;
          if (target && record.isIntersecting === true && batch.processEnters) {
            enteringRecords += 1;
            if (processIntersectionEnter(target, batch.generation, batch.sequence, anchorState)) {
              mountedRecords += 1;
            }
          } else if (target && record.isIntersecting !== true
              && Number(latestIntersectionEnterByEntry.get(target) || 0) <= batch.sequence) {
            processIntersectionLeave(target, batch.generation);
          }
          processed += 1;
        }
      } finally {
        if (anchorState.captured) restoreIfDetached();
      }
      if (unmountQueue.size > 0 && !unmountFrame) processUnmountQueue();
      recordIntersectionDuration(startedAt, processed, 'deferred_intersection', {
        enteringRecords: enteringRecords,
        mountedRecords: mountedRecords,
      });
      if (pendingIntersectionRecordCount > 0) scheduleIntersectionLeaveWork();
      publishStats('intersection_leave_batch');
    }
    function scheduleIntersectionLeaveWork() {
      if (disposed || intersectionFrame || pendingIntersectionRecordCount === 0) return;
      if (win && typeof win.requestAnimationFrame === 'function') {
        intersectionFrame = win.requestAnimationFrame(processIntersectionLeaveQueue);
      } else {
        processIntersectionLeaveQueue();
      }
    }

    function onIntersect(records, generation) {
      if (disposed || generation !== observerGeneration) return;
      var startedAt = now();
      var list = Array.isArray(records) ? records : Array.from(records || []);
      stats.lastBatchRecords = list.length;
      intersectionSequence += 1;
      var sequence = intersectionSequence;
      var anchorState = { captured: false };
      var hasLeavingRecord = false;
      var enteringRecords = 0;
      var mountedRecords = 0;
      var canDeferEnters = list.length > MAX_SYNC_INTERSECTION_RECORDS
        && Boolean(win && typeof win.requestAnimationFrame === 'function');
      var deferredEnteringRecords = [];
      try {
        for (var index = 0; index < list.length; index += 1) {
          var record = list[index];
          var target = record && record.target;
          if (!target) continue;
          var isIntersecting = record.isIntersecting === true;
          if (isIntersecting) {
            enteringRecords += 1;
            latestIntersectionEnterByEntry.set(target, sequence);
            if (canDeferEnters) deferredEnteringRecords.push(record);
            else if (processIntersectionEnter(target, generation, sequence, anchorState)) {
              mountedRecords += 1;
            }
          } else {
            hasLeavingRecord = true;
          }
        }
      } finally {
        if (anchorState.captured) restoreIfDetached();
      }
      if (deferredEnteringRecords.length > 0) {
        pendingIntersectionBatches.push({
          records: deferredEnteringRecords,
          generation: generation,
          sequence: sequence,
          index: 0,
          processEnters: true,
        });
        pendingIntersectionRecordCount += deferredEnteringRecords.length;
      }
      if (hasLeavingRecord) {
        pendingIntersectionBatches.push({
          records: list,
          generation: generation,
          sequence: sequence,
          index: 0,
          processEnters: false,
        });
        pendingIntersectionRecordCount += list.length;
        var pendingCap = Math.max(8192, observedEntries.size * 3);
        while (pendingIntersectionRecordCount > pendingCap && pendingIntersectionBatches.length > 1) {
          var dropped = pendingIntersectionBatches.shift();
          pendingIntersectionRecordCount = Math.max(0,
            pendingIntersectionRecordCount - (dropped.records.length - dropped.index));
          logRateLimited('WARN', 'chat.timeline_virtualizer_intersection_backpressure', {
            droppedRecords: dropped.records.length - dropped.index,
            pendingRecords: pendingIntersectionRecordCount,
            pendingCap: pendingCap,
          });
        }
      }
      scheduleIntersectionLeaveWork();
      recordIntersectionDuration(startedAt, list.length, 'observer', {
        enteringRecords: enteringRecords,
        mountedRecords: mountedRecords,
      });
      publishStats('intersection');
    }

    function calculateRootMargin(entries) {
      if (configuredRootMargin) return configuredRootMargin;
      if (measuredDensityEpoch !== layoutEpoch || measuredAverageHeight <= 0) {
        var heights = [];
        for (var index = 0; index < entries.length && heights.length < 32; index += 1) {
          if (entryStore.has(entries[index])) continue;
          var height = measureHeight(entries[index]);
          if (height > 0) heights.push(height);
        }
        measuredAverageHeight = heights.length
          ? heights.reduce(function sum(total, value) { return total + value; }, 0) / heights.length
          : 0;
        measuredDensityEpoch = layoutEpoch;
      }
      if (measuredAverageHeight <= 0) return DEFAULT_ROOT_MARGIN;
      var viewportHeight = Math.max(1, Number(chatThreadScroll?.clientHeight) || 800);
      var visibleRows = Math.max(1, Math.ceil(viewportHeight / measuredAverageHeight));
      var bufferRowsPerSide = Math.max(1,
        Math.floor((LONG_THREAD_BUDGETS.targetMaterializedArticles - visibleRows) / 2));
      var margin = Math.max(viewportHeight * 1.5, measuredAverageHeight * bufferRowsPerSide);
      return Math.round(Math.min(Math.max(margin, 1000), 12000)) + 'px 0px';
    }

    function disconnectObserver() {
      observerGeneration += 1;
      if (observer) {
        try { observer.disconnect(); } catch (_error) { /* best-effort */ }
      }
      observer = null;
      observerRootMargin = '';
      observedEntries.clear();
      cancelIntersectionFrame();
      pendingIntersectionBatches.length = 0;
      pendingIntersectionRecordCount = 0;
    }

    function buildObserver(rootMargin) {
      var IO = win?.IntersectionObserver
        || (typeof IntersectionObserver !== 'undefined' ? IntersectionObserver : null);
      if (!IO) return null;
      var generation = observerGeneration + 1;
      try {
        var nextObserver = new IO(function handleIntersection(records) {
          onIntersect(records, generation);
        }, { root: chatThreadScroll || null, rootMargin: rootMargin });
        observerGeneration = generation;
        return nextObserver;
      } catch (_error) {
        return null;
      }
    }

    function cancelUnmountQueue() {
      cancelIntersectionFrame();
      pendingIntersectionBatches.length = 0;
      pendingIntersectionRecordCount = 0;
      cancelUnmountFrame();
      unmountQueue.clear();
    }

    function restoreAll(entries) {
      captureIfDetached();
      var restored = entryStore.restoreAll(entries, getLayout());
      restoreIfDetached();
      return restored;
    }

    function fallbackToFullyMounted(reason, entries) {
      disconnectObserver();
      cancelUnmountQueue();
      restoreAll(entries || getEntries());
      if (!observerFallbackReason) stats.observerFallbacks += 1;
      observerFallbackReason = String(reason || 'observer_unavailable');
      setStrategy(STRATEGY_NONE, reason);
      logRateLimited('WARN', 'chat.timeline_virtualizer_fallback', {
        reason: reason,
        articleCount: stats.articles,
        fallbackCount: stats.observerFallbacks,
      });
      publishStats('fallback');
    }

    function chooseStrategy(entryCount) {
      if (observerFallbackReason) return STRATEGY_NONE;
      if (boundsEnabled && entryCount > threshold) return STRATEGY_DOM_WINDOW;
      if (contentVisibilityEnabled) return STRATEGY_CONTENT_VISIBILITY;
      return STRATEGY_NONE;
    }

    function countPinnedExemptions(entries) {
      var counts = { streaming: 0, activeRoot: 0, focused: 0, approval: 0, liveState: 0, fallback: 0 };
      function collectOwningEntries(selector) {
        var owners = new Set();
        var matches;
        try { matches = Array.from(chatTimeline?.querySelectorAll?.(selector) || []); }
        catch (_error) { return owners; }
        for (var matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
          var match = matches[matchIndex];
          var owner = match?.matches?.('.chat-entry') ? match : match?.closest?.('.chat-entry');
          if (owner) owners.add(owner);
        }
        return owners;
      }

      var fallbackEntries = collectOwningEntries('.chat-entry[data-virtualizer-fallback="true"]');
      var streamingEntries = collectOwningEntries('.chat-bubble-streaming');
      var approvalEntries = collectOwningEntries(
        '.approval-gap-row, .tool-approval-block, [data-approval-id], [data-approval-state="pending"]'
      );
      var liveStateEntries = collectOwningEntries(entryStoreUtils?.LIVE_STATE_SELECTOR || '[data-virtualizer-pin-live]');
      var activeEntry = doc?.activeElement?.closest?.('.chat-entry') || null;
      var activeRootEntries = new Set();
      var activeRootId = String(getActiveTurnRootMessageId() || '').trim();
      if (activeRootId) {
        var roots;
        try { roots = Array.from(chatTimeline?.querySelectorAll?.('.chat-thread-root') || []); }
        catch (_error2) { roots = []; }
        for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
          if (roots[rootIndex].getAttribute?.('data-thread-message-id') !== activeRootId) continue;
          var rootEntries = roots[rootIndex].querySelectorAll?.('.chat-entry') || [];
          for (var rootEntryIndex = 0; rootEntryIndex < rootEntries.length; rootEntryIndex += 1) {
            activeRootEntries.add(rootEntries[rootEntryIndex]);
          }
        }
      }
      for (var index = 0; index < entries.length; index += 1) {
        var entryEl = entries[index];
        var reason = fallbackEntries.has(entryEl) ? 'fallback'
          : streamingEntries.has(entryEl) ? 'streaming'
            : activeRootEntries.has(entryEl) ? 'activeRoot'
              : activeEntry === entryEl ? 'focused'
                : approvalEntries.has(entryEl) ? 'approval'
                  : liveStateEntries.has(entryEl) ? 'liveState'
                    : '';
        if (counts[reason] !== undefined) counts[reason] += 1;
      }
      stats.pinnedExemptions = counts;
      stats.statefulPinnedEntries = liveStateEntries.size;
    }

    function reconcileObserverMembership(entries) {
      var nextEntries = new Set(entries);
      observedEntries.forEach(function unobserveRemoved(entryEl) {
        if (nextEntries.has(entryEl)) return;
        try { observer?.unobserve?.(entryEl); } catch (_error) { /* best-effort */ }
        observedEntries.delete(entryEl);
        unmountQueue.delete(entryEl);
      });
      for (var index = 0; index < entries.length; index += 1) {
        var entryEl = entries[index];
        entryStore.dropIfMorphed(entryEl);
        if (observedEntries.has(entryEl)) continue;
        try {
          observer.observe(entryEl);
          observedEntries.add(entryEl);
        } catch (_error2) {
          stats.observeFailures += 1;
          return false;
        }
      }
      return true;
    }

    function rebuild() {
      if (disposed) return;
      var rebuildStartedAt = now();
      entryStore.pruneIndexes();
      var entries = getEntries();
      var entriesCollectedAt = now();
      stats.articles = entries.length;
      var nextLayoutWidth = getLayoutWidth();
      if (layoutWidth > 0 && nextLayoutWidth > 0 && Math.abs(nextLayoutWidth - layoutWidth) > 1) {
        scheduleLayoutInvalidation();
        return;
      }
      layoutWidth = nextLayoutWidth;
      countPinnedExemptions(entries);
      var pinsCountedAt = now();
      var desiredStrategy = chooseStrategy(entries.length);
      if (desiredStrategy !== STRATEGY_DOM_WINDOW) {
        disconnectObserver();
        cancelUnmountQueue();
        if (entryStore.getStats().virtualizedEntries > 0) restoreAll(entries);
        setStrategy(desiredStrategy, desiredStrategy === STRATEGY_NONE
          ? (observerFallbackReason || 'fully_mounted')
          : 'css_containment');
        publishStats('rebuild');
        return;
      }

      setStrategy(STRATEGY_DOM_WINDOW, 'long_thread');
      var nextRootMargin = calculateRootMargin(entries);
      var marginCalculatedAt = now();
      if (!observer || observerRootMargin !== nextRootMargin) {
        disconnectObserver();
        observer = buildObserver(nextRootMargin);
        observerRootMargin = observer ? nextRootMargin : '';
      }
      if (!observer) {
        fallbackToFullyMounted('observer_unavailable', entries);
        return;
      }
      if (!reconcileObserverMembership(entries)) {
        fallbackToFullyMounted('observe_failed', entries);
        return;
      }
      var membershipReconciledAt = now();
      if (membershipReconciledAt - rebuildStartedAt > SLOW_CALLBACK_MS) {
        logRateLimited('WARN', 'chat.timeline_virtualizer_slow_rebuild', {
          durationMs: Math.round(membershipReconciledAt - rebuildStartedAt),
          articleCount: entries.length,
          collectMs: Math.round(entriesCollectedAt - rebuildStartedAt),
          pinScanMs: Math.round(pinsCountedAt - entriesCollectedAt),
          rootMarginMs: Math.round(marginCalculatedAt - pinsCountedAt),
          membershipMs: Math.round(membershipReconciledAt - marginCalculatedAt),
        });
      }
      publishStats('rebuild');
    }

    function refreshScope(rootEl) {
      if (disposed || strategy !== STRATEGY_DOM_WINDOW || !observer) return;
      if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
      entryStore.pruneIndexes();
      var scoped = Array.from(rootEl.querySelectorAll('.chat-entry'));
      if (rootEl.matches?.('.chat-entry')) scoped.unshift(rootEl);
      for (var index = 0; index < scoped.length; index += 1) {
        var entryEl = scoped[index];
        if (observedEntries.has(entryEl)) continue;
        try {
          observer.observe(entryEl);
          observedEntries.add(entryEl);
        } catch (_error) {
          stats.observeFailures += 1;
          fallbackToFullyMounted('observe_failed', getEntries());
          return;
        }
      }
      publishStats('refresh_scope');
    }

    function ensureMounted(entryEl) {
      return mountEntry(entryEl);
    }

    function ensureMountedForRowId(rowId) {
      var entryEl = entryStore.resolveRowId(rowId);
      return entryEl ? mountEntry(entryEl) : false;
    }

    function ensureMountedForToolCallId(toolCallId) {
      var entryEl = entryStore.resolveToolCallId(toolCallId);
      return entryEl ? mountEntry(entryEl) : false;
    }

    function ensureMountedForMessageId(messageId) {
      var entryEl = entryStore.resolveMessageId(messageId);
      return entryEl ? mountEntry(entryEl) : false;
    }

    function prepareForStructuralMorph() {
      if (disposed) return;
      captureIfDetached();
      restoreIfDetached();
    }

    function clearResizeTimer() {
      if (resizeTimer == null) return;
      try { win?.clearTimeout?.(resizeTimer); } catch (_error) { /* best-effort */ }
      resizeTimer = null;
    }

    function scheduleLayoutInvalidation() {
      if (disposed) return;
      clearResizeTimer();
      // Reapply the coordinator's pre-layout logical anchor before observing
      // any new geometry. Placeholders retain their old size until mounted;
      // each invalidated mount then performs its own anchor compensation.
      restoreIfDetached();
      layoutEpoch += 1;
      layoutWidth = getLayoutWidth();
      disconnectObserver();
      cancelUnmountQueue();
      var setTimeoutFn = win && typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : null;
      if (!setTimeoutFn) {
        rebuild();
        return;
      }
      resizeTimer = setTimeoutFn(function runLayoutInvalidation() {
        resizeTimer = null;
        if (!disposed) rebuild();
      }, 150);
      publishStats('layout_invalidated');
    }

    function handleObservedResize() {
      if (disposed) return;
      var nextWidth = getLayoutWidth();
      if (Math.abs(nextWidth - layoutWidth) > 1) {
        scheduleLayoutInvalidation();
        return;
      }
      // Row/content height changes arrive after layout. The coordinator keeps
      // the last detached-reader logical anchor, so restoring it here repairs
      // Mermaid/tool/reasoning reflow without measuring the shell broadly.
      restoreIfDetached();
    }

    function handleWindowResize() {
      if (disposed) return;
      var nextWidth = getLayoutWidth();
      if (nextWidth <= 0 || layoutWidth <= 0 || Math.abs(nextWidth - layoutWidth) > 1) {
        scheduleLayoutInvalidation();
      } else {
        restoreIfDetached();
      }
    }

    /* Root-level layout axes that change the rendered row width WITHOUT
       resizing #chatThreadScroll. getLayoutWidth() measures the scroll
       container first, and that box is unaffected by --content-column-width,
       so the ResizeObserver path alone never trips scheduleLayoutInvalidation()
       for these -- the cached row heights would silently go stale. Every axis
       listed here must also appear in the attributeFilter below. */
    function readLayoutSignature() {
      var rootEl = doc?.documentElement;
      if (!rootEl) return '';
      var inlineStyle = rootEl.style;
      return [
        rootEl.getAttribute?.('data-chat-zoom') || '',
        rootEl.getAttribute?.('data-chat-width') || '',
        inlineStyle?.getPropertyValue?.('--chat-zoom-percent') || '',
        inlineStyle?.getPropertyValue?.('--chat-zoom-factor') || '',
      ].join('\x1f');
    }

    function handleLayoutMutation() {
      if (disposed) return;
      var nextSignature = readLayoutSignature();
      if (nextSignature === layoutSignature) return;
      layoutSignature = nextSignature;
      scheduleLayoutInvalidation();
    }

    function connectLayoutInvalidationHooks() {
      try { win?.addEventListener?.('resize', handleWindowResize); } catch (_error) { /* best-effort */ }
      var ResizeObserverCtor = win && typeof win.ResizeObserver === 'function' ? win.ResizeObserver : null;
      if (ResizeObserverCtor && (chatThreadScroll || chatTimeline)) {
        try {
          resizeObserver = new ResizeObserverCtor(handleObservedResize);
          if (chatThreadScroll) resizeObserver.observe(chatThreadScroll);
          if (chatTimeline && chatTimeline !== chatThreadScroll) resizeObserver.observe(chatTimeline);
        } catch (_error2) { resizeObserver = null; }
      }
      var MutationObserverCtor = win?.MutationObserver
        || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      if (MutationObserverCtor && doc?.documentElement) {
        try {
          layoutSignature = readLayoutSignature();
          layoutAxisObserver = new MutationObserverCtor(handleLayoutMutation);
          layoutAxisObserver.observe(doc.documentElement, {
            attributes: true,
            attributeFilter: ['data-chat-zoom', 'data-chat-width', 'style'],
          });
        } catch (_error3) { layoutAxisObserver = null; }
      }
      try { chatTimeline?.addEventListener?.('focusin', handleTimelineFocus, true); } catch (_error4) { /* best-effort */ }
    }

    function handleTimelineFocus(event) {
      if (disposed) return;
      var entryEl = event?.target?.closest?.('.chat-entry[data-virtualized="true"]');
      if (entryEl) mountEntry(entryEl);
    }

    function dispose() {
      if (disposed) return;
      // Never strand semantic placeholders after the owner is gone. A later
      // pipeline/controller instance cannot reconstruct rows once this
      // instance releases its bounded entry store.
      restoreAll(getEntries());
      disposed = true;
      disconnectObserver();
      cancelUnmountQueue();
      clearResizeTimer();
      try { win?.removeEventListener?.('resize', handleWindowResize); } catch (_error) { /* best-effort */ }
      try { chatTimeline?.removeEventListener?.('focusin', handleTimelineFocus, true); } catch (_error2) { /* best-effort */ }
      try { resizeObserver?.disconnect?.(); } catch (_error3) { /* best-effort */ }
      try { layoutAxisObserver?.disconnect?.(); } catch (_error4) { /* best-effort */ }
      if (canonicalRerenderFrame) {
        try { win?.cancelAnimationFrame?.(canonicalRerenderFrame); } catch (_error5) { /* best-effort */ }
      }
      canonicalRerenderFrame = 0;
      resizeObserver = null;
      layoutAxisObserver = null;
      lastDiagnosticAtByEvent.clear();
      entryStore.dispose();
    }

    layoutWidth = getLayoutWidth();
    setStrategy(STRATEGY_NONE, 'initial');
    connectLayoutInvalidationHooks();

    return {
      rebuild: rebuild,
      refreshScope: refreshScope,
      prepareForStructuralMorph: prepareForStructuralMorph,
      ensureMounted: ensureMounted,
      ensureMountedForMessageId: ensureMountedForMessageId,
      ensureMountedForRowId: ensureMountedForRowId,
      ensureMountedForToolCallId: ensureMountedForToolCallId,
      dispose: dispose,
      _internals: {
        isPinned: isPinned,
        hasObserver: function hasObserver() { return observer !== null; },
        isVirtualized: function isVirtualized(entryEl) { return entryStore.has(entryEl); },
        getVirtualIndexSizes: function getVirtualIndexSizes() {
          var indexSizes = entryStore._internals.getIndexSizes();
          return { rows: indexSizes.rows, tools: indexSizes.tools };
        },
        getRetentionMode: function getRetentionMode(entryEl) { return entryStore.getRetentionMode(entryEl); },
        getBudgetStats: getCurrentBudgetStats,
        getStrategy: function getStrategy() { return strategy; },
        onIntersect: onIntersect,
        processUnmountQueue: processUnmountQueue,
      },
    };
  }

  return {
    DEFAULT_ROOT_MARGIN: DEFAULT_ROOT_MARGIN,
    MAX_UNMOUNTS_PER_FRAME: MAX_UNMOUNTS_PER_FRAME,
    MAX_UNMOUNT_WORK_MS: MAX_UNMOUNT_WORK_MS,
    STRATEGY_CONTENT_VISIBILITY: STRATEGY_CONTENT_VISIBILITY,
    STRATEGY_DOM_WINDOW: STRATEGY_DOM_WINDOW,
    STRATEGY_NONE: STRATEGY_NONE,
    createTimelineVirtualizer: createTimelineVirtualizer,
  };
});
