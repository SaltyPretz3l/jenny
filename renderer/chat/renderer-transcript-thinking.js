(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-agent-step-utils'),
      require('./renderer-transcript-reasoning-v2'),
      require('./renderer-subagent-monitor-view'),
      require('./renderer-error-recovery-utils'),
      require('../inventory/action-button')
    );
    return;
  }
  root.rendererTranscriptThinkingUtils = factory(
    root.rendererAgentStepUtils || {},
    root.rendererTranscriptReasoningV2 || {},
    root.rendererSubagentMonitorView || {},
    root.rendererErrorRecoveryUtils,
    root.inventoryActionButton
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (agentStepUtils, reasoningV2Utils, subagentView, rendererErrorRecoveryUtils, inventoryActionButton) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const createReasoningV2RendererFn = typeof reasoningV2Utils?.createReasoningV2Renderer === 'function'
    ? reasoningV2Utils.createReasoningV2Renderer
    : null;
  const sharedResolveAgentStepDisplay = typeof agentStepUtils.resolveAgentStepDisplay === 'function'
    ? agentStepUtils.resolveAgentStepDisplay
    : null;
  const sharedHumanizeStage = typeof agentStepUtils.humanizeStage === 'function'
    ? agentStepUtils.humanizeStage
    : null;
  const sharedFormatElapsed = typeof agentStepUtils.formatElapsed === 'function'
    ? agentStepUtils.formatElapsed
    : null;
  const actionButton = typeof inventoryActionButton === 'function' ? inventoryActionButton : null;

  /* DOM id for a notice's expanded body. Message ids are opaque strings, so
     anything outside the HTML id-safe set collapses to '-' and an id that does
     not start with a letter gets the 'cc-body-' prefix it needs anyway. */
  function compactionBodyId(messageId) {
    const slug = String(messageId || '').replace(/[^A-Za-z0-9_.:-]/g, '-') || 'notice';
    return `cc-body-${slug}`;
  }

  function createTranscriptThinkingRenderer(deps) {
    const { escapeHtml } = deps || {};
    /* Expansion state is owned by the renderer, not the DOM: the timeline
       re-renders by innerHTML, so the open/closed flag has to be stamped from
       state on every render or a second compaction snaps the body shut. */
    const isContextCompactionExpanded = typeof deps?.isContextCompactionExpanded === 'function'
      ? deps.isContextCompactionExpanded
      : function noContextCompactionExpansion() { return false; };

    /* Thin adapter over the unified timeline error card
     * (rendererErrorRecoveryUtils.renderEnhancedFailureNotice). */
    function renderAssistantFailureNotice(message) {
      const errorText = String(message?.stream_error || '').trim();
      if (!errorText) {
        return '';
      }
      return rendererErrorRecoveryUtils.renderEnhancedFailureNotice(message);
    }

    const resolveAgentStepDisplay = sharedResolveAgentStepDisplay || function fallbackResolveAgentStepDisplay(step) {
      if (step && step.terminal === true && step.success === true) return { state: 'ok', dot: 'ok' };
      if (step && step.terminal === true && step.success !== true) return { state: 'error', dot: 'error' };
      const status = String((step && step.status) || '').trim().toLowerCase();
      if (status === 'running') return { state: 'active', dot: 'active' };
      if (status === 'failed') return { state: 'error', dot: 'error' };
      return { state: 'pending', dot: 'pending' };
    };
    const humanizeStage = sharedHumanizeStage || function fallbackHumanizeStage(raw) {
      return String(raw || '').trim().replace(/_/g, ' ');
    };
    const formatElapsed = sharedFormatElapsed || function fallbackFormatElapsed() { return ''; };

    function renderAgentStatusWidget(message) {
      const lifecycle =
        message?.agent_status && typeof message.agent_status === 'object' && !Array.isArray(message.agent_status)
          ? message.agent_status
          : null;
      const steps = Array.isArray(message?.agent_status_steps) ? message.agent_status_steps : [];
      if (!lifecycle && steps.length === 0) {
        return '';
      }
      const subagentSteps = steps.filter((step) => (
        String(step?.taskType || step?.task_type || '') === 'sub_agent'
        || /^(delegate|subagent_(run|batch))$/.test(String(step?.source || ''))
      ));
      if (subagentSteps.length && typeof subagentView.renderLiveSummary === 'function') {
        return subagentView.renderLiveSummary(subagentSteps);
      }
      const label = jt('chat.thinking.companionTask', 'Companion task');

      if (steps.length >= 1) {
        const lastStep = steps[steps.length - 1];
        const wrapperDisplay = resolveAgentStepDisplay(lastStep);
        const stepsHtml = steps.map((step) => {
          const display = resolveAgentStepDisplay(step);
          const stage = humanizeStage(step.stage) || jt('chat.thinking.workingStage', 'Working');
          const summary = String(step.summary || '').trim() || jt('chat.thinking.working', 'Working on it.');
          const percent = Number.isFinite(Number(step.percent))
            ? Math.min(100, Math.max(0, Math.round(Number(step.percent))))
            : null;
          const elapsed = formatElapsed(step);
          const metaParts = [];
          if (percent != null) { metaParts.push(`${percent}%`); }
          if (elapsed) { metaParts.push(elapsed); }
          const meta = metaParts.join(' - ');
          return `
            <li
              class="agent-status-step"
              data-agent-status-step-state="${escapeHtml(display.state)}"
              data-agent-status-step-terminal="${step.terminal === true ? 'true' : 'false'}"
            >
              <span class="status-dot status-dot--${escapeHtml(display.dot)}" aria-hidden="true"></span>
              <div class="agent-status-step-body">
                <div class="agent-status-step-stage">${escapeHtml(stage)}</div>
                <div class="agent-status-step-summary">${escapeHtml(summary)}</div>
                ${meta ? `<div class="agent-status-step-meta">${escapeHtml(meta)}</div>` : ''}
              </div>
            </li>
          `;
        }).join('');
        return `
          <div
            class="agent-status-note agent-status-note--steps"
            data-agent-status-state="${escapeHtml(wrapperDisplay.state)}"
            role="status"
            aria-live="polite"
          >
            <div class="agent-status-note-label kicker">${escapeHtml(label)}</div>
            <ol class="agent-status-step-list" role="list">${stepsHtml}</ol>
          </div>
        `;
      }

      const summary = String(lifecycle.summary || '').trim() || jt('chat.thinking.working', 'Working on it.');
      const stage = humanizeStage(lifecycle.stage);
      const percent = Number.isFinite(Number(lifecycle.percent))
        ? Math.min(100, Math.max(0, Math.round(Number(lifecycle.percent))))
        : null;
      const meta = [stage, percent != null ? `${percent}%` : '']
        .filter(Boolean)
        .join(' - ');
      return `
        <div
          class="agent-status-note"
          data-agent-status-state="${escapeHtml(String(lifecycle.status || 'running'))}"
          role="status"
          aria-live="polite"
        >
          <div class="agent-status-note-label">${escapeHtml(label)}</div>
          <div class="agent-status-note-summary">${escapeHtml(summary)}</div>
          ${meta ? `<div class="agent-status-note-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
      `;
    }

    const v2Renderer = createReasoningV2RendererFn ? createReasoningV2RendererFn(deps) : null;

    function renderThinkingWidget(message, latestAssistantMessageId) {
      if (v2Renderer) {
        return v2Renderer.renderThinkingWidget(message, latestAssistantMessageId);
      }
      return '';
    }

    function describeCompaction(compaction) {
      const summaryStatus = String(compaction?.summaryStatus || '');
      const phase = String(compaction?.phase || '');
      const strategy = String(compaction?.strategy || '');
      const reasonCode = String(compaction?.reasonCode || '');
      const scope = String(compaction?.historyScopeFallback || '');
      let variant = jt('chat.thinking.olderContextReduced', 'Older context was reduced to fit this request');
      if (summaryStatus === 'created') {
        variant = phase === 'tool_loop'
          ? jt('chat.thinking.workingMemorySummarized', 'Working memory was summarized mid-task to keep going')
          : compaction.summaryPersisted
            ? jt('chat.thinking.olderTurnsSummarizedFuture', 'Older turns were summarized for this request and future turns')
            : jt('chat.thinking.olderTurnsSummarized', 'Older turns were summarized for this request');
      } else if (summaryStatus === 'not_applicable') {
        variant = jt('chat.thinking.olderContextTrimmed', 'Older context was trimmed to fit this request');
      } else if (summaryStatus === 'failed') {
        variant = jt('chat.thinking.automaticSummarizationFailedFallback', 'Automatic summarization failed; a bounded fallback was used');
      } else if (strategy === 'narrowed' && scope) {
        variant = scope === 'recent' ? jt('chat.thinking.historyNarrowedRecent', 'Request history was narrowed to the last 6 turns') : jt('chat.thinking.historyNarrowedPrompt', 'Request history was narrowed to the new prompt only');
      } else if (strategy === 'narrowed' || reasonCode === 'semantic_history_limit') {
        variant = jt('chat.thinking.olderTurnsOmitted', 'Older complete turns were omitted to fit the context limit');
      }
      const tier = summaryStatus === 'created'
        ? jt('chat.thinking.summarizedWithModel', 'Summarized older context with the model')
        : summaryStatus === 'not_applicable'
          ? jt('chat.thinking.trimmedWithoutSummarizing', 'Trimmed without summarizing')
          : summaryStatus === 'failed'
            ? jt('chat.thinking.summarizerFailedFallback', 'Summarizer failed; used a bounded fallback')
            : jt('chat.thinking.reducedToFit', 'Reduced to fit');
      const details = [variant, tier];
      if (phase === 'preflight') {
        details.push(jt('chat.thinking.beforeRequest', 'Before sending the request'));
      } else if (phase === 'tool_loop') {
        details.push(jt('chat.thinking.insideToolLoop', 'Mid-task, inside the tool loop'));
      }
      const droppedMessages = Math.max(0, Number(compaction?.droppedMessages || 0) || 0);
      const droppedBytes = Math.max(0, Number(compaction?.droppedBytes || 0) || 0);
      const folded = [
        droppedMessages > 0 ? jtn('chat.thinking.compactedMessages', droppedMessages, { count: droppedMessages.toLocaleString(globalThis.jennyI18n?.tag?.()) }, '{count} message', '{count} messages') : '',
        droppedBytes > 0 ? jtn('chat.thinking.compactedBytes', droppedBytes, { count: droppedBytes.toLocaleString(globalThis.jennyI18n?.tag?.()) }, '{count} byte', '{count} bytes') : '',
      ].filter(Boolean);
      if (folded.length) {
        details.push(jt('chat.thinking.foldedSummary', 'Folded {summary}', { summary: folded.join(' / ') }));
      }
      details.push(compaction?.summaryPersisted === true
        ? jt('chat.thinking.summarySaved', 'Summary saved for future turns')
        : jt('chat.thinking.requestOnly', 'Applied to this request only'));
      if (compaction?.inputComplete === false) {
        details.push(jt('chat.thinking.summarizerInputOmitted', 'Some older messages were omitted from the summarizer input'));
      }
      return details;
    }

    /* Local time for a compaction entry, or '' when it carries no usable
       occurredAt. Doubles as the row key in the multi-compaction breakdown. */
    function compactionStamp(entry) {
      const occurredAt = String(entry?.occurredAt || '');
      if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
        return '';
      }
      return new Date(occurredAt).toLocaleTimeString(globalThis.jennyI18n?.tag?.(), {
        hour: '2-digit',
        ...globalThis.jennyI18n?.timeOptions?.(),
        minute: '2-digit',
        second: '2-digit',
      });
    }

    function compactionTokenPair(entry) {
      const before = Number(entry?.tokensBefore || 0) || 0;
      const after = Number(entry?.tokensAfter || 0) || 0;
      if (!(before > 0 && after > 0 && after < before)) {
        return '';
      }
      return jt('chat.thinking.tokensBeforeAfter', '{before} → {after} tokens', {
        before: before.toLocaleString(globalThis.jennyI18n?.tag?.()),
        after: after.toLocaleString(globalThis.jennyI18n?.tag?.()),
      });
    }

    function compactionBodyRow(key, value, valueClass = 'context-compacted-notice-value') {
      return `
            <div class="context-compacted-notice-row"><span class="context-compacted-notice-key">${escapeHtml(key)}</span><span class="${valueClass}">${escapeHtml(value)}</span></div>`;
    }

    /* The on-demand body: one key/value row per compaction when the turn
       compacted more than once, otherwise the describeCompaction lines. */
    function renderCompactionBody(list, bodyId, expanded) {
      let rows;
      if (list.length > 1) {
        const latestIndex = list.length - 1;
        rows = list.map((entry, index) => {
          const position = index === latestIndex
            ? jt('chat.thinking.compactionLatest', 'Compaction {index} (latest)', { index: index + 1 })
            : jt('chat.thinking.compaction', 'Compaction {index}', { index: index + 1 });
          const details = describeCompaction(entry);
          const description = [details[0], compactionTokenPair(entry), ...details.slice(1)]
            .filter(Boolean)
            .join(' · ');
          const stamp = compactionStamp(entry);
          // With a timestamp the stamp becomes the row key and the ordinal
          // moves into the value, so no entry loses its place in the order.
          return stamp
            ? compactionBodyRow(stamp, jt('chat.thinking.compactionEntry', '{position}: {description}', { position, description }))
            : compactionBodyRow(position, description);
        }).join('');
        const latestSummary = String(list[latestIndex]?.summaryExcerpt || '');
        if (latestSummary) {
          rows += compactionBodyRow(jt('chat.thinking.compactionSummaryKey', 'Summary'), latestSummary, 'context-compacted-notice-summary');
        }
      } else {
        const entry = list[0];
        const stamp = compactionStamp(entry);
        const pair = compactionTokenPair(entry);
        const summary = String(entry?.summaryExcerpt || '');
        rows = [
          stamp ? compactionBodyRow(jt('chat.thinking.compactionTimeKey', 'Time'), stamp) : '',
          pair ? compactionBodyRow(jt('chat.thinking.compactionTokensKey', 'Tokens'), pair) : '',
          compactionBodyRow(jt('chat.thinking.compactionHowKey', 'How'), describeCompaction(entry).join(' · ')),
          summary ? compactionBodyRow(jt('chat.thinking.compactionSummaryKey', 'Summary'), summary, 'context-compacted-notice-summary') : '',
        ].filter(Boolean).join('');
      }
      return `
          <div class="context-compacted-notice-body" id="${escapeHtml(bodyId)}" role="region"${expanded ? '' : ' hidden'}>${rows}
            <div class="context-compacted-notice-foot">${escapeHtml(jt('chat.thinking.transcriptIntact', 'Your transcript is intact. Compaction only changes what is sent to the model.'))}</div>
          </div>`;
    }

    function renderContextCompactedNotice(message) {
      const contextCompactions = Array.isArray(message?.context_compactions)
        ? message.context_compactions.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        : [];
      const fallbackCompacted = message?.context_compacted;
      const list = contextCompactions.length
        ? contextCompactions
        : fallbackCompacted && typeof fallbackCompacted === 'object' && !Array.isArray(fallbackCompacted)
          ? [fallbackCompacted]
          : [];
      if (!list.length) {
        return '';
      }
      const compacted = list[list.length - 1];
      // Only the latest compaction's pair rides the line. The old aggregate
      // "saved" figure summed independent before/after deltas measured at
      // different moments, so it never reconciled with the pair beside it; the
      // per-compaction numbers live in the body instead.
      const latestPair = compactionTokenPair(compacted);
      const label = jt('chat.thinking.contextCompacted', 'Context compacted');
      // One aggregated notice with an expandable body is intentional: the
      // existing projector contract has one single-slot row, while stacking
      // compactions would require a new row kind.
      const countToken = list.length > 1
        ? jtn('chat.thinking.compactionCount', list.length, { count: list.length.toLocaleString(globalThis.jennyI18n?.tag?.()) }, '{count} compaction', '{count} compactions')
        : '';
      const separator = '<span class="context-compacted-notice-sep" aria-hidden="true">·</span>';
      const statusParts = [
        `<span class="context-compacted-notice-label">${escapeHtml(label)}</span>`,
        countToken ? `<span class="context-compacted-notice-meta">${escapeHtml(countToken)}</span>` : '',
        latestPair ? `<span class="context-compacted-notice-meta">${escapeHtml(latestPair)}</span>` : '',
      ].filter(Boolean).join(separator);
      const messageId = String(message?.id || '');
      const bodyId = compactionBodyId(messageId);
      const expanded = isContextCompactionExpanded(messageId) === true;
      const toggle = actionButton ? actionButton({
        plain: true,
        className: 'context-compacted-notice-toggle',
        id: 'context-compaction-details',
        label: jt('chat.thinking.howThisWorked', 'How this worked'),
        ariaExpanded: expanded ? 'true' : 'false',
        ariaControls: bodyId,
        dataset: { 'message-id': messageId },
      }) : '';
      // The live region holds only the one-line status. role="status" is
      // atomic, so keeping the toggle and the body outside it means a later
      // compaction re-announces the label and numbers, not the whole list.
      return `
        <div class="context-compacted-notice" data-timeline-divider="context-compacted">
          <span class="context-compacted-notice-line" aria-hidden="true"></span>
          <span class="context-compacted-notice-chip">
            <span class="context-compacted-notice-status" role="status" aria-live="polite">${statusParts}</span>
            ${toggle ? `${separator}${toggle}` : ''}
          </span>
          <span class="context-compacted-notice-line" aria-hidden="true"></span>
          ${renderCompactionBody(list, bodyId, expanded)}
        </div>
      `;
    }

    return {
      renderAgentStatusWidget,
      renderAssistantFailureNotice,
      renderContextCompactedNotice,
      renderThinkingWidget,
    };
  }

  return {
    createTranscriptThinkingRenderer,
    compactionBodyId,
  };
});
