(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererTranscriptToolResultUtils = factory(root.stringUtils || {
    normalizeString(value) {
      return String(value || '').trim();
    },
    normalizeId(value) {
      return String(value || '').trim();
    },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  const normalizeString = typeof stringUtils.normalizeString === 'function'
    ? stringUtils.normalizeString
    : function fallbackNormalizeString(value) {
      return String(value || '').trim();
    };
  const normalizeId = typeof stringUtils.normalizeId === 'function'
    ? stringUtils.normalizeId
    : function fallbackNormalizeId(value) {
      return String(value || '').trim();
    };
  const NON_TERMINAL_RENDER_STATES = new Set([
    'running', 'requested', 'approved', 'interrupted', 'awaiting_approval',
  ]);

  function normalizeToolRenderStatus(value) {
    const status = normalizeString(value).toLowerCase();
    if (!status) {
      return 'requested';
    }
    if (status === 'pending_approval') {
      return 'awaiting_approval';
    }
    if (status === 'error') {
      return 'errored';
    }
    if (status === 'timeout') {
      return 'timed_out';
    }
    if (status === 'preempted') {
      return 'cancelled';
    }
    return status;
  }

  function readToolResultCallId(resultMeta) {
    return normalizeId(resultMeta && (resultMeta.call_id || resultMeta.callId));
  }

  function isToolResultError(resultMeta) {
    return Boolean(
      resultMeta
      && (
        resultMeta.is_error === true
        || resultMeta.isError === true
        || resultMeta.result_is_error === true
        || resultMeta.resultIsError === true
      )
    );
  }

  function readToolResultOutputText(resultMeta) {
    if (!resultMeta) return '';
    return String(resultMeta.output_text ?? resultMeta.outputText ?? '');
  }

  function readToolResultGeneratedArtifacts(resultMeta) {
    if (!resultMeta) return [];
    if (Array.isArray(resultMeta.generated_artifacts)) return resultMeta.generated_artifacts;
    if (Array.isArray(resultMeta.generatedArtifacts)) return resultMeta.generatedArtifacts;
    return [];
  }

  function readToolResultDurationMs(resultMeta, fallbackMs) {
    const resultValue = resultMeta
      ? (resultMeta.duration_ms ?? resultMeta.durationMs)
      : null;
    const resultDurationMs = Number(resultValue);
    if (Number.isFinite(resultDurationMs) && resultDurationMs > 0) {
      return resultDurationMs;
    }
    const fallbackDurationMs = Number(fallbackMs);
    return Number.isFinite(fallbackDurationMs) && fallbackDurationMs > 0 ? fallbackDurationMs : 0;
  }

  function getMessageById(messageId, allMessages, messageById) {
    const normalizedMessageId = normalizeId(messageId);
    if (!normalizedMessageId) {
      return null;
    }
    if (messageById && typeof messageById.get === 'function') {
      return messageById.get(normalizedMessageId) || null;
    }
    const sourceMessages = Array.isArray(allMessages) ? allMessages : [];
    for (let index = 0; index < sourceMessages.length; index += 1) {
      const message = sourceMessages[index];
      if (normalizeId(message && message.id) === normalizedMessageId) {
        return message;
      }
    }
    return null;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function collectProjectedToolMessages(toolStepRow, allMessages, messageById, fallbackMessage) {
    const sourceMessages = [];
    const sourceMessagesById = new Map();
    const sourceMessageIds = Array.isArray(toolStepRow && toolStepRow.source_message_ids)
      ? toolStepRow.source_message_ids
      : [];
    for (let index = 0; index < sourceMessageIds.length; index += 1) {
      const message = getMessageById(sourceMessageIds[index], allMessages, messageById);
      if (message) {
        const messageId = normalizeId(message.id);
        if (messageId) {
          sourceMessagesById.set(messageId, message);
        } else if (!sourceMessages.includes(message)) {
          sourceMessages.push(message);
        }
      }
    }
    if (fallbackMessage) {
      const fallbackMessageId = normalizeId(fallbackMessage.id);
      if (fallbackMessageId) {
        sourceMessagesById.set(fallbackMessageId, fallbackMessage);
      } else if (!sourceMessages.includes(fallbackMessage)) {
        sourceMessages.push(fallbackMessage);
      }
    }
    return Array.from(sourceMessagesById.values()).concat(sourceMessages);
  }

  function buildSyntheticToolResultMeta(toolStepRow) {
    const payload = toolStepRow && toolStepRow.payload && typeof toolStepRow.payload === 'object'
      ? toolStepRow.payload
      : {};
    if (
      !String(payload.output_text || '')
      && !String(payload.result_summary || '')
      && payload.result_is_error !== true
      && !String(payload.error_code || '')
      && (!Array.isArray(payload.generated_artifacts) || payload.generated_artifacts.length < 1)
      && (!Array.isArray(payload.trusted_attachment_refs) || payload.trusted_attachment_refs.length < 1)
      && !(payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata))
    ) {
      return null;
    }
    const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? { ...payload.metadata }
      : {};
    return {
      call_id: normalizeId(payload.tool_call_id || toolStepRow && toolStepRow.tool_call_id),
      tool_name: normalizeString(payload.tool_name),
      output_text: String(payload.output_text || ''),
      summary: String(payload.result_summary || ''),
      is_error: payload.result_is_error === true,
      error_code: normalizeString(payload.error_code),
      duration_ms: 0,
      generated_artifacts: Array.isArray(payload.generated_artifacts)
        ? payload.generated_artifacts.map((artifact) => ({ ...(artifact || {}) }))
        : [],
      trusted_attachment_refs: Array.isArray(payload.trusted_attachment_refs)
        ? payload.trusted_attachment_refs.map((attachment) => ({ ...(attachment || {}) }))
        : [],
      metadata,
    };
  }

  function findToolResultForCallId(messages, callId, options) {
    if (!callId) return null;
    const settings = options && typeof options === 'object' ? options : {};
    const sourceMessages = Array.isArray(messages) ? messages : [];
    const ownerMessage = settings.ownerMessage || null;
    let ownerIndex = ownerMessage ? sourceMessages.indexOf(ownerMessage) : -1;
    if (ownerMessage && ownerIndex < 0) {
      const ownerMessageId = normalizeId(ownerMessage.id);
      if (ownerMessageId) {
        let uniqueMatchIndex = -1;
        for (let index = 0; index < sourceMessages.length; index += 1) {
          if (normalizeId(sourceMessages[index] && sourceMessages[index].id) !== ownerMessageId) continue;
          if (uniqueMatchIndex >= 0) {
            uniqueMatchIndex = -1;
            break;
          }
          uniqueMatchIndex = index;
        }
        ownerIndex = uniqueMatchIndex;
      }
    }
    const turnId = normalizeId(settings.turnId || settings.turn_id || ownerMessage && (ownerMessage.turn_id || ownerMessage.turnId));
    const turnIdByMessageId = settings.turnIdByMessageId instanceof Map ? settings.turnIdByMessageId : null;
    const allowedMessageIds = settings.allowedMessageIds instanceof Set ? settings.allowedMessageIds : null;
    let turnEndIndex = sourceMessages.length;
    if (ownerIndex >= 0) {
      for (let index = ownerIndex + 1; index < sourceMessages.length; index += 1) {
        if (String(sourceMessages[index] && sourceMessages[index].role || '') === 'user') {
          turnEndIndex = index;
          break;
        }
      }
    }
    const hasExplicitScope = Boolean(turnId && turnIdByMessageId) || Boolean(allowedMessageIds) || ownerIndex >= 0;
    if (!hasExplicitScope) return null;
    for (let index = 0; index < sourceMessages.length; index += 1) {
      const msg = sourceMessages[index];
      if (msg.kind !== 'tool_result' || !msg.tool_result || readToolResultCallId(msg.tool_result) !== callId) {
        continue;
      }
      const messageId = normalizeId(msg.id);
      if (allowedMessageIds && !allowedMessageIds.has(messageId)) {
        continue;
      }
      if (turnId && turnIdByMessageId && normalizeId(turnIdByMessageId.get(messageId)) !== turnId) {
        continue;
      }
      if (ownerIndex >= 0) {
        // A following user message starts a new turn. Do not let a repeated
        // turn-scoped call id reach backward or forward across that boundary.
        if (index < ownerIndex || index >= turnEndIndex) continue;
      }
      return msg;
    }
    return null;
  }

  return {
    NON_TERMINAL_RENDER_STATES,
    buildSyntheticToolResultMeta,
    collectProjectedToolMessages,
    findToolResultForCallId,
    getMessageById,
    isPlainObject,
    isToolResultError,
    normalizeToolRenderStatus,
    readToolResultCallId,
    readToolResultDurationMs,
    readToolResultGeneratedArtifacts,
    readToolResultOutputText,
  };
});
