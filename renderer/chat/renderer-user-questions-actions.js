(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-user-questions-block'),
      require('./renderer-stream-handler-tools'),
      require('./renderer-enter-keydown-utils')
    );
    return;
  }
  root.rendererUserQuestionsActions = factory(
    root.rendererUserQuestionsBlock || {},
    root.rendererStreamHandlerTools || {},
    root.rendererEnterKeydownUtils || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  userQuestionsRenderer,
  defaultStreamToolHandlers,
  enterKeydownUtils
) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function createUserQuestionsActions(deps = {}) {
    const {
      state,
      doc,
      windowRef,
      appendClientLog = function noopAppendClientLog() {},
      showComposerActionError = function noopShowComposerActionError() {},
      resolveApprovalFocusFallback = function noopResolveApprovalFocusFallback() { return null; },
      watchApprovalRowRemoval = function noopWatchApprovalRowRemoval() {},
      isDisposed = function defaultIsDisposed() { return false; },
      getJennyShell = function defaultGetJennyShell() { return windowRef?.jennyShell; },
      getSessionMessages = function noopGetSessionMessages() { return []; },
      setSessionMessages = function noopSetSessionMessages() {},
      streamToolHandlers = defaultStreamToolHandlers,
    } = deps;
    let disposed = false;

    function isActionDisposed() {
      return disposed || isDisposed();
    }

    // The answered count and Submit's enabled state (renderer-user-questions-block.js).
    function refreshUserQuestionsState(block) {
      userQuestionsRenderer?.syncUserQuestionsState?.(block);
    }

    function setUserQuestionsBlockBusy(block, busy) {
      if (!block || typeof block.querySelectorAll !== 'function') {
        return;
      }
      block.setAttribute('aria-busy', busy ? 'true' : 'false');
      block.querySelectorAll('button, input, textarea, select').forEach((control) => {
        control.disabled = busy;
      });
      if (!busy) {
        refreshUserQuestionsState(block);
      }
    }

    function collectUserQuestionAnswers(block) {
      if (!block || typeof block.querySelectorAll !== 'function') {
        return [];
      }
      return Array.from(block.querySelectorAll('[data-user-question-id]')).map((questionNode) => {
        const id = String(questionNode.dataset?.userQuestionId || '').trim();
        const multiSelect = questionNode.dataset?.multiSelect === 'true';
        const freeText = questionNode.querySelector('[data-user-question-free-text]');
        if (freeText) {
          return { id, value: String(freeText.value || '') };
        }
        const selected = Array.from(questionNode.querySelectorAll('[data-user-question-option]:checked'))
          .map((option) => String(option.value || ''));
        const answer = {
          id,
          value: multiSelect ? selected : (selected[0] || ''),
        };
        const otherToggle = questionNode.querySelector('[data-user-question-other-toggle]');
        const otherInput = questionNode.querySelector('[data-user-question-other-input]');
        if (otherToggle?.checked && otherInput) {
          const other = String(otherInput.value || '');
          if (other) {
            answer.other = other;
          }
        }
        return answer;
      });
    }

    function markUserQuestionsStale(block) {
      if (!block || block.dataset?.userQuestionsStale === 'true') {
        return;
      }
      const sessionId = String(state?.currentSessionId || '').trim();
      const questionRef = String(block.dataset?.questionRef || '').trim();
      streamToolHandlers?.markUserQuestionsStale?.(sessionId, questionRef, {
        getSessionMessages,
        setSessionMessages,
      });
      // Keep what was asked: the receipt lists the prompts the card showed.
      const questions = Array.from(block.querySelectorAll('[data-user-question-id]')).map((questionNode) => ({
        id: String(questionNode.dataset?.userQuestionId || '').trim(),
        prompt: String(questionNode.querySelector('.user-questions-prompt-text')?.textContent || ''),
      }));
      const markup = userQuestionsRenderer?.renderUserQuestionsReceipt?.({
        toolCallId: String(block.dataset?.toolCallId || '').trim(),
        stale: true,
        questions,
      });
      if (!markup) {
        return;
      }
      block.dataset.userQuestionsStale = 'true';
      block.dataset.userQuestionsLivenessChecked = 'true';
      block.setAttribute('aria-label', jt('chat.questions.inactiveLabel', 'These questions are no longer active'));
      block.removeAttribute('aria-busy');
      block.innerHTML = markup;
    }

    function submitUserQuestions(block, decline) {
      if (!block || block.getAttribute('aria-busy') === 'true') {
        return;
      }
      const questionRef = String(block.dataset?.questionRef || '').trim();
      if (!questionRef) {
        return;
      }
      const originSessionId = String(state?.currentSessionId || '').trim();
      const fallbackTarget = resolveApprovalFocusFallback(block);
      const heldFocus = Boolean(doc && block.contains(doc.activeElement));
      const answers = decline ? null : collectUserQuestionAnswers(block);
      setUserQuestionsBlockBusy(block, true);
      const chat = getJennyShell()?.chat;
      const request = decline
        ? () => chat.declineUserQuestions(questionRef)
        : () => chat.answerUserQuestions(questionRef, { answers });
      Promise.resolve()
        .then(request)
        .then((result) => {
          if (isActionDisposed()) {
            return;
          }
          if (result === false) {
            // The waiter was already settled elsewhere (stream ended, another
            // window answered/declined, approval timeout). The stale receipt
            // is passive — also raise the explicit failure surface so the
            // user knows their answers were NOT delivered.
            markUserQuestionsStale(block);
            showComposerActionError(
              new Error('These questions were already resolved or are no longer active.'),
              decline ? jt('chat.questions.declineFailedTitle', 'Decline Failed') : jt('chat.questions.submitFailedTitle', 'Submit Failed')
            );
            return;
          }
          const currentSessionId = String(state?.currentSessionId || '').trim();
          if (originSessionId === currentSessionId && block.isConnected) {
            watchApprovalRowRemoval(block, fallbackTarget, heldFocus);
          }
        })
        .catch((error) => {
          if (isActionDisposed()) {
            return;
          }
          setUserQuestionsBlockBusy(block, false);
          appendClientLog(
            'ERROR',
            decline ? 'chat.decline_user_questions_failed' : 'chat.answer_user_questions_failed',
            {
              questionRef: questionRef.slice(0, 120),
              message: String(error?.message || error).slice(0, 200),
            }
          );
          showComposerActionError(error, decline ? jt('chat.questions.declineFailedTitle', 'Decline Failed') : jt('chat.questions.submitFailedTitle', 'Submit Failed'));
        });
    }

    function checkUserQuestionsLiveness(block) {
      const check = getJennyShell()?.chat?.hasPendingUserQuestions;
      if (
        isActionDisposed()
        || typeof check !== 'function'
        || !block
        || block.dataset?.userQuestionsLivenessChecked === 'true'
        || block.dataset?.userQuestionsStale === 'true'
        || block.getAttribute('aria-busy') === 'true'
      ) {
        return;
      }
      const questionRef = String(block.dataset?.questionRef || '').trim();
      if (!questionRef) {
        return;
      }
      const originSessionId = String(state?.currentSessionId || '').trim();
      block.dataset.userQuestionsLivenessChecked = 'true';
      Promise.resolve()
        .then(() => check(questionRef))
        .then((pending) => {
          const currentSessionId = String(state?.currentSessionId || '').trim();
          if (
            !isActionDisposed()
            && pending === false
            && block.isConnected
            && originSessionId === currentSessionId
          ) {
            markUserQuestionsStale(block);
          }
        })
        .catch(() => {
          // The probe is best-effort, but a transient IPC failure must not
          // burn the card's single liveness check: clear the one-shot flag so
          // the next hover/focus retries (markUserQuestionsStale re-sets it
          // when the card is genuinely demoted).
          if (block?.dataset && block.dataset.userQuestionsStale !== 'true') {
            delete block.dataset.userQuestionsLivenessChecked;
          }
        });
    }

    // A key with no modifier, on a card that is not sending.
    function isPlainKey(event, block) {
      return Boolean(block) && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
        && block.getAttribute('aria-busy') !== 'true';
    }

    function focusOtherField(questionNode) {
      questionNode?.querySelector('[data-user-question-other-input]')?.focus();
    }

    // Enter submits from any option or text field, with the composer's IME guard.
    // Shift+Enter is a new line; Enter on a button presses that button (Skip stays Skip).
    function handleSubmitKeydown(event, block) {
      if (!isPlainKey(event, block) || !enterKeydownUtils?.shouldSendOnEnterKeydown?.(event)
        || event.target?.matches?.('button')) {
        return false;
      }
      const submit = block.querySelector('.user-questions-submit-btn:not(:disabled)');
      if (!submit) {
        return false;
      }
      event.preventDefault();
      submit.click();
      return true;
    }

    // Digit N picks row N (the options, then Other) of the question holding focus.
    function handleDigitKeydown(event, block) {
      if (!isPlainKey(event, block) || !/^[1-9]$/.test(String(event.key || '')) || event.isComposing === true) {
        return false;
      }
      const target = event.target;
      const questionNode = target?.closest?.('.user-questions-question');
      if (!questionNode || target.matches('textarea, input[type="text"]')) {
        return false;
      }
      const row = questionNode.querySelectorAll('.user-questions-option')[Number(event.key) - 1];
      const input = row?.querySelector('input[type="radio"], input[type="checkbox"]');
      if (!input || input.disabled) {
        return false;
      }
      event.preventDefault();
      input.checked = input.type === 'checkbox' ? !input.checked : true;
      const EventCtor = windowRef?.Event || globalThis.Event;
      input.dispatchEvent(new EventCtor('change', { bubbles: true }));
      if (input.hasAttribute('data-user-question-other-toggle') && input.checked) {
        focusOtherField(questionNode);
      } else {
        input.focus();
      }
      return true;
    }

    function handleKeydown(event, block) {
      return handleDigitKeydown(event, block) || handleSubmitKeydown(event, block);
    }

    // Typing in Other selects it (a radio group clears its siblings). Every edit
    // refreshes the count and Submit. The free-text box grows by CSS field-sizing.
    function handleFieldInput(event) {
      const target = event.target;
      const block = target?.closest?.('.user-questions-block[data-question-ref]');
      if (!block) {
        return;
      }
      if (target.matches('[data-user-question-other-input]')) {
        const toggle = target.closest('[data-user-question-id]')?.querySelector('[data-user-question-other-toggle]');
        if (toggle && !toggle.checked && String(target.value || '').trim() !== '') {
          toggle.checked = true;
        }
      }
      refreshUserQuestionsState(block);
    }

    function handleFieldChange(event) {
      const block = event.target?.closest?.('.user-questions-block[data-question-ref]');
      if (block) {
        refreshUserQuestionsState(block);
      }
    }

    // A pointer click on the Other row (not its text field) moves the caret into
    // the field once the label has ticked Other. Keyboard selection (arrow keys,
    // detail 0) leaves focus on the radio so the user can keep arrowing.
    function handleOtherRowClick(event) {
      const row = event.target?.closest?.('.user-questions-block[data-question-ref] .user-questions-other-option');
      if (!row || !(event.detail > 0) || event.target.matches('[data-user-question-other-input]')) {
        return;
      }
      const settle = typeof windowRef?.setTimeout === 'function' ? windowRef.setTimeout.bind(windowRef) : setTimeout;
      settle(() => {
        if (!isActionDisposed() && row.querySelector('[data-user-question-other-toggle]')?.checked) {
          focusOtherField(row);
        }
      }, 0);
    }

    function dispose() {
      disposed = true;
    }

    return {
      checkUserQuestionsLiveness,
      handleFieldChange,
      handleFieldInput,
      handleKeydown,
      handleOtherRowClick,
      submitUserQuestions,
      dispose,
    };
  }

  return { createUserQuestionsActions };
});
