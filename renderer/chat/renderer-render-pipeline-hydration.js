(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineHydrationUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const longThreadBudget = globalRef.rendererRenderPipelineProjectionCacheUtils
    || (typeof require === 'function' ? require('./renderer-render-pipeline-projection-cache') : null)
    || {};
  const LONG_THREAD_BUDGETS = longThreadBudget.BUDGETS || { projectedTurns: 192 };
  const isLongThreadBoundsEnabled = typeof longThreadBudget.isLongThreadBoundsEnabled === 'function'
    ? longThreadBudget.isLongThreadBoundsEnabled
    : () => true;
  const pruneMapOldestFirst = typeof longThreadBudget.pruneMapOldestFirst === 'function'
    ? longThreadBudget.pruneMapOldestFirst
    : () => ({ evicted: [], remaining: 0 });
  const collectPinnedTurnIds = typeof longThreadBudget.collectPinnedTurnIds === 'function'
    ? longThreadBudget.collectPinnedTurnIds
    : () => new Set();
  const touchMapEntry = typeof longThreadBudget.touchMapEntry === 'function'
    ? longThreadBudget.touchMapEntry
    : () => false;

  function monotonicNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function createHydrationPipeline(deps) {
    const { state = {}, dom = {}, controllers = {}, callbacks = {} } = deps || {};
    const { chatTimeline = null } = dom;
    const { reducedMotionQuery = { matches: false } } = controllers;
    const {
      projectTurnTree = null,
      projectTurnRows = null,
      projectTurn = null,
      buildMessageProjectionFingerprint = () => '',
      computeTurnStructureHash = () => 0,
      computeTurnTailFingerprint = () => '',
      buildTurnRowId = (row) => String(row?.row_id || ''),
      buildTurnRowListMarkup = () => '',
      recordTurnArticleRolloutSignal = () => ({ logged: false, count: 0 }),
      // Single-sourced render-message-index builder shared with the
      // projection-context overlay path. Default fallback keeps tests/old
      // wirings working without the helper, but production wiring always
      // injects it from renderer-render-message-index-utils.js.
      indexRowsByRenderMessageId = (rowsByTurnId) => {
        const result = new Map();
        if (!rowsByTurnId || typeof rowsByTurnId.forEach !== 'function') {
          return result;
        }
        rowsByTurnId.forEach((rows) => {
          const source = Array.isArray(rows) ? rows : [];
          for (let rowIndex = 0; rowIndex < source.length; rowIndex += 1) {
            const row = source[rowIndex];
            const renderMessageId = String(row && (row.render_message_id || row.primary_message_id) || '').trim();
            if (!renderMessageId) {
              continue;
            }
            const bucket = result.get(renderMessageId) || [];
            bucket.push(row);
            result.set(renderMessageId, bucket);
          }
        });
        return result;
      },
    } = callbacks;

    function getPersistedTurnEventState(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const store = state.turnEventsBySession;
      if (!normalizedSessionId || !store || typeof store.get !== 'function') {
        return { turnEventLogVersion: 0, turnEvents: [] };
      }
      return store.get(normalizedSessionId) || { turnEventLogVersion: 0, turnEvents: [] };
    }

    function pushDistinctString(list, value) {
      const normalizedValue = String(value || '').trim();
      if (!normalizedValue || list.includes(normalizedValue)) {
        return;
      }
      list.push(normalizedValue);
    }

    function buildToolMessageIdsByCallId(messages) {
      const sourceMessages = Array.isArray(messages) ? messages : [];
      const idsByCallId = new Map();
      for (let index = 0; index < sourceMessages.length; index += 1) {
        const message = sourceMessages[index];
        if (!message || typeof message !== 'object') {
          continue;
        }
        const messageId = String(message.id || '').trim();
        if (!messageId) {
          continue;
        }
        const kind = String(message.kind || '').trim();
        let callId = '';
        if (kind === 'tool_use') {
          callId = String(message.tool_call?.call_id || '').trim();
        } else if (kind === 'tool_result') {
          callId = String(message.tool_result?.call_id || '').trim();
        }
        if (!callId) {
          continue;
        }
        const existingIds = idsByCallId.get(callId) || [];
        pushDistinctString(existingIds, messageId);
        idsByCallId.set(callId, existingIds);
      }
      return idsByCallId;
    }

    function buildProjectedRowContentFingerprint(row, messageById, toolMessageIdsByCallId) {
      if (!messageById || typeof messageById.get !== 'function') {
        return '';
      }
      const sourceIds = [];
      const rawSourceIds = Array.isArray(row?.source_message_ids) ? row.source_message_ids : [];
      for (let index = 0; index < rawSourceIds.length; index += 1) {
        pushDistinctString(sourceIds, rawSourceIds[index]);
      }
      pushDistinctString(sourceIds, row?.primary_message_id);
      if (String(row?.kind || '') === 'tool_step') {
        const toolCallId = String(row?.tool_call_id || row?.payload?.tool_call_id || '').trim();
        const relatedIds = toolCallId && toolMessageIdsByCallId instanceof Map
          ? toolMessageIdsByCallId.get(toolCallId)
          : null;
        if (Array.isArray(relatedIds)) {
          for (let index = 0; index < relatedIds.length; index += 1) {
            pushDistinctString(sourceIds, relatedIds[index]);
          }
        }
      }
      if (!sourceIds.length) {
        return '';
      }
      const fingerprints = [];
      for (let index = 0; index < sourceIds.length; index += 1) {
        const sourceId = String(sourceIds[index] || '').trim();
        if (!sourceId) {
          continue;
        }
        const message = messageById.get(sourceId);
        if (!message) {
          continue;
        }
        const fingerprint = String(buildMessageProjectionFingerprint(message) || '');
        if (fingerprint) {
          fingerprints.push(fingerprint);
        }
      }
      return fingerprints.join('');
    }

    // The key combines turn identity, event count, and source-message fingerprints.
    // INVARIANT: this key folds event COUNT + source-message content
    // fingerprints, not per-event payload bytes. Safe only because persisted turn
    // events are immutable under a stable event_id (append-only + dedupe-by-
    // event_id in both backends). If a projected row ever derives visible text from
    // a mutable payload field, add a per-event payload hash here too.
    function buildTurnProjectionCacheSignature(turnMeta, fingerprintById) {
      if (!turnMeta || !(fingerprintById instanceof Map)) {
        return '';
      }
      const turnId = String(turnMeta.turn_id || '').trim();
      if (!turnId) {
        return '';
      }
      const events = Array.isArray(turnMeta.events) ? turnMeta.events : [];
      const sourceIds = Array.isArray(turnMeta.source_message_ids) ? turnMeta.source_message_ids : [];
      const parts = [
        turnId,
        String(turnMeta.primary_user_message_id || ''),
        String(turnMeta.primary_assistant_message_id || ''),
        String(events.length),
      ];
      for (let index = 0; index < sourceIds.length; index += 1) {
        const id = String(sourceIds[index] || '').trim();
        parts.push(`${id}=${String(fingerprintById.get(id) || '')}`);
      }
      return parts.join('|');
    }

    // A turn whose stream is still live must not have its RUNNING tool calls
    // re-projected as 'interrupted' by the persisted-events hydration: the
    // tool result simply has not been persisted yet, so mid-stream renders
    // would flash the interrupted (clock) treatment on a tool that is about
    // to succeed. Liveness: the turn's stream id sits in state.pendingStreams
    // (a live segment is mid-flight; source-message streamId covers hydrated
    // twins keyed by the send's local id), OR the turn is the session's
    // newest and the session's send lifecycle is still in-flight — the
    // pendingStreams entry is dropped at each tool boundary (segment
    // finalized, next segment not yet created), which is exactly when the
    // interrupted flash happened.
    function isTurnStreamLive(turnMeta, messageById, liveness) {
      const pendingStreams = state.pendingStreams;
      if (pendingStreams && typeof pendingStreams.has === 'function' && pendingStreams.size > 0) {
        const turnId = String(turnMeta?.turn_id || '').trim();
        if (turnId && pendingStreams.has(turnId)) {
          return true;
        }
        const sourceIds = Array.isArray(turnMeta?.source_message_ids) ? turnMeta.source_message_ids : [];
        for (let index = 0; index < sourceIds.length; index += 1) {
          const message = messageById?.get?.(String(sourceIds[index] || '').trim());
          const streamId = String(message?.streamId || '').trim();
          if (streamId && pendingStreams.has(streamId)) {
            return true;
          }
        }
      }
      if (liveness?.isNewestTurn === true && liveness.sessionId) {
        const lifecycle = String(
          state.ui?.chatSendLifecycleBySession?.get?.(liveness.sessionId) || ''
        ).trim();
        return lifecycle === 'streaming' || lifecycle === 'preflight';
      }
      return false;
    }

    // Returns a patched COPY of the rows array with live-turn 'interrupted'
    // tool_call rows restored to 'running' (or the original array when nothing
    // needs patching). Copies keep the per-turn projection cache raw so a turn
    // that later settles as genuinely interrupted re-projects correctly.
    function guardLiveTurnRows(rows, turnMeta, messageById, liveness) {
      const sourceRows = Array.isArray(rows) ? rows : [];
      let patchedRows = null;
      for (let index = 0; index < sourceRows.length; index += 1) {
        const row = sourceRows[index];
        const payload = row?.payload && typeof row.payload === 'object' ? row.payload : null;
        if (
          !payload
          || String(row.kind || '').trim() !== 'tool_call'
          || String(payload.state || '').trim() !== 'interrupted'
        ) {
          continue;
        }
        if (!isTurnStreamLive(turnMeta, messageById, liveness)) {
          return sourceRows;
        }
        if (!patchedRows) {
          patchedRows = sourceRows.slice();
        }
        patchedRows[index] = { ...row, payload: { ...payload, state: 'running' } };
      }
      return patchedRows || sourceRows;
    }

    function buildHydratedTurnProjection(sourceMessages, threadTree, turnEventState, {
      messageById: providedMessageById = null,
      turnRowCache = null,
      messageContentFingerprintById = null,
      sessionId = '',
    } = {}) {
      const projectionStartedAt = monotonicNow();
      const persistedState = turnEventState && typeof turnEventState === 'object' ? turnEventState : {};
      const projectedTurnTree = projectTurnTree({
        messages: sourceMessages,
        threadTree,
        turn_event_log_version: Number(persistedState.turnEventLogVersion || 0),
        turn_events: Array.isArray(persistedState.turnEvents) ? persistedState.turnEvents : [],
      });
      const turns = Array.isArray(projectedTurnTree && projectedTurnTree.turns) ? projectedTurnTree.turns : [];
      const toolMessageIdsByCallId = buildToolMessageIdsByCallId(sourceMessages);
      // Reuse the caller's message index when supplied; standalone callers build one below.
      let messageById = providedMessageById instanceof Map ? providedMessageById : null;
      if (!messageById) {
        messageById = new Map();
        for (let index = 0; index < sourceMessages.length; index += 1) {
          const message = sourceMessages[index];
          const messageId = String(message && message.id || '').trim();
          if (messageId && !messageById.has(messageId)) {
            messageById.set(messageId, message);
          }
        }
      }
      // DC1 flicker cure: the base canonical projection is what renders after
      // the reconciled overlay is pruned, so it must stamp the SAME deterministic
      // row_ids as the live/reconciled rows or the terminal-handoff blink returns
      // one render later. Gate = global flag AND this session's row model live
      // (the only case that produces a live overlay to match). Off by default =>
      // projectTurn/projectTurnRows keep `row:${event_id}`, byte-identical.
      const deterministicRowId = state?.features?.featureFlags?.chat_timeline_deterministic_row_id === true
        && isLiveRowModelEnabledForSession(String(sessionId || '').trim());
      const turnById = new Map();
      const turnIdByMessageId = new Map();
      const rowsByTurnId = new Map();
      const rowByPrimaryMessageId = new Map();
      const viewModelByTurnId = new Map();
      for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
        const turn = turns[turnIndex];
        const turnId = String(turn && turn.turn_id || '').trim();
        if (!turnId) {
          continue;
        }
        turnById.set(turnId, turn);
        const sourceMessageIds = Array.isArray(turn && turn.source_message_ids) ? turn.source_message_ids : [];
        for (let messageIndex = 0; messageIndex < sourceMessageIds.length; messageIndex += 1) {
          const sourceMessageId = String(sourceMessageIds[messageIndex] || '').trim();
          if (sourceMessageId && !turnIdByMessageId.has(sourceMessageId)) {
            turnIdByMessageId.set(sourceMessageId, turnId);
          }
        }
        // Phase 2 adoption: prefer the composite projectTurn API so the
        // canonical turn view-model is built in the same pass as the rows.
        // Consumers downstream of buildProjectionContext (classic shell,
        // composer status, etc.) read the view-model through the context so
        // their semantics stay in sync with the projector.
        //
        // Per-turn projection cache (finding #1): reuse a settled turn's already
        // projected rows + view-model (with projection_fingerprints already
        // stamped) when its cache signature is unchanged, so a streaming delta
        // only re-projects the active turn instead of every turn.
        const baseCacheSignature = (turnRowCache instanceof Map)
          ? buildTurnProjectionCacheSignature(turn, messageContentFingerprintById)
          : '';
        // Fold the DC1 deterministic-row_id mode into the cache key (only when a
        // base signature exists, so the ""=>caching-disabled contract is
        // preserved) — a rare mid-session row-model rollback that flips
        // deterministicRowId then re-projects instead of serving stale row_ids.
        const turnCacheSignature = baseCacheSignature
          ? `${baseCacheSignature}|det:${deterministicRowId ? 1 : 0}`
          : '';
        let rows;
        let viewModel = null;
        const cachedTurn = turnCacheSignature ? turnRowCache.get(turnId) : null;
        if (cachedTurn && cachedTurn.signature === turnCacheSignature) {
          touchMapEntry(turnRowCache, turnId);
          rows = cachedTurn.rows;
          viewModel = cachedTurn.viewModel || null;
        } else {
          if (typeof projectTurn === 'function') {
            const projection = projectTurn(turn, { messageById, toolMessageIdsByCallId, deterministicRowId });
            rows = Array.isArray(projection && projection.rows) ? projection.rows : [];
            viewModel = projection && projection.viewModel ? projection.viewModel : null;
          } else {
            rows = projectTurnRows(Array.isArray(turn && turn.events) ? turn.events : [], { deterministicRowId });
          }
          for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            const row = rows[rowIndex];
            if (!row || typeof row !== 'object') {
              continue;
            }
            row.projection_fingerprint = buildProjectedRowContentFingerprint(row, messageById, toolMessageIdsByCallId);
          }
          if (turnCacheSignature) {
            turnRowCache.set(turnId, { signature: turnCacheSignature, rows, viewModel });
          }
        }
        rows = guardLiveTurnRows(rows, turn, messageById, {
          sessionId: String(sessionId || '').trim(),
          isNewestTurn: turnIndex === turns.length - 1,
        });
        rowsByTurnId.set(turnId, rows);
        if (viewModel) {
          viewModelByTurnId.set(turnId, viewModel);
        }
        const primaryAssistantMessageId = String(turn && turn.primary_assistant_message_id || '').trim();
        const visibleRows = rows.filter(function filterVisibleRows(row) {
          return row && String(row.kind || '').trim() !== 'user_bubble';
        });
        if (visibleRows.length > 0 && !primaryAssistantMessageId) {
          recordTurnArticleRolloutSignal('turn_article_missing_primary', {
            turnId,
            messageId: String(turn?.source_message_ids?.[0] || '').trim(),
            rowCount: visibleRows.length,
            sourceMessageCount: sourceMessageIds.length,
          });
        }
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex];
          const primaryMessageId = String(row && row.primary_message_id || '').trim();
          if (!primaryMessageId) {
            continue;
          }
          const existingRow = rowByPrimaryMessageId.get(primaryMessageId);
          if (!existingRow || row.kind === 'tool_step') {
            rowByPrimaryMessageId.set(primaryMessageId, row);
          }
          const renderMessageId = String(row && (row.render_message_id || row.primary_message_id) || '').trim();
          if (renderMessageId && !turnIdByMessageId.has(renderMessageId)) {
            turnIdByMessageId.set(renderMessageId, turnId);
          }
        }
      }
      // Bound the per-turn projection cache to the current turn set so entries
      // for deleted/edited-away turns cannot accumulate across renders.
      if (turnRowCache instanceof Map) {
        for (const cachedTurnId of Array.from(turnRowCache.keys())) {
          if (!turnById.has(cachedTurnId)) {
            turnRowCache.delete(cachedTurnId);
          }
        }
        if (isLongThreadBoundsEnabled(state?.features?.featureFlags)) {
          const pinnedTurnIds = collectPinnedTurnIds(turns, rowsByTurnId);
          pruneMapOldestFirst(turnRowCache, LONG_THREAD_BUDGETS.projectedTurns, {
            isPinned(turnId) { return pinnedTurnIds.has(String(turnId || '').trim()); },
          });
        }
      }
      // Single-source the rowsByRenderMessageId build through the helper so
      // multi-turn collisions deduplicate by (kind, primary_message_id[,
      // phase_id]) with canonical > reconciled > live. The hydrated path
      // here only ever emits canonical (untagged) rows, but going through
      // the same builder keeps the contract consistent with the overlay
      // path in projection-context.
      const rowsByRenderMessageId = indexRowsByRenderMessageId(rowsByTurnId);
      if (state.ui && typeof state.ui === 'object') {
        state.ui.longThreadBudgetStats = {
          ...(state.ui.longThreadBudgetStats || {}),
          projectionMs: Math.max(0, monotonicNow() - projectionStartedAt),
          projectedTurns: turns.length,
          projectedTurnCacheEntries: turnRowCache instanceof Map ? turnRowCache.size : 0,
          projectedTurnCacheCap: LONG_THREAD_BUDGETS.projectedTurns,
        };
      }
      return {
        turnTree: projectedTurnTree,
        turnById,
        turnIdByMessageId,
        rowsByTurnId,
        rowByPrimaryMessageId,
        rowsByRenderMessageId,
        viewModelByTurnId,
      };
    }

    function buildHydratedProjectionDigest(projectedTurnTree, rowsByTurnId) {
      const turns = Array.isArray(projectedTurnTree?.turns) ? projectedTurnTree.turns : [];
      const digestParts = [];
      for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
        const turn = turns[turnIndex];
        const turnId = String(turn && turn.turn_id || '').trim();
        const rows = turnId ? (rowsByTurnId.get(turnId) || []) : [];
        const rowFingerprints = [];
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex] || {};
          rowFingerprints.push([
            String(row.kind || ''),
            String(row.row_id || ''),
            String(row.primary_message_id || ''),
            String(row.projection_fingerprint || ''),
          ].join('~'));
        }
        digestParts.push([
          turnId,
          String(computeTurnStructureHash(turn, rows)),
          String(computeTurnTailFingerprint(turn, rows)),
          rowFingerprints.join('^'),
        ].join('|'));
      }
      return digestParts.join('||');
    }

    function resolveThreadRootMessageId(nodeById, messageId) {
      const normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId || !nodeById || typeof nodeById.get !== 'function') {
        return '';
      }
      let currentId = normalizedMessageId;
      const visited = new Set();
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const node = nodeById.get(currentId);
        const parentId = String(node?.parentId || '').trim();
        if (!node || !parentId) {
          return currentId;
        }
        currentId = parentId;
      }
      return normalizedMessageId;
    }

    function isLiveRowModelEnabledForSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const rowModelStore = state.ui?.chatTimelineRowModelBySession;
      if (!normalizedSessionId || !rowModelStore || typeof rowModelStore.get !== 'function') {
        return false;
      }
      return rowModelStore.get(normalizedSessionId) === true;
    }

    function getLiveProjectionStateForSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const liveStateStore = state.ui?.chatTimelineLiveStateBySession;
      if (!normalizedSessionId || !liveStateStore || typeof liveStateStore.get !== 'function') {
        return null;
      }
      return liveStateStore.get(normalizedSessionId) || null;
    }

    function buildLiveRowProjectionFingerprint(row) {
      const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
      // The Phase 2 `payload.raw_terminal` substatus is deliberately NOT part
      // of this fingerprint. Visible-state transitions (cancelled, timed_out,
      // completed, errored, denied, abandoned, interrupted) already live in
      // `payload.state`, and that is the drift signal consumers care about.
      // Including raw_terminal here would invalidate every hydrated digest on
      // the first post-upgrade render and force a one-time replay-drift
      // rollback across all sessions without any user-visible benefit.
      return [
        String(row?.kind || ''),
        String(row?.primary_message_id || ''),
        String(row?.tool_call_id || ''),
        String(row?.phase_id || ''),
        String(row?.assistant_phase || ''),
        String(row?.segment_group_index ?? ''),
        String(payload?.state || ''),
        String(payload?.text || payload?.content || ''),
        String(payload?.summary || ''),
        String(payload?.output_text || ''),
        String(payload?.result_summary || ''),
        String(payload?.error_code || ''),
        Array.isArray(payload?.entries) ? payload.entries.map((entry) => String(entry?.text || '')).join('^') : '',
      ].join('|');
    }

    function overlayProjectedRows(targetRowsByTurnId, targetRowByPrimaryMessageId, targetTurnById, targetTurnIdByMessageId, turnMeta, rows, options) {
      const normalizedTurnId = String(turnMeta?.turn_id || '').trim();
      if (!normalizedTurnId) {
        return;
      }
      const safeRows = Array.isArray(rows) ? rows : [];
      // Source tag tells the render-time dedup (buildTurnRowListMarkup) to
      // prefer canonical rows over live ones when both surface for the same
      // (kind, primary_message_id[, phase_id]) under one render_message_id.
      // Without this, keep-first picks whichever overlay ran last and can
      // pin a streaming-marked bubble after the response completes.
      const overlaySource = options && typeof options.source === 'string' ? options.source : '';
      for (let index = 0; index < safeRows.length; index += 1) {
        const row = safeRows[index];
        if (!row || typeof row !== 'object') {
          continue;
        }
        if (!row.projection_fingerprint) {
          row.projection_fingerprint = buildLiveRowProjectionFingerprint(row);
        }
        if (overlaySource) {
          row._dedup_source = overlaySource;
        }
      }
      // The hydrated turn tree keys a mid-stream turn by the send's local id
      // while the live reducer keys it by stream id, so the same logical turn
      // can exist twice in the maps. The hydrated twin is still load-bearing
      // (it carries rows the live reducer does not project, e.g. user bubble and
      // attachment rows), so it is NOT evicted wholesale — but its reasoning
      // rows duplicate the live turn's (under a different phase_id and a
      // different render article, which defeats the bucket-level dedup) and
      // must be filtered. Matching by primary_user_message_id pairs the two
      // turn ids without guessing at prefix conventions.
      const overlayUserMessageId = String(turnMeta?.primary_user_message_id || '').trim();
      if (overlayUserMessageId && safeRows.length > 0) {
        const liveReasoningMessageIds = new Set(
          safeRows
            .filter((row) => row && String(row.kind || '').trim() === 'reasoning')
            .map((row) => String(row.primary_message_id || '').trim())
            .filter(Boolean)
        );
        if (liveReasoningMessageIds.size > 0) {
          for (const [existingTurnId, existingTurn] of targetTurnById.entries()) {
            if (existingTurnId === normalizedTurnId) {
              continue;
            }
            if (String(existingTurn?.primary_user_message_id || '').trim() !== overlayUserMessageId) {
              continue;
            }
            const existingRows = targetRowsByTurnId.get(existingTurnId);
            if (!Array.isArray(existingRows) || !existingRows.length) {
              continue;
            }
            const filteredRows = existingRows.filter((row) => !(
              row
              && String(row.kind || '').trim() === 'reasoning'
              && liveReasoningMessageIds.has(String(row.primary_message_id || '').trim())
            ));
            if (filteredRows.length !== existingRows.length) {
              // New array on the (already cloned) overlay map — the cached
              // hydrated projection's row arrays stay untouched.
              targetRowsByTurnId.set(existingTurnId, filteredRows);
            }
          }
        }
      }
      targetTurnById.set(normalizedTurnId, turnMeta);
      targetRowsByTurnId.set(normalizedTurnId, safeRows);
      // Phase 2 follow-up: overlay the canonical view-model alongside rows
      // so Phase 3 lifecycle grammar has one authority for both live-
      // streaming and hydrated turns.
      const overlayViewModelMap = options && options.viewModelByTurnId instanceof Map ? options.viewModelByTurnId : null;
      if (overlayViewModelMap) {
        const viewModel = options.viewModel || null;
        if (viewModel) {
          overlayViewModelMap.set(normalizedTurnId, viewModel);
        }
      }
      const sourceIds = Array.isArray(turnMeta?.source_message_ids) ? turnMeta.source_message_ids : [];
      for (let index = 0; index < sourceIds.length; index += 1) {
        const sourceMessageId = String(sourceIds[index] || '').trim();
        if (sourceMessageId) {
          targetTurnIdByMessageId.set(sourceMessageId, normalizedTurnId);
        }
      }
      for (let rowIndex = 0; rowIndex < safeRows.length; rowIndex += 1) {
        const row = safeRows[rowIndex];
        const primaryMessageId = String(row?.primary_message_id || '').trim();
        if (!primaryMessageId) {
          continue;
        }
        const existingRow = targetRowByPrimaryMessageId.get(primaryMessageId);
        if (!existingRow || row.kind === 'tool_step') {
          targetRowByPrimaryMessageId.set(primaryMessageId, row);
        }
        targetTurnIdByMessageId.set(primaryMessageId, normalizedTurnId);
      }
    }

    function resolveProjectionStreamingRowTarget(projectionContext) {
      // The surgical streaming-row patch applies to every session.
      const activeTurnId = String(projectionContext?.activeTurnId || '').trim();
      const activeStreamingMessageId = String(projectionContext?.activeStreamingMessageId || '').trim();
      const activeRows = activeTurnId
        ? (projectionContext?.rowsByTurnId?.get?.(activeTurnId) || [])
        : [];
      if (activeStreamingMessageId) {
        for (let index = activeRows.length - 1; index >= 0; index -= 1) {
          const row = activeRows[index];
          if (String(row?.kind || '').trim() !== 'assistant_text') {
            continue;
          }
          if (String(row?.primary_message_id || '').trim() === activeStreamingMessageId) {
            return null;
          }
        }
      }
      for (let index = activeRows.length - 1; index >= 0; index -= 1) {
        const row = activeRows[index];
        if (String(row?.kind || '').trim() !== 'tool_result') {
          continue;
        }
        const toolCallId = String(row?.tool_call_id || row?.payload?.tool_call_id || '').trim();
        if (!toolCallId) {
          continue;
        }
        return {
          turnId: activeTurnId,
          rowKind: 'tool_result',
          toolCallId,
          row,
        };
      }
      return null;
    }

    function resolveProjectionStreamingRowId(projectionContext) {
      const target = resolveProjectionStreamingRowTarget(projectionContext);
      return target?.row ? buildTurnRowId(target.row) : '';
    }

    function buildProjectionStreamingRowMarkup(target, messages, projectionContext) {
      if (!target?.row) {
        return '';
      }
      const rowListMarkup = buildTurnRowListMarkup([target.row], messages, {
         projectionContext,
         messageById: projectionContext?.messageById,
         turnIdByMessageId: projectionContext?.turnIdByMessageId,
         sessionId: String(state.currentSessionId || '').trim(),
        reducedMotion: reducedMotionQuery.matches === true,
        streamingRowId: buildTurnRowId(target.row),
      });
      if (!String(rowListMarkup || '').trim()) {
        return '';
      }
      const template = (globalRef.document || chatTimeline?.ownerDocument)?.createElement?.('template');
      if (!template) {
        return '';
      }
      template.innerHTML = String(rowListMarkup || '').trim();
      return template.content.querySelector('.chat-row')?.outerHTML || '';
    }

    function pruneConsumedLiveProjectionState(sessionId, liveProjectionState, consumedTurnIds) {
      const normalizedSessionId = String(sessionId || '').trim();
      const liveStateStore = state.ui?.chatTimelineLiveStateBySession;
      if (
        !normalizedSessionId
        || !liveProjectionState
        || !Array.isArray(consumedTurnIds)
        || consumedTurnIds.length < 1
        || !liveStateStore
        || typeof liveStateStore.delete !== 'function'
      ) {
        return;
      }
      consumedTurnIds.forEach(function deleteConsumedTurn(turnId) {
        const normalizedTurnId = String(turnId || '').trim();
        if (!normalizedTurnId) {
          return;
        }
        if (liveProjectionState.reconciled_rows_by_turn_id && typeof liveProjectionState.reconciled_rows_by_turn_id === 'object') {
          delete liveProjectionState.reconciled_rows_by_turn_id[normalizedTurnId];
        }
        if (liveProjectionState.pending_reconciliation_by_turn_id && typeof liveProjectionState.pending_reconciliation_by_turn_id === 'object') {
          delete liveProjectionState.pending_reconciliation_by_turn_id[normalizedTurnId];
        }
      });
      const hasLiveTurns = Boolean(
        liveProjectionState.turns_by_id
        && typeof liveProjectionState.turns_by_id === 'object'
        && Object.keys(liveProjectionState.turns_by_id).length
      );
      const hasReconciledTurns = Boolean(
        liveProjectionState.reconciled_rows_by_turn_id
        && typeof liveProjectionState.reconciled_rows_by_turn_id === 'object'
        && Object.keys(liveProjectionState.reconciled_rows_by_turn_id).length
      );
      const hasPendingReconciliations = Boolean(
        liveProjectionState.pending_reconciliation_by_turn_id
        && typeof liveProjectionState.pending_reconciliation_by_turn_id === 'object'
        && Object.keys(liveProjectionState.pending_reconciliation_by_turn_id).length
      );
      if (!hasLiveTurns && !hasReconciledTurns && !hasPendingReconciliations) {
        liveStateStore.delete(normalizedSessionId);
      }
    }

    return {
      getPersistedTurnEventState,
      buildHydratedTurnProjection,
      buildHydratedProjectionDigest,
      resolveThreadRootMessageId,
      isLiveRowModelEnabledForSession,
      getLiveProjectionStateForSession,
      overlayProjectedRows,
      resolveProjectionStreamingRowTarget,
      resolveProjectionStreamingRowId,
      buildProjectionStreamingRowMarkup,
      pruneConsumedLiveProjectionState,
    };
  }

  return { createHydrationPipeline };
});
