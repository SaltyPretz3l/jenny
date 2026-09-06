/* renderer/chat/renderer-chat-unread-orientation-utils.js
 * F10: ephemeral first-unread orientation controller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./chat-scroll-utils'));
    return;
  }
  root.rendererChatUnreadOrientationUtils = factory(root.chatScrollUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (scrollUtils) {
  'use strict';

  var MAX_UNREAD_SESSION_STATES = 50;
  var SKIPPED_KINDS = new Set(['question_batch', 'interactive_round_recap', 'proactive_suggestion', 'slash_command_output', 'tool_result']);
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
    if (!(state.ui.firstUnreadMessageIdBySession instanceof Map)) {
      state.ui.firstUnreadMessageIdBySession = new Map();
    }
    if (!(state.ui.firstUnreadSessionOrder instanceof Map)) {
      state.ui.firstUnreadSessionOrder = new Map();
    }
    return state.ui;
  }

  function cssStringEscape(value) {
    var text = String(value || '');
    var escaped = '';
    for (var index = 0; index < text.length; index += 1) {
      var ch = text.charAt(index);
      var code = text.charCodeAt(index);
      if (ch === '"') {
        escaped += '\\"';
      } else if (ch === '\\') {
        escaped += '\\\\';
      } else if (code <= 31 || code === 127) {
        escaped += '\\' + code.toString(16) + ' ';
      } else {
        escaped += ch;
      }
    }
    return escaped;
  }

  function isUnreadCandidate(event) {
    var role = normalizeId(event && event.role);
    if (role === 'user') {
      return false;
    }
    var kind = normalizeId(event && event.kind);
    if (kind && SKIPPED_KINDS.has(kind)) {
      return false;
    }
    return role === 'assistant' || kind === 'tool_use';
  }

  function createUnreadOrientationController(deps) {
    var options = deps || {};
    var state = options.state || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var chatTimeline = options.chatTimeline || null;
    var chatThreadScroll = options.chatThreadScroll || null;
    var getCurrentSessionId = typeof options.getCurrentSessionId === 'function'
      ? options.getCurrentSessionId
      : function defaultGetCurrentSessionId() { return normalizeId(state.currentSessionId); };
    var getCurrentSessionMessages = typeof options.getCurrentSessionMessages === 'function'
      ? options.getCurrentSessionMessages
      : function defaultGetCurrentSessionMessages() { return []; };
    var getScrollMetrics = typeof options.getScrollMetrics === 'function'
      ? options.getScrollMetrics
      : function defaultGetScrollMetrics() {
        return {
          scrollTop: Number(chatThreadScroll && chatThreadScroll.scrollTop || 0),
          scrollHeight: Number(chatThreadScroll && chatThreadScroll.scrollHeight || 0),
          clientHeight: Number(chatThreadScroll && chatThreadScroll.clientHeight || 0),
        };
      };
    var scrollMessageIntoView = typeof options.scrollMessageIntoView === 'function'
      ? options.scrollMessageIntoView
      : null;
    var viewportReveal = options.viewportReveal || null;
    var focusEntryByMessageId = typeof options.focusEntryByMessageId === 'function'
      ? options.focusEntryByMessageId
      : null;
    var timelineVirtualizer = options.timelineVirtualizer || null;
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    var onStateChange = typeof options.onStateChange === 'function'
      ? options.onStateChange
      : null;

    var uiState = ensureUiState(state);
    var timelineObserver = null;
    var disposed = false;
    var lastStateChangeKey = null;

    function getCurrentId() {
      return normalizeId(getCurrentSessionId() || state.currentSessionId);
    }

    function currentSessionIsVisible(sessionId, visible) {
      if (visible === false) {
        return false;
      }
      // The open Workspace chat dock is a live chat surface; if the shared helper is unavailable,
      // fall back to the active Chat view while preserving the unset-view startup case.
      var chatSurfaceLive = (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state);
      if (chatSurfaceLive == null) {
        chatSurfaceLive = normalizeId(state.ui && state.ui.activeView) === 'chat';
      }
      if (normalizeId(state.ui && state.ui.activeView) && !chatSurfaceLive) {
        return false;
      }
      return normalizeId(sessionId) === getCurrentId();
    }

    function notifyStateChange(sessionId, messageId) {
      if (!onStateChange) return;
      var normalizedMessageId = normalizeId(messageId);
      var normalizedSessionId = normalizeId(sessionId);
      var stateKey = normalizedSessionId + '\x1f' + normalizedMessageId;
      if (stateKey === lastStateChangeKey) {
        return;
      }
      lastStateChangeKey = stateKey;
      try {
        onStateChange({
          visible: Boolean(normalizedMessageId),
          hasUnread: Boolean(normalizedMessageId),
          sessionId: normalizedSessionId,
          messageId: normalizedMessageId,
        });
      } catch (error) {
        try {
          appendClientLog('WARN', 'chat.unread_orientation_state_callback_failed', {
            message: String(error && error.message || error || '').slice(0, 160),
          });
        } catch (_logError) { /* ignore */ }
      }
    }

    function pruneUnreadState() {
      while (uiState.firstUnreadMessageIdBySession.size > MAX_UNREAD_SESSION_STATES) {
        var oldestSessionId = '';
        var oldestTimestamp = Infinity;
        uiState.firstUnreadMessageIdBySession.forEach(function inspectUnreadSession(_messageId, sessionId) {
          var timestamp = Number(uiState.firstUnreadSessionOrder.get(sessionId));
          if (!Number.isFinite(timestamp) || timestamp < oldestTimestamp) {
            oldestTimestamp = Number.isFinite(timestamp) ? timestamp : -Infinity;
            oldestSessionId = sessionId;
          }
        });
        if (!oldestSessionId) {
          oldestSessionId = uiState.firstUnreadMessageIdBySession.keys().next().value;
        }
        uiState.firstUnreadMessageIdBySession.delete(oldestSessionId);
        uiState.firstUnreadSessionOrder.delete(oldestSessionId);
      }
    }

    function clearSession(sessionId) {
      var normalizedSessionId = normalizeId(sessionId || getCurrentId());
      if (!normalizedSessionId) return false;
      var changed = uiState.firstUnreadMessageIdBySession.delete(normalizedSessionId);
      uiState.firstUnreadSessionOrder.delete(normalizedSessionId);
      if (changed) {
        syncAffordance({ validateTarget: false });
      }
      return changed;
    }

    function resolveEntry(messageId) {
      var id = normalizeId(messageId);
      if (!id || !chatTimeline || typeof chatTimeline.querySelector !== 'function') {
        return null;
      }
      try {
        return chatTimeline.querySelector('.chat-entry[data-message-id="' + cssStringEscape(id) + '"]');
      } catch (_error) {
        return null;
      }
    }

    function currentMessagesContain(messageId) {
      var id = normalizeId(messageId);
      if (!id) return false;
      var messages = getCurrentSessionMessages();
      if (!Array.isArray(messages) || !messages.length) {
        return Boolean(resolveEntry(id));
      }
      return messages.some(function hasMessage(message) {
        return normalizeId(message && message.id) === id;
      });
    }

    /* Historical name: this once mounted the legacy jump affordance. The
       Wayfinder owns the visible unread UI now; attaching wires the timeline
       mutation observer and the renderless state sync. */
    function attachAffordance() {
      if (disposed) return false;
      observeTimelineMutations();
      return syncAffordance();
    }

    function observeTimelineMutations() {
      if (timelineObserver || !chatTimeline || !doc) {
        return;
      }
      var View = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      var MutationObserverCtor = View && View.MutationObserver;
      if (typeof MutationObserverCtor !== 'function') {
        return;
      }
      timelineObserver = new MutationObserverCtor(function onTimelineMutated() {
        syncAffordance();
      });
      timelineObserver.observe(chatTimeline, { childList: true });
    }

    function syncAffordance(options) {
      var settings = options || {};
      var validateTarget = settings.validateTarget !== false;
      if (disposed) return false;
      var sessionId = getCurrentId();
      var messageId = uiState.firstUnreadMessageIdBySession.get(sessionId);
      if (validateTarget && messageId && !currentMessagesContain(messageId)) {
        uiState.firstUnreadMessageIdBySession.delete(sessionId);
        uiState.firstUnreadSessionOrder.delete(sessionId);
        messageId = '';
      }
      notifyStateChange(sessionId, messageId);
      return Boolean(messageId);
    }

    function noteTimelineMessageCreated(event) {
      var sessionId = normalizeId(event && event.sessionId);
      var messageId = normalizeId(event && event.messageId);
      if (!sessionId || !messageId || !currentSessionIsVisible(sessionId, event && event.visible)) {
        return false;
      }
      if (!isUnreadCandidate(event)) {
        return false;
      }
      if (isNearBottom(getScrollMetrics())) {
        clearSession(sessionId);
        return false;
      }
      if (uiState.firstUnreadMessageIdBySession.has(sessionId)) {
        syncAffordance({ validateTarget: false });
        return false;
      }
      uiState.firstUnreadMessageIdBySession.set(sessionId, messageId);
      uiState.firstUnreadSessionOrder.set(sessionId, Date.now());
      pruneUnreadState();
      syncAffordance({ validateTarget: false });
      return true;
    }

    function focusEntry(messageId) {
      if (focusEntryByMessageId) {
        try {
          if (focusEntryByMessageId(messageId)) {
            return true;
          }
        } catch (_error) { /* fall back to DOM focus */ }
      }
      var entry = resolveEntry(messageId);
      if (!entry || typeof entry.focus !== 'function') {
        return false;
      }
      entry.setAttribute('tabindex', '0');
      entry.focus({ preventScroll: true });
      return true;
    }

    function jumpToFirstUnread() {
      var sessionId = getCurrentId();
      var messageId = uiState.firstUnreadMessageIdBySession.get(sessionId);
      if (!messageId) {
        syncAffordance({ validateTarget: false });
        return false;
      }
      var target = resolveEntry(messageId);
      if (target && target.getAttribute('data-virtualized') === 'true' && timelineVirtualizer && typeof timelineVirtualizer.ensureMounted === 'function') {
        try { timelineVirtualizer.ensureMounted(target); } catch (_error) { /* best-effort */ }
      }
      var didScroll = false;
      if (scrollMessageIntoView) {
        try {
          didScroll = Boolean(scrollMessageIntoView(messageId, {
            block: 'center',
            followLatest: false,
            reason: 'unread_jump',
          }));
        } catch (error) {
          appendClientLog('WARN', 'chat.unread_jump_scroll_failed', {
            message: String(error && error.message || error || '').slice(0, 160),
          });
        }
      }
      if (!didScroll) {
        target = resolveEntry(messageId);
        didScroll = Boolean(viewportReveal?.revealElement?.(target, {
          block: 'center',
          followLatest: false,
          reason: 'unread_jump',
        }));
      }
      if (!didScroll) {
        clearSession(sessionId);
        return false;
      }
      focusEntry(messageId);
      clearSession(sessionId);
      return true;
    }

    function handleScroll(snapshot) {
      if (isNearBottom(snapshot || getScrollMetrics())) {
        return clearSession(getCurrentId());
      }
      syncAffordance({ validateTarget: false });
      return false;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      notifyStateChange(getCurrentId(), '');
      if (timelineObserver && typeof timelineObserver.disconnect === 'function') {
        timelineObserver.disconnect();
      }
      timelineObserver = null;
    }

    return {
      attachAffordance: attachAffordance,
      clearSession: clearSession,
      dispose: dispose,
      handleScroll: handleScroll,
      jumpToFirstUnread: jumpToFirstUnread,
      noteTimelineMessageCreated: noteTimelineMessageCreated,
      syncAffordance: syncAffordance,
      getState: function getState() {
        var sessionId = getCurrentId();
        var messageId = uiState.firstUnreadMessageIdBySession.get(sessionId);
        return {
          visible: Boolean(messageId),
          hasUnread: Boolean(messageId),
          sessionId: sessionId,
          messageId: normalizeId(messageId),
        };
      },
    };
  }

  return {
    createUnreadOrientationController: createUnreadOrientationController,
  };
});
