/* renderer/chat/renderer-slash-memory-commands.js -- /remember, /forget and /memory (memory v2, row 58 W1): explicit user memory commands over the existing jennyShell.memory bridge. The project always comes from the chat's session; memory text is printed into the chat only, never logged. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSlashMemoryCommands = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function noop() {}

  const GENERAL_PROJECT_ID = 'project_general';
  const KINDS = Object.freeze(['preference', 'fact', 'decision', 'convention', 'person', 'routine', 'lesson']);
  const KIND_PREFIX = new RegExp(`^(${KINDS.join('|')})\\s*:\\s*`, 'i');
  const DEFAULT_KIND = 'fact';
  const MAX_TITLE_CHARS = 80;
  const MAX_LISTED = 50;

  function refusalText(reason) {
    switch (reason) {
      case 'project_archived': return jt('composer.slash.memory.reasonProjectArchived', 'this project is archived.');
      case 'capacity': return jt('composer.slash.memory.reasonCapacity', 'memory is full. Forget something first.');
      case 'always_on_full': return jt('composer.slash.memory.reasonAlwaysOnFull', 'the always-on list is full.');
      case 'unavailable': return jt('composer.slash.memory.reasonUnavailable', 'memory is not available right now.');
      default: return jt('composer.slash.memory.reasonOther', 'Jenny could not keep it.');
    }
  }

  function oneLine(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function createMemoryCommandHandlers(deps = {}) {
    const state = deps.state && typeof deps.state === 'object' ? deps.state : {};
    const getMemoryApi = typeof deps.getMemoryApi === 'function' ? deps.getMemoryApi : () => null;
    const injectOutput = typeof deps.injectOutput === 'function' ? deps.injectOutput : noop;
    const showToastMessage = typeof deps.showToastMessage === 'function' ? deps.showToastMessage : noop;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : noop;
    const toastOptions = () => ({ title: jt('composer.slash.memory.title', 'Memory'), tone: 'warning' });

    // A chat without a project belongs to General, as everywhere else.
    function sessionProjectId(sessionId) {
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const session = sessions.find((entry) => String(entry?.id || '') === String(sessionId || ''));
      return String(session?.project_id || '') || GENERAL_PROJECT_ID;
    }

    // The rows this chat can see: its project's and General's, newest first.
    async function visibleRows(api, sessionId) {
      const projectId = sessionProjectId(sessionId);
      const listed = await api.listApproved();
      const rows = Array.isArray(listed?.memories) ? listed.memories : [];
      return rows
        .filter((row) => Number.isInteger(row?.id) && (!row.status || row.status === 'active'))
        .filter((row) => row.project_id === projectId || row.project_id === GENERAL_PROJECT_ID)
        // Chat-scope rows belong to one chat; another chat never lists or forgets them.
        .filter((row) => !row.scope_session_id || row.scope_session_id === String(sessionId || ''))
        .sort((left, right) => String(right.updated_at || right.created_at || '').localeCompare(String(left.updated_at || left.created_at || ''))
          || right.id - left.id);
    }

    function unavailable() {
      showToastMessage(jt('composer.slash.memory.unavailable', 'Memory is unavailable.'), toastOptions());
      return { ok: false, handled: true, code: 'memory_unavailable' };
    }

    function failed(command, error) {
      appendClientLog('WARN', 'slash.memory_failed', { command, error: String(error?.code || error?.name || 'error').slice(0, 64) });
      showToastMessage(jt('composer.slash.memory.failed', 'The memory command could not be completed.'), toastOptions());
      return { ok: false, handled: true, code: 'memory_failed' };
    }

    function emptyArgs(message) {
      showToastMessage(message, { title: jt('composer.slash.nothingToSave', 'Nothing to save'), tone: 'warning' });
      return { ok: false, handled: true, code: 'empty_args' };
    }

    async function rememberHandler(invocation) {
      const raw = oneLine(invocation?.args);
      const match = raw.match(KIND_PREFIX);
      const kind = match ? match[1].toLowerCase() : DEFAULT_KIND;
      const text = match ? raw.slice(match[0].length).trim() : raw;
      if (!text) return emptyArgs(jt('composer.slash.memory.rememberTypeSomething', 'Type something after /remember to save it.'));
      const api = getMemoryApi();
      if (typeof api?.save !== 'function') return unavailable();
      let result;
      try {
        result = await api.save(invocation.sessionId, { lesson_text: text, lesson_kind: kind, title: text.slice(0, MAX_TITLE_CHARS) });
      } catch (error) {
        return failed('/remember', error);
      }
      const id = Number.isInteger(result?.memory?.id) ? result.memory.id : null;
      if (result?.status === 'saved' && id !== null) {
        const line = result.duplicate === true
          ? jt('composer.slash.memory.alreadyRemembered', 'Already remembered (id {id}).', { id })
          : jt('composer.slash.memory.remembered', 'Remembered (id {id}, {kind}): {text}', { id, kind, text });
        injectOutput(line, '/remember', invocation);
        return { ok: true, code: result.duplicate === true ? 'memory_duplicate' : 'memory_saved' };
      }
      const reason = result?.status ? String(result.reason || '') : 'unavailable';
      injectOutput(jt('composer.slash.memory.notSaved', 'Not saved: {reason}', { reason: refusalText(reason) }), '/remember', invocation);
      return { ok: false, handled: true, code: 'memory_refused' };
    }

    async function forgetRow(api, row, invocation) {
      const result = await api.delete(row.id, row.project_id);
      if (result?.deleted === true || result?.status === 'saved') {
        injectOutput(jt('composer.slash.memory.forgot', 'Forgot (id {id}): {text}', { id: row.id, text: oneLine(row.lesson_text) }), '/forget', invocation);
        return { ok: true, code: 'memory_forgotten' };
      }
      const reason = result?.status ? String(result.reason || '') : 'unavailable';
      injectOutput(jt('composer.slash.memory.notForgotten', 'Not forgotten: {reason}', { reason: refusalText(reason) }), '/forget', invocation);
      return { ok: false, handled: true, code: 'memory_refused' };
    }

    async function forgetHandler(invocation) {
      const query = oneLine(invocation?.args);
      if (!query) return emptyArgs(jt('composer.slash.memory.forgetTypeSomething', 'Type a memory id or some of its words after /forget.'));
      const api = getMemoryApi();
      if (typeof api?.listApproved !== 'function' || typeof api?.delete !== 'function') return unavailable();
      try {
        const rows = await visibleRows(api, invocation.sessionId);
        // An id names one row; the row's own project goes with the delete.
        const matches = /^\d+$/.test(query)
          ? rows.filter((row) => row.id === Number(query))
          : rows.filter((row) => String(row.lesson_text || '').toLowerCase().includes(query.toLowerCase()));
        if (matches.length === 1) return await forgetRow(api, matches[0], invocation);
        if (matches.length === 0) {
          injectOutput(jt('composer.slash.memory.nothingMatches', 'Nothing matches.'), '/forget', invocation);
          return { ok: false, handled: true, code: 'memory_not_found' };
        }
        const lines = [jt('composer.slash.memory.severalMatch', 'Several memories match; use /forget <id>:')];
        for (const row of matches.slice(0, MAX_LISTED)) lines.push(`[${row.id}] ${oneLine(row.lesson_text)}`);
        injectOutput(lines.join('\n'), '/forget', invocation);
        return { ok: false, handled: true, code: 'memory_ambiguous' };
      } catch (error) {
        return failed('/forget', error);
      }
    }

    async function memoryHandler(invocation) {
      const api = getMemoryApi();
      if (typeof api?.listApproved !== 'function') return unavailable();
      let rows;
      try {
        rows = await visibleRows(api, invocation.sessionId);
      } catch (error) {
        return failed('/memory', error);
      }
      if (!rows.length) {
        injectOutput(jt('composer.slash.memory.empty', 'Jenny remembers nothing for this project yet. Say /remember <text> or just tell her.'), '/memory', invocation);
        return { ok: true, code: 'memory_listed' };
      }
      const lines = rows.slice(0, MAX_LISTED).map((row) => `[${row.id}] (${String(row.lesson_kind || DEFAULT_KIND)}) ${oneLine(row.lesson_text)}`);
      if (rows.length > MAX_LISTED) {
        lines.push(jt('composer.slash.memory.more', '…and {count} more in Settings → Memory', { count: rows.length - MAX_LISTED }));
      }
      injectOutput(lines.join('\n'), '/memory', invocation);
      return { ok: true, code: 'memory_listed' };
    }

    return { rememberHandler, forgetHandler, memoryHandler };
  }

  return { createMemoryCommandHandlers, KINDS };
});
