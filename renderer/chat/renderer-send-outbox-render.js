/* renderer/chat/renderer-send-outbox-render.js -- visible FIFO outbox projection (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), require('../inventory/text-field'));
    return;
  }
  root.rendererSendOutboxRender = factory(root.inventoryActionButton, root.inventoryTextField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, textField) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const VIEW = Symbol('sendOutboxView');

  function stableDomKey(value) {
    const raw = String(value || 'item');
    let hash = 2166136261;
    for (let index = 0; index < raw.length; index += 1) {
      hash ^= raw.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const slug = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
    return `${slug}-${(hash >>> 0).toString(36)}`;
  }

  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(doc, parent, id, label, className, handler, cleanup, disabled = false) {
    const wrapper = doc.createElement('span');
    wrapper.innerHTML = actionButton({ id, domId: id, label, className: `send-outbox__action ${className}`, plain: true, disabled });
    const node = wrapper.firstElementChild;
    node.addEventListener('click', handler);
    cleanup.push(() => node.removeEventListener('click', handler));
    parent.appendChild(node);
    return node;
  }

  function focusControl(host, id, selection) {
    const node = host.ownerDocument.getElementById(id);
    if (!node || !host.contains(node) || node.disabled) return;
    node.focus({ preventScroll: true });
    if (typeof selection?.start === 'number') node.setSelectionRange(selection.start, selection.end, selection.direction);
  }

  function renderSendOutbox(options = {}) {
    const { state, host } = options;
    const actions = options.actions || {};
    if (!state || !host) return 0;
    const view = host[VIEW] || (host[VIEW] = { edits: new Map(), collapsed: new Set(), scroll: new Map(), cleanup: [] });
    view.options = options;
    const sessionId = String(state.currentSessionId || '').trim();
    const queues = state.sendOutboxBySession instanceof Map ? state.sendOutboxBySession : new Map();
    const items = queues.get(sessionId) || [];
    const live = new Set();
    for (const [id, queue] of queues) for (const item of queue) live.add(JSON.stringify([id, item.id]));
    for (const key of view.edits.keys()) if (!live.has(key)) view.edits.delete(key);
    for (const id of view.collapsed) if (!queues.has(id)) view.collapsed.delete(id);
    for (const id of view.scroll.keys()) if (!queues.has(id)) view.scroll.delete(id);
    const session = state.sessions?.find((entry) => entry.id === sessionId);
    const signature = JSON.stringify([sessionId, session?.title, view.collapsed.has(sessionId),
      items.map((item) => [item.id, item.revision, item.prompt, item.status, item.attachments?.length])]);
    const sameActions = view.actions?.edit === actions.edit && view.actions?.cancel === actions.cancel && view.actions?.retry === actions.retry;
    // Streaming chrome refreshes must not rebuild an unchanged editor (IME, focus, selection).
    if (view.signature === signature && sameActions) return items.length;
    view.signature = signature;
    view.actions = actions;
    const doc = host.ownerDocument;
    const active = doc.activeElement;
    const focused = host.contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
    const oldList = host.querySelector('.send-outbox__list');
    if (oldList && !oldList.hidden && queues.has(view.sessionId)) view.scroll.set(view.sessionId, oldList.scrollTop);
    const listScroll = view.scroll.get(sessionId) || 0;
    view.sessionId = sessionId;
    for (const input of host.querySelectorAll('.send-outbox__input')) {
      const edit = view.edits.get(input.dataset.editKey);
      if (edit) edit.value = input.value;
    }
    while (view.cleanup.length) view.cleanup.pop()();
    host.replaceChildren();
    host.hidden = !items.length;
    // Only the small summary is live; editable drafts must not be announced on every keystroke.
    host.removeAttribute('aria-live');
    if (!items.length) return 0;
    const redraw = (focusId) => {
      view.signature = null;
      renderSendOutbox(view.options);
      if (focusId) focusControl(host, focusId);
    };
    const heading = element(doc, 'div', 'send-outbox__heading');
    const problems = items.filter((item) => ['failed', 'needs_review'].includes(item.status)).length;
    const summary = element(doc, 'span', 'send-outbox__summary', problems
      ? jtn('chat.outbox.summaryWithProblems', problems, { count: problems, queued: items.length }, '{queued} queued · {count} needs attention', '{queued} queued · {count} need attention')
      : jtn('chat.outbox.summary', items.length, { count: items.length }, '{count} queued', '{count} queued'));
    summary.setAttribute('role', 'status');
    heading.appendChild(summary);
    const collapsed = view.collapsed.has(sessionId);
    const toggle = button(doc, heading, 'send-outbox-toggle', collapsed ? jt('common.show', 'Show') : jt('common.hide', 'Hide'), 'send-outbox__toggle', () => {
      if (collapsed) view.collapsed.delete(sessionId); else view.collapsed.add(sessionId);
      redraw('send-outbox-toggle');
    }, view.cleanup);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-controls', 'send-outbox-list');
    host.appendChild(heading);
    const list = element(doc, 'div', 'send-outbox__list');
    list.id = 'send-outbox-list';
    list.hidden = collapsed;
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', jt("sendOutboxRender.queuedMessagesForValueSentInOrder", "Queued messages for {value1}, sent in order", { value1: String(session?.title || sessionId) }));
    host.appendChild(list);
    const counts = new Map();
    items.forEach((item, index) => {
      const base = stableDomKey(`${sessionId}:${item.id}`);
      const count = (counts.get(base) || 0) + 1;
      counts.set(base, count);
      const key = count === 1 ? base : `${base}-${count}`;
      renderRow({ item, index, key, sessionId, view, actions, doc, list, redraw });
    });
    list.scrollTop = listScroll;
    if (focused) focusControl(host, focused.id, focused);
    return items.length;
  }

  function renderRow({ item, index, key, sessionId, view, actions, doc, list, redraw }) {
    const row = element(doc, 'div', `send-outbox__row send-outbox__row--${item.status}`);
    row.id = `send-outbox-row-${key}`;
    row.dataset.outboxItemId = item.id;
    const sequence = element(doc, 'span', 'send-outbox__sequence', String(index + 1));
    sequence.setAttribute('aria-hidden', 'true');
    row.appendChild(sequence);
    const content = element(doc, 'div', 'send-outbox__content');
    row.appendChild(content);
    const editKey = JSON.stringify([sessionId, item.id]);
    const edit = view.edits.get(editKey);
    const locked = !['capturing_context', 'ready', 'waiting_for_turn', 'failed', 'needs_review'].includes(item.status);
    const previewId = `send-outbox-preview-${key}`;
    const inputId = `send-outbox-input-${key}`;
    if (edit && !locked) {
      const wrapper = doc.createElement('span');
      wrapper.innerHTML = textField({ id: inputId, value: edit.value, multiline: true, rows: 2, spellcheck: true, disabled: !actions.edit, ariaLabel: jt("sendOutboxRender.editQueuedMessageValue", "Edit queued message {value1}", { value1: String(index + 1) }) });
      const input = wrapper.querySelector('.inv-text-field-control');
      input.className = 'send-outbox__input';
      input.dataset.editKey = editKey;
      content.appendChild(input);
      const tools = element(doc, 'div', 'send-outbox__edit-actions');
      const close = () => { view.edits.delete(editKey); redraw(previewId); };
      button(doc, tools, `send-outbox-save-${key}`, jt('common.save', 'Save'), 'send-outbox__save', () => {
        const value = input.value;
        view.edits.delete(editKey);
        // The shell mutates the store synchronously before any dispatch await.
        actions.edit?.(item, value);
        redraw(previewId);
      }, view.cleanup, !actions.edit);
      button(doc, tools, `send-outbox-discard-${key}`, jt('chat.unsavedReply.discard', 'Discard'), '', close, view.cleanup);
      const onKey = (event) => {
        event.stopPropagation(); // Never route editor Enter into the main composer send handler.
        if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close(); }
      };
      input.addEventListener('keydown', onKey);
      view.cleanup.push(() => input.removeEventListener('keydown', onKey));
      content.appendChild(tools);
    } else {
      const prompt = String(item.prompt || '').trim() || jt("sendOutboxRender.valueAttachments", "{value1} attachments", { value1: String(item.attachments?.length || 0) });
      const preview = button(doc, content, previewId, prompt, 'send-outbox__preview', () => {
        view.edits.set(editKey, { value: String(item.prompt || '') });
        redraw(inputId);
      }, view.cleanup, locked || !actions.edit);
      preview.title = prompt;
      preview.setAttribute('aria-label', locked
        ? jt('chat.outbox.viewMessage', 'Queued message {position}: {prompt}', { position: index + 1, prompt })
        : jt('chat.outbox.editMessage', 'Edit queued message {position}: {prompt}', { position: index + 1, prompt }));
    }
    const label = { failed: jt("sendOutboxRender.couldNotSend", "Could not send"), needs_review: jt("sendOutboxRender.needsReview", "Needs review"), capturing_context: jt("sendOutboxRender.preparingContext", "Preparing context…"), sending: jt('chat.send.sendingStatus', 'Sending…') }[item.status];
    if (label) {
      const status = element(doc, 'div', 'send-outbox__status', label);
      content.appendChild(status);
      if (['failed', 'needs_review'].includes(item.status) && !edit) {
        button(doc, content, `send-outbox-retry-${key}`, jt('common.retry', 'Retry'), 'send-outbox__action--retry', () => actions.retry?.(item), view.cleanup, !actions.retry);
      }
    }
    const cancel = button(doc, row, `send-outbox-cancel-${key}`, '×', 'send-outbox__action--cancel', () => {
      actions.cancel?.(item);
      redraw('send-outbox-toggle');
    }, view.cleanup, locked || !actions.cancel);
    cancel.setAttribute('aria-label', jt("sendOutboxRender.cancelQueuedMessageValue", "Cancel queued message {value1}", { value1: String(index + 1) }));
    cancel.title = jt("sendOutboxRender.cancelQueuedMessage", "Cancel queued message");
    list.appendChild(row);
  }

  function disposeSendOutboxRender(host) {
    const view = host?.[VIEW];
    if (!view) return;
    while (view.cleanup.length) view.cleanup.pop()();
    delete host[VIEW];
  }
  return { disposeSendOutboxRender, renderSendOutbox, stableDomKey };
});
