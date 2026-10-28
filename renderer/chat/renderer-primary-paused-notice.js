(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'), null);
    return;
  }
  root.rendererPrimaryPausedNotice = factory(root.stringUtils, root.inventoryActionButton, root.rendererPrimaryChatStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, defaultActionButton, storeModule) {
  'use strict';

  // The paused notice above the primary Jenny chat's composer (row 76): one line and one
  // text action while the chat is paused. It is a sibling placed before the message strip
  // (the strip owns its own innerHTML), shown only for the primary pane and only while the
  // store says it is paused.

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d) { return d; };
  const { escapeHtml, isPrimarySessionId } = stringUtils;

  function noticeMarkup(actionButton) {
    return '<span class="status-dot status-dot--muted" aria-hidden="true"></span>'
      + '<span><span class="primary-paused-notice__why">' + escapeHtml(jt('chat.primary.pausedTitle', 'Jenny is paused.')) + '</span> '
      + escapeHtml(jt('chat.primary.pausedBody', 'Messages and reports from other chats wait until you resume.')) + '</span>'
      + actionButton({
        plain: true,
        className: 'primary-paused-notice__action',
        label: jt('chat.primary.resume', 'Resume'),
        dataset: { 'primary-paused-action': 'resume' },
      });
  }

  function mountPrimaryPausedNotice(options) {
    const o = options || {};
    const host = o.host;
    const getSessionId = o.getSessionId;
    if (!host || typeof getSessionId !== 'function' || !host.parentElement) return null;
    if (o.signal && o.signal.aborted) return null;
    const store = o.store || (storeModule && storeModule.getDefaultPrimaryChatStore && storeModule.getDefaultPrimaryChatStore());
    const actionButton = o.actionButton || globalThis.inventoryActionButton || defaultActionButton;
    if (!store || typeof store.isPaused !== 'function' || typeof actionButton !== 'function') return null;
    const doc = host.ownerDocument;
    const win = o.windowRef || (doc && doc.defaultView) || globalThis;
    const log = typeof o.appendLog === 'function' ? o.appendLog : () => {};
    const parent = host.parentElement;

    let notice = parent.querySelector('[data-primary-paused-notice]');
    const owned = !notice;
    if (owned) {
      notice = doc.createElement('div');
      notice.className = 'primary-paused-notice';
      notice.setAttribute('data-primary-paused-notice', '');
      notice.setAttribute('role', 'status');
      notice.hidden = true;
      parent.insertBefore(notice, host);
    }

    let disposed = false;
    let busy = false;
    let lastHtml = null;
    const disposers = [];

    function render() {
      if (disposed) return;
      const sessionId = String(getSessionId() || '').trim();
      const show = Boolean(sessionId) && isPrimarySessionId(o.state && o.state.sessions, sessionId) && store.isPaused(sessionId) === true;
      const html = show ? noticeMarkup(actionButton) : '';
      if (html === lastHtml) return;
      lastHtml = html;
      notice.innerHTML = html;
      notice.hidden = !show;
    }

    async function resume(button) {
      if (busy) return;
      busy = true;
      button.disabled = true;
      let result;
      try {
        result = await store.resume();
      } catch (_error) {
        result = { ok: false, reason: 'unavailable' };
      }
      busy = false;
      if (!result || result.ok !== true) log('WARN', 'primary_chat.resume_failed', { reason: (result && result.reason) || 'unavailable' });
      lastHtml = null; // repaint so a failed resume gets its button back
      render();
    }

    function listen(target, type, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler);
      disposers.push(() => target.removeEventListener(type, handler));
    }

    listen(notice, 'click', (event) => {
      const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-primary-paused-action="resume"]') : null;
      if (button && notice.contains(button)) void resume(button);
    });
    listen(win, 'jenny:focused-chat-changed', render);
    listen(o.pane, 'composer-state-rendered', render);
    listen(o.pane, 'transcript-view-rendered', render);
    if (o.chatTimeline && o.chatTimeline !== o.pane) listen(o.chatTimeline, 'transcript-view-rendered', render);
    if (typeof store.subscribe === 'function') disposers.push(store.subscribe(render));

    function dispose() {
      if (disposed) return;
      disposed = true;
      while (disposers.length) {
        const undo = disposers.pop();
        try { undo(); } catch (_error) { /* best-effort teardown */ }
      }
      if (owned && notice.parentElement) notice.parentElement.removeChild(notice);
    }
    if (o.signal && typeof o.signal.addEventListener === 'function') {
      o.signal.addEventListener('abort', dispose, { once: true });
      disposers.push(() => o.signal.removeEventListener('abort', dispose));
    }

    render();
    return { dispose, render, notice };
  }

  return { mountPrimaryPausedNotice };
});
