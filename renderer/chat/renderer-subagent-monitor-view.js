(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-subagent-monitor-model'),
      require('../inventory/action-button'),
      require('../inventory/collapsible')
    );
    return;
  }
  root.rendererSubagentMonitorView = factory(
    root.rendererSubagentMonitorModel || {},
    root.inventoryActionButton,
    root.inventoryCollapsible || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (modelUtils, actionButton, collapsible) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const VISIBLE_STEP_ROWS = 8;
  const ICON_CLOSE = '<svg class="subagent-monitor-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const ICON_CHEVRON = '<svg class="subagent-monitor-icon subagent-monitor-icon--muted" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';
  const ICON_BACK = '<svg class="subagent-monitor-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 4L6 8l4 4"/></svg>';
  const ICON_TREE = '<svg class="subagent-monitor-icon subagent-monitor-icon--muted" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v3M3.5 13.5v-3h9v3M8 5.5v5"/></svg>';

  function stateDot(tone) {
    return `<span class="status-dot subagent-monitor-dot subagent-monitor-dot--${escapeHtml(tone || 'muted')}" aria-hidden="true"></span>`;
  }

  function domToken(value) {
    const normalized = String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 120);
    return /^[A-Za-z]/.test(normalized) ? normalized : `selected-${normalized || 'item'}`;
  }

  // A collapsible disclosure (trigger + content) keyed to the selected child.
  function disclosure(prefix, child, idSuffix, trigger, content) {
    const id = `subagent-${prefix}-${domToken(child.key)}${idSuffix}`;
    return (collapsible?.trigger?.({ id, ...trigger }) || '')
      + (collapsible?.content?.({ id, ...content }) || '');
  }

  function inlineSummaryMarkup(viewModel, options = {}) {
    if (!viewModel || !viewModel.childCount || typeof actionButton !== 'function') return '';
    const countLabel = `${viewModel.childCount} ${viewModel.childCount === 1 ? 'subagent' : 'subagents'}`;
    const stateLabel = viewModel.terminal ? viewModel.statusCopy : viewModel.parentState;
    const elapsed = modelUtils.formatElapsed?.(viewModel.elapsedMs) || '';
    const meta = [countLabel, stateLabel, elapsed].filter(Boolean).join(' · ');
    const key = String(options.key || viewModel.key || viewModel.toolCallId || '').trim();
    const triggerLabel = jt('chat.subagentMonitor.openAriaLabel', 'Open subagent monitor: {summary}, {meta}', { summary: viewModel.summaryLabel, meta });
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
      ariaControls: 'subagentInspector', // the controller repoints it at the host that shows the monitor
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

  function markdownRenderer() {
    let utils = globalThis.markdownUtils || null;
    if (!utils && typeof require === 'function') {
      try { utils = require('../shared/markdown-utils'); } catch (_error) { utils = null; }
    }
    return typeof utils?.renderMarkdown === 'function' ? utils.renderMarkdown : null;
  }

  // The answer goes through the sanitized markdown pipeline; if it is
  // unavailable the text is escaped, never injected.
  function renderAnswerHtml(text) {
    const render = markdownRenderer();
    const html = render ? render(text, { mermaid: 'plain' }) : '';
    return typeof html === 'string' && html ? html : `<p>${escapeHtml(text)}</p>`;
  }

  function iconButton(id, className, trustedHtml, label) {
    return actionButton({ id, plain: true, className, trustedHtml, ariaLabel: label, title: label, dataset: { [id]: 'true' } });
  }

  // The header's trailing action cluster: the close control.
  function headerActions() {
    const close = iconButton('subagent-close', 'subagent-monitor-icon-button', ICON_CLOSE, jt('chat.subagentMonitor.closeAriaLabel', 'Close subagent monitor'));
    return `<div class="subagent-monitor-header-actions">${close}</div>`;
  }

  function backButton() {
    const html = ICON_BACK + `<span>${escapeHtml(jt('chat.subagentMonitor.subagents', 'Subagents'))}</span>`;
    return iconButton('subagent-back', 'subagent-monitor-back', html, jt('chat.subagentMonitor.backAriaLabel', 'Back to subagent list'));
  }

  function emptyBody() {
    return '<div class="subagent-monitor-body"><div class="subagent-monitor-empty">'
      + escapeHtml(jt('chat.subagentMonitor.detailsUnavailable', 'Details unavailable.')) + '</div></div>';
  }

  function stepCountLabel(count) {
    return jtn('chat.subagentMonitor.stepCount', count, { count }, '{count} step', '{count} steps');
  }

  function tokenLabel(count) {
    return Number.isSafeInteger(count)
      ? jt('chat.subagentMonitor.tokenCount', '{count} tokens', { count: modelUtils.formatTokens?.(count) })
      : jt('chat.subagentMonitor.tokensNotReported', 'Tokens not reported');
  }

  // Elapsed text the controller's one-second tick updates in place. A finished
  // child's is static (no live marker).
  function elapsedSpan(ms, liveId) {
    const text = modelUtils.formatElapsed?.(ms) || '';
    if (!text) return '';
    return liveId
      ? `<span data-subagent-live-elapsed="${escapeHtml(liveId)}">${escapeHtml(text)}</span>`
      : `<span>${escapeHtml(text)}</span>`;
  }

  // A child's elapsed time: live for a running child, static once finished.
  function childElapsed(child, fallbackMs = 0) {
    return elapsedSpan(child.elapsedMs || fallbackMs, child.terminal ? '' : `child:${child.key}`);
  }

  function treeHeaderMeta(viewModel) {
    if (viewModel.parentStateKey === 'waiting') {
      return jt('chat.subagentMonitor.waitingOnCount', 'Waiting on {running} of {total}', {
        running: viewModel.runningCount, total: viewModel.childCount,
      });
    }
    return viewModel.parentState;
  }

  function renderTreeHeader(viewModel, idSuffix) {
    return '<div class="subagent-monitor-header">'
      + ICON_TREE
      + `<h2 class="subagent-monitor-title" id="subagentInspectorTitle${escapeHtml(idSuffix)}">${escapeHtml(jt('chat.subagentMonitor.subagents', 'Subagents'))}</h2>`
      + `<span class="subagent-monitor-meta">${escapeHtml(treeHeaderMeta(viewModel))}</span>`
      + headerActions()
      + '</div>';
  }

  // "Completed", "Running", or "Failed · Reached its work limit": the plain
  // state word, refined by the reason copy when the report names one, then
  // the elapsed time and one trailing item (steps in the tree, the model in
  // the drill-in). Escaped; joined by the caller.
  function statusParts(child, trailing = '') {
    const parts = [escapeHtml(child.statusLabel)];
    if (child.terminal && child.terminalCopy !== child.statusLabel) parts.push(escapeHtml(child.terminalCopy));
    const elapsed = childElapsed(child);
    if (elapsed) parts.push(elapsed);
    if (trailing) parts.push(escapeHtml(trailing));
    return parts;
  }

  function renderChildRow(child, selectedKey) {
    const selected = child.key === selectedKey;
    const meta = statusParts(child, child.stepCount ? stepCountLabel(child.stepCount) : '').join(' · ');
    return actionButton({
      id: 'subagent-select',
      plain: true,
      className: 'subagent-tree-item',
      role: 'treeitem',
      tabIndex: selected ? 0 : -1,
      ariaSelected: selected,
      dataset: { 'subagent-select': child.key },
      trustedHtml: stateDot(child.tone)
        + '<span class="subagent-tree-copy">'
        + `<span class="subagent-tree-label">${escapeHtml(child.label)}</span>`
        + `<span class="subagent-tree-meta">${meta}</span>`
        + '</span>'
        + ICON_CHEVRON,
    });
  }

  function renderTreeBody(viewModel) {
    const rows = (viewModel.children || []).map((child) => renderChildRow(child, viewModel.selectedKey)).join('');
    const parentElapsed = elapsedSpan(viewModel.elapsedMs, viewModel.terminal ? '' : 'parent');
    return '<div class="subagent-monitor-body" data-subagent-page="tree">'
      + `<div class="subagent-tree" role="tree" aria-label="${escapeHtml(jt('chat.subagentMonitor.tasksAriaLabel', 'Subagent tasks'))}">`
      + '<div class="subagent-tree-parent" role="treeitem" aria-expanded="true" tabindex="-1">'
      + stateDot(viewModel.terminal ? viewModel.tone : 'pending')
      + '<span class="subagent-tree-parent-name">Jenny</span>'
      + `<span class="subagent-tree-parent-meta">· ${escapeHtml(jt('chat.subagentMonitor.delegatedResearch', 'Delegated research'))}${parentElapsed ? ` · ${parentElapsed}` : ''}</span>`
      + '</div>'
      + `<div class="subagent-tree-children" role="group">${rows}</div>`
      + '</div></div>';
  }

  function renderTreeFooter(viewModel) {
    const parts = [jtn('chat.subagentMonitor.taskCount', viewModel.childCount, { count: viewModel.childCount }, '{count} task', '{count} tasks')];
    if (viewModel.totalSteps > 0) parts.push(stepCountLabel(viewModel.totalSteps));
    parts.push(tokenLabel(viewModel.totalTokens));
    return `<div class="subagent-monitor-footer"><span>${escapeHtml(parts.join(' · '))}</span></div>`;
  }

  function section(title, body) {
    if (!body) return '';
    return '<section class="subagent-detail-section">'
      + `<h3 class="subagent-section-heading">${escapeHtml(title)}</h3>${body}</section>`;
  }

  function renderEvidence(child) {
    if (!child.evidence?.length) return '';
    return '<ul class="subagent-evidence-list">' + child.evidence.map((entry) => {
      const lineRange = entry.line_start
        ? `:${entry.line_start}${entry.line_end !== entry.line_start ? `-${entry.line_end}` : ''}`
        : '';
      const title = entry.relative_path
        ? `${entry.relative_path}${lineRange}`
        : (entry.source_tool || entry.source || jt('chat.subagentMonitor.sectionEvidence', 'Evidence'));
      const description = entry.summary || entry.quote
        || (entry.fact && entry.value ? `${entry.fact}: ${entry.value}` : '');
      const provenance = entry.provenance === 'tool_observed' ? jt('chat.subagentMonitor.toolObserved', 'Tool observed') : '';
      const link = entry.relative_path
        ? `<span class="subagent-evidence-title subagent-evidence-link" role="link" tabindex="0" data-chat-path-open="${escapeHtml(entry.relative_path)}" data-chat-path="${escapeHtml(entry.relative_path)}"${entry.line_start ? ` data-chat-path-line="${escapeHtml(entry.line_start)}"` : ''}>${escapeHtml(title)}</span>`
        : `<span class="subagent-evidence-title">${escapeHtml(title)}</span>`;
      return '<li class="subagent-evidence-item">' + link
        + (description ? `<span class="subagent-evidence-copy">${escapeHtml(description)}</span>` : '')
        + (provenance ? `<span class="subagent-evidence-copy">${escapeHtml(provenance)}</span>` : '')
        + '</li>';
    }).join('') + '</ul>';
  }

  function stepRow(step) {
    const failed = step.ok === false;
    return `<li class="subagent-step subagent-step--${failed ? 'error' : 'ok'}">`
      + stateDot(failed ? 'danger' : 'success')
      + '<span class="subagent-step-copy">'
      + `<span class="subagent-step-name">${escapeHtml(step.display || step.tool)}</span>`
      + (step.target ? `<span class="subagent-step-target">${escapeHtml(step.target)}</span>` : '')
      + (failed && step.detail ? `<span class="subagent-step-detail">${escapeHtml(step.detail)}</span>` : '')
      + '</span></li>';
  }

  function renderSteps(child, idSuffix) {
    if (!child.terminal) {
      return `<p class="subagent-live-summary">${escapeHtml(child.summary)}</p>`
        + `<p class="subagent-step-note">${escapeHtml(jt('chat.subagentMonitor.stepsPending', 'Steps appear when this subagent finishes.'))}</p>`;
    }
    const steps = child.steps || [];
    if (!steps.length) {
      // Reports written before the step log carry only the tool names and a count.
      const note = [...(child.tools || []), child.stepCount ? stepCountLabel(child.stepCount) : ''].filter(Boolean).join(' · ');
      return note ? `<p class="subagent-step-note">${escapeHtml(note)}</p>` : '';
    }
    const unrecorded = Math.max(0, (child.stepCount || 0) - steps.length);
    const rest = steps.slice(VISIBLE_STEP_ROWS);
    let html = `<ol class="subagent-step-list">${steps.slice(0, VISIBLE_STEP_ROWS).map(stepRow).join('')}</ol>`;
    if (rest.length) {
      html += disclosure('steps-more', child, idSuffix, {
        className: 'subagent-more-trigger',
        children: `<span>${escapeHtml(jt('chat.subagentMonitor.stepsMore', '+ {count} more', { count: rest.length }))}</span>`,
      }, {
        className: 'subagent-more-detail',
        children: `<ol class="subagent-step-list">${rest.map(stepRow).join('')}</ol>`,
      });
    }
    if (unrecorded) {
      html += `<p class="subagent-step-note">${escapeHtml(jtn('chat.subagentMonitor.stepsNotRecorded', unrecorded, { count: unrecorded }, '+ {count} step not recorded', '+ {count} steps not recorded'))}</p>`;
    }
    return html;
  }

  // Without an answer the section falls back to the summary (cut and flattened
  // to one line by persistence), titled Summary. A completed child always
  // answers, so its missing answer means a report written before the monitor
  // kept one: say so. A failed child's summary is its error, nothing was lost.
  function renderAnswerSection(child) {
    if (!child.terminal) return '';
    if (child.answer) {
      return section(jt('chat.subagentMonitor.sectionAnswer', 'Answer'), `<div class="subagent-answer">${renderAnswerHtml(child.answer)}</div>`);
    }
    if (!child.summary) return '';
    const notSaved = child.success
      ? `<p class="subagent-step-note">${escapeHtml(jt('chat.subagentMonitor.answerNotSaved', "The full answer wasn't saved for this run."))}</p>`
      : '';
    return section(jt('chat.subagentMonitor.sectionSummary', 'Summary'), `<div class="subagent-answer">${renderAnswerHtml(child.summary)}</div>${notSaved}`);
  }

  function renderTechnicalDetails(child, idSuffix) {
    if (!child.error) return '';
    const code = String(child.error.code || '').trim();
    return disclosure('error', child, idSuffix, {
      className: 'subagent-technical-trigger',
      children: `<span>${escapeHtml(jt('chat.subagentMonitor.technicalDetails', 'Technical details{code}', { code: code ? ` · ${code}` : '' }))}</span><span class="subagent-disclosure-label">${escapeHtml(jt('chat.subagentMonitor.expand', 'Expand'))}</span>`,
    }, {
      className: 'subagent-technical-detail',
      children: `<p>${escapeHtml(child.error.message || jt('chat.subagentMonitor.noAdditionalDetails', 'No additional details.'))}</p>`
        + `<p>${escapeHtml(child.error.retryable === true ? jt('chat.subagentMonitor.retryableYes', 'Retryable: yes') : jt('chat.subagentMonitor.retryableNo', 'Retryable: no'))}</p>`,
    });
  }

  function renderDetailHeader() {
    return `<div class="subagent-monitor-header">${backButton()}${headerActions()}</div>`;
  }

  function renderDetailBody(viewModel, idSuffix) {
    const child = viewModel.selected;
    if (!child) return emptyBody();
    const status = statusParts(child, child.model);
    const uncertainties = child.uncertainties?.length
      ? `<ul class="subagent-uncertainty-list">${child.uncertainties.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';
    return '<div class="subagent-monitor-body" data-subagent-page="detail">'
      + '<div class="subagent-detail-head">'
      + `<h2 class="subagent-detail-title" id="subagentInspectorTitle${escapeHtml(idSuffix)}">${escapeHtml(child.label)}</h2>`
      + `<div class="subagent-detail-status">${stateDot(child.tone)}<span>${status.join(' · ')}</span></div>`
      + '</div>'
      + section(jt('chat.subagentMonitor.sectionSteps', 'Steps'), renderSteps(child, idSuffix))
      + renderAnswerSection(child)
      + section(jt('chat.subagentMonitor.sectionEvidence', 'Evidence'), renderEvidence(child))
      + section(jt('chat.subagentMonitor.sectionUncertainties', 'Uncertainties'), uncertainties)
      + renderTechnicalDetails(child, idSuffix)
      + '</div>';
  }

  function usageRows(usage) {
    return [
      ['Input', usage.input_tokens], ['Output', usage.output_tokens],
      [jt('chat.subagentMonitor.latestRequest', 'Latest request'), usage.last_request_input_tokens],
      [jt('chat.subagentMonitor.contextEstimate', 'Context estimate'), usage.context_tokens_estimate],
      [jt('chat.subagentMonitor.contextWindow', 'Context window'), usage.context_window],
      [jt('chat.subagentMonitor.compactThreshold', 'Compact threshold'), usage.compact_threshold_tokens],
    ].filter(([, value]) => Number.isSafeInteger(value)).map(([label, value]) => (
      `<span><span>${escapeHtml(label)}</span><strong>${escapeHtml(modelUtils.formatTokens?.(value))}</strong></span>`
    )).join('');
  }

  function renderDetailFooter(viewModel, idSuffix) {
    const child = viewModel.selected;
    if (!child) return '';
    const usage = child.usage || viewModel.usage;
    const elapsed = childElapsed(child, viewModel.elapsedMs);
    const summary = `<span class="subagent-usage-summary">${escapeHtml(tokenLabel(usage?.total_tokens))}${elapsed ? ` · ${elapsed}` : ''}</span>`;
    const rows = usage ? usageRows(usage) : '';
    if (!rows) return `<div class="subagent-monitor-footer">${summary}</div>`;
    const route = [usage.provider, usage.model].filter(Boolean).join(' · ');
    const body = disclosure('usage', child, idSuffix, {
      className: 'subagent-usage-trigger',
      children: summary + `<span class="subagent-disclosure-label">${escapeHtml(jt('chat.subagentMonitor.detailsLabel', 'Details'))}</span>`,
    }, {
      className: 'subagent-usage-detail',
      children: `<div class="subagent-usage-grid">${rows}</div>`
        + (route ? `<div class="subagent-usage-route">${escapeHtml(route)}${usage.estimated ? ' · estimated' : ''}</div>` : ''),
    });
    return `<div class="subagent-monitor-footer">${body || summary}</div>`;
  }

  // The monitor's three fixed regions: a header, ONE scrolling body and a
  // footer. `page` is 'tree' (a delegation's children) or 'detail' (one
  // child). `idSuffix` (a second pane, the dock aside) keeps every rendered
  // id unique.
  function renderMonitor(viewModel, options = {}) {
    if (!viewModel || !viewModel.childCount) {
      return { header: `<div class="subagent-monitor-header">${headerActions()}</div>`, body: emptyBody(), footer: '' };
    }
    const idSuffix = String(options.idSuffix || '');
    return options.page === 'detail'
      ? { header: renderDetailHeader(), body: renderDetailBody(viewModel, idSuffix), footer: renderDetailFooter(viewModel, idSuffix) }
      : { header: renderTreeHeader(viewModel, idSuffix), body: renderTreeBody(viewModel), footer: renderTreeFooter(viewModel) };
  }

  return {
    inlineSummaryMarkup,
    renderLiveSummary,
    renderMonitor,
    renderTerminalSummary,
  };
});
