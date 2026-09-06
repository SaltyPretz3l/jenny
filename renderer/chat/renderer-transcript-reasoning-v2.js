/*
 * Reasoning row widget. Mirrors the three-part header anatomy of
 * `.tool-call-block`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./reasoning-row-v2-utils'),
      require('./chat-thinking-utils')
    );
    return;
  }
  root.rendererTranscriptReasoningV2 = factory(
    root.reasoningRowV2Utils || {},
    root.chatThinkingUtils || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (v2Utils, sharedUtils) {
  const {
    reasoningStatusTone,
    shouldAutoExpandReasoningV2,
    formatReasoningSecondaryMeta,
    formatReasoningDuration,
    buildReasoningPreview,
    deriveReasoningStatus,
    resolveLiveWindowStart,
    LIVE_WINDOW_ELIDED_FINGERPRINT,
    LIVE_WINDOW_NOTE_FINGERPRINT,
    LIVE_WINDOW_NOTE_HTML,
  } = v2Utils || {};
  const {
    groupReasoningPhaseMetadata,
    getRenderableReasoningPhaseGroups,
    joinReasoningEntriesMarkdown,
    markdownToPlainReasoningLabel,
    summaryFromEntries,
  } = sharedUtils || {};

  // generation_runtime.py's hardcoded transition_phase summary.
  const GENERIC_PHASE_SUMMARY = 'reasoning through the turn';
  const REASONING_STREAM_STATE_CACHE_LIMIT = 8;
  const streamStateCache = new Map();

  function clearReasoningStreamStateCache() {
    streamStateCache.clear();
  }

  function getCachedStreamState(cacheKey) {
    const cached = streamStateCache.get(cacheKey);
    if (cached) {
      streamStateCache.delete(cacheKey);
      streamStateCache.set(cacheKey, cached);
    }
    return cached;
  }

  function setCachedStreamState(cacheKey, streamModel, liveWindowStart) {
    streamStateCache.delete(cacheKey);
    streamStateCache.set(cacheKey, {
      units: streamModel.units,
      streamState: streamModel.streamState,
      liveWindowStart: liveWindowStart || 0,
    });
    if (streamStateCache.size > REASONING_STREAM_STATE_CACHE_LIMIT) {
      streamStateCache.delete(streamStateCache.keys().next().value);
    }
  }

  function groupTranscriptReasoningPhases(message) {
    return (Array.isArray(message?.phases) ? message.phases : [])
      .filter((phase) => String(phase?.phase_kind || phase?.phaseKind || '').trim() === 'reasoning')
      .map((phase) => ({
        phaseId: String(phase?.phase_id || phase?.phaseId || '').trim(),
        phaseKey: String(phase?.phase_id || phase?.phaseId || '').trim(),
        thinkingId: String(phase?.thinking_id || phase?.thinkingId || '').trim(),
        entries: Array.isArray(phase?.entries) ? phase.entries : [],
      }))
      .filter((group) => group.entries.length > 0);
  }

  function mergeReasoningPhaseGroups(entryGroups, metadataGroups) {
    const entries = Array.isArray(entryGroups) ? entryGroups : [];
    const metadata = Array.isArray(metadataGroups) ? metadataGroups : [];
    if (!metadata.length) return entries;
    const merged = metadata.map((group) => ({ ...group, entries: [] }));
    for (const entryGroup of entries) {
      const entryKey = String(entryGroup?.phaseKey || entryGroup?.phaseId || '').trim();
      const thinkingId = String(entryGroup?.thinkingId || '').trim();
      let candidates = [];
      if (entryKey) {
        candidates = merged
          .map((group, index) => ({ group, index }))
          .filter(({ group }) => String(group?.phaseKey || group?.phaseId || '').trim() === entryKey)
          .map(({ index }) => index);
      }
      if (!candidates.length && thinkingId) {
        candidates = merged
          .map((group, index) => ({ group, index }))
          .filter(({ group }) => String(group?.thinkingId || '').trim() === thinkingId)
          .map(({ index }) => index);
      }
      if (!candidates.length) {
        merged.push(entryGroup);
        continue;
      }
      // Duplicate legacy thinking ids cannot split flattened entries back into
      // their original phases. Attach that aggregate to the latest phase so the
      // live tail owns the body while every metadata phase still gets a row.
      const target = candidates[candidates.length - 1];
      merged[target] = { ...merged[target], entries: entryGroup.entries || [] };
    }
    return merged;
  }

  function createReasoningV2Renderer(deps) {
    const {
      escapeHtml,
      groupReasoningByPhase,
      getReasoningEntries,
      renderMarkdown,
      renderStreamingMarkdownUnits,
      shouldShowThinkingToggle,
      thinkingController,
    } = deps || {};

    function renderPhase({
      message,
      group,
      metadata,
      iteration,
      isStreamingTail,
      groupCount,
    }) {
      const thinkingId = String(group?.thinkingId || '');
      const phaseKey = String(group?.phaseKey || group?.phaseId || thinkingId || `legacy_phase_${iteration}`);
      const entries = Array.isArray(group?.entries) ? group.entries : [];
      // The sidecar supplies a generic phase summary; prefer an entry-derived summary whenever entries exist.
      const metadataSummary = String(metadata?.summary || '').trim();
      const derivedSummary = String(summaryFromEntries(entries) || '').trim();
      const summary = metadataSummary && metadataSummary.toLowerCase() !== GENERIC_PHASE_SUMMARY
        ? metadataSummary
        : (derivedSummary || metadataSummary);

      const status = deriveReasoningStatus(message, {
        isStreamingTail,
        phaseCompleted: metadata?.completed === true,
      });
      const isPhaseStreaming = isStreamingTail && status === 'streaming';
      const streamCacheKey = `${String(message?.id || '')}::${phaseKey}`;
      if (!isPhaseStreaming) streamStateCache.delete(streamCacheKey);
      const tone = reasoningStatusTone(status, { isStreaming: isPhaseStreaming });
      const autoExpand = shouldAutoExpandReasoningV2(status, { isStreaming: isPhaseStreaming });
      const expanded = thinkingController.isPhaseExpanded(message.id, phaseKey, autoExpand);

      // Settled phases prefer the settled "Thought for Xs" duration; while
      // streaming (or when timing is absent) fall back to the live tok/s rate.
      // Gated on response_loop_display_v2 (reflected on the root dataset by the
      // render pipeline, mirroring the commentary path) so flag-off keeps the
      // pre-feature tok/s secondary meta byte-identical.
      const responseLoopDisplayV2 = typeof document !== 'undefined'
        && !!document.documentElement
        && document.documentElement.dataset.responseLoopDisplay === 'true';
      const durationLabel = responseLoopDisplayV2 && typeof formatReasoningDuration === 'function'
        ? formatReasoningDuration(
          metadata && (metadata.startedAt || metadata.started_at),
          metadata && (metadata.completedAt || metadata.completed_at),
          { isStreaming: isPhaseStreaming, completed: status === 'complete' },
        )
        : '';
      const secondaryMeta = durationLabel
        ? `Thought for ${durationLabel}`
        : formatReasoningSecondaryMeta({ tokensPerSecond: metadata?.tokensPerSecond });

      const bodyMarkdown = joinReasoningEntriesMarkdown(entries);
      // mermaid: 'plain' — reasoning is a working surface, not the answer:
      // a diagram the model drafts while thinking must not render as a
      // duplicate interactive chart here.
      let bodyHtml = '';
      let bodyUnitsHtml = '';
      if (bodyMarkdown) {
        if (isPhaseStreaming) {
          const cached = getCachedStreamState(streamCacheKey);
          const renderStartedAt = typeof performance !== 'undefined'
            && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
          const streamModel = renderStreamingMarkdownUnits(bodyMarkdown, {
            mermaid: 'plain',
            previousUnits: cached ? cached.units : [],
            previousStreamState: cached ? cached.streamState : null,
          });
          const renderCompletedAt = typeof performance !== 'undefined'
            && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
          try {
            globalThis.rendererStreamClientMetricsModule?.getShared?.()
              ?.noteReasoningBodyRender?.({
                mode: streamModel.renderMode,
                fallbackReason: streamModel.fallbackReason,
                durationMs: renderCompletedAt - renderStartedAt,
                entryChars: entries.reduce(
                  (maximum, entry) => Math.max(maximum, String(entry?.text || '').length),
                  0,
                ),
              });
          } catch (_error) {
            // Diagnostics are best-effort; never break the reasoning render path.
          }
          // Trailing live window: earlier units become empty placeholders once
          // the body outgrows the window (see resolveLiveWindowStart); the
          // start is threaded through the stream cache so it never retracts.
          const liveWindowStart = typeof resolveLiveWindowStart === 'function'
            ? resolveLiveWindowStart(streamModel.units, cached ? cached.liveWindowStart : 0)
            : 0;
          setCachedStreamState(streamCacheKey, streamModel, liveWindowStart);
          bodyHtml = streamModel.html;
          // Wrap each markdown unit so the live patch can reveal only newly
          // appended units (soft-landing) instead of replacing the whole body
          // every frame. No `is-revealed` in the markup — the patch layer owns
          // reveal decisions, so a wholesale first attach never blurs the whole
          // body in at once.
          const units = Array.isArray(streamModel.units) ? streamModel.units : [];
          if (units.length) {
            bodyUnitsHtml = units
              .map((unit, unitIndex) => {
                if (unitIndex < liveWindowStart) {
                  const note = unitIndex === liveWindowStart - 1;
                  return `<div class="reasoning-stream-unit" data-stream-unit-index="${unitIndex}" data-su-fp="${note ? LIVE_WINDOW_NOTE_FINGERPRINT : LIVE_WINDOW_ELIDED_FINGERPRINT}">${note ? LIVE_WINDOW_NOTE_HTML : ''}</div>`;
                }
                return `<div class="reasoning-stream-unit" data-stream-unit-index="${unitIndex}" data-su-fp="${escapeHtml(unit.fingerprint || '')}">${unit.html}</div>`;
              })
              .join('');
          }
        } else {
          bodyHtml = renderMarkdown(bodyMarkdown, { mermaid: 'plain' });
        }
      }
      // Gate panel-open on the flat body's presence (bodyHtml); render the
      // wrapped units when the streaming tail produced them, else the flat body.
      const bodyMarkup = bodyUnitsHtml || bodyHtml;

      // A body-less panel must never open: an auto-expanded phase_started
      // shell (entries still streaming in) otherwise renders as a tall blank
      // box (.expanded sets max-height + padding with nothing inside).
      const panelExpanded = expanded && Boolean(bodyHtml);
      const a11y = thinkingController.getPhaseToggleA11y(message.id, phaseKey, panelExpanded);
      const toggleId = `${a11y.panelId}-toggle`;

      const collapsedPreview = !expanded && !isPhaseStreaming
        ? buildReasoningPreview(entries)
        : '';

      // Quiet one-liner grammar: [dot] [name] [summary·muted] … [meta] [caret].
      // The leading name carries the row (sentence case, no uppercase kicker):
      // the settled duration ("Thought for 10.2s") when available, the step
      // index in multi-step turns, or the live "Thinking" state.
      let nameText;
      let clusterMeta;
      if (groupCount > 1) {
        nameText = `Step ${iteration}`;
        clusterMeta = secondaryMeta;
      } else if (durationLabel) {
        nameText = `Thought for ${durationLabel}`;
        clusterMeta = '';
      } else {
        nameText = isPhaseStreaming ? 'Thinking' : 'Thought';
        clusterMeta = secondaryMeta;
      }
      // Clean the CHOSEN label (metadata summary, derived summary, or preview
      // alike) — cleaning inside the derivation helpers would miss a bold
      // sidecar metadata.summary. The markdown body stays raw.
      const chosenLabel = isPhaseStreaming ? summary : (summary || collapsedPreview);
      const rawHeaderLabel = typeof markdownToPlainReasoningLabel === 'function'
        ? markdownToPlainReasoningLabel(chosenLabel)
        : chosenLabel;
      /* Skip trivially short or punctuation-only labels so the header stays clean. */
      const headerLabel = /\p{L}|\p{N}/u.test(String(rawHeaderLabel || '')) ? rawHeaderLabel : '';
      const ariaLabel = groupCount > 1
        ? `Toggle reasoning step ${iteration}`
        : 'Toggle reasoning';

      return `
        <div
          class="reasoning-row-block${expanded ? ' expanded' : ''}"
          data-reasoning-status="${escapeHtml(status)}"${isPhaseStreaming ? ' data-reasoning-live-tail="true"' : ''}
          data-reasoning-iteration="${escapeHtml(String(iteration))}"
          data-thinking-id="${escapeHtml(thinkingId)}"
          data-phase-key="${escapeHtml(phaseKey)}"
        >
          <button
            class="reasoning-row-header"
            id="${escapeHtml(toggleId)}"
            type="button"
            data-reasoning-toggle="true"
            data-message-id="${escapeHtml(message.id)}"
            data-thinking-id="${escapeHtml(thinkingId)}"
            data-phase-key="${escapeHtml(phaseKey)}"
            data-default-expanded="${autoExpand ? 'true' : 'false'}"
            aria-label="${escapeHtml(ariaLabel)}"
            aria-expanded="${a11y.ariaExpanded}"
            aria-controls="${escapeHtml(a11y.ariaControls)}"
          >
            <span class="status-dot status-dot--${escapeHtml(tone)}" aria-hidden="true"></span>
            <span class="reasoning-row-name">${escapeHtml(nameText)}</span>
            <span class="reasoning-row-main${isPhaseStreaming ? ' shimmer-active' : ''}">${escapeHtml(headerLabel)}</span>
            <span class="reasoning-row-status-cluster" aria-hidden="true">
              ${clusterMeta ? `<span class="reasoning-row-meta">${escapeHtml(clusterMeta)}</span>` : ''}
              <span class="reasoning-row-caret"></span>
            </span>
          </button>
          <div
            class="reasoning-row-panel${panelExpanded ? ' expanded' : ''}${bodyHtml ? '' : ' empty'}"
            id="${escapeHtml(a11y.panelId)}"
            role="region"
            aria-labelledby="${escapeHtml(toggleId)}"
            data-thinking-id="${escapeHtml(thinkingId)}"
            data-phase-key="${escapeHtml(phaseKey)}"
            ${panelExpanded ? '' : ' hidden'}
          >
            ${
              bodyHtml
                ? `<div class="reasoning-row-panel-body chat-bubble-markdown">${bodyMarkup}</div>`
                : ''
            }
          </div>
        </div>
      `;
    }

    function renderGroupHeader(groupCount) {
      if (groupCount <= 1) return '';
      return `
        <div class="reasoning-row-group-header">
          <span class="reasoning-row-group-label">${escapeHtml(`Reasoning · ${groupCount} steps`)}</span>
        </div>
      `;
    }

    function renderReasoningRow(message, latestAssistantMessageId) {
      const entries = Array.isArray(getReasoningEntries?.(message)) ? getReasoningEntries(message) : [];
      const groupedPhases = Array.isArray(groupReasoningByPhase?.(entries))
        ? groupReasoningByPhase(entries)
        : [];
      const transcriptPhaseGroups = groupTranscriptReasoningPhases(message);
      const phaseMetadata = groupReasoningPhaseMetadata(message);
      const metadataPhaseGroups = Array.isArray(getRenderableReasoningPhaseGroups?.(message))
        ? getRenderableReasoningPhaseGroups(message)
        : [];
      const entryPhaseGroups = transcriptPhaseGroups.length ? transcriptPhaseGroups : groupedPhases;
      const phaseGroups = entryPhaseGroups.length || metadataPhaseGroups.length
        ? mergeReasoningPhaseGroups(entryPhaseGroups, metadataPhaseGroups)
        : [{ thinkingId: '', entries }];
      const isStreaming = String(message?.status || '') === 'streaming'
        && String(message?.id || '') === String(latestAssistantMessageId || '');
      const lastPhaseIndex = phaseGroups.length - 1;

      const phasesHtml = phaseGroups.map((group, index) => {
        const tid = String(group?.thinkingId || '');
        const phaseKey = String(group?.phaseKey || group?.phaseId || tid);
        const metadata = phaseMetadata.get(phaseKey) || phaseMetadata.get(tid) || null;
        const iteration = Number(metadata?.iteration || index + 1) || index + 1;
        return renderPhase({
          message,
          group,
          metadata,
          iteration,
          isStreamingTail: isStreaming && index === lastPhaseIndex,
          groupCount: phaseGroups.length,
        });
      }).join('');

      const widgetStatus = escapeHtml(String(deriveReasoningStatus(message, { isStreamingTail: isStreaming })));
      return `
        <div class="reasoning-row-stack" role="group" aria-label="Reasoning" data-reasoning-row-version="2" data-thinking-status="${widgetStatus}">
          ${renderGroupHeader(phaseGroups.length)}
          ${phasesHtml}
        </div>
      `;
    }

    function renderThinkingWidget(message, latestAssistantMessageId) {
      if (!shouldShowThinkingToggle(message, { latestAssistantMessageId })) {
        return '';
      }
      return renderReasoningRow(message, latestAssistantMessageId);
    }

    return {
      renderThinkingWidget,
    };
  }

  return {
    clearReasoningStreamStateCache,
    createReasoningV2Renderer,
  };
});
