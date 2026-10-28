(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-subagent-monitor-model'),
      require('./renderer-subagent-monitor-activity'),
      require('../inventory/action-button'),
      require('../inventory/collapsible'),
      require('../inventory/segmented-control')
    );
    return;
  }
  root.rendererSubagentMonitorView = factory(
    root.rendererSubagentMonitorModel || {},
    root.rendererSubagentMonitorActivity || {},
    root.inventoryActionButton,
    root.inventoryCollapsible || {},
    root.inventorySegmentedControl || null
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (modelUtils, activity, actionButton, collapsible, segmentedControl) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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

  // Text goes through the sanitized markdown pipeline; if it is unavailable
  // the text is escaped, never injected.
  function markdownHtml(text) {
    const render = markdownRenderer();
    const html = render ? render(text, { mermaid: 'plain' }) : '';
    return typeof html === 'string' && html ? html : `<p>${escapeHtml(text)}</p>`;
  }

  const answerCache = new Map();
  function renderAnswerHtml(text) {
    if (answerCache.has(text)) return answerCache.get(text);
    const result = markdownHtml(text);
    if (answerCache.size >= 3) answerCache.delete(answerCache.keys().next().value);
    answerCache.set(text, result);
    return result;
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

  const stepCountLabel = (count) => activity.stepCountLabel(count);

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
    const trailing = [child.stepCount ? stepCountLabel(child.stepCount) : ''];
    if (!child.terminal) trailing.push(child.model, child.reasoningEffort, tokenLabel(child.usage?.total_tokens));
    const meta = statusParts(child, trailing.filter(Boolean).join(' · ')).join(' · ');
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
        + (!child.terminal && child.summary ? `<span class="subagent-tree-meta">${escapeHtml(child.summary)}</span>` : '')
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
    if (viewModel.partialUsage) parts.push(jt('chat.subagentMonitor.partialUsage', 'partially reported'));
    return `<div class="subagent-monitor-footer"><span>${escapeHtml(parts.join(' · '))}</span></div>`;
  }

  // `aside` (trusted markup: a count, the Copy button) shares the heading's row.
  function section(title, body, aside = '') {
    if (!body) return '';
    const heading = `<h3 class="subagent-section-heading">${escapeHtml(title)}</h3>`;
    return '<section class="subagent-detail-section">'
      + (aside ? `<div class="subagent-section-head">${heading}${aside}</div>` : heading)
      + `${body}</section>`;
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

  // Without an answer the section falls back to the summary (cut and flattened
  // to one line by persistence), titled Summary. A completed child always
  // answers, so its missing answer means a report written before the monitor
  // kept one: say so. A failed child's summary is its error, nothing was lost.
  function renderAnswerSection(child) {
    if (!child.terminal) {
      if (!child.activity?.text) return '';
      return section(jt('chat.subagentMonitor.liveResponse', 'Live response'),
        `<div class="subagent-answer">${renderAnswerHtml(child.activity.text)}</div>`
        + (child.activity.text_truncated ? `<p class="subagent-step-note">${escapeHtml(jt('chat.subagentMonitor.liveTextTruncated', 'Live text limit reached. The final answer appears when this task finishes.'))}</p>` : ''));
    }
    if (child.answer) {
      const cut = child.answerTruncated
        ? `<p class="subagent-step-note">${escapeHtml(jt('chat.subagentMonitor.answerTruncated', 'Cut at 4,000 characters.'))}</p>`
        : '';
      return section(jt('chat.subagentMonitor.sectionAnswer', 'Answer'),
        `<div class="subagent-answer">${renderAnswerHtml(child.answer)}</div>${cut}`, copyButton(child));
    }
    if (!child.summary) return '';
    const notSaved = child.success
      ? `<p class="subagent-step-note">${escapeHtml(jt('chat.subagentMonitor.answerNotSaved', "The full answer wasn't saved for this run."))}</p>`
      : '';
    return section(jt('chat.subagentMonitor.sectionSummary', 'Summary'), `<div class="subagent-answer">${renderAnswerHtml(child.summary)}</div>${notSaved}`);
  }

  // Copies the saved answer (the controller writes it; the status span
  // announces the result).
  function copyButton(child) {
    const label = jt('chat.subagentMonitor.copyAnswer', 'Copy answer');
    return actionButton({
      id: 'subagent-copy', plain: true, className: 'subagent-monitor-icon-button subagent-copy-button',
      ariaLabel: label, title: label, dataset: { 'subagent-copy': child.key },
      trustedHtml: `<span>${escapeHtml(jt('chat.subagentMonitor.copy', 'Copy'))}</span>`,
    }) + '<span class="sr-only" role="status" data-subagent-copy-status></span>';
  }

  // The Copy click: writes the saved answer through the shell clipboard and
  // says so in the button's status span; the word reverts after a moment.
  function copyAnswer(button, text, windowRef) {
    const clipboard = windowRef?.jennyShell?.clipboard || windowRef?.navigator?.clipboard;
    if (!text || typeof clipboard?.writeText !== 'function') return;
    const status = button.parentElement?.querySelector?.('[data-subagent-copy-status]');
    const label = button.querySelector?.('span');
    const show = (statusText, labelText) => {
      if (status?.isConnected) status.textContent = statusText;
      if (label?.isConnected) label.textContent = labelText;
    };
    const copyWord = jt('chat.subagentMonitor.copy', 'Copy');
    Promise.resolve().then(() => clipboard.writeText(text)).then(() => {
      const copied = jt('chat.subagentMonitor.copied', 'Copied');
      show(copied, copied);
      windowRef.setTimeout?.(() => show('', copyWord), 1600);
    }, () => show(jt('chat.subagentMonitor.copyFailed', 'Could not copy the answer.'), copyWord));
  }

  // The full task the parent wrote; one the title already says in full is not repeated.
  function renderTask(child, idSuffix) {
    if (child.prompt === child.label) return '';
    return section(jt('chat.subagentMonitor.sectionTask', 'Task'), activity.taskBody(child, idSuffix, helpers, 'task'));
  }

  // The pieces the activity module (Steps, Transcript) shares with this view.
  const helpers = { stateDot, disclosure, section, renderEvidence, renderMarkdown: markdownHtml, renderAnswer: renderAnswerSection };

  // Overview | Transcript, for a child that recorded a transcript.
  function viewSwitch(child, transcript) {
    return segmentedControl?.({
      id: 'subagent-view',
      ariaLabel: jt('chat.subagentMonitor.viewAriaLabel', 'Subagent view'),
      value: transcript ? 'transcript' : 'overview',
      className: 'subagent-view-switch',
      dataset: { 'subagent-view': child.key },
      options: [
        { value: 'overview', label: jt('chat.subagentMonitor.viewOverview', 'Overview') },
        { value: 'transcript', label: jt('chat.subagentMonitor.viewTranscript', 'Transcript') },
      ],
    }) || '';
  }

  // "Reached its step limit (10 of 10)": the child spent every model turn.
  function stepLimitNote(child) {
    if (!child.stepLimit) return '';
    return `<p class="subagent-detail-note">${stateDot('warning')}<span>${escapeHtml(jt('chat.subagentMonitor.stepLimitReached',
      'Reached its step limit ({used} of {max}). The answer may be incomplete.', child.stepLimit))}</span></p>`;
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

  function renderDetailBody(viewModel, idSuffix, transcriptKeys) {
    const child = viewModel.selected;
    if (!child) return emptyBody();
    // A running child gets the switch before its first entry, so it does not appear mid-run.
    const hasTranscript = child.transcript?.length > 0 || !child.terminal;
    const showTranscript = hasTranscript && transcriptKeys?.has?.(child.key) === true;
    const status = statusParts(child, [child.model, child.reasoningEffort].filter(Boolean).join(' · '));
    const uncertainties = child.uncertainties?.length
      ? `<ul class="subagent-uncertainty-list">${child.uncertainties.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';
    return '<div class="subagent-monitor-body" data-subagent-page="detail">'
      + '<div class="subagent-detail-head">'
      + `<h2 class="subagent-detail-title" id="subagentInspectorTitle${escapeHtml(idSuffix)}">${escapeHtml(child.label)}</h2>`
      + `<div class="subagent-detail-status">${stateDot(child.tone)}<span>${status.join(' · ')}</span></div>`
      + stepLimitNote(child)
      + (hasTranscript ? viewSwitch(child, showTranscript) : '')
      + '</div>'
      + (showTranscript ? activity.renderTranscript(child, idSuffix, helpers) : renderTask(child, idSuffix)
        + renderAnswerSection(child)
        + section(jt('chat.subagentMonitor.sectionSteps', 'Steps'), activity.renderSteps(child, idSuffix, helpers),
          child.stepCount ? `<span class="subagent-section-meta">${escapeHtml(stepCountLabel(child.stepCount))}</span>` : '')
        + section(jt('chat.subagentMonitor.sectionEvidence', 'Evidence'), renderEvidence(child))
        + section(jt('chat.subagentMonitor.sectionUncertainties', 'Uncertainties'), uncertainties))
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
    // The child's own accounting only: the batch subtotal stays in the tree footer.
    const usage = child.usage || null;
    const elapsed = childElapsed(child, viewModel.elapsedMs);
    const estimate = child.terminal ? null : child.activity?.visible_output_tokens_estimate;
    const estimateText = Number.isSafeInteger(estimate)
      ? jt('chat.subagentMonitor.liveTokenEstimate', '~{count} visible-output tokens (current response)', { count: modelUtils.formatTokens?.(estimate) }) : '';
    const partial = usage?.partial ? ` · ${escapeHtml(jt('chat.subagentMonitor.partialUsage', 'partially reported'))}` : '';
    const summary = `<span class="subagent-usage-summary">${escapeHtml(tokenLabel(usage?.total_tokens))}${partial}${elapsed ? ` · ${elapsed}` : ''}${estimateText ? `<span class="subagent-live-estimate">${escapeHtml(estimateText)}</span>` : ''}</span>`;
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
      ? { header: renderDetailHeader(), body: renderDetailBody(viewModel, idSuffix, options.transcriptKeys), footer: renderDetailFooter(viewModel, idSuffix) }
      : { header: renderTreeHeader(viewModel, idSuffix), body: renderTreeBody(viewModel), footer: renderTreeFooter(viewModel) };
  }

  // Keep unchanged nodes (including selected live text) through activity frames.
  function updateMarkup(host, html) {
    const template = host.ownerDocument.createElement('template');
    template.innerHTML = html;
    const selection = host.ownerDocument.defaultView?.getSelection?.();
    const selected = selection && !selection.isCollapsed ? selection.anchorNode : null;
    function patch(parent, incoming) {
      const previous = [...parent.childNodes];
      [...incoming.childNodes].forEach((next, index) => {
        const current = previous[index];
        if (!current) { parent.append(next.cloneNode(true)); return; }
        if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
          current.replaceWith(next.cloneNode(true)); return;
        }
        if (current.nodeType === 3) {
          if (current.nodeValue !== next.nodeValue && current !== selected) current.nodeValue = next.nodeValue;
          return;
        }
        if (current.nodeType !== 1 || current.isEqualNode(next)) return;
        if (selected && current.classList.contains('subagent-answer') && current.contains(selected)) return;
        for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        patch(current, next);
      });
      previous.slice(incoming.childNodes.length).forEach((node) => node.remove());
    }
    patch(host, template.content);
  }

  function preserveLiveState(host, write) {
    const body = host?.querySelector?.('.subagent-monitor-body');
    const page = body?.getAttribute?.('data-subagent-page');
    const scrollTop = Number(body?.scrollTop || 0);
    const active = host?.ownerDocument?.activeElement;
    const focusAttribute = ['data-inv-collapsible', 'data-subagent-select', 'data-subagent-back', 'data-subagent-close', 'data-subagent-copy'].find((name) => host?.contains?.(active) && active?.hasAttribute?.(name));
    const focusedId = focusAttribute ? active.getAttribute(focusAttribute) : null;
    const open = new Set([...(host?.querySelectorAll?.('[data-inv-collapsible][aria-expanded="true"]') || [])]
      .map((el) => el.getAttribute('data-inv-collapsible')));
    write();
    const nextBody = host?.querySelector?.('.subagent-monitor-body');
    for (const el of host?.querySelectorAll?.('[data-inv-collapsible]') || []) {
      const id = el.getAttribute('data-inv-collapsible');
      if (open.has(id)) {
        el.setAttribute('aria-expanded', 'true');
        const content = host.ownerDocument?.getElementById?.(id);
        if (content && host.contains(content)) {
          content.hidden = false;
          content.setAttribute('data-state', 'open');
          content.classList?.add('expanded');
        }
      }

    }
    const focusTarget = focusAttribute && [...host.querySelectorAll(`[${focusAttribute}]`)].find((el) => el.getAttribute(focusAttribute) === focusedId);
    if (focusTarget && focusTarget !== host.ownerDocument.activeElement) focusTarget.focus?.({ preventScroll: true });
    if (nextBody && nextBody.getAttribute('data-subagent-page') === page) nextBody.scrollTop = scrollTop;
  }

  return {
    copyAnswer,
    inlineSummaryMarkup,
    renderLiveSummary,
    renderMonitor,
    renderTerminalSummary,
    preserveLiveState,
    updateMarkup,
  };
});
