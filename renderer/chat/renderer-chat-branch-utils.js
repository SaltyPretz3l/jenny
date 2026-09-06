/* renderer/chat/renderer-chat-branch-utils.js
 *
 * Message branching controller for the renderer guard and activation path over the existing `sessions.forkSession` seam.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatBranchUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var navigationIntentUtils = (typeof globalThis !== 'undefined' && globalThis.rendererNavigationIntent)
    || (typeof require === 'function' ? require('./renderer-navigation-intent') : null);
  if (!navigationIntentUtils || typeof navigationIntentUtils.getOrCreateNavigationIntentOwner !== 'function') {
    throw new Error('renderer-chat-branch-utils requires renderer-navigation-intent.');
  }

  var BRANCH_BUSY_REASON = 'Wait for the current response to finish before branching.';
  var BRANCH_UNSUPPORTED_REASON = 'unsupported_message';

  function noopFn() { /* no-op */ }
  function noopAsync() { return Promise.resolve(null); }

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function isBranchableMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return false;
    }
    var role = normalizeId(message.role);
    var kind = normalizeId(message.kind);
    return (role === 'user' || role === 'assistant') && !kind;
  }

  function createMessageBranchController(deps) {
    var options = deps || {};
    if (!options.state || typeof options.state !== 'object') {
      throw new TypeError('createMessageBranchController requires `state`.');
    }
    var state = options.state;
    var navigationIntent = navigationIntentUtils.getOrCreateNavigationIntentOwner(state);
    var jennyShellSessions = options.jennyShellSessions || null;
    var getCurrentSessionId = typeof options.getCurrentSessionId === 'function'
      ? options.getCurrentSessionId
      : function () { return normalizeId(state.currentSessionId); };
    var getCurrentSessionMessages = typeof options.getCurrentSessionMessages === 'function'
      ? options.getCurrentSessionMessages
      : function () { return []; };
    var loadSessions = typeof options.loadSessions === 'function' ? options.loadSessions : noopAsync;
    var activateWorkspaceSession = typeof options.activateWorkspaceSession === 'function'
      ? options.activateWorkspaceSession
      : null;
    var upsertSessionSummary = typeof options.upsertSessionSummary === 'function'
      ? options.upsertSessionSummary
      : noopFn;
    var renderAll = typeof options.renderAll === 'function' ? options.renderAll : noopFn;
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : noopFn;
    var showComposerActionError = typeof options.showComposerActionError === 'function'
      ? options.showComposerActionError
      : noopFn;
    var showToastMessage = typeof options.showToastMessage === 'function'
      ? options.showToastMessage
      : noopFn;
    var isSessionStreaming = typeof options.isSessionStreaming === 'function'
      ? options.isSessionStreaming
      : function () { return false; };
    var hasPendingToolApprovalForSession = typeof options.hasPendingToolApprovalForSession === 'function'
      ? options.hasPendingToolApprovalForSession
      : function () { return false; };
    var pendingBranchOperation = null;
    var disposed = false;

    function findMessage(messageId) {
      var id = normalizeId(messageId);
      if (!id) return null;
      var messages = getCurrentSessionMessages() || [];
      for (var index = 0; index < messages.length; index += 1) {
        if (normalizeId(messages[index] && messages[index].id) === id) {
          return messages[index];
        }
      }
      return null;
    }

    function resolveBusyReason(sessionId) {
      if (!sessionId) {
        return 'Start a conversation before branching.';
      }
      if (isSessionStreaming(sessionId) || hasPendingToolApprovalForSession(sessionId)) {
        return BRANCH_BUSY_REASON;
      }
      return '';
    }

    function logBlocked(messageId, reason) {
      appendClientLog('INFO', 'chat.branch_blocked', {
        sessionId: normalizeId(getCurrentSessionId()),
        messageId: normalizeId(messageId),
        reason: normalizeId(reason),
      });
    }

    async function performBranch(sessionId, targetId) {
      var busyReason = resolveBusyReason(sessionId);
      if (busyReason) {
        logBlocked(targetId, 'busy');
        showComposerActionError(new Error(busyReason), 'Branch Unavailable');
        return null;
      }
      var targetMessage = findMessage(targetId);
      if (!targetMessage || !isBranchableMessage(targetMessage)) {
        logBlocked(targetId, BRANCH_UNSUPPORTED_REASON);
        return null;
      }
      if (!jennyShellSessions || typeof jennyShellSessions.forkSession !== 'function') {
        var missingError = new Error('Branching is not available in this runtime.');
        appendClientLog('WARN', 'chat.branch_unavailable', {
          sessionId: sessionId,
          messageId: targetId,
        });
        showComposerActionError(missingError, 'Branch Unavailable');
        return null;
      }

      try {
        var navigationToken = navigationIntent.beginOperation('chat.branch');
        var branch = await jennyShellSessions.forkSession(sessionId, targetId, {});
        if (!branch || !normalizeId(branch.id)) {
          throw new Error('Jenny could not create a branch from that message.');
        }
        if (disposed) return branch;
        upsertSessionSummary(branch);
        await loadSessions(branch.id, { skipOpenCurrent: true });
        if (disposed) return branch;
        var openBranch = async function (branchSessionId, navigationGuard) {
          if (activateWorkspaceSession) {
            await activateWorkspaceSession(branchSessionId, {
              silent: true,
              navigationGuard: navigationGuard,
            });
          } else {
            await loadSessions(branchSessionId);
          }
          if (navigationGuard && navigationGuard.isCurrent() !== true) {
            return;
          }
          state.currentSessionId = normalizeId(branchSessionId);
          renderAll();
        };
        var navigationResult = await navigationIntent.navigateOrNotify(navigationToken, branch.id, {
          navigate: openBranch,
          showToastMessage: showToastMessage,
          message: 'A branch was created while you were working in another chat.',
          title: 'Branch Created',
          dedupeKey: 'chat.branch.open:' + normalizeId(branch.id),
        });
        appendClientLog('INFO', 'chat.branch_created', {
          sessionId: sessionId,
          branchSessionId: branch.id,
          messageId: targetId,
        });
        if (navigationResult.navigated) {
          showToastMessage('Opened a new branch from this message.', {
            title: 'Branch Created',
            tone: 'success',
          });
        }
        return branch;
      } catch (error) {
        if (disposed) return null;
        appendClientLog('ERROR', 'chat.branch_failed', {
          sessionId: sessionId,
          messageId: targetId,
          message: error && error.message ? error.message : String(error),
        });
        showComposerActionError(error, 'Branch Failed');
        return null;
      }
    }

    function branchFromMessage(messageId) {
      if (disposed) return Promise.resolve(null);
      if (pendingBranchOperation) return pendingBranchOperation;
      var sessionId = normalizeId(getCurrentSessionId());
      var targetId = normalizeId(messageId);
      if (!state.ui || typeof state.ui !== 'object') state.ui = {};
      state.ui.branchCommitting = true;
      try { renderAll(); } catch (_error) { /* best-effort pending paint */ }
      var operation = performBranch(sessionId, targetId).finally(function () {
        if (pendingBranchOperation === operation) pendingBranchOperation = null;
        if (!disposed) {
          state.ui.branchCommitting = false;
          try { renderAll(); } catch (_error) { /* best-effort settlement paint */ }
        }
      });
      pendingBranchOperation = operation;
      return operation;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (state.ui && typeof state.ui === 'object') state.ui.branchCommitting = false;
    }

    return {
      branchFromMessage: branchFromMessage,
      dispose: dispose,
      isPending: function () { return Boolean(pendingBranchOperation); },
      isBranchableMessage: isBranchableMessage,
    };
  }

  return {
    createMessageBranchController: createMessageBranchController,
    isBranchableMessage: isBranchableMessage,
  };
});
