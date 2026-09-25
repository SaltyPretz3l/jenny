(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-enter-keydown-utils'));
    return;
  }
  root.rendererResumeTurnInteraction = factory(root.rendererEnterKeydownUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (enterKeydownUtils) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createNoopController() {
    return { dispose: function dispose() {} };
  }

  function createResumeTurnInteraction(deps) {
    deps = deps && typeof deps === 'object' ? deps : {};
    var scopeRoot = deps.scopeRoot;
    var chatInput = deps.chatInput;
    var startPromptSend = deps.startPromptSend;
    var getCurrentSessionId = deps.getCurrentSessionId;
    var isSessionSendBusy = deps.isSessionSendBusy;
    var shouldSendOnEnterKeydown = enterKeydownUtils?.shouldSendOnEnterKeydown;
    if (typeof scopeRoot?.addEventListener !== 'function'
      || typeof scopeRoot?.removeEventListener !== 'function'
      || typeof scopeRoot?.querySelectorAll !== 'function'
      || typeof chatInput?.addEventListener !== 'function'
      || typeof chatInput?.removeEventListener !== 'function'
      || typeof startPromptSend !== 'function'
      || typeof getCurrentSessionId !== 'function'
      || typeof isSessionSendBusy !== 'function'
      || typeof shouldSendOnEnterKeydown !== 'function') {
      return createNoopController();
    }

    var appendClientLog = typeof deps.appendClientLog === 'function'
      ? deps.appendClientLog
      : null;
    var showComposerActionError = typeof deps.showComposerActionError === 'function'
      ? deps.showComposerActionError
      : null;
    // Empty text is not an empty draft: the composer treats a queued attachment as
    // sendable on its own, so Enter there belongs to the user's own send.
    var hasComposerDraftAttachments = typeof deps.hasComposerDraftAttachments === 'function'
      ? deps.hasComposerDraftAttachments
      : function noComposerDraftAttachments() { return false; };
    var claimedMessageIds = new Set();
    var disposed = false;
    var enterListenerOptions = { capture: true };

    function restoreButton(button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }

    function releaseClaim(messageId, button) {
      claimedMessageIds.delete(messageId);
      restoreButton(button);
    }

    async function activate(button) {
      var messageId = String(button?.dataset?.resumeMessageId || '').trim();
      var sessionId = String(button?.dataset?.resumeSessionId || '').trim();
      if (claimedMessageIds.has(messageId)) return;
      claimedMessageIds.add(messageId);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');

      var currentSessionId = String(getCurrentSessionId() || '').trim();
      if (!messageId
        || !sessionId
        || sessionId !== currentSessionId
        || isSessionSendBusy(sessionId) === true) {
        releaseClaim(messageId, button);
        return;
      }

      try {
        // sessionIdOverride: startPromptSend otherwise re-reads the current session
        // AFTER its own await, so a switch inside that window would land `resume` in
        // the wrong conversation.
        var outcome = await startPromptSend('resume', { sessionIdOverride: sessionId });
        // startPromptSend RESOLVES without sending on several gates (empty prompt,
        // backend not ready, not authenticated, vision gate, compacting session).
        // Holding the claim there would leave the message id claimed for the rest of
        // the session, so a later re-rendered, enabled button would be dead. Match
        // only the two shapes those gates return -- a completed send resolves with a
        // receipt object whose truthiness is not ours to assume.
        if (outcome === null || (outcome && outcome.rejected === true)) {
          releaseClaim(messageId, button);
        }
      } catch (error) {
        releaseClaim(messageId, button);
        showComposerActionError?.(error, jt('chat.resumeTurn.failedTitle', 'Resume Failed'));
        appendClientLog?.('ERROR', 'chat.resume_failed', { messageId: messageId });
      }
    }

    function isAvailableButton(button) {
      return button.disabled !== true && button.getAttribute('aria-busy') !== 'true';
    }

    // Mirror the backend flip into the renderer's own transcript so a re-render
    // during the build turn cannot resurrect the accepted receipt.
    function markPlanApprovedInState(sessionId, planId) {
      var session = deps.sessionCallbacks;
      if (typeof session?.getSessionMessages !== 'function'
        || typeof session?.setSessionMessages !== 'function') return;
      var current = session.getSessionMessages(sessionId);
      if (!Array.isArray(current)) return;
      var changed = false;
      var next = current.map(function (message) {
        if (message?.kind !== 'plan_document' || String(message?.plan_document?.plan_id || '') !== planId) return message;
        changed = true;
        return Object.assign({}, message, { plan_document: Object.assign({}, message.plan_document, { state: 'approved' }) });
      });
      if (changed) session.setSessionMessages(sessionId, next, 'session_' + sessionId);
    }

    // "Build it" on an accepted-not-built plan receipt: flip the plan to approved
    // (the backend refuses unless latest, accepted, and idle), leave Plan mode
    // through the composer's own run-mode control, then send.
    async function activateBuildAccepted(button) {
      var planId = String(button?.dataset?.planId || '').trim();
      var sessionId = String(getCurrentSessionId() || '').trim();
      if (!planId || !sessionId || claimedMessageIds.has(planId)
        || isSessionSendBusy(sessionId) === true) return;
      claimedMessageIds.add(planId);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      try {
        var built = await globalThis.jennyShell?.tools?.buildAcceptedPlan?.(sessionId, planId);
        if (!built || built.ok !== true) {
          throw new Error(jt('chat.planDocument.buildAcceptedFailed', 'This plan can no longer be built from here.'));
        }
        markPlanApprovedInState(sessionId, planId);
        var host = button.closest('[data-plan-document]');
        if (host) {
          host.dataset.planState = 'approved';
          var label = host.querySelector('.plan-document-receipt__state');
          if (label) label.textContent = jt('artifacts.plan.state.approved', 'Approved');
        }
        button.remove();
        var runMode = globalThis.rendererRunModeControl;
        if (runMode?.currentRunMode?.() === 'plan') {
          await runMode.togglePlanMode();
          if (runMode.currentRunMode() === 'plan') {
            // The plan is approved; it carries into the next send outside Plan mode.
            throw new Error(jt('chat.planDocument.leavePlanFailed', 'Could not leave Plan mode.'));
          }
        }
        var outcome = await startPromptSend(
          jt('chat.planDocument.buildAcceptedMessage', 'Build the accepted plan.'),
          { sessionIdOverride: sessionId }
        );
        if (outcome === null || (outcome && outcome.rejected === true)) claimedMessageIds.delete(planId);
      } catch (error) {
        releaseClaim(planId, button);
        showComposerActionError?.(error, jt('chat.planDocument.buildAcceptedFailedTitle', 'Build Failed'));
        appendClientLog?.('ERROR', 'chat.plan_build_accepted_failed', { planId: planId });
      }
    }

    function handleClick(event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      var buildButton = target.closest('[data-action="plan-build-accepted"]');
      if (buildButton && scopeRoot.contains(buildButton)) {
        // The button sits inside the receipt's <summary>; keep the details closed.
        event.preventDefault();
        if (isAvailableButton(buildButton)) void activateBuildAccepted(buildButton);
        return;
      }
      var button = target.closest('[data-action="resume-turn"]');
      if (!button || !scopeRoot.contains(button) || !isAvailableButton(button)) return;
      void activate(button);
    }

    function handleKeydown(event) {
      if (event.target !== chatInput
        || !shouldSendOnEnterKeydown(event)
        || event.ctrlKey || event.altKey || event.metaKey
        || event.repeat === true
        || event.defaultPrevented === true
        || String(chatInput.value || '').trim() !== ''
        || hasComposerDraftAttachments() === true) return;
      var buttons = Array.from(scopeRoot.querySelectorAll('[data-action="resume-turn"]'))
        .filter(isAvailableButton);
      if (buttons.length !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      void activate(buttons[0]);
    }

    scopeRoot.addEventListener('click', handleClick);
    chatInput.addEventListener('keydown', handleKeydown, enterListenerOptions);

    return {
      dispose: function dispose() {
        if (disposed) return;
        disposed = true;
        scopeRoot.removeEventListener('click', handleClick);
        chatInput.removeEventListener('keydown', handleKeydown, enterListenerOptions);
      },
    };
  }

  return { createResumeTurnInteraction: createResumeTurnInteraction };
});
