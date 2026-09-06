/* renderer/chat/renderer-pin-to-top-utils.js – pinned-prompt position observer (UMD).
   scroll-W4a reduced this to the renderless observer the Wayfinder consumes via
   onStateChange; the DOM overlay branch (renderOverlay/overlayHost/onJumpToMessage
   and the bubble fade machinery) was dead in production and removed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPinToTopUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var MAX_PIN_TEXT_LENGTH = 200;

  function createPinToTopController(deps) {
    var scrollContainer = deps.scrollContainer;
    var timelineContainer = deps.timelineContainer;
    var pinnableSelector = deps.pinnableSelector || '.chat-entry[data-message-role="user"]';
    var topOffset = Number(deps.topOffset) || 88;
    var listenForScroll = deps.listenForScroll !== false;
    var onStateChange = typeof deps.onStateChange === 'function'
      ? deps.onStateChange
      : null;

    var cache = [];
    var dirty = true;
    var currentPinnedId = null;
    var currentPinnedText = '';
    var rafId = 0;
    var rafPending = false;
    var bound = false;
    var resizeObserver = null;
    var currentActiveIndex = -1;

    function notifyStateChange(visible, messageId, text) {
      if (!onStateChange) {
        return;
      }
      try {
        onStateChange({
          visible: visible === true,
          messageId: visible === true ? String(messageId || '') : '',
          text: visible === true ? String(text || '') : '',
        });
      } catch (_error) {
        // The pin state callback is render-adjacent; isolate failures.
      }
    }

    function collectPinnableElements() {
      if (!timelineContainer) {
        cache = [];
        dirty = false;
        return;
      }
      cache = Array.from(timelineContainer.querySelectorAll(pinnableSelector)).map(function (element) {
        return {
          element: element,
          messageId: String(element?.dataset?.messageId || ''),
          text: extractPinText(element),
        };
      });
      currentActiveIndex = Math.min(currentActiveIndex, cache.length - 1);
      dirty = false;
    }

    function readEntryBottom(index) {
      var entry = cache[index];
      if (!entry || !entry.element || typeof entry.element.getBoundingClientRect !== 'function') return Infinity;
      var bottom = Number(entry.element.getBoundingClientRect().bottom);
      return Number.isFinite(bottom) ? bottom : Infinity;
    }

    function findLastEntryBefore(thresholdY, low, high) {
      var answer = -1;
      var left = Math.max(0, Number(low) || 0);
      var right = Math.min(cache.length - 1, Number.isFinite(high) ? high : cache.length - 1);
      while (left <= right) {
        var middle = left + Math.floor((right - left) / 2);
        if (readEntryBottom(middle) <= thresholdY) {
          answer = middle;
          left = middle + 1;
        } else {
          right = middle - 1;
        }
      }
      return answer;
    }

    function findActivePinTarget() {
      if (!scrollContainer || cache.length === 0) {
        return null;
      }
      var thresholdY = scrollContainer.getBoundingClientRect().top + topOffset;
      var index;
      if (currentActiveIndex >= 0 && currentActiveIndex < cache.length) {
        var currentBottom = readEntryBottom(currentActiveIndex);
        if (currentBottom <= thresholdY) {
          var nextIndex = currentActiveIndex + 1;
          if (nextIndex >= cache.length || readEntryBottom(nextIndex) > thresholdY) {
            index = currentActiveIndex;
          } else {
            index = findLastEntryBefore(thresholdY, nextIndex, cache.length - 1);
          }
        } else {
          index = findLastEntryBefore(thresholdY, 0, currentActiveIndex - 1);
        }
      } else {
        index = findLastEntryBefore(thresholdY, 0, cache.length - 1);
      }
      if (index < 0) {
        currentActiveIndex = -1;
        return null;
      }
      var entry = cache[index];
      if (!entry.messageId) return null;
      currentActiveIndex = index;
      return entry;
    }

    function normalizePinText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function extractPinText(element) {
      var bubble = element.querySelector('.chat-bubble');
      if (!bubble) {
        return '';
      }
      var text = normalizePinText(bubble.textContent || '');
      if (!text) {
        return '';
      }
      if (text.length > MAX_PIN_TEXT_LENGTH) {
        return text.slice(0, MAX_PIN_TEXT_LENGTH) + '…';
      }
      return text;
    }

    function scheduleSync() {
      if (rafPending || !bound) {
        return;
      }
      rafPending = true;
      rafId = globalThis.requestAnimationFrame(onScrollFrame);
    }

    function observeLayoutTargets() {
      var ResizeObserverCtor = globalThis.ResizeObserver;
      if (resizeObserver || typeof ResizeObserverCtor !== 'function') {
        return;
      }
      resizeObserver = new ResizeObserverCtor(function () {
        // Resize only changes element positions, not the set of pinnable user
        // prompts, so reuse the cached pinnable set and recompute positions via
        // scheduleSync() rather than refresh() which forces a full re-scan every
        // layout growth during streaming (finding #7). New turns set dirty via
        // the render path's pinToTopController.refresh().
        scheduleSync();
      });
      if (timelineContainer) {
        resizeObserver.observe(timelineContainer);
      }
      if (scrollContainer && scrollContainer !== timelineContainer) {
        resizeObserver.observe(scrollContainer);
      }
    }

    function disconnectLayoutObserver() {
      if (!resizeObserver) {
        return;
      }
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    function setPinnedTarget(target) {
      var text = target.text || extractPinText(target.element);
      if (!text) {
        clearPinnedTarget();
        return;
      }
      var didChange = currentPinnedId !== target.messageId || currentPinnedText !== text;
      currentPinnedId = target.messageId;
      currentPinnedText = text;
      if (didChange) {
        notifyStateChange(true, currentPinnedId, currentPinnedText);
      }
    }

    function clearPinnedTarget() {
      if (currentPinnedId !== null || currentPinnedText) {
        notifyStateChange(false, '', '');
      }
      currentPinnedId = null;
      currentPinnedText = '';
    }

    function onScrollFrame() {
      rafPending = false;
      if (!bound) {
        return;
      }
      if (dirty) {
        collectPinnableElements();
      }
      if (cache.length === 0) {
        clearPinnedTarget();
        return;
      }
      var target = findActivePinTarget();
      if (target === null) {
        clearPinnedTarget();
      } else if (target.messageId !== currentPinnedId) {
        setPinnedTarget(target);
      }
    }

    function handleScroll() {
      scheduleSync();
    }

    function handleScrollFrame() {
      if (!bound) return;
      onScrollFrame();
    }

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      dirty = true;
      currentPinnedId = null;
      currentPinnedText = '';
      observeLayoutTargets();
      if (listenForScroll && scrollContainer) {
        scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
      }
      refresh();
    }

    function dispose() {
      if (!bound) {
        return;
      }
      bound = false;
      if (listenForScroll && scrollContainer) {
        scrollContainer.removeEventListener('scroll', handleScroll);
      }
      disconnectLayoutObserver();
      if (rafId) {
        globalThis.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      rafPending = false;
      clearPinnedTarget();
      cache = [];
      dirty = true;
      currentPinnedId = null;
      currentPinnedText = '';
      currentActiveIndex = -1;
    }

    function refresh() {
      dirty = true;
      scheduleSync();
    }

    // Stream-patch scoped re-scan (B5): only re-scan the whole timeline if a NEW pinnable
    // (user-role) node appeared inside the patched subtree (C7 — e.g. a promoted interactive
    // row). Otherwise the cache is still valid and positions refresh via the scheduled sync,
    // avoiding the per-frame whole-timeline querySelectorAll the unconditional refresh did.
    function refreshScoped(patchedRoot) {
      if (!patchedRoot || typeof patchedRoot.querySelectorAll !== 'function') {
        refresh();
        return;
      }
      var scopedNodes = Array.prototype.slice.call(patchedRoot.querySelectorAll(pinnableSelector));
      if (typeof patchedRoot.matches === 'function' && patchedRoot.matches(pinnableSelector)) {
        scopedNodes.push(patchedRoot);
      }
      var cachedElements = new Set(cache.map(function (entry) { return entry.element; }));
      var hasNewPinnable = scopedNodes.some(function (node) { return !cachedElements.has(node); });
      if (hasNewPinnable) {
        refresh();
      } else {
        scheduleSync();
      }
    }

    return {
      bind: bind,
      dispose: dispose,
      refresh: refresh,
      refreshScoped: refreshScoped,
      handleScroll: handleScroll,
      handleScrollFrame: handleScrollFrame,
    };
  }

  return {
    createPinToTopController: createPinToTopController,
  };
});
