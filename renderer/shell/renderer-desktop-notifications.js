/* renderer/shell/renderer-desktop-notifications.js -- desktop (OS) notification candidates (UMD) */
/**
 * The renderer half of desktop notifications: it knows WHEN something worth a
 * toast happened and sends one candidate per event to main, which owns every
 * gate (master switch, category switches, "only when Jenny is in the
 * background", support, dedupe) and shows the toast. Nothing here reads the
 * settings or the window focus; the Settings block is only normalized here so
 * the renderer state has a total shape to show.
 *
 * Two sources, both already computed elsewhere:
 *   - a top-level turn's terminal (the terminal-settle wrappers call
 *     onTerminal after the raw complete/error handler returned terminal:true);
 *   - the "Needs you" model rows (the attention inbox calls onInboxRows on
 *     every pass whose sources moved). A row key not seen before is new; keys
 *     are pruned to the live set, so a re-render never re-fires, and rows that
 *     were already pending when the session list loaded are seeded silently
 *     (rehydration never fires a toast).
 *
 * Every candidate also lands in a bounded ring on state.desktopNotificationLog
 * so the agent snapshot and headless tests can assert would-be toasts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDesktopNotifications = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  var NOTIFICATION_CATEGORIES = Object.freeze(['replies', 'failures', 'permissions', 'questions', 'reminders']);
  var DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
    enabled: true,
    onlyWhenUnfocused: true,
    sound: true,
    replyPreview: false,
    categories: Object.freeze({ replies: true, failures: true, permissions: true, questions: true, reminders: true }),
  });
  var LOG_LIMIT = 32;
  var PREVIEW_MAX_CHARS = 240;
  var DETAIL_MAX_CHARS = 120;
  var TITLE_MAX_CHARS = 120;
  var SEPARATOR = ' · ';
  /* Terminal statuses the person chose (Stop, Deny): the timeline settles them
   * with a calm card and no danger toast, so no desktop toast either. */
  var USER_INTENT_STATUSES = Object.freeze(['cancelled', 'denied']);
  /* Rows of a turn that are not the top-level reply bubble. */
  var NON_REPLY_KINDS = Object.freeze(['tool_use', 'tool_result', 'question_batch']);

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function clip(value, maxChars) {
    var normalized = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    var characters = Array.from(normalized);
    return characters.length > maxChars ? characters.slice(0, maxChars).join('') + '…' : normalized;
  }

  function firstLine(value) {
    var lines = String(value == null ? '' : value).split(/\r?\n/);
    for (var i = 0; i < lines.length; i += 1) {
      if (lines[i].trim()) return lines[i];
    }
    return '';
  }

  function flag(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
  }

  /**
   * Total, idempotent: any input (absent, partial, garbage) yields the full
   * shape with each missing or non-boolean field at its default.
   * @param {Object} [value] - persisted windowUi.notifications
   * @returns {{enabled: boolean, onlyWhenUnfocused: boolean, sound: boolean, replyPreview: boolean, categories: Object}}
   */
  function normalizeNotificationSettings(value) {
    var source = isObject(value) ? value : {};
    var categories = isObject(source.categories) ? source.categories : {};
    var normalizedCategories = {};
    NOTIFICATION_CATEGORIES.forEach(function normalizeCategory(id) {
      normalizedCategories[id] = flag(categories[id], DEFAULT_NOTIFICATION_SETTINGS.categories[id]);
    });
    return {
      enabled: flag(source.enabled, DEFAULT_NOTIFICATION_SETTINGS.enabled),
      onlyWhenUnfocused: flag(source.onlyWhenUnfocused, DEFAULT_NOTIFICATION_SETTINGS.onlyWhenUnfocused),
      sound: flag(source.sound, DEFAULT_NOTIFICATION_SETTINGS.sound),
      replyPreview: flag(source.replyPreview, DEFAULT_NOTIFICATION_SETTINGS.replyPreview),
      categories: normalizedCategories,
    };
  }

  function resolveTerminalStateModule() {
    if (globalThis.rendererStreamTerminalState) return globalThis.rendererStreamTerminalState;
    if (typeof require === 'function') {
      try { return require('../chat/renderer-stream-terminal-state'); } catch (_error) { /* browser script mode */ }
    }
    return null;
  }

  /* The same derivation renderer-stream-handler-terminal.js makes for its
   * danger toast: an explicit terminal status wins, a non-"error" status field
   * is the fallback, both resolved through the timeline's own vocabulary. */
  function terminalStatusOf(payload) {
    var explicit = text(payload.terminal_status || payload.terminalStatus);
    var classification = text(payload.status).toLowerCase();
    var raw = explicit || (classification && classification !== 'error' ? classification : '');
    if (!raw) return '';
    var terminalState = resolveTerminalStateModule();
    var presentation = terminalState && typeof terminalState.resolveTerminalPresentation === 'function'
      ? terminalState.resolveTerminalPresentation(raw)
      : null;
    return presentation && presentation.status ? String(presentation.status) : raw.toLowerCase();
  }

  /* A delegate / sub-agent child never notifies; only the top-level turn does.
   * The terminal payload main sends today carries no child marker (runtime
   * children run in their own session and sub-agents report through the
   * parent turn's agent_status steps), so the check is layered: any child
   * marker a payload or its row may carry, then the row itself must be the
   * turn's top-level assistant reply (not a tool row, not a user row). */
  function isDelegateChild(payload, message) {
    // A runtime child's own session carries no stream marker at all; main's
    // desktop notifier suppresses it from the runtime store (child_session).
    if (payload.isDelegateChildProgress === true || payload.delegateChild === true) return true;
    if (text(payload.parent_work_id || payload.parentWorkId)) return true;
    if (isObject(payload.child_run) || isObject(payload.childRun)) return true;
    if (!message) return false;
    if (text(message.role) && text(message.role) !== 'assistant') return true;
    if (NON_REPLY_KINDS.indexOf(text(message.kind)) !== -1) return true;
    if (text(message.parent_work_id || message.parentWorkId)) return true;
    return false;
  }

  function noopController() {
    return {
      onTerminal: function onTerminal() { return null; },
      onInboxRows: function onInboxRows() { return []; },
      onStreamPayload: function onStreamPayload() { return null; },
      drain: function drain() { return []; },
      dispose: function dispose() {},
    };
  }

  /**
   * @param {Object} deps
   * @param {Window} [deps.windowRef]
   * @param {Document} [deps.documentRef]
   * @param {Object} deps.state - renderer state (sessions, messagesBySession, pendingStreams)
   * @param {Object} [deps.callbacks] - { activateWorkspaceSession, appendClientLog }
   * @param {Object} [deps.bridge] - { notify, onOpen }; defaults to windowRef.jennyShell.notifications
   * @returns {{onTerminal: Function, onInboxRows: Function, onStreamPayload: Function, drain: Function, dispose: Function}}
   */
  function createDesktopNotificationsController(deps) {
    var options = isObject(deps) ? deps : {};
    var state = isObject(options.state) ? options.state : null;
    if (!state) return noopController();
    var windowRef = options.windowRef || null;
    var callbacks = isObject(options.callbacks) ? options.callbacks : {};
    var bridge = options.bridge !== undefined
      ? options.bridge
      : (windowRef && windowRef.jennyShell && windowRef.jennyShell.notifications) || null;
    var seenKeys = new Set();
    var seededWhileLoaded = false;
    var loggedFailures = new Set();
    var lastDrainedEntry = null;
    var unsubscribeOpen = null;
    var disposed = false;

    if (!Array.isArray(state.desktopNotificationLog)) state.desktopNotificationLog = [];

    function log(level, event, data) {
      if (typeof callbacks.appendClientLog !== 'function') return;
      try { callbacks.appendClientLog(level, event, data); } catch (_error) { /* logging never breaks a notify */ }
    }

    function logOnce(event, error) {
      var message = String((error && error.message) || error || '').slice(0, 200);
      if (loggedFailures.has(event + '\u0000' + message)) return;
      loggedFailures.add(event + '\u0000' + message);
      log('WARN', event, { message: message });
    }

    function sessionTitleFor(sessionId) {
      var sessions = Array.isArray(state.sessions) ? state.sessions : [];
      for (var i = 0; i < sessions.length; i += 1) {
        if (sessions[i] && text(sessions[i].id) === sessionId) {
          var title = text(sessions[i].title);
          if (title) return clip(title, TITLE_MAX_CHARS);
          break;
        }
      }
      return jt('chat.attentionInbox.untitledSession', 'Untitled chat');
    }

    function findMessage(sessionId, messageId) {
      if (!messageId || !state.messagesBySession || typeof state.messagesBySession.get !== 'function') return null;
      var messages = state.messagesBySession.get(sessionId);
      if (!Array.isArray(messages)) return null;
      for (var i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i] && text(messages[i].id) === messageId) return messages[i];
      }
      return null;
    }

    function emit(candidate) {
      if (disposed) return null;
      var log32 = Array.isArray(state.desktopNotificationLog) ? state.desktopNotificationLog : [];
      state.desktopNotificationLog = log32;
      log32.push(Object.assign({ at: Date.now() }, candidate));
      while (log32.length > LOG_LIMIT) log32.shift();
      if (bridge && typeof bridge.notify === 'function') {
        try {
          bridge.notify(candidate);
        } catch (error) {
          logOnce('desktop_notifications.send_failed', error);
        }
      }
      return candidate;
    }

    /* Provider errors chain causes with ": " ("Model X is unavailable: engine
     * failed: RuntimeError: ..."); the toast keeps the first clause, which is
     * the one written for a person, and the chat holds the full text. */
    function failureDetail(message) {
      var full = text(message);
      var cut = full.indexOf(': ');
      var head = cut > 0 ? full.slice(0, cut) : full;
      return clip(head.length >= 12 ? head : full, DETAIL_MAX_CHARS);
    }

    /**
     * @param {{kind: 'complete'|'error', payload: Object, result: Object, messageId?: string}} event
     * @returns {Object|null} the candidate sent, or null when suppressed
     */
    function onTerminal(event) {
      try {
        var input = isObject(event) ? event : {};
        if (!isObject(input.result) || input.result.terminal !== true) return null;
        if (input.kind !== 'complete' && input.kind !== 'error') return null;
        var payload = isObject(input.payload) ? input.payload : {};
        var sessionId = text(payload.sessionId || payload.session_id);
        if (!sessionId) return null;
        if (USER_INTENT_STATUSES.indexOf(terminalStatusOf(payload)) !== -1) return null;
        var streamId = text(payload.streamId);
        var pendingMessageId = streamId && state.pendingStreams && typeof state.pendingStreams.get === 'function'
          ? state.pendingStreams.get(streamId) : '';
        var messageId = text(input.messageId) || text(pendingMessageId);
        var message = findMessage(sessionId, messageId);
        if (isDelegateChild(payload, message)) return null;
        var sessionTitle = sessionTitleFor(sessionId);
        var key = 'turn:' + (streamId || messageId || sessionId);
        if (input.kind === 'complete') {
          var candidate = {
            category: 'replies',
            key: key,
            sessionId: sessionId,
            title: jt('notifications.toast.replyReady', 'Reply ready'),
            body: sessionTitle,
          };
          var preview = clip(firstLine((message && message.content) || payload.content), PREVIEW_MAX_CHARS);
          if (preview) candidate.preview = preview;
          return emit(candidate);
        }
        var detail = failureDetail(payload.message);
        return emit({
          category: 'failures',
          key: key,
          sessionId: sessionId,
          title: jt('notifications.toast.runFailed', 'Run failed'),
          body: detail ? sessionTitle + SEPARATOR + detail : sessionTitle,
        });
      } catch (error) {
        logOnce('desktop_notifications.terminal_failed', error);
        return null;
      }
    }

    /* An approval restored from the persisted turn when its chat was opened
     * (renderer-session-lifecycle-utils marks it) is on screen already. */
    function isRehydratedApproval(row) {
      var approvals = state.pendingToolApprovals;
      if (!approvals || typeof approvals.values !== 'function') return false;
      var approvalId = text(row.approvalId);
      var callId = text(row.callId);
      var entries = [...approvals.values()];
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i];
        if (!isObject(entry)) continue;
        if ((approvalId && text(entry.approvalId) === approvalId) || (callId && text(entry.callId) === callId)) {
          return entry.rehydrated === true;
        }
      }
      return false;
    }

    function candidateForRow(row) {
      var sessionId = text(row.sessionId);
      if (!sessionId) return null;
      if ((row.kind === 'approval' || row.kind === 'plan_review') && isRehydratedApproval(row)) return null;
      var sessionTitle = clip(text(row.sessionTitle) || sessionTitleFor(sessionId), TITLE_MAX_CHARS);
      var key = 'inbox:' + text(row.key);
      if (row.kind === 'approval') {
        var toolName = clip(row.toolName, DETAIL_MAX_CHARS);
        return {
          category: 'permissions',
          key: key,
          sessionId: sessionId,
          title: jt('notifications.toast.needsPermission', 'Needs your permission'),
          body: toolName ? toolName + SEPARATOR + sessionTitle : sessionTitle,
        };
      }
      if (row.kind === 'question') {
        var intro = clip(row.introText, DETAIL_MAX_CHARS);
        return {
          category: 'questions',
          key: key,
          sessionId: sessionId,
          title: jt('notifications.toast.question', 'Jenny has a question'),
          body: intro ? sessionTitle + SEPARATOR + intro : sessionTitle,
        };
      }
      if (row.kind === 'plan_review') {
        return {
          category: 'questions',
          key: key,
          sessionId: sessionId,
          title: jt('notifications.toast.planReady', 'Plan ready to review'),
          body: sessionTitle,
        };
      }
      return null;
    }

    /* Seeding: the first pass after construction, every pass while the app's
     * session list is not loaded (state.sessionListLoaded === false: boot, or
     * signed out), and the first pass once it is -- rows present then were
     * rehydrated, not new. A state without the flag (tests, hosted) seeds on
     * the first call only. */
    function isSeedingCall() {
      var gated = Object.prototype.hasOwnProperty.call(state, 'sessionListLoaded');
      if (gated && state.sessionListLoaded !== true) {
        seededWhileLoaded = false;
        return true;
      }
      if (!seededWhileLoaded) {
        seededWhileLoaded = true;
        return true;
      }
      return false;
    }

    /**
     * @param {Array<Object>} rows - attention-inbox model rows
     * @returns {Array<Object>} the candidates sent on this pass
     */
    function onInboxRows(rows) {
      var sent = [];
      try {
        var list = Array.isArray(rows) ? rows : [];
        var seeding = isSeedingCall();
        var live = new Set();
        list.forEach(function collect(row) {
          if (row && text(row.key)) live.add(text(row.key));
        });
        seenKeys.forEach(function prune(key) { if (!live.has(key)) seenKeys.delete(key); });
        list.forEach(function consider(row) {
          var rowKey = row ? text(row.key) : '';
          if (!rowKey || seenKeys.has(rowKey)) return;
          seenKeys.add(rowKey);
          if (seeding) return;
          var candidate = candidateForRow(row);
          if (candidate && emit(candidate)) sent.push(candidate);
        });
      } catch (error) {
        logOnce('desktop_notifications.inbox_failed', error);
      }
      return sent;
    }

    /* A live ask_user request never settles a terminal and never becomes a
     * "Needs you" row (those come from the structured question batch), so the
     * stream listener hands every admitted payload here. A withdrawn request
     * frees its key so a re-ask notifies again; a reload never replays the
     * event (the persisted turn restores the card without it). */
    var questionKeys = new Set();
    var QUESTION_KEY_LIMIT = 64;

    /* The call id is unique per ask and short; a question ref (session +
     * stream + call + question ids) runs past main's 120-char key clip, and
     * two refs of one stream would share their clipped prefix. */
    function questionKeyOf(payload) {
      var ref = text(payload.questionRef || payload.question_ref);
      var callId = text(payload.callId || payload.call_id);
      return callId ? 'question:' + callId : ref ? 'question:' + ref.slice(-100) : '';
    }

    /* The question itself first: the payload summary is the generic tool
     * summary ("Ask user 1 question"), only worth showing without a prompt. */
    function questionDetail(payload) {
      var questions = Array.isArray(payload.questions) ? payload.questions : [];
      for (var i = 0; i < questions.length; i += 1) {
        var question = questions[i];
        var prompt = isObject(question) ? text(question.prompt || question.text || question.question || question.header) : text(question);
        if (prompt) return clip(prompt, DETAIL_MAX_CHARS);
      }
      var summary = text(payload.summary);
      return summary ? clip(summary, DETAIL_MAX_CHARS) : '';
    }

    /**
     * @param {Object} payload - one admitted chat stream payload
     * @returns {Object|null} the candidate sent, or null
     */
    function onStreamPayload(payload) {
      try {
        if (!isObject(payload)) return null;
        var type = text(payload.type);
        if (type === 'user_questions_withdrawn') {
          var withdrawnKey = questionKeyOf(payload);
          if (withdrawnKey) questionKeys.delete(withdrawnKey);
          return null;
        }
        if (type !== 'user_questions_requested') return null;
        var sessionId = text(payload.sessionId || payload.session_id);
        var key = questionKeyOf(payload);
        if (!sessionId || !key || questionKeys.has(key)) return null;
        if (isDelegateChild(payload, null)) return null;
        questionKeys.add(key);
        while (questionKeys.size > QUESTION_KEY_LIMIT) questionKeys.delete(questionKeys.values().next().value);
        var sessionTitle = sessionTitleFor(sessionId);
        var detail = questionDetail(payload);
        return emit({
          category: 'questions',
          key: key,
          sessionId: sessionId,
          title: jt('notifications.toast.question', 'Jenny has a question'),
          body: detail ? sessionTitle + SEPARATOR + detail : sessionTitle,
        });
      } catch (error) {
        logOnce('desktop_notifications.question_failed', error);
        return null;
      }
    }

    /* Entries appended since the previous drain, tracked by entry identity so
     * the ring trim never strands the cursor (a trimmed-away cursor restarts
     * from the ring head). Never mutates the ring. */
    function drain() {
      var ring = Array.isArray(state.desktopNotificationLog) ? state.desktopNotificationLog : [];
      var cursorIndex = lastDrainedEntry ? ring.lastIndexOf(lastDrainedEntry) : -1;
      var fresh = ring.slice(cursorIndex + 1);
      if (ring.length > 0) lastDrainedEntry = ring[ring.length - 1];
      return fresh;
    }

    function handleOpen(payload) {
      if (disposed) return;
      var sessionId = text(payload && payload.sessionId);
      if (!sessionId || typeof callbacks.activateWorkspaceSession !== 'function') return;
      try {
        var result = callbacks.activateWorkspaceSession(sessionId);
        if (result && typeof result.catch === 'function') {
          result.catch(function onOpenFailed(error) { logOnce('desktop_notifications.open_failed', error); });
        }
      } catch (error) {
        logOnce('desktop_notifications.open_failed', error);
      }
    }

    if (bridge && typeof bridge.onOpen === 'function') {
      try {
        var unsubscribe = bridge.onOpen(handleOpen);
        if (typeof unsubscribe === 'function') unsubscribeOpen = unsubscribe;
      } catch (error) {
        logOnce('desktop_notifications.subscribe_failed', error);
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (unsubscribeOpen) {
        try { unsubscribeOpen(); } catch (_error) { /* the bridge is going away with the window */ }
      }
      unsubscribeOpen = null;
      seenKeys.clear();
      questionKeys.clear();
    }

    return { onTerminal: onTerminal, onInboxRows: onInboxRows, onStreamPayload: onStreamPayload, drain: drain, dispose: dispose };
  }

  return {
    createDesktopNotificationsController: createDesktopNotificationsController,
    normalizeNotificationSettings: normalizeNotificationSettings,
    DEFAULT_NOTIFICATION_SETTINGS: DEFAULT_NOTIFICATION_SETTINGS,
    NOTIFICATION_CATEGORIES: NOTIFICATION_CATEGORIES,
  };
});
