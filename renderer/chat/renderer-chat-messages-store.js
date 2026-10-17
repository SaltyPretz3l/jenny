(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatMessagesStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Renderer-side cache of one chat's addressed messages (row 59 checkpoint 4): the inbox
  // (what other chats sent here) and the outbox (what this chat sent), read through
  // window.jennyShell.chatMessages. The composer strip and the Review dialog render from
  // this; nothing persists here (the records live in the main process). A missing bridge
  // (hosted browser, tests) reads as an empty, unavailable store and never throws.

  const SCHEMA_VERSION = 1;
  const LIST_LIMIT = 100;
  const INBOX_MAX_PAGES = 13;
  const MARK_READ_LIMIT = 100;
  const REFETCH_COALESCE_MS = 120;
  const EMPTY_COUNTS = Object.freeze({
    unread: 0, queued: 0, reserved: 0, excluded_by_user: 0, included: 0, pending_delivery: 0, failed_delivery: 0, deferred_reason: null,
  });

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function defaultBridge() {
    const shell = globalThis.window ? globalThis.window.jennyShell : globalThis.jennyShell;
    return (shell && shell.chatMessages) || null;
  }

  function newUuid() {
    const cryptoRef = globalThis.crypto;
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
    const hex = () => Math.floor(Math.random() * 16).toString(16);
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => (c === 'x' ? hex() : ((Math.random() * 4) | 8).toString(16)));
  }

  function unavailableFailure() {
    return { schema_version: SCHEMA_VERSION, ok: false, code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true };
  }

  function validList(response) {
    return isObject(response) && response.ok === true && Array.isArray(response.items)
      && Number.isSafeInteger(response.revision) && response.revision >= 0;
  }

  function normalizeCounts(counts) {
    const source = isObject(counts) ? counts : {};
    const next = { ...EMPTY_COUNTS };
    for (const key of Object.keys(EMPTY_COUNTS)) {
      if (key === 'deferred_reason') next[key] = typeof source[key] === 'string' && source[key] ? source[key] : null;
      else if (Number.isSafeInteger(source[key]) && source[key] >= 0) next[key] = source[key];
    }
    return next;
  }

  function createChatMessagesStore(options) {
    const o = options || {};
    const getBridge = typeof o.getBridge === 'function' ? o.getBridge : defaultBridge;
    const setTimer = typeof o.setTimeout === 'function' ? o.setTimeout : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof o.clearTimeout === 'function' ? o.clearTimeout : (handle) => clearTimeout(handle);
    const makeUuid = typeof o.randomUUID === 'function' ? o.randomUUID : newUuid;
    const log = typeof o.appendClientLog === 'function' ? o.appendClientLog : () => {};
    const entries = new Map(); // sessionId -> {status, inbox, outbox, fetching, refetch, fetchedAt, watchers}
    const versions = new Map(); // sessionId -> change counter (the render comparand)
    const busy = new Set();
    const listeners = new Set();
    const refetchTimers = new Map();
    let unsubscribe = null;
    let subscribedBridge = null;
    let disposed = false;

    function touch(sessionId) {
      versions.set(sessionId, (versions.get(sessionId) || 0) + 1);
      for (const listener of [...listeners]) {
        try { listener({ sessionId }); } catch (_error) { /* a view bug never breaks the store */ }
      }
    }

    function ensureEntry(sessionId) {
      let entry = entries.get(sessionId);
      if (!entry) {
        entry = { sessionId, status: 'checking', inbox: null, outbox: null, fetching: false, refetch: false, fetchedAt: 0, watchers: 0 };
        entries.set(sessionId, entry);
      }
      return entry;
    }

    // Revision guard: an older read never overwrites a newer one.
    function applyList(entry, direction, response) {
      if (!validList(response)) return false;
      const current = entry[direction];
      if (current && response.revision < current.revision) return false;
      const next = {
        items: response.items.filter(isObject),
        counts: normalizeCounts(response.counts),
        revision: response.revision,
        hasMore: typeof response.next_cursor === 'string' && response.next_cursor.length > 0,
      };
      if (current && current.revision === next.revision && JSON.stringify(current.items) === JSON.stringify(next.items)
        && JSON.stringify(current.counts) === JSON.stringify(next.counts)) return false;
      entry[direction] = next;
      return true;
    }

    // The inbox lists oldest first, so the newest arrivals can sit past the first page: follow the
    // cursor up to the retained bound (256 outstanding + 1,024 receipts). The outbox lists newest
    // first and the strip shows only the latest receipts, so one page is enough there.
    async function readDirection(bridge, sessionId, direction) {
      const maxPages = direction === 'inbox' ? INBOX_MAX_PAGES : 1;
      let merged = null;
      let cursor = null;
      try {
        for (let page = 0; page < maxPages; page += 1) {
          const request = { schema_version: SCHEMA_VERSION, session_id: sessionId, direction, limit: LIST_LIMIT };
          if (cursor) request.cursor = cursor;
          const response = await bridge.list(request);
          if (!validList(response)) return merged || response;
          // A revision change between pages restarts from a consistent first page next time.
          if (merged && response.revision !== merged.revision) return { ...merged, next_cursor: 'stale' };
          merged = merged ? { ...response, items: [...merged.items, ...response.items] } : response;
          cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : null;
          if (!cursor) break;
        }
        return merged;
      } catch (error) {
        log('WARN', 'chat_messages.list_failed', { direction, message: String((error && error.message) || error || '').slice(0, 120) });
        return merged;
      }
    }

    async function fetchEntry(entry) {
      const bridge = getBridge();
      if (disposed || !bridge || typeof bridge.list !== 'function') return;
      if (entry.fetching) { entry.refetch = true; return; }
      entry.fetching = true;
      const [inbox, outbox] = await Promise.all([readDirection(bridge, entry.sessionId, 'inbox'), readDirection(bridge, entry.sessionId, 'outbox')]);
      entry.fetching = false;
      if (disposed) return;
      entry.fetchedAt = Date.now();
      let changed = false;
      if (applyList(entry, 'inbox', inbox)) changed = true;
      if (applyList(entry, 'outbox', outbox)) changed = true;
      const answered = validList(inbox) || validList(outbox);
      if (answered && entry.status !== 'ready') { entry.status = 'ready'; changed = true; }
      if (!answered && !entry.inbox && !entry.outbox && entry.status !== 'unavailable') { entry.status = 'unavailable'; changed = true; }
      if (changed) touch(entry.sessionId);
      if (entry.refetch) {
        entry.refetch = false;
        void fetchEntry(entry);
      }
    }

    function handleChangedEvent(event) {
      if (disposed || !isObject(event) || typeof event.session_id !== 'string') return;
      const sessionId = event.session_id;
      const entry = entries.get(sessionId);
      if (!entry) return;
      if (entry.watchers <= 0) { entries.delete(sessionId); touch(sessionId); return; }
      if (refetchTimers.has(sessionId)) return;
      refetchTimers.set(sessionId, setTimer(() => {
        refetchTimers.delete(sessionId);
        const live = entries.get(sessionId);
        if (live && !disposed) void fetchEntry(live);
      }, REFETCH_COALESCE_MS));
    }

    function ensureSubscribed(bridge) {
      if (subscribedBridge === bridge || !bridge || typeof bridge.onChanged !== 'function') return;
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
      subscribedBridge = bridge;
      unsubscribe = bridge.onChanged(handleChangedEvent) || null;
    }

    function isAvailable() {
      const bridge = getBridge();
      return Boolean(bridge && typeof bridge.list === 'function');
    }

    /** The read model. Starts the first read on first sight; the answer arrives through subscribe. */
    function lookup(sessionId) {
      const sid = String(sessionId || '');
      const bridge = getBridge();
      if (!sid || !bridge || typeof bridge.list !== 'function') {
        return { status: 'unavailable', inbox: [], outbox: [], counts: { ...EMPTY_COUNTS }, inboxHasMore: false };
      }
      ensureSubscribed(bridge);
      const entry = ensureEntry(sid);
      if (!entry.fetching && entry.fetchedAt === 0) {
        entry.fetching = true; // claim the slot so a second render does not double-fetch
        Promise.resolve().then(() => { entry.fetching = false; return fetchEntry(entry); });
      }
      const inbox = entry.inbox ? entry.inbox.items : [];
      const outbox = entry.outbox ? entry.outbox.items : [];
      const counts = { ...(entry.inbox ? entry.inbox.counts : EMPTY_COUNTS) };
      if (entry.outbox) {
        counts.pending_delivery = entry.outbox.counts.pending_delivery;
        counts.failed_delivery = entry.outbox.counts.failed_delivery;
      }
      return { status: entry.status, inbox, outbox, counts, inboxHasMore: Boolean(entry.inbox && entry.inbox.hasMore) };
    }

    /** Keeps a session's entry live (refetched on change) until released. */
    function watch(sessionId) {
      const sid = String(sessionId || '');
      if (!sid) return () => {};
      const entry = ensureEntry(sid);
      entry.watchers += 1;
      lookup(sid);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const live = entries.get(sid);
        if (live) live.watchers = Math.max(0, live.watchers - 1);
      };
    }

    function refresh(sessionId) {
      const sid = String(sessionId || '');
      if (!sid || !isAvailable()) return Promise.resolve();
      return fetchEntry(ensureEntry(sid));
    }

    function setBusy(key, value, sessionId) {
      if (value === busy.has(key)) return;
      if (value) busy.add(key); else busy.delete(key);
      touch(sessionId);
    }

    function isBusy(key) {
      return busy.has(key);
    }

    // Every action answers the bridge's envelope, or a synthetic unavailable failure; a changed
    // answer is re-read (the change event would also do it, a coalesced beat later).
    async function act(sessionId, key, method, request, options) {
      const bridge = getBridge();
      if (!bridge || typeof bridge[method] !== 'function') return unavailableFailure();
      if (busy.has(key)) return { schema_version: SCHEMA_VERSION, ok: false, code: 'CMP-MESSAGE-0012', reason: 'busy', retryable: true };
      setBusy(key, true, sessionId);
      let response;
      try {
        response = await bridge[method]({ schema_version: SCHEMA_VERSION, ...request });
      } catch (error) {
        log('WARN', 'chat_messages.action_failed', { method, message: String((error && error.message) || error || '').slice(0, 120) });
        response = unavailableFailure();
      }
      setBusy(key, false, sessionId);
      if (!isObject(response)) response = unavailableFailure();
      if (response.ok === true && !(options && options.skipRefresh)) await refresh(sessionId);
      return response;
    }

    function markRead(sessionId, messageIds) {
      const ids = [...new Set((messageIds || []).filter((id) => typeof id === 'string' && id))].slice(0, MARK_READ_LIMIT);
      if (!ids.length) return Promise.resolve({ schema_version: SCHEMA_VERSION, ok: true, updated_count: 0, revision: 0 });
      return act(sessionId, `read:${sessionId}`, 'markRead', { session_id: sessionId, message_ids: ids });
    }

    function setDisposition(sessionId, messageId, disposition) {
      return act(sessionId, `msg:${messageId}`, 'setContextDisposition', { session_id: sessionId, message_ids: [messageId], disposition });
    }

    function discard(sessionId, messageId) {
      return act(sessionId, `msg:${messageId}`, 'discard', { session_id: sessionId, message_ids: [messageId] });
    }

    function retry(sessionId, operationId) {
      return act(sessionId, `op:${operationId}`, 'retry', { operation_id: operationId });
    }

    function cancel(sessionId, operationId) {
      return act(sessionId, `op:${operationId}`, 'cancel', { operation_id: operationId });
    }

    // Archive-restore confirmation (cp5b-3): the person reviewed the exact body and sends it. The busy key is the
    // operation's, so a double click is one call; each call carries a fresh gesture id unless the caller passes the
    // one it already used for the same click. Answers {ok, operation}; the list is re-read on success.
    function confirmRestored(sessionId, operationId, envelopeSha256, gestureId) {
      const sid = String(sessionId || '');
      const operation = String(operationId || '');
      const sha = String(envelopeSha256 || '');
      if (!sid || !operation || !/^[0-9a-f]{64}$/.test(sha)) {
        return Promise.resolve({ schema_version: SCHEMA_VERSION, ok: false, code: 'CMP-MESSAGE-0001', reason: 'invalid_request', retryable: false });
      }
      return act(sid, `op:${operation}`, 'confirmRestored', {
        operation_id: operation, expected_envelope_sha256: sha, gesture_id: gestureId || makeUuid(),
      });
    }

    // The linked-child "Report back to the original chat" switch (cp5b-1). Answers {ok, enabled, revision};
    // it changes no inbox/outbox row, so nothing is re-read.
    function setReporting(childSessionId, enabled) {
      const sid = String(childSessionId || '');
      if (!sid || typeof enabled !== 'boolean') return Promise.resolve({ schema_version: SCHEMA_VERSION, ok: false, code: 'CMP-MESSAGE-0001', reason: 'invalid_request', retryable: false });
      return act(sid, `reporting:${sid}`, 'setReporting', { child_session_id: sid, enabled }, { skipRefresh: true });
    }

    // Directional grants (cp5b-2): "allow messages in this direction for seven days". Each call carries
    // its own fresh gesture id, so one click is one grant; the busy key keeps a double click to one
    // call. A grant changes no inbox/outbox row, so nothing is re-read; the caller reloads recipients.
    function createGrant(sourceSessionId, destinationSessionId, purpose) {
      const source = String(sourceSessionId || '');
      const destination = String(destinationSessionId || '');
      if (!source || !destination) return Promise.resolve({ schema_version: SCHEMA_VERSION, ok: false, code: 'CMP-MESSAGE-0001', reason: 'invalid_request', retryable: false });
      return act(source, `grant:${source}:${destination}`, 'createGrant', {
        source_session_id: source, destination_session_id: destination, purpose: String(purpose == null ? '' : purpose), gesture_id: makeUuid(),
      }, { skipRefresh: true });
    }

    function revokeGrant(sourceSessionId, grantId) {
      const source = String(sourceSessionId || '');
      const grant = String(grantId || '');
      if (!source || !grant) return Promise.resolve({ schema_version: SCHEMA_VERSION, ok: false, code: 'CMP-MESSAGE-0001', reason: 'invalid_request', retryable: false });
      return act(source, `grant:${source}:${grant}`, 'revokeGrant', { source_session_id: source, grant_id: grant }, { skipRefresh: true });
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }

    /** '' when this session has no read yet, else a token that moves whenever its read model does. */
    function stateKey(sessionId) {
      const version = versions.get(String(sessionId || ''));
      return version ? `chat-messages:${version}` : '';
    }

    function dispose() {
      disposed = true;
      for (const timer of refetchTimers.values()) clearTimer(timer);
      refetchTimers.clear();
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
      unsubscribe = null;
      listeners.clear();
      entries.clear();
      busy.clear();
    }

    return {
      lookup, watch, refresh, markRead, setDisposition, discard, retry, cancel, confirmRestored, setReporting, createGrant, revokeGrant, isBusy, isAvailable, subscribe, stateKey, newGestureId: makeUuid, dispose,
    };
  }

  let defaultStore = null;
  function getDefaultStore() {
    if (!defaultStore) defaultStore = createChatMessagesStore();
    return defaultStore;
  }

  return {
    createChatMessagesStore,
    getDefaultStore,
    EMPTY_COUNTS,
    chatMessagesStateKey: (sessionId) => (defaultStore ? defaultStore.stateKey(sessionId) : ''),
  };
});
