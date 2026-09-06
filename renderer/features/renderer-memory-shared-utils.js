(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMemorySharedUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const APPROVED_MEMORY_KIND_OPTIONS = Object.freeze([
    { value: 'all', label: 'All' },
    { value: 'profile', label: 'Profile' },
    { value: 'preference', label: 'Preference' },
    { value: 'response_style', label: 'Response Style' },
    { value: 'tool_strategy', label: 'Tool Strategy' },
    { value: 'working_preference', label: 'Working Preference' },
    { value: 'project_context', label: 'Project Context' },
    { value: 'routine', label: 'Routine' },
    { value: 'goal', label: 'Goal' },
    { value: 'important_person', label: 'People' },
  ]);
  const APPROVED_MEMORY_KIND_LABELS = Object.freeze(
    APPROVED_MEMORY_KIND_OPTIONS.reduce((labels, option) => {
      if (option.value !== 'all') {
        labels[option.value] = option.label;
      }
      return labels;
    }, {})
  );
  const APPROVED_MEMORY_KIND_VALUES = new Set(
    APPROVED_MEMORY_KIND_OPTIONS.map((option) => option.value)
  );
  const PENDING_MEMORY_SORT_OPTIONS = Object.freeze([
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
    { value: 'confidence', label: 'Highest confidence' },
  ]);
  const PENDING_MEMORY_SORT_VALUES = new Set(
    PENDING_MEMORY_SORT_OPTIONS.map((option) => option.value)
  );

  function getApprovedMemoryKindOptions() {
    return APPROVED_MEMORY_KIND_OPTIONS.map((option) => ({ ...option }));
  }

  function getApprovedMemoryKindLabel(lessonKind) {
    const normalizedKind = String(lessonKind || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(APPROVED_MEMORY_KIND_LABELS, normalizedKind)) {
      return APPROVED_MEMORY_KIND_LABELS[normalizedKind];
    }
    return normalizedKind || 'Memory';
  }

  function normalizeApprovedMemoryKindFilter(value) {
    const normalizedValue = String(value || '').trim().toLowerCase();
    return APPROVED_MEMORY_KIND_VALUES.has(normalizedValue) ? normalizedValue : 'all';
  }

  function normalizeMemoryConfidence(value) {
    const confidence = Number(value);
    if (!Number.isFinite(confidence)) {
      return 0;
    }
    if (confidence < 0) {
      return 0;
    }
    if (confidence > 1) {
      return 1;
    }
    return confidence;
  }

  function normalizePendingMemorySort(value) {
    const normalizedValue = String(value || '').trim().toLowerCase();
    return PENDING_MEMORY_SORT_VALUES.has(normalizedValue) ? normalizedValue : 'newest';
  }

  function normalizeApprovedMemory(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }
    const id = Number(candidate.id);
    const title = String(candidate.title || '').trim();
    const lessonText = String(candidate.lesson_text || '').trim();
    const lessonKind = String(candidate.lesson_kind || '').trim();
    if (!Number.isInteger(id) || id <= 0 || !title || !lessonText || !lessonKind) {
      return null;
    }
    return {
      id,
      session_id: String(candidate.session_id || '').trim(),
      title,
      lesson_text: lessonText,
      lesson_kind: lessonKind,
      confidence: normalizeMemoryConfidence(candidate.confidence),
      source_excerpt: String(candidate.source_excerpt || '').trim(),
      provenance: String(candidate.provenance || '').trim(),
      content_fingerprint: String(candidate.content_fingerprint || '').trim(),
      created_at: String(candidate.created_at || '').trim(),
      updated_at: String(candidate.updated_at || '').trim(),
    };
  }

  function normalizePendingMemoryCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }
    const sessionId = String(candidate.session_id || '').trim();
    const title = String(candidate.title || '').trim();
    const lessonText = String(candidate.lesson_text || '').trim();
    const lessonKind = String(candidate.lesson_kind || '').trim();
    const contentFingerprint = String(candidate.content_fingerprint || '').trim();
    if (!sessionId || !title || !lessonText || !lessonKind || !contentFingerprint) {
      return null;
    }
    const id = Number(candidate.id);
    return {
      id: Number.isInteger(id) && id > 0 ? id : 0,
      session_id: sessionId,
      source_request_id: String(candidate.source_request_id || '').trim(),
      title,
      lesson_text: lessonText,
      lesson_kind: lessonKind,
      confidence: normalizeMemoryConfidence(candidate.confidence),
      source_excerpt: String(candidate.source_excerpt || '').trim(),
      content_fingerprint: contentFingerprint,
      family_key: String(candidate.family_key || '').trim(),
      category: String(candidate.category || '').trim(),
      created_at: String(candidate.created_at || '').trim(),
      updated_at: String(candidate.updated_at || '').trim(),
    };
  }

  function toTimestamp(value) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return null;
    }
    const parsed = new Date(normalizedValue);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }

  function compareMemoriesNewestFirst(left, right) {
    const rightTimestamp = toTimestamp(right?.updated_at || right?.created_at);
    const leftTimestamp = toTimestamp(left?.updated_at || left?.created_at);
    if (leftTimestamp != null && rightTimestamp != null && leftTimestamp !== rightTimestamp) {
      return rightTimestamp - leftTimestamp;
    }
    if (leftTimestamp == null && rightTimestamp != null) {
      return 1;
    }
    if (leftTimestamp != null && rightTimestamp == null) {
      return -1;
    }
    const rightFallback = String(right?.updated_at || right?.created_at || '').trim();
    const leftFallback = String(left?.updated_at || left?.created_at || '').trim();
    if (leftFallback !== rightFallback) {
      return rightFallback.localeCompare(leftFallback);
    }
    return Number(right?.id || 0) - Number(left?.id || 0);
  }

  function sortMemoriesNewestFirst(entries) {
    return (Array.isArray(entries) ? entries.slice() : []).sort(compareMemoriesNewestFirst);
  }

  function sortPendingMemoryCandidates(entries, sortMode) {
    const mode = normalizePendingMemorySort(sortMode);
    if (mode === 'oldest') {
      return sortMemoriesNewestFirst(entries).reverse();
    }
    if (mode === 'confidence') {
      return (Array.isArray(entries) ? entries.slice() : []).sort((left, right) => {
        const rightConfidence = normalizeMemoryConfidence(right?.confidence);
        const leftConfidence = normalizeMemoryConfidence(left?.confidence);
        if (rightConfidence !== leftConfidence) {
          return rightConfidence - leftConfidence;
        }
        return compareMemoriesNewestFirst(left, right);
      });
    }
    return sortMemoriesNewestFirst(entries);
  }

  function buildApprovedMemorySearchText(memory) {
    if (!memory || typeof memory !== 'object') {
      return '';
    }
    return [
      memory.title,
      memory.lesson_text,
      memory.source_excerpt,
      memory.lesson_kind,
      getApprovedMemoryKindLabel(memory.lesson_kind),
    ]
      .join(' ')
      .toLowerCase();
  }

  function buildPendingMemoryKey(sessionId, contentFingerprint) {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedFingerprint = String(contentFingerprint || '').trim().toLowerCase();
    return normalizedSessionId && normalizedFingerprint
      ? `${normalizedSessionId}::${normalizedFingerprint}`
      : '';
  }

  return {
    getApprovedMemoryKindOptions,
    getApprovedMemoryKindLabel,
    normalizeApprovedMemoryKindFilter,
    normalizePendingMemorySort,
    normalizeMemoryConfidence,
    normalizeApprovedMemory,
    normalizePendingMemoryCandidate,
    sortMemoriesNewestFirst,
    sortPendingMemoryCandidates,
    buildApprovedMemorySearchText,
    buildPendingMemoryKey,
  };
});
