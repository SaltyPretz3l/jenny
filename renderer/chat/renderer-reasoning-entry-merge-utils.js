/* renderer/chat/renderer-reasoning-entry-merge-utils.js -- Shared reasoning-entry merge primitives (UMD).
 * Used by renderer-stream-handler-reasoning-merge (per-stream merger) and
 * renderer-turn-reducer (per-payload merger) so the id-or-content-key dedup
 * algorithm has a single source of truth.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererReasoningEntryMergeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function _defaultNormalizeId(value) {
    return String(value || '').trim();
  }

  // The key was built from an entry's ENTIRE text, which made every merge
  // O(total reasoning chars) -- against the 262,144-char cap that is ~1MB of
  // string allocation per frame, and it ran twice per id-replace. Bounding the
  // sampled span makes the key O(1) in the entry size while keeping the dedupe
  // the SP-25 tests pin.
  //
  // Length is part of the key, so two entries collapse only if they share a
  // length AND the leading and trailing CONTENT_KEY_SPAN chars AND the timestamp
  // AND the thinkingId. At or under 2 * CONTENT_KEY_SPAN the key still contains
  // the whole text, so dedupe stays exact for every entry but a very long one.
  const CONTENT_KEY_SPAN = 512;
  const REASONING_EDIT_BASE_TAIL_CHARS = 64;

  function sampleEntryText(text) {
    if (text.length <= CONTENT_KEY_SPAN * 2) return text;
    return `${text.slice(0, CONTENT_KEY_SPAN)}${text.slice(-CONTENT_KEY_SPAN)}`;
  }

  function buildReasoningEntryContentKey(entry) {
    const text = String(entry?.text || '');
    return `${text.length}${sampleEntryText(text)}${String(entry?.timestamp || '')}${String(entry?.thinkingId || '')}`;
  }

  function isReasoningEntryEdit(entry) {
    return entry && typeof entry.baseLength === 'number' && typeof entry.append === 'string';
  }

  function resolveReasoningEntryEdits(entries, baseEntries, normalizeId) {
    const normalize = typeof normalizeId === 'function' ? normalizeId : _defaultNormalizeId;
    const baseById = new Map(
      (Array.isArray(baseEntries) ? baseEntries : [])
        .map((entry) => [normalize(entry && entry.id), entry])
        .filter(([id]) => id)
    );
    const resolved = [];
    let mismatches = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isReasoningEntryEdit(entry)) {
        resolved.push(entry);
        const id = normalize(entry && entry.id);
        if (id) baseById.set(id, entry);
        continue;
      }
      const id = normalize(entry && entry.id);
      const base = baseById.get(id);
      const baseText = String(base?.text || '');
      if (
        !base
        || typeof entry.baseTail !== 'string'
        || baseText.length !== entry.baseLength
        || !baseText.endsWith(entry.baseTail)
      ) {
        mismatches += 1;
        continue;
      }
      const next = { ...base, text: baseText + entry.append, timestamp: entry.timestamp || base.timestamp };
      const thinkingId = entry.thinkingId != null ? String(entry.thinkingId) : '';
      if (thinkingId) next.thinkingId = thinkingId;
      resolved.push(next);
      if (id) baseById.set(id, next);
    }
    return { entries: resolved, mismatches };
  }

  function addReasoningEntryContentKey(contentKeyCounts, contentKey) {
    contentKeyCounts.set(contentKey, (contentKeyCounts.get(contentKey) || 0) + 1);
  }

  function removeReasoningEntryContentKey(contentKeyCounts, contentKey) {
    const count = contentKeyCounts.get(contentKey) || 0;
    if (count <= 1) {
      contentKeyCounts.delete(contentKey);
    } else {
      contentKeyCounts.set(contentKey, count - 1);
    }
  }

  function buildReasoningEntryMergeIndexes(entries, normalizeId) {
    const normalize = typeof normalizeId === 'function' ? normalizeId : _defaultNormalizeId;
    const indexById = new Map();
    const contentKeyCounts = new Map();
    const list = Array.isArray(entries) ? entries : [];
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      const id = normalize(entry && entry.id);
      if (id && !indexById.has(id)) {
        indexById.set(id, index);
      }
      addReasoningEntryContentKey(contentKeyCounts, buildReasoningEntryContentKey(entry));
    }
    return { indexById, contentKeyCounts };
  }

  function mergeReasoningEntriesInto(state, incomingEntries, normalizeId) {
    const normalize = typeof normalizeId === 'function' ? normalizeId : _defaultNormalizeId;
    const incoming = Array.isArray(incomingEntries) ? incomingEntries : [];
    for (let index = 0; index < incoming.length; index += 1) {
      const entry = { ...incoming[index] };
      const id = normalize(entry && entry.id);
      if (isReasoningEntryEdit(entry)) {
        const entryIndex = id && state.indexById.has(id) ? state.indexById.get(id) : -1;
        const existing = entryIndex >= 0 ? state.entries[entryIndex] : null;
        const existingText = String(existing?.text || '');
        if (
          !existing
          || typeof entry.baseTail !== 'string'
          || existingText.length !== entry.baseLength
          || !existingText.endsWith(entry.baseTail)
        ) {
          state.editMismatches = (state.editMismatches || 0) + 1;
          continue;
        }
        const next = {
          ...existing,
          text: existingText + entry.append,
          timestamp: entry.timestamp || existing.timestamp,
        };
        const thinkingId = entry.thinkingId != null ? String(entry.thinkingId) : '';
        if (thinkingId) {
          next.thinkingId = thinkingId;
        }
        removeReasoningEntryContentKey(
          state.contentKeyCounts,
          buildReasoningEntryContentKey(existing)
        );
        state.entries[entryIndex] = next;
        addReasoningEntryContentKey(state.contentKeyCounts, buildReasoningEntryContentKey(next));
        continue;
      }
      // SP-25: replacing by id MUST re-key the content index, or a later
      // distinct entry matching the replaced entry's OLD content is falsely
      // dropped and one matching its NEW content is falsely duplicated.
      if (id && state.indexById.has(id)) {
        const entryIndex = state.indexById.get(id);
        removeReasoningEntryContentKey(
          state.contentKeyCounts,
          buildReasoningEntryContentKey(state.entries[entryIndex])
        );
        state.entries[entryIndex] = entry;
        addReasoningEntryContentKey(state.contentKeyCounts, buildReasoningEntryContentKey(entry));
        continue;
      }
      const contentKey = buildReasoningEntryContentKey(entry);
      if (state.contentKeyCounts.has(contentKey)) {
        continue;
      }
      if (id) {
        state.indexById.set(id, state.entries.length);
      }
      addReasoningEntryContentKey(state.contentKeyCounts, contentKey);
      state.entries.push(entry);
    }
    return state.entries;
  }

  return {
    REASONING_EDIT_BASE_TAIL_CHARS,
    buildReasoningEntryContentKey,
    buildReasoningEntryMergeIndexes,
    isReasoningEntryEdit,
    mergeReasoningEntriesInto,
    resolveReasoningEntryEdits,
  };
});
