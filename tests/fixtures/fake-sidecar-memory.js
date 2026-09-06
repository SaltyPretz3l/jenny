const {
  GENERIC_CAPTURE_VALUES,
  GOAL_CANDIDATES,
  IMPORTANT_PERSON_CANDIDATES,
  MEMORY_PATTERNS,
  PROJECT_CONTEXT_CANDIDATES,
  PROJECT_CONTEXT_FAMILY_BY_LESSON_TEXT,
  PROJECT_CONTEXT_FAMILY_PATTERNS,
  RECALL_STOPWORDS,
  RESPONSE_STYLE_CANDIDATES,
  ROUTINE_CANDIDATES,
  TOOL_STRATEGY_CANDIDATES,
  TOOL_STRATEGY_FAMILY_BY_FINGERPRINT,
  TOOL_STRATEGY_QUERY_PATTERNS,
  WORKING_PREFERENCE_FAMILY_BY_LESSON_TEXT,
  WORKING_PREFERENCE_CANDIDATES,
  WORKING_PREFERENCE_FAMILY_PATTERNS,
} = require('./fake-sidecar-memory-patterns');

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCapture(value) {
  return normalizeSpaces(String(value || '').replace(/\b(?:please|thanks|thank you)\b/gi, ''))
    .replace(/^[\s.,!?;:-]+|[\s.,!?;:-]+$/g, '');
}

function titleCaseWords(value) {
  return normalizeSpaces(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function normalizeTemplateCaptures(groups) {
  const captures = {};
  for (const [key, rawValue] of Object.entries(groups || {})) {
    let normalized = normalizeCapture(rawValue);
    if (key === 'day' || key === 'month' || key === 'relationship') {
      normalized = normalized.toLowerCase();
    }
    captures[key] = normalized;
  }
  return captures;
}

function renderCandidateTemplate(template, captures) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => captures?.[key] || '');
}

function normalizeTitle(value) {
  return normalizeSpaces(value).slice(0, 120);
}

function normalizeLessonText(value) {
  const normalized = normalizeSpaces(value).slice(0, 240);
  if (!normalized) {
    return '';
  }
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function buildFingerprint(lessonKind, lessonText) {
  const normalizedText = normalizeSpaces(lessonText)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${String(lessonKind || '').trim().toLowerCase()}:${normalizedText}`.slice(0, 160);
}

function validateCapture(value) {
  const normalized = normalizeCapture(value);
  if (normalized.length < 3 || normalized.length > 80) {
    return false;
  }
  if (GENERIC_CAPTURE_VALUES.has(normalized.toLowerCase())) {
    return false;
  }
  return normalized.split(' ').length <= 11;
}

function buildCandidate({ title, lessonText, lessonKind, confidence, sourceExcerpt }) {
  const normalizedLessonText = normalizeLessonText(lessonText);
  return {
    title: normalizeTitle(title),
    lesson_text: normalizedLessonText,
    lesson_kind: lessonKind,
    confidence: Math.max(0, Math.min(Number(confidence || 0), 1)),
    source_excerpt: normalizeSpaces(sourceExcerpt).slice(0, 240),
    content_fingerprint: buildFingerprint(lessonKind, normalizedLessonText),
  };
}

function maybeAddSuggestionCandidate(suggestions, seenFingerprints, candidate, savedMemories) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const fingerprint = String(candidate.content_fingerprint || '').trim().toLowerCase();
  if (!fingerprint || seenFingerprints.has(fingerprint) || savedMemories.has(fingerprint)) {
    return false;
  }
  seenFingerprints.add(fingerprint);
  suggestions.push(candidate);
  return true;
}

function buildMemorySuggestion(params, savedMemories) {
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  const suggestions = [];
  const seenFingerprints = new Set();

  for (const message of messages) {
    if (String(message?.role || '').trim().toLowerCase() !== 'user') {
      continue;
    }
    const content = normalizeSpaces(message?.content || '');
    if (!content) {
      continue;
    }

    for (const candidateConfig of MEMORY_PATTERNS) {
      const match = content.match(candidateConfig.pattern);
      if (!match) {
        continue;
      }
      const value = match.groups?.value;
      if (!validateCapture(value)) {
        continue;
      }
      const normalizedValue = candidateConfig.lessonKind === 'profile'
        ? titleCaseWords(normalizeCapture(value))
        : normalizeCapture(value);
      const formatted = candidateConfig.formatter(normalizedValue);
      maybeAddSuggestionCandidate(
        suggestions,
        seenFingerprints,
        buildCandidate({
          title: formatted.title,
          lessonText: formatted.lesson_text,
          lessonKind: candidateConfig.lessonKind,
          confidence: candidateConfig.confidence,
          sourceExcerpt: match[0],
        }),
        savedMemories
      );
      break;
    }

    for (const candidateConfig of RESPONSE_STYLE_CANDIDATES) {
      const match = content.match(candidateConfig.pattern);
      if (!match) {
        continue;
      }
      maybeAddSuggestionCandidate(
        suggestions,
        seenFingerprints,
        buildCandidate({
          title: candidateConfig.title,
          lessonText: candidateConfig.lesson_text,
          lessonKind: 'response_style',
          confidence: candidateConfig.confidence,
          sourceExcerpt: match[0],
        }),
        savedMemories
      );
      break;
    }

    for (const candidateConfig of TOOL_STRATEGY_CANDIDATES) {
      const match = content.match(candidateConfig.pattern);
      if (!match) {
        continue;
      }
      maybeAddSuggestionCandidate(
        suggestions,
        seenFingerprints,
        buildCandidate({
          title: candidateConfig.title,
          lessonText: candidateConfig.lesson_text,
          lessonKind: 'tool_strategy',
          confidence: candidateConfig.confidence,
          sourceExcerpt: match[0],
        }),
        savedMemories
      );
      break;
    }

    for (const candidateConfig of WORKING_PREFERENCE_CANDIDATES) {
      const match = content.match(candidateConfig.pattern);
      if (!match) {
        continue;
      }
      maybeAddSuggestionCandidate(
        suggestions,
        seenFingerprints,
        buildCandidate({
          title: candidateConfig.title,
          lessonText: candidateConfig.lesson_text,
          lessonKind: 'working_preference',
          confidence: candidateConfig.confidence,
          sourceExcerpt: match[0],
        }),
        savedMemories
      );
      break;
    }

    for (const candidateConfig of PROJECT_CONTEXT_CANDIDATES) {
      const match = content.match(candidateConfig.pattern);
      if (!match) {
        continue;
      }
      maybeAddSuggestionCandidate(
        suggestions,
        seenFingerprints,
        buildCandidate({
          title: candidateConfig.title,
          lessonText: candidateConfig.lesson_text,
          lessonKind: 'project_context',
          confidence: candidateConfig.confidence,
          sourceExcerpt: match[0],
        }),
        savedMemories
      );
      break;
    }

    for (const candidateConfig of ROUTINE_CANDIDATES) {
      const match = content.match(candidateConfig.pattern);
      if (!match) {
        continue;
      }
      const captures = normalizeTemplateCaptures(match.groups);
      if (!validateCapture(captures.value)) {
        continue;
      }
      maybeAddSuggestionCandidate(
        suggestions,
        seenFingerprints,
        buildCandidate({
          title: renderCandidateTemplate(candidateConfig.title, captures),
          lessonText: renderCandidateTemplate(candidateConfig.lesson_text, captures),
          lessonKind: 'routine',
          confidence: candidateConfig.confidence,
          sourceExcerpt: match[0],
        }),
        savedMemories
      );
      break;
    }

    for (const candidateConfig of GOAL_CANDIDATES) {
      const match = content.match(candidateConfig.pattern);
      if (!match) {
        continue;
      }
      const captures = normalizeTemplateCaptures(match.groups);
      if (!validateCapture(captures.value)) {
        continue;
      }
      maybeAddSuggestionCandidate(
        suggestions,
        seenFingerprints,
        buildCandidate({
          title: renderCandidateTemplate(candidateConfig.title, captures),
          lessonText: renderCandidateTemplate(candidateConfig.lesson_text, captures),
          lessonKind: 'goal',
          confidence: candidateConfig.confidence,
          sourceExcerpt: match[0],
        }),
        savedMemories
      );
      break;
    }

    for (const candidateConfig of IMPORTANT_PERSON_CANDIDATES) {
      const match = content.match(candidateConfig.pattern);
      if (!match) {
        continue;
      }
      const value = match.groups?.value;
      if (!validateCapture(value)) {
        continue;
      }
      const formatted = candidateConfig.formatter(normalizeCapture(value));
      maybeAddSuggestionCandidate(
        suggestions,
        seenFingerprints,
        buildCandidate({
          title: formatted.title,
          lessonText: formatted.lesson_text,
          lessonKind: candidateConfig.lessonKind,
          confidence: candidateConfig.confidence,
          sourceExcerpt: match[0],
        }),
        savedMemories
      );
      break;
    }
  }

  suggestions.sort((left, right) => {
    const confidenceCompare = Number(right.confidence || 0) - Number(left.confidence || 0);
    if (confidenceCompare !== 0) {
      return confidenceCompare;
    }
    return String(right.lesson_text || '').length - String(left.lesson_text || '').length;
  });
  return suggestions[0] || null;
}

function tokenize(value) {
  return Array.from(
    new Set(
      (String(value || '')
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g) || []).filter((token) => !RECALL_STOPWORDS.has(token))
    )
  );
}

function recencyBonus(updatedAt) {
  const updatedValue = new Date(String(updatedAt || ''));
  if (Number.isNaN(updatedValue.getTime())) {
    return 0;
  }
  const ageMs = Date.now() - updatedValue.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  if (ageMs <= sevenDaysMs) {
    return 2;
  }
  if (ageMs <= thirtyDaysMs) {
    return 1;
  }
  return 0;
}

function toolStrategyMatchesIntent(memory, query) {
  const familyKey = String(memory?.family_key || '').trim().toLowerCase();
  if (!familyKey) {
    return false;
  }
  const patterns = TOOL_STRATEGY_QUERY_PATTERNS[familyKey];
  if (!patterns) {
    return false;
  }
  return patterns.some((pattern) => pattern.test(query));
}

function workingPreferenceMatchesIntent(memory, query) {
  const familyKey = String(memory?.family_key || '').trim().toLowerCase();
  if (!familyKey) {
    return false;
  }
  const patterns = WORKING_PREFERENCE_FAMILY_PATTERNS[familyKey];
  if (!patterns || !patterns.length) {
    return false;
  }
  return patterns.some((pattern) => pattern.test(query));
}

function projectContextMatchesIntent(memory, query) {
  const familyKey = String(memory?.family_key || '').trim().toLowerCase();
  if (!familyKey) {
    return false;
  }
  const patterns = PROJECT_CONTEXT_FAMILY_PATTERNS[familyKey];
  if (!patterns || !patterns.length) {
    return false;
  }
  return patterns.some((pattern) => pattern.test(query));
}

function resolveFamilyKey(lessonKind, lessonText, fingerprint) {
  const normalizedKind = normalizeSpaces(lessonKind).toLowerCase();
  const normalizedLessonText = normalizeLessonText(lessonText).toLowerCase();
  const normalizedFingerprint = normalizeSpaces(fingerprint).toLowerCase();
  if (normalizedKind === 'tool_strategy') {
    return TOOL_STRATEGY_FAMILY_BY_FINGERPRINT[normalizedFingerprint] || '';
  }
  if (normalizedKind === 'working_preference') {
    return WORKING_PREFERENCE_FAMILY_BY_LESSON_TEXT[normalizedLessonText] || '';
  }
  if (normalizedKind === 'project_context') {
    return PROJECT_CONTEXT_FAMILY_BY_LESSON_TEXT[normalizedLessonText] || '';
  }
  return '';
}

function listApprovedMemories(savedMemories) {
  return Array.from(savedMemories.values()).sort((left, right) => {
    const updatedCompare = String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
    if (updatedCompare !== 0) {
      return updatedCompare;
    }
    return Number(right.id || 0) - Number(left.id || 0);
  });
}

function findMemoryById(savedMemories, memoryId) {
  const normalizedId = Number(memoryId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return null;
  }
  return listApprovedMemories(savedMemories).find((memory) => Number(memory.id || 0) === normalizedId) || null;
}

const ALLOWED_LESSON_KINDS = new Set([
  'profile', 'preference', 'response_style',
  'tool_strategy', 'working_preference', 'project_context',
  'routine', 'goal', 'important_person',
]);

function saveMemory(params, savedMemories, nextMemoryId) {
  const sessionId = String(params?.session_id || '').trim();
  const candidate = params?.candidate && typeof params.candidate === 'object'
    ? { ...params.candidate }
    : null;
  const lessonKind = normalizeSpaces(candidate?.lesson_kind || '').toLowerCase();
  const title = normalizeTitle(candidate?.title || '');
  const lessonText = normalizeLessonText(candidate?.lesson_text || '');
  const fingerprint = buildFingerprint(lessonKind, lessonText);
  const familyKey = resolveFamilyKey(lessonKind, lessonText, fingerprint);
  if (!sessionId || !candidate || !lessonKind || !title || !lessonText) {
    return {
      errorDetail: 'candidate and session_id are required',
      nextMemoryId,
    };
  }
  if (!ALLOWED_LESSON_KINDS.has(lessonKind)) {
    return {
      errorDetail: `unsupported lesson_kind: ${lessonKind}`,
      nextMemoryId,
    };
  }

  let record = savedMemories.get(fingerprint);
  let created = false;
  const timestamp = new Date().toISOString();
  if (!record) {
    record = {
      id: nextMemoryId,
      session_id: sessionId,
      title,
      lesson_text: lessonText,
      lesson_kind: lessonKind,
      confidence: Math.max(0, Math.min(Number(candidate.confidence || 0), 1)),
      source_excerpt: normalizeSpaces(candidate.source_excerpt || '').slice(0, 240),
      content_fingerprint: fingerprint,
      family_key: familyKey,
      created_at: timestamp,
      updated_at: timestamp,
    };
    savedMemories.set(fingerprint, record);
    created = true;
    nextMemoryId += 1;
  } else {
    record = {
      ...record,
      session_id: sessionId,
      title,
      lesson_text: lessonText,
      lesson_kind: lessonKind,
      confidence: Math.max(0, Math.min(Number(candidate.confidence || 0), 1)),
      source_excerpt: normalizeSpaces(candidate.source_excerpt || '').slice(0, 240),
      content_fingerprint: fingerprint,
      family_key: familyKey,
      updated_at: timestamp,
    };
    savedMemories.set(fingerprint, record);
  }
  return {
    result: {
      created,
      memory: record,
    },
    nextMemoryId,
  };
}

function updateMemory(params, savedMemories) {
  const memoryId = Number(params?.memory_id);
  const patch = params?.patch && typeof params.patch === 'object'
    ? params.patch
    : null;
  const existing = findMemoryById(savedMemories, memoryId);
  const title = normalizeTitle(patch?.title || '');
  const lessonText = normalizeLessonText(patch?.lesson_text || '');
  if (!existing || !patch || !title || !lessonText) {
    return {
      errorDetail: !existing ? 'memory not found' : 'memory_id and patch are required',
    };
  }

  const duplicate = listApprovedMemories(savedMemories).find((memory) =>
    memory.id !== existing.id
    && String(memory.lesson_kind || '').trim().toLowerCase() === String(existing.lesson_kind || '').trim().toLowerCase()
    && normalizeLessonText(memory.lesson_text) === lessonText
  );
  if (duplicate) {
    return {
      errorDetail: 'patch.lesson_text duplicates another approved memory',
    };
  }

  const nextFingerprint = buildFingerprint(existing.lesson_kind, lessonText);
  savedMemories.delete(String(existing.content_fingerprint || '').trim().toLowerCase());
  const updated = {
    ...existing,
    title,
    lesson_text: lessonText,
    content_fingerprint: nextFingerprint,
    family_key: existing.family_key || '',
    updated_at: new Date().toISOString(),
  };
  savedMemories.set(nextFingerprint, updated);
  return {
    result: {
      updated: true,
      memory: updated,
    },
  };
}

// KNOWN DIVERGENCE from production, deliberately not simulated.
// sidecar/ai/memory/store_approved.py's delete_memory() also writes a
// memory_suppressions row with reason 'forgotten', which is what stops a deleted
// lesson being suggested again. This fake only drops the row. Nothing today
// asserts suppression through this fixture (it reaches only
// tests/fixtures/fake-sidecar.js and two sidecar-manager suites), so no test is
// currently passing that should fail -- but a future "a forgotten memory is not
// re-suggested" test written against this fake would pass vacuously. Add the
// tombstone here in the same change as the test that needs it.
function deleteMemory(params, savedMemories) {
  const memoryId = Number(params?.memory_id);
  const existing = findMemoryById(savedMemories, memoryId);
  if (!existing) {
    return {
      errorDetail: 'memory_id must be a positive integer',
    };
  }
  savedMemories.delete(String(existing.content_fingerprint || '').trim().toLowerCase());
  return {
    result: {
      deleted: true,
      memory_id: existing.id,
    },
  };
}

function recallMemories(params, savedMemories) {
  const query = normalizeSpaces(params?.query || '');
  if (!query) {
    return [];
  }
  const queryTokens = new Set(tokenize(query));
  if (!queryTokens.size) {
    return [];
  }
  return Array.from(savedMemories.values())
    .map((memory) => {
      if (
        String(memory.lesson_kind || '').trim().toLowerCase() === 'tool_strategy'
        && !toolStrategyMatchesIntent(memory, query)
      ) {
        return { memory, score: 0 };
      }
      if (
        String(memory.lesson_kind || '').trim().toLowerCase() === 'working_preference'
        && !workingPreferenceMatchesIntent(memory, query)
      ) {
        return { memory, score: 0 };
      }
      if (
        String(memory.lesson_kind || '').trim().toLowerCase() === 'project_context'
        && !projectContextMatchesIntent(memory, query)
      ) {
        return { memory, score: 0 };
      }
      const titleTokens = new Set(tokenize(memory.title));
      const lessonTokens = new Set(tokenize(memory.lesson_text));
      const sourceTokens = new Set(tokenize(memory.source_excerpt));
      let titleOverlap = 0;
      let lessonOverlap = 0;
      let sourceOverlap = 0;
      for (const token of queryTokens) {
        if (titleTokens.has(token)) {
          titleOverlap += 1;
        }
        if (lessonTokens.has(token)) {
          lessonOverlap += 1;
        }
        if (sourceTokens.has(token)) {
          sourceOverlap += 1;
        }
      }
      const weightedOverlap = titleOverlap * 12 + lessonOverlap * 10 + sourceOverlap * 8;
      const isGated = ['tool_strategy', 'working_preference', 'project_context']
        .includes(String(memory.lesson_kind || '').trim().toLowerCase());
      if (weightedOverlap <= 0 || (isGated && weightedOverlap < 16)) {
        return { memory, score: 0 };
      }
      return {
        memory,
        score: weightedOverlap + Number(memory.confidence || 0) + recencyBonus(memory.updated_at),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      const scoreCompare = right.score - left.score;
      if (scoreCompare !== 0) {
        return scoreCompare;
      }
      const updatedCompare = String(right.memory.updated_at || '').localeCompare(String(left.memory.updated_at || ''));
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      return Number(right.memory.id || 0) - Number(left.memory.id || 0);
    })
    .slice(0, Math.max(1, Math.min(Number(params?.limit || 3), 5)))
    .map((entry) => entry.memory);
}

function recallRecentMemories(params, savedMemories) {
  const lessonKind = normalizeSpaces(params?.lesson_kind || '').toLowerCase();
  if (!lessonKind) {
    return [];
  }
  return Array.from(savedMemories.values())
    .filter((memory) => String(memory.lesson_kind || '').trim().toLowerCase() === lessonKind)
    .sort((left, right) => {
      const updatedCompare = String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      return Number(right.id || 0) - Number(left.id || 0);
    })
    .slice(0, Math.max(1, Math.min(Number(params?.limit || 3), 5)));
}

function buildMemoryContextLessons(params, fallbackContent, savedMemories) {
  const legacyLessons = Array.isArray(params?.learning_context?.lessons)
    ? params.learning_context.lessons
    : [];
  const memoryPolicy = params?.memory_policy && typeof params.memory_policy === 'object'
    ? params.memory_policy
    : null;
  if (!memoryPolicy) {
    return legacyLessons;
  }
  if (memoryPolicy.enabled !== true) {
    return [];
  }

  const recallQuery = (Array.isArray(params?.messages) ? params.messages : [])
    .filter((message) => message?.role === 'user' && !String(message?.kind || '').trim())
    .slice(-3)
    .map((message) => String(message?.content || '').trim())
    .filter(Boolean)
    .join('\n')
    .slice(-600) || fallbackContent;
  const lessons = recallMemories({ query: recallQuery, limit: 3 }, savedMemories);
  if (memoryPolicy.include_response_style === true) {
    lessons.push(...recallRecentMemories({ lesson_kind: 'response_style', limit: 1 }, savedMemories));
  }
  return [...new Map(
    lessons.map((memory) => [memory.content_fingerprint, memory])
  ).values()].slice(0, 5);
}

module.exports = {
  buildMemoryContextLessons,
  buildMemorySuggestion,
  deleteMemory,
  listApprovedMemories,
  recallMemories,
  recallRecentMemories,
  saveMemory,
  updateMemory,
};
