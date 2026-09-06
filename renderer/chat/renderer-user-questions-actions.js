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

  const STALLED_DELAY_MS = 30000;

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
      stalledDelayMs = STALLED_DELAY_MS,
    } = deps;
    const stalledBlocks = new WeakSet();
    const stalledTimers = new Map();
    let disposed = false;

    function isActionDisposed() {
      return disposed || isDisposed();
    }

    function isPendingBlock(block) {
      return Boolean(
        block
        && block.isConnected
        && block.dataset?.userQuestionsStale !== 'true'
        && block.getAttribute('aria-busy') !== 'true'
        && !block.querySelector?.('.user-questions-receipt')
      );
    }

    function clearStalledTimer(block, { clearState = false } = {}) {
      if (stalledTimers.has(block)) {
        const timerHandle = stalledTimers.get(block);
        if (typeof windowRef?.clearTimeout === 'function') {
          windowRef.clearTimeout(timerHandle);
        }
      }
      stalledTimers.delete(block);
      if (clearState && block?.dataset) {
        delete block.dataset.stalled;
      }
    }

    function startStalledTimer(block) {
      if (
        isActionDisposed()
        || !isPendingBlock(block)
        || stalledBlocks.has(block)
        || typeof windowRef?.setTimeout !== 'function'
      ) {
        return;
      }
      stalledBlocks.add(block);
      const timerHandle = windowRef.setTimeout(() => {
        stalledTimers.delete(block);
        if (!isActionDisposed() && isPendingBlock(block)) {
          block.dataset.stalled = 'true';
        }
      }, stalledDelayMs);
      stalledTimers.set(block, timerHandle);
    }

    function setUserQuestionsBlockBusy(block, busy) {
      if (!block || typeof block.querySelectorAll !== 'function') {
        return;
      }
      block.setAttribute('aria-busy', busy ? 'true' : 'false');
      block.querySelectorAll('button, input, textarea, select').forEach((control) => {
        control.disabled = busy;
      });
      if (busy) {
        return;
      }
      block.querySelectorAll('[data-user-question-id]').forEach((questionNode) => {
        const otherToggle = questionNode.querySelector('[data-user-question-other-toggle]');
        const otherInput = questionNode.querySelector('[data-user-question-other-input]');
        if (otherInput) {
          otherInput.disabled = otherToggle?.checked !== true;
        }
      });
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
      clearStalledTimer(block, { clearState: true });
      const sessionId = String(state?.currentSessionId || '').trim();
      const questionRef = String(block.dataset?.questionRef || '').trim();
      streamToolHandlers?.markUserQuestionsStale?.(sessionId, questionRef, {
        getSessionMessages,
        setSessionMessages,
      });
      const markup = userQuestionsRenderer?.renderUserQuestionsReceipt?.({
        toolCallId: String(block.dataset?.toolCallId || '').trim(),
        stale: true,
      });
      if (!markup) {
        return;
      }
      block.dataset.userQuestionsStale = 'true';
      block.dataset.userQuestionsLivenessChecked = 'true';
      block.setAttribute('aria-label', 'Questions no longer active');
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
      clearStalledTimer(block, { clearState: true });
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
              decline ? 'Decline Failed' : 'Submit Failed'
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
          showComposerActionError(error, decline ? 'Decline Failed' : 'Submit Failed');
        });
    }

    function checkUserQuestionsLiveness(block) {
      startStalledTimer(block);
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

    function handleSubmitKeydown(event, block) {
      // Same Enter/IME contract as the composer (shared guard), plus the
      // question-card-specific bails: modifier chords and a busy card.
      if (
        !block
        || !enterKeydownUtils?.shouldSendOnEnterKeydown?.(event)
        || event.ctrlKey
        || event.altKey
        || event.metaKey
        || block.getAttribute('aria-busy') === 'true'
      ) {
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

    function dispose() {
      disposed = true;
      for (const [block, timerHandle] of stalledTimers) {
        if (typeof windowRef?.clearTimeout === 'function') {
          windowRef.clearTimeout(timerHandle);
        }
        if (block?.dataset) {
          delete block.dataset.stalled;
        }
      }
      stalledTimers.clear();
    }

    return {
      checkUserQuestionsLiveness,
      handleSubmitKeydown,
      submitUserQuestions,
      dispose,
    };
  }

  return { createUserQuestionsActions };
});
