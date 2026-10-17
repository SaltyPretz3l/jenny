(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-messages-copy'), require('./renderer-chat-messages-dialog'));
    return;
  }
  root.rendererChatSendModal = factory(root.rendererChatMessagesCopy, root.rendererChatMessagesDialog);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (copy, dialogs) {
  'use strict';

  // "Send to chat" (row 59 checkpoint 4): a recipient picker over every project's chats and the
  // exact text that will be delivered, in an inv-step-modal. Send is prepare then send; a
  // recipient or text edit after prepare cancels the old operation and prepares again under a
  // new gesture id, so what the person sees is always what one operation carries.
  // cp5b-2: after a successful send the person may also allow messages in this direction for seven
  // days (an opt-in with a required purpose, created through createGrant); a recipient that already
  // has such a grant shows it, with Revoke.

  const { jt, jtn, escapeHtml } = copy;
  const MODAL_ID = 'chat-send-to-chat';
  const SCHEMA_VERSION = 1;
  const SEARCH_DEBOUNCE_MS = 200;
  const PAGE_LIMIT = 50;

  function newUuid() {
    const cryptoRef = globalThis.crypto;
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
    const hex = () => Math.floor(Math.random() * 16).toString(16);
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => (c === 'x' ? hex() : ((Math.random() * 4) | 8).toString(16)));
  }

  function createChatSendModal(deps) {
    const d = deps || {};
    const documentRef = d.documentRef || (typeof document !== 'undefined' ? document : null);
    const actionButton = d.actionButton || (globalThis.inventoryActionButton) || (typeof require === 'function' ? require('../inventory/action-button') : null);
    const textField = d.textField || (globalThis.inventoryTextField) || (typeof require === 'function' ? require('../inventory/text-field') : null);
    const checkboxModule = d.checkbox || (globalThis.inventoryCheckbox) || (typeof require === 'function' ? require('../inventory/checkbox') : null);
    const checkbox = checkboxModule && typeof checkboxModule.checkbox === 'function' ? checkboxModule.checkbox : null;
    const getBridge = typeof d.getBridge === 'function' ? d.getBridge : () => {
      const shell = globalThis.window ? globalThis.window.jennyShell : globalThis.jennyShell;
      return (shell && shell.chatMessages) || null;
    };
    const setTimer = typeof d.setTimeout === 'function' ? d.setTimeout : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof d.clearTimeout === 'function' ? d.clearTimeout : (handle) => clearTimeout(handle);
    const makeUuid = typeof d.randomUUID === 'function' ? d.randomUUID : newUuid;
    const log = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const announce = (message, key) => {
      const channel = d.announcer || (globalThis.window && globalThis.window.rendererLiveAnnouncerInstance) || null;
      if (channel && typeof channel.announce === 'function') channel.announce(message, { key });
    };
    let session = null; // the open dialog's state; null when closed
    let grantStore = d.store || null;

    // Grants go through the messages store so a click is one call with one fresh gesture id.
    function getGrantStore() {
      if (!grantStore) {
        const storeModule = globalThis.rendererChatMessagesStore || (typeof require === 'function' ? require('./renderer-chat-messages-store') : null);
        if (storeModule && typeof storeModule.createChatMessagesStore === 'function') {
          grantStore = storeModule.createChatMessagesStore({ getBridge, randomUUID: makeUuid, appendClientLog: log });
        }
      }
      return grantStore;
    }

    function bridgeReady(bridge) {
      return Boolean(bridge && typeof bridge.listRecipients === 'function' && typeof bridge.prepare === 'function' && typeof bridge.send === 'function');
    }

    const grantBridgeReady = (bridge) => Boolean(bridge && typeof bridge.createGrant === 'function' && typeof bridge.revokeGrant === 'function');
    const selectedItem = (s) => s.recipients.find((entry) => entry.session_id === s.selectedId) || null;

    /** The calling chat's live grant toward the picked recipient (from listRecipients), or null. */
    function existingGrant(s) {
      const item = selectedItem(s);
      const grant = item && item.grant;
      return copy.isObject(grant) && typeof grant.grant_id === 'string' && grant.grant_id ? grant : null;
    }

    const purposeBytes = (s) => copy.byteLength(s.grantPurpose.trim());
    const purposeTooLong = (s) => purposeBytes(s) > copy.GRANT_PURPOSE_MAX_BYTES;
    const grantInvalid = (s) => s.grantOn && !existingGrant(s) && (purposeBytes(s) < 1 || purposeTooLong(s));

    function sameProject(a, b) {
      return String(a || '') === String(b || '');
    }

    // ---- markup -------------------------------------------------------------------------
    function optionMarkup(s, item) {
      const eligible = item.eligible === true;
      const title = copy.chatTitle(item.title, true);
      const project = copy.projectName(item.project_name);
      let meta;
      if (!eligible) {
        meta = item.ineligible_reason === 'archived'
          ? jt('chat.messages.send.archivedMeta', 'archived · not available')
          : jt('chat.messages.send.unavailableMeta', 'not available');
      } else if (project && !sameProject(item.project_id, s.sourceProjectId)) {
        meta = jt('chat.messages.send.otherProject', '{project} · other project', { project });
      } else {
        meta = project;
      }
      return actionButton({
        plain: true,
        className: 'chat-send__option',
        role: 'option',
        ariaSelected: s.selectedId === item.session_id,
        disabled: !eligible,
        dataset: { 'chat-send-option': item.session_id },
        title: meta ? `${title} · ${meta}` : title, // the full name where the row truncates it
        trustedHtml: `<span class="chat-send__option-title">${escapeHtml(title)}</span>`
          + `<span class="chat-send__option-meta">${escapeHtml(meta)}</span>`,
      });
    }

    function listMarkup(s) {
      if (s.loading && !s.recipients.length) return `<p class="chat-send__note">${escapeHtml(jt('chat.messages.send.loading', 'Loading chats…'))}</p>`;
      if (s.listError && !s.recipients.length) {
        return `<p class="chat-send__note">${escapeHtml(jt('chat.messages.send.loadFailed', "Couldn't load your chats."))}</p>`
          + actionButton({ plain: true, className: 'chat-send__link', label: jt('chat.messages.send.tryAgain', 'Try again'), dataset: { 'chat-send-action': 'reload' } });
      }
      if (!s.recipients.length) {
        const text = s.query ? jt('chat.messages.send.noMatches', 'No chats match your search.') : jt('chat.messages.send.noChats', 'No other chats to send to.');
        return `<p class="chat-send__note">${escapeHtml(text)}</p>`;
      }
      return s.recipients.map((item) => optionMarkup(s, item)).join('');
    }

    function purposeHintText(s) {
      return purposeTooLong(s)
        ? jt('chat.messages.grant.purposeTooLong', 'This purpose is too long. The limit is 512 bytes.')
        : jt('chat.messages.grant.purposeHint', 'Required. It tells Jenny what these messages are for; it does not limit topics.');
    }

    function grantMarkup(s) {
      const item = selectedItem(s);
      if (!item || !checkbox || !grantBridgeReady(getBridge())) return '';
      const grant = existingGrant(s);
      if (grant) {
        const left = Number.isSafeInteger(grant.remaining_sends) && grant.remaining_sends >= 0 ? grant.remaining_sends : null;
        const expiry = copy.formatGrantExpiry(grant.expires_at);
        const detail = [
          expiry ? jt('chat.messages.grant.until', 'Until {when}', { when: expiry }) : '',
          left === null ? '' : jtn('chat.messages.grant.sendsLeft', left, { count: left }, '{count} send left', '{count} sends left'),
        ].filter(Boolean).join(' \u00b7 ');
        const purpose = copy.clip(grant.purpose, 512);
        const title = copy.chatTitle(item.title, true);
        return `<p class="chat-send__grant-title">${escapeHtml(jt('chat.messages.grant.active', 'Messages from this chat to "{title}" are allowed', { title }))}</p>`
          + (detail ? `<p class="chat-send__grant-detail">${escapeHtml(detail)}</p>` : '')
          + (purpose ? `<p class="chat-send__grant-purpose">${escapeHtml(jt('chat.messages.grant.purposeShown', 'Purpose: {purpose}', { purpose }))}</p>` : '')
          + actionButton({
            plain: true,
            className: 'chat-send__link',
            label: jt('chat.messages.grant.revoke', 'Revoke'),
            ariaLabel: jt('chat.messages.grant.revokeAria', 'Revoke messages to "{title}"', { title }),
            disabled: s.revoking,
            dataset: { 'chat-send-action': 'revoke-grant' },
          });
      }
      return checkbox({
        id: 'chat-send-grant-on',
        label: jt('chat.messages.grant.optIn', 'Allow messages in this direction for seven days'),
        checked: s.grantOn,
        disabled: s.sending,
        dataset: { 'chat-send-grant-toggle': 'true' },
      })
        + (s.grantOn
          ? textField({
            id: 'chat-send-grant-purpose',
            label: jt('chat.messages.grant.purposeLabel', 'Purpose'),
            value: s.grantPurpose,
            dataset: { 'chat-send-grant-purpose': 'true' },
          })
            + `<p class="chat-send__grant-hint" data-chat-send-grant-hint${purposeTooLong(s) ? ' data-invalid="true"' : ''}>${escapeHtml(purposeHintText(s))}</p>`
          : '');
    }

    function bodyMarkup(s) {
      return `<div class="chat-send">`
        + `<div class="chat-send__label">${escapeHtml(jt('chat.messages.send.to', 'To'))}</div>`
        + textField({
          id: 'chat-send-search',
          ariaLabel: jt('chat.messages.send.searchLabel', 'Search chats in every project'),
          placeholder: jt('chat.messages.send.searchPlaceholder', 'Search chats in every project'),
          dataset: { 'chat-send-search': 'true' },
          spellcheck: false,
        })
        + `<div class="chat-send__list" role="listbox" aria-label="${escapeHtml(jt('chat.messages.send.listLabel', 'Chats'))}" data-chat-send-list>${listMarkup(s)}</div>`
        + `<div class="chat-send__more" data-chat-send-more></div>`
        + textField({
          id: 'chat-send-body',
          label: jt('chat.messages.send.messageLabel', 'Message (sent exactly as shown)'),
          multiline: true,
          rows: 4,
          value: s.body,
          dataset: { 'chat-send-body': 'true' },
        })
        + `<div class="chat-send__grant" data-chat-send-grant>${grantMarkup(s)}</div>`
        + `<p class="chat-send__error" data-chat-send-error hidden></p>`
        + `</div>`;
    }

    // ---- view patches ---------------------------------------------------------------------
    function $(s, selector) {
      return s.mountRoot ? s.mountRoot.querySelector(selector) : null;
    }

    function paintList(s) {
      const list = $(s, '[data-chat-send-list]');
      if (list) list.innerHTML = listMarkup(s);
      const more = $(s, '[data-chat-send-more]');
      if (more) {
        more.innerHTML = s.nextCursor
          ? actionButton({ plain: true, className: 'chat-send__link', label: jt('chat.messages.send.showMore', 'Show more chats'), disabled: s.loading, dataset: { 'chat-send-action': 'more' } })
          : '';
      }
    }

    function bodyTooLong(s) {
      return copy.byteLength(s.body) > copy.MAX_BODY_BYTES;
    }

    function canSend(s) {
      return !s.sending && Boolean(s.selectedId) && s.body.trim().length > 0 && !bodyTooLong(s) && !grantInvalid(s);
    }

    function paintSend(s) {
      const send = $(s, '[data-step-modal-action="send"]');
      if (!send) return;
      send.disabled = !canSend(s);
      send.textContent = s.sending ? jt('chat.messages.send.sending', 'Sending…') : jt('chat.messages.send.send', 'Send');
      const cancel = $(s, '[data-step-modal-action="cancel"]');
      if (cancel) cancel.disabled = false;
    }

    function paintGrant(s) {
      const slot = $(s, '[data-chat-send-grant]');
      if (slot) slot.innerHTML = grantMarkup(s);
      paintSend(s);
    }

    function showError(s, text) {
      s.error = text || '';
      const node = $(s, '[data-chat-send-error]');
      if (node) {
        node.textContent = s.error;
        node.hidden = !s.error;
      }
      if (s.error) announce(s.error, 'chat-send-error');
    }

    // ---- recipients -----------------------------------------------------------------------
    async function loadRecipients(s, { append, quiet }) {
      const bridge = getBridge();
      if (!bridgeReady(bridge)) { s.listError = true; s.loading = false; paintList(s); return; }
      const token = ++s.searchToken;
      s.loading = true;
      s.listError = false;
      if (!append && !quiet) { s.recipients = []; s.nextCursor = ''; }
      paintList(s);
      let response = null;
      try {
        const request = { schema_version: SCHEMA_VERSION, source_session_id: s.sourceId, limit: PAGE_LIMIT };
        if (s.query) request.query = s.query;
        if (append && s.nextCursor) request.cursor = s.nextCursor;
        response = await bridge.listRecipients(request);
      } catch (error) {
        log('WARN', 'chat_send.recipients_failed', { message: String((error && error.message) || error || '').slice(0, 120) });
      }
      if (session !== s || token !== s.searchToken) return;
      s.loading = false;
      if (copy.isObject(response) && response.ok === true && Array.isArray(response.items)) {
        const items = response.items.filter((item) => copy.isObject(item) && typeof item.session_id === 'string' && item.session_id);
        s.recipients = append ? s.recipients.concat(items) : items;
        s.nextCursor = typeof response.next_cursor === 'string' ? response.next_cursor : '';
      } else {
        s.listError = true;
        s.nextCursor = '';
      }
      paintList(s);
      paintGrant(s);
    }

    function selectRecipient(s, id) {
      const item = s.recipients.find((entry) => entry.session_id === id);
      if (!item || item.eligible !== true || s.sending) return;
      if (s.selectedId !== id) discardPrepared(s);
      if (s.selectedId !== id) { s.grantOn = false; s.grantPurpose = ''; } // consent is per direction
      s.selectedId = id;
      s.selectedTitle = copy.chatTitle(item.title, true);
      showError(s, '');
      paintList(s);
      paintGrant(s);
      const picked = Array.from(s.mountRoot.querySelectorAll('[data-chat-send-option]')).find((node) => node.getAttribute('data-chat-send-option') === id);
      if (picked) picked.focus();
    }

    function moveOptionFocus(s, current, step) {
      const options = Array.from(s.mountRoot.querySelectorAll('[data-chat-send-option]:not([disabled])'));
      if (!options.length) return;
      const index = options.indexOf(current);
      const next = options[Math.max(0, Math.min(options.length - 1, (index < 0 ? 0 : index + step)))];
      if (next) next.focus();
    }

    // ---- prepared operation ---------------------------------------------------------------
    function discardPrepared(s) {
      const stale = s.prepared;
      s.prepared = null;
      s.gestureId = '';
      const bridge = getBridge();
      if (stale && bridge && typeof bridge.cancel === 'function') {
        // Best effort: an unreachable cancel only leaves a prepared op that expires on its own.
        Promise.resolve().then(() => bridge.cancel({ schema_version: SCHEMA_VERSION, operation_id: stale.operationId })).catch(() => {});
      }
    }

    // Creates the opted-in direction grant after the send went through. A failure never undoes the
    // send: the person is told the message went and the permission did not.
    async function createDirectionGrant(s) {
      const store = getGrantStore();
      if (!store) return { ok: false, text: copy.actionFailureText({ reason: 'unavailable' }) };
      const response = await store.createGrant(s.sourceId, s.selectedId, s.grantPurpose.trim());
      return copy.isObject(response) && response.ok === true ? { ok: true } : { ok: false, text: copy.actionFailureText(response) };
    }

    function finish(s, operation, title, grantOutcome) {
      const delivered = operation && operation.state === 'delivered';
      const allowed = Boolean(grantOutcome && grantOutcome.ok);
      const message = delivered
        ? (allowed ? jt('chat.messages.grant.sentAllowedToast', 'Sent to "{title}". Messages in this direction are allowed for seven days.', { title }) : jt('chat.messages.send.sentToast', 'Sent to "{title}"', { title }))
        : (allowed ? jt('chat.messages.grant.sendingAllowedToast', 'Sending to "{title}"… Messages in this direction are allowed for seven days.', { title }) : jt('chat.messages.send.sendingToast', 'Sending to "{title}"…', { title }));
      close();
      const dedupeKey = `chat-messages:sent:${(operation && operation.operation_id) || s.sourceId}`;
      const failedGrant = grantOutcome && !grantOutcome.ok
        ? jt('chat.messages.grant.failedToast', "Sent, but couldn't allow messages in this direction. {reason}", { reason: grantOutcome.text }) : '';
      if (typeof d.showToast === 'function') {
        d.showToast(message, { tone: 'info', source: d.toastSource, dedupeKey });
        if (failedGrant) d.showToast(failedGrant, { tone: 'warning', source: d.toastSource, dedupeKey: `${dedupeKey}:grant` });
      } else {
        announce(message, 'chat-send-done');
        if (failedGrant) announce(failedGrant, 'chat-send-grant');
      }
    }

    async function revokeGrant(s) {
      const grant = existingGrant(s);
      const store = getGrantStore();
      if (!grant || !store || s.revoking) return;
      s.revoking = true;
      showError(s, '');
      paintGrant(s);
      const response = await store.revokeGrant(s.sourceId, grant.grant_id);
      if (session !== s) return;
      s.revoking = false;
      if (copy.isObject(response) && response.ok === true) {
        const item = selectedItem(s);
        if (item) item.grant = null; // reflect it now; the quiet reload below confirms
        announce(jt('chat.messages.grant.revoked', 'Messages in this direction are no longer allowed.'), 'chat-send-grant');
        paintGrant(s);
        await loadRecipients(s, { append: false, quiet: true });
        return;
      }
      showError(s, copy.actionFailureText(response));
      paintGrant(s);
    }

    async function submit(s) {
      if (!canSend(s)) return;
      const bridge = getBridge();
      if (!bridgeReady(bridge)) { showError(s, copy.actionFailureText({ reason: 'unavailable' })); return; }
      s.sending = true;
      showError(s, '');
      paintSend(s);
      const title = s.selectedTitle;
      try {
        if (!s.prepared) {
          if (!s.gestureId) s.gestureId = makeUuid();
          const prepared = await bridge.prepare({
            schema_version: SCHEMA_VERSION,
            source_session_id: s.sourceId,
            destination_session_id: s.selectedId,
            body: s.body,
            gesture_id: s.gestureId,
          });
          if (session !== s) {
            if (copy.isObject(prepared) && prepared.ok === true && typeof prepared.operation_id === 'string') {
              s.prepared = { operationId: prepared.operation_id, state: 'prepared' };
              discardPrepared(s); // closed while preparing: release the operation
            }
            return;
          }
          if (!copy.isObject(prepared) || prepared.ok !== true || typeof prepared.operation_id !== 'string') {
            if (copy.reasonToken(prepared) === 'idempotency_conflict') s.gestureId = '';
            showError(s, copy.actionFailureText(prepared));
            return;
          }
          s.prepared = { operationId: prepared.operation_id, state: 'prepared' };
        }
        const method = s.prepared.state === 'failed' ? 'retry' : 'send';
        const response = await bridge[method]({ schema_version: SCHEMA_VERSION, operation_id: s.prepared.operationId });
        if (session !== s) return;
        if (!copy.isObject(response) || response.ok !== true) {
          // A persistence failure keeps the state: `send` resumes a prepared or pending operation and
          // `retry` a failed one, so the next press continues the same operation without a new prepare.
          if (copy.reasonToken(response) === 'stale_operation') { s.prepared = null; s.gestureId = ''; }
          showError(s, copy.actionFailureText(response));
          return;
        }
        const operation = copy.isObject(response.operation) ? response.operation : null;
        if (operation && operation.state === 'failed') {
          s.prepared.state = 'failed';
          showError(s, jt('chat.messages.send.deliveryFailed', "Couldn't deliver · {reason}. Press Send to try again.", { reason: copy.deliveryFailureDetail(operation.last_error) }));
          return;
        }
        s.prepared.state = 'sent';
        const grantOutcome = s.grantOn && !existingGrant(s) ? await createDirectionGrant(s) : null;
        finish(s, operation, title, grantOutcome);
      } catch (error) {
        log('WARN', 'chat_send.submit_failed', { message: String((error && error.message) || error || '').slice(0, 120) });
        if (session === s) showError(s, copy.actionFailureText(null));
      } finally {
        if (session === s) {
          s.sending = false;
          paintSend(s);
        }
      }
    }

    // ---- events ---------------------------------------------------------------------------
    function onClick(s, event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const option = target.closest('[data-chat-send-option]');
      if (option) { selectRecipient(s, option.getAttribute('data-chat-send-option')); return; }
      const action = target.closest('[data-chat-send-action]');
      if (action) {
        const kind = action.getAttribute('data-chat-send-action');
        if (kind === 'reload') void loadRecipients(s, { append: false });
        else if (kind === 'more' && !s.loading) void loadRecipients(s, { append: true });
        else if (kind === 'revoke-grant') void revokeGrant(s);
        return;
      }
      const step = target.closest('[data-step-modal-action]');
      if (step) {
        const id = step.getAttribute('data-step-modal-action');
        if (id === 'send') void submit(s);
        else if (id === 'cancel') close();
        return;
      }
      if (!target.closest('.inv-step-modal') && !s.sending) close();
    }

    function onInput(s, event) {
      const target = event.target;
      if (!target || !target.hasAttribute) return;
      if (target.hasAttribute('data-chat-send-search')) {
        s.pendingQuery = String(target.value || '').trim().slice(0, 200);
        if (s.searchTimer) clearTimer(s.searchTimer);
        s.searchTimer = setTimer(() => {
          s.searchTimer = 0;
          if (session !== s || s.pendingQuery === s.query) return;
          s.query = s.pendingQuery;
          void loadRecipients(s, { append: false });
        }, SEARCH_DEBOUNCE_MS);
      } else if (target.hasAttribute('data-chat-send-grant-toggle')) {
        s.grantOn = target.checked === true;
        paintGrant(s);
        const purposeField = $(s, '[data-chat-send-grant-purpose]');
        if (s.grantOn && purposeField) purposeField.focus();
      } else if (target.hasAttribute('data-chat-send-grant-purpose')) {
        // One line: the purpose may not carry control characters (a paste's line breaks become spaces).
        s.grantPurpose = String(target.value || '').replace(/\p{Cc}+/gu, ' ');
        const hint = $(s, '[data-chat-send-grant-hint]');
        if (hint) {
          hint.textContent = purposeHintText(s);
          if (purposeTooLong(s)) hint.setAttribute('data-invalid', 'true');
          else hint.removeAttribute('data-invalid');
        }
        paintSend(s);
      } else if (target.hasAttribute('data-chat-send-body')) {
        const next = String(target.value || '');
        if (next !== s.body && s.prepared) discardPrepared(s);
        s.body = next;
        showError(s, bodyTooLong(s) ? jt('chat.messages.send.tooLong', 'This message is too long. The limit is 16 KB.') : '');
        paintSend(s);
      }
    }

    function onKeydown(s, event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const option = target.closest('[data-chat-send-option]');
      if (option && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        moveOptionFocus(s, option, event.key === 'ArrowDown' ? 1 : -1);
      } else if (target.hasAttribute && target.hasAttribute('data-chat-send-search') && event.key === 'ArrowDown') {
        event.preventDefault();
        moveOptionFocus(s, null, 0);
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && target.hasAttribute && target.hasAttribute('data-chat-send-body')) {
        event.preventDefault();
        void submit(s);
      }
    }

    // ---- lifecycle ------------------------------------------------------------------------
    function close() {
      const s = session;
      if (!s) return;
      session = null;
      if (s.searchTimer) clearTimer(s.searchTimer);
      // Closed with a prepared-but-unsent op: release it rather than leave it to expire. (A failed
      // delivery stays: the sender's strip owns its Retry and Cancel send.)
      if (s.prepared && s.prepared.state === 'prepared') discardPrepared(s);
      if (s.handle) s.handle.dispose();
    }

    /** Opens the dialog for a source chat. Returns false when messaging is unavailable here. */
    function open(options) {
      const o = options || {};
      const sourceId = String(o.sourceSessionId || '').trim();
      const bridge = getBridge();
      if (!sourceId || !bridgeReady(bridge) || !actionButton || !textField || !dialogs) return false;
      if (session) close();
      const s = {
        sourceId,
        sourceProjectId: o.sourceProjectId || '',
        query: '',
        pendingQuery: '',
        recipients: [],
        nextCursor: '',
        loading: true,
        listError: false,
        selectedId: '',
        selectedTitle: '',
        body: '',
        prepared: null,
        gestureId: '',
        grantOn: false,
        grantPurpose: '',
        revoking: false,
        sending: false,
        error: '',
        searchToken: 0,
        searchTimer: 0,
        handle: null,
        mountRoot: null,
      };
      session = s;
      const handle = dialogs.mountDialog({
        documentRef, stepModal: d.stepModal, overlayManager: d.overlayManager, appendClientLog: log,
      }, {
        id: MODAL_ID,
        modal: {
          eyebrow: jt('chat.messages.send.eyebrow', 'Send to chat'),
          title: jt('chat.messages.send.title', 'Share a note with another chat'),
          summary: jt('chat.messages.send.summary', 'Only the text below is shared. No history, files or permissions go with it, and the other chat reads it on its next turn.'),
          bodyHtml: bodyMarkup(s),
          actions: [
            { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
            { id: 'send', label: jt('chat.messages.send.send', 'Send'), variant: 'primary', disabled: true },
          ],
        },
        onRequestClose: () => { if (session === s && !s.sending) close(); },
        initialFocusSelector: '[data-chat-send-search]',
        restoreFocusTo: o.trigger || undefined,
      });
      if (!handle) { session = null; return false; }
      s.handle = handle;
      s.mountRoot = handle.mountRoot;
      handle.mountRoot.addEventListener('click', (event) => onClick(s, event));
      handle.mountRoot.addEventListener('input', (event) => onInput(s, event));
      handle.mountRoot.addEventListener('keydown', (event) => onKeydown(s, event));
      paintList(s);
      void loadRecipients(s, { append: false });
      return true;
    }

    function dispose() { close(); }

    return { open, close, dispose, isOpen: () => Boolean(session) };
  }

  let defaultModal = null;
  function getDefaultModal(deps) {
    if (!defaultModal) defaultModal = createChatSendModal(deps);
    return defaultModal;
  }

  return { createChatSendModal, getDefaultModal, MODAL_ID };
});
