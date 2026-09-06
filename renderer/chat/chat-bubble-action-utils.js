(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.chatBubbleActionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const _stringUtils = typeof globalThis !== 'undefined' && typeof globalThis.stringUtils !== 'undefined' ? globalThis.stringUtils
    : typeof require === 'function' ? require('../shared/string-utils')
    : { normalizeString: function (v) { return String(v || '').trim(); }, normalizeId: function (v) { return String(v || '').trim(); } };
  const { normalizeString, normalizeId } = _stringUtils;
  const _terminalStatusVocabulary = typeof globalThis !== 'undefined' && typeof globalThis.chatTerminalStatusVocabulary !== 'undefined'
    ? globalThis.chatTerminalStatusVocabulary
    : typeof require === 'function' ? require('./chat-terminal-status-vocabulary')
    : null;
  const { normalizeTerminalStatus, coarseRenderStatus } = _terminalStatusVocabulary;

  const STREAMING_STATUS = 'streaming';
  const COMPLETE_STATUS = 'complete';
  const ERROR_STATUS = 'error';
  const ELABORATE_PROMPT = 'Can you elaborate on that?';
  const FOLLOW_UP_ACTION_BUSY_REASON =
    'Wait for the current response to finish before trying that.';
  const FOLLOW_UP_AUTH_BLOCKED_REASON =
    'Sign in before trying that.';
  const FOLLOW_UP_BACKEND_NOT_READY_REASON =
    'Wait for Jenny to finish connecting before trying that.';
  const REGENERATE_DISABLED_REASON =
    'Regenerate is only available for the latest assistant reply.';
  const REGENERATE_MISSING_SOURCE_REASON =
    'Could not find the source prompt for this reply.';
  const REGENERATE_TEXT_ATTACHMENTS_REASON =
    'Regenerate cannot replay text file attachments yet.';
  const EDIT_DISABLED_REASON_DURING_EDIT = 'Finish the current edit first.';
  const NON_REPLY_ASSISTANT_KINDS = new Set([
    'interactive_round_recap',
    'proactive_suggestion',
    'question_batch',
    'slash_command_output',
    'tool_use',
  ]);

  // Unrecognized statuses fail closed to 'unknown'; eligibility only accepts complete/error.
  function normalizeMessageStatus(message) {
    const status = normalizeString(message?.status);
    if (!status) {
      return COMPLETE_STATUS;
    }
    return coarseRenderStatus(normalizeTerminalStatus(status));
  }

  function isReplyEligibleAssistantMessage(message) {
    const source = message || {};
    const role = normalizeString(source.role);
    const kind = normalizeString(source.kind);
    const status = normalizeMessageStatus(source);
    return role === 'assistant'
      && status === COMPLETE_STATUS
      && !NON_REPLY_ASSISTANT_KINDS.has(kind);
  }

  function getLatestReplyAssistantMessageId(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (isReplyEligibleAssistantMessage(list[index])) {
        return normalizeId(list[index].id);
      }
    }
    return '';
  }

  /* A failed assistant message is retryable only when it is the session's last assistant message; newer assistant output makes it stale. */
  function isRetryEligibleFailedAssistantMessage(message, list, targetIndex) {
    const source = message || {};
    if (normalizeString(source.role) !== 'assistant') return false;
    if (NON_REPLY_ASSISTANT_KINDS.has(normalizeString(source.kind))) return false;
    if (normalizeMessageStatus(source) !== ERROR_STATUS) return false;
    for (let index = list.length - 1; index > targetIndex; index -= 1) {
      if (normalizeString(list[index]?.role) === 'assistant') return false;
    }
    return true;
  }

  function buildReplayableImageAttachments(message) {
    return (Array.isArray(message?.attachments) ? message.attachments : [])
      .filter((attachment) => normalizeString(attachment?.kind) === 'image')
      .map((attachment) => ({
        id: normalizeId(attachment?.id),
        kind: 'image',
        displayName: normalizeString(attachment?.displayName),
        mimeType: normalizeString(attachment?.mimeType),
        sizeBytes: Math.max(Number(attachment?.sizeBytes || 0), 0),
        width: Math.max(Number(attachment?.width || 0), 0),
        height: Math.max(Number(attachment?.height || 0), 0),
        assetPath: normalizeString(attachment?.assetPath),
        sourceKind: normalizeString(attachment?.sourceKind) || 'file',
      }))
      .filter((attachment) => attachment.assetPath);
  }

  function hasTextAttachmentMetadata(message) {
    return (Array.isArray(message?.attachments) ? message.attachments : []).some(
      (attachment) => normalizeString(attachment?.kind) === 'text'
    );
  }

  function resolveRegenerateRequest(messageId, messages, options) {
    const settings = options || {};
    const list = Array.isArray(messages) ? messages : [];
    const targetId = normalizeId(messageId);
    const latestReplyAssistantMessageId =
      normalizeId(settings.latestReplyAssistantMessageId) || getLatestReplyAssistantMessageId(list);
    const blockedResult = {
      allowed: false,
      prompt: '',
      visiblePrompt: '',
      replayImageAttachments: [],
      sourceMessageId: '',
      targetMessageId: targetId,
      hasTextAttachments: false,
      reason: REGENERATE_DISABLED_REASON,
    };
    if (!targetId) {
      return blockedResult;
    }

    const idToIndex = settings.idToIndex instanceof Map ? settings.idToIndex : null;
    const targetIndex = idToIndex
      ? (idToIndex.get(targetId) ?? -1)
      : list.findIndex((message) => normalizeId(message?.id) === targetId);
    if (targetIndex === -1) {
      return blockedResult;
    }

    const targetMessage = list[targetIndex];
    const isStandardTarget = normalizeId(targetMessage?.id) === latestReplyAssistantMessageId
      && isReplyEligibleAssistantMessage(targetMessage);
    const isErrorTarget = settings.allowErrorTarget === true
      && isRetryEligibleFailedAssistantMessage(targetMessage, list, targetIndex);
    if (!isStandardTarget && !isErrorTarget) {
      return blockedResult;
    }

    if (settings.followUpActionsBusy === true) {
      return {
        ...blockedResult,
        reason: FOLLOW_UP_ACTION_BUSY_REASON,
      };
    }

    let sourceMessage = null;
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      if (normalizeString(list[index]?.role) === 'user') {
        sourceMessage = list[index];
        break;
      }
    }

    if (!sourceMessage) {
      return {
        ...blockedResult,
        reason: REGENERATE_MISSING_SOURCE_REASON,
      };
    }

    const prompt = normalizeString(sourceMessage.content);
    const replayImageAttachments = buildReplayableImageAttachments(sourceMessage);
    const hasTextAttachments = hasTextAttachmentMetadata(sourceMessage);
    if (hasTextAttachments) {
      return {
        ...blockedResult,
        prompt,
        visiblePrompt: prompt,
        replayImageAttachments,
        sourceMessageId: normalizeId(sourceMessage.id),
        hasTextAttachments: true,
        reason: REGENERATE_TEXT_ATTACHMENTS_REASON,
      };
    }

    if (!prompt && !replayImageAttachments.length) {
      return {
        ...blockedResult,
        sourceMessageId: normalizeId(sourceMessage.id),
        reason: REGENERATE_MISSING_SOURCE_REASON,
      };
    }

    return {
      allowed: true,
      prompt,
      visiblePrompt: prompt,
      replayImageAttachments,
      sourceMessageId: normalizeId(sourceMessage.id),
      targetMessageId: targetId,
      hasTextAttachments: false,
      reason: '',
    };
  }

  function buildMessageActionModel(message, options) {
    const settings = options || {};
    const source = message || {};
    const role = normalizeString(source.role);
    const messageId = normalizeId(source.id);
    const kind = normalizeString(source.kind);
    const status = normalizeMessageStatus(source);
    const latestReplyAssistantMessageId = normalizeId(settings.latestReplyAssistantMessageId);
    const followUpActionsBusy = settings.followUpActionsBusy === true;
    const followUpDisabledReason = normalizeString(
      settings.followUpDisabledReason || (followUpActionsBusy ? FOLLOW_UP_ACTION_BUSY_REASON : '')
    );
    const regenerateRequest =
      settings.regenerateRequest && typeof settings.regenerateRequest === 'object'
        ? settings.regenerateRequest
        : null;
    const isAssistant = role === 'assistant';
    const isUser = role === 'user';
    const isLatestReplyAssistant =
      isReplyEligibleAssistantMessage(source)
      && !!messageId
      && messageId === latestReplyAssistantMessageId;
    const isStreamingAssistant = isAssistant && status === STREAMING_STATUS;
    const isInteractiveBatch = isAssistant && kind === 'question_batch';
    const isInteractiveRoundRecap = isAssistant && kind === 'interactive_round_recap';
    const isSpecialAssistantCard = isInteractiveBatch || isInteractiveRoundRecap;
    const durability = source.durability && typeof source.durability === 'object'
      ? source.durability
      : null;
    const unsavedReplyVisible = isAssistant
      && !isStreamingAssistant
      && normalizeString(durability?.state).toLowerCase() === 'unsaved';
    const showHoverRow = isUser || (isAssistant && !isStreamingAssistant && !isSpecialAssistantCard);
    const regenerateEnabled = isLatestReplyAssistant
      && !followUpDisabledReason
      && regenerateRequest?.allowed === true;
    const regenerateReason = regenerateEnabled
      ? ''
      : followUpDisabledReason || normalizeString(regenerateRequest?.reason) || REGENERATE_DISABLED_REASON;

    const editingMessageId = normalizeId(settings.editingMessageId);
    const isEditingThisRow = !!editingMessageId
      && !!messageId
      && editingMessageId === messageId;
    const editLockedByOtherEdit = !!editingMessageId
      && !!messageId
      && editingMessageId !== messageId;
    const editEnabled = isUser
      && !followUpDisabledReason
      && !isEditingThisRow
      && !editLockedByOtherEdit;
    const branchVisible = !!messageId
      && (isUser || isAssistant)
      && !isStreamingAssistant
      && !kind;
    const branchEnabled = branchVisible && !followUpDisabledReason;
    let editReason = '';
    if (isUser) {
      if (followUpDisabledReason) {
        editReason = followUpDisabledReason;
      } else if (editLockedByOtherEdit) {
        editReason = EDIT_DISABLED_REASON_DURING_EDIT;
      }
    }
    return {
      role,
      status,
      isLatestAssistant: isLatestReplyAssistant,
      showHoverRow,
      showMeta: isAssistant && !isStreamingAssistant && !isSpecialAssistantCard,
      unsavedReply: {
        visible: unsavedReplyVisible,
        artifactId: unsavedReplyVisible ? normalizeId(durability?.artifact_id || durability?.artifactId) : '',
        reason: unsavedReplyVisible ? normalizeString(durability?.reason) : '',
        scope: unsavedReplyVisible ? normalizeString(durability?.scope) : '',
      },
      actions: {
        edit: {
          visible: isUser,
          enabled: editEnabled,
          reason: editReason,
        },
        regenerate: {
          visible: isLatestReplyAssistant && !isSpecialAssistantCard,
          enabled: regenerateEnabled,
          reason: regenerateReason,
        },
        branch: {
          visible: branchVisible,
          enabled: branchEnabled,
          reason: branchVisible && !branchEnabled ? followUpDisabledReason : '',
        },
        copy: {
          visible: (isAssistant && !isSpecialAssistantCard) || isUser,
          enabled: isAssistant || isUser,
        },
        elaborate: {
          visible: isLatestReplyAssistant && !isSpecialAssistantCard,
          enabled: isLatestReplyAssistant && !followUpDisabledReason,
          reason: isLatestReplyAssistant ? followUpDisabledReason : '',
        },
      },
    };
  }

  function getElaboratePrompt(message, options) {
    const model = buildMessageActionModel(message, options);
    return model.actions.elaborate.visible && model.actions.elaborate.enabled
      ? ELABORATE_PROMPT
      : '';
  }

  return {
    STREAMING_STATUS,
    COMPLETE_STATUS,
    ERROR_STATUS,
    ELABORATE_PROMPT,
    FOLLOW_UP_ACTION_BUSY_REASON,
    FOLLOW_UP_AUTH_BLOCKED_REASON,
    FOLLOW_UP_BACKEND_NOT_READY_REASON,
    REGENERATE_DISABLED_REASON,
    REGENERATE_MISSING_SOURCE_REASON,
    REGENERATE_TEXT_ATTACHMENTS_REASON,
    EDIT_DISABLED_REASON_DURING_EDIT,
    buildMessageActionModel,
    getLatestReplyAssistantMessageId,
    getElaboratePrompt,
    isReplyEligibleAssistantMessage,
    resolveRegenerateRequest,
    buildReplayableImageAttachments,
    hasTextAttachmentMetadata,
  };
});
