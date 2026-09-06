(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-file-diff-bindings'),
      require('./renderer-unsaved-reply-actions'),
      require('./renderer-approval-batch-utils'),
      require('./renderer-tool-detail-body'),
      require('./renderer-user-questions-actions')
    );
    return;
  }
  root.rendererChatEventTranscriptBindings = factory(
    root.rendererFileDiffBindings || {},
    root.rendererUnsavedReplyActions || {},
    root.rendererApprovalBatchUtils || {},
    root.rendererToolDetailBody || {},
    root.rendererUserQuestionsActions || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  fileDiffBindings,
  unsavedReplyActions,
  approvalBatchUtils,
  toolDetailBody,
  userQuestionsActionsModule
) {
  const motionHeightUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionHeightUtils)
    || (typeof require === 'function' ? require('../shared/motion-height-utils') : null) || {};
  function createTranscriptEventBindings(deps) {
    const {
      chatTimeline,
      state,
      handleCopyMessage,
      handleRegenerateMessage,
      handleElaborateMessage,
      handleBranchMessage = function noopHandleBranchMessage() { return Promise.resolve(null); },
      handleEditMessage = function noopHandleEditMessage() {},
      handleEditCommit = function noopHandleEditCommit() { return Promise.resolve(null); },
      handleEditCancel = function noopHandleEditCancel() {},
      selectionController = null,
      handleSelectClick: handleSelectClickInput,
      handleFollowUpMessage,
      handleUseProactiveSuggestionMessage,
      handleSaveProactiveSuggestionMessage,
      handleLaterProactiveSuggestionMessage,
      handleErrorRecoveryAction,
      handleArtifactAction,
      handleCodeReviewAction = function noopHandleCodeReviewAction() { return Promise.resolve(); },
      handleOpenChangeDiff = function noopHandleOpenChangeDiff() { return Promise.resolve(false); },
      toggleInteractiveRoundRecap,
      toggleThreadBranch,
      setReasoningPhaseExpandedPreference, setReasoningPhaseExpandedPreferences,
      syncThinkingBlockNode,
      appendClientLog,
      showComposerActionError,
      renderAll = function noopRenderAll() {}, setToolCallExpansion = function noopSetToolCallExpansion() {},
      refreshRecoveredSession = function noopRefreshRecoveredSession() { return Promise.resolve(); },
      approvalReconcileDelayMs,
      approvalReconcileSetTimeout,
      approvalReconcileClearTimeout,
      resolveToolCallId,
      toggleToolDetails,
      getToolDetailsTransitionMs,
      thinkingController,
      timelineVirtualizer,
      getSessionMessages,
      setSessionMessages,
    } = deps || {};
    const doc = chatTimeline?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const unsavedReplyController = unsavedReplyActions.createUnsavedReplyActionController?.({
      state,
      windowRef: doc?.defaultView || (typeof window !== 'undefined' ? window : null),
      handleCopyMessage,
      appendClientLog,
      onResolved: refreshRecoveredSession,
    }) || null;
    let handleSelectClick;
    if (typeof handleSelectClickInput === 'function') {
      handleSelectClick = handleSelectClickInput;
    } else if (selectionController) {
      handleSelectClick = function defaultHandleSelectClick(messageId, opts) {
        const inMode = typeof selectionController.isSelectMode === 'function'
          ? selectionController.isSelectMode() === true
          : false;
        const shift = opts && opts.shiftKey === true;
        if (!inMode) {
          if (typeof selectionController.enterSelectMode === 'function') {
            selectionController.enterSelectMode();
          }
          if (typeof selectionController.toggleMessage === 'function') {
            selectionController.toggleMessage(messageId);
          }
          return;
        }
        if (shift && typeof selectionController.selectRange === 'function') {
          selectionController.selectRange(messageId);
          return;
        }
        if (typeof selectionController.toggleMessage === 'function') {
          selectionController.toggleMessage(messageId);
        }
      };
    } else {
      handleSelectClick = function noopHandleSelectClick() { /* no-op */ };
    }

    function syncInteractiveRecapFallback(recapId, expanded) {
      const normalizedRecapId = String(recapId || '').trim();
      if (!normalizedRecapId || !chatTimeline) {
        return;
      }
      const rows = chatTimeline.querySelectorAll(`[data-interactive-recap-row][data-recap-id="${normalizedRecapId}"]`);
      rows.forEach((row) => {
        row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        row.classList.toggle('expanded', expanded);
        const recapBlock = row.closest('.interactive-recap-block');
        if (recapBlock) {
          recapBlock.classList.toggle('expanded', expanded);
        }
        const panelId = String(row.getAttribute('aria-controls') || '').trim();
        const panel = panelId && doc
          ? doc.getElementById(panelId)
          : row.parentElement?.querySelector('.interactive-recap-panel') || null;
        if (!panel) {
          return;
        }
        panel.classList.toggle('expanded', expanded);
        panel.hidden = !expanded;
      });
    }

    function toggleInteractiveRecapFromNode(recapRow) {
      if (!recapRow) {
        return;
      }
      const recapId = String(recapRow.dataset.recapId || '').trim();
      const initialExpanded = recapRow.getAttribute('aria-expanded') === 'true';
      syncInteractiveRecapFallback(recapId, !initialExpanded);
      Promise.resolve(toggleInteractiveRoundRecap({
        messageId: recapRow.dataset.messageId,
        recapId,
      })).catch((error) => {
        showComposerActionError(error, 'Recap Toggle Failed');
      });
    }

    // A2: resolve the actual `.tool-approval-block` container for a clicked
    // Allow/Deny button. `button.closest('[data-call-id], [data-tool-call-id]')`
    // self-matches the button (it carries those data attributes too), which
    // would scope setApprovalBlockBusy's querySelectorAll to the button's own
    // (empty) subtree — walk to the button's parentElement first so the
    // .closest() search starts above the button itself.
    function resolveApprovalBlockContainer(button) {
      if (!button) {
        return null;
      }
      const searchRoot = button.parentElement || button;
      return searchRoot.closest('.tool-approval-block')
        || searchRoot.closest('[data-call-id], [data-tool-call-id]')
        || null;
    }

    // A2: shared busy/disable helper for the Allow/Deny pair in a single
    // approval block, mirroring renderer-approval-batch-utils.js's
    // setBannerBusy (busyBanners/aria-disabled pattern) but scoped to the two
    // buttons that live in the same block rather than a whole banner.
    function setApprovalBlockBusy(block, busy) {
      if (!block || typeof block.querySelectorAll !== 'function') {
        return;
      }
      block.querySelectorAll('.tool-approve-btn, .tool-deny-btn').forEach((button) => {
        button.disabled = busy;
        if (busy) {
          button.setAttribute('aria-busy', 'true');
        } else {
          button.removeAttribute('aria-busy');
        }
      });
    }

    const windowRef = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
    const approvalReconciliation = approvalBatchUtils.createApprovalReconciliationController?.({
      scopeRoot: chatTimeline,
      getActiveTurnState: (sessionId) => windowRef?.jennyShell?.chat?.getActiveTurnState?.(sessionId),
      rehydrateSession: (sessionId) => refreshRecoveredSession({ payload: { sessionId }, reason: 'approval_reconcile' }),
      getCurrentSessionId: () => state.currentSessionId,
      setBlockBusy: setApprovalBlockBusy,
      appendClientLog,
      delayMs: approvalReconcileDelayMs,
      setTimeoutFn: approvalReconcileSetTimeout,
      clearTimeoutFn: approvalReconcileClearTimeout,
    }) || { start() {}, dispose() {} };
    const approvalRowRemovalWatchers = new Set();
    let disposed = false;

    // A2: snapshot the fallback focus target BEFORE the approval row can be
    // removed from the DOM. Row removal (removeApprovalGapRow) is driven by a
    // later stream event through the reducer/render pipeline, not by this
    // click handler, so we can't rely on a single post-render callback here —
    // instead a MutationObserver watches for the row's actual removal and
    // focuses the fallback the moment it happens (no setTimeout race).
    function resolveApprovalFocusFallback(currentRow) {
      if (!chatTimeline || typeof chatTimeline.querySelectorAll !== 'function') {
        return null;
      }
      // Plan-variant gap rows are deliberately actionless (no buttons, no
      // tabindex — see renderer-approval-block.js), so they can never receive
      // focus; keep them out of the fallback pool (lockstep with the batch
      // selector in renderer-approval-batch-utils.js).
      const pendingRows = Array.from(
        chatTimeline.querySelectorAll('.approval-gap-row:not([data-approval-variant="plan"]), .tool-approval-block, .user-questions-block')
      );
      const nextRow = pendingRows.find((candidate) => candidate !== currentRow
        && !currentRow.contains(candidate)
        && !candidate.contains(currentRow));
      if (nextRow) {
        return nextRow.querySelector('.tool-approve-btn, .tool-deny-btn') || nextRow;
      }
      const composerInput = doc && typeof doc.getElementById === 'function'
        ? doc.getElementById('chatInput')
        : null;
      return composerInput || null;
    }

    function focusApprovalFallback(fallbackTarget) {
      if (!fallbackTarget || typeof fallbackTarget.focus !== 'function') {
        return;
      }
      // The fallback may itself have been removed/replaced between the
      // snapshot and the row actually disappearing (e.g. resolved out of
      // order); skip focusing a detached node.
      if (typeof fallbackTarget.isConnected === 'boolean' && !fallbackTarget.isConnected) {
        return;
      }
      try {
        fallbackTarget.focus();
      } catch (_error) {
        // Best-effort only — focus restoration must never throw into the
        // click handler's promise chain.
      }
    }

    // Observes `approvalRow` for its own removal from the DOM (which
    // removeApprovalGapRow performs via Array.splice-equivalent DOM removal
    // once the reducer sees the call resolve) and focuses the pre-snapshotted
    // fallback the moment that happens. Self-disconnects after firing once or
    // after a real timeout so a row that never gets
    // removed (e.g. a resolution that doesn't retire the row for some reason)
    // doesn't leak an observer forever.
    //
    // `heldFocus` is a snapshot (taken at click time, before any async gap)
    // of whether the approval row actually held focus when the user clicked
    // Allow/Deny. Without this gate, the restore fires unconditionally on
    // removal — stealing focus back from wherever the user has since moved
    // it (e.g. into the composer to keep typing) even though the row wasn't
    // focused to begin with.
    function watchApprovalRowRemoval(approvalRow, fallbackTarget, heldFocus) {
      if (!approvalRow || !fallbackTarget) {
        return;
      }
      const win = doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null);
      if (!win || typeof win.MutationObserver !== 'function') {
        // No MutationObserver available (non-browser environment) — fall back
        // to focusing immediately, since there is no reliable removal signal
        // to wait for.
        if (heldFocus) {
          focusApprovalFallback(fallbackTarget);
        }
        return;
      }
      let settled = false;
      let timeoutHandle = null;
      const watcher = {
        disconnect() {
          if (settled) return;
          settled = true;
          observer.disconnect();
          if (timeoutHandle !== null && typeof win.clearTimeout === 'function') {
            win.clearTimeout(timeoutHandle);
          }
          timeoutHandle = null;
          approvalRowRemovalWatchers.delete(watcher);
        },
      };
      const observer = new win.MutationObserver(() => {
        if (settled) {
          return;
        }
        if (!approvalRow.isConnected) {
          watcher.disconnect();
          // Only restore focus if the row held it at click time AND focus is
          // still orphaned by the removal (nothing else claimed it in the
          // meantime) — never pull focus away from an element the user has
          // since moved to on their own.
          const active = doc ? doc.activeElement : null;
          const focusOrphaned = !active || active === doc.body || approvalRow.contains(active);
          if (heldFocus && focusOrphaned) {
            focusApprovalFallback(fallbackTarget);
          }
        }
      });
      const observeRoot = (approvalRow.parentNode && approvalRow.parentNode.isConnected)
        ? approvalRow.parentNode
        : chatTimeline;
      if (!observeRoot) {
        focusApprovalFallback(fallbackTarget);
        return;
      }
      observer.observe(observeRoot, { childList: true, subtree: true });
      approvalRowRemovalWatchers.add(watcher);
      timeoutHandle = win.setTimeout(() => watcher.disconnect(), 5000);
    }

    const userQuestionsActions = userQuestionsActionsModule.createUserQuestionsActions?.({
      state,
      doc,
      windowRef,
      appendClientLog,
      showComposerActionError,
      resolveApprovalFocusFallback,
      watchApprovalRowRemoval,
      isDisposed: () => disposed,
      getJennyShell: () => windowRef?.jennyShell,
      getSessionMessages,
      setSessionMessages,
      streamToolHandlers: typeof globalThis !== 'undefined'
        ? globalThis.rendererStreamHandlerTools
        : null,
    }) || {
      checkUserQuestionsLiveness() {},
      handleSubmitKeydown() { return false; },
      submitUserQuestions() {},
      dispose() {},
    };

    // CTL-009: a resolved `false` from tools.approve/deny is a REFUSAL, not a
    // success — the approval reference is no longer pending (the approval
    // timeout deleted the pending entry before the click's IPC round-trip
    // landed, or the auxiliary fallback tier returned false for a stale
    // callId). Re-enable the controls so the user isn't stuck staring at a
    // permanently-disabled Allow/Deny pair, and surface a bounded message
    // instead of waiting forever for a row removal that will never come.
    // Returns true when refused so the caller bails before wiring the
    // row-removal watcher.
    function handleApprovalOutcomeRefused(result, { block, callId, logEvent, title }) {
      if (result !== false) {
        return false;
      }
      setApprovalBlockBusy(block, false);
      appendClientLog('WARN', logEvent, { callId });
      showComposerActionError(
        new Error('This approval request was already resolved or is no longer active.'),
        title
      );
      return true;
    }

    const revealTimers = new WeakMap();
    function animateRevealHeight(el, expanded) {
      if (!el) {
        return;
      }
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || null;
      const raf = win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : null;
      const setT = win && win.setTimeout ? win.setTimeout.bind(win) : null;
      const clearT = win && win.clearTimeout ? win.clearTimeout.bind(win) : null;
      const pending = revealTimers.get(el);
      if (pending && clearT) {
        clearT(pending);
      }
      revealTimers.delete(el);
      const transitionMs = typeof getToolDetailsTransitionMs === 'function'
        ? (Number(getToolDetailsTransitionMs()) || 0)
        : 0;
      const settle = () => { el.style.maxHeight = expanded ? 'none' : ''; };
      if (transitionMs === 0 || !raf || !setT) {
        settle();
        return;
      }
      if (expanded) {
        motionHeightUtils.pinHeightForTransition(el, 0);
        raf(() => { el.style.maxHeight = `${Math.max(el.scrollHeight || 0, 0)}px`; });
      } else {
        motionHeightUtils.pinHeightForTransition(el, motionHeightUtils.resolveCollapseStartPx(el));
        raf(() => { el.style.maxHeight = '0px'; });
      }
      revealTimers.set(el, setT(() => { settle(); revealTimers.delete(el); }, transitionMs));
    }
    function toggleMinimalToolRow(toggleNode, forceExpanded) {
      const rowNode = toggleNode && typeof toggleNode.closest === 'function'
        ? toggleNode.closest('.tool-call-row--minimal')
        : null;
      if (!rowNode) {
        return;
      }
      const rowKey = toggleNode.dataset?.toolRowKey || rowNode.dataset?.toolRowKey || '';
      const nextExpanded = typeof forceExpanded === 'boolean'
        ? forceExpanded : rowNode.getAttribute('data-expanded') !== 'true';
      const restoreFocus = doc?.activeElement === toggleNode;
      const toolRowUtils = typeof globalThis !== 'undefined' ? globalThis.rendererTurnRowToolRenderUtils : null;
      if (rowKey && toolRowUtils && typeof toolRowUtils.setToolRowExpansion === 'function') {
        toolRowUtils.setToolRowExpansion(rowKey, nextExpanded);
      }
      if (rowKey && typeof chatTimeline?.dispatchEvent === 'function') {
        const CustomEventCtor = doc?.defaultView?.CustomEvent || globalThis.CustomEvent;
        if (typeof CustomEventCtor === 'function') {
          chatTimeline.dispatchEvent(new CustomEventCtor('tool-row-user-expansion', {
            detail: { rowKey, expanded: nextExpanded },
          }));
        }
      }
      if (nextExpanded && rowNode.dataset?.toolDetailsMaterialized === 'false') {
        const bodyNode = rowNode.querySelector('.tool-call-row-body');
        const materialized = !bodyNode
          ? { ok: false, reason: 'missing_body', markup: '' }
          : (toolRowUtils && typeof toolRowUtils.materializeToolRowDetails === 'function'
            ? toolRowUtils.materializeToolRowDetails(rowKey)
            : { ok: false, reason: 'materializer_unavailable', markup: '' });
        if (materialized.ok && bodyNode) {
          bodyNode.innerHTML = materialized.markup;
          rowNode.dataset.toolDetailsMaterialized = 'true';
        } else {
          appendClientLog?.('WARN', 'tool.details_materialization_fallback', {
            rowKey: String(rowKey || '').slice(0, 240),
            reason: String(materialized.reason || 'unknown').slice(0, 80),
          });
          renderAll({ forceFullRender: true });
          const materializedToggle = Array.from(chatTimeline.querySelectorAll('[data-tool-row-toggle]'))
            .find((node) => node.dataset?.toolRowKey === rowKey);
          const didMaterialize = materializedToggle
            ?.closest?.('.tool-call-row--minimal')?.dataset?.toolDetailsMaterialized === 'true';
          if (didMaterialize) toggleMinimalToolRow(materializedToggle, true);
          if (restoreFocus) materializedToggle?.focus?.({ preventScroll: true });
          return;
        }
      }
      rowNode.setAttribute('data-expanded', nextExpanded ? 'true' : 'false');
      toggleNode.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
      const bodyNode = rowNode.querySelector('.tool-call-row-body');
      if (bodyNode) {
        // Visibility is owned by the inert attribute + CSS (resting state keyed
        // on data-expanded); animateRevealHeight handles the smooth max-height.
        if (nextExpanded) {
          bodyNode.removeAttribute('inert');
        } else {
          bodyNode.setAttribute('inert', '');
        }
        if (typeof animateRevealHeight === 'function') {
          animateRevealHeight(bodyNode, nextExpanded);
        }
      }
    }

    function bindTranscriptEvents(registerListener, listenerOptions, bindAbortController) {
      registerListener(chatTimeline, 'click', async (event) => {
        const questionOption = event.target.closest('[data-user-question-option], [data-user-question-other-toggle]');
        if (questionOption) {
          const questionNode = questionOption.closest('[data-user-question-id]');
          const otherToggle = questionNode?.querySelector?.('[data-user-question-other-toggle]');
          const otherInput = questionNode?.querySelector?.('[data-user-question-other-input]');
          if (otherInput) {
            otherInput.disabled = otherToggle?.checked !== true;
            if (!otherInput.disabled) otherInput.focus();
          }
          return;
        }

        const questionsAction = event.target.closest('.user-questions-submit-btn, .user-questions-decline-btn');
        if (questionsAction) {
          event.preventDefault();
          if (!questionsAction.disabled) {
            userQuestionsActions.submitUserQuestions(
              questionsAction.closest('.user-questions-block'),
              questionsAction.classList.contains('user-questions-decline-btn')
            );
          }
          return;
        }

        const toolApproveBtn = event.target.closest('.tool-approve-btn');
        if (toolApproveBtn) {
          event.preventDefault();
          // A2 double-click guard: the block is already busy (either button
          // mid-request) — ignore the re-click rather than firing a second
          // tools.approve for the same call.
          if (toolApproveBtn.disabled || toolApproveBtn.getAttribute('aria-busy') === 'true') {
            return;
          }
          const callId = resolveToolCallId(toolApproveBtn);
          if (callId) {
            const block = resolveApprovalBlockContainer(toolApproveBtn);
            // The scope is the button that was pressed ("Allow once" vs
            // "Always allow"), never a modifier read from elsewhere in the block.
            const alwaysAllow = toolApproveBtn.getAttribute('data-approval-scope') === 'always';
            const originSessionId = String(state.currentSessionId || '').trim();
            const approvalRow = toolApproveBtn.closest('.approval-gap-row') || block;
            const fallbackTarget = approvalRow ? resolveApprovalFocusFallback(approvalRow) : null;
            // Snapshot BEFORE setApprovalBlockBusy/disabling the button — disabling
            // can itself blur it, so this must reflect focus at click time.
            const heldFocus = !!(approvalRow && doc && approvalRow.contains(doc.activeElement));
            setApprovalBlockBusy(block, true);
            window.jennyShell.tools.approve(callId, { alwaysAllow }).then((result) => {
              // CTL-009 refusal handling — see handleApprovalOutcomeRefused.
              if (handleApprovalOutcomeRefused(result, {
                block, callId, logEvent: 'tool.approve_refused', title: 'Approval Failed',
              })) {
                return;
              }
              // Success: removeApprovalGapRow (renderer-turn-reducer-approval-gap.js)
              // splices this row out once the reducer sees the resolved status
              // come back over the event stream — watch for that removal and
              // restore focus to the pre-snapshotted fallback when it happens
              // (but only if the row actually held focus at click time — see
              // watchApprovalRowRemoval's heldFocus gate).
              // No re-enable here: the row (and its buttons) is on its way out.
              if (approvalRow) {
                const originStillCurrent = originSessionId === String(state.currentSessionId || '').trim();
                approvalReconciliation.start({ sessionId: originSessionId, reference: callId, row: approvalRow, block });
                if (originStillCurrent && approvalRow.isConnected) watchApprovalRowRemoval(approvalRow, fallbackTarget, heldFocus);
              }
            }).catch((error) => {
              setApprovalBlockBusy(block, false);
              appendClientLog('ERROR', 'tool.approve_failed', { callId, message: error.message || String(error) });
              showComposerActionError(error, 'Approval Failed');
            });
          }
          return;
        }

        const toolDenyBtn = event.target.closest('.tool-deny-btn');
        if (toolDenyBtn) {
          event.preventDefault();
          if (toolDenyBtn.disabled || toolDenyBtn.getAttribute('aria-busy') === 'true') {
            return;
          }
          const callId = resolveToolCallId(toolDenyBtn);
          if (callId) {
            const block = resolveApprovalBlockContainer(toolDenyBtn);
            const originSessionId = String(state.currentSessionId || '').trim();
            const approvalRow = toolDenyBtn.closest('.approval-gap-row') || block;
            const fallbackTarget = approvalRow ? resolveApprovalFocusFallback(approvalRow) : null;
            // Snapshot BEFORE setApprovalBlockBusy/disabling the button — see
            // the matching comment in the Allow branch above.
            const heldFocus = !!(approvalRow && doc && approvalRow.contains(doc.activeElement));
            setApprovalBlockBusy(block, true);
            window.jennyShell.tools.deny(callId).then((result) => {
              // CTL-009 refusal handling — see handleApprovalOutcomeRefused.
              if (handleApprovalOutcomeRefused(result, {
                block, callId, logEvent: 'tool.deny_refused', title: 'Deny Failed',
              })) {
                return;
              }
              if (approvalRow) {
                const originStillCurrent = originSessionId === String(state.currentSessionId || '').trim();
                approvalReconciliation.start({ sessionId: originSessionId, reference: callId, row: approvalRow, block });
                if (originStillCurrent && approvalRow.isConnected) watchApprovalRowRemoval(approvalRow, fallbackTarget, heldFocus);
              }
            }).catch((error) => {
              setApprovalBlockBusy(block, false);
              appendClientLog('ERROR', 'tool.deny_failed', { callId, message: error.message || String(error) });
              showComposerActionError(error, 'Deny Failed');
            });
          }
          return;
        }

        const toolHeader = event.target.closest('.tool-call-header');
        if (toolHeader) {
          event.preventDefault();
          const expanded = toolHeader.getAttribute('aria-expanded') === 'true';
          toggleToolDetails(toolHeader, !expanded);
          return;
        }

        const threadToggle = event.target.closest('[data-thread-toggle]');
        if (threadToggle) {
          event.preventDefault();
          toggleThreadBranch(threadToggle.getAttribute('data-thread-toggle'));
          return;
        }

        const errorActionButton = event.target.closest('[data-inv-error-action]');
        if (errorActionButton) {
          event.preventDefault();
          /* Guard double-fire: a second click while the action is in flight
           * would dispatch a duplicate regenerate. Mark the button busy and
           * restore on settle (a successful retry usually replaces the card). */
          if (errorActionButton.getAttribute('aria-busy') === 'true') {
            return;
          }
          errorActionButton.setAttribute('aria-busy', 'true');
          errorActionButton.disabled = true;
          handleErrorRecoveryAction({
            action: errorActionButton.dataset.invErrorAction,
            callId: errorActionButton.dataset.callId,
            sessionId: errorActionButton.dataset.sessionId,
            messageId: errorActionButton.dataset.messageId,
            errorClass: errorActionButton.dataset.errorClass, streamId: errorActionButton.dataset.streamId,
            contextNode: errorActionButton,
          }).catch((error) => {
            showComposerActionError(error, 'Error Action Failed');
          }).finally(() => {
            errorActionButton.removeAttribute('aria-busy');
            errorActionButton.disabled = false;
          });
          return;
        }

        const artifactActionButton = event.target.closest('[data-inv-artifact-action]');
        if (artifactActionButton) {
          event.preventDefault();
          handleArtifactAction({
            action: artifactActionButton.dataset.invArtifactAction,
            artifactId: artifactActionButton.dataset.artifactId,
            sessionId: artifactActionButton.dataset.sessionId,
            contextNode: artifactActionButton,
          }).catch((error) => {
            showComposerActionError(error, 'Artifact Action Failed');
          });
          return;
        }

        const codeReviewButton = event.target.closest('[data-jenny-code-review]');
        if (codeReviewButton) {
          event.preventDefault();
          Promise.resolve(handleCodeReviewAction({
            scope: codeReviewButton.dataset.scope,
            changeId: codeReviewButton.dataset.changeId,
            turnId: codeReviewButton.dataset.turnId,
            fileKey: codeReviewButton.dataset.fileKey,
            contextNode: codeReviewButton,
          })).catch((error) => {
            showComposerActionError(error, 'Code Review Failed');
          });
          return;
        }

        const diffRowToggle = event.target.closest('[data-file-diff-toggle]');
        if (diffRowToggle) {
          event.preventDefault();
          fileDiffBindings.toggleFileDiff?.(diffRowToggle, { appendClientLog });
          return;
        }

        const openChangeDiffButton = event.target.closest('[data-jenny-open-change-diff]');
        if (openChangeDiffButton) {
          event.preventDefault();
          Promise.resolve(handleOpenChangeDiff({
            changeId: openChangeDiffButton.dataset.changeId,
            contextNode: openChangeDiffButton,
          })).catch((error) => {
            showComposerActionError(error, 'Open Diff Failed');
          });
          return;
        }

        const recapRow = event.target.closest('[data-interactive-recap-row]');
        if (recapRow) {
          event.preventDefault();
          toggleInteractiveRecapFromNode(recapRow);
          return;
        }

        // F4/F5/F6: selection-handle click (multi-select toggle / range). Runs
        // BEFORE the edit/message-action cascade so the click on the checkbox
        // affordance never bubbles into the underlying bubble copy action.
        const selectionHandleTarget = event.target.closest('[data-select-message-id]');
        if (selectionHandleTarget) {
          event.preventDefault();
          event.stopPropagation();
          const messageId = String(selectionHandleTarget.dataset.selectMessageId || '').trim();
          if (messageId) {
            try {
              handleSelectClick(messageId, {
                shiftKey: event.shiftKey === true,
                ctrlKey: event.ctrlKey === true || event.metaKey === true,
              });
            } catch (error) {
              appendClientLog('ERROR', 'chat.selection_click_failed', {
                messageId,
                message: error && error.message || String(error),
              });
            }
          }
          return;
        }

        const unsavedReplyTarget = event.target.closest('[data-unsaved-reply-action]');
        if (unsavedReplyTarget && unsavedReplyController) {
          event.preventDefault();
          const action = String(unsavedReplyTarget.dataset.unsavedReplyAction || '').trim();
          unsavedReplyController.dispatch(unsavedReplyTarget).catch((error) => {
            if (action === 'copy') {
              appendClientLog('ERROR', 'chat.message_copy_failed', {
                messageId: String(unsavedReplyTarget.dataset.messageId || '').slice(0, 30),
                message: error?.message || String(error),
              });
              return;
            }
            showComposerActionError(
              error,
              action === 'discard' ? 'Discard Failed' : 'Save Retry Failed'
            );
          });
          return;
        }

        // Single .closest() walk finds either the inline edit Save/Cancel
        // buttons (F2) or any hover-action button. data-edit-action wins
        // when both attributes are present so the inline editor's buttons
        // route to the edit controller, not the hover cascade.
        const dispatchTarget = event.target.closest('[data-edit-action], [data-message-action]');
        if (dispatchTarget && dispatchTarget.dataset.editAction) {
          event.preventDefault();
          const editAction = String(dispatchTarget.dataset.editAction || '').trim();
          if (editAction === 'save') {
            try {
              const maybePromise = handleEditCommit();
              if (maybePromise && typeof maybePromise.catch === 'function') {
                maybePromise.catch((error) => showComposerActionError(error, 'Edit Failed'));
              }
            } catch (error) {
              showComposerActionError(error, 'Edit Failed');
            }
          } else if (editAction === 'cancel') {
            try {
              handleEditCancel();
            } catch (_) { /* cancel is best-effort */ }
          }
          return;
        }

        const actionButton = dispatchTarget;
        if (actionButton) {
          const { messageAction, messageId } = actionButton.dataset;
          event.preventDefault();
          if (!messageId) {
            return;
          }
          if (messageAction === 'edit') {
            try {
              handleEditMessage(messageId);
            } catch (error) {
              showComposerActionError(error, 'Edit Failed');
            }
            return;
          }
          if (messageAction === 'copy') {
            handleCopyMessage(messageId).catch((error) => {
              appendClientLog('ERROR', 'chat.message_copy_failed', {
                messageId,
                message: error.message || String(error),
              });
            });
            return;
          }
          if (messageAction === 'regenerate') {
            handleRegenerateMessage(messageId).catch((error) => {
              showComposerActionError(error, 'Regenerate Failed');
            });
            return;
          }
          if (messageAction === 'branch') {
            handleBranchMessage(messageId).catch((error) => {
              showComposerActionError(error, 'Branch Failed');
            });
            return;
          }
          if (messageAction === 'elaborate') {
            handleElaborateMessage(messageId).catch((error) => {
              showComposerActionError(error, 'Elaborate Failed');
            });
            return;
          }
          if (messageAction === 'follow-up') {
            handleFollowUpMessage(messageId).catch((error) => {
              showComposerActionError(error, 'Follow-up Failed');
            });
            return;
          }
          if (messageAction === 'use-suggestion') {
            handleUseProactiveSuggestionMessage(messageId).catch((error) => {
              showComposerActionError(error, 'Suggestion Failed');
            });
            return;
          }
          if (messageAction === 'save-suggestion') {
            handleSaveProactiveSuggestionMessage(messageId).catch((error) => {
              showComposerActionError(error, 'Save Failed');
            });
            return;
          }
          if (messageAction === 'later-suggestion') {
            handleLaterProactiveSuggestionMessage(messageId).catch((error) => {
              showComposerActionError(error, 'Later Failed');
            });
            return;
          }
          return;
        }

        const detailToggle = event.target.closest('[data-tool-detail-toggle]');
        if (detailToggle) {
          event.preventDefault();
          toolDetailBody?.toggleDetailClamp?.(detailToggle);
          return;
        }

        const toolRowToggle = event.target.closest('[data-tool-row-toggle]');
        if (toolRowToggle) {
          event.preventDefault();
          toggleMinimalToolRow(toolRowToggle);
          return;
        }

        const reasoningToggle = event.target.closest('[data-reasoning-toggle]');
        if (reasoningToggle) {
          event.preventDefault();
          const msgId = reasoningToggle.dataset.messageId;
          const tidAttr = reasoningToggle.dataset.phaseKey || reasoningToggle.dataset.thinkingId || '';
          const defaultExpanded = reasoningToggle.dataset.defaultExpanded === 'true';
          // data-reasoning-live-tail is stamped only for the streaming TAIL
          // phase (isStreamingTail && status === 'streaming') — non-tail
          // phases of a streaming message can also carry
          // data-reasoning-status="streaming", so status alone over-matches.
          const reasoningBlock = reasoningToggle.closest('.reasoning-row-block');
          const liveArticle = reasoningToggle.closest('.chat-entry[data-streaming-message-id]');
          const liveReasoningBlocks = liveArticle?.querySelectorAll('.reasoning-row-block');
          // Live-article tail position is a belt-and-braces fallback: a
          // mislabeled live tail must not silently kill scroll follow.
          const liveStreamingTail = reasoningBlock?.getAttribute('data-reasoning-live-tail') === 'true'
            || Boolean(liveReasoningBlocks?.length
              && reasoningBlock === liveReasoningBlocks[liveReasoningBlocks.length - 1]);
          const nextExpanded = thinkingController.togglePhaseExpanded
            ? thinkingController.togglePhaseExpanded(msgId, tidAttr, defaultExpanded, { liveStreamingTail })
            : thinkingController.toggleExpanded(msgId);
          setReasoningPhaseExpandedPreference?.(
            state.currentSessionId,
            msgId,
            tidAttr,
            nextExpanded,
            { defaultExpanded }
          );
          syncThinkingBlockNode(msgId, tidAttr);
        }
      }, listenerOptions);

      registerListener(chatTimeline, 'keydown', (event) => {
        const questionBlock = event.target.closest('.user-questions-block');
        if (userQuestionsActions.handleSubmitKeydown(event, questionBlock)) {
          return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const recapRow = event.target.closest('[data-interactive-recap-row]');
        if (recapRow) {
          event.preventDefault();
          toggleInteractiveRecapFromNode(recapRow);
          return;
        }

        // The error-code chip renders as a role=link span (badge primitive),
        // so Enter/Space must synthesize the click the delegate above
        // handles. Buttons are skipped — they activate natively.
        const errorActionLink = event.target.closest('[data-inv-error-action][role="link"]');
        if (errorActionLink) {
          event.preventDefault();
          errorActionLink.click();
          return;
        }

        // div[role="button"] (raw-primitive policy) needs explicit
        // Enter/Space activation.
        const toolRowToggle = event.target.closest('[data-tool-row-toggle]');
        if (toolRowToggle) {
          event.preventDefault();
          toggleMinimalToolRow(toolRowToggle);
          return;
        }

        const toolHeader = event.target.closest('.tool-call-header');
        if (!toolHeader) return;
        event.preventDefault();
        toggleToolDetails(toolHeader, toolHeader.getAttribute('aria-expanded') !== 'true');
      }, listenerOptions);

      const checkQuestionsFromEvent = (event) => {
        userQuestionsActions.checkUserQuestionsLiveness(
          event.target.closest('.user-questions-block[data-question-ref]')
        );
      };
      registerListener(chatTimeline, 'pointerover', checkQuestionsFromEvent, listenerOptions);
      registerListener(chatTimeline, 'focusin', checkQuestionsFromEvent, listenerOptions);
      chatTimeline.querySelectorAll('.user-questions-block[data-question-ref]').forEach(
        userQuestionsActions.checkUserQuestionsLiveness
      );

      const collapseExpandToggle = doc ? doc.getElementById('timelineCollapseExpandToggle') : null;
      if (collapseExpandToggle) {
        registerListener(collapseExpandToggle, 'click', (event) => {
          event.preventDefault();
          const clock = doc?.defaultView?.performance;
          const startedAt = typeof clock?.now === 'function' ? clock.now() : Date.now();
          const toolHeaders = Array.from(chatTimeline.querySelectorAll('.tool-call-header'));
          const minimalToolToggles = Array.from(chatTimeline.querySelectorAll('[data-tool-row-toggle]'));
          const reasoningToggles = Array.from(chatTimeline.querySelectorAll('[data-reasoning-toggle]'));
          const anyExpanded = toolHeaders.some(el => el.getAttribute('aria-expanded') === 'true') ||
                              minimalToolToggles.some(el => el.getAttribute('aria-expanded') === 'true') ||
                              reasoningToggles.some(el => el.getAttribute('aria-expanded') === 'true');
          const nextExpanded = !anyExpanded;
          const legacyToolKeys = new Set(toolHeaders.map((header) => String(header.dataset?.toolRowKey
            || header.closest?.('[data-tool-row-key]')?.dataset?.toolRowKey || '').trim()).filter(Boolean));
          const minimalToolKeys = new Set(minimalToolToggles.map((toggle) => String(toggle.dataset?.toolRowKey
            || toggle.closest?.('[data-tool-row-key]')?.dataset?.toolRowKey || '').trim()).filter(Boolean));
          const reasoningEntries = new Map();
          for (const toggle of reasoningToggles) {
            const messageId = String(toggle.dataset?.messageId || '').trim();
            const phaseKey = String(toggle.dataset?.phaseKey || toggle.dataset?.thinkingId || '').trim();
            if (messageId && phaseKey) reasoningEntries.set(`${messageId}::${phaseKey}`, {
              messageId, phaseKey, expanded: nextExpanded, defaultExpanded: toggle.dataset.defaultExpanded === 'true',
            });
          }
          for (const rowKey of legacyToolKeys) setToolCallExpansion(rowKey, nextExpanded);
          const toolRowUtils = typeof globalThis !== 'undefined' ? globalThis.rendererTurnRowToolRenderUtils : null;
          for (const rowKey of minimalToolKeys) toolRowUtils?.setToolRowExpansion?.(rowKey, nextExpanded);
          const CustomEventCtor = doc?.defaultView?.CustomEvent || globalThis.CustomEvent;
          if (typeof CustomEventCtor === 'function') {
            for (const rowKey of new Set([...legacyToolKeys, ...minimalToolKeys])) {
              chatTimeline.dispatchEvent(new CustomEventCtor('tool-row-user-expansion', {
                detail: { rowKey, expanded: nextExpanded },
              }));
            }
          }
          const reasoningBatch = [...reasoningEntries.values()];
          for (const entry of reasoningBatch) {
            thinkingController?.phaseExpansionState?.set?.(`${entry.messageId}::${entry.phaseKey}`, nextExpanded);
          }
          if (typeof setReasoningPhaseExpandedPreferences === 'function') {
            setReasoningPhaseExpandedPreferences(state?.currentSessionId, reasoningBatch);
          } else {
            for (const entry of reasoningBatch) setReasoningPhaseExpandedPreference?.(
              state?.currentSessionId, entry.messageId, entry.phaseKey, nextExpanded,
              { defaultExpanded: entry.defaultExpanded }
            );
          }
          const rowCount = legacyToolKeys.size + minimalToolKeys.size + reasoningBatch.length;
          if (rowCount > 0) renderAll({ forceFullRender: true });
          // Bulk expand/collapse is a deliberate reasoning interaction: drop
          // live-tail follow exemptions so an expanded tail pauses again
          // (2026-08-29 review fix).
          thinkingController?.clearFollowExemptions?.();
          if (typeof thinkingController?.syncReasoningExpansionPause === 'function') {
            thinkingController.syncReasoningExpansionPause({ userInitiated: true });
          } else if (thinkingController) {
            thinkingController.autoScrollPaused = true;
          }
          const finishedAt = typeof clock?.now === 'function' ? clock.now() : Date.now();
          appendClientLog?.('INFO', 'chat.timeline_bulk_expansion', {
            expanded: nextExpanded, legacyToolRows: legacyToolKeys.size, minimalToolRows: minimalToolKeys.size,
            reasoningRows: reasoningBatch.length,
            elapsedMs: Math.max(0, Math.round(finishedAt - startedAt)),
          });
        }, listenerOptions);
      }

    }

    return { bindTranscriptEvents, dispose: () => {
      disposed = true;
      userQuestionsActions.dispose();
      for (const watcher of [...approvalRowRemovalWatchers]) watcher.disconnect();
      approvalReconciliation.dispose();
      fileDiffBindings.disposeFileDiffBindings?.();
    } };
  }

  return { createTranscriptEventBindings };
});
