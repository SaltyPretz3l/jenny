/* renderer/chat/renderer-turn-row-approval-gap-markup.js renders the
 * approval_gap row: the inline approval card (or its resolved receipt) above
 * the tool row it gates, with the live card state the runtime reports.
 * Loaded before renderer-turn-row-tool-render-utils.js, which builds one per
 * row renderer from its settings and shared helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowApprovalGapMarkup = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createApprovalGapMarkup(deps) {
    const {
      settings, toolCallUtils, normalizeId, escapeHtml, renderApprovalBlock, resolveProjectedRowCallId,
    } = deps || {};
    if (!settings || typeof normalizeId !== 'function' || typeof escapeHtml !== 'function'
      || typeof resolveProjectedRowCallId !== 'function') {
      throw new TypeError('settings, normalizeId, escapeHtml and resolveProjectedRowCallId are required');
    }

    // A4: whether the runtime still waits on this approval (live, paused, inactive).
    function readApprovalCardState(row, toolCallId, options) {
      return typeof settings.getApprovalCardState === 'function'
        ? settings.getApprovalCardState({ sessionId: options && options.sessionId, turnId: row && row.turn_id, callId: toolCallId, rowState: row && row.payload && row.payload.state })
        : null;
    }

    function buildApprovalGapMarkup(row, _messages, options) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const toolCallId = resolveProjectedRowCallId(row);
      // A resolved row is a receipt of the decision; the live approval state
      // has nothing left to say about it.
      const resolved = payload.state === 'resolved';
      const cardState = resolved ? { state: 'resolved' } : (readApprovalCardState(row, toolCallId, options) || {});
      const toolName = String(payload.tool_name || '').trim();
      // Same precedence as the tool row this card sits above (F16).
      const displayToolName = toolCallUtils && typeof toolCallUtils.getToolDisplayName === 'function'
        ? toolCallUtils.getToolDisplayName(toolName, payload.tool_display_name)
        : (String(payload.tool_display_name || '').trim() || toolName);
      const prompt = String(payload.prompt || '').trim();
      if (!renderApprovalBlock) {
        return '';
      }
      // Quote the exact command/args being approved (bounded by the block's
      // own preview cap). The `input` object is the full sanitized payload;
      // `input_json` is a capped serialization that collapses to a
      // {truncated, preview} stub past the cap, so it is only the fallback
      // and its stub is never previewed as if it were the arguments.
      // Absent/unparsable input degrades to prompt-only.
      let commandText = '';
      let approvalInput = payload.input && typeof payload.input === 'object'
        && !Array.isArray(payload.input) && Object.keys(payload.input).length ? payload.input : null;
      const approvalInputJson = String(payload.input_json || '').trim();
      if (!approvalInput && approvalInputJson.startsWith('{')) {
        try {
          approvalInput = JSON.parse(approvalInputJson);
        } catch (_error) {
          approvalInput = null;
        }
      }
      if (approvalInput && approvalInput.truncated === true && typeof approvalInput.preview === 'string') {
        approvalInput = null;
      }
      // A message to another chat is approved against its own full-body field (the block renders
      // it); the clipped input preview and fact derivation never stand in for it.
      const sendsMessage = toolName === 'session_message';
      if (!sendsMessage && approvalInput && toolCallUtils && typeof toolCallUtils.getApprovalCommandPreview === 'function') {
        commandText = toolCallUtils.getApprovalCommandPreview(toolName, approvalInput);
      }
      return renderApprovalBlock({
        toolCallId,
        approvalId: normalizeId(payload.approval_id || payload.approvalId),
        toolName,
        displayToolName,
        prompt,
        policyScope: payload.policy_scope,
        policyConsequence: payload.policy_consequence,
        reason: payload.reason,
        oneOffOnly: payload.one_off_only === true || payload.oneOffOnly === true,
        purpose: approvalInput && toolCallUtils && typeof toolCallUtils.getApprovalPurpose === 'function'
          ? toolCallUtils.getApprovalPurpose(approvalInput) : '',
        facts: !sendsMessage && approvalInput && toolCallUtils && typeof toolCallUtils.getApprovalFacts === 'function'
          ? toolCallUtils.getApprovalFacts(toolName, approvalInput) : [],
        commandText,
        sessionMessageApproval: sendsMessage ? payload.session_message_approval : undefined,
        sessionStopApproval: toolName === 'session_stop' ? payload.session_stop_approval : undefined,
        settingsChangeApproval: toolName === 'settings_change' ? payload.settings_change_approval : undefined,
        scheduleChangeApproval: toolName === 'schedule_change' ? payload.schedule_change_approval : undefined,
        browserApproval: toolName === 'browser' ? payload.browser_approval : undefined,
        // Always passed (even undefined): a command or write without its live exact presentation fails closed.
        exactApproval: cardState.exactApproval,
        // What a command's Always allow covers (live only), and what a resolved one saved (row 103).
        alwaysAllowScope: cardState.alwaysAllowScope,
        rememberOffer: cardState.rememberOffer,
        mode: 'inline',
        cardState: cardState.state,
        resumeKey: cardState.resumeKey,
        variant: normalizeId(payload.approval_variant),
        decision: resolved ? normalizeId(payload.decision) : '',
        approvalScope: resolved ? normalizeId(payload.approval_scope) : '',
        alwaysAllowPrefix: resolved ? String(payload.always_allow_prefix || '') : '',
      }, { escapeHtml });
    }

    return { buildApprovalGapMarkup, readApprovalCardState };
  }

  return { createApprovalGapMarkup };
});
