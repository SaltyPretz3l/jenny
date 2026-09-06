/* renderer/chat/renderer-turn-reducer-approval-gap.js
 * Sibling factory for renderer-turn-reducer.js: owns the streaming reducer's
 * standalone `approval_gap` row lifecycle (create / get / remove / sync).
 *
 * SHARED INVARIANT (kept in lockstep with renderer-turn-row-projector-tools.js
 * ::buildApprovalGapRow): an `approval_gap` row exists IFF the call is awaiting
 * approval and unresolved. The payload shape mirrors that builder — tool_call_id
 * / prompt / status / state always; tool_name / tool_display_name only when known
 * — plus an additive `approval_id` so the live Allow/Deny buttons target the exact
 * approval. The `22-approval-pending` corpus scenario enforces presence parity.
 *
 * Pure factory — no module-scope mutable state. It consumes the parent reducer's
 * row/normalization helpers via `deps` and operates on the `turn` passed in.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnReducerApprovalGap = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTurnReducerApprovalGapUtils(deps) {
    const {
      buildBaseRow,
      normalizeId,
      pushDistinct,
      ensureRowEvent,
      normalizeToolStatus,
      // DC1 flicker cure: stamps the deterministic row_id when the turn opted
      // in. Optional so older wirings/tests without it stay byte-identical.
      stampRowIdentity = (turn, row) => row,
    } = deps || {};

    if (typeof buildBaseRow !== 'function'
      || typeof normalizeId !== 'function'
      || typeof pushDistinct !== 'function'
      || typeof ensureRowEvent !== 'function'
      || typeof normalizeToolStatus !== 'function') {
      throw new Error('renderer-turn-reducer-approval-gap: required deps missing');
    }

    function isPlainInput(value) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length > 0;
    }

    // The full `input` object is what the card previews; `input_json` is the
    // capped serialization kept for older rows. Either source may arrive
    // first (the approval event can beat the tool_use event), so this runs
    // on creation and again on every sync until both are present.
    function copyApprovalInput(target, ...sources) {
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index] && typeof sources[index] === 'object' ? sources[index] : {};
        if (!isPlainInput(target.input) && isPlainInput(source.input)) {
          target.input = source.input;
        }
        const inputJson = String(source.input_json || '').trim();
        if (!target.input_json && inputJson) {
          target.input_json = inputJson;
        }
      }
    }

    function createApprovalGapRow(turn, event) {
      const row = buildBaseRow('approval_gap', turn.turn_id, event);
      const toolCallId = normalizeId(event && event.tool_call_id);
      row.tool_call_id = toolCallId;
      const callRowIndex = toolCallId ? turn.tool_row_index_by_call_id[toolCallId] : undefined;
      const callRow = Number.isInteger(callRowIndex) && callRowIndex >= 0 && callRowIndex < turn.rows.length
        ? turn.rows[callRowIndex]
        : null;
      const callPayload = callRow && callRow.payload && typeof callRow.payload === 'object' ? callRow.payload : {};
      // Anchor to the tool_call row's own message id so the gap row is guaranteed
      // to bucket into the same rendered article — even if a standalone
      // tool_approval_needed event carried a divergent primary id. Falls back to
      // the event's id / synthetic id when the tool_call row isn't tracked yet.
      // (Live rows have no render_message_id; bucketing is by primary_message_id —
      // see createToolResultRow's note on synthetic ids.)
      row.primary_message_id = (callRow && normalizeId(callRow.primary_message_id))
        || normalizeId(event && event.primary_message_id)
        || `tool_use_${toolCallId}`;
      const body = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
      const payload = {
        tool_call_id: toolCallId,
        // The hydrated gap row derives its prompt from the canonical event's
        // prompt/message/summary; live, the tool_call row already carries `summary`,
        // so live ≈ hydrated. Empty falls back to renderApprovalBlock's default.
        prompt: String(body.prompt || body.message || body.summary || callPayload.summary || ''),
        // Mirror the projector's status derivation (normalize(event.status) || 'pending')
        // so the live and hydrated gap rows agree — they otherwise drift to
        // 'pending' vs 'pending_approval'.
        status: normalizeToolStatus(event && event.status) || 'pending',
        state: 'awaiting_approval',
      };
      const initialPolicyScope = String(body.policy_scope || body.policyScope || callPayload.policy_scope || '').trim();
      const initialPolicyConsequence = String(body.policy_consequence || body.policyConsequence || callPayload.policy_consequence || '').trim();
      const initialReason = String(body.reason || callPayload.reason || '').trim();
      if (initialPolicyScope) payload.policy_scope = initialPolicyScope;
      if (initialPolicyConsequence) payload.policy_consequence = initialPolicyConsequence;
      if (initialReason) payload.reason = initialReason;
      const toolName = normalizeId(body.tool_name) || normalizeId(callPayload.tool_name);
      if (toolName) {
        payload.tool_name = toolName;
      }
      const displayName = normalizeId(body.tool_display_name) || normalizeId(callPayload.tool_display_name);
      if (displayName) {
        payload.tool_display_name = displayName;
      }
      // Mirror the hydrated projector: the approval card quotes the exact
      // command/args being approved, sourced from the call's input.
      copyApprovalInput(payload, body, callPayload);
      const approvalId = normalizeId(body.approval_id || body.approvalId);
      if (approvalId) {
        payload.approval_id = approvalId;
      }
      // Mirror the hydrated projector's plan-variant stamp so the live and
      // canonical gap rows render the same buttonless plan variant.
      const approvalVariant = normalizeId(body.approval_variant);
      if (approvalVariant) {
        payload.approval_variant = approvalVariant;
      }
      row.payload = payload;
      turn.approval_gap_row_index_by_call_id[toolCallId] = turn.rows.length;
      turn.rows.push(row);
      pushDistinct(turn.source_message_ids, row.primary_message_id);
      return stampRowIdentity(turn, row);
    }

    function getApprovalGapRow(turn, event) {
      const toolCallId = normalizeId(event && event.tool_call_id);
      const rowIndex = toolCallId ? turn.approval_gap_row_index_by_call_id[toolCallId] : undefined;
      if (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < turn.rows.length) {
        const existing = turn.rows[rowIndex];
        if (existing && existing.kind === 'approval_gap') {
          return existing;
        }
      }
      return createApprovalGapRow(turn, event);
    }

    // Splicing a row out of turn.rows shifts every later row down by one, so each
    // row-index map (and last_tool_position) must drop entries that pointed past
    // the removed slot. Removal is rare (once per resolved approval), so the
    // O(rows) repair is acceptable.
    function shiftRowIndexMapsAfterRemoval(turn, removedIndex) {
      const maps = [
        turn.assistant_row_index_by_message_id,
        turn.reasoning_row_index_by_phase_id,
        turn.tool_row_index_by_call_id,
        turn.tool_result_row_index_by_call_id,
        turn.approval_gap_row_index_by_call_id,
      ];
      for (let mapIndex = 0; mapIndex < maps.length; mapIndex += 1) {
        const map = maps[mapIndex];
        if (!map) {
          continue;
        }
        const keys = Object.keys(map);
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex];
          if (map[key] > removedIndex) {
            map[key] -= 1;
          }
        }
      }
      if (Number.isInteger(turn.last_tool_position) && turn.last_tool_position > removedIndex) {
        turn.last_tool_position -= 1;
      }
    }

    function removeApprovalGapRow(turn, callId) {
      const normalizedCallId = normalizeId(callId);
      if (!normalizedCallId) {
        return;
      }
      const rowIndex = turn.approval_gap_row_index_by_call_id[normalizedCallId];
      if (!Number.isInteger(rowIndex)) {
        // No gap row tracked for this call — the common path on every
        // non-approval tool event. Return without touching the map so the
        // hot path does no work.
        return;
      }
      if (rowIndex < 0
        || rowIndex >= turn.rows.length
        || !turn.rows[rowIndex]
        || turn.rows[rowIndex].kind !== 'approval_gap') {
        // Defensive: a tracked index that no longer points at a gap row.
        delete turn.approval_gap_row_index_by_call_id[normalizedCallId];
        return;
      }
      turn.rows.splice(rowIndex, 1);
      delete turn.approval_gap_row_index_by_call_id[normalizedCallId];
      shiftRowIndexMapsAfterRemoval(turn, rowIndex);
    }

    // Drive the gap row off the tool_call row's resolved state: present while
    // awaiting_approval, gone once the call resolves (approved / running / denied /
    // timed_out / cancelled / completed / errored / abandoned) — matching the
    // projector's suppression rule (!hasApprovalResolution && !hasToolResult).
    function syncApprovalGapRow(turn, event, toolCallRow) {
      const callId = normalizeId(event && event.tool_call_id);
      if (!callId) {
        return;
      }
      const state = normalizeToolStatus(toolCallRow && toolCallRow.payload && toolCallRow.payload.state);
      if (state !== 'awaiting_approval') {
        removeApprovalGapRow(turn, callId);
        return;
      }
      const gapRow = getApprovalGapRow(turn, event);
      ensureRowEvent(gapRow, event);
      const body = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
      const approvalId = normalizeId(body.approval_id || body.approvalId);
      if (approvalId && !gapRow.payload.approval_id) {
        gapRow.payload.approval_id = approvalId;
      }
      const prompt = String(body.prompt || body.message || body.summary || '');
      if (prompt && !gapRow.payload.prompt) {
        gapRow.payload.prompt = prompt;
      }
      const policyScope = String(body.policy_scope || body.policyScope || '');
      const policyConsequence = String(body.policy_consequence || body.policyConsequence || '');
      const reason = String(body.reason || '');
      const callPayload = toolCallRow && toolCallRow.payload && typeof toolCallRow.payload === 'object'
        ? toolCallRow.payload : {};
      // A gap row created from an approval that beat its tool_use event has
      // no tool name yet; take it from whichever event brings it.
      if (!gapRow.payload.tool_name) {
        const toolName = normalizeId(body.tool_name) || normalizeId(callPayload.tool_name);
        if (toolName) gapRow.payload.tool_name = toolName;
      }
      if (!gapRow.payload.tool_display_name) {
        const displayName = normalizeId(body.tool_display_name) || normalizeId(callPayload.tool_display_name);
        if (displayName) gapRow.payload.tool_display_name = displayName;
      }
      copyApprovalInput(gapRow.payload, body, callPayload);
      if (policyScope) {
        gapRow.payload.policy_scope = policyScope;
      }
      if (policyConsequence) {
        gapRow.payload.policy_consequence = policyConsequence;
      }
      if (reason) {
        gapRow.payload.reason = reason;
      }
      // The plan variant usually arrives on the tool_approval_needed event
      // AFTER the pending tool_use created the gap row — stamp it on sync too
      // (lockstep with the hydrated projector's plan-variant stamp).
      const approvalVariant = normalizeId(body.approval_variant);
      if (approvalVariant && !gapRow.payload.approval_variant) {
        gapRow.payload.approval_variant = approvalVariant;
      }
      if (!gapRow.payload.tool_name && toolCallRow && toolCallRow.payload && toolCallRow.payload.tool_name) {
        gapRow.payload.tool_name = normalizeId(toolCallRow.payload.tool_name);
      }
      pushDistinct(turn.source_message_ids, gapRow.primary_message_id);
    }

    // Only the two lifecycle entry points are public; createApprovalGapRow /
    // getApprovalGapRow stay inner closures (no external callers).
    return {
      removeApprovalGapRow,
      syncApprovalGapRow,
    };
  }

  return { createTurnReducerApprovalGapUtils };
});
