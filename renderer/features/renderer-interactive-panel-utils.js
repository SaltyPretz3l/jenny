(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererInteractivePanelUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ---- Shared question-state helpers (pure; used by both the markup builder
  // and the renderer's stalled-timer accounting) ----
  function getSkippedMap(draft) {
    if (!draft || typeof draft !== 'object') {
      return {};
    }
    if (!draft.skippedByQuestionId || typeof draft.skippedByQuestionId !== 'object') {
      draft.skippedByQuestionId = {};
    }
    return draft.skippedByQuestionId;
  }

  function isQuestionSkipped(entry, draft) {
    var qid = String(entry?.id || '').trim();
    if (!qid) {
      return false;
    }
    return Boolean(getSkippedMap(draft)[qid]);
  }

  function isQuestionResolvedWith(entry, draft, isAnswered) {
    return isAnswered(entry, draft) || isQuestionSkipped(entry, draft);
  }

  function countUnresolvedQuestions(batch, draft, isAnswered) {
    var questions = Array.isArray(batch?.questions) ? batch.questions : [];
    return questions.filter(function (q) { return !isQuestionResolvedWith(q, draft, isAnswered); }).length;
  }

  // ---- Shared interactive-panel markup builder ----
  // Pure: builds the stacked `.ask-card` markup from a batch + its draft
  // (Wave E: every question renders at once — answer in any order; the
  // one-at-a-time tab strip is gone). Used by the composer renderer AND the
  // inline timeline batch row (buildBatchRowMarkup) so both presentations are
  // byte-identical. The caller passes `disabled` (the send-busy / backend /
  // auth gate); an empty batch also disables the affordances.
  function buildInteractivePanelMarkup(batch, draft, helpers) {
    const h = helpers || {};
    const escapeHtml = typeof h.escapeHtml === 'function'
      ? h.escapeHtml
      : function fallbackEscapeHtml(value) { return String(value == null ? '' : value); };
    const getInteractiveQuestionOptions = typeof h.getInteractiveQuestionOptions === 'function'
      ? h.getInteractiveQuestionOptions
      : function fallbackOptions() { return []; };
    const isInteractiveQuestionAnswered = typeof h.isInteractiveQuestionAnswered === 'function'
      ? h.isInteractiveQuestionAnswered
      : function fallbackAnswered() { return false; };
    const areInteractiveQuestionsAnswered = typeof h.areInteractiveQuestionsAnswered === 'function'
      ? h.areInteractiveQuestionsAnswered
      : function fallbackAllAnswered() { return false; };
    const isInteractiveOtherTrigger = typeof h.isInteractiveOtherTrigger === 'function'
      ? h.isInteractiveOtherTrigger
      : function fallbackOtherTrigger() { return false; };

    function isQuestionResolved(entry) {
      return isQuestionResolvedWith(entry, draft, isInteractiveQuestionAnswered);
    }

    const questions = Array.isArray(batch.questions) ? batch.questions : [];
    const disabled = Boolean(h.disabled) || questions.length === 0;
    const allAnswered = areInteractiveQuestionsAnswered(batch, draft);
    const allResolved = questions.length > 0 && questions.every(function (q) { return isQuestionResolved(q); });
    const unresolved = countUnresolvedQuestions(batch, draft, isInteractiveQuestionAnswered);
    const answeredCount = questions.filter(function (entry) {
      return isInteractiveQuestionAnswered(entry, draft);
    }).length;

    const questionsMarkup = questions
      .map((question) => {
        const questionId = String(question?.id || '');
        const prompt = String(question?.prompt || '');
        const selectedOptionId = String(draft?.selections?.[questionId] || '').trim();
        const otherSelected = Boolean(isInteractiveOtherTrigger(question, selectedOptionId));
        const otherText = String(draft?.customTextByQuestionId?.[questionId] || '');
        const answered = isInteractiveQuestionAnswered(question, draft);
        const skipped = isQuestionSkipped(question, draft);
        const questionState = answered ? 'answered' : (skipped ? 'skipped' : 'pending');
        const optionsMarkup = getInteractiveQuestionOptions(question)
          .map((option) => {
            const selected = selectedOptionId === option.id;
            return `
              <button
                class="interactive-option-button${selected ? ' selected' : ''}"
                type="button"
                data-interactive-option="true"
                data-batch-id="${escapeHtml(batch.batch_id)}"
                data-question-id="${escapeHtml(questionId)}"
                data-option-id="${escapeHtml(option.id)}"
                aria-pressed="${selected ? 'true' : 'false'}"
                ${disabled ? 'disabled' : ''}
              >
                ${escapeHtml(option.label)}
              </button>
            `;
          })
          .join('');
        const otherInputMarkup = otherSelected
          ? `
            <div class="interactive-other-input-row">
              <input
                class="interactive-other-input"
                type="text"
                spellcheck="true"
                value="${escapeHtml(otherText)}"
                placeholder="Type your answer..."
                data-interactive-other-input="true"
                data-batch-id="${escapeHtml(batch.batch_id)}"
                data-question-id="${escapeHtml(questionId)}"
                ${disabled ? 'disabled' : ''}
              />
              <button
                class="interactive-other-confirm"
                type="button"
                data-interactive-other-confirm="true"
                data-batch-id="${escapeHtml(batch.batch_id)}"
                data-question-id="${escapeHtml(questionId)}"
                ${disabled || !String(otherText || '').trim() ? 'disabled' : ''}
              >
                Save answer
              </button>
            </div>
          `
          : '';
        const skipMarkup = !answered && !skipped
          ? `
            <button
              class="interactive-question-skip"
              type="button"
              data-interactive-skip-question="true"
              data-batch-id="${escapeHtml(batch.batch_id)}"
              data-question-id="${escapeHtml(questionId)}"
              aria-label="Skip this question"
              title="Skip this question"
              ${disabled ? 'disabled' : ''}
            >
              Skip
            </button>
          `
          : skipped
            ? `<div class="interactive-question-skipped-note">Skipped</div>`
            : '';
        return `
          <section
            class="ask-card-question"
            role="group"
            aria-label="${escapeHtml(prompt)}"
            data-question-id="${escapeHtml(questionId)}"
            data-question-state="${questionState}"
            id="interactive-question-panel-${escapeHtml(questionId)}"
          >
            <div class="ask-card-question-header">
              <div class="interactive-question-prompt">${escapeHtml(prompt)}</div>
              ${skipMarkup}
            </div>
            <div class="interactive-question-options">
              ${optionsMarkup}
            </div>
            ${otherInputMarkup}
          </section>
        `;
      })
      .join('');

    const noteText = allResolved
      ? (allAnswered ? 'Review answers or submit when ready.' : 'Review answers - some were skipped.')
      : `${unresolved} question${unresolved === 1 ? '' : 's'} remaining.`;
    const progressMarkup = questions.length > 1
      ? `<span class="ask-card-progress">${escapeHtml(`${answeredCount} of ${questions.length} answered`)}</span>`
      : '';

    return `
      <div class="ask-card" data-interactive-batch-id="${escapeHtml(batch.batch_id)}">
        <div class="ask-card-header">
          <span class="ask-card-kicker"><span class="ask-card-kicker-dot" aria-hidden="true"></span>Jenny asks</span>
          ${progressMarkup}
        </div>
        ${batch.intro_text ? `<div class="ask-card-intro">${escapeHtml(batch.intro_text)}</div>` : ''}
        <div class="ask-card-questions">
          ${questionsMarkup}
        </div>
        <div class="interactive-card-actions">
          <button
            class="interactive-action-button primary interactive-action-button-submit"
            type="button"
            data-interactive-submit="true"
            data-batch-id="${escapeHtml(batch.batch_id)}"
            ${disabled || !allResolved ? 'disabled' : ''}
          >
            Submit answers
          </button>
          ${unresolved > 1 ? `
            <button
              class="interactive-action-button interactive-action-button-skip-all"
              type="button"
              data-interactive-skip-all="true"
              data-batch-id="${escapeHtml(batch.batch_id)}"
              ${disabled ? 'disabled' : ''}
            >
              Skip all (${unresolved})
            </button>
          ` : ''}
          <button
            class="interactive-action-button interactive-action-button-skip"
            type="button"
            data-interactive-skip="true"
            data-batch-id="${escapeHtml(batch.batch_id)}"
            ${disabled ? 'disabled' : ''}
          >
            Answer later
          </button>
          <div class="interactive-card-note">
            ${noteText}
          </div>
          <div class="interactive-stalled-nudge" aria-live="polite">
            Still there? You can skip unanswered questions or answer later.
          </div>
        </div>
      </div>
    `;
  }

  // Inert (read-only) summary for a persisted question_batch row that is NOT the
  // active pending batch (already answered or historical). No interactive
  // affordances — just the family kicker (past tense) + the intro + the
  // question prompts.
  function buildInertInteractiveBatchSummaryMarkup(batch, escapeHtml) {
    const esc = typeof escapeHtml === 'function'
      ? escapeHtml
      : function fallbackEscapeHtml(value) { return String(value == null ? '' : value); };
    const questions = Array.isArray(batch?.questions) ? batch.questions : [];
    const introMarkup = batch && batch.intro_text
      ? `<div class="ask-card-intro">${esc(batch.intro_text)}</div>`
      : '';
    const questionsMarkup = questions
      .map((entry) => `<li class="interactive-summary-question">${esc(String(entry?.prompt || ''))}</li>`)
      .join('');
    return `
      <div class="ask-card ask-card-inert" data-interactive-batch-id="${esc(batch?.batch_id || '')}" data-interactive-inert="true">
        <div class="ask-card-header">
          <span class="ask-card-kicker"><span class="ask-card-kicker-dot" aria-hidden="true"></span>Jenny asked</span>
        </div>
        ${introMarkup}
        <ul class="interactive-summary-questions">${questionsMarkup}</ul>
      </div>
    `;
  }

  // Factory for the inline timeline batch-row markup builder. Binds the session
  // helpers once; the returned builder is threaded into createTurnRowRenderUtils
  // (renderer-turn-row-render-utils.buildBatchRowMarkup) by the render pipeline.
  // Renders the LIVE editable panel when the row's batch is the session's active
  // pending batch, or a read-only summary otherwise.
  function createInteractiveBatchRowBuilder(helpers) {
    const h = helpers || {};
    const escapeHtml = typeof h.escapeHtml === 'function'
      ? h.escapeHtml
      : function fallbackEscapeHtml(value) { return String(value == null ? '' : value); };
    const state = h.state || {};
    return function buildInteractiveBatchRowMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const rowBatch = payload.question_batch && typeof payload.question_batch === 'object'
        ? payload.question_batch
        : null;
      if (!rowBatch) {
        return '';
      }
      const pending = typeof h.getPendingQuestionBatch === 'function' ? h.getPendingQuestionBatch() : null;
      const isLive = Boolean(pending)
        && (typeof h.hasStalePendingQuestionBatch !== 'function' || !h.hasStalePendingQuestionBatch())
        && String(pending.batch_id || '') === String(rowBatch.batch_id || '')
        && Array.isArray(rowBatch.questions) && rowBatch.questions.length > 0;
      if (!isLive) {
        return buildInertInteractiveBatchSummaryMarkup(rowBatch, escapeHtml);
      }
      const draft = typeof h.getInteractiveDraft === 'function' ? h.getInteractiveDraft(pending) : null;
      const disabled = (typeof h.isSendBusy === 'function' && h.isSendBusy())
        || (state.backend && state.backend.phase !== 'ready')
        || !(state.auth && state.auth.authenticated);
      const panelMarkup = buildInteractivePanelMarkup(pending, draft, {
        disabled,
        escapeHtml,
        getInteractiveQuestionOptions: h.getInteractiveQuestionOptions,
        isInteractiveQuestionAnswered: h.isInteractiveQuestionAnswered,
        areInteractiveQuestionsAnswered: h.areInteractiveQuestionsAnswered,
        isInteractiveOtherTrigger: h.isInteractiveOtherTrigger,
      });
      return `<div class="chat-row-interactive-mount" data-interactive-batch-row="${escapeHtml(String(rowBatch.batch_id || ''))}">${panelMarkup}</div>`;
    };
  }

  function createInteractivePanelRenderer(deps) {
    const { state } = deps;

    const {
      composer,
      chatInput,
      chatTimeline,
    } = deps.dom;

    const {
      getPendingQuestionBatch,
      hasStalePendingQuestionBatch,
      getInteractiveDraft,
      getInteractiveQuestionOptions,
      isInteractiveQuestionAnswered,
      areInteractiveQuestionsAnswered,
      isInteractiveOtherTrigger,
      isSendBusy,
      escapeHtml,
      escapeSelectorValue,
    } = deps.callbacks;

    // The first-class timeline row and `.chat-row-interactive-mount` own the
    // live panel.
    function getInlineInteractivePanelMount() {
      if (chatTimeline && typeof chatTimeline.querySelector === 'function') {
        return chatTimeline.querySelector('.chat-row-interactive-mount');
      }
      return null;
    }
    function getActiveInteractivePanelElement() {
      return getInlineInteractivePanelMount();
    }

    function queueInteractiveComposerFocus(request) {
      state.ui.interactiveFocusRequest = request || null;
    }

    function flushInteractiveComposerFocus() {
      const request = state.ui.interactiveFocusRequest;
      if (!request) {
        return;
      }
      state.ui.interactiveFocusRequest = null;
      requestAnimationFrame(() => {
        const panelEl = getActiveInteractivePanelElement();
        if (!panelEl) {
          if (chatInput && !chatInput.disabled && !chatInput.classList.contains('hidden')) {
            chatInput.focus();
          }
          return;
        }
        if (request.type === 'other-input' && request.questionId) {
          const input = panelEl.querySelector(
            `[data-interactive-other-input][data-question-id="${escapeSelectorValue(request.questionId)}"]`
          );
          input?.focus();
          input?.setSelectionRange?.(input.value.length, input.value.length);
          return;
        }
        if (request.type === 'question' && request.questionId) {
          // Stacked layout (Wave E): move focus to the next unresolved
          // question's first option so keyboard flow walks the batch.
          const option = panelEl.querySelector(
            `[data-interactive-option][data-question-id="${escapeSelectorValue(request.questionId)}"]`
          );
          if (option) {
            option.focus();
            return;
          }
        }
        if (request.type === 'submit') {
          const submitButton = panelEl.querySelector('[data-interactive-submit]');
          submitButton?.focus();
          return;
        }
        const preferredTarget =
          panelEl.querySelector('[data-interactive-other-input]') ||
          panelEl.querySelector('[data-interactive-option]') ||
          panelEl.querySelector('[data-interactive-submit]');
        preferredTarget?.focus();
      });
    }

    var _stalledTimer = 0;
    var STALLED_TIMEOUT_MS = 30000;

    function clearStalledTimer() {
      if (_stalledTimer) {
        clearTimeout(_stalledTimer);
        _stalledTimer = 0;
      }
      const panelEl = getActiveInteractivePanelElement();
      if (panelEl) {
        panelEl.classList.remove('interactive-stalled');
      }
    }

    function startStalledTimer() {
      clearStalledTimer();
      _stalledTimer = setTimeout(function () {
        const panelEl = getActiveInteractivePanelElement();
        if (panelEl) {
          panelEl.classList.add('interactive-stalled');
        }
        _stalledTimer = 0;
      }, STALLED_TIMEOUT_MS);
    }

    function renderComposerInteractivePanel() {
      const batch = getPendingQuestionBatch();
      const questions = Array.isArray(batch?.questions) ? batch.questions : [];
      const hasLiveBatch = Boolean(batch) && !hasStalePendingQuestionBatch() && questions.length > 0;
      const inlineMount = getInlineInteractivePanelMount();

      if (!hasLiveBatch) {
        clearStalledTimer();
        state.ui.interactiveFocusRequest = null;
        if (composer) {
          composer.classList.remove('composer-has-interactive');
        }
        if (chatInput) {
          chatInput.placeholder = 'Message Jenny...';
        }
        return;
      }

      const draft = getInteractiveDraft(batch);
      const disabled =
        isSendBusy() ||
        state.backend.phase !== 'ready' ||
        !state.auth.authenticated;
      const markup = buildInteractivePanelMarkup(batch, draft, {
        disabled,
        escapeHtml,
        getInteractiveQuestionOptions,
        isInteractiveQuestionAnswered,
        areInteractiveQuestionsAnswered,
        isInteractiveOtherTrigger,
      });
      if (inlineMount) {
        // The inline timeline row owns the panel. The row builder already
        // rendered it during the timeline pass; refill in place so the panel
        // stays responsive to the composer-v2-flow handlers (option/skip)
        // without a full renderMessages.
        inlineMount.innerHTML = markup;
      }
      if (composer) {
        composer.classList.add('composer-has-interactive');
      }
      if (chatInput) {
        chatInput.placeholder = 'Message Jenny...';
      }
      const unresolved = countUnresolvedQuestions(batch, draft, isInteractiveQuestionAnswered);
      if (unresolved > 0) {
        startStalledTimer();
      } else {
        clearStalledTimer();
      }
      flushInteractiveComposerFocus();
    }

    return {
      queueInteractiveComposerFocus,
      flushInteractiveComposerFocus,
      renderComposerInteractivePanel,
      clearStalledTimer,
    };
  }

  return {
    createInteractivePanelRenderer,
    createInteractiveBatchRowBuilder,
    buildInteractivePanelMarkup,
    buildInertInteractiveBatchSummaryMarkup,
  };
});
