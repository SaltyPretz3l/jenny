(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineProjectionCacheUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LONG_THREAD_BUDGETS = Object.freeze({
    projectionCacheSessions: 16,
    projectedTurns: 192,
    diagnosticKeys: 256,
    rootMarkupEntries: 128,
    virtualizedMarkupEntries: 160,
    statefulDetachedEntries: 24,
    targetMaterializedArticles: 160,
    observers: 3,
    scheduledLayoutTasks: 1,
  });

  function isLongThreadBoundsEnabled(featureFlags) {
    return !featureFlags || featureFlags.chat_long_thread_bounds !== false;
  }

  function pruneMapOldestFirst(map, cap, options = {}) {
    if (!(map instanceof Map)) return { evicted: [], remaining: 0 };
    const normalizedCap = Number.isFinite(cap) ? Math.max(0, Math.trunc(cap)) : 0;
    const isPinned = typeof options.isPinned === 'function' ? options.isPinned : () => false;
    const evicted = [];
    while (map.size > normalizedCap) {
      let removed = false;
      for (const key of map.keys()) {
        if (isPinned(key, map.get(key))) continue;
        map.delete(key);
        evicted.push(key);
        removed = true;
        break;
      }
      if (!removed) break;
    }
    return { evicted, remaining: map.size };
  }

  function rowRequiresPin(row) {
    if (!row || typeof row !== 'object') return false;
    const kind = String(row.kind || '').trim();
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const rowState = String(payload.state || payload.status || '').trim().toLowerCase();
    return kind === 'approval_gap'
      || ['pending_approval', 'awaiting_approval', 'requested', 'running', 'streaming'].includes(rowState);
  }

  function collectPinnedTurnIds(turns, rowsByTurnId) {
    const sourceTurns = Array.isArray(turns) ? turns : [];
    const pinned = new Set();
    const newestTurnId = String(sourceTurns[sourceTurns.length - 1]?.turn_id || '').trim();
    if (newestTurnId) pinned.add(newestTurnId);
    if (rowsByTurnId instanceof Map) {
      rowsByTurnId.forEach(function inspectRows(rows, turnId) {
        if ((Array.isArray(rows) ? rows : []).some(rowRequiresPin)) pinned.add(String(turnId || '').trim());
      });
    }
    pinned.delete('');
    return pinned;
  }
  // Enforce the per-session LRU cap on creation so caches remain bounded even when renderMessages does not run; never evict the current session.
  const PROJECTION_CACHE_SESSION_CAP = LONG_THREAD_BUDGETS.projectionCacheSessions;

  function enforceProjectionCacheBound(cacheMap, currentSessionId) {
    if (!cacheMap
      || typeof cacheMap.size !== 'number'
      || typeof cacheMap.keys !== 'function'
      || typeof cacheMap.delete !== 'function'
    ) {
      return;
    }
    while (cacheMap.size > PROJECTION_CACHE_SESSION_CAP) {
      let evicted = false;
      for (const key of cacheMap.keys()) {
        if (key === currentSessionId) continue;
        cacheMap.delete(key);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  function buildMessageIdIndex(sourceMessages) {
    const list = Array.isArray(sourceMessages) ? sourceMessages : [];
    const idIndex = new Map();
    for (let index = 0; index < list.length; index += 1) {
      const message = list[index];
      const id = String((message && message.id) || '').trim();
      if (id && !idIndex.has(id)) {
        idIndex.set(id, message);
      }
    }
    return idIndex;
  }

  // CTL-004: the #15 structural-signature cache (message-renderer.js)
  // intentionally excludes settled content/nested-payload fields so a
  // matching signature can skip the two heavy O(n) rebuilds (canonical
  // transcript + thread tree). But every settled-message update in this
  // renderer is an OBJECT REPLACEMENT (`{...message, ...patch}` / a whole
  // array swap) rather than an in-place mutation, so the cached arrays --
  // built once, at signature-establish time -- would otherwise keep holding
  // the ORIGINAL refs forever, even after the session store has replaced
  // them with fresher objects carrying new settled content. Because
  // buildCanonicalTranscriptMessages only filters/reorders source refs (it
  // never clones or wraps a message), a matching structural signature
  // guarantees the CURRENT source messages carry the same ids in the same
  // order as the cached canonical array, so swapping each cached element for
  // its current same-id object is a safe, cheap O(n) refresh -- no rebuild
  // of the canonical projection is needed.
  // The optional `idIndex` lets a call site that refreshes both cached views
  // (message array + thread tree) build the O(n) index once and share it.
  // `refreshed` is allocated copy-on-write: the common no-ref-change frame
  // (chrome-only re-render) returns `cached` without an n-length allocation.
  function refreshCanonicalMessageRefs(cachedCanonicalMessages, sourceMessages, idIndex) {
    const cached = Array.isArray(cachedCanonicalMessages) ? cachedCanonicalMessages : [];
    const messageIdIndex = idIndex || buildMessageIdIndex(sourceMessages);
    let refreshed = null;
    for (let index = 0; index < cached.length; index += 1) {
      const cachedMessage = cached[index];
      const id = String((cachedMessage && cachedMessage.id) || '').trim();
      const freshMessage = (id && messageIdIndex.get(id)) || cachedMessage;
      if (!refreshed && freshMessage !== cachedMessage) {
        refreshed = cached.slice(0, index);
      }
      if (refreshed) {
        refreshed.push(freshMessage);
      }
    }
    return refreshed || cached;
  }

  // Companion refresh for the cached thread tree: every node's `message`
  // field holds the same kind of stale ref described above, and article/
  // markup builders read message content directly off thread-tree nodes.
  // Mutated IN PLACE -- `roots[]` holds the identical node objects stored in
  // `nodeById` (see buildTranscriptThreadTree), so a single nodeById pass
  // keeps both views current without rebuilding the tree shape.
  function refreshCanonicalThreadTreeRefs(threadTree, sourceMessages, idIndex) {
    const nodeById = threadTree && threadTree.nodeById;
    if (!nodeById || typeof nodeById.forEach !== 'function') {
      return threadTree;
    }
    const messageIdIndex = idIndex || buildMessageIdIndex(sourceMessages);
    nodeById.forEach(function refreshNode(node) {
      if (!node) {
        return;
      }
      const id = String(node.id || '').trim();
      const freshMessage = id ? messageIdIndex.get(id) : undefined;
      if (freshMessage && freshMessage !== node.message) {
        node.message = freshMessage;
      }
    });
    return threadTree;
  }

  function touchProjectionCacheEntry(cacheMap, key) {
    // Move `key` to the end of the Map so the LRU eviction order treats it
    // as most-recently-used. No-op for unknown keys or non-Map caches.
    if (!cacheMap
      || typeof cacheMap.has !== 'function'
      || typeof cacheMap.get !== 'function'
      || typeof cacheMap.delete !== 'function'
      || typeof cacheMap.set !== 'function'
    ) {
      return;
    }
    if (!cacheMap.has(key)) {
      return;
    }
    const value = cacheMap.get(key);
    cacheMap.delete(key);
    cacheMap.set(key, value);
    return true;
  }

  function createProjectionCachePipeline(deps) {
    const { state = {}, dom = {}, runtime = {}, callbacks = {} } = deps || {};
    const { chatTimeline = null } = dom;
    const { uiRuntime = {} } = runtime;
    const {
      appendClientLog = () => {},
      getChatTimelineRowModelEnabled = () => false,
      recordChatTimelineRolloutSignal = () => ({ logged: false, count: 0 }),
      buildInteractiveRecapModel = () => null,
      resolveTurnArticleMessageId = (messageId) => String(messageId || ''),
      resolveVisibleMessageDomTarget = () => null,
    } = callbacks;

    function buildCanonicalTranscriptMessages(messages) {
      const sourceMessages = Array.isArray(messages) ? messages : [];
      const canonicalMessages = [];
      const recapIndexById = new Map();
      const recapAnchorIndexById = new Map();
      let lastQuestionBatchIndex = -1;
      for (let index = 0; index < sourceMessages.length; index += 1) {
        const message = sourceMessages[index];
        if (!message) {
          continue;
        }
        if (String(message.kind || '') === 'question_batch') {
          canonicalMessages.push(message);
          lastQuestionBatchIndex = canonicalMessages.length - 1;
          continue;
        }
        if (String(message.kind || '') !== 'interactive_round_recap') {
          canonicalMessages.push(message);
          continue;
        }
        const recapModel = buildInteractiveRecapModel(message);
        const hasSummaryItems = Array.isArray(recapModel?.questionSummaries) && recapModel.questionSummaries.length > 0;
        const askedCount = Number(recapModel?.askedCount || 0);
        if (!recapModel || (!hasSummaryItems && askedCount < 1)) {
          continue;
        }
        const recapId = String(recapModel.recapId || '').trim();
        if (!recapId) {
          canonicalMessages.push(message);
          continue;
        }
        if (recapIndexById.has(recapId)) {
          canonicalMessages[recapIndexById.get(recapId)] = message;
          recapAnchorIndexById.set(recapId, lastQuestionBatchIndex);
          continue;
        }
        recapIndexById.set(recapId, canonicalMessages.length);
        recapAnchorIndexById.set(recapId, lastQuestionBatchIndex);
        canonicalMessages.push(message);
      }
      const anchoredRecapsByAnchorIndex = new Map();
      recapIndexById.forEach(function collectAnchoredRecaps(recapIndex, recapId) {
        const anchorIndex = recapAnchorIndexById.get(recapId);
        if (!Number.isInteger(anchorIndex) || anchorIndex < 0) {
          return;
        }
        const existing = anchoredRecapsByAnchorIndex.get(anchorIndex) || [];
        existing.push({ recapId, recapIndex });
        anchoredRecapsByAnchorIndex.set(anchorIndex, existing);
      });
      if (!anchoredRecapsByAnchorIndex.size) {
        return canonicalMessages;
      }
      const anchoredRecapIds = new Set();
      anchoredRecapsByAnchorIndex.forEach(function sortAnchoredRecaps(entries, anchorIndex) {
        entries.sort(function sortRecapsBySourceIndex(left, right) {
          return left.recapIndex - right.recapIndex;
        });
        anchoredRecapsByAnchorIndex.set(
          anchorIndex,
          entries.map(function toRecapId(entry) {
            anchoredRecapIds.add(entry.recapId);
            return entry.recapId;
          })
        );
      });
      const result = [];
      for (let index = 0; index < canonicalMessages.length; index += 1) {
        const message = canonicalMessages[index];
        if (!message) {
          continue;
        }
        const isAnchoredRecap = String(message.kind || '') === 'interactive_round_recap'
          && anchoredRecapIds.has(String(buildInteractiveRecapModel(message)?.recapId || '').trim());
        if (!isAnchoredRecap) {
          result.push(message);
        }
        const anchoredRecapIdsForIndex = anchoredRecapsByAnchorIndex.get(index) || [];
        for (let recapIndex = 0; recapIndex < anchoredRecapIdsForIndex.length; recapIndex += 1) {
          const recapId = anchoredRecapIdsForIndex[recapIndex];
          const recapMessage = canonicalMessages[recapIndexById.get(recapId)];
          if (recapMessage) {
            result.push(recapMessage);
          }
        }
      }
      return result;
    }

    function getToolRowProjectionFallbackSet(sessionId, options) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return null;
      }
      if (!uiRuntime.toolRowProjectionFallbacksBySession || typeof uiRuntime.toolRowProjectionFallbacksBySession.get !== 'function') {
        uiRuntime.toolRowProjectionFallbacksBySession = new Map();
      }
      const cache = uiRuntime.toolRowProjectionFallbacksBySession;
      let fallbackSet = cache.get(normalizedSessionId);
      if (fallbackSet) {
        touchProjectionCacheEntry(cache, normalizedSessionId);
      } else if (options && options.create) {
        fallbackSet = new Set();
        cache.set(normalizedSessionId, fallbackSet);
        enforceProjectionCacheBound(cache, String(state.currentSessionId || '').trim());
      }
      return fallbackSet || null;
    }

    function getToolRowProjectionFailureSet(sessionId, options) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return null;
      }
      if (!uiRuntime.toolRowProjectionFailuresBySession || typeof uiRuntime.toolRowProjectionFailuresBySession.get !== 'function') {
        uiRuntime.toolRowProjectionFailuresBySession = new Map();
      }
      const cache = uiRuntime.toolRowProjectionFailuresBySession;
      let failureSet = cache.get(normalizedSessionId);
      if (failureSet) {
        touchProjectionCacheEntry(cache, normalizedSessionId);
      } else if (options && options.create) {
        failureSet = new Set();
        cache.set(normalizedSessionId, failureSet);
        enforceProjectionCacheBound(cache, String(state.currentSessionId || '').trim());
      }
      return failureSet || null;
    }

    function pruneToolRowProjectionSessionCaches(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const uiRuntimeCaches = [
        'projectionContextBySession',
        'toolRowProjectionFallbacksBySession',
        'toolRowProjectionFailuresBySession',
      ];
      for (const cacheKey of uiRuntimeCaches) {
        const cache = uiRuntime[cacheKey];
        if (!cache || typeof cache.forEach !== 'function' || typeof cache.delete !== 'function') {
          continue;
        }
        if (!normalizedSessionId) {
          cache.clear();
          continue;
        }
        cache.forEach(function removeInactiveSession(_value, cachedSessionId) {
          if (String(cachedSessionId || '').trim() !== normalizedSessionId) {
            cache.delete(cachedSessionId);
          }
        });
      }
      // chatTimelineRowModelMetaBySession lives under state.ui (rollback meta,
      // rollout telemetry counters, hydrated-projection digest). Without this
      // sweep, every visited session leaves a meta record behind for the
      // lifetime of the renderer — even after the underlying session has been
      // closed or the cache it pairs with has been pruned above.
      const metaStore = state.ui && state.ui.chatTimelineRowModelMetaBySession;
      if (metaStore && typeof metaStore.forEach === 'function' && typeof metaStore.delete === 'function') {
        if (!normalizedSessionId) {
          metaStore.clear?.();
        } else {
          metaStore.forEach(function removeInactiveMeta(_value, cachedSessionId) {
            if (String(cachedSessionId || '').trim() !== normalizedSessionId) {
              metaStore.delete(cachedSessionId);
            }
          });
        }
      }
    }

    function logToolRowProjectionFallbackOnce(messageId, reason) {
      const normalizedSessionId = String(state.currentSessionId || '').trim();
      const normalizedMessageId = String(messageId || '').trim();
      const normalizedReason = String(reason || 'missing_projected_row').trim();
      if (!normalizedSessionId || !normalizedMessageId) {
        return;
      }
      const fallbackSet = getToolRowProjectionFallbackSet(normalizedSessionId, { create: true });
      if (!fallbackSet) {
        return;
      }
      const fallbackKey = `${normalizedMessageId}:${normalizedReason}`;
      if (fallbackSet.has(fallbackKey)) {
        return;
      }
      fallbackSet.add(fallbackKey);
      if (isLongThreadBoundsEnabled(state?.features?.featureFlags)) {
        while (fallbackSet.size > LONG_THREAD_BUDGETS.diagnosticKeys) {
          fallbackSet.delete(fallbackSet.values().next().value);
        }
      }
      appendClientLog('WARN', 'renderer.tool_row_projection_fallback', {
        sessionId: normalizedSessionId,
        messageId: normalizedMessageId,
        reason: normalizedReason,
      });
    }

    function logToolRowProjectionFailureOnce(reason, payload) {
      const normalizedSessionId = String(state.currentSessionId || '').trim();
      const normalizedReason = String(reason || 'project_turn_rows_failed').trim();
      if (!normalizedSessionId) {
        return;
      }
      const failureSet = getToolRowProjectionFailureSet(normalizedSessionId, { create: true });
      if (!failureSet || failureSet.has(normalizedReason)) {
        return;
      }
      failureSet.add(normalizedReason);
      if (isLongThreadBoundsEnabled(state?.features?.featureFlags)) {
        while (failureSet.size > LONG_THREAD_BUDGETS.diagnosticKeys) {
          failureSet.delete(failureSet.values().next().value);
        }
      }
      appendClientLog('WARN', 'renderer.tool_row_projection_failed', {
        sessionId: normalizedSessionId,
        reason: normalizedReason,
        ...(payload && typeof payload === 'object' ? payload : {}),
      });
    }

    function getProjectionContextCache(sessionId, options) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return null;
      }
      if (!uiRuntime.projectionContextBySession || typeof uiRuntime.projectionContextBySession.get !== 'function') {
        uiRuntime.projectionContextBySession = new Map();
      }
      const projectionCache = uiRuntime.projectionContextBySession;
      let cache = projectionCache.get(normalizedSessionId);
      if (cache) {
        touchProjectionCacheEntry(projectionCache, normalizedSessionId);
      } else if (options && options.create) {
        cache = {};
        projectionCache.set(normalizedSessionId, cache);
        enforceProjectionCacheBound(projectionCache, String(state.currentSessionId || '').trim());
      }
      return cache || null;
    }

    function finalizeProjectionContext(sessionId, context) {
      const normalizedSessionId = String(sessionId || '').trim();
      const nextContext = context && typeof context === 'object' ? context : null;
      const cache = getProjectionContextCache(normalizedSessionId, { create: Boolean(nextContext) });
      if (cache) {
        cache.currentContext = nextContext;
      }
      return nextContext;
    }

    function getCurrentProjectionContext(sessionId) {
      return getProjectionContextCache(sessionId)?.currentContext || null;
    }

    function resolveVisibleTurnArticleTarget(messageId, projectionContext) {
      if (!chatTimeline) {
        return null;
      }
      const activeProjectionContext = projectionContext || getCurrentProjectionContext(state.currentSessionId);
      const articleMessageId = resolveTurnArticleMessageId(messageId, activeProjectionContext);
      const target = resolveVisibleMessageDomTarget(chatTimeline, articleMessageId);
      if (!target) {
        return null;
      }
      // [data-message-id] also appears on nested controls (reasoning-row
      // headers carry their segment's message id), and every caller treats
      // this result as THE turn article — patching a nested control injects
      // article markup into it. Lift a nested match to its .chat-entry.
      if (typeof target.matches === 'function' && target.matches('.chat-entry')) {
        return target;
      }
      return (typeof target.closest === 'function' && target.closest('.chat-entry')) || target;
    }

    function recordTurnArticleRolloutSignal(signal, details) {
      const normalizedSessionId = String(state.currentSessionId || '').trim();
      if (!normalizedSessionId) {
        return { logged: false, count: 0 };
      }
      if (getChatTimelineRowModelEnabled(normalizedSessionId) !== true) {
        return { logged: false, count: 0 };
      }
      return recordChatTimelineRolloutSignal(normalizedSessionId, signal, details);
    }

    function clearProjectionContextCacheForSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return false;
      }
      let didClear = false;
      [
        'projectionContextBySession',
        'toolRowProjectionFallbacksBySession',
        'toolRowProjectionFailuresBySession',
      ].forEach(function clearCache(cacheKey) {
        const cache = uiRuntime[cacheKey];
        if (!cache || typeof cache.delete !== 'function') {
          return;
        }
        didClear = cache.delete(normalizedSessionId) || didClear;
      });
      return didClear;
    }

    function rekeyProjectionContextCache(sourceSessionId, targetSessionId) {
      const normalizedSource = String(sourceSessionId || '').trim();
      const normalizedTarget = String(targetSessionId || '').trim();
      if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) {
        return normalizedTarget || normalizedSource;
      }
      const projectionCache = uiRuntime.projectionContextBySession;
      if (
        projectionCache
        && typeof projectionCache.get === 'function'
        && typeof projectionCache.set === 'function'
        && typeof projectionCache.delete === 'function'
      ) {
        const sourceCache = projectionCache.get(normalizedSource);
        if (sourceCache) {
          const targetCache = projectionCache.get(normalizedTarget);
          projectionCache.delete(normalizedSource);
          if (!targetCache) {
            projectionCache.set(normalizedTarget, sourceCache);
          }
        }
      }
      [
        'toolRowProjectionFallbacksBySession',
        'toolRowProjectionFailuresBySession',
      ].forEach(function rekeySetCache(cacheKey) {
        const cache = uiRuntime[cacheKey];
        if (
          !cache
          || typeof cache.get !== 'function'
          || typeof cache.set !== 'function'
          || typeof cache.delete !== 'function'
        ) {
          return;
        }
        const sourceSet = cache.get(normalizedSource);
        if (!(sourceSet instanceof Set) || sourceSet.size < 1) {
          cache.delete(normalizedSource);
          return;
        }
        const targetSet = cache.get(normalizedTarget);
        cache.delete(normalizedSource);
        if (targetSet instanceof Set) {
          sourceSet.forEach(function mergeValue(value) {
            targetSet.add(value);
          });
          return;
        }
        cache.set(normalizedTarget, new Set(sourceSet));
      });
      return normalizedTarget;
    }

    function getRowModelMetaStore() {
      if (!state.ui || typeof state.ui !== 'object') {
        state.ui = {};
      }
      if (!(state.ui.chatTimelineRowModelMetaBySession instanceof Map)) {
        state.ui.chatTimelineRowModelMetaBySession = new Map();
      }
      return state.ui.chatTimelineRowModelMetaBySession;
    }

    function getRowModelMeta(sessionId, options) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return null;
      }
      const metaStore = getRowModelMetaStore();
      let meta = metaStore.get(normalizedSessionId) || null;
      if (meta) {
        touchProjectionCacheEntry(metaStore, normalizedSessionId);
      } else if (options && options.create) {
        meta = {
          enablement_source: 'render_pipeline',
          sticky_rollback: false,
          rollback_reason: '',
          rollback_at: '',
          rollback_details: null,
          last_hydrated_projection_signature: null,
          last_hydrated_projection_digest: '',
          telemetry_counters: Object.create(null),
          signal_keys: Object.create(null),
          enabled: getChatTimelineRowModelEnabled(normalizedSessionId) === true,
        };
        metaStore.set(normalizedSessionId, meta);
        enforceProjectionCacheBound(metaStore, String(state.currentSessionId || '').trim());
      }
      return meta;
    }

    function countLegacyVisibleMessages(messages) {
      const sourceMessages = Array.isArray(messages) ? messages : [];
      let visibleCount = 0;
      for (let index = 0; index < sourceMessages.length; index += 1) {
        const message = sourceMessages[index];
        if (!message || String(message.kind || '').trim() === 'tool_result') {
          continue;
        }
        visibleCount += 1;
      }
      return visibleCount;
    }

    return {
      buildCanonicalTranscriptMessages,
      pruneToolRowProjectionSessionCaches,
      logToolRowProjectionFallbackOnce,
      logToolRowProjectionFailureOnce,
      getProjectionContextCache,
      finalizeProjectionContext,
      getCurrentProjectionContext,
      resolveVisibleTurnArticleTarget,
      recordTurnArticleRolloutSignal,
      clearProjectionContextCacheForSession,
      rekeyProjectionContextCache,
      getRowModelMeta,
      countLegacyVisibleMessages,
    };
  }

  return {
    createProjectionCachePipeline,
    BUDGETS: LONG_THREAD_BUDGETS,
    PROJECTION_CACHE_SESSION_CAP,
    buildMessageIdIndex,
    collectPinnedTurnIds,
    isLongThreadBoundsEnabled,
    pruneMapOldestFirst,
    refreshCanonicalMessageRefs,
    refreshCanonicalThreadTreeRefs,
    rowRequiresPin,
    touchMapEntry: touchProjectionCacheEntry,
  };
});
