(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-agent-step-utils'),
      require('./renderer-subagent-monitor-view')
    );
    return;
  }
  root.rendererTranscriptAgentProgressUtils = factory(
    root.rendererAgentStepUtils || {},
    root.rendererSubagentMonitorView || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (agentStepUtils, subagentView) {

  const resolveAgentStepDisplay = typeof agentStepUtils.resolveAgentStepDisplay === 'function'
    ? agentStepUtils.resolveAgentStepDisplay
    : function fallbackResolve() { return { state: 'pending', dot: 'pending' }; };
  const humanizeStage = typeof agentStepUtils.humanizeStage === 'function'
    ? agentStepUtils.humanizeStage
    : function fallbackHumanize(raw) { return String(raw || '').trim().replace(/_/g, ' '); };
  const formatElapsed = typeof agentStepUtils.formatElapsed === 'function'
    ? agentStepUtils.formatElapsed
    : function fallbackFormat() { return ''; };

  function defaultEscapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function renderAgentProgressRow(options) {
    const opts = options || {};
    const escapeHtml = typeof opts.escapeHtml === 'function' ? opts.escapeHtml : defaultEscapeHtml;
    const steps = Array.isArray(opts.steps) ? opts.steps : [];
    if (!steps.length) {
      return '';
    }
    const subagentSteps = steps.filter((step) => (
      String(step?.taskType || step?.task_type || '') === 'sub_agent'
      || /^(delegate|subagent_(run|batch))$/.test(String(step?.source || ''))
    ));
    if (subagentSteps.length && typeof subagentView.renderLiveSummary === 'function') {
      return subagentView.renderLiveSummary(subagentSteps);
    }
    const lastStep = steps[steps.length - 1];
    const wrapperDisplay = resolveAgentStepDisplay(lastStep);
    const label = 'Companion task';

    const stepsHtml = steps.map((step) => {
      const display = resolveAgentStepDisplay(step);
      const stage = humanizeStage(step && step.stage) || 'Working';
      const summary = String((step && step.summary) || '').trim() || 'Working on it.';
      const percent = Number.isFinite(Number(step && step.percent))
        ? Math.min(100, Math.max(0, Math.round(Number(step.percent))))
        : null;
      const elapsed = formatElapsed(step);
      const metaParts = [];
      if (percent != null) { metaParts.push(percent + '%'); }
      if (elapsed) { metaParts.push(elapsed); }
      const meta = metaParts.join(' - ');
      return (
        '<li class="agent-status-step"'
        + ' data-agent-status-step-state="' + escapeHtml(display.state) + '"'
        + ' data-agent-status-step-terminal="' + (step && step.terminal === true ? 'true' : 'false') + '">'
        + '<span class="status-dot status-dot--' + escapeHtml(display.dot) + '" aria-hidden="true"></span>'
        + '<div class="agent-status-step-body">'
        + '<div class="agent-status-step-stage">' + escapeHtml(stage) + '</div>'
        + '<div class="agent-status-step-summary">' + escapeHtml(summary) + '</div>'
        + (meta ? '<div class="agent-status-step-meta">' + escapeHtml(meta) + '</div>' : '')
        + '</div>'
        + '</li>'
      );
    }).join('');

    return (
      '<div class="agent-status-note agent-status-note--steps agent-status-note--durable"'
      + ' data-agent-status-state="' + escapeHtml(wrapperDisplay.state) + '"'
      + ' role="group"'
      + ' aria-label="' + escapeHtml(label + ' progress') + '">'
      + '<div class="agent-status-note-label kicker">' + escapeHtml(label) + '</div>'
      + '<ol class="agent-status-step-list" role="list">' + stepsHtml + '</ol>'
      + '</div>'
    );
  }

  return {
    renderAgentProgressRow,
  };
});
