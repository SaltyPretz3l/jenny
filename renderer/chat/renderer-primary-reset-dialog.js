(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-messages-dialog'));
    return;
  }
  root.rendererPrimaryResetDialog = factory(root.rendererChatMessagesDialog);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dialogs) {
  'use strict';

  // The Reset and Forget confirms for the one profile-wide Jenny chat (row 76). Both are danger-tone
  // step modals (the shared messages-dialog shell): Reset clears the transcript and keeps a copy under
  // exports; Forget does the same and also removes what memory took from the chat, after showing the
  // counts. A failure keeps the dialog open with a closed-phrase notice (no bridge text, no paths);
  // success closes it and hands the answer to `afterReset` so the caller can reload the transcript.

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const escapeHtml = (globalThis.stringUtils && globalThis.stringUtils.escapeHtml)
    || (typeof require === 'function' ? require('../shared/string-utils').escapeHtml : String);

  const RESET_ID = 'primary-chat-reset';
  const FORGET_ID = 'primary-chat-forget';
  const CANCELLED = Object.freeze({ ok: false, reason: 'cancelled' });

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function failureText(reason) {
    if (reason === 'session_busy') return jt('chat.primary.reset.busy', 'Jenny is replying. Wait for it to finish, then try again.');
    if (reason === 'copy_failed') return jt('chat.primary.reset.copyFailed', 'The copy could not be written, so nothing was cleared.');
    return jt('chat.primary.reset.failed', 'The reset did not run. Try again.');
  }

  function resetBody() {
    return '<div class="primary-reset" data-primary-reset-body><p class="primary-reset__message">'
      + escapeHtml(jt('chat.primary.reset.message', 'Its transcript is cleared and waiting messages from other chats are discarded. The row, its permissions and message grants stay. A copy of the transcript is saved under exports in your profile folder.'))
      + '</p></div>';
  }

  function loadingBody() {
    return `<div class="primary-reset" data-primary-reset-body><p class="primary-reset__message">${escapeHtml(jt('common.loading', 'Loading…'))}</p></div>`;
  }

  function forgetBody(preview, checkbox) {
    const known = preview && preview.ok === true;
    const memories = known ? count(preview.memories) : 0;
    const pending = known ? count(preview.pending) : 0;
    const counts = known
      ? `<li>${escapeHtml(jtn('chat.primary.forget.memories', memories, { count: memories }, '{count} memory (recoverable from the Forgotten list)', '{count} memories (recoverable from the Forgotten list)'))}</li>`
        + `<li>${escapeHtml(jtn('chat.primary.forget.pending', pending, { count: pending }, '{count} pending memory suggestion', '{count} pending memory suggestions'))}</li>`
      : `<li>${escapeHtml(jt('chat.primary.forget.unknownCounts', 'its memories and pending suggestions'))}</li>`;
    const optOut = checkbox({
      id: 'primary-forget-opt-out',
      label: jt('chat.primary.forget.optOut', 'Also stop taking notes from the Jenny chat'),
      dataset: { 'primary-forget-opt-out': '1' },
    });
    return '<div class="primary-reset" data-primary-reset-body>'
      + `<p class="primary-reset__message">${escapeHtml(jt('chat.primary.forget.message', 'Resets the Jenny chat and removes what memory took from it:'))}</p>`
      + `<ul class="primary-reset__list">${counts}<li>${escapeHtml(jt('chat.primary.forget.index', 'Its chat search index'))}</li></ul>`
      + `<div class="primary-reset__opt">${optOut}</div></div>`;
  }

  function createPrimaryResetDialog(deps) {
    const d = deps || {};
    const documentRef = d.documentRef || (typeof document !== 'undefined' ? document : null);
    const log = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const getBridge = typeof d.getBridge === 'function' ? d.getBridge : () => null;
    const checkboxSource = d.checkbox || globalThis.inventoryCheckbox || (typeof require === 'function' ? require('../inventory/checkbox') : null);
    const checkbox = typeof checkboxSource === 'function' ? checkboxSource : (checkboxSource && checkboxSource.checkbox);
    let session = null;

    function bridge() {
      try { return getBridge() || null; } catch (_error) { return null; }
    }

    function finish(s, outcome) {
      if (session !== s) return;
      session = null;
      if (s.handle) s.handle.dispose();
      s.resolve(outcome);
    }

    function setBusy(s, busy) {
      s.busy = busy;
      const root = s.handle && s.handle.mountRoot;
      if (!root) return;
      root.querySelectorAll('[data-step-modal-action]').forEach((button) => {
        const locked = busy || (s.loading && button.getAttribute('data-step-modal-action') === 'confirm');
        button.disabled = locked;
      });
    }

    function showNotice(s, text) {
      const body = s.handle.mountRoot.querySelector('[data-primary-reset-body]');
      if (!body) return;
      const old = body.querySelector('.primary-reset__notice');
      if (old) old.remove();
      const notice = documentRef.createElement('p');
      notice.className = 'primary-reset__notice';
      notice.setAttribute('role', 'alert');
      notice.textContent = text;
      body.appendChild(notice);
    }

    async function confirm(s) {
      if (s.busy || s.loading || session !== s) return;
      const api = bridge();
      if (!api || typeof api.reset !== 'function') { showNotice(s, failureText('unavailable')); return; }
      const request = { schema_version: 1, forget: s.forget, keep_copy: true };
      if (s.forget) {
        const box = s.handle.mountRoot.querySelector('[data-primary-forget-opt-out]');
        request.memory_opt_out = Boolean(box && box.checked);
      }
      setBusy(s, true);
      log('INFO', 'primary_chat.reset_requested', { forget: s.forget });
      let response;
      try { response = await api.reset(request); } catch (_error) { response = null; }
      if (session !== s) return;
      if (response && response.ok === true) {
        finish(s, { ok: true, result: response });
        try { if (typeof d.afterReset === 'function') d.afterReset(response); } catch (_error) { /* the caller owns its reload */ }
        return;
      }
      const reason = response && typeof response.reason === 'string' && response.reason ? response.reason : 'unavailable';
      log('WARN', 'primary_chat.reset_failed', { reason });
      setBusy(s, false);
      showNotice(s, failureText(reason));
      const again = s.handle.mountRoot.querySelector('[data-step-modal-action="confirm"]');
      if (again && typeof again.focus === 'function') again.focus();
    }

    function onClick(s, event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const step = target.closest('[data-step-modal-action]');
      if (step) {
        if (step.disabled) return;
        const action = step.getAttribute('data-step-modal-action');
        if (action === 'confirm') void confirm(s);
        else if (action === 'cancel') finish(s, CANCELLED);
        return;
      }
      if (!s.busy && !target.closest('.inv-step-modal')) finish(s, CANCELLED);
    }

    function close() {
      if (session) finish(session, CANCELLED);
    }

    function open(sessionId, trigger, forget) {
      if (!dialogs || !documentRef || !checkbox) return Promise.resolve({ ok: false, reason: 'unavailable' });
      const api = bridge();
      if (!api || typeof api.reset !== 'function') return Promise.resolve({ ok: false, reason: 'unavailable' });
      close();
      return new Promise((resolve) => {
        const s = { sessionId: String(sessionId || ''), forget, busy: false, loading: forget, handle: null, resolve };
        session = s;
        const handle = dialogs.mountDialog({ documentRef, stepModal: d.stepModal, overlayManager: d.overlayManager, appendClientLog: log }, {
          id: forget ? FORGET_ID : RESET_ID,
          modal: {
            tone: 'danger',
            title: forget ? jt('chat.primary.forget.title', 'Forget what Jenny learned here?') : jt('chat.primary.reset.title', 'Reset the Jenny chat?'),
            bodyHtml: forget ? loadingBody() : resetBody(),
            actions: [
              { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
              { id: 'confirm', label: forget ? jt('chat.primary.forget.confirm', 'Forget') : jt('chat.primary.reset.confirm', 'Reset'), variant: 'primary' },
            ],
          },
          onRequestClose: () => { if (!s.busy) finish(s, CANCELLED); },
          initialFocusSelector: '[data-step-modal-action="cancel"]',
          restoreFocusTo: trigger || undefined,
        });
        if (!handle) { session = null; resolve({ ok: false, reason: 'unavailable' }); return; }
        s.handle = handle;
        handle.mountRoot.addEventListener('click', (event) => onClick(s, event));
        if (!forget) return;
        setBusy(s, false);
        void loadPreview(s, api);
      });
    }

    async function loadPreview(s, api) {
      const preview = await Promise.resolve()
        .then(() => (typeof api.forgetPreview === 'function' ? api.forgetPreview({ schema_version: 1 }) : null))
        .catch(() => null);
      if (session !== s) return;
      const body = s.handle.mountRoot.querySelector('.inv-step-modal-body');
      if (body) body.innerHTML = forgetBody(preview, checkbox);
      s.loading = false;
      setBusy(s, false);
    }

    return {
      confirmReset: (options) => open(options && options.sessionId, options && options.trigger, false),
      confirmForget: (options) => open(options && options.sessionId, options && options.trigger, true),
      close,
      isOpen: () => Boolean(session),
    };
  }

  let defaultDialog = null;
  function getDefaultPrimaryResetDialog(deps) {
    if (!defaultDialog) defaultDialog = createPrimaryResetDialog(deps);
    return defaultDialog;
  }

  return { createPrimaryResetDialog, getDefaultPrimaryResetDialog, RESET_ID, FORGET_ID };
});
