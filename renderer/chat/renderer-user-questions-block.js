(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererUserQuestionsBlock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const LIMITS = Object.freeze({ questions: 4, options: 8, id: 120, prompt: 500, option: 200 });
  const stringUtils = (function resolveStringUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.stringUtils) return globalThis.stringUtils;
    if (typeof require === 'function') {
      try { return require('../shared/string-utils'); } catch (_error) { /* not available */ }
    }
    return null;
  })();

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const defaultEscapeHtml = stringUtils && typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : fallbackEscapeHtml;

  function boundedText(value, limit) {
    return Array.from(String(value == null ? '' : value).trim()).slice(0, limit).join('');
  }

  function normalizeQuestions(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, LIMITS.questions).map((question, index) => {
      const source = question && typeof question === 'object' && !Array.isArray(question) ? question : {};
      const options = Array.isArray(source.options)
        ? source.options.slice(0, LIMITS.options).map((option) => boundedText(option, LIMITS.option)).filter(Boolean)
        : [];
      return {
        id: boundedText(source.id, LIMITS.id) || `question_${index + 1}`,
        prompt: boundedText(source.prompt, LIMITS.prompt) || jt('chat.questions.defaultPrompt', 'Question {number}', { number: index + 1 }),
        options,
        multiSelect: source.multi_select === true,
        allowOther: source.allow_other === true && options.length > 0,
      };
    });
  }

  function renderQuestion(question, index, escapeHtml) {
    const questionId = escapeHtml(question.id);
    const inputName = escapeHtml(`user-question-${index + 1}`);
    const inputType = question.multiSelect ? 'checkbox' : 'radio';
    const optionMarkup = question.options.map((option) => {
      const safeOption = escapeHtml(option);
      return `<label class="user-questions-option">`
        + `<input type="${inputType}" name="${inputName}" value="${safeOption}" data-user-question-option>`
        + `<span class="user-questions-glyph" aria-hidden="true"></span>`
        + `<span class="user-questions-option-label">${safeOption}</span></label>`;
    }).join('');
    const otherMarkup = question.allowOther
      ? `<div class="user-questions-option user-questions-other-option">`
        + `<label class="user-questions-other-toggle-label">`
        + `<input type="${inputType}" name="${inputName}" value="" data-user-question-other-toggle>`
        + `<span class="user-questions-glyph" aria-hidden="true"></span>`
        + `<span class="user-questions-other-label">Other:</span></label>`
        + `<input type="text" class="user-questions-other-input" spellcheck="true" data-user-question-other-input`
        + ` aria-label="${escapeHtml(jt('chat.questions.otherAnswerFor', 'Other answer for {question}', { question: question.prompt }))}" maxlength="500" autocomplete="off" disabled></div>`
      : '';
    const answerMarkup = question.options.length
      ? `<div class="user-questions-options" role="group">${optionMarkup}${otherMarkup}</div>`
      : `<input type="text" class="user-questions-free-text" spellcheck="true" data-user-question-free-text`
        + ` aria-label="${escapeHtml(jt('chat.questions.answerFor', 'Answer for {question}', { question: question.prompt }))}" maxlength="500" autocomplete="off">`;
    const chooseAny = question.multiSelect
      ? `<span class="user-questions-choose-any">${escapeHtml(jt('chat.questions.chooseAny', ' — choose any'))}</span>`
      : '';
    return `<fieldset class="user-questions-question" data-user-question-id="${questionId}"`
      + ` data-multi-select="${question.multiSelect ? 'true' : 'false'}">`
      + `<legend class="user-questions-prompt">${escapeHtml(question.prompt)}${chooseAny}</legend>`
      + `${answerMarkup}</fieldset>`;
  }

  function renderUserQuestionsBlock(options, deps) {
    const source = options || {};
    const dependencies = deps || {};
    const escapeHtml = typeof dependencies.escapeHtml === 'function' ? dependencies.escapeHtml : defaultEscapeHtml;
    const toolCallId = boundedText(source.toolCallId, LIMITS.id);
    const questionRef = boundedText(source.questionRef, 500);
    const questions = normalizeQuestions(source.questions);
    if (!questionRef || !questions.length) return '';
    const questionMarkup = questions.map((question, index) => renderQuestion(question, index, escapeHtml)).join('');
    return `<div class="user-questions-block" role="group" aria-label="${escapeHtml(jt('chat.questions.fromJenny', 'Questions from Jenny'))}"`
      + ` data-tool-call-id="${escapeHtml(toolCallId)}" data-call-id="${escapeHtml(toolCallId)}"`
      + ` data-question-ref="${escapeHtml(questionRef)}">`
      + `<div class="user-questions-header" aria-hidden="true">`
      + `<span class="user-questions-eyebrow">Questions</span><span class="user-questions-rule"></span></div>`
      + `${questionMarkup}`
      + `<div class="user-questions-actions">`
      + `<button type="button" class="user-questions-submit-btn" aria-label="${escapeHtml(jt('chat.questions.submitAnswers', 'Submit your answers'))}" title="${escapeHtml(jt('chat.questions.submitAnswers', 'Submit your answers'))}">${escapeHtml(jt('chat.questions.submit', 'Submit'))}</button>`
      + `<button type="button" class="user-questions-decline-btn" aria-label="${escapeHtml(jt('chat.questions.skipQuestions', 'Skip these questions'))}" title="${escapeHtml(jt('chat.questions.skipQuestions', 'Skip these questions'))}">${escapeHtml(jt('chat.questions.skip', 'Skip'))}</button>`
      + `<span class="user-questions-enter-hint">Enter ↵</span>`
      + `</div></div>`;
  }

  function renderUserQuestionsReceipt(options, deps) {
    const source = options || {};
    const dependencies = deps || {};
    const escapeHtml = typeof dependencies.escapeHtml === 'function' ? dependencies.escapeHtml : defaultEscapeHtml;
    const toolCallId = boundedText(source.toolCallId, LIMITS.id);
    const questions = normalizeQuestions(source.questions);
    const resultKind = boundedText(source.resultKind, LIMITS.id);
    let content;
    if (source.stale === true) {
      content = `<div class="user-questions-receipt-status">${escapeHtml(jt('chat.questions.inactiveLabel', 'Questions no longer active'))}</div>`;
    } else if (resultKind === 'user_questions_declined') {
      content = `<div class="user-questions-receipt-status">${escapeHtml(jt('chat.questions.skippedLabel', 'Questions skipped'))}</div>`;
    } else if (resultKind === 'user_questions_answered') {
      const answers = Array.isArray(source.answers) ? source.answers : [];
      const answersById = new Map(answers.map((answer) => {
        const item = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
        return [String(item.id == null ? '' : item.id).trim(), item];
      }));
      const lines = questions.map((question) => {
        const answer = answersById.get(question.id) || {};
        const values = Array.isArray(answer.value)
          ? answer.value.slice(0, LIMITS.options).map((value) => boundedText(value, LIMITS.prompt)).filter(Boolean)
          : [boundedText(answer.value, LIMITS.prompt)].filter(Boolean);
        const other = boundedText(answer.other, LIMITS.prompt);
        if (other) values.push(jt('chat.questions.otherAnswer', 'Other: {answer}', { answer: other }));
        const answerText = values.length ? values.join(', ') : jt('chat.questions.noAnswer', '(no answer)');
        return `<div class="user-questions-receipt-line">`
          + `<span class="user-questions-receipt-prompt">${escapeHtml(question.prompt)}</span>`
          + `<span class="user-questions-receipt-answer"> — ${escapeHtml(answerText)}</span></div>`;
      }).join('');
      const count = questions.length;
      content = `<div class="user-questions-receipt-status">${escapeHtml(jtn('chat.questions.answeredCount', count, { count }, 'Answered {count} question', 'Answered {count} questions'))}</div>${lines}`;
    } else {
      return '';
    }
    return `<div class="user-questions-receipt" data-tool-call-id="${escapeHtml(toolCallId)}">`
      + `<span class="user-questions-receipt-rule"></span>${content}</div>`;
  }

  return { renderUserQuestionsBlock, renderUserQuestionsReceipt };
});
