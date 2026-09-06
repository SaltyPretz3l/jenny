(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPlanProposalCard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Compatibility renderer for historical persisted `plan_proposal` rows.
  // Current sidecars no longer emit proposals, so every row is inert and no
  // Approve / Adjust / Dismiss action is exposed.

  // Renderer-side mirror of sidecar normalize_plan_proposal: tolerate-and-
  // canonicalize, returning null for anything the card cannot render.
  function normalizePendingPlanProposal(rawProposal) {
    if (!rawProposal || typeof rawProposal !== 'object' || Array.isArray(rawProposal)) {
      return null;
    }
    const proposalId = String(rawProposal.proposal_id || '').trim();
    const title = String(rawProposal.title || '').trim();
    if (!proposalId || !title) {
      return null;
    }
    const stepsInput = Array.isArray(rawProposal.steps) ? rawProposal.steps : [];
    const steps = stepsInput
      .map((step, index) => {
        if (!step || typeof step !== 'object') {
          return null;
        }
        const label = String(step.label || '').trim();
        if (!label) {
          return null;
        }
        const normalized = {
          id: String(step.id || `s${index + 1}`).trim(),
          label,
        };
        const detail = String(step.detail || '').trim();
        if (detail) {
          normalized.detail = detail;
        }
        return normalized;
      })
      .filter(Boolean);
    if (!steps.length) {
      return null;
    }
    return {
      proposal_id: proposalId,
      title,
      intro_text: String(rawProposal.intro_text || '').trim(),
      steps,
    };
  }

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value);
  }

  // Plain-text transcript form of a proposal — the persisted message content
  // and copy/export surface (sibling of buildInteractiveQuestionBatchTranscript).
  // Pure and DOM-free so the Electron backend requires it too.
  function buildPlanProposalTranscript(proposal) {
    const normalized = normalizePendingPlanProposal(proposal);
    if (!normalized) {
      return '';
    }
    const lines = [`Jenny proposed a plan: ${normalized.title}`];
    if (normalized.intro_text) {
      lines.push(normalized.intro_text);
    }
    lines.push('');
    normalized.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.label}`);
      if (step.detail) {
        lines.push(`   ${step.detail}`);
      }
    });
    return lines.join('\n');
  }

  function buildStepsMarkup(steps, escapeHtml, options) {
    const includeDetail = !options || options.includeDetail !== false;
    return steps
      .map((step) => {
        const detail = includeDetail ? String(step?.detail || '').trim() : '';
        const detailMarkup = detail
          ? `<span class="plan-proposal-step-detail">${escapeHtml(detail)}</span>`
          : '';
        return `
          <li class="plan-proposal-step" data-step-id="${escapeHtml(String(step?.id || ''))}">
            <span class="plan-proposal-step-label">${escapeHtml(String(step?.label || ''))}</span>
            ${detailMarkup}
          </li>
        `;
      })
      .join('');
  }

  // Inert (read-only) summary for every persisted plan_proposal row. Family
  // kicker in past tense; step labels only, no details, no affordances.
  function buildInertPlanProposalSummaryMarkup(proposal, escapeHtml) {
    const esc = typeof escapeHtml === 'function' ? escapeHtml : fallbackEscapeHtml;
    const normalized = normalizePendingPlanProposal(proposal);
    if (!normalized) {
      return '';
    }
    return `
      <div class="ask-card ask-card-inert ask-card-proposal" data-plan-proposal-id="${esc(normalized.proposal_id)}" data-plan-proposal-inert="true">
        <div class="ask-card-header">
          <span class="ask-card-kicker"><span class="ask-card-kicker-dot" aria-hidden="true"></span>Jenny proposed</span>
        </div>
        <div class="plan-proposal-title">${esc(normalized.title)}</div>
        ${normalized.intro_text ? `<div class="ask-card-intro">${esc(normalized.intro_text)}</div>` : ''}
        <ol class="plan-proposal-steps plan-proposal-steps-inert">
          ${buildStepsMarkup(normalized.steps, esc, { includeDetail: false })}
        </ol>
      </div>
    `;
  }

  // Factory for historical inline timeline plan_proposal rows.
  function createPlanProposalRowBuilder(helpers) {
    const h = helpers || {};
    const escapeHtml = typeof h.escapeHtml === 'function' ? h.escapeHtml : fallbackEscapeHtml;
    return function buildPlanProposalRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const rowProposal = normalizePendingPlanProposal(payload.plan_proposal);
      if (!rowProposal) {
        return '';
      }
      return buildInertPlanProposalSummaryMarkup(rowProposal, escapeHtml);
    };
  }

  return {
    normalizePendingPlanProposal,
    buildPlanProposalTranscript,
    buildInertPlanProposalSummaryMarkup,
    createPlanProposalRowBuilder,
  };
});
