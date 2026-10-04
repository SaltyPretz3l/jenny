/* renderer/shell/renderer-session-autotitle.js
 *
 * Client-side session auto-titles (nav overhaul W9) — no model inference.
 * deriveTitleFromFirstMessage is the shared rule in
 * renderer/shared/string-utils.js (slash-commands and a leading greeting
 * dropped, ~48 chars at a word boundary), the same rule the backend send
 * preflight applies. One controller
 * serves both entry points: the send pipeline calls maybeAutoTitleSession
 * with the outgoing prompt the moment a first message leaves the composer,
 * and openSession calls it without text so legacy untitled sessions
 * backfill from their freshly loaded history.
 *
 * Titles persist through sessions.setMeta (bumpUpdatedAt:false) so a
 * backfill never re-sorts the recents list. setMeta is managed-mode only:
 * a null result means the backend has no meta surface and the session
 * keeps its default title (the backend's own completion-time exchange
 * title still covers the live send there).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererSessionAutotitleUtils = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  var AUTOTITLE_MAX_LENGTH = stringUtils.SESSION_TITLE_MAX_LENGTH;
  var deriveTitleFromFirstMessage = stringUtils.deriveSessionTitleFromMessage;

  function isDefaultSessionTitle(value) {
    var title = String(value || '').trim();
    return !title || title === 'New Chat';
  }

  function createSessionAutotitleController(deps) {
    const { state, windowRef } = deps;
    const patchSessionSummary = deps.callbacks?.patchSessionSummary || (() => {});
    const renderSessions = deps.callbacks?.renderSessions || (() => {});
    const appendClientLog = deps.callbacks?.appendClientLog || (() => {});
    const inFlightSessionIds = new Set();

    function getSummary(sessionId) {
      return (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => session?.id === sessionId) || null;
    }

    function getFirstUserMessageText(sessionId) {
      const messages = state.messagesBySession instanceof Map
        ? state.messagesBySession.get(sessionId) || []
        : [];
      const firstUserMessage = messages.find((message) =>
        String(message?.role || '') === 'user' && String(message?.content || '').trim());
      return String(firstUserMessage?.content || '');
    }

    async function maybeAutoTitleSession(sessionId, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId || inFlightSessionIds.has(normalizedSessionId)) {
        return false;
      }
      const summary = getSummary(normalizedSessionId);
      if (!summary || !isDefaultSessionTitle(summary.title)) {
        return false;
      }
      // Optimistic sessions have no persisted row to retitle yet; the
      // backend stamps their title at create time from the same prompt.
      if (summary.optimistic_local === true || summary.local_draft === true) {
        return false;
      }
      const pendingDeletes = Array.isArray(state.ui?.pendingSessionDeletes)
        ? state.ui.pendingSessionDeletes
        : [];
      if (pendingDeletes.includes(normalizedSessionId)) {
        return false;
      }
      const sourceText = typeof options.messageText === 'string' && options.messageText.trim()
        ? options.messageText
        : getFirstUserMessageText(normalizedSessionId);
      const title = deriveTitleFromFirstMessage(sourceText);
      if (!title || title === 'New Chat') {
        return false;
      }
      inFlightSessionIds.add(normalizedSessionId);
      let updated;
      try {
        updated = await windowRef.jennyShell?.sessions?.setMeta?.(normalizedSessionId, { title });
      } catch (error) {
        appendClientLog('WARN', 'sessions.autotitle_failed', {
          sessionId: normalizedSessionId,
          message: String(error?.message || error),
        });
        return false;
      } finally {
        inFlightSessionIds.delete(normalizedSessionId);
      }
      if (!updated || typeof updated !== 'object' || !updated.id) {
        return false;
      }
      patchSessionSummary(normalizedSessionId, { title: String(updated.title || title) });
      renderSessions();
      appendClientLog('INFO', 'sessions.autotitled', {
        sessionId: normalizedSessionId,
        source: options.messageText ? 'send' : 'open',
      });
      return true;
    }

    return {
      maybeAutoTitleSession,
    };
  }

  return {
    AUTOTITLE_MAX_LENGTH,
    deriveTitleFromFirstMessage,
    isDefaultSessionTitle,
    createSessionAutotitleController,
  };
});
