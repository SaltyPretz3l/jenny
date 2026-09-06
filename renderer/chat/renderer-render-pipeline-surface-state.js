(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererRenderPipelineSurfaceStateUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const windowRef = globalRef.window || globalRef;

  function createSurfaceStatePipeline(deps) {
    const { state = {}, dom = {}, runtime = {}, callbacks = {} } = deps || {};
    const {
      chatView = null,
      composer = null,
      composerWrap = null,
      chatSurfaceEffects = null,
      chatSurfaceEffectLeft = null,
      homeView = null,
      ideView = null,
      artifactsView = null,
      logsView = null,
      settingsView = null,
    } = dom;
    const { uiRuntime = {} } = runtime;
    const {
      getChatSendLifecycle = () => 'idle',
      isSendPreflightPending = () => false,
      isSessionStreaming = () => false,
      hasPendingToolApprovalForSession = () => false,
      updateComposerSafeOffset = () => {},
      refreshActiveSurfaceEffect = () => {},
      // Background Effects v3 S5 W1b: optional surface-activity sync hook,
      // fired at the end of every syncStableChatSurfaceState call. Absent by
      // default so pre-existing callers/tests are untouched.
      onSurfaceLifecycleSync = null,
    } = callbacks;
    const disposalFence = asyncFence.createDisposalFence();

    function normalizeChatSendLifecycle(value) {
      var token = String(value || '').trim().toLowerCase();
      if (token === 'preflight' || token === 'streaming' || token === 'settling' || token === 'failed') {
        return token;
      }
      return 'idle';
    }

    function resolveChatSendLifecycle(sessionId) {
      var normalizedSessionId = String(sessionId || state.currentSessionId || '').trim();
      if (!normalizedSessionId) {
        return 'idle';
      }
      var explicitLifecycle = normalizeChatSendLifecycle(getChatSendLifecycle(normalizedSessionId));
      if (explicitLifecycle !== 'idle') {
        return explicitLifecycle;
      }
      if (isSendPreflightPending() && normalizedSessionId === String(state.currentSessionId || '').trim()) {
        return 'preflight';
      }
      if (isSessionStreaming(normalizedSessionId) || hasPendingToolApprovalForSession(normalizedSessionId)) {
        return 'streaming';
      }
      return 'idle';
    }

    function writeDatasetValue(node, key, value) {
      if (!node || !node.dataset) {
        return false;
      }
      if (node.dataset[key] === value) {
        return false;
      }
      node.dataset[key] = value;
      return true;
    }

    function writeSendLifecycle(node, lifecycle) {
      return writeDatasetValue(node, 'sendLifecycle', normalizeChatSendLifecycle(lifecycle));
    }

    function syncStableChatSurfaceState() {
      var currentLifecycle = resolveChatSendLifecycle(state.currentSessionId);
      var changed = false;
      if (chatView) {
        changed = writeDatasetValue(chatView, 'chatMode', String(state.ui.chatMode || 'empty')) || changed;
      }
      changed = writeSendLifecycle(chatView, currentLifecycle) || changed;
      changed = writeSendLifecycle(composerWrap, currentLifecycle) || changed;
      changed = writeSendLifecycle(composer, currentLifecycle) || changed;
      if (typeof onSurfaceLifecycleSync === 'function') {
        onSurfaceLifecycleSync({ sessionId: state.currentSessionId });
      }
      return changed;
    }

    function setSurfaceEffectModifier(element, effectId) {
      if (!element) {
        return false;
      }
      if (!effectId || effectId === 'none') {
        if (typeof element.getAttribute === 'function' && element.getAttribute('data-widget-modifier') === null) {
          return false;
        }
        element.removeAttribute('data-widget-modifier');
        return true;
      }
      if (typeof element.getAttribute === 'function' && element.getAttribute('data-widget-modifier') === effectId) {
        return false;
      }
      element.setAttribute('data-widget-modifier', effectId);
      return true;
    }

    function syncSurfaceEffectModifiers() {
      var effectId = (state.ui.appearance && state.ui.appearance.surfaceEffectId) || 'none';
      var showHomeEffect = state.ui.activeView === 'home';
      var showChatEffect = state.ui.activeView === 'chat';
      var changed = false;
      changed = setSurfaceEffectModifier(homeView, showHomeEffect ? effectId : 'none') || changed;
      changed = setSurfaceEffectModifier(chatSurfaceEffectLeft, showChatEffect ? effectId : 'none') || changed;
      changed = setSurfaceEffectModifier(chatSurfaceEffects, 'none') || changed;
      changed = setSurfaceEffectModifier(chatView, 'none') || changed;
      changed = setSurfaceEffectModifier(ideView, 'none') || changed;
      changed = setSurfaceEffectModifier(artifactsView, 'none') || changed;
      changed = setSurfaceEffectModifier(logsView, 'none') || changed;
      changed = setSurfaceEffectModifier(settingsView, 'none') || changed;
      return changed;
    }

    // Workspace Chat Dock (ide_chat_dock): the moved chat nodes stop matching
    // `.chat-view.chat-empty/.chat-active/...` once reparented, so the dock
    // body mirrors the three chat state classes; ide-chat-dock.css re-authors
    // the empty/active rules against `.ide-chat-dock-body.chat-*`. Mirrored
    // from chatView (the single source of truth) after every toggle site.
    function mirrorChatStateClassesToDock() {
      var doc = chatView && chatView.ownerDocument;
      var dockBody = doc && typeof doc.getElementById === 'function'
        ? doc.getElementById('ideChatDockBody')
        : null;
      if (!dockBody || !chatView) {
        return;
      }
      ['chat-empty', 'chat-active', 'thread-transition-ready'].forEach(function (className) {
        dockBody.classList.toggle(className, chatView.classList.contains(className));
      });
    }

    function applyChatStateClasses(hasMessages) {
      var nextChatMode = hasMessages ? 'thread' : 'empty';
      var chatModeChanged = state.ui.chatMode !== nextChatMode;
      state.ui.chatMode = nextChatMode;
      chatView.classList.toggle('chat-active', hasMessages);
      chatView.classList.toggle('chat-empty', !hasMessages);
      syncStableChatSurfaceState();
      if (!hasMessages) {
        chatView.classList.remove('thread-transition-ready');
      }
      mirrorChatStateClassesToDock();
      var modifiersChanged = syncSurfaceEffectModifiers();
      if (chatModeChanged || modifiersChanged) {
        refreshActiveSurfaceEffect();
      }
    }

    function applySurfaceEffect() {
      applyChatStateClasses(state.ui.chatMode === 'thread');
    }

    function refreshChatViewportAfterStateChange() {
      if (
        disposalFence.isDisposed()
        || uiRuntime.viewportRefreshFrame
        || !chatView
        || typeof updateComposerSafeOffset !== 'function'
      ) {
        return;
      }
      uiRuntime.viewportRefreshFrame = windowRef.requestAnimationFrame(disposalFence.guard(function () {
        uiRuntime.viewportRefreshFrame = 0;
        updateComposerSafeOffset({ force: true });
      }));
    }

    function parseCssDurationMs(value, fallbackMs) {
      var rawValue = String(value || '').trim();
      if (!rawValue) {
        return fallbackMs;
      }
      if (rawValue.endsWith('ms')) {
        var msValue = Number.parseFloat(rawValue.slice(0, -2));
        return Number.isFinite(msValue) ? msValue : fallbackMs;
      }
      if (rawValue.endsWith('s')) {
        var secondsValue = Number.parseFloat(rawValue.slice(0, -1));
        return Number.isFinite(secondsValue) ? secondsValue * 1000 : fallbackMs;
      }
      var numericValue = Number.parseFloat(rawValue);
      return Number.isFinite(numericValue) ? numericValue : fallbackMs;
    }

    function readCssDurationMs(variableName, fallbackMs) {
      if (!chatView || typeof windowRef.getComputedStyle !== 'function') {
        return fallbackMs;
      }
      return parseCssDurationMs(windowRef.getComputedStyle(chatView).getPropertyValue(variableName), fallbackMs);
    }

    function clearThreadTransitionCleanup() {
      if (uiRuntime.threadTransitionTimer) {
        windowRef.clearTimeout(uiRuntime.threadTransitionTimer);
        uiRuntime.threadTransitionTimer = 0;
      }
      chatView.classList.remove('thread-transition-ready');
      mirrorChatStateClassesToDock();
    }

    function scheduleThreadTransitionCleanup() {
      clearThreadTransitionCleanup();
      var transitionDurationMs = readCssDurationMs('--thread-transition-duration', 300);
      uiRuntime.threadTransitionTimer = windowRef.setTimeout(function clearThreadTransitionReadyState() {
        uiRuntime.threadTransitionTimer = 0;
        chatView.classList.remove('thread-transition-ready');
        mirrorChatStateClassesToDock();
      }, Math.max(transitionDurationMs + 120, 120));
    }

    function syncChatState(hasMessages, { animate = false } = {}) {
      var currentSendLifecycle = resolveChatSendLifecycle(state.currentSessionId);

      if (!hasMessages) {
        clearThreadTransitionCleanup();
        applyChatStateClasses(false);
        refreshChatViewportAfterStateChange();
        return;
      }

      if (state.ui.chatMode === 'thread' && currentSendLifecycle === 'streaming') {
        syncStableChatSurfaceState();
        return;
      }

      if (state.ui.chatMode === 'thread') {
        clearThreadTransitionCleanup();
        applyChatStateClasses(true);
        refreshChatViewportAfterStateChange();
        return;
      }

      if (!animate || currentSendLifecycle !== 'idle') {
        clearThreadTransitionCleanup();
        applyChatStateClasses(true);
        refreshChatViewportAfterStateChange();
        return;
      }

      applyChatStateClasses(true);
      chatView.classList.add('thread-transition-ready');
      mirrorChatStateClassesToDock();
      refreshChatViewportAfterStateChange();
    }

    function escapeSelectorValue(value) {
      if (windowRef.CSS && typeof windowRef.CSS.escape === 'function') {
        return windowRef.CSS.escape(value);
      }
      return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function dispose() {
      if (uiRuntime.viewportRefreshFrame) {
        if (typeof windowRef.cancelAnimationFrame === 'function') {
          windowRef.cancelAnimationFrame(uiRuntime.viewportRefreshFrame);
        }
        uiRuntime.viewportRefreshFrame = 0;
      }
      disposalFence.dispose();
      clearThreadTransitionCleanup();
    }

    return {
      resolveChatSendLifecycle,
      syncStableChatSurfaceState,
      applyChatStateClasses,
      applySurfaceEffect,
      syncChatState,
      scheduleThreadTransitionCleanup,
      escapeSelectorValue,
      dispose,
    };
  }

  return { createSurfaceStatePipeline };
});
