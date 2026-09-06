(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-composer-v2-model'));
    return;
  }
  root.rendererComposerV2Flow = factory(root.rendererComposerV2Model || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerV2Model) {

  const _stringUtils = typeof globalThis !== 'undefined' && typeof globalThis.stringUtils !== 'undefined' ? globalThis.stringUtils
    : typeof require === 'function' ? require('../shared/string-utils')
    : { normalizeString: function (v) { return String(v || '').trim(); }, normalizeId: function (v) { return String(v || '').trim(); } };
  const { normalizeString, normalizeId } = _stringUtils;

  function getTextByteLengthFallback(value) {
    const text = String(value || '');
    let sizeBytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 0x80) {
        sizeBytes += 1;
      } else if (code < 0x800) {
        sizeBytes += 2;
      } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          sizeBytes += 4;
          index += 1;
        } else {
          sizeBytes += 3;
        }
      } else {
        sizeBytes += 3;
      }
    }
    return sizeBytes;
  }

  const {
    PASTE_WARN_BYTES = 100 * 1024,
    PASTE_REJECT_BYTES = 1024 * 1024,
    getTextByteLength = getTextByteLengthFallback,
    makePasteResult = (accepted, sizeBytes, warned = false) => ({
      accepted: accepted !== false,
      sizeBytes: Math.max(Number(sizeBytes || 0), 0),
      warned: warned === true,
    }),
  } = composerV2Model || {};
  const PASTE_NOTICE_OWNER = 'composer:paste-size';

  function createComposerV2FlowController(deps) {
    const {
      INTERACTIVE_GUARDRAIL_PROMPT,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
      appendClientLog,
      buildInteractiveAnswerPrompt,
      buildInteractiveSelectedAnswers,
      chatInput,
      setComposerStatusNotice,
      chatTimeline,
      ensureInteractiveDraft,
      escapeSelectorValue,
      getInteractiveDraft,
      getInteractiveQuestionOptions,
      getPendingQuestionBatch,
      isInteractiveQuestionAnswered,
      isSendBusy,
      isInteractiveOtherTrigger,
      normalizePendingQuestionBatch,
      patchSessionSummary,
      queueInteractiveComposerFocus,
      renderComposerInteractivePanel,
      startPromptSend,
      state,
      windowRef,
    } = deps;
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    function touchInteractiveDraft(draft) {
      if (!draft || typeof draft !== 'object') {
        return draft;
      }
      const timestamp = Number(now());
      const normalizedTimestamp = Number.isFinite(timestamp) ? Math.max(0, timestamp) : Date.now();
      if (!Number.isFinite(Number(draft.createdAtMs))) {
        draft.createdAtMs = normalizedTimestamp;
      }
      draft.lastTouchedAtMs = normalizedTimestamp;
      return draft;
    }

    function handleComposerPaste(event) {
      const clipboardData = event?.clipboardData || null;
      const getData = typeof clipboardData?.getData === 'function' ? clipboardData.getData.bind(clipboardData) : null;
      if (!getData) {
        return makePasteResult(true, 0, false);
      }
      const pastedText = String(getData('text/plain') || '');
      if (!pastedText) {
        return makePasteResult(true, 0, false);
      }
      const sizeBytes = getTextByteLength(pastedText);
      if (sizeBytes >= PASTE_REJECT_BYTES) {
        if (typeof event?.preventDefault === 'function') {
          event.preventDefault();
        }
        appendClientLog('WARN', 'composer.paste_rejected', {
          sizeBytes,
          limitBytes: PASTE_REJECT_BYTES,
        });
        if (typeof setComposerStatusNotice === 'function') {
          setComposerStatusNotice('Paste is too large. Keep pasted text under 1 MB.', {
            tone: 'warning',
            owner: PASTE_NOTICE_OWNER,
          });
        }
        return makePasteResult(false, sizeBytes, true);
      }
      if (sizeBytes >= PASTE_WARN_BYTES) {
        appendClientLog('WARN', 'composer.paste_large', {
          sizeBytes,
          warnBytes: PASTE_WARN_BYTES,
        });
        if (typeof setComposerStatusNotice === 'function') {
          setComposerStatusNotice('Large paste added. Jenny may take longer to respond.', {
            tone: 'warning',
            owner: PASTE_NOTICE_OWNER,
          });
        }
        return makePasteResult(true, sizeBytes, true);
      }
      return makePasteResult(true, sizeBytes, false);
    }

    function isBatchIdMatch(batch, batchId) {
      return batch && normalizeId(batch.batch_id) === normalizeId(batchId);
    }

    function getSkippedMap(draft) {
      if (!draft || typeof draft !== 'object') {
        return {};
      }
      if (!draft.skippedByQuestionId || typeof draft.skippedByQuestionId !== 'object') {
        draft.skippedByQuestionId = {};
      }
      return draft.skippedByQuestionId;
    }

    function isQuestionResolved(question, draft) {
      const questionId = String(question?.id || '').trim();
      if (!questionId) {
        return false;
      }
      return Boolean(getSkippedMap(draft)[questionId]) || isInteractiveQuestionAnswered(question, draft);
    }

    function areInteractiveQuestionsResolved(batch, draft) {
      const questions = Array.isArray(batch?.questions) ? batch.questions : [];
      return questions.length > 0 && questions.every((question) => isQuestionResolved(question, draft));
    }

    function buildInteractiveResponse(batch, disposition, answers) {
      return {
        batch_id: batch.batch_id,
        round_index: batch.round_index,
        disposition,
        batch_snapshot: batch,
        answers: Array.isArray(answers) ? answers : [],
        ...(batch.continuation_token
          ? { continuation_token: batch.continuation_token }
          : {}),
      };
    }

    function getNextUnresolvedIndex(batch, draft, afterIndex) {
      const questions = Array.isArray(batch?.questions) ? batch.questions : [];
      if (!questions.length) {
        return -1;
      }
      const startIndex = Number.isFinite(afterIndex) ? Math.max(-1, Math.floor(afterIndex)) : -1;
      for (let offset = 1; offset <= questions.length; offset += 1) {
        const index = (startIndex + offset + questions.length) % questions.length;
        if (!isQuestionResolved(questions[index], draft)) {
          return index;
        }
      }
      return -1;
    }

    async function handleSend() {
      const prompt = chatInput.value.trim();
      const activeSession = (Array.isArray(state?.sessions) ? state.sessions : [])
        .find((session) => session?.id === state.currentSessionId);
      if (activeSession?.session_type === 'plugin') return;
      await startPromptSend(prompt, { restoreInputOnError: true });
    }

    function handleInteractiveOptionSelect(batchId, questionId, optionId) {
      const batch = getPendingQuestionBatch();
      if (
        !isBatchIdMatch(batch, batchId) ||
        isSendBusy()
      ) {
        return;
      }
      const draft = ensureInteractiveDraft(batch);
      if (!draft) {
        return;
      }
      touchInteractiveDraft(draft);
      const questionIndex = batch.questions.findIndex((question) => question.id === questionId);
      const question = questionIndex === -1 ? null : batch.questions[questionIndex];
      if (!question) {
        return;
      }
      const skippedByQuestionId = getSkippedMap(draft);
      skippedByQuestionId[questionId] = false;
      draft.selections[questionId] = optionId;
      if (isInteractiveOtherTrigger(question, optionId)) {
        draft.customModeByQuestionId[questionId] = true;
        queueInteractiveComposerFocus({ type: 'other-input', questionId });
        renderComposerInteractivePanel();
        return;
      }
      draft.customModeByQuestionId[questionId] = false;
      draft.customTextByQuestionId[questionId] = '';
      const nextUnansweredIndex = getNextUnresolvedIndex(batch, draft, questionIndex);
      const allResolved = areInteractiveQuestionsResolved(batch, draft);
      draft.activeQuestionIndex =
        nextUnansweredIndex !== -1 ? nextUnansweredIndex : questionIndex;
      queueInteractiveComposerFocus(
        allResolved
          ? { type: 'submit' }
          : { type: 'question', questionId: String(batch.questions[nextUnansweredIndex]?.id || '') }
      );
      renderComposerInteractivePanel();
    }

    function handleInteractiveOtherInputChange(batchId, questionId, value) {
      const batch = getPendingQuestionBatch();
      if (
        !isBatchIdMatch(batch, batchId) ||
        isSendBusy()
      ) {
        return;
      }
      const draft = ensureInteractiveDraft(batch);
      const question = batch.questions.find((entry) => entry.id === questionId);
      if (!draft || !question) {
        return;
      }
      touchInteractiveDraft(draft);
      const otherOption = getInteractiveQuestionOptions(question).find(
        (option) => isInteractiveOtherTrigger(question, option.id)
      );
      const skippedByQuestionId = getSkippedMap(draft);
      skippedByQuestionId[questionId] = false;
      draft.selections[questionId] =
        normalizeString(draft.selections[questionId]) || otherOption?.id || '__other__';
      draft.customTextByQuestionId[questionId] = String(value || '');
      draft.customModeByQuestionId[questionId] = true;
      // Patch the inline panel's confirm/submit disabled state per keystroke to avoid a full render;
      // all questions are stacked, so target the input's question id.
      const interactivePanelEl = chatTimeline && typeof chatTimeline.querySelector === 'function'
        ? chatTimeline.querySelector('.chat-row-interactive-mount')
        : null;
      const confirmButton = interactivePanelEl?.querySelector(
        `[data-interactive-other-confirm][data-question-id="${escapeSelectorValue(questionId)}"]`
      );
      if (confirmButton) {
        confirmButton.disabled = !normalizeString(value);
      }
      const submitButton = interactivePanelEl?.querySelector('[data-interactive-submit]');
      if (submitButton) {
        submitButton.disabled = true;
      }
    }

    function handleInteractiveOtherConfirm(batchId, questionId) {
      const batch = getPendingQuestionBatch();
      if (
        !isBatchIdMatch(batch, batchId) ||
        isSendBusy()
      ) {
        return;
      }
      const draft = ensureInteractiveDraft(batch);
      const questionIndex = batch.questions.findIndex((question) => question.id === questionId);
      const question = questionIndex === -1 ? null : batch.questions[questionIndex];
      const customText = normalizeString(draft?.customTextByQuestionId?.[questionId]);
      if (!draft || !question || !customText) {
        return;
      }
      touchInteractiveDraft(draft);
      const skippedByQuestionId = getSkippedMap(draft);
      skippedByQuestionId[questionId] = false;
      draft.customModeByQuestionId[questionId] = false;
      const nextUnansweredIndex = getNextUnresolvedIndex(batch, draft, questionIndex);
      const allResolved = areInteractiveQuestionsResolved(batch, draft);
      draft.activeQuestionIndex =
        nextUnansweredIndex !== -1 ? nextUnansweredIndex : questionIndex;
      queueInteractiveComposerFocus(
        allResolved
          ? { type: 'submit' }
          : { type: 'question', questionId: String(batch.questions[nextUnansweredIndex]?.id || '') }
      );
      renderComposerInteractivePanel();
    }

    function handleInteractiveSkipQuestion(batchId, questionId) {
      const batch = getPendingQuestionBatch();
      if (
        !isBatchIdMatch(batch, batchId) ||
        isSendBusy()
      ) {
        return;
      }
      const draft = ensureInteractiveDraft(batch);
      const questionIndex = batch.questions.findIndex((question) => question.id === questionId);
      const question = questionIndex === -1 ? null : batch.questions[questionIndex];
      if (!draft || !question) {
        return;
      }
      touchInteractiveDraft(draft);
      const skippedByQuestionId = getSkippedMap(draft);
      skippedByQuestionId[questionId] = true;
      draft.customModeByQuestionId[questionId] = false;
      draft.customTextByQuestionId[questionId] = '';
      draft.selections[questionId] = '';
      const nextUnresolvedIndex = getNextUnresolvedIndex(batch, draft, questionIndex);
      if (nextUnresolvedIndex !== -1) {
        draft.activeQuestionIndex = nextUnresolvedIndex;
      }
      queueInteractiveComposerFocus(
        areInteractiveQuestionsResolved(batch, draft)
          ? { type: 'submit' }
          : { type: 'question', questionId: String(batch.questions[nextUnresolvedIndex]?.id || '') }
      );
      renderComposerInteractivePanel();
    }

    function handleInteractiveSkipAll(batchId) {
      const batch = getPendingQuestionBatch();
      if (
        !isBatchIdMatch(batch, batchId) ||
        isSendBusy()
      ) {
        return;
      }
      const draft = ensureInteractiveDraft(batch);
      if (!draft) {
        return;
      }
      touchInteractiveDraft(draft);
      const skippedByQuestionId = getSkippedMap(draft);
      for (const question of batch.questions) {
        if (!question || !question.id) {
          continue;
        }
        if (!isInteractiveQuestionAnswered(question, draft)) {
          skippedByQuestionId[question.id] = true;
          draft.customModeByQuestionId[question.id] = false;
          draft.customTextByQuestionId[question.id] = '';
          draft.selections[question.id] = '';
        }
      }
      queueInteractiveComposerFocus({ type: 'submit' });
      renderComposerInteractivePanel();
    }

    async function handleInteractiveSubmit(batchId) {
      const batch = getPendingQuestionBatch();
      if (!isBatchIdMatch(batch, batchId)) {
        return;
      }
      const draft = getInteractiveDraft(batch);
      if (!areInteractiveQuestionsResolved(batch, draft)) {
        return;
      }
      touchInteractiveDraft(draft);
      const answers = buildInteractiveSelectedAnswers(batch, draft);
      const prompt = buildInteractiveAnswerPrompt(batch, answers);
      await startPromptSend(prompt, {
        interactiveResponse: buildInteractiveResponse(batch, 'answered', answers),
      });
    }

    async function handleInteractiveSkip(batchId) {
      const batch = getPendingQuestionBatch();
      if (!isBatchIdMatch(batch, batchId)) {
        return;
      }
      await startPromptSend('Please continue with the best available answer.', {
        visiblePrompt: '',
        interactiveResponse: buildInteractiveResponse(batch, 'skipped', []),
      });
    }

    async function persistInteractiveFallbackRequest(sessionId, roundCount) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return;
      }
      const parsedRoundCount = Number(roundCount || 0);
      const normalizedRoundCount = Number.isFinite(parsedRoundCount)
        ? Math.max(0, Math.floor(parsedRoundCount))
        : 0;
      patchSessionSummary(normalizedSessionId, {
        pending_question_batch: null,
        interactive_sequence_state: INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
        interactive_round_count: normalizedRoundCount,
      });
      await windowRef.jennyShell.sessions.setPreferences(normalizedSessionId, {
        pending_question_batch: null,
        interactive_sequence_state: INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
        interactive_round_count: normalizedRoundCount,
      });
    }

    async function requestInteractiveGuardrailAnswer(sessionId, batch) {
      const normalizedBatch = normalizePendingQuestionBatch(batch);
      if (!normalizedBatch) {
        return;
      }

      if (state.currentSessionId !== sessionId) {
        state.currentSessionId = sessionId;
      }

      await persistInteractiveFallbackRequest(sessionId, normalizedBatch.round_index);

      await startPromptSend(INTERACTIVE_GUARDRAIL_PROMPT, {
        visiblePrompt: '',
        sessionIdOverride: sessionId,
        interactiveGuardrailFallback: true,
        interactiveResponse: buildInteractiveResponse(normalizedBatch, 'skipped', []),
      });
    }

    return {
      handleComposerPaste,
      handleInteractiveOptionSelect,
      handleInteractiveOtherConfirm,
      handleInteractiveOtherInputChange,
      handleInteractiveSkipAll,
      handleInteractiveSkipQuestion,
      handleInteractiveSkip,
      handleInteractiveSubmit,
      handleSend,
      persistInteractiveFallbackRequest,
      requestInteractiveGuardrailAnswer,
    };
  }

  return {
    createComposerV2FlowController,
  };
});
