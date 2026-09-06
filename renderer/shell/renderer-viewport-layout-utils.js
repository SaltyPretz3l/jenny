(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportLayoutUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SAFE_OFFSET_MINIMUM_PX = 28;
  // Parked in pendingResizeFrame between scheduling a coalesced resize measurement
  // and recording its real rAF handle, so a synchronously-invoked rAF can clear the
  // marker without a late handle assignment clobbering it back to a non-zero value.
  const RESIZE_FRAME_SCHEDULED = -1;

  function createViewportLayoutUtils(deps) {
    const settings = deps || {};
    const state = settings.state || { ui: {} };
    const dom = settings.dom || {};
    const callbacks = settings.callbacks || {};
    const chatView = dom.chatView || null;
    const chatSurfaceEffects = dom.chatSurfaceEffects || null;
    const chatSurfaceEffectLeft = dom.chatSurfaceEffectLeft || null;
    const chatThreadStage = dom.chatThreadStage || null;
    const chatThreadColumn = dom.chatThreadColumn || null;
    const composerWrap = dom.composerWrap || null;
    const getCurrentSessionMessages = typeof callbacks.getCurrentSessionMessages === 'function'
      ? callbacks.getCurrentSessionMessages
      : () => [];
    const scheduleMessageViewportSync = typeof callbacks.scheduleMessageViewportSync === 'function'
      ? callbacks.scheduleMessageViewportSync
      : function noopScheduleMessageViewportSync() {};
    const layoutRuntime = {
      measureCanvas: null,
      measureContext: null,
      resizeObserver: null,
      pendingResizeFrame: 0,
      viewportHeight: 0,
      safeOffset: 0,
      chatSurfaceEffectLeftWidth: 0,
      chatSurfaceEffectRightWidth: 0,
    };

    function requestLayoutFrame(callback) {
      if (typeof requestAnimationFrame === 'function') {
        return requestAnimationFrame(callback);
      }
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        return window.requestAnimationFrame(callback);
      }
      // No-rAF fallback fires synchronously (not via setTimeout) so the sentinel
      // reset inside the resize callback lands before the handle is recorded --
      // deferring it would defeat the RESIZE_FRAME_SCHEDULED coalescing guard.
      callback();
      return 0;
    }

    function cancelLayoutFrame(handle) {
      if (!handle) {
        return;
      }
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(handle);
        return;
      }
      if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(handle);
      }
    }

    function getRootStyle() {
      if (typeof document === 'undefined' || !document.documentElement) {
        return null;
      }
      return document.documentElement.style || null;
    }

    function updateAppWindowHeight() {
      const rootStyle = getRootStyle();
      const nextViewportHeight =
        typeof window === 'undefined'
          ? 0
          : Math.max(Math.ceil(Number(window.innerHeight) || 0), 0);
      if (!rootStyle || !nextViewportHeight) {
        return false;
      }
      if (layoutRuntime.viewportHeight === nextViewportHeight) {
        return false;
      }
      layoutRuntime.viewportHeight = nextViewportHeight;
      rootStyle.setProperty('--app-window-height', `${nextViewportHeight}px`);
      return true;
    }

    function setStyleProperty(target, name, value) {
      if (!target || !target.style || typeof target.style.setProperty !== 'function') {
        return;
      }
      target.style.setProperty(name, value);
    }

    function clearStyleProperty(target, name) {
      if (!target || !target.style) {
        return;
      }
      if (typeof target.style.removeProperty === 'function') {
        target.style.removeProperty(name);
        return;
      }
      if (typeof target.style.setProperty === 'function') {
        target.style.setProperty(name, '');
      }
    }

    function clearChatSurfaceEffectWidths() {
      const alreadyCleared =
        layoutRuntime.chatSurfaceEffectLeftWidth === 0
        && layoutRuntime.chatSurfaceEffectRightWidth === 0
        && !String(chatSurfaceEffects?.style?.getPropertyValue?.('--chat-surface-effect-left-width') || '').trim()
        && !String(chatSurfaceEffects?.style?.getPropertyValue?.('--chat-surface-effect-right-width') || '').trim();
      layoutRuntime.chatSurfaceEffectLeftWidth = 0;
      layoutRuntime.chatSurfaceEffectRightWidth = 0;
      if (alreadyCleared) {
        return;
      }
      clearStyleProperty(chatSurfaceEffects, '--chat-surface-effect-left-width');
      clearStyleProperty(chatSurfaceEffects, '--chat-surface-effect-right-width');
    }

    function updateChatSurfaceEffectWidths() {
      if (
        !chatSurfaceEffects
        || !chatSurfaceEffectLeft
        || !chatThreadColumn
        || typeof chatSurfaceEffects.getBoundingClientRect !== 'function'
        || typeof chatThreadColumn.getBoundingClientRect !== 'function'
      ) {
        clearChatSurfaceEffectWidths();
        return false;
      }

      const layerRect = chatSurfaceEffects.getBoundingClientRect();
      const threadRect = chatThreadColumn.getBoundingClientRect();
      if (
        !Number.isFinite(layerRect.left)
        || !Number.isFinite(layerRect.right)
        || !Number.isFinite(threadRect.left)
        || !Number.isFinite(threadRect.right)
        || !(layerRect.right > layerRect.left)
      ) {
        clearChatSurfaceEffectWidths();
        return false;
      }

      const nextLeftWidth = Math.max(Math.round(threadRect.left - layerRect.left), 0);
      const nextRightWidth = Math.max(Math.round(layerRect.right - threadRect.right), 0);
      const widthsChanged =
        layoutRuntime.chatSurfaceEffectLeftWidth !== nextLeftWidth
        || layoutRuntime.chatSurfaceEffectRightWidth !== nextRightWidth;

      layoutRuntime.chatSurfaceEffectLeftWidth = nextLeftWidth;
      layoutRuntime.chatSurfaceEffectRightWidth = nextRightWidth;
      if (!widthsChanged) {
        return false;
      }
      setStyleProperty(chatSurfaceEffects, '--chat-surface-effect-left-width', `${nextLeftWidth}px`);
      setStyleProperty(chatSurfaceEffects, '--chat-surface-effect-right-width', `${nextRightWidth}px`);
      return true;
    }

    function getComposerSafeOffset() {
      return layoutRuntime.safeOffset || 0;
    }

    function measureComposerSafeOffset() {
      if (!chatView || !chatThreadStage || !composerWrap) {
        return null;
      }
      const viewRect = chatView.getBoundingClientRect();
      const stageRect = chatThreadStage.getBoundingClientRect();
      const composerRect = composerWrap.getBoundingClientRect();
      if (
        !Number(viewRect.height)
        || !Number(stageRect.height)
        || !Number(composerRect.height)
      ) {
        return null;
      }
      const stageBottom = Number.isFinite(stageRect.bottom) ? stageRect.bottom : (stageRect.top + stageRect.height);
      const composerTop = Number.isFinite(composerRect.top) ? composerRect.top : 0;
      const stageToComposerGap = Math.max(Math.ceil(composerTop - stageBottom), 0);
      return Math.max(stageToComposerGap + SAFE_OFFSET_MINIMUM_PX, SAFE_OFFSET_MINIMUM_PX);
    }

    function updateComposerSafeOffset(options = {}) {
      const viewportHeightChanged = updateAppWindowHeight();
      const preserveSurfaceEffectWidths = options && options.preserveSurfaceEffectWidths === true;
      const chatSurfaceEffectWidthsChanged = preserveSurfaceEffectWidths
        ? false
        : updateChatSurfaceEffectWidths();
      const nextSafeOffset = measureComposerSafeOffset();
      if (!chatView || !nextSafeOffset) {
        return;
      }
      const safeOffsetChanged = layoutRuntime.safeOffset !== nextSafeOffset;
      if (!safeOffsetChanged && !viewportHeightChanged && !chatSurfaceEffectWidthsChanged && !options.force) {
        return;
      }
      layoutRuntime.safeOffset = nextSafeOffset;
      chatView.style.setProperty('--composer-safe-offset', `${nextSafeOffset}px`);
      chatView.style.setProperty('--empty-hero-stage-bottom', `${nextSafeOffset}px`);
      // Widened render gate (ide_chat_dock): viewport sync also runs while the
      // Workspace dock is the live chat surface (falls back flag-off).
      const chatSurfaceLive = (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state)
        ?? (state.ui.activeView === 'chat');
      if (options.syncViewport && chatSurfaceLive && state.ui.chatMode === 'thread') {
        scheduleMessageViewportSync(getCurrentSessionMessages(), {
          preserveFollowLatest: true,
          preserveSurfaceEffectWidths,
        });
      }
    }

    function initializeComposerLayoutObserver() {
      if ((!composerWrap && !chatView) || layoutRuntime.resizeObserver) {
        updateComposerSafeOffset({ force: true });
        return;
      }
      if (typeof ResizeObserver !== 'function') {
        updateComposerSafeOffset({ force: true });
        return;
      }
      layoutRuntime.resizeObserver = new ResizeObserver(() => {
        // Coalesce a burst of RO callbacks into a single measurement per frame:
        // each updateComposerSafeOffset does ~5 getBoundingClientRect reads and
        // writes CSS custom props onto observed elements, which can re-fire the
        // observer. Deferring out of the layout-delivery phase batches the reads
        // and breaks that write -> reflow -> refire loop.
        if (layoutRuntime.pendingResizeFrame) {
          return;
        }
        layoutRuntime.pendingResizeFrame = RESIZE_FRAME_SCHEDULED;
        const handle = requestLayoutFrame(() => {
          layoutRuntime.pendingResizeFrame = 0;
          updateComposerSafeOffset({ syncViewport: true });
        });
        // A synchronous rAF (or the no-rAF fallback) already reset the marker to 0
        // inside the callback above; only a still-pending async frame keeps the
        // sentinel and needs its real handle recorded for cancellation on dispose.
        if (layoutRuntime.pendingResizeFrame === RESIZE_FRAME_SCHEDULED) {
          layoutRuntime.pendingResizeFrame = handle;
        }
      });
      [chatView, chatThreadStage, chatSurfaceEffects, chatThreadColumn, composerWrap]
        .filter(Boolean)
        .forEach((target) => layoutRuntime.resizeObserver.observe(target));
      updateComposerSafeOffset({ force: true });
    }

    function disposeComposerLayoutObserver() {
      if (layoutRuntime.pendingResizeFrame) {
        cancelLayoutFrame(layoutRuntime.pendingResizeFrame);
        layoutRuntime.pendingResizeFrame = 0;
      }
      if (layoutRuntime.resizeObserver) {
        layoutRuntime.resizeObserver.disconnect();
        layoutRuntime.resizeObserver = null;
      }
    }

    return {
      composerLayoutRuntime: layoutRuntime,
      getComposerSafeOffset,
      measureComposerSafeOffset,
      updateComposerSafeOffset,
      initializeComposerLayoutObserver,
      disposeComposerLayoutObserver,
    };
  }

  return {
    SAFE_OFFSET_MINIMUM_PX,
    createViewportLayoutUtils,
  };
});
