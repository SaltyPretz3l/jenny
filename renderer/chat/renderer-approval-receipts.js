(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererApprovalReceipts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Load-order guard: the shared text helpers must already be loaded.
  const textUtils = globalThis.rendererApprovalText
    || (typeof require === 'function' ? require('./renderer-approval-text') : null);
  if (!textUtils || typeof textUtils.boundedText !== 'function') {
    throw new Error('renderer-approval-text must load before renderer/chat/renderer-approval-receipts.js');
  }
  const { normalizeText, boundedText } = textUtils;

  // Paused work, and paused work being discarded: the runtime holds the turn.
  const HELD_STATUSES = new Set(['paused', 'withdrawing']);

  // A resolved approval keeps its row as one receipt line (HB-038 H2, owner
  // pick B 2026-10-05): the card's slot never vanishes and the chat keeps a
  // record of what was allowed or denied. The live reducer and the hydrated
  // projector both settle the row from the call's own record through these
  // two helpers, so a live receipt and a reopened one say the same thing.
  const RECEIPT_HARD_OUTCOMES = new Set(['denied', 'timed_out', 'cancelled']);
  // A call that ran, or is running, was allowed even when the record of the
  // answer itself is missing.
  const RECEIPT_RAN_STATES = new Set(['approved', 'running', 'completed', 'errored', 'interrupted']);
  // The receipt subject ellipsizes in CSS; this bound stays above what a
  // Wide chat width row shows.
  const RECEIPT_SUBJECT_MAX_CHARS = 500;

  // The plan card owns a plan approval's record.
  function approvalKeepsReceipt(toolName) {
    return normalizeText(toolName) !== 'exit_plan_mode';
  }

  function deriveApprovalReceipt(callPayload) {
    const payload = callPayload && typeof callPayload === 'object' ? callPayload : {};
    if (!approvalKeepsReceipt(payload.tool_name)) return null;
    const state = normalizeText(payload.state).toLowerCase();
    // The reader's recorded answer wins: an allowed command that later timed
    // out or was stopped was still allowed. The call's own outcome only
    // speaks when no answer was recorded.
    const resolutions = Array.isArray(payload.approval_resolutions) ? payload.approval_resolutions : [];
    const last = resolutions.length && resolutions[resolutions.length - 1] && typeof resolutions[resolutions.length - 1] === 'object'
      ? resolutions[resolutions.length - 1] : {};
    const resolved = normalizeText(last.approval_state || last.status).toLowerCase();
    if (resolved === 'approved') {
      const scope = normalizeText(last.approval_scope).toLowerCase();
      // A command's Always allow saved a program + subcommand prefix (row 103).
      const prefix = scope === 'always' ? normalizeText(last.always_allow_prefix) : '';
      if (prefix) return { decision: 'allowed', scope, alwaysAllowPrefix: prefix };
      return scope === 'always' || scope === 'once' || scope === 'full_auto' ? { decision: 'allowed', scope } : { decision: 'allowed' };
    }
    if (RECEIPT_HARD_OUTCOMES.has(resolved)) return { decision: resolved };
    if (RECEIPT_HARD_OUTCOMES.has(state)) return { decision: state };
    if (state === 'awaiting_approval' || state === 'pending_approval') return null;
    return RECEIPT_RAN_STATES.has(state) ? { decision: 'allowed' } : { decision: 'closed' };
  }

  function applyApprovalReceipt(rowPayload, receipt) {
    if (!rowPayload || !receipt) return;
    rowPayload.state = 'resolved';
    rowPayload.status = 'resolved';
    rowPayload.decision = receipt.decision;
    if (receipt.scope) rowPayload.approval_scope = receipt.scope;
    else delete rowPayload.approval_scope;
    if (receipt.alwaysAllowPrefix) rowPayload.always_allow_prefix = receipt.alwaysAllowPrefix;
    else delete rowPayload.always_allow_prefix;
  }

  function receiptLabel(decision, scope) {
    switch (decision) {
      case 'allowed':
        if (scope === 'always') return jt('approval.receipt.alwaysAllowed', 'Always allowed');
        if (scope === 'full_auto') return jt('approval.receipt.fullAuto', 'Ran in Full auto');
        return scope === 'once' ? jt('approval.receipt.allowedOnce', 'Allowed once') : jt('approval.receipt.allowed', 'Allowed');
      case 'denied': return jt('approval.receipt.denied', 'Denied');
      case 'timed_out': return jt('approval.receipt.timedOut', 'Not answered in time');
      case 'cancelled': return jt('approval.receipt.cancelled', 'Approval cancelled');
      default: return jt('approval.receipt.closed', 'Approval closed');
    }
  }

  function receiptDecision(value) {
    const decision = normalizeText(value);
    return decision === 'allowed' || decision === 'closed' || RECEIPT_HARD_OUTCOMES.has(decision) ? decision : 'closed';
  }

  // The receipt names what was decided: the command's first line when there
  // is one, else the tool.
  // `subjectText` (a stop's "Stop <title>") replaces the command line as plain text.
  function renderResolvedReceipt(source, displayToolName, escapeHtml, subjectText = '') {
    const decision = receiptDecision(source.decision);
    const mark = decision === 'allowed' ? '\u2713' : (decision === 'denied' ? '\u2715' : '');
    const firstLine = String(source.commandText == null ? '' : source.commandText).trim().split('\n')[0];
    // An Always allowed command names what the saved rule covers (row 103).
    const savedPrefix = source.approvalScope === 'always' ? normalizeText(source.alwaysAllowPrefix) : '';
    const command = subjectText ? '' : (savedPrefix ? `${boundedText(savedPrefix, RECEIPT_SUBJECT_MAX_CHARS)} …`
      : boundedText(firstLine, RECEIPT_SUBJECT_MAX_CHARS));
    const subject = command
      ? `<code class="tool-approval-receipt-subject">${escapeHtml(command)}</code>`
      : `<span class="tool-approval-receipt-subject">${escapeHtml(boundedText(subjectText, RECEIPT_SUBJECT_MAX_CHARS) || displayToolName)}</span>`;
    return `<p class="tool-approval-receipt tool-approval-receipt--resolved">`
      + (mark ? `<span class="tool-approval-receipt-mark" aria-hidden="true">${mark}</span>` : '')
      + `<span class="tool-approval-receipt-label">${escapeHtml(receiptLabel(decision, source.approvalScope))}</span>`
      + `<span class="tool-approval-receipt-sep" aria-hidden="true">\u00b7</span>${subject}</p>`;
  }

  // Which card a pending approval row shows (A4, owner-approved 2026-09-22).
  // Live wins: Allow and Deny resolve by call id, so any approval the runtime
  // holds for the call is answerable. A paused reply for the turn offers its
  // Resume, unless the runtime says the pause cannot continue (a restart left
  // no checkpoint: the scheduler would refuse the Resume); then, like one
  // being discarded or a card whose answer was refused, it folds to a
  // receipt, as does a row the sealed fold marked interrupted (the turn is
  // over). Anything else keeps today's buttons: before the live approvals and
  // paused work load, a card must not claim it is dead. A live approval also
  // hands over its exact presentation, which only the live request (or the backend's waiter, on a
  // reopen) carries.
  function resolveApprovalCardState(state, ref) {
    const callId = normalizeText(ref && ref.callId);
    if (!state || !callId) return { state: 'live' };
    const approvals = state.pendingToolApprovals && typeof state.pendingToolApprovals.values === 'function'
      ? [...state.pendingToolApprovals.values()] : [];
    const live = approvals.find((approval) => normalizeText(approval && approval.callId) === callId);
    if (live) {
      const card = live.exactApproval && typeof live.exactApproval === 'object'
        ? { state: 'live', exactApproval: live.exactApproval } : { state: 'live' };
      // What a command card's Always allow covers (row 103): only the live request carries it.
      if (live.alwaysAllowScope && typeof live.alwaysAllowScope === 'object') card.alwaysAllowScope = live.alwaysAllowScope;
      if (live.rememberOffer === 'linked_children') card.rememberOffer = 'linked_children'; // row 87 C1
      return card;
    }
    const sessionId = normalizeText(ref.sessionId);
    const turnId = normalizeText(ref.turnId);
    const rows = sessionId && turnId && typeof state.runtimeSendController?.listPending === 'function'
      ? state.runtimeSendController.listPending(sessionId) : [];
    const held = rows.find((row) => row.turnId === turnId && HELD_STATUSES.has(row.status));
    if (held) {
      return held.status === 'paused' && held.resumable !== false
        ? { state: 'paused', resumeKey: held.key } : { state: 'inactive' };
    }
    if (state.inactiveApprovalCallIds instanceof Set && state.inactiveApprovalCallIds.has(callId)) {
      return { state: 'inactive' };
    }
    if (normalizeText(ref.rowState) === 'interrupted') return { state: 'inactive' };
    return { state: 'live' };
  }

  // Every input resolveApprovalCardState reads, as one string: the transcript
  // forces a full render when it changes, because no message changed with it.
  function approvalCardStateKey(state, sessionId) {
    if (!state) return '';
    const live = state.pendingToolApprovals && typeof state.pendingToolApprovals.values === 'function'
      ? [...state.pendingToolApprovals.values()].map((approval) => normalizeText(approval && approval.callId)).sort()
      : [];
    const id = normalizeText(sessionId);
    const paused = id && typeof state.runtimeSendController?.listPending === 'function'
      ? state.runtimeSendController.listPending(id).filter((row) => HELD_STATUSES.has(row.status))
        .map((row) => `${row.turnId}=${row.status}${row.resumable === false ? '!' : ''}:${row.key}`).sort()
      : [];
    const inactive = state.inactiveApprovalCallIds instanceof Set ? [...state.inactiveApprovalCallIds].sort() : [];
    return live.length || paused.length || inactive.length
      ? `${live.join(',')}/${paused.join(',')}/${inactive.join(',')}` : '';
  }

  return {
    RECEIPT_SUBJECT_MAX_CHARS,
    applyApprovalReceipt,
    approvalCardStateKey,
    approvalKeepsReceipt,
    deriveApprovalReceipt,
    receiptDecision,
    renderResolvedReceipt,
    resolveApprovalCardState,
  };
});
