/* renderer/chat/renderer-chat-approval-card-bindings.js owns the inline
 * approval cards' click handling in one pane timeline: Resume on a paused
 * reply, Allow (once / always / for linked chats) and Deny, with the busy
 * pair, Resume's re-offered approval id, the refused-outcome fold, the
 * post-answer reconciliation, the batch Allow-all / Deny-all controller and
 * the focus hand-off when an answered row leaves. Loaded before
 * renderer-chat-event-transcript-bindings.js, which creates it per pane. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-approval-batch-utils'),
      require('./renderer-approval-focus-restore')
    );
    return;
  }
  root.rendererChatApprovalCardBindings = factory(
    root.rendererApprovalBatchUtils || {},
    root.rendererApprovalFocusRestore || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  approvalBatchUtils,
  approvalFocusRestoreModule
) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function createApprovalCardBindings(deps) {
    const {
      chatTimeline,
      doc,
      windowRef,
      state,
      getSessionId,
      appendClientLog,
      showComposerActionError,
      renderAll,
      refreshRecoveredSession,
      resolveToolCallId,
      approvalReconcileDelayMs,
      approvalReconcileSetTimeout,
      approvalReconcileClearTimeout,
    } = deps;

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

    // Focus hand-off when a resolved approval row leaves the DOM (renderer-approval-focus-restore.js).
    const { resolveApprovalFocusFallback, watchApprovalRowRemoval, dispose: disposeApprovalFocusRestore } =
      approvalFocusRestoreModule.createApprovalFocusRestore?.({ chatTimeline, doc })
      || { resolveApprovalFocusFallback: () => null, watchApprovalRowRemoval() {}, dispose() {} };

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

    // The transcript click delegate's approval branches, in its order; true
    // when the click belonged to an approval card.
    function handleApprovalClick(event) {
      // A4: a paused reply's card resumes that reply, like the queue strip.
      const resumeApproval = event.target.closest('[data-action="resume-paused-approval"]');
      if (resumeApproval) {
        event.preventDefault();
        if (!resumeApproval.disabled) {
          resumeApproval.disabled = true;
          Promise.resolve(state.runtimeSendController?.resume?.(resumeApproval.dataset.resumeKey))
            .catch(() => false).then(() => { resumeApproval.disabled = false; });
        }
        return true;
      }

      const toolApproveBtn = event.target.closest('.tool-approve-btn');
      if (toolApproveBtn) {
        event.preventDefault();
        // A2 double-click guard: the block is already busy (either button
        // mid-request) — ignore the re-click rather than firing a second
        // tools.approve for the same call.
        if (toolApproveBtn.disabled || toolApproveBtn.getAttribute('aria-busy') === 'true') {
          return true;
        }
        const callId = resolveToolCallId(toolApproveBtn);
        if (callId && approvalClaims.claim(callId)) {
          const block = resolveApprovalBlockContainer(toolApproveBtn);
          // The scope is the button that was pressed ("Allow once" vs
          // "Always allow"), never a modifier read from elsewhere in the block.
          const alwaysAllow = toolApproveBtn.getAttribute('data-approval-scope') === 'always';
          // Row 87 C1: "Always allow for chats Jenny started" also asks the backend to save its offered rule.
          const remember = toolApproveBtn.getAttribute('data-approval-remember') === 'linked_children' ? 'linked_children' : undefined;
          const originSessionId = String(getSessionId() || '').trim();
          const approvalRow = toolApproveBtn.closest('.approval-gap-row') || block;
          const fallbackTarget = approvalRow ? resolveApprovalFocusFallback(approvalRow) : null;
          // Snapshot BEFORE setApprovalBlockBusy/disabling the button — disabling
          // can itself blur it, so this must reflect focus at click time.
          const heldFocus = !!(approvalRow && doc && approvalRow.contains(doc.activeElement));
          setApprovalBlockBusy(block, true);
          answerLiveApproval(toolApproveBtn, callId, originSessionId, (liveId) => window.jennyShell.tools.approve(liveId, remember ? { alwaysAllow, remember } : { alwaysAllow })).then((result) => {
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
        return true;
      }

      const toolDenyBtn = event.target.closest('.tool-deny-btn');
      if (toolDenyBtn) {
        event.preventDefault();
        if (toolDenyBtn.disabled || toolDenyBtn.getAttribute('aria-busy') === 'true') {
          return true;
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
        return true;
      }
      return false;
    }

    return {
      handleApprovalClick,
      resolveApprovalFocusFallback,
      watchApprovalRowRemoval,
      dispose() {
        disposeApprovalFocusRestore();
        approvalReconciliation.dispose(); approvalBatch?.dispose();
      },
    };
  }

  return { createApprovalCardBindings };
});
