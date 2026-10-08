(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-file-diff-bindings'),
      require('./renderer-unsaved-reply-actions'),
      require('./renderer-approval-batch-utils'),
      require('./renderer-tool-detail-body'),
      require('./renderer-user-questions-actions'),
      require('./renderer-approval-focus-restore')
    );
    return;
  }
  root.rendererChatEventTranscriptBindings = factory(
    root.rendererFileDiffBindings || {},
    root.rendererUnsavedReplyActions || {},
    root.rendererApprovalBatchUtils || {},
    root.rendererToolDetailBody || {},
    root.rendererUserQuestionsActions || {},
    root.rendererApprovalFocusRestore || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  fileDiffBindings,
  unsavedReplyActions,
  approvalBatchUtils,
  toolDetailBody,
  userQuestionsActionsModule,
  approvalFocusRestoreModule
) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
      handleStopActiveStream = function noopHandleStopActiveStream() { return Promise.resolve(); },
      handleCodeReviewAction = function noopHandleCodeReviewAction() { return Promise.resolve(); },
      handleOpenChangeDiff = function noopHandleOpenChangeDiff() { return Promise.resolve(false); },
      toggleInteractiveRoundRecap,
      toggleContextCompactionDetails = function noopToggleContextCompactionDetails() {},
      toggleThreadBranch,
      setReasoningPhaseExpandedPreference,
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
      ownsFileDiffRegistry = true, // W2-3: a second pane's dispose leaves the shared file-diff registry to pane 0
      getSessionId = () => String(state?.currentSessionId || '').trim(), // the pane's session (split view)
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
        showComposerActionError(error, jt('chat.transcript.recapToggleFailedTitle', 'Recap Toggle Failed'));
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

    // F14: answer Resume's re-offer (new approval id), matched by call id within this session only.
    function answerLiveApproval(button, id, sessionId, answer) {
      const approvals = state.pendingToolApprovals instanceof Map ? state.pendingToolApprovals : null;
      const callId = String(button.dataset.callId || button.dataset.toolCallId || '').trim();
      const find = () => {
        if (!approvals || approvals.has(id)) return id;
        const matches = [...approvals.values()].filter((approval) => callId && String(approval?.callId || '').trim() === callId
          && String(approval?.sessionId || '').trim() === sessionId);
        return matches.length === 1 ? matches[0].approvalId : '';
      };
      if (find()) { try { return answer(find()); } catch (error) { return Promise.reject(error); } } // a synchronous throw still rejects: the caller releases its claim
      const wait = (waited) => new Promise((resolve) => setTimeout(resolve, 100))
        .then(() => (find() || waited >= 5000 ? answer(find() || id) : wait(waited + 100)));
      return wait(100);
    }

    // A2: busy/disable the Allow/Deny pair of one approval block (setBannerBusy, scoped to the block).
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
      getCurrentSessionId: () => getSessionId(),
      setBlockBusy: setApprovalBlockBusy,
      appendClientLog,
      delayMs: approvalReconcileDelayMs,
      setTimeoutFn: approvalReconcileSetTimeout,
      clearTimeoutFn: approvalReconcileClearTimeout,
    }) || { start() {}, dispose() {} };
    // CTR-006/007: one batch controller per pane timeline, sharing the per-approval in-flight claims with the card handlers below.
    const approvalClaims = approvalBatchUtils.approvalClaims || { claim: () => true, release() {} };
    const approvalBatch = approvalBatchUtils.bindApprovalBatchUx?.({
      scopeRoot: chatTimeline, document: doc, callbacks: {
        approveOne: (id, options) => window.jennyShell.tools.approve(id, options || {}), denyOne: (id) => window.jennyShell.tools.deny(id),
        setRowBusy: setApprovalBlockBusy,
        onError: (action, callId, error) => {
          const deny = action === 'deny-all';
          appendClientLog('ERROR', deny ? 'tool.deny_failed' : 'tool.approve_failed', { callId, batch_action: action, message: error?.message || String(error) });
          showComposerActionError(error, deny ? jt('app.controller.denyFailedTitle', 'Deny Failed') : jt('app.controller.approvalFailedTitle', 'Approval Failed'));
        },
      },
    });
    let disposed = false;

    // Focus hand-off when a resolved approval row leaves the DOM (renderer-approval-focus-restore.js).
    const { resolveApprovalFocusFallback, watchApprovalRowRemoval, dispose: disposeApprovalFocusRestore } =
      approvalFocusRestoreModule.createApprovalFocusRestore?.({ chatTimeline, doc })
      || { resolveApprovalFocusFallback: () => null, watchApprovalRowRemoval() {}, dispose() {} };

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
      // A4: nothing waits on this card any more; fold it to its receipt.
      if (!(state.inactiveApprovalCallIds instanceof Set)) state.inactiveApprovalCallIds = new Set();
      state.inactiveApprovalCallIds.add(String(callId || ''));
      renderAll();
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
      if (pending?.timerId && clearT) {
        clearT(pending.timerId);
      }
      const intent = { expanded, timerId: 0 };
      revealTimers.set(el, intent);
      const transitionMs = typeof getToolDetailsTransitionMs === 'function'
        ? (Number(getToolDetailsTransitionMs()) || 0)
        : 0;
      const settle = () => {
        if (revealTimers.get(el) !== intent) return;
        el.style.maxHeight = expanded ? 'none' : ''; intent.timerId = 0;
      };
      if (transitionMs === 0 || !raf || !setT) {
        settle();
        return;
      }
      if (expanded) {
        motionHeightUtils.pinHeightForTransition(el, pending?.timerId && !pending.expanded
          ? motionHeightUtils.readCurrentMaxHeightPx(el, win) : 0);
        raf(() => { if (revealTimers.get(el) === intent) el.style.maxHeight = `${Math.max(el.scrollHeight || 0, 0)}px`; });
      } else {
        motionHeightUtils.pinHeightForTransition(el, pending?.timerId
          ? motionHeightUtils.readCurrentMaxHeightPx(el, win) : motionHeightUtils.resolveCollapseStartPx(el));
        raf(() => { if (revealTimers.get(el) === intent) el.style.maxHeight = '0px'; });
      }
      intent.timerId = setT(settle, transitionMs);
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
      notifyToolRowExpansion(rowKey, nextExpanded);
      if (nextExpanded && rowNode.dataset?.toolDetailsMaterialized === 'false') {
        const bodyNode = rowNode.querySelector('.tool-call-row-body');
        const materialized = !bodyNode
          ? { ok: false, reason: 'missing_body', markup: '' }
          : (toolRowUtils && typeof toolRowUtils.materializeToolRowDetails === 'function'
            ? toolRowUtils.materializeToolRowDetails(rowKey)
            : { ok: false, reason: 'materializer_unavailable', markup: '' });
        if (materialized.ok && bodyNode) {
          bodyNode.innerHTML = materialized.markup;
          globalThis.rendererCodeHighlight?.decorateCodeBlocks?.(bodyNode);
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

    // Answers tool run (renderer-turn-row-list-utils): the summary row and its
    // flat member rows share data-run-id; the override is keyed like a tool row
    // so a view switch resets it with the session's other tool overrides.
    function toggleToolRun(toggleNode, forceExpanded) {
      const summaryRow = toggleNode?.closest?.('.chat-row[data-row-kind="tool_run"]');
      const list = summaryRow?.closest?.('.turn-row-list');
      if (!summaryRow || !list) return;
      const next = typeof forceExpanded === 'boolean' ? forceExpanded : summaryRow.getAttribute('data-run-expanded') !== 'true';
      globalThis.toolCallUtils?.getToolRunRows?.(list, summaryRow.getAttribute('data-run-id'))
        ?.forEach((node) => node.setAttribute('data-run-expanded', next ? 'true' : 'false'));
      toggleNode.setAttribute('aria-expanded', next ? 'true' : 'false');
      const runKey = toggleNode.getAttribute('data-tool-run-key') || '';
      globalThis.rendererTurnRowToolRenderUtils?.setToolRowExpansion?.(runKey, next);
      notifyToolRowExpansion(runKey, next);
    }

    // A user toggle tells the search overlay to drop its transient record.
    function notifyToolRowExpansion(rowKey, expanded) {
      const CustomEventCtor = doc?.defaultView?.CustomEvent || globalThis.CustomEvent;
      if (rowKey && typeof CustomEventCtor === 'function') {
        chatTimeline?.dispatchEvent?.(new CustomEventCtor('tool-row-user-expansion', { detail: { rowKey, expanded } }));
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

        // A4: a paused reply's card resumes that reply, like the queue strip.
        const resumeApproval = event.target.closest('[data-action="resume-paused-approval"]');
        if (resumeApproval) {
          event.preventDefault();
          if (!resumeApproval.disabled) {
            resumeApproval.disabled = true;
            Promise.resolve(state.runtimeSendController?.resume?.(resumeApproval.dataset.resumeKey))
              .catch(() => false).then(() => { resumeApproval.disabled = false; });
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
          if (callId && approvalClaims.claim(callId)) {
            const block = resolveApprovalBlockContainer(toolApproveBtn);
            // The scope is the button that was pressed ("Allow once" vs
            // "Always allow"), never a modifier read from elsewhere in the block.
            const alwaysAllow = toolApproveBtn.getAttribute('data-approval-scope') === 'always';
            const originSessionId = String(getSessionId() || '').trim();
            const approvalRow = toolApproveBtn.closest('.approval-gap-row') || block;
            const fallbackTarget = approvalRow ? resolveApprovalFocusFallback(approvalRow) : null;
            // Snapshot BEFORE setApprovalBlockBusy/disabling the button — disabling
            // can itself blur it, so this must reflect focus at click time.
            const heldFocus = !!(approvalRow && doc && approvalRow.contains(doc.activeElement));
            setApprovalBlockBusy(block, true);
            answerLiveApproval(toolApproveBtn, callId, originSessionId, (liveId) => window.jennyShell.tools.approve(liveId, { alwaysAllow })).then((result) => {
              // CTL-009 refusal handling — see handleApprovalOutcomeRefused.
              if (handleApprovalOutcomeRefused(result, {
                block, callId, logEvent: 'tool.approve_refused', title: jt('chat.transcript.approvalFailedTitle', 'Approval Failed'),
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
                const originStillCurrent = originSessionId === String(getSessionId() || '').trim();
                approvalReconciliation.start({ sessionId: originSessionId, reference: callId, row: approvalRow, block });
                if (originStillCurrent && approvalRow.isConnected) watchApprovalRowRemoval(approvalRow, fallbackTarget, heldFocus);
              }
            }).catch((error) => {
              setApprovalBlockBusy(block, false);
              appendClientLog('ERROR', 'tool.approve_failed', { callId, message: error.message || String(error) });
              showComposerActionError(error, jt('chat.transcript.approvalFailedTitle', 'Approval Failed'));
            }).finally(() => approvalClaims.release(callId));
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
          if (callId && approvalClaims.claim(callId)) {
            const block = resolveApprovalBlockContainer(toolDenyBtn);
            const originSessionId = String(getSessionId() || '').trim();
            const approvalRow = toolDenyBtn.closest('.approval-gap-row') || block;
            const fallbackTarget = approvalRow ? resolveApprovalFocusFallback(approvalRow) : null;
            // Snapshot BEFORE setApprovalBlockBusy/disabling the button — see
            // the matching comment in the Allow branch above.
            const heldFocus = !!(approvalRow && doc && approvalRow.contains(doc.activeElement));
            setApprovalBlockBusy(block, true);
            answerLiveApproval(toolDenyBtn, callId, originSessionId, (liveId) => window.jennyShell.tools.deny(liveId)).then((result) => {
              // CTL-009 refusal handling — see handleApprovalOutcomeRefused.
              if (handleApprovalOutcomeRefused(result, {
                block, callId, logEvent: 'tool.deny_refused', title: jt('chat.transcript.denyFailedTitle', 'Deny Failed'),
              })) {
                return;
              }
              if (approvalRow) {
                const originStillCurrent = originSessionId === String(getSessionId() || '').trim();
                approvalReconciliation.start({ sessionId: originSessionId, reference: callId, row: approvalRow, block });
                if (originStillCurrent && approvalRow.isConnected) watchApprovalRowRemoval(approvalRow, fallbackTarget, heldFocus);
              }
            }).catch((error) => {
              setApprovalBlockBusy(block, false);
              appendClientLog('ERROR', 'tool.deny_failed', { callId, message: error.message || String(error) });
              showComposerActionError(error, jt('chat.transcript.denyFailedTitle', 'Deny Failed'));
            }).finally(() => approvalClaims.release(callId));
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
            showComposerActionError(error, jt('chat.transcript.errorActionFailedTitle', 'Error Action Failed'));
          }).finally(() => {
            errorActionButton.removeAttribute('aria-busy');
            errorActionButton.disabled = false;
          });
          return;
        }

        if (event.target.closest('[data-inv-image-cancel]')) {
          event.preventDefault();
          Promise.resolve().then(() => handleStopActiveStream()).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.stopFailedTitle', 'Stop Failed'));
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
            showComposerActionError(error, jt('chat.transcript.artifactActionFailedTitle', 'Artifact Action Failed'));
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
            toolCallId: codeReviewButton.dataset.toolCallId,
            contextNode: codeReviewButton,
          })).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.codeReviewFailedTitle', 'Code Review Failed'));
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
            showComposerActionError(error, jt('chat.transcript.openDiffFailedTitle', 'Open Diff Failed'));
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
              action === 'discard' ? jt('chat.transcript.discardFailedTitle', 'Discard Failed') : jt('chat.transcript.saveRetryFailedTitle', 'Save Retry Failed')
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
                maybePromise.catch((error) => showComposerActionError(error, jt('chat.transcript.editFailedTitle', 'Edit Failed')));
              }
            } catch (error) {
              showComposerActionError(error, jt('chat.transcript.editFailedTitle', 'Edit Failed'));
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
              showComposerActionError(error, jt('chat.transcript.editFailedTitle', 'Edit Failed'));
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
              showComposerActionError(error, jt('chat.transcript.regenerateFailedTitle', 'Regenerate Failed'));
            });
            return;
          }
          if (messageAction === 'branch') {
            handleBranchMessage(messageId).catch((error) => {
              showComposerActionError(error, jt('chat.transcript.branchFailedTitle', 'Branch Failed'));
            });
            return;
          }
          if (messageAction === 'elaborate') {
            handleElaborateMessage(messageId).catch((error) => {
              showComposerActionError(error, jt('chat.transcript.elaborateFailedTitle', 'Elaborate Failed'));
            });
            return;
          }
          if (messageAction === 'follow-up') {
            handleFollowUpMessage(messageId).catch((error) => {
              showComposerActionError(error, jt('chat.transcript.followUpFailedTitle', 'Follow-up Failed'));
            });
            return;
          }
          if (messageAction === 'use-suggestion') {
            handleUseProactiveSuggestionMessage(messageId).catch((error) => {
              showComposerActionError(error, jt('chat.transcript.suggestionFailedTitle', 'Suggestion Failed'));
            });
            return;
          }
          if (messageAction === 'save-suggestion') {
            handleSaveProactiveSuggestionMessage(messageId).catch((error) => {
              showComposerActionError(error, jt('chat.transcript.saveFailedTitle', 'Save Failed'));
            });
            return;
          }
          if (messageAction === 'later-suggestion') {
            handleLaterProactiveSuggestionMessage(messageId).catch((error) => {
              showComposerActionError(error, jt('chat.transcript.laterFailedTitle', 'Later Failed'));
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

        const toolRunToggle = event.target.closest('[data-tool-run-toggle]');
        if (toolRunToggle) {
          event.preventDefault();
          toggleToolRun(toolRunToggle);
          return;
        }

        const compactionToggle = event.target.closest('[data-action="context-compaction-details"]');
        if (compactionToggle) {
          event.preventDefault();
          toggleContextCompactionDetails(compactionToggle.dataset.messageId);
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
            getSessionId(),
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
        const toolRunToggle = event.target.closest('[data-tool-run-toggle]');
        if (toolRunToggle) {
          event.preventDefault();
          toggleToolRun(toolRunToggle);
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
      // Chat search (CTR-5) opens a collapsed row around a match through the
      // reader's own toggle path: a full render alone would be undone by the
      // preservation registry restoring the row's collapsed DOM state.
      registerListener(chatTimeline, 'tool-row-expand-request', (event) => {
        const toggle = event.target?.closest?.('[data-tool-row-toggle]');
        if (toggle && typeof event.detail?.expanded === 'boolean') toggleMinimalToolRow(toggle, event.detail.expanded);
      }, listenerOptions);
      registerListener(chatTimeline, 'pointerover', checkQuestionsFromEvent, listenerOptions);
      registerListener(chatTimeline, 'focusin', checkQuestionsFromEvent, listenerOptions);
      chatTimeline.querySelectorAll('.user-questions-block[data-question-ref]').forEach(
        userQuestionsActions.checkUserQuestionsLiveness
      );

      // Transcript views: this pane's utility
      // cluster carries the view control; the bulk collapse/expand toggle it
      // replaces retired with the views (its per-row batch writes are gone).
      const utilityCluster = chatTimeline?.closest?.('.chat-pane')?.querySelector?.('[data-chat-node="chatTimelineUtilityCluster"]') || null;
      if (utilityCluster) {
        globalThis.rendererTranscriptViewUtils?.mountTranscriptViewControl?.({
          cluster: utilityCluster, chatTimeline, getSessionId, registerListener, listenerOptions,
        });
      }
    }

    return { bindTranscriptEvents, dispose: () => {
      disposed = true;
      userQuestionsActions.dispose();
      disposeApprovalFocusRestore();
      approvalReconciliation.dispose(); approvalBatch?.dispose();
      if (ownsFileDiffRegistry) fileDiffBindings.disposeFileDiffBindings?.();
    } };
  }

  return { createTranscriptEventBindings };
});
