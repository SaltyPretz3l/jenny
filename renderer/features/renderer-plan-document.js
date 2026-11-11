(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPlanDocument = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const TERMINAL_STATES = new Set(['approved', 'approved_auto', 'accepted', 'rejected', 'abandoned', 'superseded']);

  function stateLabel(state) {
    switch (state) {
      case 'approved': return jt('artifacts.plan.state.approved', 'Approved');
      case 'approved_auto': return jt('artifacts.plan.state.approvedAuto', 'Approved, auto mode');
      case 'accepted': return jt('artifacts.plan.state.accepted', 'Accepted · not built');
      case 'rejected': return jt('artifacts.plan.state.rejected', 'Rejected');
      case 'abandoned': return jt('artifacts.plan.state.abandoned', 'Abandoned');
      case 'superseded': return jt('artifacts.plan.state.superseded', 'Superseded');
      default: return state.replace(/_/g, ' ');
    }
  }

  const escapeFallback = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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
      title: bounded(source.title || source.summary || jt('artifacts.plan.implementationPlan', 'Implementation plan'), 120),
      summary: bounded(source.summary, 1200),
      steps,
      notes: bounded(source.notes, 4000),
      verification: bounded(typeof source.verification === 'string'
        ? source.verification : source.verification?.summary, 1200),
      feedback: bounded(source.feedback, 800),
      plan_edited: source.plan_edited === true,
      files_read: (Array.isArray(source.files_read) ? source.files_read : [])
        .map((path) => bounded(path, 300)).filter(Boolean).slice(0, 20),
      state: TERMINAL_STATES.has(state) ? state : 'pending',
    };
  }

  // Display only: a step stays one string; these choose how it is drawn.
  const NOTES_OPEN_MAX = 700;
  const NO_FEEDBACK_PLACEHOLDER = '<no feedback given>';
  const LEAD_BREAK_RE = /: |(?<!\b(?:e\.g|i\.e|vs|etc))\. | [—–-] /gi;
  const FLOW_BREAK_RE = /, | (?:that|so|and|with|covering|once|using|to|which|because) /g;
  const sentenceCase = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  function firstBreak(re, masked, from, max) {
    re.lastIndex = from;
    const match = re.exec(masked);
    return match && match.index < max ? match : null;
  }

  function splitPlanStep(raw) {
    const text = String(raw ?? '').trim();
    const bold = /^\*\*(.+?)\*\*\s*[:.—–-]*\s*([\s\S]*)$/.exec(text);
    if (bold) return { lead: bold[1], detail: sentenceCase(bold[2]), flow: false };
    // Mask code spans: no break counts inside backticks.
    const masked = text.replace(/`[^`]*`?/g, (span) => 'x'.repeat(span.length));
    const lead = firstBreak(LEAD_BREAK_RE, masked, 4, 90);
    if (lead) {
      return { lead: text.slice(0, lead.index), detail: sentenceCase(text.slice(lead.index + lead[0].length).trim()), flow: false };
    }
    if (text.length <= 90) return { lead: text, detail: '', flow: false };
    const flow = firstBreak(FLOW_BREAK_RE, masked, 16, 92);
    return flow
      ? { lead: text.slice(0, flow.index), detail: text.slice(flow.index), flow: true }
      : { lead: '', detail: text, flow: false };
  }

  // Escape first, then `x` becomes <code> and, outside code, **x** <strong>.
  function planInlineMarkup(text, escapeHtml) {
    return escapeHtml(String(text ?? '')).split(/(`[^`]+`)/).map((part, index) => (index % 2
      ? `<code>${part.slice(1, -1)}</code>`
      : part.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'))).join('');
  }

  function planStepInnerMarkup(raw, escapeHtml) {
    const { lead, detail, flow } = splitPlanStep(raw);
    const fmt = (text) => planInlineMarkup(text, escapeHtml);
    const span = (kind, text) => `<span class="plan-document__step-${kind}">${fmt(text)}</span>`;
    if (flow) return `<span class="plan-document__step-flow"><strong>${fmt(lead)}</strong>${fmt(detail)}</span>`;
    return lead ? span('lead', lead) + (detail ? span('detail', detail) : '') : span('plain', detail);
  }

  function sectionsMarkup(plan, escapeHtml, options) {
    const renderMarkdown = options?.renderMarkdown || ((text) => `<p>${escapeHtml(text)}</p>`);
    const section = (name, open, label, body) => `<details class="plan-document__section" data-plan-section="${name}"${open ? ' open' : ''}><summary>${escapeHtml(label)}</summary>${body}</details>`;
    return (plan.notes ? section('notes', plan.notes.length <= NOTES_OPEN_MAX, jt('chat.planDocument.notesLabel', 'Notes'),
      `<div class="plan-document__section-body plan-document__notes markdown-body chat-bubble-markdown" dir="auto">${renderMarkdown(plan.notes)}</div>`) : '')
      + (plan.verification ? section('check', true, jt('chat.planDocument.checkLabel', 'How it gets checked'),
        `<div class="plan-document__section-body"><p class="plan-document__check" dir="auto">${planInlineMarkup(plan.verification, escapeHtml)}</p></div>`) : '');
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
      + `<summary><span>${escapeHtml(plan.title)}</span><span class="plan-document-receipt__meta"><span class="plan-document-receipt__state">${plan.plan_edited ? `${escapeHtml(jt('artifacts.plan.editedPrefix', 'edited'))} &middot; ` : ''}${escapeHtml(stateLabel(plan.state))}</span>`
      + (plan.state === 'accepted' && plan.plan_id ? `<span data-plan-build-accepted data-plan-id="${escapeHtml(plan.plan_id)}"></span>` : '')
      + '</span></summary>'
      + '<div class="plan-document-receipt__body">'
      + (plan.summary ? `<p class="plan-document__summary" dir="auto">${planInlineMarkup(plan.summary, escapeHtml)}</p>` : '')
      + `<ol class="plan-document__steps">${plan.steps.map((step) => `<li><span class="plan-document__step-text" dir="auto">${planStepInnerMarkup(step, escapeHtml)}</span></li>`).join('')}</ol>`
      + sectionsMarkup(plan, escapeHtml, options)
      + (plan.feedback && plan.feedback !== NO_FEEDBACK_PLACEHOLDER ? `<p><strong>${escapeHtml(jt('artifacts.plan.feedbackLabel', 'Feedback:'))}</strong> ${escapeHtml(plan.feedback)}</p>` : '')
      + '</div></details>';
  }

  function fullDocumentMarkup(value, options) {
    const plan = normalizePlanDocument(value);
    if (plan.state !== 'pending') return collapsedReceiptMarkup(plan, options);
    const escapeHtml = options?.escapeHtml || escapeFallback;
    const approvalRef = plan.approval_id || plan.tool_call_id;
    return `<section class="plan-document" data-plan-document="true" data-plan-state="pending" data-approval-ref="${escapeHtml(approvalRef)}">`
      + '<header class="plan-document__header"><span class="plan-document__eyebrow">' + escapeHtml(jt('artifacts.document.plan', 'Plan')) + '</span><span class="plan-document__rule" aria-hidden="true"></span>'
      + `<span class="plan-document__meta" data-plan-files-read-count="${plan.files_read.length}">${escapeHtml(jt('artifacts.plan.stepCount', '{count} steps', { count: plan.steps.length }))}${plan.files_read.length ? ` · ${escapeHtml(jt('artifacts.plan.filesRead', '{count} files read', { count: plan.files_read.length }))}` : ''}</span></header>`
      + `<h3 class="plan-document__title" data-plan-title dir="auto" role="button" tabindex="0" aria-label="${escapeHtml(jt('artifacts.plan.editTitleLabel', 'Edit plan title'))}">${escapeHtml(plan.title)}</h3>`
      + (plan.summary ? `<p class="plan-document__summary" dir="auto">${planInlineMarkup(plan.summary, escapeHtml)}</p>` : '')
      + `<ol class="plan-document__steps">${plan.steps.map((step, index) => `<li draggable="true" data-plan-step-index="${index}"><span class="plan-document__step-text" data-plan-step-text data-plan-step-raw="${escapeHtml(step)}" dir="auto" role="button" tabindex="0" aria-label="${escapeHtml(jt('artifacts.plan.editStepLabel', 'Edit step {number}', { number: index + 1 }))}">${planStepInnerMarkup(step, escapeHtml)}</span><span class="plan-document__step-controls" data-plan-step-controls></span></li>`).join('')}</ol>`
      + '<div class="plan-document__add-step" data-plan-add-step></div>'
      + sectionsMarkup(plan, escapeHtml, options)
      + '<div class="plan-document__decision" role="status" aria-live="polite"><span class="plan-document__edited-chip" data-plan-edited hidden>' + escapeHtml(jt('artifacts.plan.edited', 'Plan edited')) + '</span><div data-plan-actions></div></div>'
      + '</section>';
  }

  function legacyPlanObjectMarkup(value, options) {
    const source = value && typeof value === 'object' ? value : {};
    return collapsedReceiptMarkup({
      plan_id: source.plan_id,
      title: source.title || jt('artifacts.plan.planThenAct', 'Plan-then-act plan'),
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
      title: proposal.title || jt('artifacts.document.plan', 'Plan'),
      summary: proposal.intro_text,
      steps: (Array.isArray(proposal.steps) ? proposal.steps : []).map((step) => (
        typeof step === 'string' ? step : step?.label
      )),
      state: 'superseded',
    }, options);
  }

  return {
    normalizePlanDocument,
    splitPlanStep,
    planInlineMarkup,
    planStepInnerMarkup,
    coalesceTransitions,
    fullDocumentMarkup,
    collapsedReceiptMarkup,
    legacyPlanObjectMarkup,
    legacyPlanProposalMarkup,
  };
});
