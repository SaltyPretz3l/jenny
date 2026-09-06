(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-subagent-monitor-model'),
      require('../inventory/action-button'),
      require('../inventory/badge'),
      require('../inventory/collapsible')
    );
    return;
  }
  root.rendererSubagentMonitorView = factory(
    root.rendererSubagentMonitorModel || {},
    root.inventoryActionButton,
    root.inventoryBadge,
    root.inventoryCollapsible || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (modelUtils, actionButton, badge, collapsible) {
  'use strict';

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function stateDot(tone) {
    return `<span class="status-dot subagent-monitor-dot subagent-monitor-dot--${escapeHtml(tone || 'muted')}" aria-hidden="true"></span>`;
  }

  function domToken(value, fallback) {
    const normalized = String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 120);
    return /^[A-Za-z]/.test(normalized) ? normalized : `${fallback}-${normalized || 'item'}`;
  }

  function inlineSummaryMarkup(viewModel, options = {}) {
    if (!viewModel || !viewModel.childCount || typeof actionButton !== 'function') return '';
    const countLabel = `${viewModel.childCount} ${viewModel.childCount === 1 ? 'subagent' : 'subagents'}`;
    const stateLabel = viewModel.terminal ? viewModel.statusCopy : viewModel.parentState;
    const elapsed = modelUtils.formatElapsed?.(viewModel.elapsedMs) || '';
    const meta = [countLabel, stateLabel, elapsed].filter(Boolean).join(' · ');
    const key = String(options.key || viewModel.key || viewModel.toolCallId || '').trim();
    const triggerLabel = `Open subagent monitor: ${viewModel.summaryLabel}, ${meta}`;
    const content = stateDot(viewModel.tone)
      + `<span class="subagent-summary-label">${escapeHtml(viewModel.summaryLabel)}</span>`
      + '<span class="subagent-summary-meta">'
      + `${escapeHtml(countLabel)} · ${escapeHtml(stateLabel)}`
      + (elapsed ? ` · <span data-subagent-elapsed>${escapeHtml(elapsed)}</span>` : '')
      + '</span>'
      + '<span class="subagent-summary-open-label">Open</span>';
    return actionButton({
      id: 'subagent-open',
      plain: true,
      className: 'subagent-summary-trigger',
      trustedHtml: content,
      ariaLabel: triggerLabel,
      title: triggerLabel,
      ariaExpanded: options.open === true,
      ariaControls: 'subagentInspector',
      dataset: {
        'subagent-open': key,
        'subagent-source': options.source || (viewModel.authoritative ? 'terminal' : 'live'),
      },
    });
  }

  function renderLiveSummary(steps, options = {}) {
    const selectedSteps = modelUtils.selectLiveDelegationSteps?.(steps)
      || (Array.isArray(steps) ? steps : []);
    const viewModel = modelUtils.buildMonitorViewModel?.({
      steps: selectedSteps,
      key: options.key,
      now: options.now,
    });
    return inlineSummaryMarkup(viewModel, { ...options, source: 'live' });
  }

  function renderTerminalSummary(metadata, options = {}) {
    const terminal = modelUtils.extractTerminalReport?.(metadata);
    if (!terminal) return '';
    const viewModel = modelUtils.buildMonitorViewModel?.({
      terminal,
      key: options.key,
      toolCallId: options.toolCallId,
      parentResponding: options.parentResponding === true,
    });
    return inlineSummaryMarkup(viewModel, { ...options, source: 'terminal' });
  }

  function renderTree(viewModel) {
    const children = viewModel.children || [];
    const childRows = children.map((child, index) => {
      const meta = [child.terminalCopy, child.model || child.usage?.model, modelUtils.formatElapsed?.(child.budget?.elapsed_ms || 0)]
        .filter(Boolean).join(' · ');
      return actionButton({
        id: 'subagent-select',
        plain: true,
        className: `subagent-tree-item${child.key === viewModel.selectedKey ? ' is-selected' : ''}`,
        role: 'treeitem',
        tabIndex: child.key === viewModel.selectedKey ? 0 : -1,
        ariaSelected: child.key === viewModel.selectedKey,
        dataset: { 'subagent-select': child.key },
        trustedHtml: stateDot(child.tone)
          + '<span class="subagent-tree-copy">'
          + `<span class="subagent-tree-label">${escapeHtml(child.label)}</span>`
          + `<span class="subagent-tree-meta">${escapeHtml(meta)}</span>`
          + '</span>',
      });
    }).join('');
    return '<div class="subagent-monitor-tree-pane">'
      + '<div class="subagent-monitor-kicker">Subagent tree</div>'
      + '<div class="subagent-tree" role="tree" aria-label="Subagent tasks">'
      + '<div class="subagent-tree-parent" role="treeitem" aria-expanded="true" tabindex="-1">'
      + stateDot(viewModel.terminal ? viewModel.tone : 'pending')
      + `<span>Jenny · ${escapeHtml(viewModel.parentState)}</span>`
      + '</div>'
      + `<div class="subagent-tree-children" role="group">${childRows}</div>`
      + '</div></div>';
  }

  function section(title, body, className = '') {
    if (!body) return '';
    return `<section class="subagent-detail-section ${escapeHtml(className)}">`
      + `<div class="subagent-monitor-kicker">${escapeHtml(title)}</div>${body}</section>`;
  }

  function renderEvidence(child) {
    if (!child.evidence?.length) return '';
    return '<div class="subagent-evidence-list">' + child.evidence.map((entry) => {
      const lineRange = entry.line_start
        ? `:${entry.line_start}${entry.line_end !== entry.line_start ? `-${entry.line_end}` : ''}`
        : '';
      const title = entry.relative_path
        ? `${entry.relative_path}${lineRange}`
        : (entry.source_tool || entry.source || 'Evidence');
      const description = entry.summary || entry.quote
        || (entry.fact && entry.value ? `${entry.fact}: ${entry.value}` : '');
      const provenance = entry.provenance === 'tool_observed' ? 'Tool observed' : '';
      const pathAttrs = entry.relative_path
        ? ` role="link" tabindex="0" data-chat-path-open="${escapeHtml(entry.relative_path)}" data-chat-path="${escapeHtml(entry.relative_path)}"`
        : '';
      return `<div class="subagent-evidence-item"${pathAttrs}>`
        + `<span class="subagent-evidence-title">${escapeHtml(title)}</span>`
        + (description ? `<span class="subagent-evidence-copy">${escapeHtml(description)}</span>` : '')
        + (provenance ? `<span class="subagent-evidence-copy">${escapeHtml(provenance)}</span>` : '')
        + '</div>';
    }).join('') + '</div>';
  }

  function renderTools(child) {
    if (!child.tools?.length) return '';
    return '<div class="subagent-tool-list">' + child.tools.map((tool) => (
      `<span class="subagent-tool-row">${escapeHtml(tool)}</span>`
    )).join('') + '</div>';
  }

  function renderUsage(child, aggregateUsage, liveElapsedMs) {
    const usage = child.usage || aggregateUsage;
    const elapsed = modelUtils.formatElapsed?.(child.budget?.elapsed_ms || liveElapsedMs || 0) || '';
    if (!usage && !elapsed) return '';
    const total = usage ? modelUtils.formatTokens?.(usage.total_tokens) : 'Unavailable';
    const compact = `<div class="subagent-usage-summary"><strong>${escapeHtml(total)} tokens</strong>${elapsed ? ` · <span data-subagent-live-elapsed>${escapeHtml(elapsed)}</span>` : ''}</div>`;
    if (!usage) return compact;
    const details = [
      ['Input', usage.input_tokens], ['Output', usage.output_tokens],
      ['Latest request', usage.last_request_input_tokens], ['Context estimate', usage.context_tokens_estimate],
      ['Context window', usage.context_window], ['Compact threshold', usage.compact_threshold_tokens],
    ].filter(([, value]) => Number.isSafeInteger(value));
    const rows = details.map(([label, value]) => (
      `<span><span>${escapeHtml(label)}</span><strong>${escapeHtml(modelUtils.formatTokens?.(value))}</strong></span>`
    )).join('');
    const route = [usage.provider, usage.model].filter(Boolean).join(' · ');
    const contentId = `subagent-usage-${domToken(child.key, 'selected')}`;
    const trigger = collapsible?.trigger?.({
      id: contentId,
      className: 'subagent-usage-trigger',
      children: compact + '<span class="subagent-disclosure-label">Expand</span>',
    }) || compact;
    const content = collapsible?.content?.({
      id: contentId,
      className: 'subagent-usage-detail',
      children: `<div class="subagent-usage-grid">${rows}</div>`
        + (route ? `<div class="subagent-usage-route">${escapeHtml(route)}${usage.estimated ? ' · estimated' : ''}</div>` : ''),
    }) || '';
    return trigger + content;
  }

  function renderTechnicalDetails(child) {
    if (!child.error) return '';
    const contentId = `subagent-error-${domToken(child.key, 'selected')}`;
    const code = String(child.error.code || '').trim();
    const trigger = collapsible?.trigger?.({
      id: contentId,
      className: 'subagent-technical-trigger',
      children: `<span>Technical details${code ? ` · ${escapeHtml(code)}` : ''}</span><span class="subagent-disclosure-label">Expand</span>`,
    }) || '';
    const content = collapsible?.content?.({
      id: contentId,
      className: 'subagent-technical-detail',
      children: `<p>${escapeHtml(child.error.message || 'No additional details.')}</p>`
        + `<p>Retryable: ${child.error.retryable === true ? 'yes' : 'no'}</p>`,
    }) || '';
    return trigger + content;
  }

  function renderDetails(viewModel) {
    const child = viewModel.selected;
    if (!child) return '<div class="subagent-monitor-empty">Details unavailable.</div>';
    const failureBadge = typeof badge === 'function' && child.terminal
      ? badge({ text: child.terminalCopy, tone: child.tone, size: 'sm' })
      : '';
    return '<div class="subagent-monitor-detail-pane">'
      + '<div class="subagent-monitor-kicker">Details</div>'
      + `<h2 id="subagentInspectorTitle">${escapeHtml(child.label)}</h2>`
      + `<div class="subagent-detail-status">${stateDot(child.tone)}${failureBadge || escapeHtml(child.terminalCopy)}</div>`
      + renderTechnicalDetails(child)
      + section('Summary', `<p>${escapeHtml(child.summary)}</p>`)
      + section('Evidence', renderEvidence(child))
      + section('Tools', renderTools(child))
      + section('Uncertainties', child.uncertainties?.length ? `<p>${escapeHtml(child.uncertainties.join(' · '))}</p>` : '')
      + section('Usage', renderUsage(child, viewModel.usage, viewModel.elapsedMs), 'subagent-detail-usage')
      + '</div>';
  }

  function renderInspector(viewModel, options = {}) {
    if (!viewModel || !viewModel.childCount) return '<div class="subagent-monitor-empty">Details unavailable.</div>';
    const closeButton = actionButton({
      id: 'subagent-close', label: 'Close', variant: 'ghost', size: 'sm',
      className: 'subagent-monitor-close', ariaLabel: 'Close subagent monitor', title: 'Close subagent monitor',
      dataset: { 'subagent-close': 'true' },
    });
    const backButton = actionButton({
      id: 'subagent-back', label: 'Back', variant: 'ghost', size: 'sm',
      className: 'subagent-monitor-back', ariaLabel: 'Back to subagent list', title: 'Back to subagent list',
      dataset: { 'subagent-back': 'true' },
    });
    return '<div class="subagent-monitor-header">'
      + '<div><span class="subagent-monitor-title">Subagent Monitor</span>'
      + `<span class="subagent-monitor-parent-state">${escapeHtml(viewModel.parentState)}</span></div>`
      + `<div class="subagent-monitor-header-actions">${options.compactDetail ? backButton : ''}${closeButton}</div>`
      + '</div>'
      + '<div class="subagent-monitor-body">'
      + `<div class="subagent-monitor-master${options.compactDetail ? ' is-hidden-compact' : ''}">${renderTree(viewModel)}</div>`
      + `<div class="subagent-monitor-detail${options.compact && !options.compactDetail ? ' is-hidden-compact' : ''}">${renderDetails(viewModel)}</div>`
      + '</div>';
  }

  return {
    inlineSummaryMarkup,
    renderInspector,
    renderLiveSummary,
    renderTerminalSummary,
  };
});
