/* renderer/chat/renderer-chat-wayfinder-utils.js
 * Contextual transcript Wayfinder controller: decides which jump the bottom-edge control offers
 * (first unread, then latest once the reader has left the live end) and runs it.
 * It renders nothing itself.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./chat-scroll-utils'));
    return;
  }
  root.rendererChatWayfinderUtils = factory(root.chatScrollUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scrollUtils) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var STATE_HIDDEN = 'hidden';
  var STATE_UNREAD = 'unread';
  var STATE_LATEST = 'latest';
  var JUMP_CLICK_GUARD_MS = 350;

  var isNearBottom = scrollUtils && typeof scrollUtils.isNearBottom === 'function'
    ? scrollUtils.isNearBottom
    : function fallbackIsNearBottom(metrics) {
      var scrollTop = Number(metrics && metrics.scrollTop || 0);
      var scrollHeight = Number(metrics && metrics.scrollHeight || 0);
      var clientHeight = Number(metrics && metrics.clientHeight || 0);
      return scrollHeight - (scrollTop + clientHeight) <= 48;
    };

  var normalizeId = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).normalizeId;

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

  // Runs the first-unread jump a model names; "latest" is the bottom-edge control's own jump.
  function activateModel(model, handlers) {
    if (!model || model.visible !== true) return false;
    var h = handlers || {};
    try {
      if (model.state === STATE_UNREAD) {
        var unread = h.unreadController;
        return Boolean(unread && typeof unread.jumpToFirstUnread === 'function' && unread.jumpToFirstUnread());
      }
    } catch (error) {
      if (typeof h.onError === 'function') h.onError(error);
    }
    return false;
  }

  // One click, one jump: the control's state flips the moment a jump starts, so the second press of a
  // double-click would otherwise undo the first.
  function createJumpClickHandler(deps) {
    var guardUntil = 0;
    var now = deps.now || Date.now;
    return function onJumpClick() {
      var time = now();
      if (time < guardUntil) return false;
      guardUntil = time + JUMP_CLICK_GUARD_MS;
      var model = deps.getModel();
      if (model && model.visible === true && model.state !== STATE_LATEST
        && String(model.sessionId || '') === String(deps.getSessionId() || '')) {
        if (activateModel(model, deps.getHandlers())) return true;
      }
      deps.jumpToLatest();
      return true;
    };
  }

  function createChatWayfinderController(deps) {
    var options = deps || {};
    var state = options.state || {};
    var uiState = ensureUiState(state);
    var getCurrentSessionId = typeof options.getCurrentSessionId === 'function'
      ? options.getCurrentSessionId
      : function defaultGetCurrentSessionId() { return normalizeId(state.currentSessionId); };
    var getCurrentSessionMessages = typeof options.getCurrentSessionMessages === 'function'
      ? options.getCurrentSessionMessages
      : function defaultGetCurrentSessionMessages() { return []; };
    var getScrollMetrics = typeof options.getScrollMetrics === 'function'
      ? options.getScrollMetrics
      : function defaultGetScrollMetrics() { return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }; };
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    // Fired when the model changes, so the bottom-edge jump control re-renders.
    var onChange = typeof options.onChange === 'function' ? options.onChange : null;

    var bound = false;
    var disposed = false;
    var unreadState = null;
    var renderedSignature = '';
    var currentModel = {
      visible: false,
      state: STATE_HIDDEN,
      label: '',
      messageId: '',
      sessionId: '',
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
          label: jt('chat.wayfinder.jumpToFirstUnread', 'Jump to first unread'),
          messageId: normalizeId(unreadState.messageId),
          sessionId: sessionId,
        };
      }
      if (hasLatestTarget(scrollSnapshot)) {
        return {
          visible: true,
          state: STATE_LATEST,
          label: jt('chat.wayfinder.returnToLatest', 'Return to latest'),
          messageId: '',
          sessionId: sessionId,
        };
      }
      return {
        visible: false,
        state: STATE_HIDDEN,
        label: '',
        messageId: '',
        sessionId: sessionId,
      };
    }

    function getModelSignature(model) {
      return [
        model.visible === true ? '1' : '0',
        model.state || '',
        model.label || '',
        model.messageId || '',
        model.sessionId || '',
      ].join('');
    }

    // The model is published on state.ui.chatWayfinder so the bottom-edge jump control
    // (rendered per pane by the composer chrome) reads it; each pane matches it to its own session.
    function publish(model) {
      uiState.chatWayfinder = model;
    }

    function notifyChange() {
      if (typeof onChange !== 'function') return;
      try {
        onChange(currentModel);
      } catch (error) {
        logWarning('chat.wayfinder_change_failed', error);
      }
    }

    function sync(scrollSnapshot) {
      if (disposed) return currentModel;
      var model = buildModel(scrollSnapshot);
      var nextSignature = getModelSignature(model);
      currentModel = model;
      if (nextSignature !== renderedSignature) {
        renderedSignature = nextSignature;
        publish(model);
        notifyChange();
      }
      return model;
    }

    function bind() {
      if (disposed || bound) return false;
      bound = true;
      sync();
      return true;
    }

    function setUnreadState(nextState) {
      unreadState = nextState && typeof nextState === 'object'
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
      publish(createHiddenModel(''));
      renderedSignature = '';
      unreadState = null;
      currentModel = createHiddenModel('');
    }

    return {
      bind: bind,
      dispose: dispose,
      handleScroll: handleScroll,
      refresh: refresh,
      setUnreadState: setUnreadState,
    };
  }

  return {
    activateModel: activateModel,
    createJumpClickHandler: createJumpClickHandler,
    createChatWayfinderController: createChatWayfinderController,
  };
});
