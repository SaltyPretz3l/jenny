(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-file-diff-bindings'),
      require('./renderer-tool-detail-body'),
      require('./renderer-user-questions-actions'),
      require('./renderer-chat-tool-row-toggles'),
      require('./renderer-chat-approval-card-bindings'),
      require('./renderer-chat-message-action-bindings')
    );
    return;
  }
  root.rendererChatEventTranscriptBindings = factory(
    root.rendererFileDiffBindings || {},
    root.rendererToolDetailBody || {},
    root.rendererUserQuestionsActions || {},
    root.rendererChatToolRowToggles || {},
    root.rendererChatApprovalCardBindings || {},
    root.rendererChatMessageActionBindings || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  fileDiffBindings,
  toolDetailBody,
  userQuestionsActionsModule,
  toolRowToggles,
  approvalCardBindings,
  messageActionBindings
) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
      promptJump = null,
    } = deps || {};
    const doc = chatTimeline?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    // Selection handle, unsaved reply, inline edit and hover actions: renderer-chat-message-action-bindings.js.
    const messageActions = messageActionBindings.createMessageActionBindings({
      state,
      doc,
      selectionController,
      handleSelectClickInput,
      handleCopyMessage,
      handleRegenerateMessage,
      handleElaborateMessage,
      handleBranchMessage,
      handleEditMessage,
      handleEditCommit,
      handleEditCancel,
      handleFollowUpMessage,
      handleUseProactiveSuggestionMessage,
      handleSaveProactiveSuggestionMessage,
      handleLaterProactiveSuggestionMessage,
      appendClientLog,
      showComposerActionError,
      refreshRecoveredSession,
    });

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

    const windowRef = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
    // Resume / Allow / Deny, reconciliation, batch UX and focus hand-off:
    // renderer-chat-approval-card-bindings.js.
    const approvalCards = approvalCardBindings.createApprovalCardBindings({
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
    });
    let disposed = false;
    const { resolveApprovalFocusFallback, watchApprovalRowRemoval } = approvalCards;

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

    // Minimal tool rows and Answers tool runs: renderer-chat-tool-row-toggles.js.
    const { toggleMinimalToolRow, toggleToolRun } = toolRowToggles.createMinimalToolRowToggles({
      chatTimeline, doc, appendClientLog, renderAll, getToolDetailsTransitionMs,
    });

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

        if (approvalCards.handleApprovalClick(event)) return;

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

        const imageCancelButton = event.target.closest('[data-inv-image-cancel]');
        if (imageCancelButton) {
          event.preventDefault();
          // Disabled while stopping: a double click must not fire repeated stops.
          imageCancelButton.setAttribute('aria-busy', 'true');
          imageCancelButton.disabled = true;
          Promise.resolve().then(() => handleStopActiveStream()).catch((error) => {
            imageCancelButton.removeAttribute('aria-busy');
            imageCancelButton.disabled = false;
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
        const editPromptButton = event.target.closest('[data-image-edit-prompt]');
        if (editPromptButton) {
          event.preventDefault();
          // Row 91: the image's prompt, size and seed back in its chat's composer.
          const { imagePrompt: prompt, imageSeed, imageWidth, imageHeight } = editPromptButton.dataset;
          const armed = state?.imagePromptController?.editPrompt?.({
            sessionId: editPromptButton.dataset.sessionId || getSessionId(), prompt,
            seed: imageSeed === undefined ? undefined : Number(imageSeed),
            width: Number(imageWidth), height: Number(imageHeight),
          }) === true;
          if (!armed) showComposerActionError(new Error(jt('chat.artifactFigure.editPromptUnavailable', 'The prompt could not be put back in the composer.')),
            jt('chat.transcript.artifactActionFailedTitle', 'Artifact Action Failed'));
          return;
        }
        const imageActionButton = event.target.closest('[data-image-action]');
        if (imageActionButton) {
          event.preventDefault();
          const { imageAction: action, imageKind: kind, imageId: id } = imageActionButton.dataset;
          const sessionId = imageActionButton.dataset.sessionId || getSessionId();
          const controller = doc?.defaultView?.rendererImageViewerController;
          Promise.resolve().then(() => {
            if (action === 'panel') return handleArtifactAction({ action, artifactId: id, sessionId, contextNode: imageActionButton });
            if (!controller?.run) throw new Error(jt('chat.artifactFigure.unavailable', 'Image unavailable'));
            return controller.run(action, { kind, id, sessionId });
          }).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.artifactActionFailedTitle', 'Artifact Action Failed'));
          });
          return;
        }
        const imageOpenButton = event.target.closest('[data-image-viewer-open]');
        if (imageOpenButton) {
          event.preventDefault();
          if (imageOpenButton.getAttribute('aria-disabled') === 'true') return;
          const controller = doc?.defaultView?.rendererImageViewerController;
          Promise.resolve(controller?.open?.({
            sessionId: imageOpenButton.dataset.sessionId || getSessionId(),
            select: { kind: imageOpenButton.dataset.imageViewerOpen, id: imageOpenButton.dataset.imageId },
            contextNode: imageOpenButton,
          }) ?? false).then((opened) => {
            if (opened === false) throw new Error(jt('chat.artifactFigure.unavailable', 'Image unavailable'));
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

        if (messageActions.handleMessageActionClick(event)) return;

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
      // An attached or tool-output image whose file is gone: show the frame's unavailable state.
      // Generated images (data-inv-artifact-image-key) are handled by the artifact card loader.
      registerListener(chatTimeline, 'error', (event) => {
        const img = event.target;
        if (!img?.matches?.('img.inv-artifact-figure-image:not([data-inv-artifact-image-key])')) return;
        img.closest('.inv-artifact-figure')?.setAttribute('data-inv-artifact-image-state', 'unavailable');
        img.closest('.inv-artifact-figure-frame')?.setAttribute('aria-disabled', 'true');
      }, { ...listenerOptions, capture: true });
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
        // Row 115: the More button (Back to prompt, views, Wide transcript, Activity, Tasks and Notes when short of room); its width observer ends with the bind.
        globalThis.rendererTranscriptViewUtils?.mountTranscriptViewControl?.({
          cluster: utilityCluster, getSessionId, registerListener, listenerOptions, signal: bindAbortController?.signal, promptJump,
        });
        // Row 115: the session bar's title, in the same cluster; not mounted for a pane hosted in the IDE dock.
        globalThis.rendererSessionBar?.mountSessionBar?.({ pane: utilityCluster.parentElement, cluster: utilityCluster, chatTimeline, getSessionId, windowRef, jt,
          getTitle: (id) => state.sessions?.find?.((entry) => entry.id === id)?.title, signal: bindAbortController?.signal });
        // Row 59 checkpoint 2: this pane's session rail (its own session's facts); it disposes with the bind.
        globalThis.rendererSessionRail?.mountSessionRail?.({ pane: utilityCluster.parentElement, cluster: utilityCluster, chatTimeline, getSessionId,
          refreshIntervalMs: 15000, // a safety net only: file, git and turn events refetch through onChanged
          // Row 100 P2: the titles of chats waiting on a background job ('' if untitled).
          getJobWaiters: (jobId) => (state.streamWaits?.waitersForJob?.(jobId) || []).map((id) => String(state.sessions?.find?.((entry) => entry.id === id)?.title || '').trim()),
          // This pane's own queue: split view keeps attachments per session.
          getAttachments: () => globalThis.rendererComposerSessionState?.getQueuedAttachments?.(state, getSessionId())
            ?? state.attachments?.queued ?? [],
          getSummaryKey: () => {
            const session = state.sessions?.find?.((entry) => entry.id === getSessionId()) || {};
            return JSON.stringify([session.project_id, session.run_mode, session.plan_mode,
              session.context_preferences, session.preferred_model, state.settings, state.model]);
          }, signal: bindAbortController?.signal });
        // Row 59 checkpoint 4: the pane's addressed-message strip above its composer (backlog line, sender receipts).
        globalThis.rendererComposerMessageStrip?.mountComposerMessageStrip?.({ host: utilityCluster.parentElement.querySelector('#composerMessageStrip, [data-chat-node="composerMessageStrip"]'), pane: utilityCluster.parentElement, chatTimeline, getSessionId, signal: bindAbortController?.signal, appendClientLog });
        // Row 76: the primary chat's paused notice, a sibling before the strip.
        globalThis.rendererPrimaryPausedNotice?.mountPrimaryPausedNotice?.({ host: utilityCluster.parentElement.querySelector('#composerMessageStrip, [data-chat-node="composerMessageStrip"]'), pane: utilityCluster.parentElement, chatTimeline, getSessionId, state, signal: bindAbortController?.signal, appendLog: appendClientLog });
      }
    }

    return { bindTranscriptEvents, dispose: () => {
      disposed = true;
      userQuestionsActions.dispose();
      approvalCards.dispose();
      if (ownsFileDiffRegistry) fileDiffBindings.disposeFileDiffBindings?.();
    } };
  }

  return { createTranscriptEventBindings };
});
