const {
  buildInteractiveQuestionBatchTranscript,
  buildInteractiveRoundRecapTranscript,
} = require('./interactive-session-utils');
// The link popover marks the chats this picks (same rule, one helper).
const { selectLinkedRecallSessions } = require('../../renderer/shared/string-utils');

const EXCLUDED_KINDS = new Set([
  'tool_use',
  'tool_result',
  'proactive_suggestion',
  'slash_command_output',
  'reasoning-only',
]);
const MAX_EXCERPTS_PER_SESSION = 2, MAX_TOTAL_CHARS = 1200;
const EXCERPT_CHARS = 220;
// Each part of a unit is scored over at most this much normalized text, so one
// long message cannot crowd out its partner and the scoring cost stays bounded.
const MAX_SCORING_CHARS_PER_PART = 2000;
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

function recallPart(label, text) {
  return {
    label,
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SCORING_CHARS_PER_PART),
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
        parts: [recallPart('User', current.text), recallPart('Assistant', next.text)],
        timestamp: Math.max(current.timestamp, next.timestamp),
      });
      index += 1;
      continue;
    }
    units.push({
      parts: [recallPart(current.role === 'user' ? 'User' : 'Assistant', current.text)],
      timestamp: current.timestamp,
    });
  }
  return units;
}

// Index of the first occurrence of the rarest (highest-weight) query token in
// the text, found with the scoring tokenizer (lowercased [a-z0-9] runs), or -1.
// Anchoring on the rarest term keeps a common word ("the") from winning.
function bestQueryMatchIndex(text, tokenWeights) {
  let bestIndex = -1;
  let bestWeight = 0;
  for (const match of text.matchAll(/[A-Za-z0-9]+/g)) {
    const weight = tokenWeights.get(match[0].toLowerCase()) || 0;
    if (weight > bestWeight) {
      bestWeight = weight;
      bestIndex = match.index;
    }
  }
  return bestIndex;
}

// Show `text` in `budget` chars: a window around the match (with "..." marks
// where it is cut) or, with no match, the head.
function excerptPart(text, budget, matchIndex) {
  if (text.length <= budget) {
    return text;
  }
  if (matchIndex < 0) {
    return `${text.slice(0, Math.max(budget - 3, 1)).trimEnd()}...`;
  }
  let start = Math.max(0, matchIndex - Math.min(Math.floor(budget / 4), 40));
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < matchIndex) {
      start = space + 1;
    }
  }
  const prefix = start > 0 ? '...' : '';
  const room = budget - prefix.length;
  if (start + room >= text.length) {
    return `${prefix}${text.slice(start)}`;
  }
  return `${prefix}${text.slice(start, start + Math.max(room - 3, 1)).trimEnd()}...`;
}

// Split the text budget between the parts: a matching part is never squeezed
// out by a non-matching one, and unused share flows to the other part.
function allocatePartBudgets(parts, matches, total) {
  const matched = matches.filter((index) => index >= 0).length;
  const shares = parts.map((part, index) => {
    let base = Math.ceil(total / parts.length);
    if (parts.length > 1 && matched === 1) {
      base = matches[index] >= 0 ? total - Math.floor(total / 4) : Math.floor(total / 4);
    }
    return Math.min(base, part.text.length);
  });
  let leftover = total - shares.reduce((sum, share) => sum + share, 0);
  const byPriority = parts.map((part, index) => index).sort((left, right) => (
    Number(matches[right] >= 0) - Number(matches[left] >= 0) || left - right
  ));
  for (const index of byPriority) {
    const extra = Math.min(leftover, parts[index].text.length - shares[index]);
    shares[index] += extra;
    leftover -= extra;
  }
  return shares;
}

// Built after scoring, only for the selected units. A unit whose full lines
// already fit renders as plain "Label: text" lines joined by a space.
function buildUnitExcerpt(unit, tokenWeights) {
  const lines = unit.parts.map((part) => `${part.label}: ${part.text}`);
  const full = lines.join(' ');
  if (full.length <= EXCERPT_CHARS) {
    return full;
  }
  const matches = unit.parts.map((part) => bestQueryMatchIndex(part.text, tokenWeights));
  const fixed = unit.parts.reduce((sum, part) => sum + part.label.length + 2, 0) + (unit.parts.length - 1);
  const shares = allocatePartBudgets(unit.parts, matches, EXCERPT_CHARS - fixed);
  return unit.parts
    .map((part, index) => `${part.label}: ${excerptPart(part.text, shares[index], matches[index])}`)
    .join(' ');
}
// Ranked units plus the idf weight of every query token the session contains
// (the excerpt anchor uses the weights).
function scoreUnits(units, queryText) {
  const queryTokens = tokenize(queryText);
  const tokenWeights = new Map();
  if (!queryTokens.length || !units.length) {
    return { ranked: [], tokenWeights };
  }
  const docs = units
    .map((unit) => {
      const text = unit.parts.map((part) => `${part.label}: ${part.text}`).join(' ');
      return { ...unit, textLength: text.length, tokens: tokenize(text) };
    })
    .filter((unit) => unit.tokens.length);
  const averageLength = docs.reduce((sum, unit) => sum + unit.tokens.length, 0) / docs.length || 1;
  const docFreq = new Map();
  for (const unit of docs) {
    for (const token of new Set(unit.tokens)) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }
  for (const token of queryTokens) {
    const frequency = docFreq.get(token) || 0;
    if (frequency) {
      tokenWeights.set(token, Math.log(1 + ((docs.length - frequency + 0.5) / (frequency + 0.5))));
    }
  }
  const ranked = docs
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
        score += tokenWeights.get(token) * ((tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * (unit.tokens.length / averageLength))));
      }
      return { ...unit, score };
    })
    .filter((unit) => unit.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || right.timestamp - left.timestamp
      || left.textLength - right.textLength
    ));
  return { ranked, tokenWeights };
}

function rankedExcerpts(units, queryText) {
  const { ranked, tokenWeights } = scoreUnits(units, queryText);
  return ranked
    .slice(0, MAX_EXCERPTS_PER_SESSION)
    .map((unit) => buildUnitExcerpt(unit, tokenWeights));
}
function buildLinkedSessionContext(sessionStore, activeSessionId, prompt, recentUserTurns) {
  const activeSession = sessionStore?.getSessionSummary?.(activeSessionId);
  const linkedSessionIds = Array.isArray(activeSession?.linked_session_ids)
    ? activeSession.linked_session_ids
    : [];
  if (!linkedSessionIds.length) {
    return null;
  }
  const queryText = [
    String(prompt || '').trim(),
    ...(Array.isArray(recentUserTurns) ? recentUserTurns : []).map((turn) => String(turn?.content || turn || '').trim()),
  ].filter(Boolean).slice(0, 3).join('\n');
  const linkedSessions = selectLinkedRecallSessions(
    activeSession, linkedSessionIds, (sessionId) => sessionStore.getSessionSummary(sessionId)
  );
  const sections = linkedSessions.map((session) => ({
    title: clipExcerpt(session.title || session.id || 'Linked session', 72),
    excerpts: rankedExcerpts(buildRecallUnits(sessionStore.getSessionMessages(session.id)), queryText),
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
