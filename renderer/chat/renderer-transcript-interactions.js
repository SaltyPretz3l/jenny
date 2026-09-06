(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTranscriptInteractionsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const _stringUtils = typeof globalThis !== 'undefined' && typeof globalThis.stringUtils !== 'undefined'
    ? globalThis.stringUtils
    : typeof require === 'function' ? require('../shared/string-utils')
    : {
      normalizeString: function normalizeString(value) {
        return String(value || '').trim();
      },
      normalizeId: function normalizeId(value) {
        return String(value || '').trim();
      },
    };
  const { normalizeString, normalizeId } = _stringUtils;

  function createTranscriptInteractionRenderer(deps) {
    const { escapeHtml, isInteractiveRecapExpanded } = deps || {};

    function toDomIdToken(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }

    function hashTextSeed(value) {
      const input = String(value || '');
      let hash = 0;
      for (let index = 0; index < input.length; index += 1) {
        hash = (hash << 5) - hash + input.charCodeAt(index);
        hash |= 0;
      }
      return Math.abs(hash).toString(36);
    }

    function normalizeRecapIdentifier(value) {
      return normalizeId(value);
    }

    function resolveRecapIdentityFields(message, recap) {
      const turnId = normalizeRecapIdentifier(
        recap?.turn_id
        || recap?.turnId
        || message?.turn_id
        || message?.turnId
      );
      const requestId = normalizeRecapIdentifier(
        recap?.request_id
        || recap?.requestId
        || message?.request_id
        || message?.requestId
        || message?.streamId
      );
      const batchId = normalizeRecapIdentifier(recap?.batch_id || recap?.batchId);
      const parsedRoundIndex = Number(recap?.round_index);
      const roundIndex = Number.isFinite(parsedRoundIndex) && parsedRoundIndex > 0
        ? Math.floor(parsedRoundIndex)
        : 0;
      return { turnId, requestId, batchId, roundIndex };
    }

    function resolveRecapId(message, recap, questionSummaries, askedCount) {
      const explicitRecapId = normalizeRecapIdentifier(recap?.recap_id || recap?.recapId);
      if (explicitRecapId) {
        return explicitRecapId;
      }

      const messageId = normalizeRecapIdentifier(message?.id);
      const { turnId, requestId, batchId, roundIndex } = resolveRecapIdentityFields(message, recap);
      const keyParts = [];
      if (turnId) keyParts.push(`turn:${turnId}`);
      if (requestId) keyParts.push(`request:${requestId}`);
      if (batchId) keyParts.push(`batch:${batchId}`);
      if (roundIndex > 0) keyParts.push(`round:${roundIndex}`);
      if (keyParts.length) {
        return `interactive-recap:${keyParts.join('|')}`;
      }
      if (messageId) {
        return `interactive-recap:message:${messageId}`;
      }

      const fallbackSeed = [
        String(askedCount || 0),
        questionSummaries.map((summary) => `${summary.questionId}|${summary.prompt}|${summary.answerLabel}`).join('||'),
      ].join('::');
      return `interactive-recap:fallback:${hashTextSeed(fallbackSeed)}`;
    }

    function buildQuestionSummaries(recap) {
      const items = Array.isArray(recap?.items) ? recap.items : [];
      const questionSummaries = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          continue;
        }
        const prompt = normalizeString(item.prompt || item.question || item.question_text);
        const answerLabel = normalizeString(item.answer_label || item.answer || item.selection_label);
        if (!prompt && !answerLabel) {
          continue;
        }
        const questionId = normalizeRecapIdentifier(item.question_id || item.id || `q${index + 1}`);
        questionSummaries.push({
          questionId,
          prompt,
          answerLabel,
          compact: answerLabel ? `${prompt} -> ${answerLabel}` : prompt,
          full: answerLabel ? `${prompt}\n${answerLabel}` : prompt,
        });
      }
      return questionSummaries;
    }

    function buildSourceMessageRefs(message, recap) {
      const refs = [];
      const sourceRefs = Array.isArray(recap?.source_message_refs)
        ? recap.source_message_refs
        : Array.isArray(recap?.sourceMessageRefs)
          ? recap.sourceMessageRefs
          : [];
      sourceRefs.forEach((ref) => {
        const normalized = normalizeRecapIdentifier(ref);
        if (normalized && !refs.includes(normalized)) {
          refs.push(normalized);
        }
      });
      const messageId = normalizeRecapIdentifier(message?.id);
      if (messageId && !refs.includes(messageId)) {
        refs.push(messageId);
      }
      return refs;
    }

    function buildInteractiveRecapViewModel(message) {
      const recap = message && message.interactive_round_recap && typeof message.interactive_round_recap === 'object'
        ? message.interactive_round_recap
        : null;
      if (!recap) {
        return null;
      }

      const questionSummaries = buildQuestionSummaries(recap);
      const parsedCount = Number(recap.answer_count);
      const askedCount = Number.isFinite(parsedCount) && parsedCount > 0
        ? Math.max(1, Math.floor(parsedCount))
        : questionSummaries.length;
      if (askedCount < 1 && !questionSummaries.length) {
        return null;
      }

      const identityFields = resolveRecapIdentityFields(message, recap);
      const isStreaming = String(message?.status || '').trim() === 'streaming';
      const answeredCount = questionSummaries.filter((summary) => Boolean(summary.answerLabel)).length;
      const isPartial = isStreaming
        || recap?.is_partial === true
        || recap?.partial === true
        || (askedCount > 0 && answeredCount < askedCount);

      return {
        recapId: resolveRecapId(message, recap, questionSummaries, askedCount),
        turnId: identityFields.turnId,
        requestId: identityFields.requestId,
        askedCount,
        questionSummaries,
        sourceMessageRefs: buildSourceMessageRefs(message, recap),
        isPartial,
        isStreaming,
      };
    }

    function renderInteractiveRoundRecap(message, options) {
      const recapModel = options?.recapModel || buildInteractiveRecapViewModel(message);
      if (!recapModel) {
        return '';
      }

      const expanded = typeof options?.expanded === 'boolean'
        ? options.expanded
        : (typeof isInteractiveRecapExpanded === 'function'
          ? isInteractiveRecapExpanded(recapModel.recapId, options?.sessionId)
          : false);
      const summaryLabel = `Asked ${recapModel.askedCount} question${recapModel.askedCount === 1 ? '' : 's'} ...`;
      const panelId = `interactive-recap-panel-${toDomIdToken(recapModel.recapId) || 'default'}`;
      const detailsMarkup = recapModel.questionSummaries.length
        ? `
            <div class="interactive-recap-list">
              ${recapModel.questionSummaries
                .map(
                  (summary) => `
                    <div class="interactive-recap-item" data-question-id="${escapeHtml(summary.questionId)}">
                      <div class="interactive-recap-question">${escapeHtml(summary.prompt || 'Question')}</div>
                      <div class="interactive-recap-answer">${escapeHtml(summary.answerLabel || 'Pending response...')}</div>
                    </div>
                  `
                )
                .join('')}
            </div>
          `
        : `
            <div class="interactive-recap-empty">
              ${escapeHtml(recapModel.isPartial ? 'Recap is still being prepared.' : 'No recap details available.')}
            </div>
          `;

      return `
        <div class="interactive-recap-block${expanded ? ' expanded' : ''}${recapModel.isPartial ? ' is-partial' : ''}">
          <div
            class="interactive-recap-row${expanded ? ' expanded' : ''}"
            role="button"
            tabindex="0"
            data-interactive-recap-row="true"
            data-recap-id="${escapeHtml(recapModel.recapId)}"
            data-message-id="${escapeHtml(message.id)}"
            aria-expanded="${expanded ? 'true' : 'false'}"
            aria-controls="${escapeHtml(panelId)}"
          >
            <span class="interactive-recap-caret" aria-hidden="true"></span>
            <span class="interactive-recap-label">${escapeHtml(summaryLabel)}</span>
            ${
              recapModel.isPartial
                ? '<span class="interactive-recap-state">Updating</span>'
                : ''
            }
          </div>
          <div
            class="interactive-recap-panel${expanded ? ' expanded' : ''}"
            id="${escapeHtml(panelId)}"
            ${expanded ? '' : 'hidden'}
          >
            ${detailsMarkup}
          </div>
        </div>
      `;
    }

    function renderProactiveSuggestionBlock(message) {
      const suggestion =
        message && message.proactive_suggestion && typeof message.proactive_suggestion === 'object'
          ? message.proactive_suggestion
          : null;
      const title = String(suggestion?.title || message?.content || 'Proactive suggestion').trim();
      const body = String(suggestion?.body || message?.content || '').trim();
      const promptSuggestion = String(suggestion?.promptSuggestion || '').trim();

      return `
        <div class="proactive-suggestion-block">
          <div class="proactive-suggestion-kicker">Suggestion</div>
          <div class="proactive-suggestion-title">${escapeHtml(title)}</div>
          <div class="chat-bubble proactive-suggestion-body">${escapeHtml(body)}</div>
          <div class="proactive-suggestion-actions">
            ${
              promptSuggestion
                ? `
                  <button
                    class="settings-secondary proactive-suggestion-action"
                    type="button"
                    data-message-action="use-suggestion"
                    data-message-id="${escapeHtml(message.id)}"
                    title="Copy this suggestion into the composer"
                    aria-label="Use suggested prompt"
                  >
                    Use Prompt
                  </button>
                `
                : ''
            }
            <button
              class="settings-secondary proactive-suggestion-action"
              type="button"
              data-message-action="save-suggestion"
              data-message-id="${escapeHtml(message.id)}"
              title="Save this suggestion as an open loop"
              aria-label="Save to open loops"
            >
              Save
            </button>
            <button
              class="settings-secondary proactive-suggestion-action"
              type="button"
              data-message-action="later-suggestion"
              data-message-id="${escapeHtml(message.id)}"
              title="Defer this suggestion into open loops"
              aria-label="Save for later"
            >
              Later
            </button>
          </div>
        </div>
      `;
    }

    return {
      buildInteractiveRecapViewModel,
      renderInteractiveRoundRecap,
      renderProactiveSuggestionBlock,
    };
  }

  return {
    createTranscriptInteractionRenderer,
  };
});
