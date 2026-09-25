/* renderer/chat/renderer-runtime-queue-view.js -- durable queue strip (UMD) */
/**
 * The visible projection of the durable pending list: what is waiting, in what
 * order, and what can still be done about it. Places in line come from the
 * runtime's own submission order (renderer-durable-send.js), never from this
 * view — when the position is unknown the row says "queued" rather than
 * inventing a number, and paused work shows Resume instead of a place in line.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'));
    return;
  }
  root.rendererRuntimeQueueView = factory(root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const VIEW = Symbol('runtimeQueueView');
  const PREVIEW_CHARS = 160;
  /* A turn already running, or one already being withdrawn, cannot be withdrawn again. */
  const WITHDRAW_LOCKED = ['running', 'withdrawing'];

  function rowDomKey(value, taken) {
    const slug = String(value || 'row').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'row';
    let key = slug;
    let count = 1;
    while (taken.has(key)) { count += 1; key = `${slug}-${count}`; }
    taken.add(key);
    return key;
  }

  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(doc, parent, id, label, className, handler, cleanup, disabled = false) {
    const wrapper = doc.createElement('span');
    wrapper.innerHTML = actionButton({ id, domId: id, label, className: `runtime-queue__action ${className}`, plain: true, disabled });
    const node = wrapper.firstElementChild;
    node.addEventListener('click', handler);
    cleanup.push(() => node.removeEventListener('click', handler));
    parent.appendChild(node);
    return node;
  }

  function focusControl(host, id) {
    const node = id ? host.ownerDocument.getElementById(id) : null;
    if (!node || !host.contains(node) || node.disabled) return;
    node.focus({ preventScroll: true });
  }

  function positionLabel(row) {
    if (row.position === 1) return jt('chat.runtimeQueue.runsNext', 'Runs next');
    if (Number.isSafeInteger(row.position) && row.position > 1) {
      return jt('chat.runtimeQueue.inLine', '#{position} in line', { position: String(row.position) });
    }
    /* Unknown place in line (paused, running, or past the first page). */
    return jt('chat.runtimeQueue.queued', 'Queued');
  }

  function statusLabel(status) {
    if (status === 'running') return jt('chat.runtimeQueue.running', 'Running');
    if (status === 'withdrawing') return jt('chat.runtimeQueue.withdrawing', 'Withdrawing…');
    // The runtime never acknowledged this send; the poller is re-asking it.
    if (status === 'unconfirmed') return jt('chat.runtimeQueue.confirming', 'Confirming…');
    // The snapshot row cannot say why work is paused (restart, user pause,
    // runtime off), so the label states only the status the runtime reports.
    if (status === 'paused') return jt('runtime.ui.paused', 'Paused');
    return '';
  }

  /**
   * Render the composer queue strip.
   * @param {Object} options
   * @param {Object} options.state - Renderer state (current session, sessions)
   * @param {HTMLElement} options.host - The #runtimeQueue host element
   * @param {Array<Object>} options.rows - Frozen row views from listPending()
   * @param {Object} [options.actions] - { withdraw(row), resume(row) }
   * @returns {number} rendered row count
   */
  function renderRuntimeQueue(options = {}) {
    const { state, host } = options;
    const actions = options.actions || {};
    if (!state || !host) return 0;
    const rows = Array.isArray(options.rows) ? options.rows : [];
    const closing = options.closing === true;
    const view = host[VIEW] || (host[VIEW] = { collapsed: false, cleanup: [] });
    view.options = options;
    const sessionId = String(state.currentSessionId || '').trim();
    const session = (Array.isArray(state.sessions) ? state.sessions : []).find((entry) => entry?.id === sessionId);
    const signature = JSON.stringify([sessionId, session?.title, view.collapsed, closing,
      rows.map((row) => [row.key, row.workId, row.prompt, row.position, row.status])]);
    const sameActions = view.actions?.withdraw === actions.withdraw && view.actions?.resume === actions.resume;
    // Streaming chrome refreshes must not rebuild an unchanged strip (focus, hover).
    if (view.signature === signature && sameActions) return rows.length;
    view.signature = signature;
    view.actions = actions;
    const doc = host.ownerDocument;
    const active = doc.activeElement;
    const focused = host.contains(active) ? active.id : '';
    while (view.cleanup.length) view.cleanup.pop()();
    host.replaceChildren();
    host.hidden = !rows.length;
    if (!rows.length) return 0;
    const redraw = (focusId) => {
      view.signature = null;
      renderRuntimeQueue(view.options);
      focusControl(host, focusId);
    };
    const heading = element(doc, 'div', 'runtime-queue__heading');
    const summary = element(doc, 'span', 'runtime-queue__summary',
      jtn('chat.runtimeQueue.summary', rows.length, { count: String(rows.length) }, '{count} queued', '{count} queued'));
    summary.setAttribute('role', 'status');
    heading.appendChild(summary);
    const toggle = button(doc, heading, 'runtime-queue-toggle',
      view.collapsed ? jt('common.show', 'Show') : jt('common.hide', 'Hide'), 'runtime-queue__toggle', () => {
        view.collapsed = !view.collapsed;
        redraw('runtime-queue-toggle');
      }, view.cleanup);
    toggle.setAttribute('aria-expanded', String(!view.collapsed));
    toggle.setAttribute('aria-controls', 'runtime-queue-list');
    host.appendChild(heading);
    const list = element(doc, 'div', 'runtime-queue__list');
    list.id = 'runtime-queue-list';
    list.hidden = view.collapsed;
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', jt('chat.runtimeQueue.listLabel', 'Queued messages for {title}, run in order',
      { title: String(session?.title || sessionId) }));
    host.appendChild(list);
    const taken = new Set();
    for (const row of rows) renderRow({ row, key: rowDomKey(row.key, taken), view, actions, doc, list, closing });
    focusControl(host, focused);
    return rows.length;
  }

  function renderRow({ row, key, view, actions, doc, list, closing }) {
    const node = element(doc, 'div', `runtime-queue__row runtime-queue__row--${row.status}`);
    node.id = `runtime-queue-row-${key}`;
    node.dataset.runtimeWorkKey = String(row.key || '');
    // The place in line is real information, so assistive tech hears it too.
    const marker = element(doc, 'span', 'runtime-queue__position', positionLabel(row));
    node.appendChild(marker);
    const content = element(doc, 'div', 'runtime-queue__content');
    node.appendChild(content);
    const prompt = String(row.prompt || '').trim();
    const preview = element(doc, 'div', 'runtime-queue__preview', prompt.slice(0, PREVIEW_CHARS));
    preview.title = prompt;
    content.appendChild(preview);
    const status = statusLabel(row.status);
    if (status) content.appendChild(element(doc, 'div', 'runtime-queue__status', status));
    // A detached row is a paused reply the composer never queued: it is
    // discarded rather than withdrawn, and its copy says reply, not message.
    const detached = row.detached === true;
    if (row.status === 'paused') {
      // Paused work never auto-resumes: the only honest affordance is Resume.
      // Nothing new can start while the runtime closes, so Resume says why.
      const resume = button(doc, content, `runtime-queue-resume-${key}`, jt('chat.runtimeQueue.resume', 'Resume'),
        'runtime-queue__action--resume', () => actions.resume?.(row), view.cleanup, !actions.resume || closing === true);
      resume.title = closing === true
        ? jt('chat.runtimeQueue.resumeClosing', 'Jenny is shutting down')
        : detached ? jt('chat.runtimeQueue.resumeReplyTitle', 'Resume this paused reply')
          : jt('chat.runtimeQueue.resumeTitle', 'Resume this queued message');
    }
    // Nothing can be withdrawn before the runtime has acknowledged the send
    // (no work_id yet), while it runs, or while a withdrawal is in flight.
    const withdrawTitle = detached
      ? jt('chat.runtimeQueue.discardTitle', 'Discard this paused reply')
      : jt('chat.runtimeQueue.withdrawTitle', 'Withdraw this queued message');
    const withdraw = button(doc, node, `runtime-queue-withdraw-${key}`,
      detached ? jt('chat.runtimeQueue.discard', 'Discard') : jt('chat.runtimeQueue.withdraw', 'Withdraw'),
      'runtime-queue__action--withdraw', () => actions.withdraw?.(row), view.cleanup,
      WITHDRAW_LOCKED.includes(row.status) || !row.workId || !actions.withdraw);
    withdraw.title = withdrawTitle;
    withdraw.setAttribute('aria-label', !detached && Number.isSafeInteger(row.position)
      ? jt('chat.runtimeQueue.withdrawLabel', 'Withdraw queued message {position}', { position: String(row.position) })
      : withdrawTitle);
    list.appendChild(node);
  }

  function disposeRuntimeQueueRender(host) {
    const view = host?.[VIEW];
    if (!view) return;
    while (view.cleanup.length) view.cleanup.pop()();
    delete host[VIEW];
    // Listeners are gone, so the controls must go with them.
    host.replaceChildren();
    host.hidden = true;
  }

  return { disposeRuntimeQueueRender, renderRuntimeQueue };
});
