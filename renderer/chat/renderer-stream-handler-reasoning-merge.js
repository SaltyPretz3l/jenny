(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-reasoning-entry-merge-utils'));
    return;
  }
  root.rendererStreamHandlerReasoningMerge = factory(root.rendererReasoningEntryMergeUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (reasoningEntryMergeUtils) {
  'use strict';

  const {
    buildReasoningEntryContentKey,
    buildReasoningEntryMergeIndexes,
    isReasoningEntryEdit,
    mergeReasoningEntriesInto,
  } = reasoningEntryMergeUtils;

  function createReasoningStreamMerger(options = {}) {
    const normalizeId = typeof options.normalizeId === 'function'
      ? options.normalizeId
      : (value) => String(value || '').trim();
    const mergeMessageReasoning = typeof options.mergeMessageReasoning === 'function'
      ? options.mergeMessageReasoning
      : null;
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    const flushPendingStreamCommit = typeof options.flushPendingStreamCommit === 'function'
      ? options.flushPendingStreamCommit
      : function noopFlushPendingStreamCommit() {};
    const bufferExpiryMs = Number(options.bufferExpiryMs) > 0 ? Number(options.bufferExpiryMs) : 60000;
    const maxStreams = Number(options.maxStreams) > 0 ? Number(options.maxStreams) : 128;
    const pruneIntervalMs = Number(options.pruneIntervalMs) > 0 ? Number(options.pruneIntervalMs) : 1000;
    const streamReasoningMergeState = new Map();
    let lastExpiryPruneAt = 0;

    function normalizeReasoningEntryDelta(entry, fallbackIndex, timestamp) {
      const source = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry
        : {};
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
          timestamp: String(source.timestamp || timestamp),
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
        timestamp: String(source.timestamp || timestamp),
      };
      const thinkingId = source.thinkingId != null ? String(source.thinkingId) : '';
      if (thinkingId) {
        normalized.thinkingId = thinkingId;
      }
      return normalized;
    }

    function pickOldestReasoningStreamId(latest) {
      let oldestStreamId = '';
      let oldestTouchedAt = Infinity;
      for (const [streamId, mergeState] of streamReasoningMergeState.entries()) {
        if (streamId === latest) {
          continue;
        }
        const lastTouchedAt = Number(mergeState?.lastTouchedAt) || 0;
        if (!oldestStreamId || lastTouchedAt < oldestTouchedAt) {
          oldestStreamId = streamId;
          oldestTouchedAt = lastTouchedAt;
        }
      }
      return oldestStreamId || streamReasoningMergeState.keys().next().value;
    }

    function buildReasoningEntryMetadata(entriesDelta) {
      const metadata = [];
      for (let index = 0; index < entriesDelta.length; index += 1) {
        const source = entriesDelta[index] && typeof entriesDelta[index] === 'object' && !Array.isArray(entriesDelta[index])
          ? entriesDelta[index]
          : {};
        const text = String(source.text || source.summary || source.content || '').trim();
        if (!text) {
          continue;
        }
        metadata.push({
          sourceIndex: index,
          explicitId: normalizeId(source.id),
          text,
        });
      }
      return metadata;
    }

    function normalizeReasoningEntriesDirect(reasoning, fallbackStartIndex) {
      const entries = [];
      const indexById = new Map();
      const indexByContent = new Map();
      const timestamp = new Date().toISOString();
      for (let index = 0; index < reasoning.entriesDelta.length; index += 1) {
        const entry = normalizeReasoningEntryDelta(
          reasoning.entriesDelta[index],
          fallbackStartIndex + index,
          timestamp
        );
        if (!entry) {
          continue;
        }
        if (isReasoningEntryEdit(entry)) {
          entries.push(entry);
          continue;
        }
        const existingIndex = indexById.get(entry.id);
        if (Number.isInteger(existingIndex)) {
          entries[existingIndex] = entry;
          continue;
        }
        const contentKey = buildReasoningEntryContentKey(entry);
        if (indexByContent.has(contentKey)) {
          continue;
        }
        indexById.set(entry.id, entries.length);
        indexByContent.set(contentKey, entries.length);
        entries.push(entry);
      }
      return {
        source: String(reasoning.source || 'provider'),
        entries,
      };
    }

    function normalizeReasoningEntriesOnly(reasoning, fallbackStartIndex = 0) {
      if (!reasoning || !Array.isArray(reasoning.entriesDelta) || !reasoning.entriesDelta.length) {
        return { source: 'none', entries: [] };
      }
      const normalized = mergeMessageReasoning
        ? mergeMessageReasoning(
            { reasoning: { source: String(reasoning.source || 'provider'), entries: [] } },
            reasoning
          )
        : normalizeReasoningEntriesDirect(reasoning, fallbackStartIndex);
      const normalizedEntries = Array.isArray(normalized?.entries)
        ? normalized.entries.map((entry) => ({ ...(entry && typeof entry === 'object' ? entry : {}) }))
        : [];
      if (fallbackStartIndex > 0 && normalizedEntries.length) {
        const metadata = buildReasoningEntryMetadata(reasoning.entriesDelta);
        const usedMetadata = new Set();
        for (let index = 0; index < normalizedEntries.length; index += 1) {
          const entry = normalizedEntries[index];
          const normalizedEntryId = normalizeId(entry.id);
          let metadataIndex = -1;
          for (let candidateIndex = 0; candidateIndex < metadata.length; candidateIndex += 1) {
            if (usedMetadata.has(candidateIndex)) {
              continue;
            }
            const candidate = metadata[candidateIndex];
            if (candidate.explicitId && candidate.explicitId === normalizedEntryId) {
              metadataIndex = candidateIndex;
              break;
            }
            if (!candidate.explicitId && candidate.text === String(entry.text || '').trim()) {
              metadataIndex = candidateIndex;
              break;
            }
          }
          if (metadataIndex < 0) {
            continue;
          }
          usedMetadata.add(metadataIndex);
          const source = metadata[metadataIndex];
          if (!source.explicitId && /^reasoning_\d+$/.test(normalizedEntryId)) {
            entry.id = `reasoning_${fallbackStartIndex + source.sourceIndex}`;
          }
        }
      }
      return {
        source: String(normalized?.source || reasoning.source || 'provider'),
        entries: normalizedEntries,
      };
    }

    function createReasoningMergeState(messageId, existingReasoning) {
      const entries = Array.isArray(existingReasoning?.entries)
        ? existingReasoning.entries.map((entry) => ({ ...(entry && typeof entry === 'object' ? entry : {}) }))
        : [];
      const { indexById, contentKeyCounts } = buildReasoningEntryMergeIndexes(entries, normalizeId);
      return {
        messageId,
        source: String(existingReasoning?.source || 'provider'),
        entries,
        indexById,
        contentKeyCounts,
        lastTouchedAt: Date.now(),
      };
    }

    function deleteReasoningMergeState(streamId, reason) {
      const normalizedStreamId = normalizeId(streamId);
      if (!normalizedStreamId || !streamReasoningMergeState.has(normalizedStreamId)) {
        return false;
      }
      try {
        flushPendingStreamCommit(normalizedStreamId);
      } catch (error) {
        appendClientLog('WARN', 'stream.reasoning_merge_flush_failed', {
          streamId: normalizedStreamId,
          reason: String(reason || 'evict'),
          error: String(error && error.message || error || ''),
        });
      }
      return streamReasoningMergeState.delete(normalizedStreamId);
    }

    function prune(latestStreamId = '') {
      if (!streamReasoningMergeState.size) {
        return;
      }
      const latest = normalizeId(latestStreamId);
      const now = Date.now();
      let evictedCount = 0;
      if (now - lastExpiryPruneAt >= pruneIntervalMs) {
        lastExpiryPruneAt = now;
        const cutoff = now - bufferExpiryMs;
        for (const [streamId, mergeState] of streamReasoningMergeState.entries()) {
          if (streamId === latest) {
            continue;
          }
          const lastTouchedAt = Number(mergeState?.lastTouchedAt) || 0;
          if (lastTouchedAt > 0 && lastTouchedAt < cutoff && deleteReasoningMergeState(streamId, 'expired')) {
            evictedCount += 1;
          }
        }
      }
      while (streamReasoningMergeState.size > maxStreams) {
        const oldestStreamId = pickOldestReasoningStreamId(latest);
        if (!oldestStreamId || !deleteReasoningMergeState(oldestStreamId, 'cap')) {
          break;
        }
        evictedCount += 1;
      }
      if (evictedCount > 0) {
        appendClientLog('DEBUG', 'stream.reasoning_merge_state_pruned', {
          evictedCount,
          remainingCount: streamReasoningMergeState.size,
        });
      }
    }

    function merge(streamId, message, reasoning) {
      if (!reasoning || !Array.isArray(reasoning.entriesDelta) || !reasoning.entriesDelta.length) {
        return message?.reasoning || { source: 'none', entries: [] };
      }
      const normalizedStreamId = normalizeId(streamId);
      const messageId = normalizeId(message?.id);
      const baseReasoning = message?.reasoning || { source: 'none', entries: [] };
      let mergeState = normalizedStreamId ? streamReasoningMergeState.get(normalizedStreamId) : null;
      if (!mergeState || mergeState.messageId !== messageId) {
        mergeState = createReasoningMergeState(messageId, baseReasoning);
        if (normalizedStreamId) {
          streamReasoningMergeState.set(normalizedStreamId, mergeState);
        }
      }
      const edits = reasoning.entriesDelta.filter(isReasoningEntryEdit);
      const snapshots = reasoning.entriesDelta.filter((entry) => !isReasoningEntryEdit(entry));
      const normalizedIncoming = normalizeReasoningEntriesOnly(
        { ...reasoning, entriesDelta: snapshots },
        mergeState.entries.length
      );
      const normalizedSnapshots = Array.isArray(normalizedIncoming.entries)
        ? normalizedIncoming.entries
        : [];
      const normalizedSnapshotByIndex = new Map();
      const claimedSnapshotIndexes = new Set();
      for (const normalizedEntry of normalizedSnapshots) {
        const normalizedEntryId = normalizeId(normalizedEntry?.id);
        const normalizedText = String(normalizedEntry?.text || '').trim();
        for (let index = snapshots.length - 1; index >= 0; index -= 1) {
          if (claimedSnapshotIndexes.has(index)) continue;
          const source = snapshots[index] && typeof snapshots[index] === 'object'
            ? snapshots[index]
            : {};
          const sourceText = String(source.text || source.summary || source.content || '').trim();
          const sourceId = normalizeId(source.id)
            || `reasoning_${mergeState.entries.length + index}`;
          if (normalizeId(sourceId) !== normalizedEntryId || sourceText !== normalizedText) continue;
          normalizedSnapshotByIndex.set(index, normalizedEntry);
          claimedSnapshotIndexes.add(index);
          break;
        }
      }
      const incomingEntries = [];
      let snapshotIndex = 0;
      for (const entry of reasoning.entriesDelta) {
        if (isReasoningEntryEdit(entry)) {
          incomingEntries.push(entry);
        } else {
          const normalizedEntry = normalizedSnapshotByIndex.get(snapshotIndex);
          if (normalizedEntry) incomingEntries.push(normalizedEntry);
          snapshotIndex += 1;
        }
      }
      if (!incomingEntries.length && !edits.length) {
        return baseReasoning;
      }
      mergeState.lastTouchedAt = Date.now();
      mergeState.source = String(
        (snapshots.length ? normalizedIncoming.source : reasoning.source)
        || mergeState.source
        || 'provider'
      );
      const priorEditMismatches = mergeState.editMismatches || 0;
      mergeReasoningEntriesInto(mergeState, incomingEntries, normalizeId);
      if (
        (mergeState.editMismatches || 0) > priorEditMismatches
        && mergeState.editMismatchLogged !== true
      ) {
        mergeState.editMismatchLogged = true;
        appendClientLog('WARN', 'stream.reasoning_edit_base_mismatch', {
          streamId: normalizedStreamId,
          messageId,
          mismatches: mergeState.editMismatches - priorEditMismatches,
        });
      }
      prune(normalizedStreamId);
      return {
        source: mergeState.source || 'provider',
        entries: mergeState.entries.slice(),
      };
    }

    function drop(streamId) {
      const normalizedStreamId = normalizeId(streamId);
      if (normalizedStreamId) {
        streamReasoningMergeState.delete(normalizedStreamId);
      }
    }

    function clearAll() {
      streamReasoningMergeState.clear();
    }

    return {
      clearAll,
      drop,
      merge,
    };
  }

  return {
    createReasoningStreamMerger,
  };
});
