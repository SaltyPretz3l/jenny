const {
  buildInteractiveQuestionBatchTranscript,
  buildInteractiveRoundRecapTranscript,
} = require('./interactive-session-utils');

const EXCLUDED_KINDS = new Set([
  'tool_use',
  'tool_result',
  'proactive_suggestion',
  'slash_command_output',
  'reasoning-only',
]);
const MAX_LINKED_SESSIONS = 3, MAX_EXCERPTS_PER_SESSION = 2, MAX_TOTAL_CHARS = 1200;
function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function clipExcerpt(text, maxLength = 220) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(maxLength - 3, 1)).trimEnd()}...`;
}
function toTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function semanticRecallText(message) {
  const kind = String(message?.kind || '').trim();
  if (kind === 'question_batch') {
    return buildInteractiveQuestionBatchTranscript(message?.interactive_batch);
  }
  if (kind === 'interactive_round_recap') {
    return buildInteractiveRoundRecapTranscript(message?.interactive_round_recap);
  }
  return String(message?.content || '').trim();
}

function semanticRecallRole(message) {
  const kind = String(message?.kind || '').trim();
  if (kind === 'interactive_round_recap') {
    return 'user';
  }
  return String(message?.role || '').trim();
}

function buildSemanticRecallMessage(message) {
  const kind = String(message?.kind || '').trim();
  if (EXCLUDED_KINDS.has(kind)) {
    return null;
  }

  const role = semanticRecallRole(message);
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }

  const text = semanticRecallText(message);
  if (!text) {
    return null;
  }

  return {
    kind,
    role,
    text,
    timestamp: toTimestamp(message.timestamp),
  };
}

function buildRecallUnits(messages) {
  const recallMessages = (Array.isArray(messages) ? messages : [])
    .map((message) => buildSemanticRecallMessage(message))
    .filter(Boolean);
  const units = [];
  for (let index = 0; index < recallMessages.length; index += 1) {
    const current = recallMessages[index];
    const next = recallMessages[index + 1];
    if (
      !current.kind
      && !next?.kind
      && current.role === 'user'
      && next?.role === 'assistant'
    ) {
      units.push({
        excerpt: clipExcerpt(`User: ${current.text}\nAssistant: ${next.text}`),
        timestamp: Math.max(current.timestamp, next.timestamp),
      });
      index += 1;
      continue;
    }
    units.push({
      excerpt: clipExcerpt(`${current.role === 'user' ? 'User' : 'Assistant'}: ${current.text}`),
      timestamp: current.timestamp,
    });
  }
  return units;
}
function scoreUnits(units, queryText) {
  const queryTokens = tokenize(queryText);
  if (!queryTokens.length || !units.length) {
    return [];
  }
  const docs = units.map((unit) => ({ ...unit, tokens: tokenize(unit.excerpt) })).filter((unit) => unit.tokens.length);
  const averageLength = docs.reduce((sum, unit) => sum + unit.tokens.length, 0) / docs.length || 1;
  const docFreq = new Map();
  for (const unit of docs) {
    for (const token of new Set(unit.tokens)) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }
  return docs
    .map((unit) => {
      const termFreq = new Map();
      for (const token of unit.tokens) {
        termFreq.set(token, (termFreq.get(token) || 0) + 1);
      }
      let score = 0;
      for (const token of queryTokens) {
        const tf = termFreq.get(token) || 0;
        if (!tf) {
          continue;
        }
        const idf = Math.log(1 + ((docs.length - (docFreq.get(token) || 0) + 0.5) / ((docFreq.get(token) || 0) + 0.5)));
        score += idf * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (unit.tokens.length / averageLength))));
      }
      return { ...unit, score };
    })
    .filter((unit) => unit.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || right.timestamp - left.timestamp
      || left.excerpt.length - right.excerpt.length
    ));
}
function buildLinkedSessionContext(sessionStore, activeSessionId, prompt, recentUserTurns) {
  const activeSession = sessionStore?.getSession?.(activeSessionId);
  const linkedSessionIds = Array.isArray(activeSession?.linked_session_ids) ? activeSession.linked_session_ids : [];
  if (!linkedSessionIds.length) {
    return null;
  }
  const queryText = [
    String(prompt || '').trim(),
    ...(Array.isArray(recentUserTurns) ? recentUserTurns : []).map((turn) => String(turn?.content || turn || '').trim()),
  ].filter(Boolean).slice(0, 3).join('\n');
  const linkedSessions = linkedSessionIds
    .map((sessionId) => sessionStore.getSession(sessionId))
    .filter(Boolean)
    .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')))
    .slice(0, MAX_LINKED_SESSIONS);
  const sections = linkedSessions.map((session) => ({
    title: clipExcerpt(session.title || session.id || 'Linked session', 72),
    excerpts: scoreUnits(buildRecallUnits(sessionStore.getSessionMessages(session.id)), queryText)
      .slice(0, MAX_EXCERPTS_PER_SESSION)
      .map((unit) => unit.excerpt),
  })).filter((section) => section.excerpts.length);
  if (!sections.length) {
    return null;
  }
  let block = 'Linked session context:\n';
  for (const section of sections) {
    const sectionText = `${section.title}\n${section.excerpts.map((excerpt) => `- ${excerpt}`).join('\n')}\n`;
    if ((block + sectionText).length > MAX_TOTAL_CHARS) {
      const remaining = MAX_TOTAL_CHARS - block.length;
      if (remaining <= 0) {
        break;
      }
      block += clipExcerpt(sectionText, remaining);
      break;
    }
    block += sectionText;
  }
  const content = block.trim();
  return content === 'Linked session context:' ? null : { role: 'system', content };
}
module.exports = { buildLinkedSessionContext };
