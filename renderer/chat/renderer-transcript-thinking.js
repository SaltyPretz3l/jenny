(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-agent-step-utils'),
      require('./renderer-transcript-reasoning-v2'),
      require('./renderer-subagent-monitor-view'),
      require('./renderer-error-recovery-utils')
    );
    return;
  }
  root.rendererTranscriptThinkingUtils = factory(
    root.rendererAgentStepUtils || {},
    root.rendererTranscriptReasoningV2 || {},
    root.rendererSubagentMonitorView || {},
    root.rendererErrorRecoveryUtils
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (agentStepUtils, reasoningV2Utils, subagentView, rendererErrorRecoveryUtils) {
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

  function createTranscriptThinkingRenderer(deps) {
    const { escapeHtml } = deps || {};

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
      const label = 'Companion task';

      if (steps.length >= 1) {
        const lastStep = steps[steps.length - 1];
        const wrapperDisplay = resolveAgentStepDisplay(lastStep);
        const stepsHtml = steps.map((step) => {
          const display = resolveAgentStepDisplay(step);
          const stage = humanizeStage(step.stage) || 'Working';
          const summary = String(step.summary || '').trim() || 'Working on it.';
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

      const summary = String(lifecycle.summary || '').trim() || 'Working on it.';
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
      const tier = summaryStatus === 'created'
        ? 'Summarized older context with the model'
        : summaryStatus === 'not_applicable'
          ? 'Trimmed without summarizing'
          : summaryStatus === 'failed'
            ? 'Summarizer failed; used a bounded fallback'
            : 'Reduced to fit';
      const details = [tier];
      if (phase === 'preflight') {
        details.push('Before sending the request');
      } else if (phase === 'tool_loop') {
        details.push('Mid-task, inside the tool loop');
      }
      const droppedMessages = Math.max(0, Number(compaction?.droppedMessages || 0) || 0);
      const droppedBytes = Math.max(0, Number(compaction?.droppedBytes || 0) || 0);
      const folded = [
        droppedMessages > 0 ? `${droppedMessages.toLocaleString()} messages` : '',
        droppedBytes > 0 ? `${droppedBytes.toLocaleString()} bytes` : '',
      ].filter(Boolean);
      if (folded.length) {
        details.push(`Folded ${folded.join(' / ')}`);
      }
      details.push(compaction?.summaryPersisted === true
        ? 'Summary saved for future turns'
        : 'Applied to this request only');
      if (compaction?.inputComplete === false) {
        details.push('Some older messages were omitted from the summarizer input');
      }
      return details;
    }

    function renderCompactionDetails(list) {
      let detailItems;
      if (list.length > 1) {
        const latestIndex = list.length - 1;
        const breakdown = list.map((entry, index) => {
          const occurredAt = String(entry?.occurredAt || '');
          const stamp = occurredAt && Number.isFinite(Date.parse(occurredAt))
            ? new Date(occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : '';
          const position = `Compaction ${index + 1}${index === latestIndex ? ' (latest)' : ''}`;
          const time = stamp ? ` at ${stamp}` : '';
          const before = Number(entry?.tokensBefore || 0) || 0;
          const after = Number(entry?.tokensAfter || 0) || 0;
          const tokens = before > 0 && after > 0 && after < before
            ? `${before.toLocaleString()} → ${after.toLocaleString()} tokens (${(before - after).toLocaleString()} saved) · `
            : '';
          const description = tokens + describeCompaction(entry).join(' · ');
          return `<li class="context-compacted-notice-breakdown-item">${escapeHtml(`${position}${time}: ${description}`)}</li>`;
        }).join('');
        detailItems = `
          <li>
            Compactions in order
            <ul class="context-compacted-notice-breakdown">${breakdown}</ul>
          </li>
        `;
      } else {
        detailItems = describeCompaction(list[0])
          .map((detail) => `<li>${escapeHtml(detail)}</li>`)
          .join('');
      }
      return `
        <details class="context-compacted-notice-details">
          <summary>How this worked</summary>
          <ul>
            ${detailItems}
            <li>Your transcript is intact. Compaction only changes what is sent to the model.</li>
          </ul>
        </details>
      `;
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
      const tokensBefore = Number(compacted.tokensBefore || 0) || 0;
      const tokensAfter = Number(compacted.tokensAfter || 0) || 0;
      const aggregateSaved = list.reduce((total, entry) => {
        const before = Number(entry.tokensBefore || 0) || 0;
        const after = Number(entry.tokensAfter || 0) || 0;
        return total + (before > 0 && after > 0 && after < before ? before - after : 0);
      }, 0);
      // The pair describes the latest compaction; the saved figure is the sum
      // over the whole list and keeps its own guard so an earlier compaction's
      // savings survive a latest entry that reports no usable token pair.
      const latestPair = tokensBefore > 0 && tokensAfter > 0 && tokensAfter < tokensBefore
        ? `${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens`
        : '';
      const meta = [latestPair, aggregateSaved > 0 ? `${aggregateSaved.toLocaleString()} saved` : '']
        .filter(Boolean)
        .join(' · ');
      const strategy = String(compacted.strategy || '');
      const summaryStatus = String(compacted.summaryStatus || '');
      const reasonCode = String(compacted.reasonCode || '');
      const scope = String(compacted.historyScopeFallback || '');
      const phase = String(compacted.phase || '');
      let label = 'Older context was reduced to fit this request';
      if (summaryStatus === 'created') {
        label = phase === 'tool_loop'
          ? 'Working memory was summarized mid-task to keep going'
          : compacted.summaryPersisted
            ? 'Older turns were summarized for this request and future turns'
            : 'Older turns were summarized for this request';
      } else if (summaryStatus === 'not_applicable') {
        label = 'Older context was trimmed to fit this request';
      } else if (summaryStatus === 'failed') {
        label = 'Automatic summarization failed; a bounded fallback was used';
      } else if (strategy === 'narrowed' && scope) {
        label = `Request history was narrowed to ${scope === 'recent' ? 'the last 6 turns' : 'the new prompt only'}`;
      } else if (strategy === 'narrowed' || reasonCode === 'semantic_history_limit') {
        label = 'Older complete turns were omitted to fit the context limit';
      }
      // One aggregated notice with an expandable breakdown is intentional: the
      // existing projector contract has one single-slot row, while stacking
      // compactions would require a new row kind.
      const count = list.length > 1
        ? `<span class="context-compacted-notice-count">×${escapeHtml(list.length.toLocaleString())}</span>`
        : '';
      // The live region holds only the one-line status. role="status" is
      // atomic, so keeping the <details> breakdown outside it means a later
      // compaction re-announces the label and numbers, not the whole list.
      return `
        <div class="context-compacted-notice">
          <div class="context-compacted-notice-status" role="status" aria-live="polite">
            <span class="context-compacted-notice-icon" aria-hidden="true"></span>
            <span class="context-compacted-notice-label">${escapeHtml(label)}</span>
            ${count}
            ${meta ? `<span class="context-compacted-notice-meta">${escapeHtml(meta)}</span>` : ''}
          </div>
          ${renderCompactionDetails(list)}
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
  };
});
