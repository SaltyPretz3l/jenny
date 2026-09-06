/* renderer/chat/renderer-chat-message-edit-utils.js
 *
 * F2: in-line user-message edit + re-send controller. Owns the edit-mode
 * state machine on state.ui, the textarea event wiring (input + keydown), and
 * the atomic edit-and-regenerate orchestration.
 *
 * Semantics: replace-and-regenerate. Saving an edit issues one backend-owned
 * command through startPromptSend; the backend truncates and starts the
 * replacement generation under one ownership boundary.
 *
 * Disposal contract (AGENTS.md §5): dispose() drops textarea listeners and
 * clears state.ui.editing* fields; safe to call from app teardown.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererChatMessageEditUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  'use strict';

  var EDIT_STREAM_BUSY_REASON = 'Wait for the current response to finish before editing.';
  var EDIT_EMPTY_CONTENT_REASON = 'Edited message cannot be empty.';
  var EDIT_TEXT_ATTACHMENT_NOTICE = 'Text attachments will not be replayed for this edit.';

  function noopFn() { /* no-op */ }
  function noopAsync() { return Promise.resolve(null); }

  // CSS attribute-selector string escaping: backslash MUST be escaped before
  // quote, or a literal backslash in the id gets silently swallowed by the
  // selector parser (the value it matches against ends up missing the
  // backslash, so a correct id never matches). Shared by every attribute
  // lookup below so the escaping rule can't drift between callers.
  function escapeAttrSelectorValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Shared across F2 edit-and-regenerate AND F4 truncate-from-selection: the
  // single source of truth for which renderer caches must drop when a session's
  // message list shrinks. Adding a new cache here updates both callers.
  function purgeChatSessionCaches(state, sessionId, clearProjectionContextCacheForSession) {
    if (!state || !sessionId) return;
    try {
      if (state.turnEventsBySession && typeof state.turnEventsBySession.delete === 'function') {
        state.turnEventsBySession.delete(sessionId);
      }
    } catch (_) { /* ignore */ }
    try {
      if (state.messagesBySession && typeof state.messagesBySession.delete === 'function') {
        state.messagesBySession.delete(sessionId);
      }
    } catch (_) { /* ignore */ }
    if (typeof clearProjectionContextCacheForSession === 'function') {
      try { clearProjectionContextCacheForSession(sessionId); } catch (_) { /* ignore */ }
    }
    try {
      if (state.ui && state.ui.chatTimelineRowModelMetaBySession
        && typeof state.ui.chatTimelineRowModelMetaBySession.delete === 'function') {
        state.ui.chatTimelineRowModelMetaBySession.delete(sessionId);
      }
    } catch (_) { /* ignore */ }
    try {
      if (state.ui && state.ui.chatTimelineRowModelBySession
        && typeof state.ui.chatTimelineRowModelBySession.delete === 'function') {
        state.ui.chatTimelineRowModelBySession.delete(sessionId);
      }
    } catch (_) { /* ignore */ }
  }

  function defaultEnsureUiState(state) {
    if (!state.ui || typeof state.ui !== 'object') {
      state.ui = {};
    }
    if (typeof state.ui.editingMessageId !== 'string') {
      state.ui.editingMessageId = '';
    }
    if (typeof state.ui.editingDraftText !== 'string') {
      state.ui.editingDraftText = '';
    }
    if (typeof state.ui.editingOriginalText !== 'string') {
      state.ui.editingOriginalText = '';
    }
    if (typeof state.ui.editingSessionId !== 'string') {
      state.ui.editingSessionId = '';
    }
    if (typeof state.ui.editCommitting !== 'boolean') {
      state.ui.editCommitting = false;
    }
    if (!Number.isFinite(Number(state.ui.editingAffectedCount))) state.ui.editingAffectedCount = 0;
  }

  function createMessageEditController(deps) {
    var settings = deps || {};
    if (!settings.state || typeof settings.state !== 'object') {
      throw new TypeError('createMessageEditController requires `state`.');
    }
    var state = settings.state;
    var doc = settings.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) {
      throw new TypeError('createMessageEditController requires `document`.');
    }
    var getCurrentSessionMessages = typeof settings.getCurrentSessionMessages === 'function'
      ? settings.getCurrentSessionMessages
      : function () { return []; };
    var getCurrentSessionId = typeof settings.getCurrentSessionId === 'function'
      ? settings.getCurrentSessionId
      : function () { return ''; };
    var startPromptSend = typeof settings.startPromptSend === 'function'
      ? settings.startPromptSend
      : noopAsync;
    var renderAll = typeof settings.renderAll === 'function' ? settings.renderAll : noopFn;
    var appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog
      : noopFn;
    var showComposerActionError = typeof settings.showComposerActionError === 'function'
      ? settings.showComposerActionError
      : noopFn;
    var resolveFollowUpActionBlock = typeof settings.resolveFollowUpActionBlock === 'function'
      ? settings.resolveFollowUpActionBlock
      : function () { return { blocked: false }; };
    var clearProjectionContextCacheForSession =
      typeof settings.clearProjectionContextCacheForSession === 'function'
        ? settings.clearProjectionContextCacheForSession
        : noopFn;
    var buildReplayableImageAttachments =
      typeof settings.buildReplayableImageAttachments === 'function'
        ? settings.buildReplayableImageAttachments
        : function () { return []; };
    var hasTextAttachmentMetadata =
      typeof settings.hasTextAttachmentMetadata === 'function'
        ? settings.hasTextAttachmentMetadata
        : function () { return false; };
    var showToastMessage = typeof settings.showToastMessage === 'function'
      ? settings.showToastMessage
      : noopFn;
    var timelineVirtualizer = settings.timelineVirtualizer || null;

    var CANCEL_HIGHLIGHT_CLASS = 'chat-citation-target-highlight';
    var CANCEL_HIGHLIGHT_DURATION_MS = 1400;
    var wiredTextarea = null;
    var wiredTextareaListeners = null;
    var cancelHighlightTarget = null;
    var cancelHighlightTimer = null;
    var disposalFence = asyncFence.createDisposalFence();
    var editGeneration = asyncFence.createGenerationGate();

    defaultEnsureUiState(state);

    function findMessage(messageId) {
      var id = String(messageId || '').trim();
      if (!id) return null;
      var messages = getCurrentSessionMessages() || [];
      for (var i = 0; i < messages.length; i += 1) {
        if (String(messages[i] && messages[i].id || '') === id) {
          return messages[i];
        }
      }
      return null;
    }

    // Shared by findEntryByMessageId and syncFromState's textarea lookup:
    // try the direct attribute-selector query first (fast path for the
    // common case), then fall back to a linear scan + exact attribute
    // comparison if the selector throws (e.g. an id containing a raw
    // newline is not valid inside a CSS string) or simply misses.
    function findElementByAttrValue(selectorPrefix, attrName, messageId) {
      var id = String(messageId || '').trim();
      if (!id || !doc) return null;
      if (typeof doc.querySelector === 'function') {
        var safeId = escapeAttrSelectorValue(id);
        try {
          var found = doc.querySelector(selectorPrefix + '[' + attrName + '="' + safeId + '"]');
          if (found) return found;
        } catch (_) { /* fall back to linear scan */ }
      }
      if (typeof doc.querySelectorAll !== 'function') return null;
      var candidates = doc.querySelectorAll(selectorPrefix + '[' + attrName + ']');
      for (var i = 0; i < candidates.length; i += 1) {
        if (String(candidates[i].getAttribute(attrName) || '') === id) {
          return candidates[i];
        }
      }
      return null;
    }

    function findEntryByMessageId(messageId) {
      return findElementByAttrValue('.chat-entry', 'data-message-id', messageId);
    }

    function ensureEntryMounted(entry) {
      if (
        !entry
        || !timelineVirtualizer
        || typeof timelineVirtualizer.ensureMounted !== 'function'
        || entry.getAttribute('data-virtualized') !== 'true'
      ) {
        return;
      }
      try { timelineVirtualizer.ensureMounted(entry); } catch (_) { /* best-effort */ }
    }

    function restoreFocusToEntry(messageId) {
      var entry = findEntryByMessageId(messageId);
      if (!entry) return null;
      ensureEntryMounted(entry);
      entry = findEntryByMessageId(messageId) || entry;
      if (entry && typeof entry.focus === 'function') {
        var hadTabindex = typeof entry.hasAttribute === 'function'
          ? entry.hasAttribute('tabindex')
          : entry.getAttribute && entry.getAttribute('tabindex') !== null;
        var previousTabindex = entry.getAttribute ? entry.getAttribute('tabindex') : null;
        try {
          if (!hadTabindex && typeof entry.setAttribute === 'function') {
            entry.setAttribute('tabindex', '-1');
          }
          entry.focus({ preventScroll: true });
        } catch (_) { /* best-effort */ } finally {
          if (!hadTabindex && typeof entry.removeAttribute === 'function') {
            try { entry.removeAttribute('tabindex'); } catch (__e) { /* best-effort */ }
          } else if (hadTabindex && previousTabindex != null && typeof entry.setAttribute === 'function') {
            try { entry.setAttribute('tabindex', previousTabindex); } catch (__e2) { /* best-effort */ }
          }
        }
      }
      return entry;
    }

    function getWindowRef() {
      return settings.windowRef
        || doc.defaultView
        || (typeof window !== 'undefined' ? window : null)
        || (typeof globalThis !== 'undefined' ? globalThis : null);
    }

    function clearCancelHighlight() {
      var windowRef = getWindowRef();
      if (cancelHighlightTimer != null && windowRef && typeof windowRef.clearTimeout === 'function') {
        try { windowRef.clearTimeout(cancelHighlightTimer); } catch (_) { /* ignore */ }
      }
      cancelHighlightTimer = null;
      if (cancelHighlightTarget && cancelHighlightTarget.classList) {
        try { cancelHighlightTarget.classList.remove(CANCEL_HIGHLIGHT_CLASS); } catch (_) { /* ignore */ }
      }
      cancelHighlightTarget = null;
    }

    function applyCancelHighlight(entry) {
      if (!entry || !entry.classList) return;
      clearCancelHighlight();
      try {
        entry.classList.add(CANCEL_HIGHLIGHT_CLASS);
        cancelHighlightTarget = entry;
      } catch (_) {
        cancelHighlightTarget = null;
        return;
      }
      var windowRef = getWindowRef();
      if (windowRef && typeof windowRef.setTimeout === 'function') {
        cancelHighlightTimer = windowRef.setTimeout(clearCancelHighlight, CANCEL_HIGHLIGHT_DURATION_MS);
      }
    }

    function enterEdit(messageId) {
      defaultEnsureUiState(state);
      var id = String(messageId || '').trim();
      if (!id) return false;
      if (state.ui.editingMessageId) {
        // Already editing — re-entry on the same id is a no-op success; a
        // different id is refused silently (the lock-disabled hover-action
        // surfaces the reason).
        return state.ui.editingMessageId === id;
      }
      var block = resolveFollowUpActionBlock();
      if (block && block.blocked) {
        showComposerActionError(
          new Error(String(block.reason || EDIT_STREAM_BUSY_REASON)),
          'Edit Unavailable'
        );
        appendClientLog('INFO', 'chat.edit_blocked', {
          messageId: id,
          reason: String(block.reason || 'busy'),
        });
        return false;
      }
      var message = findMessage(id);
      if (!message || message.role !== 'user') {
        appendClientLog('INFO', 'chat.edit_blocked', {
          messageId: id,
          reason: 'not_user_message',
        });
        return false;
      }
      var sessionId = getCurrentSessionId();
      var original = typeof message.content === 'string' ? message.content : '';
      var messages = getCurrentSessionMessages() || [];
      var messageIndex = messages.findIndex(function (entry) { return String(entry?.id || '') === id; });
      editGeneration.bump();
      state.ui.editingMessageId = id;
      state.ui.editingOriginalText = original;
      state.ui.editingDraftText = original;
      state.ui.editingSessionId = String(sessionId || '');
      state.ui.editCommitting = false;
      state.ui.editingAffectedCount = messageIndex >= 0 ? messages.length - messageIndex : 1;
      appendClientLog('INFO', 'chat.edit_entered', {
        messageId: id,
        sessionId: String(sessionId || ''),
        contentLength: original.length,
      });
      try {
        renderAll();
      } catch (_) { /* renderAll failures shouldn't break the state machine */ }
      // After renderAll the textarea should exist; sync wires the listeners.
      syncFromState({ focus: true });
      return true;
    }

    function cancelEdit(options) {
      defaultEnsureUiState(state);
      var settings = options || {};
      var skipFocusRestore = settings.skipFocusRestore === true;
      var msgId = state.ui.editingMessageId;
      var sessionId = state.ui.editingSessionId;
      if (!msgId) return false;
      editGeneration.bump();
      state.ui.editingMessageId = '';
      state.ui.editingDraftText = '';
      state.ui.editingOriginalText = '';
      state.ui.editingSessionId = '';
      state.ui.editCommitting = false;
      state.ui.editingAffectedCount = 0;
      cleanupTextareaListeners();
      clearCancelHighlight();
      appendClientLog('INFO', 'chat.edit_cancelled', {
        messageId: String(msgId || ''),
        sessionId: String(sessionId || ''),
      });
      try {
        renderAll();
      } catch (_) { /* ignore */ }
      if (!skipFocusRestore) {
        applyCancelHighlight(restoreFocusToEntry(msgId));
      }
      return true;
    }

    function commitEdit() {
      defaultEnsureUiState(state);
      var msgId = state.ui.editingMessageId;
      var sessionId = state.ui.editingSessionId;
      if (!msgId || !sessionId) {
        return Promise.resolve(null);
      }
      if (state.ui.editCommitting === true) {
        appendClientLog('DEBUG', 'chat.edit_commit_ignored_pending', {
          messageId: msgId,
          sessionId: sessionId,
        });
        return Promise.resolve(null);
      }
      var block = resolveFollowUpActionBlock();
      if (block && block.blocked) {
        showComposerActionError(
          new Error(String(block.reason || EDIT_STREAM_BUSY_REASON)),
          'Edit Blocked'
        );
        appendClientLog('WARN', 'chat.edit_commit_blocked_by_stream', {
          messageId: msgId,
          sessionId: sessionId,
          reason: String(block.reason || 'busy'),
        });
        return Promise.resolve(null);
      }
      var draft = state.ui.editingDraftText;
      var original = state.ui.editingOriginalText;
      var trimmedDraft = String(draft || '').trim();
      if (String(draft || '') === String(original || '')) {
        appendClientLog('INFO', 'chat.edit_unchanged', { messageId: msgId, sessionId: sessionId });
        cancelEdit();
        return Promise.resolve(null);
      }
      var message = findMessage(msgId);
      var replayImageAttachments = message ? buildReplayableImageAttachments(message) : [];
      var hasReplayImages = Array.isArray(replayImageAttachments) && replayImageAttachments.length > 0;
      if (!trimmedDraft && !hasReplayImages) {
        showComposerActionError(new Error(EDIT_EMPTY_CONTENT_REASON), 'Edit Unavailable');
        return Promise.resolve(null);
      }
      var hadTextAttachments = message ? hasTextAttachmentMetadata(message) === true : false;
      if (hadTextAttachments) {
        try {
          showToastMessage({ message: EDIT_TEXT_ATTACHMENT_NOTICE, kind: 'warning' });
        } catch (_) { /* toast best-effort */ }
      }
      state.ui.editCommitting = true;
      try {
        renderAll();
      } catch (_) { /* ignore */ }

      var commitToken = editGeneration.capture();
      function isCurrentCommit() {
        return !disposalFence.isDisposed()
          && editGeneration.isCurrent(commitToken)
          && state.ui.editingMessageId === msgId
          && state.ui.editingSessionId === sessionId;
      }
      var authoritativeStartAccepted = false;
      function acceptAuthoritativeStart(result) {
        if (authoritativeStartAccepted) return true;
        if (!isCurrentCommit()) return false;
        var authoritativeUserMessageId = String(
          result && result.identity && result.identity.userMessageId || ''
        ).trim();
        if (
          !result
          || !String(result.streamId || '').trim()
          || authoritativeUserMessageId !== String(msgId)
        ) {
          return false;
        }

        reconcileRendererStateForCommittedEdit(sessionId, msgId, draft);
        state.ui.editingMessageId = '';
        state.ui.editingDraftText = '';
        state.ui.editingOriginalText = '';
        state.ui.editingSessionId = '';
        state.ui.editCommitting = false;
        state.ui.editingAffectedCount = 0;
        cleanupTextareaListeners();
        authoritativeStartAccepted = true;
        appendClientLog('INFO', 'chat.edit_committed', {
          messageId: msgId,
          sessionId: sessionId,
          newLength: String(draft || '').length,
          replayImageCount: replayImageAttachments.length,
        });
        appendClientLog('INFO', 'chat.edit_replayed', {
          messageId: msgId,
          sessionId: sessionId,
          streamId: result.streamId,
          userMessageId: authoritativeUserMessageId,
        });
        try {
          renderAll();
        } catch (_) { /* ignore */ }
        return true;
      }

      return Promise.resolve().then(function () {
        if (!isCurrentCommit()) return null;
        return startPromptSend(String(draft || ''), {
          visiblePrompt: String(draft || ''),
          replayImageAttachments: replayImageAttachments,
          preserveComposerDraft: true,
          editedMessageId: msgId,
          sessionIdOverride: sessionId,
          // The real send controller invokes this immediately after the atomic
          // backend start returns its authoritative identity, before buffered
          // stream events are flushed into the newly truncated renderer state.
          onAuthoritativeStart: acceptAuthoritativeStart,
        });
      }).then(function (result) {
        if (authoritativeStartAccepted) {
          return result;
        }
        if (!isCurrentCommit()) return null;
        if (!acceptAuthoritativeStart(result)) {
          appendClientLog('WARN', 'chat.edit_start_refused', {
            messageId: msgId,
            sessionId: sessionId,
            reason: result ? 'invalid_authoritative_identity' : 'start_failed',
          });
          state.ui.editCommitting = false;
          try {
            renderAll();
          } catch (_) { /* ignore */ }
          syncFromState();
          return null;
        }
        return result;
      }).catch(function (error) {
        if (!isCurrentCommit()) return null;
        appendClientLog('ERROR', 'chat.edit_failed', {
          messageId: msgId,
          sessionId: sessionId,
          message: (error && error.message) ? error.message : String(error),
        });
        state.ui.editCommitting = false;
        try {
          renderAll();
        } catch (_) { /* ignore */ }
        syncFromState();
        showComposerActionError(error, 'Edit Failed');
        return null;
      });
    }

    function invalidateRendererCachesForSession(sessionId) {
      purgeChatSessionCaches(state, sessionId, clearProjectionContextCacheForSession);
    }

    function reconcileRendererStateForCommittedEdit(sessionId, messageId, content) {
      var normalizedSessionId = String(sessionId || '');
      var normalizedMessageId = String(messageId || '');
      var messages = state.messagesBySession instanceof Map
        ? state.messagesBySession.get(normalizedSessionId)
        : null;
      var nextMessages = null;
      if (Array.isArray(messages)) {
        var anchorIndex = messages.findIndex(function (entry) {
          return String(entry && entry.id || '') === normalizedMessageId;
        });
        if (anchorIndex >= 0) {
          var anchor = messages[anchorIndex] || {};
          var imageAttachments = Array.isArray(anchor.attachments)
            ? anchor.attachments.filter(function (attachment) {
                var kind = String(attachment && attachment.kind || '').trim().toLowerCase();
                var mimeType = String(
                  attachment && (attachment.mime_type || attachment.mimeType) || ''
                ).trim().toLowerCase();
                return kind === 'image' || mimeType.indexOf('image/') === 0;
              })
            : [];
          nextMessages = messages.slice(0, anchorIndex).concat([{
            ...anchor,
            content: String(content || ''),
            attachments: imageAttachments,
          }]);
        }
      }
      invalidateRendererCachesForSession(normalizedSessionId);
      if (nextMessages && state.messagesBySession instanceof Map) {
        state.messagesBySession.set(normalizedSessionId, nextMessages);
      }
    }

    function cleanupTextareaListeners() {
      if (!wiredTextarea || !wiredTextareaListeners) {
        wiredTextarea = null;
        wiredTextareaListeners = null;
        return;
      }
      if (typeof wiredTextarea.removeEventListener === 'function') {
        try { wiredTextarea.removeEventListener('input', wiredTextareaListeners.input); } catch (_) { /* ignore */ }
        try { wiredTextarea.removeEventListener('keydown', wiredTextareaListeners.keydown); } catch (_) { /* ignore */ }
      }
      wiredTextarea = null;
      wiredTextareaListeners = null;
    }

    function wireTextareaListeners(textarea) {
      if (!textarea) {
        cleanupTextareaListeners();
        return;
      }
      if (wiredTextarea === textarea) return;
      cleanupTextareaListeners();
      var onInput = function () {
        defaultEnsureUiState(state);
        if (!state.ui.editingMessageId) return;
        var nextValue = String(textarea.value || '');
        state.ui.editingDraftText = nextValue;
      };
      var onKeydown = function (event) {
        if (!event) return;
        var key = String(event.key || '');
        // IME composition guard: while an IME composition is active, some
        // IMEs use Escape to dismiss the candidate popup. Let the IME
        // consume it instead of cancelling the whole edit. keyCode 229 is
        // the legacy in-composition keystroke signal.
        var isComposing = event.isComposing === true || event.keyCode === 229;
        if ((key === 'Escape' || key === 'Esc') && !isComposing) {
          event.preventDefault();
          event.stopPropagation();
          cancelEdit();
          return;
        }
        if (key === 'Enter') {
          if (!event.ctrlKey && !event.metaKey) {
            // Multiline editor contract: Enter inserts a newline;
            // Ctrl/Cmd+Enter is the deliberate commit chord.
            return;
          }
          // The Enter that commits/selects an IME candidate (CJK,
          // Vietnamese Telex, dead-key accents, …) also fires here.
          // Without this guard, committing a candidate would save +
          // resend the edit mid-composition.
          if (isComposing) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          commitEdit();
        }
      };
      textarea.addEventListener('input', onInput);
      textarea.addEventListener('keydown', onKeydown);
      wiredTextarea = textarea;
      wiredTextareaListeners = {
        input: onInput,
        keydown: onKeydown,
      };
    }

    function syncFromState(options) {
      defaultEnsureUiState(state);
      var settings = options || {};
      var shouldFocus = settings.focus === true;
      var msgId = state.ui.editingMessageId;
      if (!msgId) return;
      if (!doc) return;
      var textarea = findElementByAttrValue('textarea', 'data-edit-target-message-id', msgId);
      if (!textarea) return;
      wireTextareaListeners(textarea);
      // Re-mirror the draft into the textarea if the renderer rebuilt the markup
      // with the original text (e.g. first render after enterEdit).
      if (typeof textarea.value === 'string' && textarea.value !== state.ui.editingDraftText) {
        var selectionStart = Number(textarea.selectionStart);
        var selectionEnd = Number(textarea.selectionEnd);
        textarea.value = state.ui.editingDraftText;
        if (!shouldFocus && typeof textarea.setSelectionRange === 'function'
          && Number.isFinite(selectionStart) && Number.isFinite(selectionEnd)) {
          var nextLength = String(state.ui.editingDraftText || '').length;
          try {
            textarea.setSelectionRange(
              Math.max(0, Math.min(selectionStart, nextLength)),
              Math.max(0, Math.min(selectionEnd, nextLength))
            );
          } catch (_) { /* selection restore is best-effort */ }
        }
      }
      if (shouldFocus && typeof textarea.focus === 'function') {
        try {
          textarea.focus();
          if (typeof textarea.select === 'function') {
            textarea.select();
          }
        } catch (_) { /* focus best-effort */ }
      }
    }

    function getDraft() {
      defaultEnsureUiState(state);
      return {
        messageId: state.ui.editingMessageId || '',
        sessionId: state.ui.editingSessionId || '',
        draftText: state.ui.editingDraftText || '',
        originalText: state.ui.editingOriginalText || '',
        committing: state.ui.editCommitting === true,
      };
    }

    function isEditing(messageId) {
      defaultEnsureUiState(state);
      if (!messageId) return state.ui.editingMessageId !== '';
      return state.ui.editingMessageId === String(messageId);
    }

    function dispose() {
      // Best-effort cleanup. Tab navigation aborts the listeners on its own
      // when the textarea is removed from the DOM, so we just clear state.
      editGeneration.bump();
      disposalFence.dispose();
      defaultEnsureUiState(state);
      state.ui.editingMessageId = '';
      state.ui.editingDraftText = '';
      state.ui.editingOriginalText = '';
      state.ui.editingSessionId = '';
      state.ui.editCommitting = false;
      state.ui.editingAffectedCount = 0;
      cleanupTextareaListeners();
      clearCancelHighlight();
    }

    return {
      enterEdit: enterEdit,
      cancelEdit: cancelEdit,
      commitEdit: commitEdit,
      syncFromState: syncFromState,
      getDraft: getDraft,
      isEditing: isEditing,
      dispose: dispose,
    };
  }

  return {
    createMessageEditController: createMessageEditController,
    purgeChatSessionCaches: purgeChatSessionCaches,
    EDIT_STREAM_BUSY_REASON: EDIT_STREAM_BUSY_REASON,
    EDIT_EMPTY_CONTENT_REASON: EDIT_EMPTY_CONTENT_REASON,
    EDIT_TEXT_ATTACHMENT_NOTICE: EDIT_TEXT_ATTACHMENT_NOTICE,
  };
});
