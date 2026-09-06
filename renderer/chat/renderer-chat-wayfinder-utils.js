/* renderer/chat/renderer-chat-wayfinder-utils.js
 * Contextual transcript Wayfinder controller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./chat-scroll-utils'));
    return;
  }
  root.rendererChatWayfinderUtils = factory(root.chatScrollUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scrollUtils) {
  'use strict';

  var STATE_HIDDEN = 'hidden';
  var STATE_UNREAD = 'unread';
  var STATE_PROMPT = 'prompt';
  var STATE_LATEST = 'latest';

  var isNearBottom = scrollUtils && typeof scrollUtils.isNearBottom === 'function'
    ? scrollUtils.isNearBottom
    : function fallbackIsNearBottom(metrics) {
      var scrollTop = Number(metrics && metrics.scrollTop || 0);
      var scrollHeight = Number(metrics && metrics.scrollHeight || 0);
      var clientHeight = Number(metrics && metrics.clientHeight || 0);
      return scrollHeight - (scrollTop + clientHeight) <= 48;
    };

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function ensureUiState(state) {
    if (!state.ui || typeof state.ui !== 'object') {
      state.ui = {};
    }
    return state.ui;
  }

  function safeCall(callback) {
    if (typeof callback !== 'function') return undefined;
    try {
      return callback();
    } catch (_error) {
      return undefined;
    }
  }

  function createChatWayfinderController(deps) {
    var options = deps || {};
    var state = options.state || {};
    var uiState = ensureUiState(state);
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var host = options.host || null;
    var getCurrentSessionId = typeof options.getCurrentSessionId === 'function'
      ? options.getCurrentSessionId
      : function defaultGetCurrentSessionId() { return normalizeId(state.currentSessionId); };
    var getCurrentSessionMessages = typeof options.getCurrentSessionMessages === 'function'
      ? options.getCurrentSessionMessages
      : function defaultGetCurrentSessionMessages() { return []; };
    var getScrollMetrics = typeof options.getScrollMetrics === 'function'
      ? options.getScrollMetrics
      : function defaultGetScrollMetrics() { return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }; };
    var scrollMessageIntoView = typeof options.scrollMessageIntoView === 'function'
      ? options.scrollMessageIntoView
      : null;
    var handleJumpToBottom = typeof options.handleJumpToBottom === 'function'
      ? options.handleJumpToBottom
      : null;
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    var affordanceFactory = options.affordanceFactory
      || (typeof globalThis !== 'undefined' ? globalThis.inventoryChatWayfinderAffordance : null);

    var affordance = null;
    var bound = false;
    var disposed = false;
    var offActivate = null;
    var unreadController = null;
    var unreadState = null;
    var pinState = null;
    var renderedSignature = '';
    var mountedVisible = null;
    var mountedHost = null;
    var currentModel = {
      visible: false,
      state: STATE_HIDDEN,
      label: '',
      messageId: '',
      sessionId: '',
      detail: '',
    };

    function logWarning(eventName, error, details) {
      try {
        appendClientLog('WARN', eventName, Object.assign({
          message: String(error && error.message || error || '').slice(0, 160),
        }, details || {}));
      } catch (_logError) {
        // Logging is best-effort and must not break transcript navigation.
      }
    }

    function createHiddenModel(sessionId) {
      return {
        visible: false,
        state: STATE_HIDDEN,
        label: '',
        messageId: '',
        sessionId: normalizeId(sessionId || getCurrentId()),
        detail: '',
      };
    }

    function getCurrentId() {
      return normalizeId(getCurrentSessionId() || state.currentSessionId);
    }

    function sessionMatches(nextState) {
      var nextSessionId = normalizeId(nextState && nextState.sessionId);
      var currentSessionId = getCurrentId();
      if (!nextSessionId || !currentSessionId) {
        return nextSessionId === currentSessionId;
      }
      return nextSessionId === currentSessionId;
    }

    function activeViewAllowsWayfinder() {
      var activeView = normalizeId(uiState.activeView);
      if (!activeView) return true;
      // The open Workspace chat dock is a live chat surface; when the shared helper is absent,
      // only the active Chat view qualifies.
      var live = (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state);
      return live ?? (activeView === 'chat');
    }

    function hasVisibleUnread() {
      return activeViewAllowsWayfinder()
        && unreadState
        && unreadState.visible === true
        && unreadState.hasUnread !== false
        && sessionMatches(unreadState)
        && Boolean(normalizeId(unreadState.messageId));
    }

    function hasVisiblePrompt() {
      return activeViewAllowsWayfinder()
        && pinState
        && pinState.visible === true
        && sessionMatches(pinState)
        && Boolean(normalizeId(pinState.messageId));
    }

    function hasLatestTarget(scrollSnapshot) {
      if (!activeViewAllowsWayfinder()) return false;
      if (uiState.followLatest !== false) return false;
      var messages = safeCall(getCurrentSessionMessages);
      if (!Array.isArray(messages) || messages.length <= 0) return false;
      var metrics;
      try {
        metrics = scrollSnapshot || getScrollMetrics();
      } catch (error) {
        logWarning('chat.wayfinder_metrics_failed', error);
        return false;
      }
      return !isNearBottom(metrics);
    }

    function buildModel(scrollSnapshot) {
      var sessionId = getCurrentId();
      if (hasVisibleUnread()) {
        return {
          visible: true,
          state: STATE_UNREAD,
          label: 'Jump to first unread',
          messageId: normalizeId(unreadState.messageId),
          sessionId: sessionId,
          detail: '',
        };
      }
      if (hasVisiblePrompt()) {
        return {
          visible: true,
          state: STATE_PROMPT,
          label: 'Back to prompt',
          messageId: normalizeId(pinState.messageId),
          sessionId: sessionId,
          detail: String(pinState.text || '').trim(),
        };
      }
      if (hasLatestTarget(scrollSnapshot)) {
        return {
          visible: true,
          state: STATE_LATEST,
          label: 'Return to latest',
          messageId: '',
          sessionId: sessionId,
          detail: '',
        };
      }
      return {
        visible: false,
        state: STATE_HIDDEN,
        label: '',
        messageId: '',
        sessionId: sessionId,
        detail: '',
      };
    }

    function setUiWayfinderState(model) {
      uiState.chatWayfinderVisible = model.visible === true;
      uiState.chatWayfinderState = model.state || STATE_HIDDEN;
    }

    function getModelSignature(model) {
      return [
        model.visible === true ? '1' : '0',
        model.state || '',
        model.label || '',
        model.messageId || '',
        model.sessionId || '',
        model.detail || '',
      ].join('\x1f');
    }

    function ensureAffordance() {
      if (affordance || !affordanceFactory || typeof affordanceFactory.createChatWayfinderAffordance !== 'function') {
        return affordance;
      }
      try {
        affordance = affordanceFactory.createChatWayfinderAffordance({
          document: doc,
          hostId: 'chat-wayfinder',
        });
        if (affordance && typeof affordance.on === 'function') {
          offActivate = affordance.on('activate', handleActivate);
        }
      } catch (error) {
        logWarning('chat.wayfinder_affordance_failed', error);
        try {
          affordance?.dispose?.();
        } catch (_disposeError) { /* ignore */ }
        affordance = null;
        affordanceFactory = null;
        offActivate = null;
      }
      return affordance;
    }

    function resolveHost() {
      if (host) return host;
      if (doc && typeof doc.getElementById === 'function') {
        host = doc.getElementById('composerWayfinderHost');
      }
      return host;
    }

    function sync(scrollSnapshot) {
      if (disposed) return currentModel;
      var model = buildModel(scrollSnapshot);
      var targetHost = resolveHost();
      var nextAffordance = ensureAffordance();
      if (model.visible && (!nextAffordance || !targetHost)) {
        model = createHiddenModel(model.sessionId);
      }
      currentModel = model;
      setUiWayfinderState(model);
      if (nextAffordance && typeof nextAffordance.setState === 'function') {
        var nextSignature = getModelSignature(model);
        try {
          if (nextSignature !== renderedSignature) {
            nextAffordance.setState(model);
            renderedSignature = nextSignature;
          }
        } catch (error) {
          logWarning('chat.wayfinder_affordance_failed', error, { phase: 'set_state' });
          try {
            nextAffordance.dispose?.();
          } catch (_disposeError) { /* ignore */ }
          affordance = null;
          offActivate = null;
          renderedSignature = '';
          mountedVisible = null;
          mountedHost = null;
          currentModel = createHiddenModel(model.sessionId);
          setUiWayfinderState(currentModel);
          return currentModel;
        }
      }
      if (bound && nextAffordance) {
        try {
          if (model.visible && (mountedVisible !== true || mountedHost !== targetHost)) {
            nextAffordance.mount?.(targetHost);
            mountedVisible = true;
            mountedHost = targetHost;
          } else if (!model.visible && mountedVisible !== false) {
            nextAffordance.unmount?.();
            mountedVisible = false;
            mountedHost = null;
          }
        } catch (error) {
          logWarning('chat.wayfinder_affordance_failed', error, { phase: model.visible ? 'mount' : 'unmount' });
          try {
            nextAffordance.dispose?.();
          } catch (_disposeError) { /* ignore */ }
          affordance = null;
          offActivate = null;
          renderedSignature = '';
          mountedVisible = null;
          mountedHost = null;
          currentModel = createHiddenModel(model.sessionId);
          setUiWayfinderState(currentModel);
          return currentModel;
        }
      }
      return model;
    }

    function logActionFailure(error) {
      logWarning('chat.wayfinder_action_failed', error, {
        state: currentModel.state || STATE_HIDDEN,
      });
    }

    function handleActivate() {
      if (disposed || !currentModel.visible) return false;
      try {
        if (currentModel.state === STATE_UNREAD) {
          if (unreadController && typeof unreadController.jumpToFirstUnread === 'function') {
            return Boolean(unreadController.jumpToFirstUnread());
          }
          return false;
        }
        if (currentModel.state === STATE_PROMPT) {
          if (!currentModel.messageId || !scrollMessageIntoView) return false;
          return Boolean(scrollMessageIntoView(currentModel.messageId, { block: 'start', followLatest: false }));
        }
        if (currentModel.state === STATE_LATEST) {
          if (!handleJumpToBottom) return false;
          return Boolean(handleJumpToBottom());
        }
      } catch (error) {
        logActionFailure(error);
        return false;
      } finally {
        sync();
      }
      return false;
    }

    function bind(nextHost) {
      if (disposed || bound) return false;
      bound = true;
      host = nextHost || host;
      ensureAffordance();
      sync();
      return Boolean(affordance);
    }

    function setUnreadController(nextController) {
      unreadController = nextController || null;
      sync();
    }

    function setUnreadState(nextState) {
      unreadState = nextState && typeof nextState === 'object'
        ? Object.assign({}, nextState)
        : null;
      sync();
    }

    function setPinState(nextState) {
      pinState = nextState && typeof nextState === 'object'
        ? Object.assign({}, nextState)
        : null;
      sync();
    }

    function handleScroll(snapshot) {
      return sync(snapshot);
    }

    function refresh() {
      return sync();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      bound = false;
      setUiWayfinderState({ visible: false, state: STATE_HIDDEN });
      if (typeof offActivate === 'function') {
        try {
          offActivate();
        } catch (_error) { /* ignore */ }
      }
      offActivate = null;
      if (affordance && typeof affordance.dispose === 'function') {
        try {
          affordance.dispose();
        } catch (_error) { /* ignore */ }
      }
      affordance = null;
      host = null;
      renderedSignature = '';
      mountedVisible = null;
      mountedHost = null;
      unreadController = null;
      unreadState = null;
      pinState = null;
      currentModel = {
        visible: false,
        state: STATE_HIDDEN,
        label: '',
        messageId: '',
        sessionId: '',
        detail: '',
      };
    }

    return {
      bind: bind,
      dispose: dispose,
      handleScroll: handleScroll,
      refresh: refresh,
      setPinState: setPinState,
      setUnreadController: setUnreadController,
      setUnreadState: setUnreadState,
    };
  }

  return {
    createChatWayfinderController: createChatWayfinderController,
  };
});
