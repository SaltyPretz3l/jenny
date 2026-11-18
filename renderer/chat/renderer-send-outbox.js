/* renderer/chat/renderer-send-outbox.js -- immutable visible FIFO send outbox (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendOutbox = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_MAX_ITEMS = 20;
  const CONTEXT_CAPTURE_DEADLINE_MS = 2000;
  let nextItemSequence = 0;

  function clone(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return value; }
  }

  function deepFreeze(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
  }

  function freezeEntry(entry) {
    return deepFreeze(clone(entry));
  }

  function createSendOutbox(state, options = {}) {
    const requestedMaxItems = Number(options.maxItems);
    const maxItems = Number.isFinite(requestedMaxItems) && requestedMaxItems >= 1
      ? Math.floor(requestedMaxItems)
      : DEFAULT_MAX_ITEMS;
    const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
    const releaseAssets = typeof options.releaseAssets === 'function' ? options.releaseAssets : () => {};
    if (!(state.sendOutboxBySession instanceof Map)) state.sendOutboxBySession = new Map();
    if (!(state.queuedSendBySession instanceof Map)) state.queuedSendBySession = new Map();
    const capturePromises = new Map();
    const removeListeners = new Set();
    let disposed = false;

    function normalizeSessionId(value) { return String(value || '').trim(); }
    function queueFor(sessionId) {
      const id = normalizeSessionId(sessionId);
      if (!id) return [];
      let queue = state.sendOutboxBySession.get(id);
      if (!Array.isArray(queue)) {
        const legacy = state.queuedSendBySession.get(id);
        queue = legacy ? [freezeEntry({
          ...legacy,
          id: String(legacy.id || `outbox_legacy_${++nextItemSequence}`),
          revision: Math.max(Number(legacy.revision) || 1, 1),
          status: String(legacy.status || 'ready'),
          attachmentOwner: Array.isArray(legacy.attachments) && legacy.attachments.length
            ? String(legacy.attachmentOwner || 'outbox')
            : 'none',
        })] : [];
        if (queue.length) state.sendOutboxBySession.set(id, queue);
      }
      return queue;
    }

    function findById(itemId) {
      const id = String(itemId || '').trim();
      if (!id) return null;
      for (const [sessionId, queue] of state.sendOutboxBySession.entries()) {
        const entry = Array.isArray(queue) ? queue.find((candidate) => candidate.id === id) : null;
        if (entry) return { sessionId, entry };
      }
      return null;
    }

    function createItemId(prefix = 'outbox') {
      let id;
      do {
        id = `${prefix}_${Date.now().toString(36)}_${(++nextItemSequence).toString(36)}`;
      } while (findById(id));
      return id;
    }

    function releaseOwnedAttachments(entry) {
      if (!entry || entry.attachmentOwner !== 'outbox') return false;
      const candidatePaths = [...new Set((Array.isArray(entry.attachments) ? entry.attachments : [])
        .map((attachment) => String(attachment?.assetPath || '').trim())
        .filter(Boolean))];
      const paths = typeof state.sendReceiptController?.filterReleasableAssetPaths === 'function'
        ? state.sendReceiptController.filterReleasableAssetPaths(candidatePaths)
        : candidatePaths;
      if (!paths.length) return false;
      try { releaseAssets(paths)?.catch?.(() => {}); } catch (_error) { /* best-effort edge cleanup */ }
      return true;
    }

    function cancelCapture(itemId) {
      const pending = capturePromises.get(String(itemId || ''));
      if (!pending) return false;
      pending.cancel();
      capturePromises.delete(String(itemId || ''));
      return true;
    }

    // A 'taken' row (row 180) is never the head the composer or the drain restores.
    const isEcho = (entry) => entry?.status === 'taken';

    function syncLegacyHead(sessionId, queue) {
      const id = normalizeSessionId(sessionId);
      if (!id) return;
      const head = queue.find((entry) => !isEcho(entry));
      if (head) state.queuedSendBySession.set(id, head);
      else state.queuedSendBySession.delete(id);
      if (queue.length) state.sendOutboxBySession.set(id, queue);
      else state.sendOutboxBySession.delete(id);
    }

    function list(sessionId) { return queueFor(sessionId).slice(); }
    function peek(sessionId) { return queueFor(sessionId).find((entry) => !isEcho(entry)) || null; }
    function firstDispatchable(sessionId) {
      for (const entry of queueFor(sessionId)) {
        if (['needs_review', 'sent', 'taken'].includes(entry.status)) continue;
        // 'offered' is dispatchable: a terminal that outruns main's release still sends it.
        if (['capturing_context', 'ready', 'waiting_for_turn', 'failed', 'offered'].includes(entry.status)) return entry;
        return null;
      }
      return null;
    }

    function enqueue(sessionId, payload) {
      const id = normalizeSessionId(sessionId);
      const queue = queueFor(id);
      if (disposed || !id || !payload || queue.length >= maxItems) return null;
      const entry = freezeEntry({
        sessionId: id,
        id: createItemId(),
        revision: 1,
        status: String(payload.status || 'capturing_context'),
        prompt: String(payload.prompt || ''),
        attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
        runtimePreferences: payload.runtimePreferences || null,
        sourceRevision: Number(payload.sourceRevision) || 0,
        targetSessionIncarnation: String(payload.targetSessionIncarnation || ''),
        createdAt: Number(payload.createdAt || Date.now()),
        source: String(payload.source || 'send_controller'),
        attachmentOwner: Array.isArray(payload.attachments) && payload.attachments.length
          ? String(payload.attachmentOwner || 'outbox')
          : 'none',
        meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {},
        failure: null,
      });
      const next = [...queue, entry];
      syncLegacyHead(id, next);
      return entry;
    }

    function replace(entry, patch) {
      if (!entry) return null;
      const queue = queueFor(entry.sessionId);
      const index = queue.findIndex((candidate) => candidate.id === entry.id
        && candidate.revision === entry.revision);
      if (index === -1) return null;
      const nextEntry = freezeEntry({
        ...queue[index],
        ...clone(patch),
        id: queue[index].id,
        sessionId: queue[index].sessionId,
        revision: queue[index].revision + 1,
      });
      const next = queue.slice();
      next[index] = nextEntry;
      syncLegacyHead(entry.sessionId, next);
      return nextEntry;
    }

    function remove(entry) {
      if (!entry) return false;
      const queue = queueFor(entry.sessionId);
      const index = queue.findIndex((candidate) => candidate.id === entry.id
        && candidate.revision === entry.revision);
      if (index === -1) return false;
      const next = queue.slice();
      next.splice(index, 1);
      cancelCapture(entry.id);
      syncLegacyHead(entry.sessionId, next);
      releaseOwnedAttachments(queue[index]);
      for (const listener of [...removeListeners]) {
        try { listener(entry.sessionId, queue[index]); } catch (_error) { /* listeners never break a removal */ }
      }
      return true;
    }

    // Row 180: the drain may still take it, so its files stay held until a user_steer
    // claims them or the turn's end releases them.
    const heldBySession = new Map();
    function removeHolding(entry) {
      const current = entry ? queueFor(entry.sessionId).find((candidate) => candidate.id === entry.id) : null;
      if (!current || current.attachmentOwner !== 'outbox') return remove(entry);
      const handed = replace(current, { attachmentOwner: 'none' });
      if (!handed || !remove(handed)) return false;
      if (!heldBySession.has(current.sessionId)) heldBySession.set(current.sessionId, new Map());
      heldBySession.get(current.sessionId).set(current.id, current);
      return true;
    }
    function claimHeld(sessionId, itemId) {
      return Boolean(heldBySession.get(normalizeSessionId(sessionId))?.delete(String(itemId || '')));
    }
    function releaseHeld(sessionId) {
      const id = normalizeSessionId(sessionId);
      const held = heldBySession.get(id);
      if (!held) return 0;
      heldBySession.delete(id);
      for (const entry of held.values()) releaseOwnedAttachments(entry);
      return held.size;
    }

    function onRemove(listener) {
      if (typeof listener !== 'function') return () => {};
      removeListeners.add(listener);
      return () => removeListeners.delete(listener);
    }

    function edit(entry, prompt) {
      const editedPrompt = String(prompt || '');
      const hasPromptBearingAttachment = (Array.isArray(entry?.attachments) ? entry.attachments : [])
        .some((attachment) => String(attachment?.kind || '').trim() !== 'audio');
      return replace(entry, {
        prompt: editedPrompt,
        status: editedPrompt.trim() || hasPromptBearingAttachment
          ? (capturePromises.has(entry.id) ? 'capturing_context' : 'ready') : 'needs_review',
        failure: null,
      });
    }
    function retry(entry) { return replace(entry, { status: 'ready', failure: null }); }

    function settleContextCapture(entry, capturePromise) {
      if (!entry || disposed) return Promise.resolve(null);
      let timer = null;
      let cancel = () => {};
      const deadline = new Promise((resolve) => {
        cancel = () => resolve({ cancelled: true });
        timer = setTimeoutImpl(() => resolve({ omitted: true, reason: 'context_capture_timeout' }), CONTEXT_CAPTURE_DEADLINE_MS);
      });
      const capture = Promise.resolve(capturePromise)
        .then((meta) => ({ meta: meta && typeof meta === 'object' ? meta : {}, omitted: false }))
        .catch(() => ({ omitted: true, reason: 'context_capture_failed' }));
      const settled = Promise.race([capture, deadline]).then((result) => {
        if (timer !== null) clearTimeoutImpl(timer);
        if (disposed || result.cancelled) return null;
        const current = findById(entry.id)?.entry || null;
        if (!current || ['sending', 'sent'].includes(current.status)) return null;
        return replace(current, {
          status: current.status === 'needs_review' ? 'needs_review' : 'ready',
          meta: result.omitted ? {
            ...current.meta,
            mentionContentsSnapshot: [],
            contextOmission: { reason: result.reason },
          } : { ...current.meta, ...result.meta },
        });
      }).finally(() => capturePromises.delete(entry.id));
      capturePromises.set(entry.id, {
        promise: settled,
        cancel() {
          if (timer !== null) clearTimeoutImpl(timer);
          cancel();
        },
      });
      return settled;
    }

    async function awaitContextCapture(entry) {
      if (!entry || !capturePromises.has(entry.id)) return entry;
      await capturePromises.get(entry.id)?.promise;
      return findById(entry.id)?.entry || null;
    }

    function clearSession(sessionId) {
      const id = normalizeSessionId(sessionId);
      const entries = queueFor(id).slice();
      syncLegacyHead(id, []);
      for (const entry of entries) {
        cancelCapture(entry.id);
        releaseOwnedAttachments(entry);
      }
    }

    function clearAll() {
      for (const entry of capturePromises.values()) entry.cancel();
      const entries = [...state.sendOutboxBySession.values()]
        .flatMap((queue) => (Array.isArray(queue) ? queue : []));
      capturePromises.clear();
      state.sendOutboxBySession.clear();
      state.queuedSendBySession.clear();
      for (const entry of entries) releaseOwnedAttachments(entry);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      removeListeners.clear();
      clearAll();
    }

    function rekeySession(sourceSessionId, targetSessionId) {
      const source = normalizeSessionId(sourceSessionId);
      const target = normalizeSessionId(targetSessionId);
      if (!source || !target || source === target) return target;
      const sourceQueue = queueFor(source);
      if (!sourceQueue.length) return target;
      const targetQueue = queueFor(target);
      const moved = sourceQueue.map((entry) => freezeEntry({
        ...entry,
        sessionId: target,
        revision: entry.revision + 1,
      }));
      syncLegacyHead(source, []);
      syncLegacyHead(target, [...targetQueue, ...moved]);
      return target;
    }

    return {
      awaitContextCapture,
      claimHeld,
      clearAll,
      clearSession,
      dispose,
      edit,
      enqueue,
      firstDispatchable,
      list,
      onRemove,
      peek,
      releaseHeld,
      remove,
      removeHolding,
      rekeySession,
      replace,
      retry,
      settleContextCapture,
    };
  }

  function getOrCreateSendOutbox(state, options) {
    if (!state.sendOutboxController) {
      state.sendOutboxController = createSendOutbox(state, options);
    }
    return state.sendOutboxController;
  }

  return { createSendOutbox, getOrCreateSendOutbox };
});
