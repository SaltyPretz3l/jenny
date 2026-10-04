/* renderer/chat/renderer-chat-selection-utils.js
 *
 * F4/F5/F6: multi-select state machine for the chat timeline. Owns
 * state.ui.selectionModePaneId + the per-session selected-message-id sets +
 * the per-session range-select anchor. Exposes enter/exit/toggle/range/
 * selectAll/clear/get APIs consumed by:
 *   - the inventory selection-handle click branch in renderer-chat-event-transcript-bindings.js
 *   - the keyboard shortcuts (Esc/Ctrl+A/Delete) wired in renderer-chat-keyboard-utils.js
 *   - the selection-action-bar mount in wireChatAccessibility (renderer-chat-accessibility-wiring.js)
 *   - the bulk-actions controller in renderer-chat-bulk-actions-utils.js
 *
 * Disposal contract (AGENTS.md §5): dispose() removes the Esc listener
 * registered by attach() and, when its pane owns the mode, clears
 * state.ui.selectionModePaneId. Per-session Sets / anchors persist on state.ui
 * across dispose for cache reasons — a re-attach picks them up unchanged.
 * session-switch + stream-start drop selection mode when their pane owns it.
 *
 * Split view W3-1: selection mode has ONE owner, `state.ui.selectionModePaneId`
 * (null = off). A controller is bound to a pane (`paneId`, default 0); a pane
 * renders checkboxes and its action bar only while it owns the mode
 * (`isPaneSelecting(state, paneId)`), so one pane selecting leaves the other
 * pane's transcript untouched.
 *
 * W3-1 also gives the mode its entry, the one the help overlay promises
 * ("Shift+Click: enter selection mode (or extend the range)"):
 * attachTimeline(timeline, ...) binds the pane's own timeline so a Shift+Click
 * on a message article enters THAT pane's mode with the message selected, and
 * while selecting extends the range from the last clicked message. Controls
 * (links, buttons, fields, the checkbox handle) keep their own click.
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
  // A Shift+Click on any of these is the control's, not a selection gesture;
  // the checkbox handle has its own click path (transcript bindings).
  var SHIFT_CLICK_EXCLUDED_SELECTOR = [
    'a', 'button', 'input', 'textarea', 'select', 'option', 'label', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]', '[role="button"]', '[role="link"]',
    '[role="menuitem"]', '[role="checkbox"]', '[data-select-message-id]', '.inv-codeblock-copy',
  ].join(', ');

  function noopFn() { /* no-op */ }

  var normalizeId = stringUtils && typeof stringUtils.normalizeId === 'function'
    ? stringUtils.normalizeId
    : function (value) { return String(value || '').trim(); };

  function ensureUiState(state) {
    if (!state.ui || typeof state.ui !== 'object') {
      state.ui = {};
    }
    if (!isPaneIdValue(state.ui.selectionModePaneId)) {
      state.ui.selectionModePaneId = null;
    }
    if (!(state.ui.selectedMessageIdsBySession instanceof Map)) {
      state.ui.selectedMessageIdsBySession = new Map();
    }
    if (!(state.ui.selectionAnchorBySession instanceof Map)) {
      state.ui.selectionAnchorBySession = new Map();
    }
  }

  function isPaneIdValue(value) {
    return Number.isInteger(value) && value >= 0;
  }

  // Does pane `paneId` own selection mode? Read-only (no ensureUiState), so a
  // render pipeline can ask on every frame without writing state.
  function isPaneSelecting(state, paneId) {
    var owner = state && state.ui ? state.ui.selectionModePaneId : null;
    return isPaneIdValue(owner) && owner === (isPaneIdValue(paneId) ? paneId : 0);
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

  // Split view W2-3/W3-1: every pane's controller over one state is a peer, so
  // an ownership change (an exit, or another pane taking the mode) re-syncs
  // every live controller's action bar, not only the acting pane's.
  var peersByState = new WeakMap();
  function syncPeerBars(state) {
    var peers = peersByState.get(state);
    if (!peers) return;
    peers.forEach(function (peer) {
      if (typeof peer.syncActionBar === 'function') {
        try { peer.syncActionBar(); } catch (_e) { /* best-effort */ }
      }
    });
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
    var paneId = isPaneIdValue(settings.paneId) ? settings.paneId : 0;
    ensureUiState(state);

    var documentListenerCleanup = null;
    var timelineListenerCleanup = null;
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
      return isPaneSelecting(state, paneId);
    }

    // Taking the mode from another pane drops that pane's selection first
    // (one owner, one selection), then re-syncs its bar.
    function enterSelectMode() {
      ensureUiState(state);
      if (isPaneSelecting(state, paneId)) return false;
      var takenFromPeer = state.ui.selectionModePaneId !== null;
      if (takenFromPeer) {
        state.ui.selectedMessageIdsBySession.clear();
        state.ui.selectionAnchorBySession.clear();
      }
      state.ui.selectionModePaneId = paneId;
      appendClientLog('INFO', 'chat.selection_mode_entered', {});
      if (takenFromPeer) syncPeerBars(state);
      else syncBarAfterMutation();
      renderAll();
      return true;
    }

    function exitSelectMode() {
      ensureUiState(state);
      if (!isPaneSelecting(state, paneId)) return false;
      state.ui.selectionModePaneId = null;
      state.ui.selectedMessageIdsBySession.clear();
      state.ui.selectionAnchorBySession.clear();
      appendClientLog('INFO', 'chat.selection_mode_exited', {});
      syncPeerBars(state);
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

    // The message id a Shift+Click on `timeline` names, or '' when the gesture
    // is not a selection one (no Shift, another modifier or button, a control,
    // no article, an article outside this pane's timeline, a skipped kind).
    function resolveShiftClickMessageId(event, timeline) {
      if (!event || event.shiftKey !== true || event.button !== 0) return '';
      if (event.ctrlKey || event.metaKey || event.altKey) return '';
      // Extending a live text selection stays native until the mode is on.
      var textSelection = !isSelectMode() && doc && typeof doc.getSelection === 'function' ? doc.getSelection() : null;
      if (textSelection && textSelection.isCollapsed === false && String(textSelection).length > 0) return '';
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return '';
      if (target.closest(SHIFT_CLICK_EXCLUDED_SELECTOR)) return '';
      var article = target.closest('article[data-message-id]');
      if (!article || (timeline && typeof timeline.contains === 'function' && !timeline.contains(article))) return '';
      var messageId = normalizeId(article.getAttribute('data-message-id'));
      if (!messageId) return '';
      var messages = getCurrentSessionMessages() || [];
      for (var i = 0; i < messages.length; i += 1) {
        if (normalizeId(messages[i] && messages[i].id) === messageId) {
          return isSelectableMessage(messages[i]) ? messageId : '';
        }
      }
      return messageId;
    }

    // Enter this pane's mode with the message selected, or (already selecting)
    // extend from the last clicked message to it; the clicked message becomes
    // the next range's start.
    function shiftClickMessage(messageId) {
      var targetId = normalizeId(messageId);
      if (!targetId) return false;
      if (!isSelectMode()) {
        enterSelectMode();
        var set = getSelectionSet(getCurrentSessionId(), false);
        if (!set || !set.has(targetId)) toggleMessage(targetId);
        else setAnchor(getCurrentSessionId(), targetId);
        return true;
      }
      selectRange(targetId);
      setAnchor(getCurrentSessionId(), targetId);
      return true;
    }

    // Binds the pane's own timeline: the mousedown is cancelled only when the
    // click will select (so the first Shift+Click starts no native text
    // selection), and the click enters or extends. Returns the detach.
    function attachTimeline(timeline, registerListener, listenerOptions) {
      if (!timeline || typeof timeline.addEventListener !== 'function') return noopFn;
      var register = typeof registerListener === 'function'
        ? registerListener
        : function (target, type, handler, opts) {
          target.addEventListener(type, handler, opts);
          return function () { target.removeEventListener(type, handler, opts); };
        };
      var detachMouseDown = register(timeline, 'mousedown', function onShiftMouseDown(event) {
        if (resolveShiftClickMessageId(event, timeline)) event.preventDefault();
      }, listenerOptions);
      var detachClick = register(timeline, 'click', function onShiftClick(event) {
        var messageId = resolveShiftClickMessageId(event, timeline);
        if (!messageId) return;
        event.preventDefault();
        shiftClickMessage(messageId);
      }, listenerOptions);
      return function detachTimeline() {
        if (typeof detachMouseDown === 'function') detachMouseDown();
        if (typeof detachClick === 'function') detachClick();
      };
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

    // `timeline` (optional, W3-1): the pane's own timeline, bound for the
    // Shift+Click entry after the document Esc listener.
    function attach(registerListener, listenerOptions, timeline) {
      if (!doc) return noopFn;
      var register = typeof registerListener === 'function'
        ? registerListener
        : function (target, type, handler, opts) {
          target.addEventListener(type, handler, opts);
          return function () { target.removeEventListener(type, handler, opts); };
        };
      var detach = register(doc, 'keydown', handleDocumentKeyDown, listenerOptions || true);
      documentListenerCleanup = typeof detach === 'function' ? detach : noopFn;
      timelineListenerCleanup = timeline ? attachTimeline(timeline, register, listenerOptions) : null;
      return function detachAll() {
        if (documentListenerCleanup) {
          documentListenerCleanup();
          documentListenerCleanup = null;
        }
        if (timelineListenerCleanup) {
          timelineListenerCleanup();
          timelineListenerCleanup = null;
        }
      };
    }

    // A stream start or session switch reaches the controller of the pane it
    // belongs to; it exits only when that pane owns the mode.
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
      if (timelineListenerCleanup) {
        timelineListenerCleanup();
        timelineListenerCleanup = null;
      }
      ensureUiState(state);
      if (peersByState.has(state)) peersByState.get(state).delete(controller);
      if (!isPaneSelecting(state, paneId)) return;
      state.ui.selectionModePaneId = null;
      syncPeerBars(state);
    }

    controller = {
      attach,
      attachTimeline,
      shiftClickMessage,
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
    if (!peersByState.has(state)) peersByState.set(state, new Set());
    peersByState.get(state).add(controller);
    return controller;
  }

  return {
    createSelectionController,
    isPaneSelecting,
    SKIPPED_KIND_SET,
  };
});
