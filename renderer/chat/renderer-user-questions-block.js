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
  const LIMITS = Object.freeze({ questions: 4, options: 8, id: 120, prompt: 500, option: 200, reply: 2000 });
  const stringUtils = (function resolveStringUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.stringUtils) return globalThis.stringUtils;
    if (typeof require === 'function') {
      try { return require('../shared/string-utils'); } catch (_error) { /* not available */ }
    }
    return null;
  })();

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
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

  function progressText(answered, total) {
    return jt('chat.questions.progress', '{answered} of {total} answered', { answered, total });
  }

  // A question is answered by non-blank free text, a picked option, or a ticked
  // Other with non-blank text (clearing Other's text leaves it ticked but unanswered).
  function isQuestionAnswered(questionNode) {
    const freeText = questionNode.querySelector('[data-user-question-free-text]');
    if (freeText) return String(freeText.value || '').trim() !== '';
    if (questionNode.querySelector('[data-user-question-option]:checked')) return true;
    const otherToggle = questionNode.querySelector('[data-user-question-other-toggle]');
    const otherInput = questionNode.querySelector('[data-user-question-other-input]');
    return Boolean(otherToggle?.checked && otherInput && String(otherInput.value || '').trim() !== '');
  }

  // Cheap and idempotent: the answered count and Submit's enabled state. The card
  // actions call it on every edit; the preservation registry after a restore.
  function syncUserQuestionsState(block) {
    if (!block || typeof block.querySelectorAll !== 'function') return;
    const questionNodes = Array.from(block.querySelectorAll('[data-user-question-id]'));
    const answered = questionNodes.filter(isQuestionAnswered).length;
    const progress = block.querySelector('.user-questions-progress');
    const text = progressText(answered, questionNodes.length);
    if (progress && progress.textContent !== text) progress.textContent = text;
    const submit = block.querySelector('.user-questions-submit-btn');
    const disabled = answered === 0 || block.getAttribute('aria-busy') === 'true';
    if (submit && submit.disabled !== disabled) submit.disabled = disabled;
  }

  // Rows 1-9 carry their keyboard number; a tenth row would need two digits.
  function renderKey(position) {
    return position >= 1 && position <= 9
      ? `<span class="user-questions-key" aria-hidden="true">${position}</span>`
      : '';
  }

  function renderQuestion(question, index, escapeHtml) {
    const questionId = escapeHtml(question.id);
    const inputName = escapeHtml(`user-question-${index + 1}`);
    const inputType = question.multiSelect ? 'checkbox' : 'radio';
    const optionMarkup = question.options.map((option, optionIndex) => {
      const safeOption = escapeHtml(option);
      return `<label class="user-questions-option">`
        + `<input type="${inputType}" name="${inputName}" value="${safeOption}" data-user-question-option>`
        + `<span class="user-questions-glyph" aria-hidden="true"></span>`
        + `<span class="user-questions-option-label">${safeOption}</span>${renderKey(optionIndex + 1)}</label>`;
    }).join('');
    const otherMarkup = question.allowOther
      ? `<label class="user-questions-option user-questions-other-option">`
        + `<input type="${inputType}" name="${inputName}" value="" data-user-question-other-toggle>`
        + `<span class="user-questions-glyph" aria-hidden="true"></span>`
        + `<input type="text" class="user-questions-other-input" spellcheck="true" data-user-question-other-input`
        + ` placeholder="${escapeHtml(jt('chat.questions.otherPlaceholder', 'Something else…'))}"`
        + ` aria-label="${escapeHtml(jt('chat.questions.otherAnswerFor', 'Other answer for {question}', { question: question.prompt }))}" maxlength="500" autocomplete="off">`
        + `${renderKey(question.options.length + 1)}</label>`
      : '';
    const answerMarkup = question.options.length
      ? `<div class="user-questions-options" role="group">${optionMarkup}${otherMarkup}</div>`
      : `<textarea class="user-questions-free-text" rows="1" spellcheck="true" data-user-question-free-text`
        + ` placeholder="${escapeHtml(jt('chat.questions.freeTextPlaceholder', 'Type your answer'))}"`
        + ` aria-label="${escapeHtml(jt('chat.questions.answerFor', 'Answer for {question}', { question: question.prompt }))}" maxlength="500"></textarea>`;
    const chooseAny = question.multiSelect
      ? `<span class="user-questions-choose-any">${escapeHtml(jt('chat.questions.chooseAny', ' · choose any'))}</span>`
      : '';
    return `<fieldset class="user-questions-question" data-user-question-id="${questionId}"`
      + ` data-multi-select="${question.multiSelect ? 'true' : 'false'}">`
      + `<legend class="user-questions-prompt"><span class="user-questions-prompt-text">${escapeHtml(question.prompt)}</span>${chooseAny}</legend>`
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
    const submitLabel = escapeHtml(jt('chat.questions.submitAnswers', 'Submit your answers'));
    const skipLabel = escapeHtml(jt('chat.questions.skipQuestions', 'Skip these questions'));
    return `<div class="user-questions-block" role="group" aria-label="${escapeHtml(jt('chat.questions.fromJenny', 'Questions from Jenny'))}"`
      + ` data-tool-call-id="${escapeHtml(toolCallId)}" data-call-id="${escapeHtml(toolCallId)}"`
      + ` data-question-ref="${escapeHtml(questionRef)}">`
      + `<div class="user-questions-kicker"><span class="user-questions-dot" aria-hidden="true"></span>`
      + `${escapeHtml(jt('chat.questions.kicker', 'Jenny is asking'))}`
      + `<span class="user-questions-progress" aria-live="polite">${escapeHtml(progressText(0, questions.length))}</span></div>`
      + `${questionMarkup}`
      + `<div class="user-questions-actions">`
      + `<button type="button" class="user-questions-submit-btn" aria-label="${submitLabel}" title="${submitLabel}" disabled>${escapeHtml(jt('chat.questions.submit', 'Submit'))}</button>`
      + `<button type="button" class="user-questions-decline-btn" aria-label="${skipLabel}" title="${skipLabel}">${escapeHtml(jt('chat.questions.skip', 'Skip'))}</button>`
      + `<span class="user-questions-enter-hint">${escapeHtml(jt('chat.questions.enterHint', 'Enter to submit · Shift+Enter for a new line'))}</span>`
      + `</div></div>`;
  }

  function renderUserQuestionsReceipt(options, deps) {
    const source = options || {};
    const dependencies = deps || {};
    const escapeHtml = typeof dependencies.escapeHtml === 'function' ? dependencies.escapeHtml : defaultEscapeHtml;
    const toolCallId = boundedText(source.toolCallId, LIMITS.id);
    const questions = normalizeQuestions(source.questions);
    const resultKind = boundedText(source.resultKind, LIMITS.id);
    const status = (ok, text) => `<div class="user-questions-receipt-status">`
      + `<span class="user-questions-receipt-mark${ok ? ' is-ok' : ''}" aria-hidden="true">${ok ? '✓' : '–'}</span>${escapeHtml(text)}</div>`;
    const promptLines = questions.map((question) => `<div class="user-questions-receipt-line">`
      + `<span class="user-questions-receipt-prompt">${escapeHtml(question.prompt)}</span></div>`).join('');
    let content;
    if (source.stale === true) {
      content = status(false, jt('chat.questions.inactiveLabel', 'These questions are no longer active')) + promptLines;
    } else if (resultKind === 'user_questions_declined') {
      content = status(false, jt('chat.questions.skippedLabel', "You skipped Jenny's questions"));
    } else if (resultKind === 'user_questions_answered') {
      const reply = boundedText(source.reply, LIMITS.reply);
      if (reply) {
        content = status(true, jt('chat.questions.repliedLabel', 'You replied in your own words'))
          + `<div class="user-questions-receipt-reply">${escapeHtml(reply)}</div>${promptLines}`;
      } else {
        const answers = Array.isArray(source.answers) ? source.answers : [];
        const answersById = new Map(answers.map((answer) => {
          const item = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
          return [String(item.id == null ? '' : item.id).trim(), item];
        }));
        const rows = questions.map((question) => {
          const answer = answersById.get(question.id) || {};
          const values = Array.isArray(answer.value)
            ? answer.value.slice(0, LIMITS.options).map((value) => boundedText(value, LIMITS.prompt)).filter(Boolean)
            : [boundedText(answer.value, LIMITS.prompt)].filter(Boolean);
          const other = boundedText(answer.other, LIMITS.prompt);
          if (other) values.push(jt('chat.questions.otherAnswer', 'Other: {answer}', { answer: other }));
          return { question, values };
        });
        const lines = rows.map(({ question, values }) => `<div class="user-questions-receipt-line">`
          + `<span class="user-questions-receipt-prompt">${escapeHtml(question.prompt)}</span>`
          + `<span class="user-questions-receipt-answer${values.length ? '' : ' is-skipped'}">`
          + `${escapeHtml(values.length ? values.join(', ') : jt('chat.questions.skippedAnswer', 'Skipped'))}</span></div>`).join('');
        // Count what was answered, so a partly skipped set does not claim all of it.
        const count = rows.filter((row) => row.values.length).length;
        content = (count
          ? status(true, jtn('chat.questions.youAnsweredCount', count, { count }, 'You answered {count} question', 'You answered {count} questions'))
          : status(false, jt('chat.questions.skippedLabel', "You skipped Jenny's questions"))) + lines;
      }
    } else {
      return '';
    }
    return `<div class="user-questions-receipt" data-tool-call-id="${escapeHtml(toolCallId)}">${content}</div>`;
  }

  return { renderUserQuestionsBlock, renderUserQuestionsReceipt, syncUserQuestionsState };
});
