'use strict';

const { buildVisibleSegmentContent } = require('../backend/message-normalization');

const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_PAGE_BYTES = 262_144;

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function projectOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (typeof option === 'string') return { id: option, label: option };
    if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
    const id = asText(option.id).trim();
    const label = asText(option.label).trim();
    return id && label ? { id, label } : null;
  }).filter(Boolean);
}

function projectInteractiveBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return null;
  const batchId = asText(batch.batch_id || batch.batchId).trim();
  if (!batchId || !Array.isArray(batch.questions)) return null;
  const questions = batch.questions.map((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return null;
    const id = asText(question.id).trim();
    const prompt = asText(question.prompt).trim();
    if (!id || !prompt) return null;
    return {
      id,
      prompt,
      options: projectOptions(question.options),
      multi_select: question.multi_select === true,
    };
  }).filter(Boolean);
  return { batch_id: batchId, questions };
}

function projectMessage(message) {
  const source = message && typeof message === 'object' && !Array.isArray(message) ? message : {};
  return {
    id: asText(source.id),
    role: asText(source.role),
    kind: asText(source.kind),
    content: buildVisibleSegmentContent(source.visible_segments, source.content),
    status: asText(source.status),
    terminal_subcode: asText(source.terminal_subcode),
    timestamp: asText(source.timestamp),
    parent_stream_id: asText(source.parent_stream_id || source.parentStreamId),
    event_seq: Number.isSafeInteger(source.event_seq) && source.event_seq >= 0
      ? source.event_seq : null,
    tool_steps: (Array.isArray(source.tool_steps) ? source.tool_steps : [])
      .map((step) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
        const name = asText(step.name || step.tool_name || step.toolName).trim();
        return name ? { name, status: asText(step.status) } : null;
      })
      .filter(Boolean),
    interactive_batch: projectInteractiveBatch(source.interactive_batch),
    truncated: source.truncated === true,
  };
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function serializedBytes(message) {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function fitOversizedMessage(message, maxBytes) {
  const candidate = { ...message, content: '', truncated: true };
  if (serializedBytes(candidate) > maxBytes) return candidate;
  const content = String(message.content || '');
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    candidate.content = content.slice(0, middle);
    if (serializedBytes(candidate) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  candidate.content = content.slice(0, low);
  return candidate;
}

function projectPage(messages, { before, limit, limits = {} } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const maxMessages = positiveInteger(limits.TRANSCRIPT_PAGE_MAX_MESSAGES, DEFAULT_PAGE_LIMIT);
  const maxBytes = positiveInteger(limits.TRANSCRIPT_PAGE_MAX_BYTES, DEFAULT_PAGE_BYTES);
  const requestedLimit = Math.min(positiveInteger(limit, maxMessages), maxMessages);
  const beforeId = asText(before).trim();
  const located = beforeId ? source.findIndex((message) => asText(message?.id) === beforeId) : -1;
  const end = located >= 0 ? located : source.length;
  const selected = [];
  let usedBytes = 2;
  let cursor = end - 1;

  for (; cursor >= 0 && selected.length < requestedLimit; cursor -= 1) {
    const projected = projectMessage(source[cursor]);
    const bytes = serializedBytes(projected);
    const separatorBytes = selected.length ? 1 : 0;
    if (usedBytes + separatorBytes + bytes > maxBytes) {
      if (selected.length) break;
      const fitted = fitOversizedMessage(projected, Math.max(0, maxBytes - usedBytes));
      selected.push(fitted);
      cursor -= 1;
      break;
    }
    selected.push(projected);
    usedBytes += separatorBytes + bytes;
  }

  selected.reverse();
  const hasMore = cursor >= 0;
  return {
    messages: selected,
    has_more: hasMore,
    next_before: hasMore
      ? (selected[0]?.id || asText(source[cursor]?.id) || null)
      : null,
  };
}

module.exports = { projectMessage, projectPage };
