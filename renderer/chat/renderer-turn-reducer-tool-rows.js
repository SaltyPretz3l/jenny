(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnReducerToolRows = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTurnToolRowBuilders(context) {
    const {
      buildBaseRow,
      normalizeId,
      pushDistinct,
      stampRowIdentity,
      normalizeGeneratedArtifact,
      deepCloneJsonValue,
      normalizeToolStatus,
    } = context;

    function appendToolPayloadFromEvent(payload, event) {
      const body = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
      payload.tool_call_id = payload.tool_call_id || normalizeId(event && event.tool_call_id);
      payload.tool_name = payload.tool_name || normalizeId(body.tool_name);
      if (!Object.keys(payload.input).length && body.input && typeof body.input === 'object' && !Array.isArray(body.input)) {
        payload.input = { ...body.input };
      }
      payload.input_json = payload.input_json || String(body.input_json || '');
      payload.summary = payload.summary || String(body.summary || '');
      if (event && event.kind === 'tool_use') {
        // Falls back to the call's summary exactly as the hydrated projector does.
        // Without it the fold left input_summary empty on every tool, and the
        // search index and the timeline's tool label both read it.
        payload.input_summary = payload.input_summary || String(body.input_summary || body.summary || '');
      }
      if (event.kind === 'tool_result') {
        payload.output_text = String(body.output_text || payload.output_text || '');
        payload.result_summary = String(body.summary || payload.result_summary || '');
        payload.generated_artifacts = Array.isArray(body.generated_artifacts)
          ? body.generated_artifacts.map(normalizeGeneratedArtifact).filter(Boolean)
          : [];
        if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
          payload.metadata = deepCloneJsonValue(body.metadata);
        }
        payload.result_is_error = body.is_error === true;
        payload.error_code = normalizeId(body.error_code || payload.error_code);
      }
    }

    // Trace parity (D1): the live reducer emits a tool_call row per call id —
    // shaped like the trace projector's buildToolCallRow — so streaming
    // provisional rows share identity keys (kind|turn|tool_call_id) with the
    // hydrated trace projection. The matching result is a SEPARATE tool_result
    // row (createToolResultRow), mirroring the trace projector's two-row split.
    function createToolCallRow(turn, event) {
      const row = buildBaseRow('tool_call', turn.turn_id, event);
      const toolCallId = normalizeId(event && event.tool_call_id);
      row.tool_call_id = toolCallId;
      row.primary_message_id = normalizeId(event && event.primary_message_id) || `tool_use_${toolCallId}`;
      row.payload = {
        tool_call_id: toolCallId,
        tool_name: '',
        input: {},
        input_json: '',
        summary: '',
        input_summary: '',
        approval_requests: [],
        approval_resolutions: [],
        state: 'requested',
        duplicate_tool_use_count: 0,
      };
      turn.tool_row_index_by_call_id[toolCallId] = turn.rows.length;
      turn.rows.push(row);
      pushDistinct(turn.source_message_ids, row.primary_message_id);
      return stampRowIdentity(turn, row);
    }

    function createToolResultRow(turn, event) {
      const row = buildBaseRow('tool_result', turn.turn_id, event);
      const toolCallId = normalizeId(event && event.tool_call_id);
      row.tool_call_id = toolCallId;
      // Anchor tool results to the real result-message ID, falling back to the tool-use message ID, so article assembly can render the row; use the synthetic ID only as a last resort.
      row.primary_message_id = normalizeId(event && event.tool_result_message_id)
        || normalizeId(event && event.primary_message_id)
        || `tool_result_${toolCallId}`;
      row.payload = {
        tool_call_id: toolCallId,
        tool_name: '',
        output_text: '',
        result_summary: '',
        duration_ms: 0,
        is_error: false,
        result_is_error: false,
        error_code: '',
        generated_artifacts: [],
        state: 'completed',
      };
      turn.tool_result_row_index_by_call_id[toolCallId] = turn.rows.length;
      turn.rows.push(row);
      pushDistinct(turn.source_message_ids, row.primary_message_id);
      return stampRowIdentity(turn, row);
    }

    function populateToolResultRow(row, event) {
      const payload = row.payload;
      const body = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
      payload.tool_call_id = payload.tool_call_id || normalizeId(event && event.tool_call_id);
      payload.tool_name = payload.tool_name || normalizeId(body.tool_name);
      payload.output_text = String(body.output_text || payload.output_text || '');
      payload.result_summary = String(body.summary || payload.result_summary || '');
      const durationMs = Number(body.duration_ms ?? body.durationMs);
      if (Number.isFinite(durationMs) && durationMs > 0) {
        payload.duration_ms = durationMs;
      }
      payload.is_error = body.is_error === true;
      payload.result_is_error = body.is_error === true;
      payload.error_code = normalizeId(body.error_code || payload.error_code);
      payload.generated_artifacts = Array.isArray(body.generated_artifacts)
        ? body.generated_artifacts.map(normalizeGeneratedArtifact).filter(Boolean)
        : [];
      if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
        payload.metadata = deepCloneJsonValue(body.metadata);
      }
      const approvalState = normalizeToolStatus(body.approval_state);
      if (approvalState === 'denied' || approvalState === 'timed_out' || approvalState === 'cancelled') {
        payload.state = approvalState;
      } else {
        payload.state = payload.is_error ? 'errored' : 'completed';
      }
    }

    /* Stamp the wall-clock moment an approval first enters awaiting_approval, ONCE, so the deck can show
       a stable "time since requested" timer. The payload object persists per tool_call_id, so the guard
       keeps it from resetting as later events for the same call arrive. (In-memory only: a full replay
       restamps at replay time — the same accepted limitation as the turn's started_at_ms.) */
    function stampApprovalRequestedAt(payload) {
      if (payload && !payload.approval_requested_at_ms) {
        payload.approval_requested_at_ms = Date.now();
      }
    }

    /* Same contract for the moment a call first starts executing: the running
       row's per-tool elapsed timer ticks from this anchor (see the elapsed-node
       scan in renderer-turn-elapsed-clock). Once, in-memory only. */
    function stampToolRunningStartedAt(payload) {
      if (payload && !payload.running_started_at_ms) {
        payload.running_started_at_ms = Date.now();
      }
    }

    function updateToolRowState(row, event) {
      const payload = row.payload;
      const status = normalizeToolStatus(event && event.status);
      const currentState = normalizeToolStatus(payload.state);
      const isTerminalState = currentState === 'completed'
        || currentState === 'errored'
        || currentState === 'denied'
        || currentState === 'timed_out'
        || currentState === 'cancelled';
      appendToolPayloadFromEvent(payload, event);
      if (event.kind === 'tool_use') {
        if (payload.state !== 'requested') {
          payload.duplicate_tool_use_count += 1;
        }
        if (isTerminalState) {
          return;
        }
        if (status === 'pending_approval') {
          payload.state = 'awaiting_approval';
          stampApprovalRequestedAt(payload);
        } else if (status === 'approved') {
          payload.state = 'approved';
        } else if (status === 'running') {
          payload.state = 'running';
          stampToolRunningStartedAt(payload);
        } else if (status === 'denied') {
          payload.state = 'denied';
        } else if (status === 'timed_out') {
          payload.state = 'timed_out';
        } else if (status === 'cancelled') {
          payload.state = 'cancelled';
        } else if (status) {
          payload.state = status;
          if (status === 'executing') {
            stampToolRunningStartedAt(payload);
          }
        }
        return;
      }
      if (event.kind === 'approval_requested') {
        // Recorded BEFORE the terminal guard, and unconditionally, the way the
        // hydrated projector records it. The guard exists to stop a late event
        // from rewriting a settled state -- it was never meant to suppress the
        // history of how the call was approved, and suppressing it left a row that
        // had been denied unable to say what denied it.
        payload.approval_requests.push({
          status,
          approval_state: normalizeToolStatus(event && event.payload && event.payload.approval_state),
          prompt: String(
            event && event.payload && (
              event.payload.prompt
              || event.payload.message
              || event.payload.summary
            ) || ''
          ),
        });
        if (isTerminalState) {
          return;
        }
        payload.state = 'awaiting_approval';
        stampApprovalRequestedAt(payload);
        return;
      }
      if (event.kind === 'approval_resolved') {
        // Same rule as approval_requested above: history first, state change
        // behind the guard. A tool_use that already arrived `denied` marks the row
        // terminal, so the resolution that followed was dropped entirely and the
        // row could not say HOW it resolved.
        payload.approval_resolutions.push({
          status,
          approval_state: normalizeToolStatus(event && event.payload && event.payload.approval_state),
        });
        if (isTerminalState) {
          return;
        }
        if (status === 'denied' || status === 'timed_out' || status === 'cancelled') {
          payload.state = status;
        } else {
          payload.state = 'approved';
        }
        return;
      }
      if (event.kind === 'tool_executing') {
        if (isTerminalState) {
          return;
        }
        // An approval the user has not answered outranks an execution notice.
        // The backend cannot actually produce this order: both emitters of
        // tool_executing (services/backend/tool-loop.js and
        // chat-stream-tool-handling.js) either never requested approval, or send
        // approval_resolved first and only execute when it came back approved. So
        // this guard is inert on every real stream and fires only on one that lost
        // its resolution -- where falling to 'running' would retract the Allow/Deny
        // block and leave the turn with no way to approve the tool it is still
        // blocked on. The hydrated projector already resolves the contradiction
        // this way; matching it here removes the last live-vs-hydrated divergence.
        if (payload.approval_requests.length > payload.approval_resolutions.length) {
          return;
        }
        payload.state = 'running';
        return;
      }
      if (event.kind === 'tool_result') {
        const resultApprovalState = normalizeToolStatus(event && event.payload && event.payload.approval_state);
        if (resultApprovalState === 'denied' || resultApprovalState === 'timed_out' || resultApprovalState === 'cancelled') {
          payload.state = resultApprovalState;
        } else {
          payload.state = payload.result_is_error ? 'errored' : 'completed';
        }
      }
    }

    return {
      createToolCallRow,
      createToolResultRow,
      populateToolResultRow,
      stampApprovalRequestedAt,
      stampToolRunningStartedAt,
      updateToolRowState,
    };
  }

  return { createTurnToolRowBuilders };
});
