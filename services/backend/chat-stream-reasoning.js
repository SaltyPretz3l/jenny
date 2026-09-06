const { budgetAttachmentEntries, isTextAttachment } = require('../attachment-service');
const { createReasoningEntry } = require('./backend-service-utils');
const {
  normalizeContextPreferences,
} = require('./context-preferences');
const {
  buildInteractiveQuestionBatchTranscript,
  buildInteractiveRoundRecapTranscript,
} = require('./interactive-session-utils');
const {
  sanitizeGrowingReasoningTail,
  sanitizePersistedReasoningText,
} = require('./chat-stream-reasoning-sanitize');

const RECENT_TURN_GROUP_LIMIT = 6;
const MAX_PERSISTED_REASONING_ENTRIES = 40;
const MAX_PERSISTED_REASONING_CHARS = 48_000;

function serializeMessageContent(content) {
  return String(content || '').trim();
}

function buildPromptWithAttachments(prompt, attachments) {
  const basePrompt = serializeMessageContent(prompt);
  const budgeted = budgetAttachmentEntries(attachments);
  const acceptedTextAttachments = budgeted.accepted.filter((entry) => isTextAttachment(entry));
  if (!acceptedTextAttachments.length) {
    return basePrompt;
  }

  const attachmentBlocks = acceptedTextAttachments
    .map((entry) => {
      const promptName = String(entry.promptName || entry.displayName || 'attachment.txt').trim();
      return `--- file: ${promptName} ---\n${String(entry.text || '').trim()}\n--- end file ---`;
    })
    .join('\n\n');

  return `${basePrompt}\n\nAttached files:\n${attachmentBlocks}`.trim();
}

function normalizeReasoningSentence(value) {
  const collapsed = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) {
    return '';
  }

  const sentenceMatch = collapsed.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = sentenceMatch ? sentenceMatch[1] : collapsed;
  return sentence.length > 220 ? `${sentence.slice(0, 217).trim()}...` : sentence;
}

function collectReasoningTexts(source, bucket) {
  if (!source) {
    return;
  }

  if (typeof source === 'string') {
    const normalized = normalizeReasoningSentence(source);
    if (normalized) {
      bucket.push(normalized);
    }
    return;
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      collectReasoningTexts(item, bucket);
    }
    return;
  }

  if (typeof source !== 'object') {
    return;
  }

  collectReasoningTexts(source.summary, bucket);
  collectReasoningTexts(source.text, bucket);
  collectReasoningTexts(source.content, bucket);
  collectReasoningTexts(source.reasoning, bucket);
  collectReasoningTexts(source.entries, bucket);
  collectReasoningTexts(source.reasoning_summary, bucket);
  collectReasoningTexts(source.reasoning_text, bucket);
  collectReasoningTexts(source.reasoning_content, bucket);
  collectReasoningTexts(source.reasoning_details, bucket);
}

function extractProviderReasoningDelta(payload, timestamp = new Date().toISOString()) {
  const choices = Array.isArray(payload && payload.choices) ? payload.choices : [];
  const delta = choices[0] && choices[0].delta ? choices[0].delta : null;
  if (!delta) {
    return null;
  }

  const collected = [];
  collectReasoningTexts(delta.reasoning, collected);
  collectReasoningTexts(delta.reasoning_summary, collected);
  collectReasoningTexts(delta.reasoning_text, collected);
  collectReasoningTexts(delta.reasoning_content, collected);
  collectReasoningTexts(delta.reasoning_details, collected);

  const deduped = [];
  const seen = new Set();
  for (const text of collected) {
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    deduped.push(text);
  }

  if (!deduped.length) {
    return null;
  }

  return {
    source: 'provider',
    entriesDelta: deduped.map((text, index) => createReasoningEntry(text, index, timestamp)),
  };
}

function mergeReasoningEntries(existingEntries, incomingEntries) {
  const merged = [];
  const indexById = new Map();
  const combined = []
    .concat(Array.isArray(existingEntries) ? existingEntries : [])
    .concat(Array.isArray(incomingEntries) ? incomingEntries : []);

  for (const item of combined) {
    if (!item || !item.text) {
      continue;
    }
    const entry = {
      id: String(item.id || `reasoning_${merged.length}`),
      text: String(item.text || '').trim(),
      timestamp: String(item.timestamp || ''),
    };
    if (item.thinkingId != null && String(item.thinkingId || '')) {
      entry.thinkingId = String(item.thinkingId || '');
    }
    if (!entry.text) {
      continue;
    }
    const existingIndex = indexById.get(entry.id);
    if (Number.isInteger(existingIndex)) {
      merged[existingIndex] = entry;
      continue;
    }
    const duplicateIndex = merged.findIndex(
      (existingEntry) =>
        existingEntry.text === entry.text
        && existingEntry.timestamp === entry.timestamp
        && String(existingEntry.thinkingId || '') === String(entry.thinkingId || '')
    );
    if (duplicateIndex !== -1) {
      continue;
    }
    indexById.set(entry.id, merged.length);
    merged.push(entry);
  }

  return merged;
}

function truncateReasoningText(text, remainingChars) {
  if (text.length <= remainingChars) {
    return { text, truncated: false };
  }
  let keptLimit = remainingChars;
  while (keptLimit > 0) {
    const keptText = text.slice(0, keptLimit).trimEnd();
    const omittedChars = text.length - keptText.length;
    const marker = `\n\n_[reasoning truncated - ${omittedChars} more characters not stored]_`;
    const nextKeptLimit = remainingChars - marker.length;
    if (nextKeptLimit < 0) return { text: '', truncated: true };
    if (keptText.length <= nextKeptLimit) return { text: `${keptText}${marker}`, truncated: true };
    keptLimit = nextKeptLimit;
  }
  return { text: '', truncated: true };
}

function unchangedReasoningResult(entries, rawText, sanitizedTailText, truncated = false) {
  return { entries, entry: null, truncated, rawText, sanitizedTailText };
}

function appendPersistedReasoningEntry(
  existingEntries,
  incomingText,
  timestamp = new Date().toISOString(),
  options = {}
) {
  const currentEntries = Array.isArray(existingEntries) ? existingEntries.slice() : [];
  const settings = options && typeof options === 'object' ? options : {};
  const maxTotalChars = Number.isInteger(settings.maxTotalChars) && settings.maxTotalChars > 0 ? settings.maxTotalChars : MAX_PERSISTED_REASONING_CHARS;
  const coalesceTail = settings.coalesceTail === true;
  const lastEntry = currentEntries[currentEntries.length - 1] || null;
  // Optional caller-maintained raw accumulation for the tail entry: sanitizing
  // trims the trailing edge, so joining on the SANITIZED tail destroyed every
  // chunk-final newline ("sequentially:\n" + "1. Create" -> "sequentially:1.
  // Create"). When the caller threads the raw text back in, the join happens
  // at the true chunk boundary and only the final result is sanitized.
  const rawTailText = typeof settings.rawTailText === 'string' ? settings.rawTailText : '';
  const sanitizedTailText = typeof settings.sanitizedTailText === 'string'
    ? settings.sanitizedTailText : String(lastEntry?.text || '');
  // Post-cap early-out must measure against the tail's SHARE of the budget,
  // not the whole cap: earlier entries (checkpoint phases) consume
  // priorEntriesChars of it, and thresholding on the whole cap left a
  // priorEntriesChars-wide window where every delta re-sanitized the full
  // tail and re-emitted a churning truncation marker.
  const priorEntriesChars = coalesceTail && lastEntry
    ? currentEntries
        .slice(0, -1)
        .reduce((sum, entry) => sum + String(entry?.text || '').length, 0)
    : 0;
  if (coalesceTail && lastEntry && priorEntriesChars + rawTailText.length >= maxTotalChars) {
    return unchangedReasoningResult(currentEntries, rawTailText, sanitizedTailText, true);
  }
  const baseText = coalesceTail && lastEntry ? (rawTailText || String(lastEntry.text || '')) : '';
  const combinedInput = coalesceTail ? `${baseText}${String(incomingText || '')}` : incomingText;
  const combinedRawText = String(combinedInput || '').length > maxTotalChars
    ? String(combinedInput || '').slice(0, maxTotalChars)
    : String(combinedInput || '');
  const canSanitizeIncrementally = coalesceTail
    && lastEntry
    && rawTailText.length > 0
    // combinedInput is constructed from rawTailText here; avoid rescanning the full tail.
    && String(combinedInput || '').length > rawTailText.length
    && !String(lastEntry.text || '').includes('_[reasoning truncated - ');
  const sanitizedText = canSanitizeIncrementally
    ? sanitizeGrowingReasoningTail(
        rawTailText, String(combinedInput || '').slice(rawTailText.length), sanitizedTailText
      )
    : sanitizePersistedReasoningText(combinedInput).text;
  if (!sanitizedText) {
    return unchangedReasoningResult(currentEntries, coalesceTail ? combinedRawText : rawTailText, sanitizedText);
  }
  if (!coalesceTail && currentEntries.length >= MAX_PERSISTED_REASONING_ENTRIES) {
    return unchangedReasoningResult(currentEntries, rawTailText, sanitizedTailText, true);
  }
  const charBudgetBase = coalesceTail && lastEntry
    ? priorEntriesChars
    : currentEntries.reduce((sum, entry) => sum + String(entry?.text || '').length, 0);
  const nextEntryCount = coalesceTail && lastEntry ? currentEntries.length : currentEntries.length + 1;
  if (nextEntryCount > MAX_PERSISTED_REASONING_ENTRIES) {
    return unchangedReasoningResult(currentEntries, rawTailText, sanitizedTailText, true);
  }
  const remainingChars = maxTotalChars - charBudgetBase;
  const truncatedResult = truncateReasoningText(sanitizedText, remainingChars);
  const { text, truncated } = truncatedResult;
  if (!text) {
    return unchangedReasoningResult(currentEntries, rawTailText, sanitizedTailText, truncated);
  }
  if (coalesceTail && lastEntry && String(lastEntry.text || '').trim() === text) {
    return unchangedReasoningResult(currentEntries, combinedRawText, sanitizedText, truncated);
  }
  if (!coalesceTail && currentEntries.some((entry) => String(entry?.text || '').trim() === text)) {
    return unchangedReasoningResult(currentEntries, rawTailText, sanitizedText, truncated);
  }
  const thinkingId = String(settings.thinkingId || '');
  const entry = coalesceTail && lastEntry
    ? {
        ...lastEntry,
        text,
        timestamp: timestamp || lastEntry.timestamp || new Date().toISOString(),
        thinkingId: thinkingId || lastEntry.thinkingId || '',
      }
    : createReasoningEntry(text, currentEntries.length, timestamp, thinkingId);
  const nextEntries = coalesceTail && lastEntry
    ? currentEntries.slice(0, -1).concat(entry)
    : currentEntries.concat(entry);
  return { entries: nextEntries, entry, truncated, rawText: combinedRawText, sanitizedTailText: sanitizedText };
}

function convertToolUseToProviderMessage(message) {
  const tc = message.tool_call;
  if (!tc || !tc.call_id || !tc.tool_name) {
    return null;
  }
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: tc.call_id,
        type: 'function',
        function: {
          name: tc.tool_name,
          arguments: tc.input_json || JSON.stringify(tc.input || {}),
        },
      },
    ],
  };
}

function isHarnessSnapshotToolResult(toolResult) {
  if (!toolResult || typeof toolResult !== 'object' || Array.isArray(toolResult)) {
    return false;
  }
  if (String(toolResult.tool_name || '').trim() === 'inspect_harness') {
    return true;
  }
  const metadata = toolResult.metadata;
  return (
    metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && String(metadata.result_kind || '').trim() === 'harness_snapshot'
  );
}

function summarizeHistoricalToolResult(message) {
  const toolResult = message && typeof message === 'object' ? message.tool_result : null;
  const summary = String(toolResult?.summary || toolResult?.tool_name || message?.content || '').trim();
  if (isHarnessSnapshotToolResult(toolResult)) {
    return (
      `${summary || 'Harness snapshot'} completed in a prior turn. `
      + 'Use jenny_status for a current report.'
    );
  }
  return String(toolResult?.output_text || serializeMessageContent(message.content)).trim();
}

function convertToolResultToProviderMessage(message) {
  const tr = message.tool_result;
  if (!tr || !tr.call_id) {
    return null;
  }
  const providerMessage = {
    role: 'tool',
    tool_call_id: tr.call_id,
    content: summarizeHistoricalToolResult(message),
    tool_envelope: { v: 1 },
  };
  const name = String(tr.tool_name || '').trim();
  if (name) {
    providerMessage.name = name;
  }
  if (tr.is_error === true) {
    providerMessage.is_error = true;
  }
  const errorCode = typeof tr.error_code === 'string' ? tr.error_code.trim() : '';
  if (errorCode) {
    providerMessage.error_code = errorCode;
  }
  const metadata = tr.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    for (const key of [
      'failure_class',
      'effects',
      'precondition_id',
      'remediation',
      'failed_phase',
      'phase_timings_json',
      'trace_id',
      'idempotency_key',
    ]) {
      const value = typeof metadata[key] === 'string' ? metadata[key].trim() : '';
      if (value) {
        providerMessage.tool_envelope[key] = value;
      }
    }
  }
  // elapsed_ms comes ONLY from persisted metadata (the same source the
  // in-turn envelope reads), never from Electron-measured duration_ms —
  // sourcing them differently would make history framing drift from what the
  // model saw in-turn for the same result.
  const elapsedMs = Number(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata.elapsed_ms
      : NaN
  );
  if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
    providerMessage.tool_envelope.elapsed_ms = elapsedMs;
  }
  return providerMessage;
}

function convertQuestionBatchToProviderMessage(message) {
  const content = buildInteractiveQuestionBatchTranscript(message?.interactive_batch);
  if (!content) {
    return null;
  }
  return {
    role: 'assistant',
    content,
  };
}

function convertInteractiveRoundRecapToProviderMessage(message) {
  const content = buildInteractiveRoundRecapTranscript(message?.interactive_round_recap);
  if (!content) {
    return null;
  }
  return {
    role: 'user',
    content,
  };
}

function isPlainUserAnchorMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  return String(message.role || '').trim() === 'user' && !String(message.kind || '').trim();
}

function selectRecentTurnGroups(messages, maxGroups = RECENT_TURN_GROUP_LIMIT) {
  const groups = [];
  let currentGroup = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (isPlainUserAnchorMessage(message)) {
      if (currentGroup.length) {
        groups.push(currentGroup);
      }
      currentGroup = [message];
      continue;
    }
    // Messages before the first plain user anchor are intentionally
    // dropped in 'recent' mode. System/personality context is re-injected
    // fresh on each send, so only user-anchored turn groups are retained.
    if (currentGroup.length) {
      currentGroup.push(message);
    }
  }

  if (currentGroup.length) {
    groups.push(currentGroup);
  }

  return groups.slice(-Math.max(0, Number(maxGroups) || 0)).flat();
}

function selectContextHistoryMessages(messages, contextPreferences) {
  const normalized = normalizeContextPreferences(contextPreferences);
  if (normalized.history_scope === 'fresh') {
    return [];
  }
  if (normalized.history_scope === 'recent') {
    return selectRecentTurnGroups(messages, RECENT_TURN_GROUP_LIMIT);
  }
  if (normalized.history_scope === 'session') {
    return Array.isArray(messages) ? messages : [];
  }
  throw new Error(`Unsupported context history scope: ${normalized.history_scope}`);
}

function buildPreparedContextHistory(messages, contextPreferences) {
  const contextHistory = selectContextHistoryMessages(
    messages,
    contextPreferences
  );
  const preparedMessages = [...contextHistory]
    .filter((message) => {
      const kind = String(message.kind || '');
      if (
        kind === 'proactive_suggestion'
      ) {
        return false;
      }
      if (kind === 'tool_use' || kind === 'tool_result') {
        return true;
      }
      return message.role === 'user' || message.role === 'assistant' || message.role === 'system';
    })
    .map((message) => {
      const kind = String(message.kind || '');
      if (kind === 'tool_use') {
        return convertToolUseToProviderMessage(message);
      }
      if (kind === 'tool_result') {
        return convertToolResultToProviderMessage(message);
      }
      if (kind === 'question_batch') {
        return convertQuestionBatchToProviderMessage(message);
      }
      if (kind === 'interactive_round_recap') {
        return convertInteractiveRoundRecapToProviderMessage(message);
      }
      return {
        role: message.role,
        content: serializeMessageContent(message.content),
      };
    })
    .filter((message) => {
      if (!message) return false;
      if (message.tool_calls) return true;
      if (message.role === 'tool') return true;
      return Boolean(message.content);
    });

  // Fold a text-only assistant message into the following tool_calls
  // assistant message.  With text segmentation, the store may contain
  // [text_seg, tool_use, ...] which maps to two consecutive assistant
  // messages.  Merging them produces the standard single-turn format:
  // {role: 'assistant', content: '...', tool_calls: [...]}.
  const folded = [];
  for (const msg of preparedMessages) {
    const prev = folded[folded.length - 1];
    if (
      prev
      && prev.role === 'assistant'
      && !prev.tool_calls
      && typeof prev.content === 'string'
      && msg.role === 'assistant'
      && msg.tool_calls
    ) {
      folded[folded.length - 1] = { ...msg, content: prev.content };
    } else {
      folded.push(msg);
    }
  }

  return folded;
}

function buildPreparedMessages(messages, prompt, options = {}) {
  const folded = buildPreparedContextHistory(messages, options.contextPreferences);
  folded.push({
    role: 'user',
    content: buildPromptWithAttachments(prompt, options.attachments),
  });

  return folded;
}

module.exports = {
  buildPreparedContextHistory,
  buildPromptWithAttachments,
  buildPreparedMessages,
  convertToolUseToProviderMessage,
  convertToolResultToProviderMessage,
  extractProviderReasoningDelta,
  mergeReasoningEntries,
  appendPersistedReasoningEntry,
  normalizeReasoningSentence,
  sanitizePersistedReasoningText,
  selectContextHistoryMessages,
  selectRecentTurnGroups,
  serializeMessageContent,
};
