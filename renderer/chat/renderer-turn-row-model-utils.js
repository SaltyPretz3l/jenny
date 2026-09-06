(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowModelUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ASSISTANT_ERROR_RECOVERY_FIELDS = Object.freeze([
    'error_code',
    'terminal_status',
    'terminal_subcode',
    'category',
    'recovery_class',
    'next_action',
    'recovery_title',
    'recovery_hint',
    'next_action_label',
  ]);

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function normalizeRecoveryActionText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function cloneRecoveryActions(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return null;
        }
        const id = normalizeRecoveryActionText(entry.id);
        if (!id) {
          return null;
        }
        const label = normalizeRecoveryActionText(entry.label);
        return label ? { id, label } : { id };
      })
      .filter(Boolean);
  }

  function hasRecoveryActions(value) {
    if (!Array.isArray(value)) {
      return false;
    }
    return value.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false;
      }
      return Boolean(normalizeRecoveryActionText(entry.id));
    });
  }

  function getAssistantErrorField(payload, sourceMessage, fieldName) {
    const sources = [payload, sourceMessage];
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      const value = source && typeof source === 'object' ? source[fieldName] : null;
      const normalized = normalizeId(value);
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  function copyAssistantErrorRecoveryFields(target, payload, sourceMessage) {
    for (const fieldName of ASSISTANT_ERROR_RECOVERY_FIELDS) {
      const value = getAssistantErrorField(payload, sourceMessage, fieldName);
      if (value) {
        target[fieldName] = value;
      }
    }
    if (payload && typeof payload.retryable === 'boolean') {
      target.retryable = payload.retryable;
    } else if (sourceMessage && typeof sourceMessage.retryable === 'boolean') {
      target.retryable = sourceMessage.retryable;
    }
    const payloadActions = cloneRecoveryActions(payload && payload.recovery_actions);
    target.recovery_actions = payloadActions.length
      ? payloadActions
      : cloneRecoveryActions(sourceMessage && sourceMessage.recovery_actions);
  }

  function hasAssistantErrorRecoveryMetadata(message) {
    return Boolean(
      normalizeId(message && message.error_code)
      || normalizeId(message && message.recovery_class)
      || normalizeId(message && message.next_action)
      || normalizeId(message && message.recovery_title)
      || normalizeId(message && message.recovery_hint)
      || normalizeId(message && message.next_action_label)
      || hasRecoveryActions(message && message.recovery_actions)
    );
  }

  function getMessageById(messageId, messages, messageById) {
    const normalizedMessageId = normalizeId(messageId);
    if (!normalizedMessageId) {
      return null;
    }
    if (messageById && typeof messageById.get === 'function') {
      return messageById.get(normalizedMessageId) || null;
    }
    const sourceMessages = Array.isArray(messages) ? messages : [];
    for (let index = 0; index < sourceMessages.length; index += 1) {
      const message = sourceMessages[index];
      if (normalizeId(message && message.id) === normalizedMessageId) {
        return message;
      }
    }
    return null;
  }

  function getReasoningPhaseField(phase, fieldName) {
    if (!phase || typeof phase !== 'object') {
      return '';
    }
    if (fieldName === 'renderCollapsed') {
      return phase.renderCollapsed === true || phase.render_collapsed === true;
    }
    const snakeCaseFieldName = String(fieldName || '')
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase();
    return phase[fieldName] != null
      ? phase[fieldName]
      : phase[snakeCaseFieldName];
  }

  function normalizeReasoningPhase(phase) {
    const view = {
      phaseKind: String(getReasoningPhaseField(phase, 'phaseKind') || ''),
      phaseId: String(getReasoningPhaseField(phase, 'phaseId') || ''),
      thinkingId: String(getReasoningPhaseField(phase, 'thinkingId') || ''),
      renderCollapsed: getReasoningPhaseField(phase, 'renderCollapsed') === true,
      iteration: Number(getReasoningPhaseField(phase, 'iteration')) || 0,
    };
    const summary = String(getReasoningPhaseField(phase, 'summary') || '').trim();
    if (summary) view.summary = summary;
    const tokRate = Number(getReasoningPhaseField(phase, 'tokensPerSecond'));
    if (Number.isFinite(tokRate) && tokRate > 0) view.tokensPerSecond = tokRate;
    const startedAt = String(getReasoningPhaseField(phase, 'startedAt') || '').trim();
    if (startedAt) view.startedAt = startedAt;
    const completedAt = String(getReasoningPhaseField(phase, 'completedAt') || '').trim();
    if (completedAt) view.completedAt = completedAt;
    view.completed = getReasoningPhaseField(phase, 'completed') === true || Boolean(completedAt);
    return view;
  }

  function formatDurationMs(ms) {
    const durationMs = Number(ms);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return '';
    }
    if (durationMs < 1000) {
      return `${Math.round(durationMs)}ms`;
    }
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return {
    cloneRecoveryActions,
    copyAssistantErrorRecoveryFields,
    formatDurationMs,
    getAssistantErrorField,
    getMessageById,
    getReasoningPhaseField,
    hasAssistantErrorRecoveryMetadata,
    hasRecoveryActions,
    normalizeId,
    normalizeReasoningPhase,
  };
});
