(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-messages-copy'), require('./renderer-chat-messages-dialog'), require('./renderer-chat-messages-store'));
    return;
  }
  root.rendererChatMessagesReview = factory(root.rendererChatMessagesCopy, root.rendererChatMessagesDialog, root.rendererChatMessagesStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (copy, dialogs, storeModule) {
  'use strict';

  // Also home of the archive-restore confirm dialog (cp5b-3): "Review and send" for a send a trusted
  // archive restore parked. It shows the recipient, the exact full body as plain text and the short
  // envelope hash, and Send passes that hash back so a changed message can never be sent unseen.
  //
  // "Review" for a chat's inbox (row 59 checkpoint 4): every message other chats sent here,
  // attributed, with the PO state words. Delivery, unread and inclusion stay separate: reading
  // never includes a message. Queue again / Don't include / Discard call the store, which calls
  // the main process; the list repaints from the store, never from local guesses.

  const { jt, escapeHtml } = copy;
  const MODAL_ID = 'chat-messages-review';
  const PENDING_STATES = new Set(['queued', 'reserved', 'excluded_by_user']);

  function sequenceOf(item) {
    return Number.isSafeInteger(item.receive_sequence) ? item.receive_sequence : 0;
  }

  /** Pending messages first in the order the model will read them, then the settled ones, newest first. */
  function orderItems(items) {
    const list = items.filter((item) => copy.isObject(item) && copy.isObject(item.envelope) && typeof item.envelope.message_id === 'string');
    const state = (item) => (copy.isObject(item.context) ? item.context.state : '');
    const pending = list.filter((item) => PENDING_STATES.has(state(item))).sort((a, b) => sequenceOf(a) - sequenceOf(b));
    const settled = list.filter((item) => !PENDING_STATES.has(state(item))).sort((a, b) => sequenceOf(b) - sequenceOf(a));
    return pending.concat(settled);
  }

  function statusFor(item, counts) {
    const context = copy.isObject(item.context) ? item.context : {};
    switch (context.state) {
      case 'queued':
        if (counts.deferred_reason) {
          return {
            tone: 'warn',
            word: counts.deferred_reason === 'budget_unknown'
              ? jt('chat.messages.review.waitingUnknown', 'Waiting · context size unknown')
              : jt('chat.messages.review.waiting', 'Waiting · context is full'),
            detail: '',
            actions: ['exclude'],
          };
        }
        return { tone: 'muted', word: jt('chat.messages.review.queued', 'Queued for the next turn'), detail: '', actions: ['exclude'] };
      case 'reserved':
        return { tone: 'pending', word: jt('chat.messages.review.reserved', 'Being included in the current turn'), detail: '', actions: [] };
      case 'included':
        return { tone: 'ok', word: jt('chat.messages.review.included', 'Included in the turn at {time}', { time: copy.formatTime(context.included_at) }), detail: '', actions: [] };
      case 'excluded_by_user':
        return { tone: 'muted', word: jt('chat.messages.review.excluded', 'Not included · you excluded it'), detail: '', actions: ['queue', 'discard'] };
      case 'discarded':
        return { tone: 'muted', word: jt('chat.messages.review.discarded', 'Discarded · never shown to the model'), detail: '', actions: [] };
      default:
        return { tone: 'muted', word: jt('chat.messages.review.unknown', 'Unavailable'), detail: '', actions: [] };
    }
  }

  function dotClass(tone) {
    return { ok: 'status-dot--ok', warn: 'status-dot--warn', error: 'status-dot--error', pending: 'status-dot--pending' }[tone] || 'status-dot--muted';
  }

  function itemMarkup(item, ctx) {
    const id = item.envelope.message_id;
    const source = copy.isObject(item.source) ? item.source : {};
    const title = copy.chatTitle(source.title, source.available !== false);
    const project = copy.projectName(source.project_name);
    const time = copy.formatTime(item.delivered_at || item.envelope.created_at);
    const status = statusFor(item, ctx.counts);
    const busy = ctx.store.isBusy(`msg:${id}`);
    const isReport = copy.isReportEnvelope(item.envelope);
    const fromLabel = isReport ? copy.reportFromLabel() : jt('chat.messages.review.from', 'From');
    const chipInner = `${escapeHtml(fromLabel)} <strong>${escapeHtml(title)}</strong>`;
    const canOpen = ctx.canOpen && source.available !== false && typeof source.session_id === 'string' && source.session_id;
    const chip = canOpen
      ? ctx.actionButton({ plain: true, className: 'chat-review__chip', dataset: { 'review-action': 'open-source', 'review-session': source.session_id }, title, trustedHtml: chipInner })
      : `<span class="chat-review__chip">${chipInner}</span>`;
    const meta = [project, time].filter(Boolean).join(' · ');
    // A child's report (cp5b-1): the outcome word beside the chip, a clipped marker under the answer, Open chat in the status line.
    const outcome = isReport ? copy.reportOutcome(item.envelope) : null;
    const outcomeMarkup = outcome && outcome.word
      ? `<span class="chat-review__outcome" data-tone="${escapeHtml(outcome.tone)}">${escapeHtml(`· ${outcome.word}`)}</span>` : '';
    const clipped = copy.isReportClipped(item.envelope)
      ? `<p class="chat-review__clipped">${escapeHtml(copy.reportClippedText())}</p>` : '';
    const openChat = isReport && canOpen
      ? ctx.actionButton({
        plain: true, className: 'chat-review__link', label: copy.reportOpenChatLabel(),
        dataset: { 'review-action': 'open-source', 'review-session': source.session_id },
      })
      : '';
    const actionLabels = {
      exclude: jt('chat.messages.review.exclude', "Don't include"),
      queue: jt('chat.messages.review.queueAgain', 'Queue again'),
      discard: jt('chat.messages.review.discard', 'Discard'),
    };
    const controls = status.actions.map((action) => ctx.actionButton({
      plain: true, className: 'chat-review__link', label: actionLabels[action], disabled: busy,
      dataset: { 'review-action': action, 'review-message': id },
    })).join('');
    return `<li class="chat-review__item" data-state="${escapeHtml(item.context && item.context.state)}" data-review-message="${escapeHtml(id)}"`
      + `${outcome ? ` data-report-outcome="${escapeHtml(outcome.outcome)}"` : ''} tabindex="-1">`
      + `<div class="chat-review__head">${chip}${outcomeMarkup}${meta ? `<span class="chat-review__meta">· ${escapeHtml(meta)}</span>` : ''}</div>`
      + `<p class="chat-review__body">${escapeHtml(item.envelope.body)}</p>${clipped}`
      + `<div class="chat-review__status" data-tone="${escapeHtml(status.tone)}"><span class="status-dot ${dotClass(status.tone)}" aria-hidden="true"></span>`
      + `<span class="chat-review__state">${escapeHtml(status.word)}</span>${openChat}${controls}</div></li>`;
  }

  function listMarkup(lookup, ctx) {
    const items = orderItems(lookup.inbox);
    if (lookup.status === 'checking') return `<p class="chat-review__note">${escapeHtml(jt('chat.messages.review.loading', 'Loading messages…'))}</p>`;
    if (!items.length) {
      return `<p class="chat-review__note">${escapeHtml(lookup.status === 'unavailable'
        ? jt('chat.messages.review.unavailable', "Can't read messages right now.")
        : jt('chat.messages.review.empty', 'No messages from other chats.'))}</p>`;
    }
    const more = lookup.inboxHasMore
      ? `<p class="chat-review__note">${escapeHtml(jt('chat.messages.review.more', 'Older messages are not shown.'))}</p>` : '';
    return `<ul class="chat-review__list">${items.map((item) => itemMarkup(item, { ...ctx, counts: lookup.counts })).join('')}</ul>${more}`;
  }

  function createChatMessagesReview(deps) {
    const d = deps || {};
    const documentRef = d.documentRef || (typeof document !== 'undefined' ? document : null);
    const actionButton = d.actionButton || globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
    const store = d.store || (storeModule && storeModule.getDefaultStore());
    const log = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const openSession = typeof d.openSession === 'function' ? d.openSession : null;
    const announce = (message, key) => {
      const channel = d.announcer || (globalThis.window && globalThis.window.rendererLiveAnnouncerInstance) || null;
      if (channel && typeof channel.announce === 'function') channel.announce(message, { key });
    };
    let session = null;

    function paint(s) {
      const host = s.mountRoot && s.mountRoot.querySelector('[data-chat-review-body]');
      if (!host) return;
      const lookup = store.lookup(s.sessionId);
      const active = documentRef.activeElement;
      const focusedRow = active && host.contains(active) ? active.closest('li[data-review-message]') : null;
      const focus = focusedRow ? { action: active.getAttribute('data-review-action'), message: focusedRow.getAttribute('data-review-message') } : null;
      const notice = s.notice ? `<p class="chat-review__notice" data-tone="error">${escapeHtml(s.notice)}</p>` : '';
      host.innerHTML = notice + listMarkup(lookup, { store, actionButton, canOpen: Boolean(openSession) });
      if (!focus) return;
      const li = Array.from(host.querySelectorAll('li[data-review-message]')).find((node) => node.getAttribute('data-review-message') === focus.message);
      if (!li) return;
      const same = Array.from(li.querySelectorAll('[data-review-action]:not([disabled])')).find((node) => node.getAttribute('data-review-action') === focus.action);
      (same || li.querySelector('[data-review-action]:not([disabled])') || li).focus();
    }

    const ACTION_RESULTS = {
      exclude: ['excluded_by_user', () => jt('chat.messages.review.announceExcluded', 'Message left out of the next turn')],
      queue: ['queued', () => jt('chat.messages.review.announceQueued', 'Message queued for the next turn')],
    };

    async function runAction(s, action, messageId) {
      let response;
      if (action === 'discard') response = await store.discard(s.sessionId, messageId);
      else if (ACTION_RESULTS[action]) response = await store.setDisposition(s.sessionId, messageId, ACTION_RESULTS[action][0]);
      else return;
      if (session !== s) return;
      if (copy.isObject(response) && response.ok === true) {
        s.notice = '';
        announce(action === 'discard' ? jt('chat.messages.review.announceDiscarded', 'Message discarded') : ACTION_RESULTS[action][1](), `chat-review:${messageId}`);
      } else {
        // The reserved/included/active-turn refusals arrive as busy or its alias stale_operation.
        const token = copy.reasonToken(response);
        s.notice = copy.actionFailureText(token === 'stale_operation' ? { reason: 'busy' } : response);
        announce(s.notice, `chat-review:${messageId}`);
      }
      paint(s);
    }

    function onClick(s, event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const control = target.closest('[data-review-action]');
      if (control) {
        const action = control.getAttribute('data-review-action');
        if (action === 'open-source') {
          const sessionId = control.getAttribute('data-review-session');
          if (openSession && sessionId) { close(); openSession(sessionId); }
        } else {
          void runAction(s, action, control.getAttribute('data-review-message'));
        }
        return;
      }
      const step = target.closest('[data-step-modal-action]');
      if (step && step.getAttribute('data-step-modal-action') === 'close') { close(); return; }
      if (!target.closest('.inv-step-modal')) close();
    }

    function close() {
      const s = session;
      if (!s) return;
      session = null;
      if (s.unsubscribe) s.unsubscribe();
      if (s.release) s.release();
      if (s.handle) s.handle.dispose();
    }

    function open(options) {
      const o = options || {};
      const sessionId = String(o.sessionId || '').trim();
      if (!sessionId || !store || !store.isAvailable() || !actionButton || !dialogs) return false;
      if (session) close();
      const s = { sessionId, notice: '', handle: null, mountRoot: null, release: null, unsubscribe: null };
      session = s;
      const handle = dialogs.mountDialog({ documentRef, stepModal: d.stepModal, overlayManager: d.overlayManager, appendClientLog: log }, {
        id: MODAL_ID,
        modal: {
          eyebrow: jt('chat.messages.review.eyebrow', 'Messages'),
          title: jt('chat.messages.review.title', 'Messages from other chats'),
          summary: jt('chat.messages.review.summary', "Queued messages go to the model on this chat's next turn. Leave one out to keep it from the model, or discard it for good."),
          bodyHtml: '<div class="chat-review" data-chat-review-body></div>',
          actions: [{ id: 'close', label: jt('common.close', 'Close'), variant: 'primary' }],
        },
        onRequestClose: close,
        initialFocusSelector: '[data-review-action]:not([disabled]), [data-step-modal-action="close"]',
        restoreFocusTo: o.trigger || undefined,
      });
      if (!handle) { session = null; return false; }
      s.handle = handle;
      s.mountRoot = handle.mountRoot;
      handle.mountRoot.addEventListener('click', (event) => onClick(s, event));
      s.release = store.watch(sessionId);
      s.unsubscribe = store.subscribe((event) => { if (session === s && event.sessionId === sessionId) paint(s); });
      paint(s);
      return true;
    }

    return { open, close, dispose: close, isOpen: () => Boolean(session) };
  }

  // ---- archive-restore confirmation -----------------------------------------------------------
  const RESTORE_MODAL_ID = 'chat-messages-restore';

  function restoreBodyMarkup(s) {
    const project = copy.projectName(s.project);
    const hash = copy.shortHash(s.sha);
    return '<div class="chat-restore" data-chat-restore-body>'
      + `<p class="chat-restore__to"><span class="chat-restore__label">${escapeHtml(jt('chat.messages.restore.to', 'To'))}</span> `
      + `<strong data-chat-restore-title>${escapeHtml(s.title)}</strong>${project ? ` <span class="chat-restore__meta">· ${escapeHtml(project)}</span>` : ''}</p>`
      + `<p class="chat-restore__label">${escapeHtml(jt('chat.messages.restore.messageLabel', 'Message (sent exactly as shown)'))}</p>`
      + `<div class="chat-restore__text" role="region" tabindex="0" aria-label="${escapeHtml(jt('chat.messages.restore.textAria', 'Message text'))}" data-chat-restore-text></div>`
      + `<p class="chat-restore__hash">${escapeHtml(jt('chat.messages.restore.hashLabel', 'Check code'))} <code data-chat-restore-hash>${escapeHtml(hash)}</code></p>`
      + '<p class="chat-restore__error" role="alert" data-chat-restore-error hidden></p>'
      + '</div>';
  }

  function createRestoreConfirm(deps) {
    const d = deps || {};
    const documentRef = d.documentRef || (typeof document !== 'undefined' ? document : null);
    const defaultStore = () => (d.store || (storeModule && storeModule.getDefaultStore()));
    const log = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const announce = (message, key) => {
      const channel = d.announcer || (globalThis.window && globalThis.window.rendererLiveAnnouncerInstance) || null;
      if (channel && typeof channel.announce === 'function') channel.announce(message, { key });
    };
    let session = null;

    function $(s, selector) {
      return s.mountRoot ? s.mountRoot.querySelector(selector) : null;
    }

    function paintSend(s) {
      const send = $(s, '[data-step-modal-action="send"]');
      if (!send) return;
      send.disabled = s.sending;
      send.textContent = s.sending ? jt('chat.messages.send.sending', 'Sending…') : jt('chat.messages.send.send', 'Send');
    }

    function showError(s, text) {
      s.error = text || '';
      const node = $(s, '[data-chat-restore-error]');
      if (node) {
        node.textContent = s.error;
        node.hidden = !s.error;
      }
      if (s.error) announce(s.error, 'chat-restore-error');
    }

    function close() {
      const s = session;
      if (!s) return;
      session = null;
      if (s.unsubscribe) s.unsubscribe();
      if (s.release) s.release();
      if (s.handle) s.handle.dispose();
    }

    function tell(s, message, tone) {
      if (typeof d.showToast === 'function') d.showToast(message, { tone, source: d.toastSource, dedupeKey: `chat-messages:restore:${s.operationId}` });
      else announce(message, 'chat-restore-done');
    }

    function finish(s, response) {
      const operation = copy.isObject(response.operation) ? response.operation : null;
      const state = operation ? operation.state : '';
      close();
      if (state === 'failed') {
        tell(s, jt('chat.messages.restore.deliveryFailed', "Couldn't deliver · {reason}. You can retry it from the message list.", { reason: copy.deliveryFailureDetail(operation.last_error) }), 'warning');
        return;
      }
      tell(s, state === 'delivered'
        ? jt('chat.messages.send.sentToast', 'Sent to "{title}"', { title: s.title })
        : jt('chat.messages.send.sendingToast', 'Sending to "{title}"…', { title: s.title }), 'info');
    }

    async function submit(s) {
      if (s.sending) return; // one click is one call; the store's busy key backs this up
      s.sending = true;
      showError(s, '');
      paintSend(s);
      let response = null;
      try {
        response = await s.store.confirmRestored(s.sessionId, s.operationId, s.sha, s.store.newGestureId());
      } catch (error) {
        log('WARN', 'chat_restore.confirm_failed', { message: String((error && error.message) || error || '').slice(0, 120) });
      }
      s.sending = false;
      if (session !== s) return;
      if (copy.isObject(response) && response.ok === true) { finish(s, response); return; }
      showError(s, copy.restoreFailureText(response));
      paintSend(s);
    }

    function onClick(s, event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const step = target.closest('[data-step-modal-action]');
      if (step) {
        const id = step.getAttribute('data-step-modal-action');
        if (id === 'send') void submit(s);
        else if (id === 'cancel') close();
        return;
      }
      if (!target.closest('.inv-step-modal') && !s.sending) close();
    }

    /** Opens the confirm dialog for one parked send (request: {sessionId, operationId, trigger, store}). */
    function open(request) {
      const o = request || {};
      const store = o.store || defaultStore();
      const sessionId = String(o.sessionId || '').trim();
      const operationId = String(o.operationId || '').trim();
      if (!sessionId || !operationId || !store || !store.isAvailable() || !dialogs) return false;
      const op = store.lookup(sessionId).outbox.find((item) => copy.isObject(item) && item.operation_id === operationId);
      const envelope = op && copy.isObject(op.envelope) ? op.envelope : null;
      if (!op || op.state !== 'failed' || op.restore_requires_confirmation !== true || !envelope || typeof envelope.body !== 'string'
        || !copy.shortHash(op.envelope_sha256)) return false;
      if (session) close();
      const destination = copy.isObject(op.destination) ? op.destination : {};
      const s = {
        sessionId, operationId, store, sha: op.envelope_sha256, body: envelope.body,
        title: copy.chatTitle(destination.title, destination.available !== false), project: destination.project_name,
        sending: false, error: '', handle: null, mountRoot: null, release: null, unsubscribe: null,
      };
      session = s;
      const handle = dialogs.mountDialog({ documentRef, stepModal: d.stepModal, overlayManager: d.overlayManager, appendClientLog: log }, {
        id: RESTORE_MODAL_ID,
        modal: {
          eyebrow: jt('chat.messages.restore.eyebrow', 'Restored message'),
          title: jt('chat.messages.restore.title', 'Send this message?'),
          summary: jt('chat.messages.restore.summary', 'This message was waiting to be sent when the backup was made. Nothing is sent until you press Send.'),
          bodyHtml: restoreBodyMarkup(s),
          actions: [
            { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
            { id: 'send', label: jt('chat.messages.send.send', 'Send'), variant: 'primary' },
          ],
        },
        onRequestClose: () => { if (session === s && !s.sending) close(); },
        initialFocusSelector: '[data-step-modal-action="send"]',
        restoreFocusTo: o.trigger || undefined,
      });
      if (!handle) { session = null; return false; }
      s.handle = handle;
      s.mountRoot = handle.mountRoot;
      const text = $(s, '[data-chat-restore-text]');
      if (text) text.textContent = s.body; // plain text only: the body is another chat's untrusted content
      handle.mountRoot.addEventListener('click', (event) => onClick(s, event));
      s.release = store.watch(sessionId);
      // The parked send left this state elsewhere (cancelled, delivered): the dialog has nothing left to confirm.
      s.unsubscribe = store.subscribe((event) => {
        if (session !== s || s.sending || event.sessionId !== sessionId) return;
        const live = store.lookup(sessionId).outbox.find((item) => copy.isObject(item) && item.operation_id === operationId);
        if (!live || live.state !== 'failed' || live.restore_requires_confirmation !== true) {
          close();
          announce(jt('chat.messages.restore.gone', 'That message is no longer waiting for your confirmation.'), 'chat-restore-gone');
        }
      });
      return true;
    }

    return { open, close, dispose: close, isOpen: () => Boolean(session) };
  }

  let defaultRestoreConfirm = null;
  function getDefaultRestoreConfirm(deps) {
    if (!defaultRestoreConfirm) defaultRestoreConfirm = createRestoreConfirm(deps);
    return defaultRestoreConfirm;
  }

  let defaultReview = null;
  function getDefaultReview(deps) {
    if (!defaultReview) defaultReview = createChatMessagesReview(deps);
    return defaultReview;
  }

  return {
    createChatMessagesReview, getDefaultReview, createRestoreConfirm, getDefaultRestoreConfirm, orderItems, statusFor, MODAL_ID, RESTORE_MODAL_ID,
  };
});
