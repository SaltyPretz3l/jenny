(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.chatMessageUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const _terminalStatusVocabulary = typeof globalThis !== 'undefined' && typeof globalThis.chatTerminalStatusVocabulary !== 'undefined'
    ? globalThis.chatTerminalStatusVocabulary
    : typeof require === 'function' ? require('./chat-terminal-status-vocabulary')
    : null;
  const { normalizeTerminalStatus, coarseRenderStatus } = _terminalStatusVocabulary;
  const _reasoningEntryMergeUtils = typeof globalThis !== 'undefined' && typeof globalThis.rendererReasoningEntryMergeUtils !== 'undefined'
    ? globalThis.rendererReasoningEntryMergeUtils
    : typeof require === 'function' ? require('./renderer-reasoning-entry-merge-utils')
    : null;
  const {
    buildReasoningEntryMergeIndexes,
    isReasoningEntryEdit,
    mergeReasoningEntriesInto,
  } = _reasoningEntryMergeUtils;

  const STREAMING_STATUS = 'streaming';
  const COMPLETE_STATUS = 'complete';
  const ERROR_STATUS = 'error';
  const REASONING_STATUS_NONE = 'none';
  const REASONING_STATUS_STREAMING = 'streaming';
  const REASONING_STATUS_COMPLETE = 'complete';
  const REASONING_STATUS_ERROR = 'error';
  const REASONING_SOURCE_PROVIDER = 'provider';
  const REASONING_SOURCE_NONE = 'none';
  const PHASE_KIND_REASONING = 'reasoning';

  function normalizeStatus(status) {
    const trimmed = status == null ? '' : String(status).trim();
    if (!trimmed) {
      // Legacy-hydration default: rows persisted before status was tracked
      // have no status field at all -- callers own this default, not the
      // vocabulary (normalizeTerminalStatus returns '' for absent input).
      return COMPLETE_STATUS;
    }
    // Present-but-unrecognized statuses fail closed to 'unknown' (SP-12) --
    // they no longer silently pass as 'complete'.
    return coarseRenderStatus(normalizeTerminalStatus(trimmed));
  }

  function normalizeReasoningEntry(entry, options) {
    const settings = options || {};
    const source = entry || {};
    const fallbackIndex = Number.isFinite(settings.fallbackIndex) ? settings.fallbackIndex : 0;
    const fallbackTimestamp = String(settings.timestamp || '');
    if (isReasoningEntryEdit(source)) {
      const id = String(source.id || '');
      if (!id) {
        return null;
      }
      const normalized = {
        id,
        baseLength: source.baseLength,
        baseTail: source.baseTail,
        append: source.append,
        timestamp: String(source.timestamp || fallbackTimestamp),
      };
      const thinkingId = source.thinkingId != null ? String(source.thinkingId) : '';
      if (thinkingId) {
        normalized.thinkingId = thinkingId;
      }
      return normalized;
    }
    const text = String(source.text || source.summary || source.content || '').trim();

    if (!text) {
      return null;
    }

    const normalized = {
      id: String(source.id || `reasoning_${fallbackIndex}`),
      text,
      timestamp: String(source.timestamp || fallbackTimestamp),
    };
    const thinkingId = source.thinkingId != null ? String(source.thinkingId) : '';
    if (thinkingId) {
      normalized.thinkingId = thinkingId;
    }
    return normalized;
  }

  // Use the shared ref-counted merge primitive so ID replacements keep content-key indexes synchronized.
  function mergeReasoningEntries(existingEntries, incomingEntries, options) {
    const settings = options || {};
    const sources = []
      .concat(Array.isArray(existingEntries) ? existingEntries : [])
      .concat(Array.isArray(incomingEntries) ? incomingEntries : []);

    const normalizedEntries = [];
    for (let index = 0; index < sources.length; index += 1) {
      const entry = normalizeReasoningEntry(sources[index], {
        fallbackIndex: index,
        timestamp: settings.timestamp,
      });
      if (entry) {
        normalizedEntries.push(entry);
      }
    }

    const { indexById, contentKeyCounts } = buildReasoningEntryMergeIndexes([]);
    const state = { entries: [], indexById, contentKeyCounts };
    return mergeReasoningEntriesInto(state, normalizedEntries);
  }

  function normalizeTranscriptPhase(phase, fallbackIndex, timestamp) {
    const source = phase || {};
    const rawTokensPerSecond = source.tokensPerSecond ?? source.tokens_per_second;
    const phaseId = String(source.phaseId || source.phase_id || `phase_${fallbackIndex}`);
    const phaseKind = String(source.phaseKind || source.phase_kind || '').trim();
    if (!phaseId || !phaseKind) {
      return null;
    }
    return {
      phaseId,
      phaseKind,
      iteration: Number.isFinite(Number(source.iteration))
        ? Math.max(0, Math.floor(Number(source.iteration)))
        : 0,
      thinkingId: String(source.thinkingId || source.thinking_id || ''),
      toolCallId: String(source.toolCallId || source.tool_call_id || ''),
      toolName: String(source.toolName || source.tool_name || ''),
      renderCollapsed: source.renderCollapsed === true || source.render_collapsed === true,
      summary: String(source.summary || '').trim(),
      tokensPerSecond: Number(rawTokensPerSecond) || 0,
      startedAt: String(source.startedAt || source.started_at || timestamp || ''),
      completedAt: String(source.completedAt || source.completed_at || ''),
      entries: mergeReasoningEntries([], source.entries, { timestamp }),
    };
  }

  function normalizeVisibleSegment(segment, fallbackIndex) {
    const source = segment || {};
    const segmentId = String(source.segmentId || source.segment_id || `segment_${fallbackIndex}`);
    if (!segmentId) {
      return null;
    }
    return {
      segmentId,
      phaseId: String(source.phaseId || source.phase_id || ''),
      text: String(source.text || ''),
    };
  }

  function buildVisibleSegmentContent(visibleSegments, fallbackContent) {
    const segments = Array.isArray(visibleSegments) ? visibleSegments : [];
    if (!segments.length) {
      return String(fallbackContent || '');
    }
    return segments.map((segment) => String(segment?.text || '')).join('');
  }

  function normalizeToolStep(toolStep) {
    const source = toolStep || {};
    const callId = String(source.callId || source.call_id || '').trim();
    const toolName = String(source.toolName || source.tool_name || '').trim();
    if (!callId || !toolName) {
      return null;
    }
    return {
      callId,
      toolName,
      toolUseMessageId: String(source.toolUseMessageId || source.tool_use_message_id || ''),
      toolResultMessageId: String(source.toolResultMessageId || source.tool_result_message_id || ''),
      status: String(source.status || 'completed').trim() || 'completed',
    };
  }

  function flattenReasoningEntriesFromPhases(phases, timestamp, fallbackEntries) {
    const flattened = [];
    const phaseList = Array.isArray(phases) ? phases : [];
    for (let index = 0; index < phaseList.length; index += 1) {
      const phase = phaseList[index];
      if (String(phase?.phaseKind || '') !== PHASE_KIND_REASONING) {
        continue;
      }
      flattened.push(...(Array.isArray(phase.entries) ? phase.entries : []));
    }
    const merged = mergeReasoningEntries([], flattened, { timestamp });
    if (merged.length) {
      return merged;
    }
    return mergeReasoningEntries([], fallbackEntries, { timestamp });
  }

  function normalizeReasoningPhases(legacyReasoningPhases, phases, timestamp) {
    const normalizedPhases = Array.isArray(phases)
      ? phases
          .filter((phase) => String(phase?.phaseKind || '') === PHASE_KIND_REASONING)
          .map((phase) => {
            const normalized = {
              phaseId: String(phase.phaseId || ''),
              phaseKind: PHASE_KIND_REASONING,
              iteration: Number(phase.iteration || 0) || 0,
              thinkingId: String(phase.thinkingId || ''),
              toolCallId: String(phase.toolCallId || ''),
              toolName: String(phase.toolName || ''),
              completed: Boolean(phase.completedAt || !phase.startedAt),
              renderCollapsed: phase.renderCollapsed === true,
              startedAt: String(phase.startedAt || ''),
              completedAt: String(phase.completedAt || ''),
            };
            const summary = String(phase.summary || '').trim();
            if (summary) normalized.summary = summary;
            const tokRate = Number(phase.tokensPerSecond);
            if (Number.isFinite(tokRate) && tokRate > 0) normalized.tokensPerSecond = tokRate;
            return normalized;
          })
      : [];
    if (normalizedPhases.length) {
      return normalizedPhases;
    }
    return Array.isArray(legacyReasoningPhases)
      ? legacyReasoningPhases
          .map((phase, index) => {
            const normalized = normalizeTranscriptPhase(phase, index, timestamp);
            if (!normalized || normalized.phaseKind !== PHASE_KIND_REASONING) {
              return null;
            }
            return {
              phaseId: normalized.phaseId,
              phaseKind: normalized.phaseKind,
              iteration: normalized.iteration,
              thinkingId: normalized.thinkingId,
              toolCallId: normalized.toolCallId,
              toolName: normalized.toolName,
              ...(normalized.summary ? { summary: normalized.summary } : {}),
              ...(normalized.tokensPerSecond ? { tokensPerSecond: normalized.tokensPerSecond } : {}),
              completed: Boolean(normalized.completedAt || !normalized.startedAt),
              renderCollapsed: normalized.renderCollapsed === true,
              startedAt: normalized.startedAt,
              completedAt: normalized.completedAt,
            };
          })
          .filter(Boolean)
      : [];
  }

  function normalizeReasoning(reasoning, role, messageStatus, timestamp, phases) {
    if (role !== 'assistant') {
      return {
        available: false,
        status: REASONING_STATUS_NONE,
        source: REASONING_SOURCE_NONE,
        entries: [],
      };
    }

    const entries = flattenReasoningEntriesFromPhases(
      phases,
      timestamp,
      reasoning && reasoning.entries
    );
    const source = entries.length
      ? REASONING_SOURCE_PROVIDER
      : (
        reasoning && reasoning.source === REASONING_SOURCE_PROVIDER
          ? REASONING_SOURCE_PROVIDER
          : REASONING_SOURCE_NONE
      );
    const available = source === REASONING_SOURCE_PROVIDER && entries.length > 0;
    let status = REASONING_STATUS_NONE;

    if (messageStatus === STREAMING_STATUS) {
      status = REASONING_STATUS_STREAMING;
    } else if (messageStatus === ERROR_STATUS && available) {
      status = REASONING_STATUS_ERROR;
    } else if (available) {
      status = REASONING_STATUS_COMPLETE;
    }

    return {
      available,
      status,
      source,
      entries,
    };
  }

  function normalizeInteractiveRoundRecap(recap) {
    if (!recap || typeof recap !== 'object' || Array.isArray(recap)) {
      return null;
    }

    const parsedRoundIndex = Number(recap.round_index || 1);
    const roundIndex = Number.isFinite(parsedRoundIndex) && parsedRoundIndex > 0
      ? Math.max(1, Math.floor(parsedRoundIndex))
      : 1;
    const items = Array.isArray(recap.items)
      ? recap.items
          .map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              return null;
            }
            const questionId = String(item.question_id || '').trim();
            const prompt = String(item.prompt || '').trim();
            const answerLabel = String(item.answer_label || '').trim();
            if (!questionId || !prompt || !answerLabel) {
              return null;
            }
            return {
              question_id: questionId,
              prompt,
              answer_label: answerLabel,
            };
          })
          .filter(Boolean)
      : [];

    if (!items.length) {
      return null;
    }

    return {
      round_index: roundIndex,
      answer_count: Math.max(1, Number(recap.answer_count) || items.length),
      items,
      collapsed: recap.collapsed !== false,
    };
  }

  function normalizeChatMessage(message, options) {
    const settings = options || {};
    const source = message || {};
    const role = String(source.role || 'assistant');
    const timestamp = String(source.timestamp || settings.timestamp || '');
    const fallbackIdPrefix = String(settings.fallbackIdPrefix || 'message');
    const fallbackIndex = Number.isFinite(settings.fallbackIndex) ? settings.fallbackIndex : 0;
    const id = String(source.id || `${fallbackIdPrefix}_${role}_${fallbackIndex}`);
    const status = normalizeStatus(source.status);
    const phases = Array.isArray(source.phases)
      ? source.phases.map((phase, index) => normalizeTranscriptPhase(phase, index, timestamp)).filter(Boolean)
      : [];
    const visibleSegments = Array.isArray(source.visible_segments)
      ? source.visible_segments.map((segment, index) => normalizeVisibleSegment(segment, index)).filter(Boolean)
      : [];
    const toolSteps = Array.isArray(source.tool_steps)
      ? source.tool_steps.map((toolStep) => normalizeToolStep(toolStep)).filter(Boolean)
      : [];
    const content = buildVisibleSegmentContent(visibleSegments, source.content);
    let finalizedAt = source.finalizedAt || null;

    if (role === 'assistant') {
      finalizedAt = status === STREAMING_STATUS ? null : String(finalizedAt || timestamp || '');
    } else {
      finalizedAt = finalizedAt ? String(finalizedAt) : null;
    }

    return {
      ...source,
      id,
      role,
      content,
      stream_error: source.stream_error ? String(source.stream_error) : '',
      // Preserve explicit terminal_status across re-normalization; deriving it from the coarsened status loses cancellation semantics.
      terminal_status: String(source.terminal_status || source.status || ''),
      terminal_subcode: String(source.terminal_subcode || ''),
      timestamp,
      status,
      finalizedAt,
      parent_stream_id: String(source.parent_stream_id || source.parentStreamId || ''),
      phases,
      visible_segments: visibleSegments,
      tool_steps: toolSteps,
      reasoning: normalizeReasoning(source.reasoning, role, status, timestamp, phases),
      reasoning_phases: normalizeReasoningPhases(source.reasoning_phases, phases, timestamp),
      interactive_round_recap: normalizeInteractiveRoundRecap(source.interactive_round_recap),
    };
  }

  function normalizeChatMessages(messages, options) {
    return Array.isArray(messages)
      ? messages.map((message, index) =>
          normalizeChatMessage(message, {
            ...options,
            fallbackIndex: index,
          })
        )
      : [];
  }

  function getLatestAssistantMessageId(messages) {
    if (!Array.isArray(messages)) {
      return '';
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const kind = String(message && message.kind || '');
      if (
        message &&
        message.role === 'assistant' &&
        kind !== 'interactive_round_recap' &&
        kind !== 'slash_command_output'
      ) {
        return String(message.id || '');
      }
    }

    return '';
  }

  function buildAssistantMetaLabel(message, formatTime) {
    const kind = String(message && message.kind || '');
    if (
      !message ||
      message.role !== 'assistant' ||
      message.status === STREAMING_STATUS ||
      kind === 'question_batch' ||
      kind === 'interactive_round_recap'
    ) {
      return '';
    }

    // User stops retain coarse error status but display "Stopped"; include per-turn model provenance because a conversation may span model switches.
    const terminalStatus = String(message.terminal_status || message.recovery_class || '').trim().toLowerCase();
    const cancelled = terminalStatus === 'cancelled' || terminalStatus === 'canceled';
    const prefix = message.status === ERROR_STATUS ? (cancelled ? 'Stopped' : 'Failed') : 'Completed';
    const terminalTime = message.finalizedAt || message.timestamp || '';
    const formattedTime = terminalTime
      ? String(typeof formatTime === 'function' ? formatTime(terminalTime) : terminalTime)
      : '';
    const base = formattedTime ? `${prefix} ${formattedTime}` : prefix;
    const modelUsed = String(message.model_used || '').trim();
    return modelUsed ? `${base} · ${modelUsed}` : base;
  }

  return {
    STREAMING_STATUS,
    COMPLETE_STATUS,
    ERROR_STATUS,
    REASONING_STATUS_NONE,
    REASONING_STATUS_STREAMING,
    REASONING_STATUS_COMPLETE,
    REASONING_STATUS_ERROR,
    REASONING_SOURCE_PROVIDER,
    REASONING_SOURCE_NONE,
    normalizeChatMessage,
    normalizeChatMessages,
    normalizeReasoning,
    normalizeTranscriptPhase,
    flattenReasoningEntriesFromPhases,
    buildVisibleSegmentContent,
    normalizeReasoningEntry,
    mergeReasoningEntries,
    getLatestAssistantMessageId,
    buildAssistantMetaLabel,
    normalizeInteractiveRoundRecap,
  };
});
