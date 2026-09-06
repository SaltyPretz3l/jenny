(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineProjectionContextUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createProjectionContextPipeline(deps) {
    const { state = {}, constants = {}, callbacks = {} } = deps || {};
    const { MESSAGE_STATUS = {} } = constants;
    const {
      escapeHtml = (value) => String(value || ''),
      renderToolCallBlock = () => '',
      buildProjectedToolCallRowMarkup = null,
      hasSpecializedToolShell = () => false,
      projectTurn = null,
      projectTurnTree = null,
      projectTurnRows = null,
      computeProjectionSignature = () => '',
      computeProjectionSignatureFromFingerprints = null,
      computeTurnStructureHash = () => 0,
      computeTurnTailFingerprint = () => '',
      getChatTimelineRowModelEnabled = () => false,
      recordChatTimelineRolloutSignal = () => ({ logged: false, count: 0 }),
      rollbackChatTimelineRowModel = () => false,
      // C1 projection-cache pipeline:
      getProjectionContextCache = () => null,
      finalizeProjectionContext = (_sessionId, context) => context,
      getRowModelMeta = () => null,
      countLegacyVisibleMessages = () => 0,
      logToolRowProjectionFailureOnce = () => {},
      logToolRowProjectionFallbackOnce = () => {},
      // C2 hydration pipeline:
      getPersistedTurnEventState = () => ({ turnEventLogVersion: 0, turnEvents: [] }),
      buildHydratedTurnProjection = () => ({
        turnTree: null,
        turnById: new Map(),
        turnIdByMessageId: new Map(),
        rowsByTurnId: new Map(),
        rowByPrimaryMessageId: new Map(),
        rowsByRenderMessageId: new Map(),
        viewModelByTurnId: new Map(),
      }),
      buildHydratedProjectionDigest = () => '',
      isLiveRowModelEnabledForSession = () => false,
      getLiveProjectionStateForSession = () => null,
      overlayProjectedRows = () => {},
      pruneConsumedLiveProjectionState = () => {},
      resolveThreadRootMessageId = () => '',
      // B1 thread-state pipeline:
      buildInteractiveRecapModel = () => null,
      isRecapExpandedForSession = () => false,
      // Render-message-index helper (single source for the multi-turn dedup
      // contract; tagged `_dedup_source` rows from live/reconciled overlays
      // lose to canonical rows here so downstream renderers receive a
      // single-row-per-(kind, primary_message_id[, phase_id]) bucket).
      indexRowsByRenderMessageId = (rowsByTurnId) => {
        const rowsByRenderMessageId = new Map();
        if (!rowsByTurnId || typeof rowsByTurnId.forEach !== 'function') {
          return rowsByRenderMessageId;
        }
        rowsByTurnId.forEach(function indexTurnRows(rows) {
          const sourceRows = Array.isArray(rows) ? rows : [];
          for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
            const row = sourceRows[rowIndex];
            const renderMessageId = String(row && (row.render_message_id || row.primary_message_id) || '').trim();
            if (!renderMessageId) {
              continue;
            }
            const bucket = rowsByRenderMessageId.get(renderMessageId) || [];
            bucket.push(row);
            rowsByRenderMessageId.set(renderMessageId, bucket);
          }
        });
        return rowsByRenderMessageId;
      },
    } = callbacks;
    const turnEventArrayRevisionByIdentity = new WeakMap();
    let nextTurnEventArrayRevision = 1;
    // Monotonic per-session revision of the live/reconciled projection
    // overlay's contribution to SETTLED turns. Message fingerprints cannot see
    // projection-row-only changes (rows live in liveProjectionState, not on
    // any message), so this revision participates in the transcript render
    // signature instead: bumping it is what invalidates the no-op guard and
    // the narrow patch paths in renderer-render-pipeline-message-renderer.js.
    // It replaces the per-render `forceFullRender` context flag — a persistent
    // counter survives any early return between context build and DOM commit
    // (the flag did not), so a dropped render self-heals on the next one.
    // Bump it from any future mutation path whose projection-row or render-
    // authority change must reach the DOM without a message fingerprint
    // changing. Streaming text/tool deltas deliberately do not bump per event;
    // their message-level deltas already invalidate the active-turn patch.
    // Store the counter on the bounded projection cache so session clear/rekey
    // lifecycle applies to it automatically.

    function getProjectionStateRevision(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return 0;
      }
      return Number(getProjectionContextCache(normalizedSessionId)?.projectionStateRevision) || 0;
    }

    function bumpProjectionStateRevision(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return 0;
      }
      const cache = getProjectionContextCache(normalizedSessionId, { create: true });
      if (!cache) {
        return 0;
      }
      const next = (Number(cache.projectionStateRevision) || 0) + 1;
      cache.projectionStateRevision = next;
      return next;
    }

    // Session-scoped key ("<sessionId>|<revision>") so a cross-session compare
    // can never alias two sessions' revisions onto the same value.
    function buildProjectionStateRevisionKey(sessionId) {
      return sessionId + '|' + getProjectionStateRevision(sessionId);
    }

    function resolveTurnEventArrayRevision(turnEvents) {
      if (!Array.isArray(turnEvents)) {
        return 0;
      }
      const cached = turnEventArrayRevisionByIdentity.get(turnEvents);
      if (cached) {
        return cached;
      }
      const revision = nextTurnEventArrayRevision;
      nextTurnEventArrayRevision += 1;
      if (nextTurnEventArrayRevision > Number.MAX_SAFE_INTEGER) {
        nextTurnEventArrayRevision = 1;
      }
      turnEventArrayRevisionByIdentity.set(turnEvents, revision);
      return revision;
    }

    function buildProjectionContext(messages, threadTree, derivedState, renderInputs) {
      const sourceMessages = Array.isArray(messages) ? messages : [];
      // The render pipeline computes every message's content fingerprint once
      // per render (finding #2) and threads the list in here so the projection
      // cache key reuses that work instead of re-fingerprinting the whole
      // transcript a second time.
      const messageFingerprints = renderInputs && Array.isArray(renderInputs.messageFingerprints)
        ? renderInputs.messageFingerprints
        : null;
      const normalizedSessionId = String(state.currentSessionId || '').trim();
      const turnEventState = getPersistedTurnEventState(normalizedSessionId);
      // INVARIANT (audit E1): the turn-event contribution to this cache key is
      // (event_id, event_seq) only — deliberately NOT the event payload. This is
      // sound ONLY because persisted turn events are immutable under a stable
      // event_id: both backends (services/backend/session-turn-events.js and
      // session-shadow-store.js) are append-only and dedupe-by-event_id, so a
      // re-emitted event is dropped, never replaced in place. The full-transcript
      // message fingerprint below covers source-content changes. If a future path
      // ever lets a projected row derive VISIBLE text from a payload field that can
      // change under a stable event_id:event_seq, fold a cheap per-event payload
      // hash in here (and into the per-turn key in
      // renderer-render-pipeline-hydration.js) or this cache will serve stale rows.
      const turnEventSignature = resolveTurnEventArrayRevision(turnEventState.turnEvents);
      const projectionMessageSignature = messageFingerprints && typeof computeProjectionSignatureFromFingerprints === 'function'
        ? computeProjectionSignatureFromFingerprints(messageFingerprints)
        : computeProjectionSignature(sourceMessages);
      const projectionSignature = [
        projectionMessageSignature,
        String(turnEventState.turnEventLogVersion || 0),
        turnEventSignature,
      ].join('||');
      const cached = getProjectionContextCache(normalizedSessionId);
      // P3-PERF-B: settle the whole-projection cache question BEFORE walking the
      // transcript. The signature is derived from the fingerprint list the caller
      // already computed, so asking early costs nothing here — and knowing the
      // answer is what collapses two full-message passes into one:
      //   * messageById is always needed (it is part of the returned context),
      //   * messageContentFingerprintById is consumed ONLY by the projection
      //     rebuild below, so a cache hit must not pay to build it at all.
      // Both are independent first-id-wins indexes over the same array in the
      // same order, so fusing their loops cannot change either map's contents.
      // Keep this the SAME expression the rebuild below branches on: if the two
      // ever disagree, the rebuild receives a null fingerprint map and silently
      // drops the per-turn projection cache to a full re-projection every turn.
      const reusableTurnProjection = cached && cached.projectionSignature === projectionSignature
        ? cached.turnProjection
        : null;
      const messageById = new Map();
      // Map message id -> content fingerprint so the hydration pipeline can build
      // cheap per-turn cache signatures (finding #1) without re-fingerprinting.
      const messageContentFingerprintById = !reusableTurnProjection && messageFingerprints
        ? new Map()
        : null;
      for (let index = 0; index < sourceMessages.length; index += 1) {
        const message = sourceMessages[index];
        const messageId = String(message && message.id || '').trim();
        if (!messageId) {
          continue;
        }
        if (!messageById.has(messageId)) {
          messageById.set(messageId, message);
        }
        if (messageContentFingerprintById && !messageContentFingerprintById.has(messageId)) {
          messageContentFingerprintById.set(messageId, messageFingerprints[index]?.content || '');
        }
      }
      if (!projectTurnTree || !projectTurnRows) {
        return finalizeProjectionContext(normalizedSessionId, {
          available: false,
          projectionSignature,
          messageById,
          turnTree: null,
          turnById: new Map(),
          turnIdByMessageId: new Map(),
          rowsByTurnId: new Map(),
          rowByPrimaryMessageId: new Map(),
          rowsByRenderMessageId: new Map(),
          viewModelByTurnId: new Map(),
          activeTurnId: '',
          activeTurnRootMessageId: '',
          activeTurnStructureHash: 0,
          activeTurnTailFingerprint: '',
          projectionStateRevisionKey: buildProjectionStateRevisionKey(normalizedSessionId),
        });
      }
      try {
        const rolloutMeta = getRowModelMeta(normalizedSessionId, { create: true });
        // Resolved above the transcript walk so messageContentFingerprintById is
        // built exactly when this is null — i.e. only when the rebuild runs.
        let turnProjection = reusableTurnProjection;
        if (!turnProjection) {
          const cache = getProjectionContextCache(normalizedSessionId, { create: true });
          // Per-turn projection cache (finding #1) persists on the per-session
          // projection cache object so it survives whole-projection cache misses
          // (which fire on every streaming delta) and is evicted together with
          // the session entry. Settled turns are reused; only the active turn
          // re-projects.
          let turnRowCache = cache && cache.turnRowCache instanceof Map ? cache.turnRowCache : null;
          if (cache && !turnRowCache) {
            turnRowCache = new Map();
            cache.turnRowCache = turnRowCache;
          }
          turnProjection = buildHydratedTurnProjection(sourceMessages, threadTree, turnEventState, {
            // Reuse the messageById map already built above instead of letting
            // the hydration pipeline rebuild a byte-identical one (finding #14).
            messageById,
            turnRowCache,
            messageContentFingerprintById,
            // Threads send-lifecycle liveness into the live-turn interrupted
            // guard (see guardLiveTurnRows in the hydration pipeline).
            sessionId: normalizedSessionId,
          });
          if (cache) {
            cache.projectionSignature = projectionSignature;
            cache.turnProjection = turnProjection;
          }
        }
        if (getChatTimelineRowModelEnabled(normalizedSessionId) === true && rolloutMeta) {
          const lastSignature = rolloutMeta.last_hydrated_projection_signature;
          const lastDigest = String(rolloutMeta.last_hydrated_projection_digest || '');
          // Rollout canary runs once per projectionSignature. Re-running every render
          // saturates the main thread during streaming on long conversations (each
          // delta-triggered render would otherwise rebuild the full projection a
          // second time for diagnostics + walk every turn × row). The cache is
          // per-session and the projection is not mutated after build, so a stable
          // signature implies a stable projection.
          if (lastSignature !== projectionSignature || !lastDigest) {
            let didRollbackThisRender = false;
            const diagnosticTurns = Array.isArray(turnProjection.turnTree?.turns)
              ? turnProjection.turnTree.turns
              : [];
            const diagnosticDigest = buildHydratedProjectionDigest(
              turnProjection.turnTree,
              turnProjection.rowsByTurnId
            );
            let hydratedRowCount = 0;
            for (let turnIndex = 0; turnIndex < diagnosticTurns.length; turnIndex += 1) {
              const turn = diagnosticTurns[turnIndex];
              const turnId = String(turn?.turn_id || '').trim();
              const rows = turnId ? (turnProjection.rowsByTurnId.get(turnId) || []) : [];
              hydratedRowCount += rows.length;
              for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
                const row = rows[rowIndex];
                const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
                const subkind = String(payload.subkind || '').trim();
                if (row?.kind === 'system_notice' && subkind.startsWith('orphan_')) {
                  recordChatTimelineRolloutSignal(normalizedSessionId, 'orphan_row', {
                    subkind,
                    turnId,
                    primaryMessageId: String(row?.primary_message_id || '').trim(),
                  });
                }
                if (row?.kind === 'tool_call' && String(payload.state || '').trim() === 'interrupted') {
                  recordChatTimelineRolloutSignal(normalizedSessionId, 'interrupted_running_tool_hydration', {
                    turnId,
                    toolCallId: String(row?.tool_call_id || payload.tool_call_id || '').trim(),
                    primaryMessageId: String(row?.primary_message_id || '').trim(),
                  });
                }
              }
            }
            const legacyVisibleCount = countLegacyVisibleMessages(sourceMessages);
            const turnEventCount = Array.isArray(turnEventState.turnEvents)
              ? turnEventState.turnEvents.length
              : 0;
            // Rows project from both messages and canonical turn events; counting
            // only messages made this ratio track tool-heavy or interrupted turns.
            const rowCountBudgetBase = legacyVisibleCount + turnEventCount;
            const rowCountLimit = Math.max(12, rowCountBudgetBase * 4);
            if (hydratedRowCount > rowCountLimit) {
              recordChatTimelineRolloutSignal(normalizedSessionId, 'row_count_sanity', {
                hydratedRowCount,
                legacyVisibleCount,
                turnEventCount,
                rowCountLimit,
                projectionSignature,
              });
              rollbackChatTimelineRowModel(normalizedSessionId, 'row_count_sanity', {
                hydratedRowCount,
                legacyVisibleCount,
                turnEventCount,
                rowCountLimit,
                projectionSignature,
              }, {
                renderNow: false,
              });
              didRollbackThisRender = true;
              // Rollback swaps every turn back to the legacy projection with
              // no message change — bump so the signature/patch guards commit.
              bumpProjectionStateRevision(normalizedSessionId);
            }
            if (!didRollbackThisRender) {
              rolloutMeta.last_hydrated_projection_signature = projectionSignature;
              rolloutMeta.last_hydrated_projection_digest = diagnosticDigest;
            }
          }
        }
        const liveProjectionState = isLiveRowModelEnabledForSession(normalizedSessionId)
          ? getLiveProjectionStateForSession(normalizedSessionId)
          : null;
        // The six cached projection Maps are cloned only to protect the cached
        // projection from overlayProjectedRows mutation, which runs solely inside
        // the `if (liveProjectionState)` block. When no live overlay applies (the
        // common case — the row-model overlay is a gated rollout), the cached
        // projection is read-only here, so pass its Maps through directly instead
        // of allocating six fresh copies per render (finding #13).
        const rowsByTurnId = liveProjectionState
          ? new Map(turnProjection.rowsByTurnId)
          : turnProjection.rowsByTurnId;
        const rowByPrimaryMessageId = liveProjectionState
          ? new Map(turnProjection.rowByPrimaryMessageId)
          : turnProjection.rowByPrimaryMessageId;
        let rowsByRenderMessageId;
        if (turnProjection.rowsByRenderMessageId instanceof Map) {
          rowsByRenderMessageId = liveProjectionState
            ? new Map(turnProjection.rowsByRenderMessageId)
            : turnProjection.rowsByRenderMessageId;
        } else {
          rowsByRenderMessageId = indexRowsByRenderMessageId(rowsByTurnId);
        }
        const turnById = liveProjectionState
          ? new Map(turnProjection.turnById)
          : turnProjection.turnById;
        const turnIdByMessageId = liveProjectionState
          ? new Map(turnProjection.turnIdByMessageId)
          : turnProjection.turnIdByMessageId;
        const viewModelByTurnId = turnProjection.viewModelByTurnId instanceof Map
          ? (liveProjectionState ? new Map(turnProjection.viewModelByTurnId) : turnProjection.viewModelByTurnId)
          : new Map();
        const activeMessageId = String(derivedState?.streamingMessage?.id || '').trim();
        let activeTurnId = activeMessageId
          ? String(turnIdByMessageId.get(activeMessageId) || '').trim()
          : '';
        let didOverlayRows = false;
        let liveActiveTurnId = '';
        if (liveProjectionState) {
          const consumedReconciledTurnIds = [];
          const reconciledTurns = liveProjectionState.reconciled_rows_by_turn_id && typeof liveProjectionState.reconciled_rows_by_turn_id === 'object'
            ? liveProjectionState.reconciled_rows_by_turn_id
            : {};
          const pendingReconciliations = liveProjectionState.pending_reconciliation_by_turn_id
            && typeof liveProjectionState.pending_reconciliation_by_turn_id === 'object'
            ? liveProjectionState.pending_reconciliation_by_turn_id
            : {};
          Object.keys(reconciledTurns).forEach(function overlayReconciledTurn(turnId) {
            const entry = reconciledTurns[turnId];
            if (!entry || !entry.turn || pendingReconciliations[turnId] !== true) {
              return;
            }
            overlayProjectedRows(
              rowsByTurnId,
              rowByPrimaryMessageId,
              turnById,
              turnIdByMessageId,
              entry.turn,
              entry.rows,
              { viewModelByTurnId, viewModel: entry.viewModel || null, source: 'reconciled' }
            );
            didOverlayRows = true;
            consumedReconciledTurnIds.push(turnId);
          });
          const liveTurns = liveProjectionState.turns_by_id && typeof liveProjectionState.turns_by_id === 'object'
            ? liveProjectionState.turns_by_id
            : {};
          liveActiveTurnId = String(liveProjectionState.active_turn_id || '').trim();
          Object.keys(liveTurns).forEach(function overlayLiveTurn(turnId) {
            const entry = liveTurns[turnId];
            if (!entry) {
              return;
            }
            // Phase 2 follow-up: derive a canonical view-model from the
            // live provisional turn's event stream so consumers (composer
            // status, comet presence, transcript emphasis) have the same
            // authority during streaming as after reconciliation.
            let liveViewModel = null;
            if (typeof projectTurn === 'function' && Array.isArray(entry.events) && entry.events.length > 0) {
              try {
                const liveProjection = projectTurn(
                  { turn_id: turnId, events: entry.events, primary_user_message_id: entry.primary_user_message_id, primary_assistant_message_id: entry.primary_assistant_message_id },
                  { messageById }
                );
                liveViewModel = liveProjection && liveProjection.viewModel ? liveProjection.viewModel : null;
              } catch (_liveViewModelError) {
                liveViewModel = null;
              }
            }
            overlayProjectedRows(
              rowsByTurnId,
              rowByPrimaryMessageId,
              turnById,
              turnIdByMessageId,
              entry,
              entry.rows,
              { viewModelByTurnId, viewModel: liveViewModel, source: 'live' }
            );
            didOverlayRows = true;
          });
          // Only let the live state's active_turn_id override the canonical
          // derivation when a streaming message still exists. Otherwise a
          // stale live entry — surviving the gap between the complete-event
          // status flip and settleRowModelTerminalState clearing it — would
          // keep isStreaming/throbbers visible on a finished turn.
          if (liveActiveTurnId && activeMessageId) {
            activeTurnId = liveActiveTurnId;
          }
          // Consuming a reconciled turn prunes it from live state below, so
          // this render must be the one that commits the corrected rows. The
          // revision bump breaks the transcript render-signature no-op guard
          // and bails the narrow patch paths
          // (renderer-render-pipeline-message-renderer.js); without it, a
          // terminal whose messages did not change since the immediate
          // terminal render (the common error/cancel path) consumes the
          // reconciled rows and never commits them to the DOM — the turn's
          // error card is silently lost. If a later early return still drops
          // this render, the stale committed revision keeps every subsequent
          // render invalid until a full render commits the canonical rows.
          if (consumedReconciledTurnIds.length > 0) {
            bumpProjectionStateRevision(normalizedSessionId);
          }
          pruneConsumedLiveProjectionState(normalizedSessionId, liveProjectionState, consumedReconciledTurnIds);
        }
        if (didOverlayRows) {
          rowsByRenderMessageId = indexRowsByRenderMessageId(rowsByTurnId);
        }
        // A tool boundary finalizes the segment's assistant message and deletes
        // its pendingStreams entry, briefly leaving a running turn with no
        // streaming message. Root-scope fields may follow the live turn there
        // because they choose which scope repaints; activeTurnId also decides
        // whether the turn renders as streaming and must remain narrower.
        const activeRootScopeTurnId = activeTurnId || (
          liveActiveTurnId
            && state.ui?.chatSendLifecycleBySession?.get?.(normalizedSessionId) === 'streaming'
            ? liveActiveTurnId
            : ''
        );
        const activeTurn = activeRootScopeTurnId ? turnById.get(activeRootScopeTurnId) : null;
        const activeTurnRootMessageId = activeTurn
          ? resolveThreadRootMessageId(
              threadTree?.nodeById,
              activeTurn.primary_user_message_id || activeTurn.primary_assistant_message_id || activeMessageId
            )
          : '';
        const activeRows = activeRootScopeTurnId ? (rowsByTurnId.get(activeRootScopeTurnId) || []) : [];
        return finalizeProjectionContext(normalizedSessionId, {
          available: true,
          projectionSignature,
          messageById,
          turnTree: turnProjection.turnTree,
          turnById,
          turnIdByMessageId,
          rowsByTurnId,
          rowByPrimaryMessageId,
          rowsByRenderMessageId,
          viewModelByTurnId,
          activeTurnId,
          activeStreamingMessageId: activeMessageId,
          activeTurnRootMessageId,
          activeTurnStructureHash: activeTurn ? computeTurnStructureHash(activeTurn, activeRows) : 0,
          activeTurnTailFingerprint: activeTurn ? computeTurnTailFingerprint(activeTurn, activeRows) : '',
          projectionStateRevisionKey: buildProjectionStateRevisionKey(normalizedSessionId),
        });
      } catch (error) {
        logToolRowProjectionFailureOnce('project_turn_rows_failed', {
          messageCount: sourceMessages.length,
          message: error && error.message ? error.message : String(error),
        });
        return finalizeProjectionContext(normalizedSessionId, {
          available: false,
          projectionSignature,
          messageById,
          turnTree: null,
          turnById: new Map(),
          turnIdByMessageId: new Map(),
          rowsByTurnId: new Map(),
          rowByPrimaryMessageId: new Map(),
          rowsByRenderMessageId: new Map(),
          viewModelByTurnId: new Map(),
          activeTurnId: '',
          activeTurnRootMessageId: '',
          activeTurnStructureHash: 0,
          activeTurnTailFingerprint: '',
          projectionStateRevisionKey: buildProjectionStateRevisionKey(normalizedSessionId),
        });
      }
    }

    function resolveProjectedPrimaryRow(message, projectionContext) {
      return projectionContext && projectionContext.rowByPrimaryMessageId
        ? projectionContext.rowByPrimaryMessageId.get(String(message && message.id || '').trim()) || null
        : null;
    }

    // Lifecycle states that keep a tool call on the legacy block path even
    // when the trace-rows fix is on: an unsettled call still needs the classic
    // auto-expanded block with its inline approval affordances. Every other
    // state except 'interrupted' classifies as settled — deliberately
    // including the reducer's 'abandoned' (approved-then-superseded: no
    // pending user action, so the trace row is the right surface).
    const UNSETTLED_TOOL_CALL_STATES = new Set([
      '', 'requested', 'running', 'executing', 'approved', 'awaiting_approval', 'pending_approval', 'pending', 'queued', 'waiting',
    ]);

    function resolvePairedToolResultRow(toolCallRow, projectionContext) {
      const turnId = String(toolCallRow && toolCallRow.turn_id || '').trim();
      const callId = String(
        toolCallRow && (toolCallRow.tool_call_id || (toolCallRow.payload && toolCallRow.payload.tool_call_id)) || ''
      ).trim();
      if (!turnId || !callId || !projectionContext || !(projectionContext.rowsByTurnId instanceof Map)) {
        return null;
      }
      const turnRows = projectionContext.rowsByTurnId.get(turnId) || [];
      for (let index = 0; index < turnRows.length; index += 1) {
        const row = turnRows[index];
        if (!row || String(row.kind || '').trim() !== 'tool_result') {
          continue;
        }
        const rowCallId = String(row.tool_call_id || (row.payload && row.payload.tool_call_id) || '').trim();
        if (rowCallId === callId) {
          return row;
        }
      }
      return null;
    }

    function isSettledProjectedToolCall(toolCallRow, pairedResultRow) {
      if (pairedResultRow) {
        return true;
      }
      const payload = toolCallRow && toolCallRow.payload && typeof toolCallRow.payload === 'object'
        ? toolCallRow.payload
        : {};
      const status = String(payload.state || payload.status || toolCallRow?.status || '').trim().toLowerCase();
      return !UNSETTLED_TOOL_CALL_STATES.has(status) && status !== 'interrupted';
    }

    function resolveRetryMessageIdForToolRow(toolCallRow, messages, projectionContext) {
      const sourceMessages = Array.isArray(messages) ? messages : [];
      let latestReplyId = '';
      for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
        const candidate = sourceMessages[index];
        const kind = String(candidate && candidate.kind || '');
        const status = String(candidate && candidate.status || 'complete').trim().toLowerCase();
        if (String(candidate && candidate.role || '') === 'assistant'
          && kind !== 'tool_use'
          && kind !== 'tool_result'
          && kind !== 'interactive_round_recap'
          && kind !== 'proactive_suggestion'
          && kind !== 'question_batch'
          && kind !== 'slash_command_output'
          && status === 'complete') {
          latestReplyId = String(candidate.id || '').trim();
          break;
        }
      }
      if (!latestReplyId) return '';
      const toolTurnId = String(toolCallRow && toolCallRow.turn_id || '').trim();
      const replyTurnId = String(projectionContext?.turnIdByMessageId?.get?.(latestReplyId) || '').trim();
      return toolTurnId && replyTurnId === toolTurnId ? latestReplyId : '';
    }

    function buildToolEntryInnerMarkup(message, messages, projectionContext) {
      const projectedToolRow = resolveProjectedPrimaryRow(message, projectionContext);
      const toolRowContext = projectionContext;
      const messageId = String(message && message.id || '').trim();
      if (
        !projectedToolRow
        && toolRowContext
        && toolRowContext.available
        && toolRowContext.turnIdByMessageId
        && toolRowContext.turnIdByMessageId.has(messageId)
      ) {
        logToolRowProjectionFallbackOnce(message && message.id, 'missing_projected_row');
      }
      if (projectedToolRow && String(projectedToolRow.kind || '').trim() === 'tool_call') {
        const projectedCallId = String(projectedToolRow.tool_call_id || projectedToolRow.payload?.tool_call_id || '').trim();
        if (!projectedCallId) {
          logToolRowProjectionFallbackOnce(projectedToolRow.row_id || messageId, 'missing_tool_call_id');
        }
      }
      // When chat_tool_trace_rows_fix is enabled, settled projected tool calls use trace rows; unsettled calls retain the classic approval affordances. When disabled, use the legacy path.
      if (
        Boolean(state?.features?.featureFlags?.chat_tool_trace_rows_fix)
        && projectedToolRow
        && String(projectedToolRow.kind || '').trim() === 'tool_call'
        && typeof buildProjectedToolCallRowMarkup === 'function'
      ) {
        const pairedToolResultRow = resolvePairedToolResultRow(projectedToolRow, toolRowContext);
        const projectedToolName = String(
          projectedToolRow.payload?.tool_name
          || pairedToolResultRow?.payload?.tool_name
          || ''
        ).trim();
        const projectedToolState = String(
          projectedToolRow.payload?.state
          || projectedToolRow.payload?.status
          || ''
        ).trim().toLowerCase();
        // Keep the established rich shells as the single rendering owner for
        // tool-specific output. The generic trace row intentionally handles
        // only tools without a specialized renderer.
        if (
          !(hasSpecializedToolShell(projectedToolName) && projectedToolState !== 'denied')
          && isSettledProjectedToolCall(projectedToolRow, pairedToolResultRow)
        ) {
          const traceRowMarkup = buildProjectedToolCallRowMarkup(projectedToolRow, messages, {
            pairedToolResultRow,
            messageById: toolRowContext && toolRowContext.messageById,
            sessionId: String(state.currentSessionId || '').trim(),
            turnIdByMessageId: toolRowContext && toolRowContext.turnIdByMessageId,
            retryMessageId: resolveRetryMessageIdForToolRow(projectedToolRow, messages, toolRowContext),
          });
          if (traceRowMarkup && String(traceRowMarkup).trim()) {
            return `
            <div class="chat-role sr-only">${escapeHtml(message.role)}</div>
            ${traceRowMarkup}
          `;
          }
        }
      }
      // Phase 2D adoption: thread the canonical view-model's tool-call entry
      // through to the classic shell so buildToolCallViewModel can derive its
      // render fields from canonical data instead of a second state machine.
      let canonicalToolCall = null;
      if (projectedToolRow && toolRowContext?.viewModelByTurnId instanceof Map) {
        const turnId = String(projectedToolRow.turn_id || '').trim();
        const viewModel = turnId ? toolRowContext.viewModelByTurnId.get(turnId) : null;
        const callId = String(projectedToolRow.tool_call_id || projectedToolRow.payload?.tool_call_id || '').trim();
        if (viewModel && Array.isArray(viewModel.toolCalls) && callId) {
          canonicalToolCall = viewModel.toolCalls.find((tc) => String(tc.toolCallId || '').trim() === callId) || null;
        }
      }
      return `
            <div class="chat-role sr-only">${escapeHtml(message.role)}</div>
            ${renderToolCallBlock(message, messages, projectedToolRow
              ? {
                  projectedToolRow,
                  messageById: toolRowContext.messageById,
                  canonicalToolCall,
                  sessionId: String(state.currentSessionId || '').trim(),
                  turnId: projectedToolRow.turn_id,
                  rowId: projectedToolRow.row_id,
                  turnIdByMessageId: toolRowContext.turnIdByMessageId,
                }
              : undefined)}
          `;
    }

    function resolveArticlePredictionCacheKey(message, projectionContext) {
      const projectedRow = resolveProjectedPrimaryRow(message, projectionContext);
      if (projectedRow && projectedRow.turn_id && projectedRow.row_id) {
        return `turn:${projectedRow.turn_id}:row:${projectedRow.row_id}`;
      }
      return `article:${String(message && message.id || '').trim()}`;
    }

    function getMessageFromCollection(messageId, messages, projectionContext) {
      const normalizedMessageId = String(messageId || '').trim();
      if (!normalizedMessageId) {
        return null;
      }
      const messageById = projectionContext?.messageById;
      if (messageById && typeof messageById.get === 'function') {
        return messageById.get(normalizedMessageId) || null;
      }
      const sourceMessages = Array.isArray(messages) ? messages : [];
      for (let index = 0; index < sourceMessages.length; index += 1) {
        const message = sourceMessages[index];
        if (String(message && message.id || '').trim() === normalizedMessageId) {
          return message;
        }
      }
      return null;
    }

    function deriveActionTargetMessageId(turn, rows) {
      const sourceRows = Array.isArray(rows) ? rows : [];
      for (let index = sourceRows.length - 1; index >= 0; index -= 1) {
        const row = sourceRows[index];
        if (!row || String(row.kind || '') !== 'assistant_text') {
          continue;
        }
        const primaryMessageId = String(row.primary_message_id || '').trim();
        if (primaryMessageId) {
          return primaryMessageId;
        }
      }
      return String(turn && turn.primary_assistant_message_id || '').trim();
    }

    function getForcedOpenStreamingMessageId(messages, derivedState) {
      const derivedStreamingId = String(derivedState?.streamingMessage?.id || '').trim();
      if (derivedStreamingId) {
        return derivedStreamingId;
      }
      const sourceMessages = Array.isArray(messages) ? messages : [];
      for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
        const message = sourceMessages[index];
        if (!message) {
          continue;
        }
        const role = String(message.role || '').trim();
        const kind = String(message.kind || '').trim();
        const status = String(message.status || '').trim();
        if (
          role === 'assistant'
          && status === MESSAGE_STATUS.STREAMING
          && kind !== 'tool_use'
          && kind !== 'question_batch'
          && kind !== 'interactive_round_recap'
          && kind !== 'slash_command_output'
        ) {
          return String(message.id || '').trim();
        }
      }
      return '';
    }

    function buildRecapExpansionSignature(messages, sessionId) {
      const expandedRecapIds = [];
      const sourceMessages = Array.isArray(messages) ? messages : [];
      for (let index = 0; index < sourceMessages.length; index += 1) {
        const message = sourceMessages[index];
        if (!message || String(message.kind || '') !== 'interactive_round_recap') {
          continue;
        }
        const recapModel = buildInteractiveRecapModel(message);
        if (!recapModel || !recapModel.recapId) {
          continue;
        }
        if (isRecapExpandedForSession(recapModel.recapId, sessionId)) {
          expandedRecapIds.push(String(recapModel.recapId));
        }
      }
      expandedRecapIds.sort();
      return expandedRecapIds.join('|');
    }

    return {
      buildProjectionContext,
      resolveProjectedPrimaryRow,
      buildToolEntryInnerMarkup,
      resolveRetryMessageIdForToolRow,
      resolveArticlePredictionCacheKey,
      getMessageFromCollection,
      deriveActionTargetMessageId,
      getForcedOpenStreamingMessageId,
      buildRecapExpansionSignature,
      invalidateProjectionStateForSession: bumpProjectionStateRevision,
    };
  }

  return { createProjectionContextPipeline };
});
