(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPlanDocument = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TERMINAL_STATES = new Set(['approved', 'approved_auto', 'rejected', 'abandoned', 'superseded']);

  function escapeFallback(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function bounded(value, limit) {
    return String(value || '').trim().slice(0, limit);
  }

  function normalizePlanDocument(value) {
    const source = value && typeof value === 'object' ? value : {};
    const steps = (Array.isArray(source.steps) ? source.steps : [])
      .map((step) => bounded(typeof step === 'string' ? step : step?.summary, 300))
      .filter(Boolean).slice(0, 20);
    const state = bounded(source.transition || source.state || source.status || 'pending', 40).toLowerCase();
    return {
      plan_id: bounded(source.plan_id, 120),
      tool_call_id: bounded(source.tool_call_id, 160),
      approval_id: bounded(source.approval_id || source.tool_call_id, 240),
      title: bounded(source.title || source.summary || 'Implementation plan', 120),
      summary: bounded(source.summary, 800),
      steps,
      notes: bounded(source.notes, 4000),
      verification: bounded(typeof source.verification === 'string'
        ? source.verification : source.verification?.summary, 400),
      feedback: bounded(source.feedback, 800),
      plan_edited: source.plan_edited === true,
      files_read: (Array.isArray(source.files_read) ? source.files_read : [])
        .map((path) => bounded(path, 300)).filter(Boolean).slice(0, 20),
      state: TERMINAL_STATES.has(state) ? state : 'pending',
    };
  }

  function coalesceTransitions(events) {
    const rows = Array.isArray(events) ? events : [];
    const last = rows[rows.length - 1] || {};
    const document = normalizePlanDocument(last.payload || last);
    return {
      document: { ...document, transition: document.state },
      transitions: rows.map((event) => bounded(
        event?.payload?.transition || event?.status || event?.state, 40
      ).toLowerCase()).filter(Boolean),
    };
  }

  function collapsedReceiptMarkup(value, options) {
    const plan = normalizePlanDocument(value);
    const escapeHtml = options?.escapeHtml || escapeFallback;
    return `<details class="plan-document-receipt" data-plan-document="true" data-plan-state="${escapeHtml(plan.state)}">`
      + `<summary><span>${escapeHtml(plan.title)}</span><span class="plan-document-receipt__state">${plan.plan_edited ? 'edited &middot; ' : ''}${escapeHtml(plan.state.replace('_', ' '))}</span></summary>`
      + `<div class="plan-document-receipt__body"><ol>${plan.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
      + (plan.feedback ? `<p><strong>Feedback:</strong> ${escapeHtml(plan.feedback)}</p>` : '')
      + '</div></details>';
  }

  function fullDocumentMarkup(value, options) {
    const plan = normalizePlanDocument(value);
    if (plan.state !== 'pending') return collapsedReceiptMarkup(plan, options);
    const escapeHtml = options?.escapeHtml || escapeFallback;
    const renderMarkdown = options?.renderMarkdown || ((text) => `<p>${escapeHtml(text)}</p>`);
    const approvalRef = plan.approval_id || plan.tool_call_id;
    return `<section class="plan-document" data-plan-document="true" data-plan-state="pending" data-approval-ref="${escapeHtml(approvalRef)}">`
      + '<header class="plan-document__header"><span class="plan-document__eyebrow">Proposed plan</span><span class="plan-document__rule" aria-hidden="true"></span>'
      + `<span class="plan-document__meta">${plan.steps.length} steps${plan.files_read.length ? ` · ${plan.files_read.length} files read` : ''}</span></header>`
      + `<h3 class="plan-document__title" data-plan-title role="button" tabindex="0" aria-label="Edit plan title">${escapeHtml(plan.title)}</h3>`
      + (plan.summary ? `<p class="plan-document__summary">${escapeHtml(plan.summary)}</p>` : '')
      + `<ol class="plan-document__steps">${plan.steps.map((step, index) => `<li draggable="true" data-plan-step-index="${index}"><span class="plan-document__step-text" data-plan-step-text role="button" tabindex="0" aria-label="Edit step ${index + 1}">${escapeHtml(step)}</span><span class="plan-document__step-controls" data-plan-step-controls></span></li>`).join('')}</ol>`
      + '<div class="plan-document__add-step" data-plan-add-step></div>'
      + (plan.notes ? `<div class="plan-document__notes markdown-body">${renderMarkdown(plan.notes)}</div>` : '')
      + (plan.verification ? `<div class="plan-document__verification"><span>Verification</span><p>${escapeHtml(plan.verification)}</p></div>` : '')
      + '<div class="plan-document__decision" role="status" aria-live="polite"><span class="plan-document__edited-chip" data-plan-edited hidden>Plan edited</span><div data-plan-actions></div></div>'
      + '</section>';
  }

  function legacyPlanObjectMarkup(value, options) {
    const source = value && typeof value === 'object' ? value : {};
    return collapsedReceiptMarkup({
      plan_id: source.plan_id,
      title: source.title || 'Plan-then-act plan',
      summary: source.summary,
      steps: source.steps,
      verification: source.verification,
      state: source.status || 'approved',
    }, options);
  }

  function legacyPlanProposalMarkup(value, options) {
    const source = value && typeof value === 'object' ? value : {};
    const proposal = source.plan_proposal && typeof source.plan_proposal === 'object'
      ? source.plan_proposal
      : source;
    return collapsedReceiptMarkup({
      plan_id: proposal.proposal_id,
      title: proposal.title || 'Proposed plan',
      summary: proposal.intro_text,
      steps: (Array.isArray(proposal.steps) ? proposal.steps : []).map((step) => (
        typeof step === 'string' ? step : step?.label
      )),
      state: 'superseded',
    }, options);
  }

  return {
    normalizePlanDocument,
    coalesceTransitions,
    fullDocumentMarkup,
    collapsedReceiptMarkup,
    legacyPlanObjectMarkup,
    legacyPlanProposalMarkup,
  };
});
