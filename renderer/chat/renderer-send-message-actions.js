/* renderer/chat/renderer-send-message-actions.js -- message-level chat action handlers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendMessageActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createSendMessageActions(deps = {}) {
    const {
      appendClientLog = () => {},
      showComposerActionError = () => {},
      showCopyFeedback = () => {},
      getCurrentMessageById = () => null,
      getCurrentSessionMessages = () => [],
      getLatestReplyAssistantMessageId = () => '',
      getElaboratePrompt = () => '',
      resolveRegenerateRequest = () => ({ allowed: false }),
      resolveMessageCopyText = () => '',
      resolveFollowUpActionBlock = () => ({ blocked: false, reason: '' }),
      getCurrentSessionId = () => '',
      reconcileAcceptedRegenerate = () => false,
      startPromptSend = async () => null,
    } = deps;

    async function handleElaborateMessage(messageId) {
      const message = getCurrentMessageById(messageId);
      if (!message) {
        return null;
      }
      const followUpBlock = resolveFollowUpActionBlock();
      if (followUpBlock.blocked) {
        appendClientLog('INFO', 'chat.elaborate_blocked', {
          messageId,
          reason: followUpBlock.reason,
        });
        showComposerActionError(
          new Error(String(followUpBlock.reason || 'Elaborate is unavailable.')),
          'Elaborate Unavailable'
        );
        return null;
      }
      const prompt = getElaboratePrompt(message, {
        latestReplyAssistantMessageId: getLatestReplyAssistantMessageId(getCurrentSessionMessages()),
        followUpActionsBusy: false,
        followUpDisabledReason: '',
      });
      if (!prompt) {
        return null;
      }
      appendClientLog('INFO', 'chat.elaborate_requested', { messageId });
      return startPromptSend(prompt);
    }

    async function handleRegenerateMessage(messageId, options = {}) {
      const failureRetry = options.failureRetry === true;
      const followUpBlock = resolveFollowUpActionBlock();
      if (followUpBlock.blocked) {
        appendClientLog('INFO', 'chat.regenerate_blocked', {
          messageId,
          sourceMessageId: '',
          reason: followUpBlock.reason,
          hasTextAttachments: false,
          replayImageCount: 0,
        });
        showComposerActionError(
          new Error(String(followUpBlock.reason || 'Regenerate is unavailable.')),
          'Regenerate Unavailable'
        );
        return null;
      }
      const messages = getCurrentSessionMessages();
      const latestReplyAssistantMessageId = getLatestReplyAssistantMessageId(messages);
      const request = resolveRegenerateRequest(messageId, messages, {
        latestReplyAssistantMessageId,
        followUpActionsBusy: false,
        /* EH-W4: the latest failed turn is always a valid retry target. */
        allowErrorTarget: true,
      });

      if (!request.allowed) {
        appendClientLog('INFO', 'chat.regenerate_blocked', {
          messageId,
          sourceMessageId: request.sourceMessageId || '',
          reason: request.reason || '',
          hasTextAttachments: request.hasTextAttachments === true,
          replayImageCount: Array.isArray(request.replayImageAttachments)
            ? request.replayImageAttachments.length
            : 0,
        });
        showComposerActionError(
          new Error(String(request.reason || 'Regenerate is unavailable.')),
          'Regenerate Unavailable'
        );
        return null;
      }

      appendClientLog('INFO', 'chat.regenerate_requested', {
        messageId,
        sourceMessageId: request.sourceMessageId || '',
        promptLength: String(request.prompt || '').length,
        replayImageCount: request.replayImageAttachments.length,
      });
      const sessionId = String(getCurrentSessionId() || '').trim();
      const result = await startPromptSend(request.prompt, {
        visiblePrompt: request.visiblePrompt,
        replayImageAttachments: request.replayImageAttachments,
        preserveComposerDraft: true,
        editedMessageId: request.sourceMessageId,
        ...(failureRetry ? { failureRetry: true } : {}),
        sessionIdOverride: sessionId,
        onAuthoritativeStart: (startResult) => reconcileAcceptedRegenerate({
          sessionId,
          sourceMessageId: request.sourceMessageId,
          targetMessageId: request.targetMessageId,
          startResult,
          ...(failureRetry ? { failureRetry: true } : {}),
        }),
      });
      if (result?.streamId) {
        appendClientLog('INFO', 'chat.regenerate_replayed', {
          messageId,
          sourceMessageId: request.sourceMessageId || '',
          streamId: result.streamId,
          sessionId: result.sessionId,
          replayImageCount: request.replayImageAttachments.length,
        });
      }
      return result;
    }

    async function handleCopyMessage(messageId) {
      const message = getCurrentMessageById(messageId);
      if (!message) {
        return;
      }
      const text = resolveMessageCopyText(message);
      await window.jennyShell.clipboard.writeText(text);
      showCopyFeedback(messageId);
      appendClientLog('INFO', 'chat.message_copied', { messageId });
    }

    return {
      handleElaborateMessage,
      handleRegenerateMessage,
      handleCopyMessage,
    };
  }

  return { createSendMessageActions };
});
