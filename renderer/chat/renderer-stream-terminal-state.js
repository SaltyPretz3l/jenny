/* renderer/chat/renderer-stream-terminal-state.js -- terminal status identity and hydration guards (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamTerminalState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const terminalStatusVocabulary = typeof globalThis !== 'undefined'
      && globalThis.chatTerminalStatusVocabulary
    ? globalThis.chatTerminalStatusVocabulary
    : (typeof require === 'function' ? require('./chat-terminal-status-vocabulary') : null);
  if (!terminalStatusVocabulary
    || typeof terminalStatusVocabulary.normalizeTerminalStatus !== 'function'
    || typeof terminalStatusVocabulary.isTerminalStatus !== 'function') {
    throw new Error('chat-terminal-status-vocabulary must load before renderer-stream-terminal-state');
  }

  function freezePresentation(value) {
    return Object.freeze({ ...value, actions: Object.freeze(value.actions.slice()) });
  }

  const TERMINAL_PRESENTATION_MATRIX = Object.freeze({
    complete: freezePresentation({ status: 'completed', phase: 'completed', label: 'Complete', tone: 'success', actions: ['review_answer'], ariaLabel: 'Turn completed', summary: 'Turn complete.', presenceState: 'complete', attentionLevel: 'quiet', priorityKind: 'review' }),
    error: freezePresentation({ status: 'errored', phase: 'error', label: 'Needs Recovery', tone: 'danger', actions: ['review_recovery'], ariaLabel: 'Turn ended with an error', summary: 'The turn needs recovery.', presenceState: 'recovery', attentionLevel: 'urgent', priorityKind: 'recovery' }),
    cancelled: freezePresentation({ status: 'cancelled', phase: 'cancelled', label: 'Cancelled', tone: 'warning', actions: ['resume_or_review'], ariaLabel: 'Turn cancelled', summary: 'Resume or review the partial turn.', presenceState: 'cancelled', attentionLevel: 'caution', priorityKind: 'resume' }),
    denied: freezePresentation({ status: 'denied', phase: 'error', label: 'Approval Denied', tone: 'warning', actions: ['review_recovery'], ariaLabel: 'Tool approval denied', summary: 'The requested tool approval was denied.', presenceState: 'recovery', attentionLevel: 'caution', priorityKind: 'recovery' }),
    timeout: freezePresentation({ status: 'timed_out', phase: 'error', label: 'Timed Out', tone: 'danger', actions: ['review_recovery'], ariaLabel: 'Turn timed out', summary: 'The turn timed out.', presenceState: 'recovery', attentionLevel: 'urgent', priorityKind: 'recovery' }),
    interrupted: freezePresentation({ status: 'interrupted', phase: 'interrupted', label: 'Interrupted', tone: 'warning', actions: ['resume_or_review'], ariaLabel: 'Turn interrupted', summary: 'Resume or review the partial turn.', presenceState: 'interrupted', attentionLevel: 'caution', priorityKind: 'resume' }),
    preempted: freezePresentation({ status: 'preempted', phase: 'interrupted', label: 'Preempted', tone: 'warning', actions: ['resume_or_review'], ariaLabel: 'Turn preempted', summary: 'The turn was stopped before it could finish.', presenceState: 'interrupted', attentionLevel: 'caution', priorityKind: 'resume' }),
    unknown: freezePresentation({ status: 'unknown', phase: 'unknown', label: 'Status Unavailable', tone: 'warning', actions: ['refresh_status'], ariaLabel: 'Turn status unavailable', summary: 'The terminal status is unavailable. Refresh or retry.', presenceState: 'recovery', attentionLevel: 'caution', priorityKind: 'recovery' }),
  });
  const PRESENTATION_STATUS_ALIASES = Object.freeze({
    completed: 'complete',
    errored: 'error',
    timed_out: 'timeout',
  });
  function resolveTerminalPresentationIfTerminal(value, options = {}) {
    const raw = String(value || '').trim().toLowerCase();
    const candidate = raw || String(options.fallbackStatus || '').trim().toLowerCase();
    if (!candidate || candidate === terminalStatusVocabulary.STREAMING_STATUS) return null;
    const normalizedCandidate = candidate.replace(/[\s.-]+/g, '_');
    const recognized = Object.prototype.hasOwnProperty.call(PRESENTATION_STATUS_ALIASES, normalizedCandidate)
      || terminalStatusVocabulary.CANONICAL_TERMINAL_STATUSES.has(normalizedCandidate)
      || terminalStatusVocabulary.ALIASES.has(normalizedCandidate);
    if (!recognized) return null;
    const canonical = PRESENTATION_STATUS_ALIASES[normalizedCandidate]
      || terminalStatusVocabulary.normalizeTerminalStatus(normalizedCandidate);
    return TERMINAL_PRESENTATION_MATRIX[canonical] || TERMINAL_PRESENTATION_MATRIX.unknown;
  }

  function resolveTerminalPresentation(value, options = {}) {
    const presentation = resolveTerminalPresentationIfTerminal(value, options);
    const hasCandidate = String(value || options.fallbackStatus || '').trim();
    return presentation || (hasCandidate ? TERMINAL_PRESENTATION_MATRIX.unknown : null);
  }

  function terminalPhaseForStatus(value) {
    return resolveTerminalPresentationIfTerminal(value)?.phase || '';
  }

  function createTerminalStateUtils(options = {}) {
    const { MESSAGE_STATUS, normalizeId, appendClientLog } = options;
    const normalizeStatus = (value) => String(value || '').trim().toLowerCase();
    const statusEquals = (value, expected) => normalizeStatus(value) === normalizeStatus(expected);

    function isCompleteStatus(value) {
      return terminalStatusVocabulary.normalizeTerminalStatus(value)
        === terminalStatusVocabulary.COMPLETE_STATUS;
    }

    function isTerminalStatus(value) {
      return Boolean(resolveTerminalPresentationIfTerminal(value));
    }

    const readMessageStreamId = (message) => normalizeId(message?.streamId || message?.stream_id);

    function readMessageAssociatedStreamId(message) {
      return normalizeId(
        message?.streamId
        || message?.stream_id
        || message?.parent_stream_id
        || message?.parentStreamId
        || message?.tool_call?.parent_stream_id
        || message?.tool_call?.parentStreamId
        || message?.tool_result?.parent_stream_id
        || message?.tool_result?.parentStreamId
      );
    }

    function isTerminalStreamLocalArtifact(message, streamId) {
      const normalizedStreamId = normalizeId(streamId);
      return Boolean(normalizedStreamId && readMessageAssociatedStreamId(message) === normalizedStreamId);
    }

    function messageMatchesTerminal(message, completedMessage, streamId) {
      if (!message || !completedMessage) return false;
      const messageId = normalizeId(message.id);
      const completedId = normalizeId(completedMessage.id);
      if (messageId && completedId && messageId === completedId) return true;
      const normalizedStreamId = normalizeId(streamId);
      return Boolean(normalizedStreamId && readMessageStreamId(message) === normalizedStreamId);
    }

    function findTerminalFallbackMessage(fallbackMessages, streamId) {
      const fallback = Array.isArray(fallbackMessages) ? fallbackMessages : [];
      const normalizedStreamId = normalizeId(streamId);
      for (let index = fallback.length - 1; index >= 0; index -= 1) {
        const message = fallback[index];
        if (!message || !isTerminalStatus(message.status)) continue;
        if (!normalizedStreamId || readMessageStreamId(message) === normalizedStreamId) return message;
      }
      return null;
    }

    function guardTerminalHydratedMessages(sessionId, refreshedMessages, fallbackMessages, guardOptions = {}) {
      const terminalMessage = findTerminalFallbackMessage(fallbackMessages, guardOptions.streamId);
      if (!terminalMessage) return refreshedMessages;
      let staleCount = 0;
      let guardedMessages = refreshedMessages;
      refreshedMessages.forEach((message, index) => {
        if (!messageMatchesTerminal(message, terminalMessage, guardOptions.streamId)
          || !statusEquals(message?.status, MESSAGE_STATUS.STREAMING || 'streaming')) return;
        staleCount += 1;
        if (guardedMessages === refreshedMessages) guardedMessages = refreshedMessages.slice();
        guardedMessages[index] = {
          ...message,
          content: terminalMessage.content || message.content || '',
          status: terminalMessage.status || MESSAGE_STATUS.COMPLETE,
          stream_error: terminalMessage.stream_error || '',
          finalizedAt: terminalMessage.finalizedAt || message.finalizedAt || new Date().toISOString(),
          agent_status: null,
          agent_status_steps: [],
          ...(terminalMessage.agent_progress_snapshot
            ? { agent_progress_snapshot: terminalMessage.agent_progress_snapshot }
            : {}),
        };
      });
      if (staleCount > 0) {
        appendClientLog('WARN', 'stream.terminal_hydration_stale', {
          sessionId: String(sessionId || '').slice(0, 30),
          streamId: String(guardOptions.streamId || '').slice(0, 30),
          staleCount,
        });
      }
      return guardedMessages;
    }

    return {
      guardTerminalHydratedMessages,
      isCompleteStatus,
      isTerminalStatus,
      isTerminalStreamLocalArtifact,
      readMessageAssociatedStreamId,
      statusEquals,
    };
  }

  return {
    TERMINAL_PRESENTATION_MATRIX,
    createTerminalStateUtils,
    resolveTerminalPresentation,
    resolveTerminalPresentationIfTerminal,
    terminalPhaseForStatus,
  };
});
