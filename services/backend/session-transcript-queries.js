const FIRST_ASSISTANT_SENTENCE_RE = /\bfirst\s+(?:sentence|thing|message)\b/i;
const ASSISTANT_SPEECH_RE = /\b(?:you|jenny)\s+(?:sent|said|wrote|asked)\b/i;
const SESSION_SCOPE_RE = /\b(?:this|the)\s+(?:session|chat|conversation)\b/i;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isFirstAssistantSentenceQuery(prompt) {
  const text = normalizeText(prompt);
  return Boolean(
    text
    && FIRST_ASSISTANT_SENTENCE_RE.test(text)
    && ASSISTANT_SPEECH_RE.test(text)
    && SESSION_SCOPE_RE.test(text)
  );
}

function assistantTranscriptText(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return '';
  }
  if (String(message.role || '').trim() !== 'assistant') {
    return '';
  }
  const kind = String(message.kind || '').trim();
  if (kind === 'question_batch') {
    const introText = normalizeText(message.interactive_batch?.intro_text);
    if (introText) {
      return introText;
    }
  }
  if (kind === 'tool_use' || kind === 'tool_result') {
    return '';
  }
  return normalizeText(message.content);
}

function firstSentence(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return '';
  }
  const sentence = normalized.match(/^(.+?[.!?]["'\u201d\u2019)\]}]*)(?:\s|$)/u);
  return normalizeText(sentence ? sentence[1] : normalized);
}

function resolveSessionTranscriptAnswer({ prompt, messages } = {}) {
  if (!isFirstAssistantSentenceQuery(prompt)) {
    return null;
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    const sentence = firstSentence(assistantTranscriptText(message));
    if (sentence) {
      return `The first sentence I sent to you this session was: ${JSON.stringify(sentence)}`;
    }
  }
  return null;
}

module.exports = {
  assistantTranscriptText,
  firstSentence,
  isFirstAssistantSentenceQuery,
  resolveSessionTranscriptAnswer,
};
