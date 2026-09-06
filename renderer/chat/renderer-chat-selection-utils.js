/* renderer/chat/renderer-chat-selection-utils.js
 *
 * F4/F5/F6: multi-select state machine for the chat timeline. Owns
 * state.ui.selectionMode + the per-session selected-message-id sets +
 * the per-session range-select anchor. Exposes enter/exit/toggle/range/
 * selectAll/clear/get APIs consumed by:
 *   - the inventory selection-handle click branch in renderer-chat-event-transcript-bindings.js
 *   - the keyboard shortcuts (Esc/Ctrl+A/Delete) wired in renderer-chat-keyboard-utils.js
 *   - the selection-action-bar mount in wireChatAccessibility (also in keyboard-utils.js)
 *   - the bulk-actions controller in renderer-chat-bulk-actions-utils.js
 *
 * Disposal contract (AGENTS.md §5): dispose() removes the Esc listener
 * registered by attach() and clears state.ui.selectionMode. Per-session
 * Sets / anchors persist on state.ui across dispose for cache reasons —
 * a re-attach picks them up unchanged. session-switch + stream-start
 * unconditionally drop selection mode.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererChatSelectionUtils = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  var SKIPPED_KIND_SET = new Set(['question_batch', 'interactive_round_recap']);

  function noopFn() { /* no-op */ }

  var normalizeId = stringUtils && typeof stringUtils.normalizeId === 'function'
    ? stringUtils.normalizeId
    : function (value) { return String(value || '').trim(); };

  function ensureUiState(state) {
    if (!state.ui || typeof state.ui !== 'object') {
      state.ui = {};
    }
    if (typeof state.ui.selectionMode !== 'boolean') {
      state.ui.selectionMode = false;
    }
    if (!(state.ui.selectedMessageIdsBySession instanceof Map)) {
      state.ui.selectedMessageIdsBySession = new Map();
    }
    if (!(state.ui.selectionAnchorBySession instanceof Map)) {
      state.ui.selectionAnchorBySession = new Map();
    }
  }

  function isTextInputTarget(target) {
    if (!target || typeof target !== 'object') return false;
    var tag = String(target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return target.isContentEditable === true;
  }

  function isSelectableMessage(message) {
    if (!message || typeof message !== 'object') return false;
    var id = normalizeId(message.id);
    if (!id) return false;
    var kind = String(message.kind || '').trim();
    if (kind && SKIPPED_KIND_SET.has(kind)) return false;
    return true;
  }

  function createSelectionController(deps) {
    var settings = deps || {};
    if (!settings.state || typeof settings.state !== 'object') {
      throw new TypeError('createSelectionController requires `state`.');
    }
    var state = settings.state;
    var doc = settings.document || (typeof document !== 'undefined' ? document : null);
    var getCurrentSessionMessages = typeof settings.getCurrentSessionMessages === 'function'
      ? settings.getCurrentSessionMessages
      : function () { return []; };
    var getCurrentSessionId = typeof settings.getCurrentSessionId === 'function'
      ? settings.getCurrentSessionId
      : function () { return ''; };
    var renderAll = typeof settings.renderAll === 'function' ? settings.renderAll : noopFn;
    var appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog
      : noopFn;
    ensureUiState(state);

    var documentListenerCleanup = null;
    var controller;

    // Selection mutators monkey-patch a `syncActionBar` method onto the
    // returned controller (see wireChatAccessibility). Without this call the
    // floating action bar never mounts and its count badge stays stale.
    function syncBarAfterMutation() {
      if (controller && typeof controller.syncActionBar === 'function') {
        try { controller.syncActionBar(); } catch (_e) { /* best-effort */ }
      }
    }

    function getSelectionSet(sessionId, createIfMissing) {
      ensureUiState(state);
      var id = normalizeId(sessionId);
      if (!id) return null;
      var existing = state.ui.selectedMessageIdsBySession.get(id);
      if (existing instanceof Set) return existing;
      if (!createIfMissing) return null;
      var fresh = new Set();
      state.ui.selectedMessageIdsBySession.set(id, fresh);
      return fresh;
    }

    function setAnchor(sessionId, messageId) {
      ensureUiState(state);
      var id = normalizeId(sessionId);
      var anchorId = normalizeId(messageId);
      if (!id) return;
      if (anchorId) {
        state.ui.selectionAnchorBySession.set(id, anchorId);
      } else {
        state.ui.selectionAnchorBySession.delete(id);
      }
    }

    function isSelectMode() {
      ensureUiState(state);
      return state.ui.selectionMode === true;
    }

    function enterSelectMode() {
      ensureUiState(state);
      if (state.ui.selectionMode === true) return false;
      state.ui.selectionMode = true;
      appendClientLog('INFO', 'chat.selection_mode_entered', {});
      syncBarAfterMutation();
      renderAll();
      return true;
    }

    function exitSelectMode() {
      ensureUiState(state);
      if (state.ui.selectionMode !== true) return false;
      state.ui.selectionMode = false;
      state.ui.selectedMessageIdsBySession.clear();
      state.ui.selectionAnchorBySession.clear();
      appendClientLog('INFO', 'chat.selection_mode_exited', {});
      syncBarAfterMutation();
      renderAll();
      return true;
    }

    function toggleMessage(messageId) {
      ensureUiState(state);
      var sessionId = normalizeId(getCurrentSessionId());
      var targetId = normalizeId(messageId);
      if (!sessionId || !targetId) return false;
      var set = getSelectionSet(sessionId, true);
      if (!set) return false;
      var becameSelected;
      if (set.has(targetId)) {
        set.delete(targetId);
        becameSelected = false;
        var currentAnchor = state.ui.selectionAnchorBySession.get(sessionId);
        if (currentAnchor === targetId) {
          state.ui.selectionAnchorBySession.delete(sessionId);
        }
      } else {
        set.add(targetId);
        becameSelected = true;
        setAnchor(sessionId, targetId);
      }
      syncBarAfterMutation();
      renderAll();
      return becameSelected;
    }

    function selectRange(messageId) {
      ensureUiState(state);
      var sessionId = normalizeId(getCurrentSessionId());
      var targetId = normalizeId(messageId);
      if (!sessionId || !targetId) return 0;
      var messages = getCurrentSessionMessages() || [];
      if (!Array.isArray(messages) || !messages.length) return 0;
      var anchorId = state.ui.selectionAnchorBySession.get(sessionId) || '';
      var targetIndex = -1;
      var anchorIndex = -1;
      for (var i = 0; i < messages.length; i += 1) {
        var id = normalizeId(messages[i] && messages[i].id);
        if (!id) continue;
        if (id === targetId) targetIndex = i;
        if (anchorId && id === anchorId) anchorIndex = i;
      }
      if (targetIndex < 0) return 0;
      var startIndex = anchorIndex >= 0 ? Math.min(anchorIndex, targetIndex) : targetIndex;
      var endIndex = anchorIndex >= 0 ? Math.max(anchorIndex, targetIndex) : targetIndex;
      var set = getSelectionSet(sessionId, true);
      if (!set) return 0;
      var added = 0;
      for (var j = startIndex; j <= endIndex; j += 1) {
        var message = messages[j];
        if (!isSelectableMessage(message)) continue;
        var id2 = normalizeId(message.id);
        if (id2 && !set.has(id2)) {
          set.add(id2);
          added += 1;
        }
      }
      if (anchorIndex < 0) setAnchor(sessionId, targetId);
      if (added > 0) {
        syncBarAfterMutation();
        renderAll();
      }
      return added;
    }

    function selectAll() {
      ensureUiState(state);
      var sessionId = normalizeId(getCurrentSessionId());
      if (!sessionId) return 0;
      var messages = getCurrentSessionMessages() || [];
      if (!Array.isArray(messages)) return 0;
      var set = getSelectionSet(sessionId, true);
      if (!set) return 0;
      var added = 0;
      var firstId = '';
      for (var i = 0; i < messages.length; i += 1) {
        var message = messages[i];
        if (!isSelectableMessage(message)) continue;
        var id = normalizeId(message.id);
        if (!firstId) firstId = id;
        if (!set.has(id)) {
          set.add(id);
          added += 1;
        }
      }
      if (firstId && !state.ui.selectionAnchorBySession.get(sessionId)) {
        setAnchor(sessionId, firstId);
      }
      if (added > 0) {
        syncBarAfterMutation();
        renderAll();
      }
      return added;
    }

    function getSelectedMessageIds(options) {
      ensureUiState(state);
      var sessionId = options && options.sessionId
        ? normalizeId(options.sessionId)
        : normalizeId(getCurrentSessionId());
      if (!sessionId) return [];
      var set = state.ui.selectedMessageIdsBySession.get(sessionId);
      if (!(set instanceof Set)) return [];
      return Array.from(set);
    }

    function handleDocumentKeyDown(event) {
      if (!event) return;
      if (event.defaultPrevented) return;
      if (event.key !== 'Escape') return;
      if (!isSelectMode()) return;
      if (isTextInputTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      exitSelectMode();
    }

    function attach(registerListener, listenerOptions) {
      if (!doc) return noopFn;
      var register = typeof registerListener === 'function'
        ? registerListener
        : function (target, type, handler, opts) {
          target.addEventListener(type, handler, opts);
          return function () { target.removeEventListener(type, handler, opts); };
        };
      var detach = register(doc, 'keydown', handleDocumentKeyDown, listenerOptions || true);
      documentListenerCleanup = typeof detach === 'function' ? detach : noopFn;
      return function detachAll() {
        if (documentListenerCleanup) {
          documentListenerCleanup();
          documentListenerCleanup = null;
        }
      };
    }

    function onStreamStarted(payload) {
      void payload;
      if (isSelectMode()) exitSelectMode();
    }

    function onSessionSwitch(nextSessionId) {
      void nextSessionId;
      if (isSelectMode()) exitSelectMode();
    }

    function dispose() {
      if (documentListenerCleanup) {
        documentListenerCleanup();
        documentListenerCleanup = null;
      }
      ensureUiState(state);
      state.ui.selectionMode = false;
    }

    controller = {
      attach,
      dispose,
      isSelectMode,
      enterSelectMode,
      exitSelectMode,
      toggleMessage,
      selectRange,
      selectAll,
      getSelectedMessageIds,
      onStreamStarted,
      onSessionSwitch,
    };
    return controller;
  }

  return {
    createSelectionController,
    SKIPPED_KIND_SET,
  };
});
