(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.interactiveModeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const INTERACTIVE_GUARDRAIL_NOTICE =
    'Jenny kept asking structured follow-up questions, so the shell asked for a direct answer based on the information already collected.';
  const INTERACTIVE_PROTOCOL_DRIFT_NOTICE =
    'Jenny asked a regular follow-up instead of an interactive question for this turn, so the shell requested a direct answer based on the information already collected.';
  const INTERACTIVE_OTHER_OPTION_ID = '__other__';

  function normalizeQuestionOptions(question) {
    return Array.isArray(question?.options) ? question.options.filter(Boolean) : [];
  }

  function getQuestionOtherOption(question) {
    const options = normalizeQuestionOptions(question);
    return (
      options.find((option) => /^other$/i.test(String(option?.label || '').trim())) || null
    );
  }

  function buildQuestionOptionsWithOther(question) {
    const options = normalizeQuestionOptions(question);
    if (getQuestionOtherOption(question)) {
      return options;
    }
    return options.concat({
      id: INTERACTIVE_OTHER_OPTION_ID,
      label: 'Other',
      synthetic: true,
    });
  }

  function isOtherTrigger(question, optionId) {
    const token = String(optionId || '').trim();
    if (!token) {
      return false;
    }
    if (token === INTERACTIVE_OTHER_OPTION_ID) {
      return true;
    }
    const otherOption = getQuestionOtherOption(question);
    return Boolean(otherOption && String(otherOption.id || '').trim() === token);
  }

  function isQuestionAnswered(question, draft) {
    const questionId = String(question?.id || '').trim();
    if (!questionId || !draft) {
      return false;
    }
    const selectedOptionId = String(draft.selections?.[questionId] || '').trim();
    if (!selectedOptionId) {
      return false;
    }
    if (!isOtherTrigger(question, selectedOptionId)) {
      return true;
    }
    const customText = String(draft.customTextByQuestionId?.[questionId] || '').trim();
    return Boolean(customText) && !draft.customModeByQuestionId?.[questionId];
  }

  function allQuestionsAnswered(batch, draft) {
    const questions = Array.isArray(batch?.questions) ? batch.questions : [];
    return questions.length > 0 && questions.every((question) => isQuestionAnswered(question, draft));
  }

  function getNextUnansweredIndex(batch, draft, afterIndex) {
    const questions = Array.isArray(batch?.questions) ? batch.questions : [];
    if (!questions.length) {
      return -1;
    }
    const startIndex = Number.isFinite(afterIndex) ? Math.max(-1, Math.floor(afterIndex)) : -1;
    for (let offset = 1; offset <= questions.length; offset += 1) {
      const index = (startIndex + offset + questions.length) % questions.length;
      if (!isQuestionAnswered(questions[index], draft)) {
        return index;
      }
    }
    return -1;
  }

  function getComposerStatusNotice(kind) {
    const token = String(kind || '').trim().toLowerCase();
    if (token === 'guardrail') {
      return INTERACTIVE_GUARDRAIL_NOTICE;
    }
    if (token === 'protocol_drift') {
      return INTERACTIVE_PROTOCOL_DRIFT_NOTICE;
    }
    return '';
  }

  return {
    INTERACTIVE_GUARDRAIL_NOTICE,
    INTERACTIVE_PROTOCOL_DRIFT_NOTICE,
    INTERACTIVE_OTHER_OPTION_ID,
    buildQuestionOptionsWithOther,
    getComposerStatusNotice,
    getNextUnansweredIndex,
    getQuestionOtherOption,
    isOtherTrigger,
    isQuestionAnswered,
    allQuestionsAnswered,
  };
});
