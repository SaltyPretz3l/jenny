/* renderer/chat/renderer-composer-v2-render.js - Composer V2 mode-chip render layer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let inv;
    try { inv = require('../inventory/action-button'); } catch (_err) { inv = null; }
    module.exports = factory(inv, require('../inventory/chip'), require('./renderer-composer-v2-state'));
    return;
  }
  root.rendererComposerV2Render = factory(root.inventoryActionButton, root.inventoryChip, root.rendererComposerV2State);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryActionButton, inventoryChip, composerState) {
  'use strict';

  const BLOCKED_SEND_REASONS = Object.freeze({
    NO_SESSION: 'Start a conversation first.',
    NOT_AUTHENTICATED: 'Sign in to send messages.',
    BACKEND_PREFLIGHT: 'Connecting to the model…',
    BACKEND_NOT_READY: 'Backend not ready yet.',
    INTERACTIVE_PENDING: 'Answer the interactive questions above first.',
    STREAMING: 'Wait for the current response to finish, or stop it.',
    EMPTY_DRAFT: 'Type a message or attach a file.',
    UNAVAILABLE: 'Send is currently unavailable.',
  });

  const MODE_CHIP_COPY = Object.freeze({
    ask: Object.freeze({
      label: 'Ask',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
      hint: 'Jenny asks before running tools that change things.',
    }),
    auto: Object.freeze({
      label: 'Auto',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      hint: 'Tools run without asking. Python, blocked commands, and explicit denies still prompt.',
    }),
    plan: Object.freeze({
      label: 'Plan',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
      hint: 'Read-only: Jenny plans first and presents it before acting.',
    }),
  });

  function escapeCssString(value) {
    const text = String(value || '');
    const css = typeof globalThis !== 'undefined' ? globalThis.CSS : null;
    if (css && typeof css.escape === 'function') {
      return css.escape(text);
    }
    const escapedChars = '"\\#.:,[]>~+*^$|=';
    return Array.from(text, (char) => {
      const code = char.charCodeAt(0);
      if (code > 31 && code !== 127 && !escapedChars.includes(char)) {
        return char;
      }
      if (code === 0) return '\\FFFD ';
      const hex = char.charCodeAt(0).toString(16).toUpperCase();
      return '\\' + hex + ' ';
    }).join('');
  }

  function mountInventoryButton(container, opts, handlers) {
    if (!container) {
      throw new Error('mountInventoryButton: container is required');
    }
    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) {
      throw new Error('mountInventoryButton: container has no ownerDocument');
    }
    const options = opts || {};
    if (typeof inventoryActionButton !== 'function') {
      throw new Error('mountInventoryButton: inventory action button is required');
    }
    const html = inventoryActionButton({ ...options, plain: true });
    container.insertAdjacentHTML('beforeend', html);
    const node = container.lastElementChild;
    const dispatch = handlers || {};
    const attached = [];
    for (const evt of Object.keys(dispatch)) {
      const fn = dispatch[evt];
      if (typeof fn === 'function') {
        node.addEventListener(evt, fn);
        attached.push([evt, fn]);
      }
    }
    return {
      node,
      detachHandlers() {
        for (const [evt, fn] of attached) {
          node.removeEventListener(evt, fn);
        }
      },
    };
  }

  function createComposerModeChipsRenderer(deps) {
    const container = deps && deps.container;
    if (!container) {
      throw new Error('createComposerModeChipsRenderer: container is required');
    }

    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) {
      throw new Error('createComposerModeChipsRenderer: container has no ownerDocument');
    }

    const announcer = (deps && deps.announcer) || container.querySelector('#composerModeChipsAnnouncer') || null;
    const getRunMode = deps && typeof deps.getRunMode === 'function'
      ? deps.getRunMode
      : () => (deps?.getPlanMode?.() === true ? 'plan' : 'ask');
    const slot = doc.getElementById('composerRunModeSlot');
    const switcher = slot ? createRunModeSwitcherRenderer({
      slot,
      hint: doc.getElementById('composerRunModeHint'),
      getRunMode,
    }) : null;

    function updateChips() {
      switcher?.sync();
    }

    updateChips();

    return {
      refresh: updateChips,
      destroy() {
        switcher?.destroy();
        if (announcer) {
          announcer.textContent = '';
        }
      },
    };
  }

  const normalizeRunMode = composerState.normalizeRunMode;

  function applyRunModeChip(chip, hint, runMode) {
    if (!chip) return false;
    const mode = normalizeRunMode(runMode);
    const nextMode = typeof composerState?.nextRunMode === 'function'
      ? composerState.nextRunMode(mode)
      : ({ ask: 'auto', auto: 'plan', plan: 'ask' })[mode];
    const copy = MODE_CHIP_COPY[mode];
    const nextCopy = MODE_CHIP_COPY[nextMode];
    chip.classList.remove('composer-run-mode-ask', 'composer-run-mode-auto', 'composer-run-mode-plan', 'inv-chip--on');
    chip.classList.add(`composer-run-mode-${mode}`);
    chip.classList.toggle('inv-chip--on', mode === 'auto');
    const icon = chip.querySelector('.inv-chip-icon');
    const label = chip.querySelector('.inv-chip-label');
    if (icon) icon.innerHTML = copy.icon;
    if (label) label.textContent = copy.label;
    chip.setAttribute('aria-label', `Run mode: ${copy.label}. Click to switch to ${nextCopy.label}.`);
    chip.setAttribute('title', `Run mode: ${copy.label}. Click to switch to ${nextCopy.label}. (Shift+Tab to cycle)`);
    chip.setAttribute('aria-keyshortcuts', 'Shift+Tab');
    chip.removeAttribute('aria-pressed');
    if (hint) hint.textContent = copy.hint;
    return true;
  }

  function syncRunModeChip(runMode, documentRef) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    return applyRunModeChip(
      doc?.getElementById?.('composerRunModeChip'),
      doc?.getElementById?.('composerRunModeHint'),
      runMode
    );
  }

  function createRunModeSwitcherRenderer(deps) {
    const slot = deps && deps.slot;
    if (!slot) throw new Error('createRunModeSwitcherRenderer: slot is required');
    if (typeof inventoryChip !== 'function') throw new Error('createRunModeSwitcherRenderer: inventory chip is required');
    const doc = slot.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const getRunMode = typeof deps.getRunMode === 'function' ? deps.getRunMode : () => 'ask';
    const initialMode = normalizeRunMode(getRunMode());
    const initialCopy = MODE_CHIP_COPY[initialMode];
    slot.insertAdjacentHTML('beforeend', inventoryChip({
      id: 'composer-run-mode',
      domId: 'composerRunModeChip',
      iconHtml: initialCopy.icon,
      label: initialCopy.label,
      ariaLabel: `Run mode: ${initialCopy.label}.`,
      className: `composer-run-mode-chip composer-run-mode-${initialMode}${initialMode === 'auto' ? ' inv-chip--on' : ''}`,
    }));
    const chip = slot.querySelector('#composerRunModeChip');
    const onCycle = typeof deps.onCycle === 'function' ? deps.onCycle : null;
    if (onCycle) chip.addEventListener('click', onCycle);
    const sync = () => applyRunModeChip(chip, deps.hint || doc?.getElementById?.('composerRunModeHint'), getRunMode()); sync();
    return {
      sync,
      syncRunModeChip: (runMode) => applyRunModeChip(chip, deps.hint, runMode),
      destroy() {
        if (onCycle) chip.removeEventListener('click', onCycle);
        chip.remove();
      },
    };
  }

  function createComposerAttachmentTrayPreviewRenderer(deps) {
    const tray = deps && deps.tray;
    const pill = deps && deps.pill;
    if (!tray) {
      throw new Error('createComposerAttachmentTrayPreviewRenderer: deps.tray is required');
    }
    if (!pill) {
      throw new Error('createComposerAttachmentTrayPreviewRenderer: deps.pill is required');
    }
    const doc = tray.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    const MutationObserverCtor = (win && win.MutationObserver)
      || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

    let lastCount = -1;

    function readQueuedCount() {
      const chips = tray.querySelectorAll('.attachment-chip:not(.attachment-chip-clear)');
      return chips.length;
    }

    function update() {
      const count = readQueuedCount();
      if (count === lastCount) return;
      lastCount = count;
      if (count > 0) {
        pill.textContent = 'Queued (' + count + ')';
        pill.classList.remove('hidden');
      } else {
        pill.textContent = '';
        pill.classList.add('hidden');
      }
    }

    let observer = null;
    if (MutationObserverCtor) {
      observer = new MutationObserverCtor(update);
      observer.observe(tray, { childList: true, attributes: true, attributeFilter: ['class'] });
    }

    update();

    return {
      refresh: update,
      destroy() {
        if (observer) {
          try { observer.disconnect(); } catch (_err) { /* noop */ }
          observer = null;
        }
        pill.textContent = '';
        pill.classList.add('hidden');
      },
    };
  }

  function createComposerBlockedSendTooltipRenderer(deps) {
    const sendButton = deps && deps.sendButton;
    const getReason = deps && deps.getReason;
    if (!sendButton) {
      throw new Error('createComposerBlockedSendTooltipRenderer: deps.sendButton is required');
    }
    if (typeof getReason !== 'function') {
      throw new Error('createComposerBlockedSendTooltipRenderer: deps.getReason must be a function');
    }
    const defaultTitle = String(deps && deps.defaultTitle !== undefined
      ? deps.defaultTitle
      : sendButton.getAttribute('title') || '');

    const doc = sendButton.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    const MutationObserverCtor = (win && win.MutationObserver)
      || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

    function isBlocked() {
      if (sendButton.disabled === true) return true;
      const aria = String(sendButton.getAttribute('aria-disabled') || '').toLowerCase();
      return aria === 'true';
    }

    function update() {
      if (isBlocked()) {
        let reason;
        try { reason = String(getReason() || ''); } catch (_err) { reason = ''; }
        const title = reason || BLOCKED_SEND_REASONS.UNAVAILABLE;
        if (sendButton.getAttribute('title') !== title) {
          sendButton.setAttribute('title', title);
        }
      } else if (sendButton.getAttribute('title') !== defaultTitle) {
        if (defaultTitle) {
          sendButton.setAttribute('title', defaultTitle);
        } else {
          sendButton.removeAttribute('title');
        }
      }
    }

    let observer = null;
    if (MutationObserverCtor) {
      observer = new MutationObserverCtor(update);
      observer.observe(sendButton, { attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    }

    update();

    return {
      refresh: update,
      destroy() {
        if (observer) {
          try { observer.disconnect(); } catch (_err) { /* noop */ }
          observer = null;
        }
        if (defaultTitle) {
          sendButton.setAttribute('title', defaultTitle);
        } else {
          sendButton.removeAttribute('title');
        }
      },
    };
  }
  function createComposerFailedSendNoticeRenderer(deps) {
    const noticeNode = deps && deps.noticeNode;
    const chatThread = deps && deps.chatThread;
    const getCurrentSessionId = deps && deps.getCurrentSessionId;
    const getMessagesForSession = deps && deps.getMessagesForSession;
    const getRetryAvailability = deps && typeof deps.getRetryAvailability === 'function'
      ? deps.getRetryAvailability
      : () => ({ available: true, reason: '' });
    const onRetry = deps && deps.onRetry;
    const onDismiss = deps && deps.onDismiss;
    if (!noticeNode) {
      throw new Error('createComposerFailedSendNoticeRenderer: deps.noticeNode is required');
    }
    if (!chatThread) {
      throw new Error('createComposerFailedSendNoticeRenderer: deps.chatThread is required');
    }
    if (typeof getCurrentSessionId !== 'function') {
      throw new Error('createComposerFailedSendNoticeRenderer: deps.getCurrentSessionId must be a function');
    }
    if (typeof getMessagesForSession !== 'function') {
      throw new Error('createComposerFailedSendNoticeRenderer: deps.getMessagesForSession must be a function');
    }
    if (typeof onRetry !== 'function') {
      throw new Error('createComposerFailedSendNoticeRenderer: deps.onRetry must be a function');
    }
    if (typeof onDismiss !== 'function') {
      throw new Error('createComposerFailedSendNoticeRenderer: deps.onDismiss must be a function');
    }

    const doc = noticeNode.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    const MutationObserverCtor = (win && win.MutationObserver)
      || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

    // Unchanged arrays are O(1); same-length replacements inspect changed
    // object identities, and touching the active failure requires a full scan
    // to resurface older failures.
    let scanState = { sessionId: null, messages: null, resultIndex: -1, resultMessageId: null, resultFailure: null };

    function messageIsActiveFailure(msg) {
      return Boolean(
        msg
        && String(msg.role || '').trim() === 'user'
        && msg.send_failure
        && msg.send_failure.state === 'failed'
        && msg.send_failure.dismissed !== true
      );
    }

    // Full reverse scan -- only reached on a genuine structural change
    // (message count changed, session switch, or a rare dismiss/retry edge
    // case where an older historical failure needs to resurface).
    function scanForLatestFailure(messages) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messageIsActiveFailure(messages[i])) {
          return i;
        }
      }
      return -1;
    }

    function findLatestFailedUserMessage() {
      const sessionId = String(getCurrentSessionId() || '').trim();
      if (!sessionId) {
        scanState = { sessionId: null, messages: null, resultIndex: -1, resultMessageId: null, resultFailure: null };
        return null;
      }
      let messages;
      try {
        const result = getMessagesForSession(sessionId);
        messages = Array.isArray(result) ? result : [];
      } catch (_err) {
        messages = [];
      }

      if (sessionId === scanState.sessionId && messages === scanState.messages) {
        return scanState.resultIndex >= 0
          ? { sessionId, messageId: scanState.resultMessageId, failure: scanState.resultFailure }
          : null;
      }

      const previousMessages = sessionId === scanState.sessionId ? scanState.messages : null;
      let resultIndex = -1;

      if (previousMessages && previousMessages.length === messages.length) {
        const changedIndexes = [];
        for (let i = 0; i < messages.length; i += 1) {
          if (messages[i] !== previousMessages[i]) {
            changedIndexes.push(i);
          }
        }
        if (changedIndexes.length === 0) {
          resultIndex = scanState.resultIndex;
        } else {
          const priorSlotTouched = scanState.resultIndex >= 0 && changedIndexes.indexOf(scanState.resultIndex) !== -1;
          let candidateIndex = -1;
          for (const idx of changedIndexes) {
            if (idx > candidateIndex && messageIsActiveFailure(messages[idx])) {
              candidateIndex = idx;
            }
          }
          if (candidateIndex >= 0) {
            // An untouched prior active failure at a HIGHER index is still
            // the most recent one -- a newly-failed changed slot only takes
            // over when it sits later in the array. (When the prior slot was
            // itself touched it competed in the candidate loop above, so
            // candidateIndex already accounts for it.)
            resultIndex = (!priorSlotTouched && scanState.resultIndex > candidateIndex)
              ? scanState.resultIndex
              : candidateIndex;
          } else if (scanState.resultIndex >= 0 && !priorSlotTouched) {
            // Previously active failure's slot wasn't one of the changed
            // entries -- still untouched and still valid.
            resultIndex = scanState.resultIndex;
          } else if (scanState.resultIndex >= 0 && priorSlotTouched) {
            // The active failure's own slot changed (e.g. dismissed) and no
            // other changed slot is a live failure -- an older historical
            // failure could now be the most recent live one; this
            // incremental pass can't see past the changed set, so fall back
            // once. Rare: only fires on an explicit dismiss/retry, not on
            // streaming frames.
            resultIndex = scanForLatestFailure(messages);
          }
        }
      } else {
        resultIndex = scanForLatestFailure(messages);
      }

      const resultMessage = resultIndex >= 0 ? messages[resultIndex] : null;
      scanState = {
        sessionId,
        messages,
        resultIndex,
        resultMessageId: resultMessage ? String(resultMessage.id || '').trim() : null,
        resultFailure: resultMessage ? resultMessage.send_failure : null,
      };

      return resultIndex >= 0
        ? { sessionId, messageId: scanState.resultMessageId, failure: scanState.resultFailure }
        : null;
    }

    function renderNoticeBody(messageText, handlers, retryAvailability) {
      noticeNode.replaceChildren();
      const messageEl = doc.createElement('span');
      messageEl.className = 'composer-failed-send-notice-message';
      messageEl.textContent = messageText;
      const actionsEl = doc.createElement('span');
      actionsEl.className = 'composer-failed-send-notice-actions';
      noticeNode.appendChild(messageEl);
      noticeNode.appendChild(actionsEl);
      const retryState = retryAvailability && typeof retryAvailability === 'object'
        ? retryAvailability
        : { available: true, reason: '' };
      const retryMount = mountInventoryButton(actionsEl, {
        label: 'Retry',
        className: 'composer-failed-send-notice-button composer-failed-send-notice-button--retry',
        dataset: { action: 'retry' },
        disabled: retryState.available === false,
        title: retryState.available === false
          ? String(retryState.reason || 'Retry is unavailable.')
          : 'Retry sending this message',
      }, retryState.available === false ? {} : { click: handlers.onRetry });
      const dismissMount = mountInventoryButton(actionsEl, {
        label: 'Dismiss',
        className: 'composer-failed-send-notice-button composer-failed-send-notice-button--dismiss',
        dataset: { action: 'dismiss' },
        title: 'Dismiss this error',
      }, { click: handlers.onDismiss });
      return { retryMount, dismissMount };
    }

    let activeFailure = null;
    let activeMounts = null;

    function detachActionHandlers() {
      if (!activeMounts) return;
      try { activeMounts.retryMount.detachHandlers(); } catch (_err) { /* noop */ }
      try { activeMounts.dismissMount.detachHandlers(); } catch (_err) { /* noop */ }
      activeMounts = null;
    }

    function clearBubbleStates() {
      const tagged = chatThread.querySelectorAll('.chat-bubble[data-message-state="failed"]');
      for (const node of tagged) {
        node.removeAttribute('data-message-state');
      }
    }

    function tagFailedBubble(sessionId, messageId) {
      if (!messageId) return;
      const escapedMessageId = escapeCssString(messageId);
      const article = chatThread.querySelector('article[data-message-id="' + escapedMessageId + '"]')
        || chatThread.querySelector('[data-message-id="' + escapedMessageId + '"]');
      if (!article) return;
      const bubble = article.querySelector('.chat-bubble');
      if (!bubble) return;
      // Clear other tagged bubbles first (one failed bubble visible at a time).
      const others = chatThread.querySelectorAll('.chat-bubble[data-message-state="failed"]');
      for (const node of others) {
        if (node !== bubble) node.removeAttribute('data-message-state');
      }
      bubble.setAttribute('data-message-state', 'failed');
    }

    function update() {
      const found = findLatestFailedUserMessage();
      if (!found) {
        if (!noticeNode.classList.contains('hidden')) {
          detachActionHandlers();
          noticeNode.replaceChildren();
          noticeNode.classList.add('hidden');
        }
        clearBubbleStates();
        activeFailure = null;
        return;
      }
      tagFailedBubble(found.sessionId, found.messageId);
      const sameAsActive = activeFailure
        && activeFailure.sessionId === found.sessionId
        && activeFailure.messageId === found.messageId;
      if (sameAsActive && !noticeNode.classList.contains('hidden')) {
        return;
      }
      detachActionHandlers();
      let retryAvailability;
      try {
        retryAvailability = getRetryAvailability(found) || { available: false, reason: 'Retry is unavailable.' };
      } catch (_error) {
        retryAvailability = { available: false, reason: 'Retry is unavailable.' };
      }
      activeMounts = renderNoticeBody('Last message failed to send. Retry or dismiss to move on.', {
        onRetry() {
          try {
            onRetry({ sessionId: found.sessionId, messageId: found.messageId, failure: found.failure });
          } catch (_err) { /* noop */ }
        },
        onDismiss() {
          try {
            onDismiss({ sessionId: found.sessionId, messageId: found.messageId, failure: found.failure });
          } catch (_err) { /* noop */ }
        },
      }, retryAvailability);
      noticeNode.classList.remove('hidden');
      activeFailure = { sessionId: found.sessionId, messageId: found.messageId };
    }

    let observer = null;
    if (MutationObserverCtor) {
      observer = new MutationObserverCtor(update);
      observer.observe(chatThread, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-message-id'] });
    }

    update();

    return {
      refresh: update,
      destroy() {
        if (observer) {
          try { observer.disconnect(); } catch (_err) { /* noop */ }
          observer = null;
        }
        detachActionHandlers();
        clearBubbleStates();
        noticeNode.replaceChildren();
        noticeNode.classList.add('hidden');
        activeFailure = null;
        scanState = { sessionId: null, messages: null, resultIndex: -1, resultMessageId: null, resultFailure: null };
      },
    };
  }

  return {
    createComposerModeChipsRenderer,
    createRunModeSwitcherRenderer,
    createComposerAttachmentTrayPreviewRenderer,
    createComposerBlockedSendTooltipRenderer,
    createComposerFailedSendNoticeRenderer,
    mountInventoryButton,
    syncRunModeChip,
    BLOCKED_SEND_REASONS,
  };
});
