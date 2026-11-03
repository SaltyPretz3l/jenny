(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSessionUnread = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Sidebar unread (row 59 checkpoint 4): a chat that received addressed messages the person
  // has not seen gets a 600-weight title plus a 6 px accent dot in the time slot, with the
  // word "unread" for assistive tech. Unread is sidebar-only and independent of inclusion.
  // The signal is the session summary's unread_message_count; bindUnreadSync keeps it current
  // between summary refreshes from the chatMessages change events; bindSessionsChangedSync (row 94) refreshes
  // the whole list when an agent changed other chats.

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const SCHEMA_VERSION = 1;
  const SYNC_DELAY_MS = 150;

  /** Unread inbox messages on a session summary; absent, negative or malformed reads as 0. */
  function count(session) {
    const value = session && session.unread_message_count;
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  /** Extra class for the row's title span. */
  function titleClass(session) {
    return count(session) > 0 ? ' session-row__title--unread' : '';
  }

  /** The dot and its accessible word, placed before the time in the row's open button. */
  function markup(session) {
    if (count(session) <= 0) return '';
    return '<span class="session-row__unread-dot" aria-hidden="true"></span>'
      + '<span class="sr-only">' + jt('sidebar.chats.unread', 'unread') + '</span>';
  }

  /**
   * The session list with one chat's mail counts replaced, or null when nothing moved (or the chat
   * is not listed). The failed-delivery count feeds the "Needs you" row; null keeps the summary's own.
   * @returns {Array<object>|null}
   */
  function patchMailCounts(sessions, sessionId, unread, failed) {
    const list = Array.isArray(sessions) ? sessions : [];
    const current = list.find((session) => session && session.id === sessionId);
    if (!current) return null;
    const failedCount = failed === null || failed === undefined ? (current.failed_delivery_count || 0) : failed;
    if ((current.unread_message_count || 0) === unread && (current.failed_delivery_count || 0) === failedCount) return null;
    const patched = Object.assign({}, current, { unread_message_count: unread, failed_delivery_count: failedCount });
    return list.map((session) => (session === current ? patched : session));
  }

  /**
   * Re-reads one chat's unread count when a message lands or is read, then hands it to apply(),
   * with the failed-delivery count the same reply carries (null when absent) for "Needs you".
   * @param {object} options {bridge, apply(sessionId, unreadCount, failedDeliveryCount), setTimeout?, clearTimeout?}
   * @returns {function} dispose
   */
  function bindUnreadSync(options) {
    const o = options || {};
    const bridge = o.bridge;
    if (!bridge || typeof bridge.onChanged !== 'function' || typeof bridge.list !== 'function' || typeof o.apply !== 'function') return function noop() {};
    const setTimer = typeof o.setTimeout === 'function' ? o.setTimeout : function (fn, ms) { return setTimeout(fn, ms); };
    const clearTimer = typeof o.clearTimeout === 'function' ? o.clearTimeout : function (handle) { clearTimeout(handle); };
    const timers = new Map();
    // Per-chat read sequence: only the latest read for a chat may apply, so a slow older count never overwrites a newer one.
    const sequences = new Map();
    let disposed = false;

    function read(sessionId) {
      const seq = (sequences.get(sessionId) || 0) + 1;
      sequences.set(sessionId, seq);
      return Promise.resolve(bridge.list({ schema_version: SCHEMA_VERSION, session_id: sessionId, direction: 'inbox', limit: 1 })).then(function (response) {
        if (disposed || sequences.get(sessionId) !== seq) return;
        const unread = response && response.ok === true && response.counts ? response.counts.unread : null;
        const failed = response && response.ok === true && response.counts ? response.counts.failed_delivery : null;
        if (Number.isSafeInteger(unread) && unread >= 0) o.apply(sessionId, unread, Number.isSafeInteger(failed) && failed >= 0 ? failed : null);
      }).catch(function () { /* the next summary refresh carries the count */ });
    }

    const unsubscribe = bridge.onChanged(function (event) {
      const sessionId = event && typeof event.session_id === 'string' ? event.session_id : '';
      if (disposed || !sessionId || timers.has(sessionId)) return;
      timers.set(sessionId, setTimer(function () {
        timers.delete(sessionId);
        void read(sessionId);
      }, SYNC_DELAY_MS));
    });

    return function dispose() {
      disposed = true;
      timers.forEach(clearTimer);
      timers.clear();
      sequences.clear();
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
    };
  }

  /**
   * Row 94: sessions.onChanged says an agent changed other chats (rename, pin, archive, move, model, mode).
   * A burst coalesces into one refresh(sessionIds); at most one runs at a time and events that land during
   * it earn one follow-up. A failed refresh is swallowed: the next push or summary refresh catches up.
   * @param {object} options {bridge, refresh(sessionIds, {projectsChanged}), setTimeout?, clearTimeout?}
   * @returns {function} dispose
   */
  function bindSessionsChangedSync(options) {
    const o = options || {};
    const bridge = o.bridge;
    if (!bridge || typeof bridge.onChanged !== 'function' || typeof o.refresh !== 'function') return function noop() {};
    const setTimer = typeof o.setTimeout === 'function' ? o.setTimeout : function (fn, ms) { return setTimeout(fn, ms); };
    const clearTimer = typeof o.clearTimeout === 'function' ? o.clearTimeout : function (handle) { clearTimeout(handle); };
    const pending = new Set();
    let projectsChanged = false;
    let timer = null;
    let running = false;
    let disposed = false;

    function schedule() {
      if (disposed || timer !== null || running || pending.size === 0) return;
      timer = setTimer(function () {
        timer = null;
        if (disposed) return;
        const ids = Array.from(pending);
        const flags = { projectsChanged: projectsChanged };
        pending.clear();
        projectsChanged = false;
        running = true;
        Promise.resolve().then(function () { return o.refresh(ids, flags); }).catch(function () { /* the next push catches up */ }).then(function () {
          running = false;
          schedule();
        });
      }, SYNC_DELAY_MS);
    }

    const unsubscribe = bridge.onChanged(function (event) {
      const ids = event && Array.isArray(event.session_ids) ? event.session_ids : [];
      ids.forEach(function (id) { if (typeof id === 'string' && id && pending.size < 200) pending.add(id); });
      if (event && event.projects_changed === true) projectsChanged = true;
      schedule();
    });

    return function dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending.clear();
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
    };
  }

  return { count, titleClass, markup, patchMailCounts, bindUnreadSync, bindSessionsChangedSync };
});
