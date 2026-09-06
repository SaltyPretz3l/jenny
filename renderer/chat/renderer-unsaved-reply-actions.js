/* Persistent unsaved-reply affordance + controller (UMD).
 *
 * The backend may return a successful assistant reply before its durable write
 * succeeds. That reply remains useful, but must stay visibly marked until an
 * additive save retry succeeds or the user explicitly discards it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/badge'),
      require('../inventory/action-button')
    );
    return;
  }
  root.rendererUnsavedReplyActions = factory(
    root.inventoryBadge,
    root.inventoryActionButton
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (badge, actionButton) {
  'use strict';

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function renderUnsavedReplyNotice(message, model) {
    const unsavedReply = model && model.unsavedReply;
    const messageId = normalizeId(message && message.id);
    if (!unsavedReply || unsavedReply.visible !== true || !messageId) {
      return '';
    }
    const artifactId = normalizeId(unsavedReply.artifactId);
    const recoveryUnavailable = !artifactId;
    const recoveryUnavailableReason =
      'Recovery controls are unavailable because the repair record could not be saved.';
    const dataset = (action) => ({
      'unsaved-reply-action': action,
      'message-id': messageId,
      'artifact-id': artifactId,
    });
    const retryButton = actionButton({
      label: 'Retry save',
      variant: 'ghost',
      size: 'sm',
      className: 'chat-unsaved-reply-action',
      ariaLabel: recoveryUnavailable
        ? `Retry saving this reply (${recoveryUnavailableReason})`
        : 'Retry saving this reply',
      title: recoveryUnavailable ? recoveryUnavailableReason : 'Retry saving this reply',
      disabled: recoveryUnavailable,
      dataset: dataset('retry'),
    });
    const copyButton = actionButton({
      label: 'Copy',
      variant: 'ghost',
      size: 'sm',
      className: 'chat-unsaved-reply-action',
      ariaLabel: 'Copy this unsaved reply',
      title: 'Copy this reply',
      dataset: dataset('copy'),
    });
    const discardButton = actionButton({
      label: 'Discard',
      variant: 'danger',
      size: 'sm',
      className: 'chat-unsaved-reply-action',
      ariaLabel: recoveryUnavailable
        ? `Discard this unsaved reply (${recoveryUnavailableReason})`
        : 'Discard this unsaved reply',
      title: recoveryUnavailable ? recoveryUnavailableReason : 'Discard this unsaved reply',
      disabled: recoveryUnavailable,
      dataset: dataset('discard'),
    });
    return `
      <div class="chat-unsaved-reply-notice" data-unsaved-reply-notice="true" data-message-id="${actionButton.escapeHtml(messageId)}">
        <div class="chat-unsaved-reply-state">
          ${badge({ tone: 'warning', size: 'sm', text: 'Unsaved', className: 'chat-unsaved-reply-badge' })}
          <span class="chat-unsaved-reply-detail">Not yet saved to chat history.</span>
        </div>
        <div class="chat-unsaved-reply-actions" role="group" aria-label="Unsaved reply actions">
          ${retryButton}${copyButton}${discardButton}
        </div>
      </div>
    `;
  }

  function isSuccessfulDurabilityResult(result) {
    return Boolean(result && result.ok === true && result.durable === true);
  }

  function clearUnsavedDurability(message) {
    if (!message || typeof message !== 'object') {
      return message;
    }
    const next = { ...message };
    delete next.durability;
    return next;
  }

  function messageMatchesId(message, messageId) {
    const target = normalizeId(messageId);
    return Boolean(target && [
      message && message.id,
      message && message.client_message_id,
      message && message.clientMessageId,
    ].some((value) => normalizeId(value) === target));
  }

  function updateCachedMessage(state, sessionId, messageId, updater) {
    const store = state && state.messagesBySession;
    const messages = store instanceof Map ? store.get(sessionId) : null;
    if (!Array.isArray(messages)) {
      return false;
    }
    const index = messages.findIndex((message) => messageMatchesId(message, messageId));
    if (index < 0) {
      return false;
    }
    const next = messages.slice();
    next[index] = updater(messages[index]);
    store.set(sessionId, next);
    return true;
  }

  function removeCachedMessage(state, sessionId, messageIds) {
    const store = state && state.messagesBySession;
    const messages = store instanceof Map ? store.get(sessionId) : null;
    if (!Array.isArray(messages)) {
      return false;
    }
    const ids = (Array.isArray(messageIds) ? messageIds : [])
      .map(normalizeId)
      .filter(Boolean);
    const next = messages.filter((message) => !ids.some((id) => messageMatchesId(message, id)));
    if (next.length === messages.length) {
      return false;
    }
    store.set(sessionId, next);
    return true;
  }

  function setNoticeBusy(target, busy) {
    const notice = target && target.closest
      ? target.closest('[data-unsaved-reply-notice]')
      : null;
    if (!notice) {
      return;
    }
    notice.dataset.busy = busy ? 'true' : 'false';
    notice.querySelectorAll('[data-unsaved-reply-action]').forEach((button) => {
      button.disabled = Boolean(busy);
      if (busy) {
        button.setAttribute('aria-disabled', 'true');
      } else {
        button.removeAttribute('aria-disabled');
      }
    });
  }

  function createUnsavedReplyActionController(deps = {}) {
    const {
      state = {},
      windowRef = typeof window !== 'undefined' ? window : null,
      handleCopyMessage = () => Promise.resolve(),
      appendClientLog = () => {},
      onResolved = () => Promise.resolve(),
    } = deps;
    const pending = new Set();

    function buildFailure(action, result) {
      const reason = normalizeId(result && result.reason) || 'durability_not_confirmed';
      const error = new Error(action === 'retry'
        ? 'Jenny could not save this reply yet.'
        : 'Jenny could not discard this reply.');
      error.code = reason;
      return error;
    }

    function applyRetrySuccess(target, payload, result) {
      const returnedMessage = result.message
        && typeof result.message === 'object'
        && normalizeId(result.message.id || result.message.client_message_id || result.message.clientMessageId)
        ? clearUnsavedDurability(result.message)
        : null;
      updateCachedMessage(state, payload.sessionId, payload.messageId, (current) => (
        returnedMessage || clearUnsavedDurability(current)
      ));
      target.closest('[data-unsaved-reply-notice]')?.remove();
    }

    function applyDiscardSuccess(target, payload, result) {
      removeCachedMessage(state, payload.sessionId, [
        payload.messageId,
        result.removedMessageId,
      ]);
      const entry = target.closest('.chat-entry[data-message-id]');
      if (entry) {
        entry.remove();
      } else {
        target.closest('[data-unsaved-reply-notice]')?.remove();
      }
    }

    async function dispatch(target) {
      const action = normalizeId(target && target.dataset && target.dataset.unsavedReplyAction);
      const messageId = normalizeId(target && target.dataset && target.dataset.messageId);
      if (!action || !messageId) {
        return false;
      }
      if (action === 'copy') {
        await handleCopyMessage(messageId);
        return true;
      }
      if (action !== 'retry' && action !== 'discard') {
        return false;
      }
      const sessionId = normalizeId(state && state.currentSessionId);
      const artifactId = normalizeId(target && target.dataset && target.dataset.artifactId);
      if (!artifactId) {
        throw new Error('Unsaved reply recovery is unavailable because its repair record is missing.');
      }
      if (!sessionId) {
        throw new Error('Open the reply session before using recovery controls.');
      }
      const pendingKey = `${sessionId}:${artifactId}`;
      if (pending.has(pendingKey)) {
        return false;
      }
      const methodName = action === 'retry' ? 'retryUnsavedReply' : 'discardUnsavedReply';
      const method = windowRef && windowRef.jennyShell && windowRef.jennyShell.chat
        ? windowRef.jennyShell.chat[methodName]
        : null;
      if (typeof method !== 'function') {
        throw new Error('Unsaved reply recovery is unavailable.');
      }
      const payload = { sessionId, messageId, artifactId };
      pending.add(pendingKey);
      setNoticeBusy(target, true);
      try {
        const result = await method(payload);
        if (!isSuccessfulDurabilityResult(result)) {
          throw buildFailure(action, result);
        }
        if (action === 'retry') {
          applyRetrySuccess(target, payload, result);
        } else {
          applyDiscardSuccess(target, payload, result);
        }
        try {
          await onResolved({ action, payload, result });
        } catch (refreshError) {
          appendClientLog('WARN', 'chat.unsaved_reply_refresh_failed', {
            sessionId: sessionId.slice(0, 30),
            messageId: messageId.slice(0, 30),
            code: normalizeId(refreshError && refreshError.code) || 'refresh_failed',
          });
        }
        appendClientLog('INFO', `chat.unsaved_reply_${action}_completed`, {
          sessionId: sessionId.slice(0, 30),
          messageId: messageId.slice(0, 30),
        });
        return true;
      } catch (error) {
        setNoticeBusy(target, false);
        appendClientLog('WARN', `chat.unsaved_reply_${action}_failed`, {
          sessionId: sessionId.slice(0, 30),
          messageId: messageId.slice(0, 30),
          code: normalizeId(error && error.code) || 'unknown',
        });
        throw error;
      } finally {
        pending.delete(pendingKey);
      }
    }

    return { dispatch };
  }

  return {
    createUnsavedReplyActionController,
    isSuccessfulDurabilityResult,
    renderUnsavedReplyNotice,
  };
});
