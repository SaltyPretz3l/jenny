/* renderer/chat/renderer-slash-linked-command.js -- /linked <request> (row 59 checkpoint 5a): sends the request as an ordinary user message, then, on that one send's runtime admission receipt, asks main for a launch grant bound to the admitted message so the assistant's propose_session(user_asked) can start the linked chat without a second click. A failed or missing grant only costs the shortcut: the turn continues and the assistant offers the choice instead. The request text is never logged. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSlashLinkedCommand = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function noop() {}

  // The visible user message and the model's cue. Deliberately English and fixed: it is what
  // the assistant reads, and the request stays the user's own words after it.
  const LINKED_PROMPT_PREFIX = 'Start a linked chat: ';
  const MAX_CHILDREN = 1;

  function str(value) {
    return String(value == null ? '' : value).trim();
  }

  function newActionId() {
    const crypto = globalThis.crypto;
    return crypto && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '';
  }

  function createLinkedCommandHandler(deps = {}) {
    const state = deps.state && typeof deps.state === 'object' ? deps.state : {};
    const getStartPromptSend = typeof deps.getStartPromptSend === 'function' ? deps.getStartPromptSend : () => null;
    const getSessionProposals = typeof deps.getSessionProposals === 'function' ? deps.getSessionProposals : () => null;
    const setNotice = typeof deps.setNotice === 'function' ? deps.setNotice : noop;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const makeActionId = typeof deps.newActionId === 'function' ? deps.newActionId : newActionId;
    const getChatWorkspace = typeof deps.getChatWorkspace === 'function' ? deps.getChatWorkspace
      : () => globalThis.window?.jennyShell?.chatWorkspace || null;

    function summaryFor(sessionId) {
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      return sessions.find((entry) => str(entry && entry.id) === sessionId) || null;
    }

    // The incarnation as of admission: a legacy or imported chat gets its first one on this very turn,
    // so the summary captured before the send may not carry it yet.
    async function liveIncarnation(sessionId, summary) {
      const known = str(summaryFor(sessionId)?.session_incarnation) || str(summary && summary.session_incarnation);
      if (known) return known;
      try {
        const fresh = await getChatWorkspace()?.getSummary?.({ schema_version: 1, session_id: sessionId });
        return str(fresh && fresh.ok !== false && fresh.summary && fresh.summary.session_incarnation);
      } catch {
        return '';
      }
    }

    // Runs once, from the durable send's admission receipt of THIS message. Never throws.
    async function authorize(sessionId, summary, receipt) {
      const api = getSessionProposals();
      const incarnation = await liveIncarnation(sessionId, summary);
      const messageId = str(receipt && receipt.user_message_id);
      if (!incarnation || !messageId || str(receipt && receipt.session_id) !== sessionId || typeof api?.authorizeLaunch !== 'function') {
        setNotice(jt('chat.linked.noGrant', 'Jenny will offer the linked chat first, because it could not be pre-approved.'));
        appendClientLog('INFO', 'slash.linked_grant_skipped', { reason: incarnation && messageId ? 'unavailable' : 'missing_identity' });
        return false;
      }
      const projectId = str(summary && summary.project_id);
      try {
        const result = await api.authorizeLaunch({
          schema_version: 1,
          session_id: sessionId,
          source_user_message_id: messageId,
          expected_session_incarnation: incarnation,
          max_children: MAX_CHILDREN,
          destination_project_ids: [projectId || null],
          action_id: makeActionId(),
        });
        if (result && result.ok === false) throw Object.assign(new Error('refused'), { code: result.reason });
        return true;
      } catch (error) {
        setNotice(jt('chat.linked.grantFailed', 'The linked chat could not be pre-approved, so Jenny will offer it first.'));
        appendClientLog('WARN', 'slash.linked_grant_failed', { code: str(error && error.code).slice(0, 64) || 'error' });
        return false;
      }
    }

    return async function handleLinkedCommand(invocation) {
      const request = str(invocation && invocation.args);
      if (!request) {
        setNotice(jt('chat.linked.typeSomething', 'Type what the linked chat should do after /linked.'));
        return { ok: false, handled: true, code: 'empty_args' };
      }
      const sessionId = str(invocation && invocation.sessionId);
      const startPromptSend = getStartPromptSend();
      if (!sessionId || typeof startPromptSend !== 'function') {
        setNotice(jt('chat.linked.unavailable', 'Linked chats are not available here.'));
        return { ok: false, handled: true, code: 'linked_unavailable' };
      }
      const summary = summaryFor(sessionId);
      const result = await startPromptSend(LINKED_PROMPT_PREFIX + request, {
        sessionIdOverride: sessionId,
        // The composer still holds "/linked ..."; the slash dispatch clears it after a successful handler.
        preserveComposerDraft: true,
        onAdmission: (receipt) => { void authorize(sessionId, summary, receipt); },
      });
      if (!result || result.rejected === true || result.failed === true) {
        return { ok: false, handled: true, code: 'send_not_started' };
      }
      return { ok: true, code: 'linked_sent' };
    };
  }

  return { LINKED_PROMPT_PREFIX, createLinkedCommandHandler };
});
