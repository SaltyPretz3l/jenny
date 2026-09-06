/* renderer/chat/renderer-turn-row-projector-tools.js
 * C4b sibling factory for renderer-turn-row-projector.js: owns the
 * tool-cluster row builders (tool_call / approval_gap / tool_result).
 * Extracted to bring the projector under the 1015-line modularity cap.
 *
 * Pure factory — no module-scope mutable state. The four builders all
 * consume the parent module's `createBaseRow` and the shared
 * projector-utils helpers, both passed in via `deps`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowProjectorTools = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTurnRowProjectorTools(deps) {
    const {
      createBaseRow,
      normalizeId,
      normalizeGeneratedArtifact,
      normalizeToolLifecycleStatus,
      clonePlainObject,
      statusForToolResult,
    } = deps || {};

    if (typeof createBaseRow !== 'function') {
      throw new Error('renderer-turn-row-projector-tools: createBaseRow dep is required');
    }
    if (typeof normalizeId !== 'function') {
      throw new Error('renderer-turn-row-projector-tools: normalizeId dep is required');
    }

    function buildToolCallRow(turnId, events, toolCallId, context) {
      const row = createBaseRow('tool_call', turnId, events);
      const payload = {
        tool_call_id: normalizeId(toolCallId),
        tool_name: '',
        input: {},
        input_json: '',
        summary: '',
        input_summary: '',
        state: 'requested',
        approval_requests: [],
        approval_resolutions: [],
      };
      // Trace mode renders the tool_result as its own row, so the matching
      // result event is threaded in via context (never added to this row's
      // source events). We consume it for state derivation only, so a settled
      // call reconciles to a terminal state instead of remaining stuck on
      // 'running' when canonical enrichment is bypassed (for example a tool
      // whose call_id never round-tripped).
      const resultEvent = context && context.resultEvent ? context.resultEvent : null;
      // When a standalone approval_gap row is emitted, its approval_requested
      // event is withheld from THIS row's source events (the source-event
      // partition), so the `approval_requests.length` fallback below cannot see
      // it. The projector passes `awaitingApproval` so this row still derives
      // `awaiting_approval` even when the tool_use status is stale/absent.
      const awaitingApproval = Boolean(context && context.awaitingApproval);
      const resultPayload = resultEvent && resultEvent.payload && typeof resultEvent.payload === 'object'
        ? resultEvent.payload
        : null;
      const hasResult = Boolean(resultEvent);
      const resultStatus = hasResult && typeof statusForToolResult === 'function'
        ? statusForToolResult(resultPayload)
        : (resultPayload && resultPayload.is_error === true ? 'errored' : 'completed');
      const resultApprovalStatus = normalizeToolLifecycleStatus(resultPayload && resultPayload.approval_state);
      let toolUseStatus = '';
      let hasExecuting = false;
      for (const event of events) {
        if (event.kind === 'tool_use') {
          toolUseStatus = normalizeToolLifecycleStatus(event.status);
          payload.tool_name = payload.tool_name || normalizeId(event.payload && event.payload.tool_name);
          payload.input_json = payload.input_json || String(event.payload && event.payload.input_json || '');
          payload.summary = payload.summary || String(event.payload && event.payload.summary || '');
          payload.input_summary = payload.input_summary || String(event.payload && event.payload.input_summary || event.payload && event.payload.summary || '');
          if (!Object.keys(payload.input).length && event.payload && typeof event.payload.input === 'object' && !Array.isArray(event.payload.input)) {
            payload.input = clonePlainObject(event.payload.input);
          }
        } else if (event.kind === 'approval_requested') {
          payload.approval_requests.push({
            status: normalizeToolLifecycleStatus(event.status),
            approval_state: normalizeToolLifecycleStatus(event.payload && event.payload.approval_state),
            prompt: String(
              event.payload && (
                event.payload.prompt
                || event.payload.message
                || event.payload.summary
              ) || ''
            ),
          });
        } else if (event.kind === 'user_questions_requested') {
          const body = event.payload && typeof event.payload === 'object' ? event.payload : {};
          payload.tool_name = payload.tool_name || normalizeId(body.tool_name);
          payload.question_ref = normalizeId(body.question_ref);
          payload.user_questions = Array.isArray(body.questions)
            ? body.questions.map((question) => {
                const source = question && typeof question === 'object' && !Array.isArray(question) ? question : {};
                return {
                  ...clonePlainObject(source),
                  ...(Array.isArray(source.options) ? { options: source.options.slice() } : {}),
                };
              })
            : [];
        } else if (event.kind === 'approval_resolved') {
          payload.approval_resolutions.push({
            status: normalizeToolLifecycleStatus(event.status),
            approval_state: normalizeToolLifecycleStatus(event.payload && event.payload.approval_state),
          });
        } else if (event.kind === 'tool_executing') {
          hasExecuting = true;
        }
      }
      const resultMetadata = resultPayload && resultPayload.metadata
        && typeof resultPayload.metadata === 'object' && !Array.isArray(resultPayload.metadata)
        ? resultPayload.metadata
        : {};
      const userQuestionsResultKind = normalizeId(resultMetadata.result_kind);
      if (payload.tool_name === 'ask_user'
        && (userQuestionsResultKind === 'user_questions_answered'
          || userQuestionsResultKind === 'user_questions_declined')) {
        payload.user_questions_result_kind = userQuestionsResultKind;
        if (Array.isArray(resultMetadata.answers)) {
          payload.user_questions_answers = resultMetadata.answers.map((answer) => {
            const source = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
            return {
              ...clonePlainObject(source),
              ...(Array.isArray(source.value) ? { value: source.value.slice() } : {}),
            };
          });
        }
      }
      const resolutionStatus = payload.approval_resolutions.length
        ? payload.approval_resolutions[payload.approval_resolutions.length - 1].status
        : '';
      // The result's approval_state is authoritative for a settled call, so it
      // overrides a lingering resolution status when it carries a hard outcome.
      const finalApprovalStatus = (resultApprovalStatus === 'denied'
        || resultApprovalStatus === 'timed_out'
        || resultApprovalStatus === 'cancelled')
        ? resultApprovalStatus
        : resolutionStatus;
      if (hasResult) {
        // An authoritative result settles stale running/interrupted/approval
        // states. Specific terminal outcomes take precedence over is_error.
        payload.state = resultStatus;
      } else if (awaitingApproval) {
        // A gap row is being emitted for this call (no resolution, no result),
        // so the call is awaiting approval — this dominates a stale tool_use
        // status so the badge stays consistent with the visible Allow/Deny block.
        payload.state = 'awaiting_approval';
      } else if (finalApprovalStatus === 'denied' || toolUseStatus === 'denied') {
        payload.state = 'denied';
      } else if (finalApprovalStatus === 'timed_out' || toolUseStatus === 'timed_out') {
        payload.state = 'timed_out';
      } else if (finalApprovalStatus === 'cancelled' || toolUseStatus === 'cancelled') {
        payload.state = 'cancelled';
      } else if (Array.isArray(payload.user_questions)) {
        // The blocking question request follows the running tool_use event and
        // must outrank that stale status until the normal tool_result settles it.
        payload.state = 'pending_user_input';
      } else if (hasExecuting || toolUseStatus === 'running') {
        payload.state = 'interrupted';
      } else if (finalApprovalStatus === 'approved' || toolUseStatus === 'approved') {
        payload.state = 'approved';
      } else if (payload.approval_requests.length || toolUseStatus === 'pending_approval') {
        payload.state = 'awaiting_approval';
      } else if (toolUseStatus) {
        payload.state = toolUseStatus;
      }
      row.tool_call_id = payload.tool_call_id;
      row.payload = payload;
      return row;
    }

    // SHARED INVARIANT (kept in lockstep with renderer-turn-reducer-approval-gap.js
    // ::createApprovalGapRow / syncApprovalGapRow): an `approval_gap` row exists
    // IFF the call is awaiting approval and unresolved. The streaming reducer
    // mirrors this payload shape so live and hydrated rows reconcile cleanly; the
    // `22-approval-pending` corpus scenario enforces presence parity.
    function buildApprovalGapRow(turnId, events, toolCallId, context) {
      const row = createBaseRow('approval_gap', turnId, events);
      const payload = {
        tool_call_id: normalizeId(toolCallId),
        prompt: '',
        status: 'pending',
        state: 'awaiting_approval',
      };
      const ctx = context && typeof context === 'object' ? context : {};
      const toolUseEvent = ctx.toolUseEvent && typeof ctx.toolUseEvent === 'object' ? ctx.toolUseEvent : null;
      const toolUsePayload = toolUseEvent && toolUseEvent.payload && typeof toolUseEvent.payload === 'object'
        ? toolUseEvent.payload
        : null;
      if (toolUsePayload) {
        const toolName = normalizeId(toolUsePayload.tool_name);
        if (toolName) {
          payload.tool_name = toolName;
        }
        const displayName = normalizeId(toolUsePayload.tool_display_name);
        if (displayName) {
          payload.tool_display_name = displayName;
        }
        // The approval card quotes the exact command/args being approved
        // (renderApprovalBlock commandText); carry the call's input through
        // so hydrated gap rows match the live reducer's.
        const inputJson = String(toolUsePayload.input_json || '').trim();
        if (inputJson) {
          payload.input_json = inputJson;
        }
        // The full object as well: input_json collapses to a {truncated,
        // preview} stub past its cap, and the card previews the object first.
        if (toolUsePayload.input && typeof toolUsePayload.input === 'object'
          && !Array.isArray(toolUsePayload.input) && Object.keys(toolUsePayload.input).length) {
          payload.input = clonePlainObject(toolUsePayload.input);
        }
        const policyScope = String(toolUsePayload.policy_scope || '').trim();
        const policyConsequence = String(toolUsePayload.policy_consequence || '').trim();
        const reason = String(toolUsePayload.reason || '').trim();
        if (policyScope) payload.policy_scope = policyScope;
        if (policyConsequence) payload.policy_consequence = policyConsequence;
        if (reason) payload.reason = reason;
      }
      for (const event of events) {
        if (event.kind !== 'approval_requested') {
          continue;
        }
        payload.prompt = payload.prompt || String(
          event.payload && (
            event.payload.prompt
            || event.payload.message
            || event.payload.summary
          ) || ''
        );
        payload.status = normalizeToolLifecycleStatus(event.status) || payload.status;
        const policyScope = String(event.payload && event.payload.policy_scope || payload.policy_scope || '').trim();
        const policyConsequence = String(event.payload && event.payload.policy_consequence || payload.policy_consequence || '').trim();
        const reason = String(event.payload && event.payload.reason || payload.reason || '').trim();
        if (policyScope) payload.policy_scope = policyScope;
        if (policyConsequence) payload.policy_consequence = policyConsequence;
        if (reason) payload.reason = reason;
      }
      row.tool_call_id = payload.tool_call_id;
      row.payload = payload;
      return row;
    }

    function buildToolResultRow(turnId, event, toolCallId) {
      const row = createBaseRow('tool_result', turnId, [event]);
      const payload = {
        tool_call_id: normalizeId(toolCallId),
        tool_name: normalizeId(event?.payload && event.payload.tool_name),
        output_text: String(event?.payload && event.payload.output_text || ''),
        result_summary: String(event?.payload && event.payload.summary || ''),
        duration_ms: Number(event?.payload && (event.payload.duration_ms ?? event.payload.durationMs)) || 0,
        is_error: event?.payload && event.payload.is_error === true,
        result_is_error: event?.payload && event.payload.is_error === true,
        error_code: normalizeId(event?.payload && event.payload.error_code),
        state: normalizeToolLifecycleStatus(event?.status) || (event?.payload && event.payload.is_error === true ? 'errored' : 'completed'),
      };
      const generatedArtifacts = Array.isArray(event?.payload && event.payload.generated_artifacts)
        ? event.payload.generated_artifacts.map(normalizeGeneratedArtifact).filter(Boolean)
        : [];
      if (generatedArtifacts.length) {
        payload.generated_artifacts = generatedArtifacts;
      }
      if (event?.payload && event.payload.metadata && typeof event.payload.metadata === 'object' && !Array.isArray(event.payload.metadata)) {
        payload.metadata = clonePlainObject(event.payload.metadata);
      }
      row.tool_call_id = payload.tool_call_id;
      row.payload = payload;
      return row;
    }

    return {
      buildToolCallRow,
      buildApprovalGapRow,
      buildToolResultRow,
    };
  }

  return { createTurnRowProjectorTools };
});
