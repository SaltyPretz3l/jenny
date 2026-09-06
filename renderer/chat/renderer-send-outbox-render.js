/* renderer/chat/renderer-send-outbox-render.js -- visible FIFO outbox projection (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/action-button'),
      require('../inventory/text-field')
    );
    return;
  }
  root.rendererSendOutboxRender = factory(root.inventoryActionButton, root.inventoryTextField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, textField) {
  if (typeof actionButton !== 'function' || typeof textField !== 'function') {
    throw new Error('renderer-send-outbox-render requires inventory action-button and text-field.');
  }
  const LISTENER_CLEANUP = Symbol('sendOutboxListenerCleanup');

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

  function addButton(documentRef, row, id, label, className, onClick, cleanup, disabled = false) {
    const wrapper = documentRef.createElement('span');
    wrapper.innerHTML = actionButton({
      id,
      label,
      className: `send-outbox__action ${className || ''}`.trim(),
      plain: true,
      disabled,
    });
    const button = wrapper.firstElementChild;
    button.addEventListener('click', onClick);
    cleanup.push(() => button.removeEventListener('click', onClick));
    row.appendChild(button);
    return button;
  }

  function renderSendOutbox(options = {}) {
    const { state, host, actions = {} } = options;
    if (!host || !state) return 0;
    const sessionId = String(state.currentSessionId || '').trim();
    const items = sessionId && state.sendOutboxBySession instanceof Map
      ? (state.sendOutboxBySession.get(sessionId) || [])
      : [];
    disposeSendOutboxRender(host);
    const cleanup = [];
    host[LISTENER_CLEANUP] = cleanup;
    host.replaceChildren();
    host.hidden = items.length === 0;
    if (!items.length) return 0;

    const documentRef = host.ownerDocument;
    const heading = documentRef.createElement('div');
    heading.className = 'send-outbox__heading';
    const session = Array.isArray(state.sessions)
      ? state.sessions.find((entry) => String(entry?.id || '').trim() === sessionId)
      : null;
    const destination = String(session?.title || sessionId).trim().slice(0, 60);
    heading.textContent = `Queued sends for ${destination} (${items.length})`;
    host.appendChild(heading);

    const renderedKeyCounts = new Map();
    items.forEach((item, index) => {
      const baseItemKey = stableDomKey(item.id);
      const occurrence = (renderedKeyCounts.get(baseItemKey) || 0) + 1;
      renderedKeyCounts.set(baseItemKey, occurrence);
      const itemKey = occurrence === 1 ? baseItemKey : `${baseItemKey}-${occurrence}`;
      const row = documentRef.createElement('div');
      row.id = `send-outbox-row-${itemKey}`;
      row.className = `send-outbox__row send-outbox__row--${String(item.status || 'ready')}`;
      row.dataset.outboxItemId = String(item.id || '');

      const sequence = documentRef.createElement('span');
      sequence.className = 'send-outbox__sequence';
      sequence.textContent = String(index + 1);
      sequence.setAttribute('aria-label', `Queue position ${index + 1}`);
      row.appendChild(sequence);

      const inputWrapper = documentRef.createElement('span');
      inputWrapper.innerHTML = textField({
        id: `send-outbox-input-${itemKey}`,
        value: String(item.prompt || ''),
        disabled: item.status === 'sending',
        spellcheck: true,
        ariaLabel: `Queued message ${index + 1}`,
      });
      const input = inputWrapper.querySelector('.inv-text-field-control');
      input.className = 'send-outbox__input';
      row.appendChild(input);

      const status = documentRef.createElement('span');
      status.className = 'send-outbox__status';
      status.textContent = String(item.status || 'ready').replaceAll('_', ' ');
      row.appendChild(status);

      addButton(documentRef, row, `send-outbox-save-${itemKey}`, 'Save', '', () => actions.edit?.(item, input.value), cleanup, item.status === 'sending');
      if (item.status === 'failed' || item.status === 'needs_review') {
        addButton(documentRef, row, `send-outbox-retry-${itemKey}`, 'Retry', 'send-outbox__action--retry', () => actions.retry?.(item), cleanup);
      }
      addButton(documentRef, row, `send-outbox-cancel-${itemKey}`, 'Cancel', 'send-outbox__action--cancel', () => actions.cancel?.(item), cleanup, item.status === 'sending');
      host.appendChild(row);
    });
    return items.length;
  }

  function disposeSendOutboxRender(host) {
    const cleanup = host?.[LISTENER_CLEANUP];
    if (!Array.isArray(cleanup)) return;
    while (cleanup.length) cleanup.pop()();
    delete host[LISTENER_CLEANUP];
  }

  return { disposeSendOutboxRender, renderSendOutbox, stableDomKey };
});
