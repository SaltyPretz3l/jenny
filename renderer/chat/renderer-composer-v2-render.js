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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const BLOCKED_SEND_REASONS = Object.freeze({
    NO_SESSION: jt('composer.sendBlocked.noSession', 'Start a conversation first.'),
    NOT_AUTHENTICATED: jt('composer.sendBlocked.notAuthenticated', 'Sign in to send messages.'),
    BACKEND_PREFLIGHT: jt('composer.sendBlocked.connecting', 'Connecting to the model…'),
    BACKEND_NOT_READY: jt('composer.sendBlocked.backendNotReady', 'Backend not ready yet.'),
    INTERACTIVE_PENDING: jt('composer.sendBlocked.interactivePending', 'Answer the interactive questions above first.'),
    STREAMING: jt('composer.sendBlocked.streaming', 'Wait for the current response to finish, or stop it.'),
    EMPTY_DRAFT: jt('composer.sendBlocked.emptyDraft', 'Type a message or attach a file.'),
    UNAVAILABLE: jt('composer.sendBlocked.unavailable', 'Send is currently unavailable.'),
  });

  const MODE_CHIP_COPY = Object.freeze({
    ask: Object.freeze({
      label: jt('composer.runMode.ask', 'Ask'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
      hint: jt('composer.runMode.askHint', 'Jenny asks before running tools that change things.'),
    }),
    auto: Object.freeze({
      label: jt('composer.runMode.auto', 'Auto'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      hint: jt('composer.runMode.autoHint', 'Tools run without asking. Python, blocked commands, and explicit denies still prompt.'),
    }),
    plan: Object.freeze({
      label: jt('composer.runMode.plan', 'Plan'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
      hint: jt('composer.runMode.planHint', 'Read-only: Jenny plans first and presents it before acting.'),
    }),
    propose: Object.freeze({
      label: jt('composer.runMode.propose', 'Propose'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
      hint: jt('composer.runMode.proposeHint', 'Jenny suggests exact changes for you to review. Nothing in your files changes until you accept.'),
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
    if (!container) throw new Error('createComposerModeChipsRenderer: container is required');
    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('createComposerModeChipsRenderer: container has no ownerDocument');
    const announcer = (deps && deps.announcer) || container.querySelector('#composerModeChipsAnnouncer') || null;
    const getRunMode = deps && typeof deps.getRunMode === 'function'
      ? deps.getRunMode
      : () => (deps?.getPlanMode?.() === true ? 'plan' : 'ask');
    const slot = doc.getElementById('composerRunModeSlot');
    const switcher = slot ? createRunModeSwitcherRenderer({ slot, getRunMode }) : null;
    function updateChips() { switcher?.sync(); }
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
  // Every run-mode class derives from the canonical order, so a new mode cannot leave a stale class behind.
  const RUN_MODE_CLASSES = Object.freeze(composerState.RUN_MODE_ORDER.map((m) => `composer-run-mode-${m}`));

  // Gate C13 (2026-09-26): an unchanged apply (every focus move) writes nothing.
  const appliedRunModeChips = new WeakMap();

  /* Collapsed settings popover (2026-09-26 spec §4 step 4): an inline
     Ask | Auto | Plan segmented control rendered beside the cycling chip in
     the same slot. The stylesheet shows the segments only inside the open
     popover and hides the chip there; the toolbar keeps the chip. Clicks
     route through the settings bindings (`data-run-mode-option`). */
  const RUN_MODE_SEGMENT_ORDER = Object.freeze(['ask', 'auto', 'plan', 'propose']);

  // Plain inventory action buttons (the raw-primitive policy); '' without the
  // primitive, and every segment sync below then no-ops.
  function runModeSegmentsMarkup(mode, disabled) {
    if (typeof inventoryActionButton !== 'function') return '';
    const escapeHtml = inventoryActionButton.escapeHtml;
    const groupLabel = jt('composer.settingsSummary.rowRunMode', 'Run mode');
    return '<div class="composer-run-mode-segments" role="group" aria-label="' + escapeHtml(groupLabel) + '">'
      + RUN_MODE_SEGMENT_ORDER.map((option) => {
        const copy = MODE_CHIP_COPY[option];
        const active = option === mode;
        return inventoryActionButton({
          plain: true,
          className: `composer-run-mode-segment composer-run-mode-segment--${option}${active ? ' is-active' : ''}`,
          dataset: { 'run-mode-option': option },
          ariaPressed: active,
          title: copy.hint,
          disabled: disabled === true,
          trustedHtml: '<span class="composer-run-mode-segment-icon" aria-hidden="true">' + copy.icon + '</span>'
            + '<span class="composer-run-mode-segment-label">' + escapeHtml(copy.label) + '</span>',
        });
      }).join('')
      + '</div>';
  }

  // The segments group beside a run-mode chip: accepts the slot, the chip, or
  // the group itself.
  function findRunModeSegments(slotOrChip) {
    if (!slotOrChip || typeof slotOrChip.querySelector !== 'function') return null;
    if (slotOrChip.classList?.contains('composer-run-mode-segments')) return slotOrChip;
    const slot = slotOrChip.matches?.('[data-inv-chip="composer-run-mode"]') ? slotOrChip.parentElement : slotOrChip;
    if (!slot || typeof slot.querySelector !== 'function') return null;
    return slot.querySelector('.composer-run-mode-segments');
  }

  function syncRunModeSegmentsPressed(segments, mode) {
    if (!segments) return;
    for (const button of segments.querySelectorAll('[data-run-mode-option]')) {
      const active = button.getAttribute('data-run-mode-option') === mode;
      const pressed = active ? 'true' : 'false';
      if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
      if (button.classList.contains('is-active') !== active) button.classList.toggle('is-active', active);
    }
  }

  /* Mirror a disabled run-mode chip onto its segments (plugin read-only
     sessions). Exported: pane 0's render pipeline and pane 1's rail toggle
     `chip.disabled` directly, outside applyRunModeChip. Writes only on a
     change; returns whether a segments group was found. */
  function syncRunModeSegmentsDisabled(slotOrChip, disabled) {
    const segments = findRunModeSegments(slotOrChip);
    if (!segments) return false;
    const off = disabled === true;
    for (const button of segments.querySelectorAll('[data-run-mode-option]')) {
      if (button.disabled !== off) button.disabled = off;
    }
    return true;
  }

  function applyRunModeChip(chip, runMode) {
    if (!chip) return false;
    const mode = normalizeRunMode(runMode);
    const nextMode = typeof composerState?.nextRunMode === 'function'
      ? composerState.nextRunMode(mode)
      : ({ ask: 'auto', auto: 'plan', plan: 'propose', propose: 'ask' })[mode];
    const copy = MODE_CHIP_COPY[mode];
    const nextCopy = MODE_CHIP_COPY[nextMode];
    // The mode's hint sentence rides the chip: its tooltip and the end of its label.
    const ariaLabel = jt('composer.runMode.switchAriaLabel', 'Run mode: {mode}. Click to switch to {nextMode}.', { mode: copy.label, nextMode: nextCopy.label }).replace('{mode}', () => String(copy.label)).replace('{nextMode}', () => String(nextCopy.label)) + ' ' + copy.hint;
    const title = copy.label + ' · ' + copy.hint;
    const segments = findRunModeSegments(chip);
    const disabled = chip.disabled === true;
    // The segments (their node and the chip's disabled state) ride the key, so
    // a segments mount or a disabled flip still writes; an unchanged apply not.
    const key = [mode, ariaLabel, title, disabled ? 'disabled' : ''].join('\u0000');
    const applied = appliedRunModeChips.get(chip);
    const modeClass = `composer-run-mode-${mode}`;
    if (applied && applied.key === key && applied.segments === segments
        && RUN_MODE_CLASSES.every((c) => chip.classList.contains(c) === (c === modeClass))) return true;
    syncRunModeSegmentsPressed(segments, mode);
    if (segments) syncRunModeSegmentsDisabled(segments, disabled);
    chip.classList.remove(...RUN_MODE_CLASSES, 'inv-chip--on');
    chip.classList.add(modeClass);
    chip.classList.toggle('inv-chip--on', mode === 'auto');
    const icon = chip.querySelector('.inv-chip-icon');
    const label = chip.querySelector('.inv-chip-label');
    if (icon) icon.innerHTML = copy.icon;
    if (label) label.textContent = copy.label;
    chip.setAttribute('aria-label', ariaLabel);
    chip.setAttribute('title', title);
    chip.setAttribute('aria-keyshortcuts', 'Shift+Tab');
    chip.removeAttribute('aria-pressed');
    appliedRunModeChips.set(chip, { key, segments });
    return true;
  }

  function syncRunModeChip(runMode, documentRef) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    return applyRunModeChip(doc?.getElementById?.('composerRunModeChip'), runMode);
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
      domId: deps.domId === undefined ? 'composerRunModeChip' : deps.domId, // W2-2a: a second pane's chip has no id
      iconHtml: initialCopy.icon,
      label: initialCopy.label,
      ariaLabel: jt('composer.runMode.ariaLabel', 'Run mode: {mode}.', { mode: initialCopy.label }).replace('{mode}', () => String(initialCopy.label)),
      className: `composer-run-mode-chip composer-run-mode-${initialMode}${initialMode === 'auto' ? ' inv-chip--on' : ''}`,
    }));
    const chip = slot.querySelector('[data-inv-chip="composer-run-mode"]');
    chip.insertAdjacentHTML('afterend', runModeSegmentsMarkup(initialMode, chip.disabled === true));
    const segments = findRunModeSegments(slot);
    const onCycle = typeof deps.onCycle === 'function' ? deps.onCycle : null;
    if (onCycle) chip.addEventListener('click', onCycle);
    /* Both panes flip `chip.disabled` outside applyRunModeChip (pane 0's render
       pipeline sets it right after the sync), so the segments follow the
       attribute itself; attribute-filtered, it fires only on a real flip. */
    const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    const MutationObserverCtor = (win && win.MutationObserver)
      || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    let disabledObserver = null;
    if (MutationObserverCtor && segments) {
      disabledObserver = new MutationObserverCtor(() => syncRunModeSegmentsDisabled(segments, chip.disabled === true));
      disabledObserver.observe(chip, { attributes: true, attributeFilter: ['disabled'] });
    }
    const sync = () => applyRunModeChip(chip, getRunMode()); sync();
    return {
      sync,
      syncRunModeChip: (runMode) => applyRunModeChip(chip, runMode),
      destroy() {
        if (disabledObserver) {
          try { disabledObserver.disconnect(); } catch (_err) { /* noop */ }
          disabledObserver = null;
        }
        if (onCycle) chip.removeEventListener('click', onCycle);
        chip.remove();
        if (segments) segments.remove();
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
        pill.textContent = jtn('composer.attachments.queuedCount', count, { count }, 'Queued ({count})', 'Queued ({count})').replace('{count}', () => String(count));
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

  /* Status loader F6: one sentence for a model load, shown as the composer
     line and as Send's disabled tooltip (one key). '' when nothing loads. */
  const MODEL_LOADING_PHASES = Object.freeze(['model_acquiring', 'model_loading']);
  function describeModelLoading(backend) {
    if (!backend || !MODEL_LOADING_PHASES.includes(String(backend.phase || ''))) return '';
    const model = String(backend.model_acquisition?.requested_model || backend.model_lifecycle?.requested_model || '').trim();
    return model
      ? jt('composer.sendBlocked.modelLoading', 'Jenny is loading {model}. You can type; Send turns on when it is ready.', { model })
      : jt('composer.sendBlocked.modelLoadingUnnamed', 'Jenny is loading the model. You can type; Send turns on when it is ready.');
  }

  // Row 38 item 1 (B): the failed state, told once above the input while the
  // model is unavailable. '' otherwise. Send stays enabled: sending retries.
  function loadFailureUtils() {
    return (typeof globalThis !== 'undefined' && globalThis.jennyModelLoadFailure)
    || (typeof require === 'function' ? require('../shared/model-load-failure') : null);
  }
  function formatContextShort(value) {
    return value >= 1024 ? `${Math.round(value / 1024)}K` : String(value);
  }
  function describeModelFailure(backend) {
    const utils = loadFailureUtils();
    const failure = utils?.readModelLoadFailure?.(backend);
    if (!failure) return '';
    return jt('composer.modelFailure.line', "{model} didn't load · {cause}", { model: failure.model, cause: utils.causePhrase(failure) });
  }
  // Two plain actions beside the line: the cause's first fix, and the library.
  function buildModelFailureActions(backend) {
    const utils = loadFailureUtils();
    const failure = utils?.readModelLoadFailure?.(backend);
    if (!failure || typeof inventoryActionButton !== 'function') return '';
    const fix = utils.recoveryActions(failure)[0];
    const fixLabel = fix === 'loadSmaller'
      ? jt('composer.modelFailure.loadAt', 'Load at {context}', { context: formatContextShort(utils.retryContext(failure)) })
      : fix === 'showFits'
        ? jt('models.library.showModelsThatFit', 'Show models that fit')
        : fix === 'diagnostics'
          ? jt('composer.modelFailure.openDiagnostics', 'Open Diagnostics')
          : jt('composer.modelFailure.retry', 'Retry');
    const othersLabel = jt('composer.modelFailure.otherModels', 'Other models');
    const action = (id, label) => inventoryActionButton({
      plain: true, className: 'composer-loading-line-action', label, title: label,
      dataset: { 'composer-failure-action': id, 'composer-failure-model': failure.model },
    });
    return action(fix, fixLabel) + action('models', othersLabel);
  }

  // The failure markup last painted into a line (innerHTML re-serializes entities, so it cannot be compared).
  const paintedFailureHtml = new WeakMap();

  // The line sits in the row under the input, before the turn timer.
  // `scope` is the document (pane 0's id-addressed composer) or a split-view
  // pane root, whose composer nodes are addressed by data-chat-node.
  function syncComposerLoadingLine(scope, text, actionsHtml = '') {
    const paneScoped = Boolean(scope) && typeof scope.getElementById !== 'function';
    const byName = (name) => (paneScoped
      ? scope.querySelector?.(`[data-chat-node="${name}"]`) || null
      : scope?.getElementById?.(name) || null);
    const row = byName('composerModeChips');
    if (!row) return null;
    let line = byName('composerLoadingLine');
    const message = String(text || '').trim();
    if (!message) {
      if (line) line.remove();
      return null;
    }
    if (!line) {
      line = row.ownerDocument.createElement('span');
      if (paneScoped) line.setAttribute('data-chat-node', 'composerLoadingLine');
      else line.id = 'composerLoadingLine';
      line.className = 'composer-loading-line';
      row.insertBefore(line, byName('composerTurnTimer') || null);
    }
    if (actionsHtml && typeof inventoryActionButton === 'function') {
      const html = `<span>${inventoryActionButton.escapeHtml(message)}</span>${actionsHtml}`;
      if (line.dataset.tone !== 'failed' || paintedFailureHtml.get(line) !== html) {
        line.innerHTML = html;
        paintedFailureHtml.set(line, html);
        line.dataset.tone = 'failed';
        line.setAttribute('role', 'status');
      }
      return line;
    }
    if (line.dataset.tone) {
      delete line.dataset.tone;
      line.removeAttribute('role');
      paintedFailureHtml.delete(line);
    }
    if (line.textContent !== message) line.textContent = message;
    return line;
  }

  // A model load is app-wide, so every pane's composer tells it: pane 0 by id,
  // each further split-view pane in its own run-mode row.
  // `text` may be a resolver `(paneId) => [text, actionsHtml]` when the line differs per pane
  // (the hero's words show only in a pane whose conversation is empty).
  function syncComposerLoadingLines(doc, text, actionsHtml = '') {
    const resolve = typeof text === 'function' ? text : () => [text, actionsHtml];
    syncComposerLoadingLine(doc, ...resolve(0));
    const panes = doc?.querySelectorAll?.('.chat-pane[data-pane-id]:not([data-pane-id="0"])') || [];
    for (const pane of panes) syncComposerLoadingLine(pane, ...resolve(Number(pane.dataset.paneId)));
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
      : sendButton.getAttribute('title') || '') || jt('composer.sendTitle', 'Send message (Enter)');

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
      // data-model-loading: a load can start while Send is already disabled.
      observer.observe(sendButton, { attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-model-loading'] });
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
        label: jt('common.retry', 'Retry'),
        className: 'composer-failed-send-notice-button composer-failed-send-notice-button--retry',
        dataset: { action: 'retry' },
        disabled: retryState.available === false,
        title: retryState.available === false
          ? String(retryState.reason || jt('composer.failedSend.retryUnavailable', 'Retry is unavailable.'))
          : jt('composer.failedSend.retryTitle', 'Retry sending this message'),
      }, retryState.available === false ? {} : { click: handlers.onRetry });
      const dismissMount = mountInventoryButton(actionsEl, {
        label: jt('common.dismiss', 'Dismiss'),
        className: 'composer-failed-send-notice-button composer-failed-send-notice-button--dismiss',
        dataset: { action: 'dismiss' },
        title: jt('composer.failedSend.dismissTitle', 'Dismiss this error'),
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
        retryAvailability = getRetryAvailability(found) || { available: false, reason: jt('composer.failedSend.retryUnavailable', 'Retry is unavailable.') };
      } catch (_error) {
        retryAvailability = { available: false, reason: jt('composer.failedSend.retryUnavailable', 'Retry is unavailable.') };
      }
      activeMounts = renderNoticeBody(jt('composer.failedSend.notice', 'Last message failed to send. Retry or dismiss to move on.'), {
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
    describeModelLoading,
    describeModelFailure,
    buildModelFailureActions,
    syncComposerLoadingLine,
    syncComposerLoadingLines,
    mountInventoryButton,
    syncRunModeChip,
    syncRunModeSegmentsDisabled,
    BLOCKED_SEND_REASONS,
  };
});
