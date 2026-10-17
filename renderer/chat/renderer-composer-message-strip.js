(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-messages-copy'), require('./renderer-chat-messages-store'));
    return;
  }
  root.rendererComposerMessageStrip = factory(root.rendererChatMessagesCopy, root.rendererChatMessagesStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (copy, storeModule) {
  'use strict';

  // The message strip above a pane's composer (row 59 checkpoint 4): the inbox backlog line
  // ("N messages will be included in the next turn . Review") and the sender's receipts
  // (Sending / Couldn't deliver + Retry + Cancel send / Delivered). It renders from the
  // pane session's live inbox and outbox, marks visible unread messages read, and announces
  // state changes through the shared announcer rather than a live region that repaints.

  const { jt, jtn, escapeHtml } = copy;
  const MAX_RECEIPTS = 3;
  const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000;

  function stamp(value) {
    const ms = value ? new Date(value).valueOf() : 0;
    return Number.isFinite(ms) ? ms : 0;
  }

  /** Pure read model: what the strip shows for one session's counts and outbox. */
  function buildStripView(lookup, nowMs) {
    const counts = (lookup && lookup.counts) || storeModule.EMPTY_COUNTS;
    let backlog = null;
    if (counts.queued > 0 && counts.deferred_reason) {
      backlog = {
        tone: 'warn',
        word: counts.deferred_reason === 'budget_unknown'
          ? jt('chat.messages.strip.waitingUnknown', 'Waiting · context size unknown')
          : jt('chat.messages.strip.waiting', 'Waiting · context is full'),
        detail: jtn('chat.messages.strip.waitingCount', counts.queued, { count: counts.queued }, '{count} message waiting', '{count} messages waiting'),
      };
    } else if (counts.queued > 0) {
      backlog = {
        tone: 'muted',
        word: '',
        detail: jtn('chat.messages.strip.willInclude', counts.queued, { count: counts.queued }, '{count} message will be included in the next turn', '{count} messages will be included in the next turn'),
      };
    } else if (counts.excluded_by_user > 0) {
      backlog = {
        tone: 'muted',
        word: '',
        detail: jtn('chat.messages.strip.excluded', counts.excluded_by_user, { count: counts.excluded_by_user }, '{count} message excluded from the next turn', '{count} messages excluded from the next turn'),
      };
    }
    const outbox = lookup && Array.isArray(lookup.outbox) ? lookup.outbox : [];
    const receipts = outbox.filter((item) => {
      if (!copy.isObject(item) || typeof item.operation_id !== 'string') return false;
      if (item.state === 'pending' || item.state === 'failed') return true;
      return item.state === 'delivered' && nowMs - stamp(item.delivered_at) <= RECEIPT_WINDOW_MS;
    }).map((item) => {
      const destination = copy.isObject(item.destination) ? item.destination : {};
      const title = copy.chatTitle(destination.title, destination.available !== false);
      // A linked child's terminal report to its parent (cp5b-1) reads "Report to", and its Cancel is "Discard report".
      const report = copy.isReportEnvelope(item.envelope);
      if (item.state === 'pending') {
        return { id: item.operation_id, state: 'pending', title, report, tone: 'pending', word: jt('chat.messages.strip.sending', 'Sending…'), detail: '', order: stamp(item.send_requested_at || item.prepared_at) };
      }
      if (item.state === 'failed' && item.restore_requires_confirmation === true) {
        // Parked by an archive restore (cp5b-3): never plain Retry; the person reviews the exact body and sends it.
        return {
          id: item.operation_id, state: 'failed', title, report, tone: 'warn', retry: false, restore: true,
          word: copy.restoredStripWord(), detail: copy.restoredStripDetail(), order: stamp(item.send_requested_at || item.prepared_at),
        };
      }
      if (item.state === 'failed') {
        const error = copy.isObject(item.last_error) ? item.last_error : null;
        return {
          id: item.operation_id, state: 'failed', title, report, tone: 'error', retry: !error || error.retryable !== false,
          word: jt('chat.messages.strip.failed', "Couldn't deliver"), detail: copy.deliveryFailureDetail(error), order: stamp(item.send_requested_at || item.prepared_at),
        };
      }
      return { id: item.operation_id, state: 'delivered', title, report, tone: 'ok', word: jt('chat.messages.strip.delivered', 'Delivered'), detail: copy.formatTime(item.delivered_at), order: stamp(item.delivered_at) };
    });
    // Failures and in-flight sends first (they need a decision), then deliveries; newest first in each.
    receipts.sort((a, b) => (Number(a.state === 'delivered') - Number(b.state === 'delivered')) || (b.order - a.order));
    return { backlog, receipts: receipts.slice(0, MAX_RECEIPTS) };
  }

  function dotClass(tone) {
    return { ok: 'status-dot--ok', warn: 'status-dot--warn', error: 'status-dot--error', pending: 'status-dot--pending' }[tone] || 'status-dot--muted';
  }

  function statusLine(tone, word, detail, controls) {
    return `<div class="composer-message-strip__status" data-tone="${escapeHtml(tone)}"${tone === 'pending' ? ' data-running="true"' : ''}>`
      + `<span class="status-dot ${dotClass(tone)}" aria-hidden="true"></span>`
      + (word ? `<span class="composer-message-strip__state">${escapeHtml(word)}</span>` : '')
      + (detail ? `<span class="composer-message-strip__detail">${escapeHtml(detail)}</span>` : '')
      + (controls || '')
      + '</div>';
  }

  const sentLine = (receipt) => (receipt.report
    ? copy.reportToLine(receipt.title)
    : jt('chat.messages.strip.sentTo', 'Sent to “{title}”', { title: receipt.title }));

  function stripMarkup(view, deps) {
    const link = (action, label, extra) => deps.actionButton({
      plain: true, className: 'composer-message-strip__link', label, dataset: { 'message-strip-action': action, ...(extra || {}) },
    });
    let html = '';
    if (view.backlog) {
      html += `<div class="composer-message-strip__backlog">${statusLine(view.backlog.tone, view.backlog.word, view.backlog.detail, link('review', jt('chat.messages.strip.review', 'Review')))}</div>`;
    }
    for (const receipt of view.receipts) {
      let controls = '';
      // A send still pending here was not durably delivered (delivery is synchronous): offer the same recovery.
      if (receipt.state === 'failed' || receipt.state === 'pending') {
        if (receipt.restore) controls += link('review-restored', copy.reviewAndSendLabel(), { 'message-op': receipt.id });
        else if (receipt.state === 'pending' || receipt.retry) controls += link('retry', jt('chat.messages.strip.retry', 'Retry'), { 'message-op': receipt.id });
        controls += link('cancel', receipt.report ? copy.reportDiscardLabel() : jt('chat.messages.strip.cancelSend', 'Cancel send'), { 'message-op': receipt.id });
      }
      html += `<div class="composer-message-strip__receipt" data-message-op="${escapeHtml(receipt.id)}">`
        + `<div class="composer-message-strip__sent">${escapeHtml(sentLine(receipt))}</div>`
        + `${statusLine(receipt.tone, receipt.word, receipt.detail, controls)}</div>`;
    }
    return html;
  }

  function mountComposerMessageStrip(options) {
    const o = options || {};
    const host = o.host;
    const getSessionId = o.getSessionId;
    if (!host || typeof getSessionId !== 'function') return null;
    if (o.signal && o.signal.aborted) return null;
    const store = o.store || (storeModule && storeModule.getDefaultStore());
    const actionButton = o.actionButton || globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
    if (!store || !actionButton || !store.isAvailable()) return null;
    const doc = host.ownerDocument;
    const win = o.windowRef || (doc && doc.defaultView) || globalThis;
    const log = typeof o.appendClientLog === 'function' ? o.appendClientLog : () => {};
    const announcer = () => o.announcer || (win && win.rendererLiveAnnouncerInstance) || null;
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const openReview = typeof o.openReview === 'function' ? o.openReview : (request) => {
      const review = win && win.rendererChatMessagesReview;
      const controller = review && review.getDefaultReview ? review.getDefaultReview() : null;
      return controller ? controller.open(request) : false;
    };

    // "Review and send" for a send parked by an archive restore: the exact-body confirm dialog.
    const openRestore = typeof o.openRestore === 'function' ? o.openRestore : (request) => {
      const review = win && win.rendererChatMessagesReview;
      const controller = review && review.getDefaultRestoreConfirm ? review.getDefaultRestoreConfirm() : null;
      return controller ? controller.open(request) : false;
    };

    let disposed = false;
    let sessionId = '';
    let release = null;
    let lastHtml = null;
    let primed = false; // the first render of a session announces nothing
    let previousStates = new Map();
    let previousBacklog = '';
    let lastMarkKey = '';
    const marking = new Set(); // chats with a markRead in flight; keyed so a session switch never skips the new chat
    const disposers = [];

    function announce(message, key) {
      const channel = announcer();
      if (message && channel && typeof channel.announce === 'function') channel.announce(message, { key });
    }

    function announceChanges(view) {
      const states = new Map(view.receipts.map((receipt) => [receipt.id, receipt]));
      const backlogText = view.backlog ? [view.backlog.word, view.backlog.detail].filter(Boolean).join('. ') : '';
      if (primed) {
        for (const [id, receipt] of states) {
          const before = previousStates.get(id);
          if (before && before.state !== receipt.state) {
            announce([sentLine(receipt), receipt.word, receipt.detail].filter(Boolean).join('. '), `chat-message-op:${id}`);
          }
        }
        if (backlogText && backlogText !== previousBacklog) announce(backlogText, `chat-message-backlog:${sessionId}`);
      }
      previousStates = states;
      previousBacklog = backlogText;
      primed = true;
    }

    function render() {
      if (disposed) return;
      const view = buildStripView(sessionId ? store.lookup(sessionId) : null, now());
      const html = stripMarkup(view, { actionButton });
      announceChanges(view);
      if (html === lastHtml) return;
      lastHtml = html;
      const active = doc.activeElement;
      const focused = active && host.contains(active)
        ? { action: active.getAttribute('data-message-strip-action'), op: active.getAttribute('data-message-op') }
        : null;
      host.innerHTML = html;
      host.classList.toggle('hidden', !html);
      if (focused && focused.action) {
        const again = Array.from(host.querySelectorAll('[data-message-strip-action]')).find((node) => node.getAttribute('data-message-strip-action') === focused.action
          && (node.getAttribute('data-message-op') || null) === focused.op);
        if (again) again.focus();
      }
    }

    function maybeMarkRead() {
      if (disposed || !sessionId || marking.has(sessionId)) return;
      if (doc.visibilityState === 'hidden' || (typeof doc.hasFocus === 'function' && !doc.hasFocus())) return;
      const ids = store.lookup(sessionId).inbox
        .filter((item) => copy.isObject(item) && item.read_at == null && copy.isObject(item.envelope) && typeof item.envelope.message_id === 'string'
          && !(copy.isObject(item.context) && item.context.state === 'discarded'))
        .map((item) => item.envelope.message_id);
      if (!ids.length) { lastMarkKey = ''; return; }
      const key = `${sessionId}:${ids.join(',')}`;
      if (key === lastMarkKey) return; // already tried this exact set; a focus/visibility event retries
      lastMarkKey = key;
      const target = sessionId;
      marking.add(target);
      Promise.resolve(store.markRead(target, ids)).catch((error) => {
        log('WARN', 'chat_messages.mark_read_failed', { message: String((error && error.message) || error || '').slice(0, 120) });
      }).finally(() => { marking.delete(target); if (!disposed && sessionId === target) maybeMarkRead(); });
    }

    function syncSession() {
      if (disposed) return false;
      const next = String(getSessionId() || '').trim();
      if (next === sessionId) return false;
      if (release) { release(); release = null; }
      sessionId = next;
      lastHtml = null;
      primed = false;
      previousStates = new Map();
      previousBacklog = '';
      lastMarkKey = '';
      if (sessionId) release = store.watch(sessionId);
      render();
      maybeMarkRead();
      return true;
    }

    function listen(target, type, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler);
      disposers.push(() => target.removeEventListener(type, handler));
    }

    listen(host, 'click', (event) => {
      const target = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-message-strip-action]') : null;
      if (!target || !host.contains(target)) return;
      const action = target.getAttribute('data-message-strip-action');
      const op = target.getAttribute('data-message-op') || '';
      if (action === 'review') openReview({ sessionId, trigger: target });
      else if (action === 'review-restored' && op) openRestore({ sessionId, operationId: op, trigger: target, store });
      else if (action === 'retry' && op) void store.retry(sessionId, op);
      else if (action === 'cancel' && op) void store.cancel(sessionId, op);
    });
    listen(win, 'jenny:focused-chat-changed', syncSession);
    if (o.pane) listen(o.pane, 'composer-state-rendered', syncSession);
    if (o.chatTimeline) listen(o.chatTimeline, 'transcript-view-rendered', syncSession);
    const refocus = () => { lastMarkKey = ''; maybeMarkRead(); };
    listen(win, 'focus', refocus);
    listen(doc, 'visibilitychange', refocus);
    disposers.push(store.subscribe((event) => {
      if (event.sessionId !== sessionId) return;
      render();
      maybeMarkRead();
    }));

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (release) release();
      release = null;
      while (disposers.length) {
        const undo = disposers.pop();
        try { undo(); } catch (_error) { /* best-effort teardown */ }
      }
      host.innerHTML = '';
      host.classList.add('hidden');
    }
    if (o.signal && typeof o.signal.addEventListener === 'function') {
      o.signal.addEventListener('abort', dispose, { once: true });
      disposers.push(() => o.signal.removeEventListener('abort', dispose));
    }

    syncSession();
    return { dispose, syncSession, render, host };
  }

  return { mountComposerMessageStrip, buildStripView, stripMarkup };
});
