/**
 * Pure context-meter state and estimation model (UMD).
 *
 * Owns bounded per-session usage records, approximate history shaping, manual
 * compaction projections, and target resolution. Rendering stays in
 * renderer-context-usage-utils.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererContextUsageModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  var DEFAULT_MAX_ENTRIES = 200;
  var RECENT_TURN_GROUP_LIMIT = 6;
  var ATTACHMENT_IMAGE_TOKEN_ESTIMATE = 768;
  var ATTACHMENT_AUDIO_TOKEN_ESTIMATE = 1024;

  var META_TOKEN_COUNTED_ROLES = new Set(['user', 'assistant']);
  var META_EXCLUDED_KINDS = new Set([
    'assistant_error',
    'question_batch',
    'interactive_round_recap',
    'proactive_suggestion',
    'system_notice',
    'tool_use',
    'tool_result',
    'slash_command_output',
  ]);
  var CONTEXT_EXCLUDED_KINDS = new Set(['proactive_suggestion']);

  function normalizePositiveInteger(value) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
  }

  function normalizeNonnegativeInteger(value) {
    var parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
    return parsed;
  }

  function normalizeSessionId(value) {
    return String(value || '').trim();
  }

  function normalizeHistoryScope(value) {
    var scope = String(value || '').trim().toLowerCase();
    return scope === 'fresh' || scope === 'recent' ? scope : 'session';
  }

  function estimateTextTokens(text) {
    var length = String(text || '').length;
    return length > 0 ? Math.ceil(length / 4) : 0;
  }

  function getMessageTokenText(message) {
    var kind = String(message && message.kind || '').trim();
    if (kind === 'tool_use') {
      var toolCall = message?.tool_call || {};
      return [
        String(toolCall.tool_name || toolCall.summary || ''),
        String(toolCall.input_json || safeStringify(toolCall.input)),
      ].filter(Boolean).join('\n');
    }
    if (kind === 'tool_result') {
      return String(
        message?.tool_result?.output_text
        || message?.content
        || message?.tool_result?.summary
        || message?.tool_result?.tool_name
        || ''
      );
    }
    if (kind === 'question_batch') return safeStringify(message?.interactive_batch);
    if (kind === 'interactive_round_recap') return safeStringify(message?.interactive_round_recap);
    if (Array.isArray(message && message.visible_segments) && message.visible_segments.length) {
      return message.visible_segments.map(function mapSegment(segment) {
        return String(segment && segment.text || '');
      }).join('');
    }
    return String(message && message.content || '');
  }

  function safeStringify(value) {
    if (value === undefined || value === null) return '';
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return '';
    }
  }

  function isMetaTokenCountedMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    var role = String(message.role || '').trim();
    if (!META_TOKEN_COUNTED_ROLES.has(role)) return false;
    return !META_EXCLUDED_KINDS.has(String(message.kind || '').trim());
  }

  function walkMessageTokenEstimates(messages, onEstimate) {
    var list = Array.isArray(messages) ? messages : [];
    var cumulativeTokens = 0;
    var callback = typeof onEstimate === 'function' ? onEstimate : null;
    for (var index = 0; index < list.length; index += 1) {
      var message = list[index];
      if (!isMetaTokenCountedMessage(message)) continue;
      var messageTokens = estimateTextTokens(getMessageTokenText(message));
      cumulativeTokens += messageTokens;
      var messageId = String(message && message.id || '').trim();
      if (!messageId || messageTokens <= 0 || !callback) continue;
      callback({
        messageId: messageId,
        messageTokens: messageTokens,
        cumulativeTokens: cumulativeTokens,
      });
    }
    return cumulativeTokens;
  }

  function buildMessageTokenMeta(messages) {
    var metaById = new Map();
    walkMessageTokenEstimates(messages, function recordMessageTokenMeta(estimate) {
      metaById.set(estimate.messageId, {
        messageTokens: estimate.messageTokens,
        cumulativeTokens: estimate.cumulativeTokens,
        estimated: true,
      });
    });
    return metaById;
  }

  function isPlainUserAnchorMessage(message) {
    return Boolean(
      message
      && typeof message === 'object'
      && !Array.isArray(message)
      && String(message.role || '').trim() === 'user'
      && !String(message.kind || '').trim()
    );
  }

  function selectRecentTurnGroups(messages, maxGroups) {
    var groups = [];
    var currentGroup = [];
    var list = Array.isArray(messages) ? messages : [];
    for (var index = 0; index < list.length; index += 1) {
      var message = list[index];
      if (isPlainUserAnchorMessage(message)) {
        if (currentGroup.length) groups.push(currentGroup);
        currentGroup = [message];
      } else if (currentGroup.length) {
        currentGroup.push(message);
      }
    }
    if (currentGroup.length) groups.push(currentGroup);
    return groups.slice(-Math.max(0, Number(maxGroups) || 0)).flat();
  }

  function selectContextEstimateMessages(messages, historyScope) {
    var list = Array.isArray(messages) ? messages : [];
    var scope = normalizeHistoryScope(historyScope);
    if (scope === 'fresh') return [];
    if (scope === 'recent') return selectRecentTurnGroups(list, RECENT_TURN_GROUP_LIMIT);
    return list;
  }

  function isContextEstimateMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    var kind = String(message.kind || '').trim();
    if (CONTEXT_EXCLUDED_KINDS.has(kind)) return false;
    if (kind === 'tool_use') {
      return Boolean(message.tool_call?.call_id && message.tool_call?.tool_name);
    }
    if (kind === 'tool_result') return Boolean(message.tool_result?.call_id);
    var role = String(message.role || '').trim();
    return role === 'user' || role === 'assistant' || role === 'system';
  }

  function estimateContextMessagesTokens(messages, historyScope) {
    var selected = selectContextEstimateMessages(messages, historyScope);
    var total = 0;
    for (var index = 0; index < selected.length; index += 1) {
      if (!isContextEstimateMessage(selected[index])) continue;
      total += estimateTextTokens(getMessageTokenText(selected[index]));
    }
    return total;
  }

  function estimateAttachmentTokens(attachments) {
    var list = Array.isArray(attachments) ? attachments : [];
    var total = 0;
    for (var index = 0; index < list.length; index += 1) {
      var entry = list[index];
      if (!entry || typeof entry !== 'object') continue;
      total += String(entry.kind || '').trim().toLowerCase() === 'audio'
        ? ATTACHMENT_AUDIO_TOKEN_ESTIMATE
        : ATTACHMENT_IMAGE_TOKEN_ESTIMATE;
    }
    return total;
  }

  function normalizeCompactionContext(value) {
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!source) return null;
    var sourceVersion = Number(source.version);
    // Mirrors COMPACTION_SNAPSHOT_VERSION in services/backend/session-compaction-snapshot.js.
    if (![1, 2].includes(sourceVersion)) return null;
    var strategy = String(source.strategy || '').trim();
    var boundaryMessageCount = normalizePositiveInteger(source.boundary_message_count);
    var tokensAfter = normalizePositiveInteger(source.tokens_after);
    var replacementTokens = normalizePositiveInteger(source.replacement_tokens) || null;
    if (!['full', 'micro'].includes(strategy) || !boundaryMessageCount || !tokensAfter) return null;
    return {
      version: sourceVersion,
      created_at: String(source.created_at || '').trim(),
      strategy: strategy,
      tokens_before: normalizeNonnegativeInteger(source.tokens_before),
      tokens_after: tokensAfter,
      replacement_tokens: replacementTokens,
      boundary_message_count: boundaryMessageCount,
    };
  }

  function buildContextUsageEstimate(messages, options) {
    var opts = options || {};
    var list = Array.isArray(messages) ? messages : [];
    var historyScope = normalizeHistoryScope(opts.historyScope);
    var compactionContext = normalizeCompactionContext(opts.compactionContext);
    var messageTokens;
    var usageSource = 'estimate';
    if (
      historyScope === 'session'
      && compactionContext
      && list.length >= compactionContext.boundary_message_count
    ) {
      messageTokens = (compactionContext.replacement_tokens || compactionContext.tokens_after)
        + estimateContextMessagesTokens(
          list.slice(compactionContext.boundary_message_count),
          'session'
        );
      usageSource = 'compaction';
    } else {
      messageTokens = estimateContextMessagesTokens(list, historyScope);
    }
    var usedTokens = messageTokens
      + normalizeNonnegativeInteger(opts.overheadTokens)
      + estimateAttachmentTokens(opts.attachments);
    if (usedTokens <= 0) return null;
    /* Continuity with the last authoritative reading (Cause B of the meter
     * accuracy work): the caller passes the stored record's threshold so the
     * fallback renders against the SAME denominator (no ~2x percentage jump
     * when the estimate takes over), and its usedTokens as a floor so a model
     * switch cannot collapse the numerator to the bare chars/4 sum. The floor
     * only applies when the estimate is already renderable — a deliberately
     * empty scope (fresh) still reads as empty. */
    var priorUsedTokens = normalizePositiveInteger(opts.priorUsedTokens);
    if (priorUsedTokens > usedTokens) usedTokens = priorUsedTokens;
    var contextLimit = normalizePositiveInteger(opts.contextLimit);
    if (contextLimit <= 0) return null;
    return {
      usedTokens: usedTokens,
      totalTokens: usedTokens,
      contextLimit: contextLimit,
      compactThresholdTokens: normalizePositiveInteger(opts.compactThresholdTokens),
      model: String(opts.model || '').trim(),
      usageSource: usageSource,
      updatedAt: Date.now(),
    };
  }

  function resolveContextTarget(data, options) {
    var opts = options || {};
    var threshold = normalizePositiveInteger(data && data.compactThresholdTokens);
    var autoCompactEnabled = opts.autoCompactEnabled !== false;
    if (autoCompactEnabled && threshold > 0) {
      return { limit: threshold, type: 'auto_compact', exact: true };
    }
    var contextLimit = normalizePositiveInteger(data && data.contextLimit);
    if (contextLimit > 0) {
      return { limit: contextLimit, type: 'context_window', exact: true };
    }
    return { limit: 0, type: '', exact: false };
  }

  /* Which lane produced a usage record. 'terminal' is the turn's authoritative
   * chat.done reading; 'preflight'/'iteration' are the ephemeral mid-turn
   * context.usage snapshots that keep the ring moving during a long agentic
   * turn. Only the payload TYPE decides this — a mid-turn payload's own
   * `phase` field is a refinement, never a way to claim terminal authority. */
  function normalizeUsagePhase(payload) {
    if (String(payload && payload.type || '') !== 'context_usage') return 'terminal';
    return payload.phase === 'preflight' ? 'preflight' : 'iteration';
  }

  function normalizeUsagePayload(payload, now) {
    if (!payload || typeof payload !== 'object') return null;
    var usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
    var lastRequestTokens = normalizePositiveInteger(usage.last_request_input_tokens);
    var contextEstimate = normalizePositiveInteger(
      payload.context_tokens_estimate || usage.context_tokens_estimate
    );
    var usedTokens = 0;
    var usageSource = 'turn';
    // Sidecar-computed single source of truth (max of provider truth and the
    // assembled-prompt estimate — attach_context_used_tokens). Legacy payloads
    // without it fall through to the local guard below, byte-identical.
    var contextUsed = normalizePositiveInteger(
      payload.context_used_tokens || usage.context_used_tokens
    );
    if (contextUsed > 0) {
      usedTokens = contextUsed;
      var contextUsedSource = payload.context_used_source || usage.context_used_source;
      usageSource = contextUsedSource === 'provider' ? 'provider' : 'context';
    } else if (lastRequestTokens > 0 && lastRequestTokens >= contextEstimate) {
      usedTokens = lastRequestTokens;
      usageSource = 'provider';
    } else if (contextEstimate > 0) {
      usedTokens = contextEstimate;
      usageSource = 'context';
    }
    return {
      usedTokens: usedTokens,
      totalTokens: normalizeNonnegativeInteger(usage.total_tokens),
      contextLimit: normalizePositiveInteger(payload.context_window || usage.context_window),
      compactThresholdTokens: normalizePositiveInteger(
        payload.compact_threshold_tokens || usage.compact_threshold_tokens
      ),
      model: String(payload.model || usage.model || '').trim(),
      usageSource: usageSource,
      /* turnId == streamId in this codebase; it scopes the mid-turn/terminal
       * precedence below so a late snapshot can only lose to ITS OWN turn's
       * terminal, never to the previous turn's. */
      turnId: normalizeSessionId(payload.streamId),
      phase: normalizeUsagePhase(payload),
      updatedAt: typeof now === 'function' ? now() : Date.now(),
    };
  }

  function buildEstimateSignature(options) {
    var opts = options || {};
    var attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
    var attachmentSignature = attachments.map(function attachmentPart(entry) {
      return [String(entry?.id || ''), String(entry?.kind || ''), Number(entry?.sizeBytes || 0)].join(':');
    }).join('|');
    var compaction = normalizeCompactionContext(opts.compactionContext);
    return [
      normalizeHistoryScope(opts.historyScope),
      normalizePositiveInteger(opts.contextLimit),
      /* Both continuity inputs are part of the estimate's value, so both must
       * be part of the memo key — an omitted signature input means a stale
       * cached estimate survives the stored record changing. */
      normalizePositiveInteger(opts.compactThresholdTokens),
      normalizePositiveInteger(opts.priorUsedTokens),
      String(opts.model || '').trim(),
      normalizeNonnegativeInteger(opts.overheadTokens),
      opts.autoCompactEnabled === true ? 'auto:on' : 'auto:off',
      attachmentSignature,
      compaction
        ? [
          compaction.version,
          compaction.created_at,
          compaction.tokens_after,
          compaction.replacement_tokens,
          compaction.boundary_message_count,
        ].join(':')
        : '',
    ].join('\u001f');
  }

  function createContextUsageStore(options) {
    var opts = options || {};
    var now = typeof opts.now === 'function' ? opts.now : Date.now;
    var usageBySession = new Map();
    var estimateBySession = new Map();

    function invalidateEstimate(sessionId) {
      var key = normalizeSessionId(sessionId);
      if (key) estimateBySession.delete(key);
    }

    /* Terminal ALWAYS writes. A mid-turn snapshot is dropped when it would
     * regress its own turn's already-settled terminal reading (late arrival),
     * or when it carries no new information — the ring must not repaint for an
     * identical number. Precedence is scoped by turnId, so a mid-turn snapshot
     * for turn N+1 always supersedes turn N's terminal record. */
    function supersedesStoredUsage(prior, record) {
      if (record.phase === 'terminal') return true;
      if (!prior || !prior.turnId || prior.turnId !== record.turnId) return true;
      if (prior.phase === 'terminal') return false;
      return !(
        prior.usedTokens === record.usedTokens
        && prior.compactThresholdTokens === record.compactThresholdTokens
        && prior.contextLimit === record.contextLimit
      );
    }

    function updateUsage(sessionId, payload) {
      var key = normalizeSessionId(sessionId);
      var record = normalizeUsagePayload(payload, now);
      if (!key || !record) return null;
      var prior = usageBySession.get(key) || null;
      if (!supersedesStoredUsage(prior, record)) return prior;
      usageBySession.set(key, record);
      invalidateEstimate(key);
      pruneUsage();
      return record;
    }

    function updateCompactionUsage(sessionId, result, metadata) {
      var key = normalizeSessionId(sessionId);
      var source = result && typeof result === 'object' ? result : {};
      var usedTokens = normalizePositiveInteger(source.tokens_after);
      if (!key || source.compacted !== true || source.snapshot_persisted !== true || !usedTokens) {
        return null;
      }
      var prior = usageBySession.get(key) || {};
      var meta = metadata && typeof metadata === 'object' ? metadata : {};
      var record = {
        usedTokens: usedTokens,
        totalTokens: usedTokens,
        contextLimit: normalizePositiveInteger(meta.contextLimit) || normalizePositiveInteger(prior.contextLimit),
        compactThresholdTokens: normalizePositiveInteger(meta.compactThresholdTokens)
          || normalizePositiveInteger(prior.compactThresholdTokens),
        model: String(meta.model || prior.model || '').trim(),
        usageSource: 'compaction',
        /* Manual "compact now" is turn-less: no turnId means the next mid-turn
         * snapshot supersedes it normally instead of being fenced out. */
        turnId: '',
        phase: 'terminal',
        updatedAt: now(),
      };
      usageBySession.set(key, record);
      invalidateEstimate(key);
      pruneUsage();
      return record;
    }

    function getUsage(sessionId) {
      return usageBySession.get(normalizeSessionId(sessionId)) || null;
    }

    function buildCachedEstimate(sessionId, messages, estimateOptions) {
      var key = normalizeSessionId(sessionId);
      if (!key) return buildContextUsageEstimate(messages, estimateOptions);
      var list = Array.isArray(messages) ? messages : [];
      var signature = buildEstimateSignature(estimateOptions);
      var cached = estimateBySession.get(key);
      if (
        cached
        && cached.messages === list
        && cached.messageCount === list.length
        && cached.signature === signature
      ) {
        cached.updatedAt = now();
        return cached.value;
      }
      var value = buildContextUsageEstimate(list, estimateOptions);
      estimateBySession.set(key, {
        messages: list,
        messageCount: list.length,
        signature: signature,
        value: value,
        updatedAt: now(),
      });
      pruneUsage();
      return value;
    }

    function clearUsage(sessionId) {
      var key = normalizeSessionId(sessionId);
      if (!key) return;
      usageBySession.delete(key);
      estimateBySession.delete(key);
    }

    function clearAllUsage() {
      usageBySession.clear();
      estimateBySession.clear();
    }

    function pruneUsage(pruneOptions) {
      var settings = pruneOptions || {};
      var maxAgeMs = typeof settings.maxAgeMs === 'number' && settings.maxAgeMs >= 0
        ? settings.maxAgeMs
        : DEFAULT_MAX_AGE_MS;
      var maxEntries = typeof settings.maxEntries === 'number' && settings.maxEntries > 0
        ? settings.maxEntries
        : DEFAULT_MAX_ENTRIES;
      var keep = new Set(
        Array.isArray(settings.keepSessionIds)
          ? settings.keepSessionIds.map(normalizeSessionId).filter(Boolean)
          : []
      );
      var removed = 0;
      var cutoff = now() - maxAgeMs;
      for (var pair of usageBySession.entries()) {
        var sessionId = pair[0];
        var record = pair[1];
        if (keep.has(sessionId)) continue;
        if (!Number(record && record.updatedAt) || Number(record.updatedAt) < cutoff) {
          usageBySession.delete(sessionId);
          estimateBySession.delete(sessionId);
          removed += 1;
        }
      }
      if (usageBySession.size > maxEntries) {
        var ordered = Array.from(usageBySession.entries()).sort(function byAge(a, b) {
          return Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0);
        });
        var toDrop = usageBySession.size - maxEntries;
        for (var index = 0; index < ordered.length && toDrop > 0; index += 1) {
          var candidateId = ordered[index][0];
          if (keep.has(candidateId)) continue;
          usageBySession.delete(candidateId);
          estimateBySession.delete(candidateId);
          removed += 1;
          toDrop -= 1;
        }
      }
      for (var estimateEntry of estimateBySession.entries()) {
        var estimateSessionId = estimateEntry[0];
        var estimateRecord = estimateEntry[1];
        if (!usageBySession.has(estimateSessionId)
            && !keep.has(estimateSessionId)
            && Number(estimateRecord?.updatedAt || 0) < cutoff) {
          estimateBySession.delete(estimateSessionId);
        }
      }
      if (estimateBySession.size > maxEntries) {
        var orderedEstimates = Array.from(estimateBySession.entries()).sort(function byEstimateAge(a, b) {
          return Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0);
        });
        var estimatesToDrop = estimateBySession.size - maxEntries;
        for (var estimateIndex = 0; estimateIndex < orderedEstimates.length && estimatesToDrop > 0; estimateIndex += 1) {
          var estimateCandidateId = orderedEstimates[estimateIndex][0];
          if (keep.has(estimateCandidateId)) continue;
          estimateBySession.delete(estimateCandidateId);
          estimatesToDrop -= 1;
        }
      }
      return removed;
    }

    return {
      updateUsage: updateUsage,
      updateCompactionUsage: updateCompactionUsage,
      getUsage: getUsage,
      clearUsage: clearUsage,
      clearAllUsage: clearAllUsage,
      pruneUsage: pruneUsage,
      invalidateEstimate: invalidateEstimate,
      buildCachedEstimate: buildCachedEstimate,
    };
  }

  return {
    ATTACHMENT_AUDIO_TOKEN_ESTIMATE: ATTACHMENT_AUDIO_TOKEN_ESTIMATE,
    ATTACHMENT_IMAGE_TOKEN_ESTIMATE: ATTACHMENT_IMAGE_TOKEN_ESTIMATE,
    RECENT_TURN_GROUP_LIMIT: RECENT_TURN_GROUP_LIMIT,
    buildContextUsageEstimate: buildContextUsageEstimate,
    buildMessageTokenMeta: buildMessageTokenMeta,
    createContextUsageStore: createContextUsageStore,
    estimateAttachmentTokens: estimateAttachmentTokens,
    estimateContextMessagesTokens: estimateContextMessagesTokens,
    estimateTextTokens: estimateTextTokens,
    normalizeCompactionContext: normalizeCompactionContext,
    normalizeHistoryScope: normalizeHistoryScope,
    normalizePositiveInteger: normalizePositiveInteger,
    normalizeUsagePayload: normalizeUsagePayload,
    resolveContextTarget: resolveContextTarget,
    selectContextEstimateMessages: selectContextEstimateMessages,
    walkMessageTokenEstimates: walkMessageTokenEstimates,
  };
});
