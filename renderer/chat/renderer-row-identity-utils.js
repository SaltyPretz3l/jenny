/* renderer/chat/renderer-row-identity-utils.js
 * Shared row-identity module — the ONE source of truth for how a timeline row's
 * identity is derived, so the live reducer and the hydrated projector cannot
 * drift apart (flicker RCA defect class DC1).
 *
 * Exports:
 *   - deriveDeterministicRowId(row, fallbackRowId): the identity-tuple row_id
 *     (flag-gated). Because it is a PURE function of a row's stable identity
 *     tuple and is called from BOTH the reducer and the projector, the same
 *     logical row carries the same `row_id` (hence the same DOM data-row-id)
 *     across the live -> reconciled -> canonical handoffs, so the already-painted
 *     node is reused in place instead of being removed-and-reinserted (a blink).
 *   - stampDeterministicRowId(row, enabled): in-place stamp helper (no-op /
 *     byte-identical when disabled).
 *   - buildRowIdentityKey(row, options): the reconcile identity key. Under the
 *     deterministic-row_id flag it returns the row_id itself, so reconcile's
 *     first pass matches structurally; without the flag it returns the legacy
 *     slice-scoped tuple key (byte-identical).
 *   - reconcileTurnRows(provisional, hydrated, options): the live -> canonical
 *     merge. Moved here (from renderer-turn-reducer.js) so identity + reconcile
 *     live in one module — this collapses the "three paths must agree" hazard
 *     into a single definition and relieves the reducer's 1015-line cap.
 *
 * Reasoning anchors on `phase_id` when available because a provider generation
 * may legally emit multiple reasoning phases around visible text. Those phases
 * share a `thinking_id` but retain distinct phase identities. Legacy rows that
 * lack the phase envelope fall back to `thinking_id`.
 *
 * Pure factory — no module-scope mutable state. UMD.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-turn-normalization-utils'));
    return;
  }
  root.rendererRowIdentityUtils = factory(root.rendererTurnNormalizationUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnNormalizationUtils) {
  'use strict';

  const normalizeId = typeof (turnNormalizationUtils && turnNormalizationUtils.normalizeId) === 'function'
    ? turnNormalizationUtils.normalizeId
    : function fallbackNormalizeId(value) { return String(value || '').trim(); };

  // Deterministic row_id per kind. The fallback (no tuple / empty keyed field)
  // is `fallbackRowId` — prefer the row's existing id (an upstream-stamped
  // `event.row_id` if one is ever added, else today's `row:${event_id}`), so an
  // id is never lost and a future upstream stamp (approach A) drops in with no
  // rework. Any kind not enumerated here keeps its fallback id, so flag-on is
  // byte-identical for everything except the five DC1-affected kinds.
  function deriveDeterministicRowId(row, fallbackRowId) {
    const fallback = normalizeId(fallbackRowId) || normalizeId(row && row.row_id);
    if (!row || typeof row !== 'object') {
      return fallback;
    }
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const kind = normalizeId(row.kind);
    const turnId = normalizeId(row.turn_id);
    if (kind === 'reasoning') {
      // phase_id distinguishes multiple reasoning phases inside one generation;
      // thinking_id remains the compatibility anchor for legacy phase-less rows.
      const anchor = normalizeId(row.phase_id || payload.phase_id)
        || normalizeId(row.thinking_id || payload.thinking_id);
      return anchor ? `row:reasoning:${turnId}:${anchor}` : fallback;
    }
    if (kind === 'assistant_text') {
      const seg = row.segment_group_index != null ? row.segment_group_index : payload.segment_group_index;
      if (seg == null || seg === '') {
        return fallback;
      }
      return `row:assistant_text:${turnId}:${Number(seg) || 0}`;
    }
    if (kind === 'plan_document') {
      const anchor = normalizeId(payload.plan_id) || normalizeId(payload.tool_call_id);
      return anchor ? `row:plan_document:${turnId}:${anchor}` : fallback;
    }
    if (kind === 'tool_call' || kind === 'tool_result' || kind === 'approval_gap' || kind === 'tool_step') {
      const callId = normalizeId(row.tool_call_id || payload.tool_call_id);
      return callId ? `row:${kind}:${turnId}:${callId}` : fallback;
    }
    return fallback;
  }

  // Stamp a row's deterministic row_id in place when the reducer/projector opted
  // in. Returns the row for chaining. Strictly a no-op (byte-identical) when
  // `enabled` is not true.
  function stampDeterministicRowId(row, enabled) {
    if (enabled === true && row && typeof row === 'object') {
      row.row_id = deriveDeterministicRowId(row, row.row_id);
    }
    return row;
  }

  // Stamp deterministic row_ids across a whole row array, disambiguating any
  // in-turn collision (two rows that derive the SAME id). This is the projector's
  // stamp entry point: the projector groups reasoning by CONTIGUOUS phase_id, so
  // a turn whose backend reuses one (phase_id, thinking_id) across a tool call —
  // a documented approval-resume case (services/backend/canonical-turn-event-
  // collector.js, reasoning mis-retargeting RCA 2026-07-06) — splits into two
  // reasoning rows that both anchor on that thinking_id. A duplicated tool event
  // (distinct event_id, same call id) is the same hazard for tool rows. Left
  // un-disambiguated those would share a DOM data-row-id under flag-on.
  //
  // The FIRST occurrence keeps the bare id so it matches the first live row in
  // reconcile's first pass. Later contiguous instances get a deterministic `#N`
  // suffix by order of appearance; the live reducer applies the same counting
  // rule when a tool/text boundary reuses an id. Row order is deterministic
  // (events are sorted before projection), so the suffix is stable across
  // re-projections. deriveDeterministicRowId reads the tuple fields, not the
  // current row_id, so re-running over already-stamped rows recomputes the same
  // base and re-derives the same suffixes (idempotent).
  // Strictly a no-op (byte-identical) when `enabled` is not true.
  function stampDeterministicRowIds(rows, enabled) {
    if (enabled !== true || !Array.isArray(rows)) {
      return rows;
    }
    const seenBaseIds = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || typeof row !== 'object') {
        continue;
      }
      const baseId = deriveDeterministicRowId(row, row.row_id);
      const priorCount = seenBaseIds.get(baseId) || 0;
      row.row_id = priorCount === 0 ? baseId : `${baseId}#${priorCount}`;
      seenBaseIds.set(baseId, priorCount + 1);
    }
    return rows;
  }

  // Tombstone one row OUT of the canonical identity space this module defines,
  // for rows a DISCARDING stream_reset erased from the transcript (main deleted
  // both their persisted messages and their captured turn events, so the
  // hydrated projector renumbers the surviving post-reset text from group index
  // 0). Left in place, a discarded assistant_text row at group index 0 matches
  // the canonical post-reset row in reconcile's first pass — the canonical text
  // merges into the truncated row and the live post-reset row survives as a
  // stale duplicate (the double paint). The row itself stays visible with its
  // payload.truncated "restarted" marker; only its identity changes.
  //
  // `ordinal` (1-based, per turn) makes each tombstone distinct: the group index
  // becomes -ordinal — a value the projector never mints, so it can never match
  // a hydrated row, and two discarded rows cannot collide with each other under
  // the legacy tuple key either. Under the deterministic-row_id flag the row_id
  // is re-derived from the row's CURRENT (already unique) id plus a ':discarded'
  // suffix, counted through the same collision map stampDeterministicRowIds
  // uses. Flag-off leaves row_id alone (it is already `row:${event_id}`).
  function tombstoneRowIdentity(row, options) {
    if (!row || typeof row !== 'object') {
      return row;
    }
    const settings = options && typeof options === 'object' ? options : {};
    const ordinal = Math.max(1, Number(settings.ordinal) || 1);
    const counts = settings.counts && typeof settings.counts === 'object' ? settings.counts : null;
    // RELEASE the row's canonical base id back to the turn's collision map
    // before mutating its tuple. Without this the surviving post-reset row
    // re-derives the SAME base (group index 0 again), sees the discarded row's
    // count, and is stamped `...:0#1` — which no hydrated row ever carries, so
    // reconcile's first pass misses and the duplicate returns by another route.
    const releasedBaseId = counts ? deriveDeterministicRowId(row, row.row_id) : '';
    if (releasedBaseId && Number(counts[releasedBaseId] || 0) > 0) {
      const remaining = Number(counts[releasedBaseId]) - 1;
      if (remaining > 0) counts[releasedBaseId] = remaining;
      else delete counts[releasedBaseId];
    }
    row.discarded = true;
    if (row.payload && typeof row.payload === 'object') {
      row.payload.discarded = true;
    }
    if (normalizeId(row.kind) === 'assistant_text') {
      row.segment_group_index = -ordinal;
      if (row.payload && typeof row.payload === 'object') {
        row.payload.segment_group_index = row.segment_group_index;
      }
    }
    if (settings.deterministicRowId === true) {
      const baseId = `${normalizeId(row.row_id)}:discarded`;
      const priorCount = counts ? Number(counts[baseId] || 0) : 0;
      row.row_id = priorCount === 0 ? baseId : `${baseId}#${priorCount}`;
      if (counts) {
        counts[baseId] = priorCount + 1;
      }
    }
    return row;
  }

  // --- stream_reset row bookkeeping -----------------------------------------
  // Pure functions over a live reducer `turn`, hosted here (not in
  // renderer-turn-reducer.js) because that file is at the 1015-line modularity
  // cap. The reducer owns WHEN they run; they own the identity arithmetic.

  const STREAM_RESET_DISCARD_SCOPES = new Set(['all', 'live_slice', 'none']);
  // Legacy fallback only — the reason set main used before it published
  // `discard_scope`. Keeps an older main byte-identical: neither reason
  // tombstoned anything.
  const LEGACY_STREAM_RESET_PRESERVE_REASONS = new Set(['tool_continuation', 'model_winddown']);

  // What the reset erased, as main decided it. Main is the authority and the
  // renderer must never re-derive it from `reason`: the tool_continuation
  // preserve is gated on response_loop_display_v2 (flag off => main discards
  // EVERYTHING under that same reason), and model_winddown preserves the
  // persisted segments while erasing the unsaved live slice.
  function resolveStreamResetDiscardScope(event) {
    const scope = normalizeId(event && event.discard_scope);
    if (STREAM_RESET_DISCARD_SCOPES.has(scope)) {
      return scope;
    }
    const preserve = event && event.preserve_prior_segments;
    if (typeof preserve === 'boolean') {
      if (!preserve) return 'all';
      return normalizeId(event && event.reason) === 'model_winddown' ? 'live_slice' : 'none';
    }
    return LEGACY_STREAM_RESET_PRESERVE_REASONS.has(normalizeId(event && event.reason)) ? 'none' : 'all';
  }

  // Apply one stream_reset to the turn's assistant rows:
  //   * tombstone the rows the reset erased (scope 'all' => every assistant_text
  //     / reasoning row; 'live_slice' => only the rows of the still-active
  //     assistant message id, which is exactly the slice main dropped from its
  //     captured events; 'none' => nothing),
  //   * ALWAYS release the active id from the row lookup, so post-reset text
  //     opens a FRESH row even when main hands back the very same
  //     next_assistant_message_id (model_winddown after a tool boundary does:
  //     its textSegmentIndex has not advanced, so without this the wind-down
  //     answer appended into the row it just abandoned), and
  //   * restate next_assistant_segment_index as the number of SURVIVING
  //     assistant_text rows — the same number the hydrated projector will count
  //     when it renumbers the persisted segments from 0.
  function applyStreamResetToTurnRows(turn, options) {
    const settings = options && typeof options === 'object' ? options : {};
    const scope = STREAM_RESET_DISCARD_SCOPES.has(normalizeId(settings.scope))
      ? normalizeId(settings.scope)
      : 'all';
    const activeAssistantMessageId = normalizeId(settings.activeAssistantMessageId);
    const deterministicRowId = settings.deterministicRowId === true;
    const rows = turn && Array.isArray(turn.rows) ? turn.rows : [];
    const assistantRowIndexes = (turn && turn.assistant_row_index_by_message_id) || null;
    const reasoningRowIndexes = (turn && turn.reasoning_row_index_by_phase_id) || null;
    let discardedRowCount = 0;
    let survivingTextRowCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      const kind = normalizeId(row.kind);
      const isText = kind === 'assistant_text';
      if (!isText && kind !== 'reasoning') continue;
      if (row.discarded === true) continue;
      const inScope = scope === 'all'
        || (
          scope === 'live_slice'
          && activeAssistantMessageId
          && normalizeId(row.primary_message_id) === activeAssistantMessageId
        );
      if (!inScope) {
        if (isText) survivingTextRowCount += 1;
        continue;
      }
      if (isText) {
        turn.discarded_text_seq = (Number(turn.discarded_text_seq) || 0) + 1;
      }
      tombstoneRowIdentity(row, {
        ordinal: isText ? turn.discarded_text_seq : 0,
        deterministicRowId,
        counts: turn.deterministic_row_id_counts_by_base,
      });
      discardedRowCount += 1;
      // Drop the lookups so a post-reset delta cannot append into a truncated
      // row (main may reuse the pre-reset message id, or a resumed phase_id).
      if (assistantRowIndexes && assistantRowIndexes[row.primary_message_id] === index) {
        delete assistantRowIndexes[row.primary_message_id];
      }
      if (reasoningRowIndexes && row.phase_id && reasoningRowIndexes[row.phase_id] === index) {
        delete reasoningRowIndexes[row.phase_id];
      }
    }
    if (assistantRowIndexes && activeAssistantMessageId) {
      delete assistantRowIndexes[activeAssistantMessageId];
    }
    if (turn) {
      turn.next_assistant_segment_index = survivingTextRowCount;
    }
    return { scope, discardedRowCount, survivingTextRowCount };
  }

  function buildRowIdentityKey(row, options) {
    // Under the deterministic-row_id flag the row_id IS the identity tuple, so
    // reconcile keys on it directly and the first pass matches structurally
    // (no drift to recover). Flag-off keeps the legacy slice-scoped tuple key.
    if (options && options.deterministicRowId === true) {
      return normalizeId(row && row.row_id);
    }
    const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
    const kind = normalizeId(row && row.kind);
    const primaryMessageId = normalizeId(row && row.primary_message_id);
    const turnId = normalizeId(row && row.turn_id);
    if (kind === 'user_bubble') {
      return `user_bubble|${primaryMessageId}`;
    }
    if (kind === 'reasoning') {
      return `reasoning|${turnId}|${normalizeId(row && row.phase_id || payload.phase_id)}`;
    }
    if (kind === 'assistant_text') {
      return `assistant_text|${turnId}|${String(row && row.segment_group_index != null ? row.segment_group_index : payload.segment_group_index || 0)}`;
    }
    if (kind === 'plan_document') {
      return `plan_document|${turnId}|${normalizeId(payload.plan_id) || normalizeId(payload.tool_call_id)}`;
    }
    // Trace parity (D1): tool_call / tool_result / approval_gap rows reconcile
    // by call id so a streaming provisional row matches its hydrated trace
    // counterpart (which carries a different row_id). tool_step is retained for
    // back-compat with any legacy provisional rows.
    if (kind === 'tool_step' || kind === 'tool_call' || kind === 'tool_result' || kind === 'approval_gap') {
      return `${kind}|${turnId}|${normalizeId(row && row.tool_call_id || payload.tool_call_id)}`;
    }
    if (kind === 'batch' || kind === 'recap' || kind === 'suggestion' || kind === 'slash_output' || kind === 'attachment') {
      return `${kind}|${primaryMessageId}`;
    }
    if (kind === 'system_notice') {
      return `system_notice|${primaryMessageId}|${normalizeId(payload.subkind)}`;
    }
    return `${kind}|${primaryMessageId}|${normalizeId(row && row.row_id)}`;
  }

  // Tool-call lifecycle states the LIVE reducer only reaches after observing a
  // real terminal signal for the call (tool_result / denial / cancellation).
  // A hydrated 'interrupted' must not downgrade these: it means the persisted
  // event log is lagging the stream at the terminal boundary, not that the
  // call died. Transient states (running/pending/approved/...) are NOT here —
  // for those a hydrated 'interrupted' at reconcile time is the truth (the
  // turn ended and the call never finished).
  const SETTLED_PROVISIONAL_TOOL_STATES = new Set([
    'completed', 'errored', 'failed', 'denied', 'timed_out', 'cancelled',
  ]);

  // Adopting the provisional row_id keeps the already-painted DOM node keyed
  // alive across the live->canonical handoff. Canonical payloads win, except a
  // canonical 'interrupted' tool state must not downgrade a provisional row
  // that already settled (the tool_result event can lag persistence at the
  // terminal boundary — the tool succeeded, the log just hasn't caught up).
  function mergeReconciledRow(hydratedRow, provisionalRow) {
    const merged = {
      ...hydratedRow,
      row_id: provisionalRow.row_id,
    };
    const hydratedPayload = hydratedRow && hydratedRow.payload && typeof hydratedRow.payload === 'object'
      ? hydratedRow.payload
      : null;
    const provisionalState = normalizeId(
      provisionalRow && provisionalRow.payload && provisionalRow.payload.state
    );
    if (
      normalizeId(hydratedRow && hydratedRow.kind) === 'tool_call'
      && hydratedPayload
      && normalizeId(hydratedPayload.state) === 'interrupted'
      && SETTLED_PROVISIONAL_TOOL_STATES.has(provisionalState)
    ) {
      merged.payload = { ...hydratedPayload, state: provisionalRow.payload.state };
    }
    return merged;
  }

  function reconcileTurnRows(provisionalRows, hydratedRows, options) {
    const keyOptions = options && options.deterministicRowId === true
      ? { deterministicRowId: true }
      : undefined;
    const provisional = Array.isArray(provisionalRows) ? provisionalRows : [];
    const hydrated = Array.isArray(hydratedRows) ? hydratedRows : [];
    const provisionalByKey = new Map();
    for (let index = 0; index < provisional.length; index += 1) {
      const row = provisional[index];
      provisionalByKey.set(buildRowIdentityKey(row, keyOptions), row);
    }
    const finalRows = [];
    const unmatchedHydratedIndexes = [];
    for (let index = 0; index < hydrated.length; index += 1) {
      const hydratedRow = hydrated[index];
      const key = buildRowIdentityKey(hydratedRow, keyOptions);
      const provisionalRow = provisionalByKey.get(key);
      if (provisionalRow) {
        finalRows.push(mergeReconciledRow(hydratedRow, provisionalRow));
        provisionalByKey.delete(key);
        continue;
      }
      unmatchedHydratedIndexes.push(finalRows.length);
      finalRows.push({ ...hydratedRow });
    }
    // Second pass: a provisional row whose identity key drifted from its
    // hydrated counterpart (e.g. a reasoning row keyed by the delta's
    // thinkingId while the persisted event carries the sidecar phase_id)
    // would otherwise be deleted while a new-identity hydrated row is
    // inserted — a visible remove/insert blink at the terminal handoff.
    // Pair leftover provisional rows with unmatched hydrated rows of the
    // same kind, in order, so the hydrated row adopts the provisional
    // row_id and the DOM node is reused in place.
    //
    // Under the deterministic-row_id flag the first pass already keys on the
    // shared row_id, so this pass should be inert; secondPassMatches is
    // returned so the caller can telemeter any residual fire (goal: zero)
    // before this net is ever retired.
    const secondPassMatches = [];
    if (provisionalByKey.size > 0 && unmatchedHydratedIndexes.length > 0) {
      for (const [key, provisionalRow] of Array.from(provisionalByKey.entries())) {
        const provisionalKind = normalizeId(provisionalRow && provisionalRow.kind);
        if (!provisionalKind) {
          continue;
        }
        // A tombstoned row was deliberately taken OUT of the identity space
        // (tombstoneRowIdentity) because main erased its content. This
        // drift-recovery net must not hand it back: pairing it with an
        // unmatched hydrated row would let the discarded row adopt canonical
        // text — the exact double paint the tombstone prevents.
        if (provisionalRow.discarded === true) {
          continue;
        }
        const provisionalCallId = normalizeId(
          provisionalRow && (provisionalRow.tool_call_id
            || (provisionalRow.payload && provisionalRow.payload.tool_call_id))
        );
        for (let slot = 0; slot < unmatchedHydratedIndexes.length; slot += 1) {
          const finalIndex = unmatchedHydratedIndexes[slot];
          const hydratedRow = finalRows[finalIndex];
          if (normalizeId(hydratedRow && hydratedRow.kind) !== provisionalKind) {
            continue;
          }
          const hydratedCallId = normalizeId(
            hydratedRow && (hydratedRow.tool_call_id
              || (hydratedRow.payload && hydratedRow.payload.tool_call_id))
          );
          // Tool-scoped kinds must only pair within the same call.
          if ((provisionalCallId || hydratedCallId) && provisionalCallId !== hydratedCallId) {
            continue;
          }
          finalRows[finalIndex] = mergeReconciledRow(hydratedRow, provisionalRow);
          unmatchedHydratedIndexes.splice(slot, 1);
          provisionalByKey.delete(key);
          secondPassMatches.push({
            key,
            kind: provisionalKind,
            row_id: normalizeId(provisionalRow && provisionalRow.row_id),
          });
          break;
        }
      }
    }
    return {
      finalRows,
      staleRows: Array.from(provisionalByKey.values()),
      secondPassMatches,
    };
  }

  return {
    deriveDeterministicRowId,
    stampDeterministicRowId,
    stampDeterministicRowIds,
    tombstoneRowIdentity,
    resolveStreamResetDiscardScope,
    applyStreamResetToTurnRows,
    STREAM_RESET_DISCARD_SCOPES,
    buildRowIdentityKey,
    mergeReconciledRow,
    reconcileTurnRows,
    SETTLED_PROVISIONAL_TOOL_STATES,
  };
});
