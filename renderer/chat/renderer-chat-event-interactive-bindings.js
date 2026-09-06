// This chat-scoped module also hosts the app-wide delegated text-field menu because the
// renderer script budget is full. Its pure, parameterized pieces can be extracted cheaply later.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatEventInteractiveBindings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // --- Composer context menu (clipboard + spellcheck corrections) -----------
  //
  // The composer's contextmenu handler preventDefault()s Chromium's native menu,
  // so the spelling suggestions it would have shown arrive out-of-band: Electron
  // main forwards `params.misspelledWord` / `dictionarySuggestions` over the
  // `spellcheck:context` push (services/main/spellcheck-menu-bridge.js). That
  // push round-trips through the browser process, so it lands AFTER the
  // renderer's own contextmenu event — hence the bounded wait below rather than
  // a synchronous read. Missing preload, older preload, or a slow/absent push
  // all degrade to exactly today's clipboard-only menu.
  const SPELLCHECK_SUGGESTION_LIMIT = 5;
  const SPELLCHECK_WAIT_MS = 30;
  // The attribute is the opt-in: text-field.js emits it only for an explicit boolean,
  // and attribute selectors match the literal attribute, not the inherited IDL property.
  const SPELLCHECK_FIELD_SELECTOR = 'textarea[spellcheck="true"], input[spellcheck="true"]';

  function normalizeSpellcheckContext(payload, receivedAt) {
    if (!payload || typeof payload !== 'object') return { word: '', suggestions: [], at: receivedAt };
    const word = typeof payload.misspelled_word === 'string' ? payload.misspelled_word.trim() : '';
    const rawSuggestions = Array.isArray(payload.dictionary_suggestions)
      ? payload.dictionary_suggestions
      : [];
    return {
      word,
      suggestions: word
        ? rawSuggestions
          .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
          .map((entry) => entry.trim())
          .slice(0, SPELLCHECK_SUGGESTION_LIMIT)
        : [],
      at: receivedAt,
    };
  }

  // Latest-wins tracker over the spellcheck push. `wait(clickedAt)` resolves with
  // the first payload stamped at/after the right-click, or null after waitMs — a
  // payload received BEFORE the click is stale (it belongs to a previous
  // right-click) and is never reused.
  function createSpellcheckContextTracker(options) {
    const {
      subscribe = null,
      waitMs = SPELLCHECK_WAIT_MS,
      now = () => Date.now(),
    } = options || {};
    let latest = null;
    let waiters = [];
    const flush = (value) => {
      const pending = waiters;
      waiters = [];
      pending.forEach((resolve) => resolve(value));
    };
    let unsubscribe = null;
    if (typeof subscribe === 'function') {
      try {
        const off = subscribe((payload) => {
          latest = normalizeSpellcheckContext(payload, now());
          flush(latest);
        });
        unsubscribe = typeof off === 'function' ? off : null;
      } catch (_error) {
        // An older/missing preload surface is a normal degraded state.
        unsubscribe = null;
      }
    }
    const fresh = (value, clickedAt) => (value && value.at >= clickedAt ? value : null);
    return {
      wait(clickedAt) {
        if (typeof subscribe !== 'function') return Promise.resolve(null);
        if (fresh(latest, clickedAt)) return Promise.resolve(latest);
        return new Promise((resolve) => {
          let settled = false;
          let timer = null;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            const waiterIndex = waiters.indexOf(finish);
            if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
            resolve(fresh(value, clickedAt));
          };
          waiters.push(finish);
          timer = setTimeout(() => finish(null), waitMs);
        });
      },
      dispose() {
        try {
          if (unsubscribe) unsubscribe();
        } catch (_error) {
          /* best-effort */
        }
        unsubscribe = null;
        latest = null;
        flush(null);
      },
    };
  }

  // Pure: merge up to five corrections + "Add to dictionary" + a separator above
  // the existing clipboard items. No misspelling (or no payload) => baseItems
  // unchanged, byte-for-byte the menu that shipped before this bridge existed.
  function buildComposerContextMenuItems(options) {
    const {
      spellcheck = null,
      baseItems = [],
      onReplace = () => {},
      onAddToDictionary = () => {},
    } = options || {};
    const base = Array.isArray(baseItems) ? baseItems : [];
    const word = spellcheck && typeof spellcheck.word === 'string' ? spellcheck.word.trim() : '';
    if (!word) return base.slice();
    const suggestions = (Array.isArray(spellcheck.suggestions) ? spellcheck.suggestions : [])
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .slice(0, SPELLCHECK_SUGGESTION_LIMIT);
    const items = suggestions.map((suggestion) => ({
      label: suggestion,
      action: () => onReplace(suggestion),
    }));
    items.push({ label: 'Add to dictionary', action: () => onAddToDictionary(word) });
    items.push({ separator: true });
    return items.concat(base);
  }

  function buildComposerClipboardItems(options) {
    const { chatInput, doc, view, handleComposerPaste } = options || {};
    const hasSelection = chatInput.selectionStart !== chatInput.selectionEnd;
    const exec = (command, value) => {
      chatInput.focus();
      doc.execCommand(command, false, value);
    };
    return [
      { label: 'Cut', shortcutHint: 'Ctrl+X', disabled: !hasSelection, action: () => exec('cut') },
      { label: 'Copy', shortcutHint: 'Ctrl+C', disabled: !hasSelection, action: () => exec('copy') },
      {
        label: 'Paste',
        shortcutHint: 'Ctrl+V',
        action: () => {
          chatInput.focus();
          return view.navigator.clipboard.readText().then((text) => {
            const pasteResult = handleComposerPaste({
              clipboardData: { getData: (type) => (type === 'text/plain' ? text : '') },
              preventDefault: () => {},
            });
            if (pasteResult && pasteResult.accepted === false) return null;
            doc.execCommand('insertText', false, text);
            return null;
          });
        },
      },
      { separator: true },
      {
        label: 'Select All',
        shortcutHint: 'Ctrl+A',
        action: () => {
          chatInput.focus();
          chatInput.select();
        },
      },
    ];
  }

  // This is not buildComposerClipboardItems: image/oversize paste gating belongs only
  // to the composer, while other opted-in text fields insert clipboard text directly.
  function buildTextFieldClipboardItems(options) {
    const { field, doc, view } = options || {};
    const hasSelection = field.selectionStart !== field.selectionEnd;
    const exec = (command, value) => {
      field.focus();
      doc.execCommand(command, false, value);
    };
    return [
      { label: 'Cut', shortcutHint: 'Ctrl+X', disabled: !hasSelection, action: () => exec('cut') },
      { label: 'Copy', shortcutHint: 'Ctrl+C', disabled: !hasSelection, action: () => exec('copy') },
      {
        label: 'Paste',
        shortcutHint: 'Ctrl+V',
        action: () => {
          field.focus();
          return view.navigator.clipboard.readText()
            .then((text) => doc.execCommand('insertText', false, text));
        },
      },
      { separator: true },
      {
        label: 'Select All',
        shortcutHint: 'Ctrl+A',
        action: () => { field.focus(); field.select(); },
      },
    ];
  }

  function resolveSpellcheckField(event, { selector = SPELLCHECK_FIELD_SELECTOR } = {}) {
    if (!event || !event.target || event.defaultPrevented === true
        || typeof event.target.closest !== 'function') return null;
    try {
      const field = event.target.closest(selector);
      if (!field || field.disabled === true || field.readOnly === true
          || typeof field.closest !== 'function'
          || field.closest('[data-ctx-menu-owner]')) return null;
      return field;
    } catch (_error) {
      return null;
    }
  }

  function bindComposerContextMenu(options) {
    const {
      chatInput,
      registerListener,
      listenerOptions,
      addCleanup = null,
      handleComposerPaste = () => null,
      appendClientLog = () => {},
      showComposerActionError = () => {},
      spellcheckApi = null,
      contextMenuHost = null,
    } = options || {};
    if (!chatInput || typeof registerListener !== 'function') return null;
    try { chatInput.setAttribute('data-ctx-menu-owner', 'composer'); } catch (_error) { /* best-effort */ }
    const doc = chatInput.ownerDocument || globalThis.document;
    const view = (doc && doc.defaultView) || globalThis;
    const canSubscribe = spellcheckApi && typeof spellcheckApi.onContext === 'function';
    const tracker = createSpellcheckContextTracker({
      subscribe: canSubscribe ? (listener) => spellcheckApi.onContext(listener) : null,
    });
    // dispose() resolves pending waiters, so a right-click racing teardown
    // would otherwise still open a menu over the detached composer.
    let torn = false;
    if (typeof addCleanup === 'function') {
      addCleanup(() => {
        torn = true;
        tracker.dispose();
        try { chatInput.removeAttribute('data-ctx-menu-owner'); } catch (_error) { /* best-effort */ }
      });
    }

    // Never throws across the preload seam: a missing method, a rejected
    // promise, or a { ok:false } result all become one bounded WARN.
    const invokeSpellcheck = (method, word) => {
      const fn = spellcheckApi && typeof spellcheckApi[method] === 'function'
        ? spellcheckApi[method]
        : null;
      if (!fn) return Promise.resolve(null);
      return Promise.resolve()
        .then(() => fn(word))
        .then((result) => {
          if (!result || result.ok !== true) {
            appendClientLog('WARN', 'composer.spellcheck_action_failed', {
              method,
              code: String((result && result.code) || 'no_result').slice(0, 64),
            });
          }
          return null;
        })
        .catch((error) => {
          appendClientLog('WARN', 'composer.spellcheck_action_failed', {
            method,
            message: String((error && error.message) || error).slice(0, 200),
          });
          return null;
        });
    };

    registerListener(chatInput, 'contextmenu', (event) => {
      // Chromium reports a context menu to the MAIN process — the only place
      // `params.misspelledWord` exists — ONLY when the DOM event is left
      // uncancelled: Blink runs `Node::DefaultEventHandler` ->
      // `ContextMenuController` from `DispatchEventPostProcess`, which is
      // skipped once `preventDefault()` has been called. Electron renders no
      // default context menu of its own, so declining to preventDefault costs
      // nothing visually and is the only way to reach the suggestions. With no
      // bridge we keep today's preventDefault so an older preload is
      // byte-identical to the menu that shipped before this change.
      if (!canSubscribe) event.preventDefault();
      const inventory = contextMenuHost
        || (typeof globalThis !== 'undefined' ? globalThis.inventory : null);
      const ctxMenu = inventory ? inventory.contextMenu : null;
      if (!ctxMenu) return;
      // The menu opens after an await, so pin the anchor to the click.
      const anchorX = event.clientX;
      const anchorY = event.clientY;
      const clickedAt = Date.now();
      const baseItems = buildComposerClipboardItems({ chatInput, doc, view, handleComposerPaste });
      const onActionError = (error, item) => {
        const itemLabel = String((item && item.label) || '').trim();
        appendClientLog('WARN', 'composer.context_menu_failed', {
          itemLabel,
          message: (error && error.message) || String(error),
        });
        showComposerActionError(
          error,
          itemLabel === 'Paste' ? 'Clipboard Paste Failed' : 'Composer Menu Failed'
        );
      };
      const open = (spellcheck) => {
        if (torn) return;
        ctxMenu.show({
          anchorX,
          anchorY,
          items: buildComposerContextMenuItems({
            spellcheck,
            baseItems,
            onReplace: (suggestion) => {
              chatInput.focus();
              return invokeSpellcheck('replaceMisspelling', suggestion);
            },
            onAddToDictionary: (word) => invokeSpellcheck('addToDictionary', word),
          }),
          onActionError,
        });
      };
      tracker.wait(clickedAt).then(open, () => open(null));
    }, listenerOptions);
    return tracker;
  }

  function bindTextFieldContextMenu(options) {
    const {
      delegateRoot, registerListener = null, listenerOptions, addCleanup = null,
      spellcheckApi = null, contextMenuHost = null, appendClientLog = () => {},
      showActionError = () => {}, isEnabled = null,
    } = options || {};
    if (!delegateRoot) return null;
    const doc = delegateRoot.ownerDocument || delegateRoot;
    const view = (doc && doc.defaultView) || globalThis;
    const canSubscribe = spellcheckApi && typeof spellcheckApi.onContext === 'function';
    const tracker = createSpellcheckContextTracker({
      subscribe: canSubscribe ? (listener) => spellcheckApi.onContext(listener) : null,
    });
    let torn = false;
    let directlyBound = false;
    const invokeSpellcheck = (method, word) => {
      const fn = spellcheckApi && typeof spellcheckApi[method] === 'function'
        ? spellcheckApi[method]
        : null;
      if (!fn) return Promise.resolve(null);
      return Promise.resolve()
        .then(() => fn(word))
        .then((result) => {
          if (!result || result.ok !== true) {
            appendClientLog('WARN', 'textfield.spellcheck_action_failed', {
              method,
              code: String((result && result.code) || 'no_result').slice(0, 64),
            });
          }
          return null;
        })
        .catch((error) => {
          appendClientLog('WARN', 'textfield.spellcheck_action_failed', {
            method,
            message: String((error && error.message) || error).slice(0, 200),
          });
          return null;
        });
    };
    const handler = (event) => {
      if (isEnabled && isEnabled() !== true) return;
      const field = resolveSpellcheckField(event);
      if (!field) return;
      // Never preventDefault(): only an uncancelled event reaches Blink's
      // ContextMenuController; keyboard events without coordinates use the field box.
      const fieldRect = typeof field.getBoundingClientRect === 'function' ? field.getBoundingClientRect() : null;
      const anchorX = event.clientX || (fieldRect ? fieldRect.left + 24 : event.clientX);
      const anchorY = event.clientY || (fieldRect ? fieldRect.bottom : event.clientY);
      const clickedAt = Date.now();
      const baseItems = buildTextFieldClipboardItems({ field, doc, view });
      const onActionError = (error, item) => {
        const itemLabel = String((item && item.label) || '').trim();
        appendClientLog('WARN', 'textfield.context_menu_failed', {
          itemLabel,
          message: (error && error.message) || String(error),
        });
        showActionError(error, itemLabel === 'Paste' ? 'Clipboard Paste Failed' : 'Text Field Menu Failed');
      };
      const open = (spellcheck) => {
        if (torn || field.isConnected === false) return;
        const inventory = contextMenuHost
          || (typeof globalThis !== 'undefined' ? globalThis.inventory : null);
        const ctxMenu = inventory ? inventory.contextMenu : null;
        if (!ctxMenu) return;
        ctxMenu.show({
          anchorX,
          anchorY,
          items: buildComposerContextMenuItems({
            spellcheck,
            baseItems,
            onReplace: (suggestion) => {
              field.focus();
              return invokeSpellcheck('replaceMisspelling', suggestion);
            },
            onAddToDictionary: (word) => invokeSpellcheck('addToDictionary', word),
          }),
          onActionError,
        });
      };
      tracker.wait(clickedAt).then(open, () => open(null));
    };
    if (typeof registerListener === 'function') {
      registerListener(delegateRoot, 'contextmenu', handler, listenerOptions);
    } else {
      delegateRoot.addEventListener('contextmenu', handler, listenerOptions);
      directlyBound = true;
    }
    const dispose = () => {
      if (torn) return;
      torn = true;
      if (directlyBound) delegateRoot.removeEventListener('contextmenu', handler, listenerOptions);
      tracker.dispose();
    };
    if (typeof addCleanup === 'function') addCleanup(dispose);
    return { dispose };
  }

  function bindInteractiveComposerEvents(options) {
    const {
      composerWrap,
      // Delegate interactive-panel events from the timeline root; tool-toggle events remain on composerWrap.
      // Fall back to composerWrap when no timeline root is supplied.
      interactiveDelegateRoot,
      registerListener,
      listenerOptions,
      handleInteractiveOptionSelect,
      handleInteractiveOtherConfirm,
      handleInteractiveSubmit,
      handleInteractiveSkip,
      handleInteractiveSkipQuestion,
      handleInteractiveSkipAll,
      handleInteractiveOtherInputChange,
      handleComposerToggleChange,
      showComposerActionError,
      state,
    } = options || {};

    if (typeof registerListener !== 'function') {
      return;
    }

    const delegateRoot = interactiveDelegateRoot || composerWrap;

    if (delegateRoot) {
      registerListener(delegateRoot, 'click', (event) => {
        const interactiveOption = event.target.closest('[data-interactive-option]');
        if (interactiveOption) {
          event.preventDefault();
          handleInteractiveOptionSelect(
            interactiveOption.dataset.batchId,
            interactiveOption.dataset.questionId,
            interactiveOption.dataset.optionId
          );
          return;
        }

        const interactiveOtherConfirm = event.target.closest('[data-interactive-other-confirm]');
        if (interactiveOtherConfirm) {
          event.preventDefault();
          handleInteractiveOtherConfirm(
            interactiveOtherConfirm.dataset.batchId,
            interactiveOtherConfirm.dataset.questionId
          );
          return;
        }

        const interactiveSubmit = event.target.closest('[data-interactive-submit]');
        if (interactiveSubmit) {
          event.preventDefault();
          handleInteractiveSubmit(interactiveSubmit.dataset.batchId).catch((error) => {
            showComposerActionError(error, 'Interactive Submit Failed');
          });
          return;
        }

        const interactiveSkip = event.target.closest('[data-interactive-skip]');
        if (interactiveSkip) {
          event.preventDefault();
          handleInteractiveSkip(interactiveSkip.dataset.batchId).catch((error) => {
            showComposerActionError(error, 'Interactive Skip Failed');
          });
          return;
        }

        const interactiveSkipQuestion = event.target.closest('[data-interactive-skip-question]');
        if (interactiveSkipQuestion) {
          event.preventDefault();
          handleInteractiveSkipQuestion(
            interactiveSkipQuestion.dataset.batchId,
            interactiveSkipQuestion.dataset.questionId
          );
          return;
        }

        const interactiveSkipAll = event.target.closest('[data-interactive-skip-all]');
        if (interactiveSkipAll) {
          event.preventDefault();
          handleInteractiveSkipAll(interactiveSkipAll.dataset.batchId);
          return;
        }

      }, listenerOptions);

      registerListener(delegateRoot, 'input', (event) => {
        const interactiveOtherInput = event.target.closest('[data-interactive-other-input]');
        if (!interactiveOtherInput) {
          return;
        }
        handleInteractiveOtherInputChange(
          interactiveOtherInput.dataset.batchId,
          interactiveOtherInput.dataset.questionId,
          interactiveOtherInput.value
        );
      }, listenerOptions);

      registerListener(delegateRoot, 'keydown', (event) => {
        const interactiveOtherInput = event.target.closest('[data-interactive-other-input]');
        if (
          interactiveOtherInput
          && event.key === 'Enter'
          && !event.shiftKey
          // IME composition guard: don't confirm on the Enter that
          // commits/selects an IME candidate (keyCode 229 is the legacy
          // commit-keystroke signal).
          && event.isComposing !== true
          && event.keyCode !== 229
        ) {
          event.preventDefault();
          handleInteractiveOtherConfirm(
            interactiveOtherInput.dataset.batchId,
            interactiveOtherInput.dataset.questionId
          );
        }
      }, listenerOptions);
    }

    // inv-toggle-change carries the composer's tool toggles, not an
    // interactive-panel affordance — it stays bound to composerWrap.
    if (composerWrap) {
      registerListener(composerWrap, 'inv-toggle-change', (event) => {
        handleComposerToggleChange(event);
      }, listenerOptions);

      // Rail chips (Tools, Model): each toggles its popover. The chips are
      // innerHTML-rendered into their slots, so delegation (not direct
      // binding) is required; aria-controls names the popover to toggle.
      registerListener(composerWrap, 'click', (event) => {
        const planMeter = composerWrap.ownerDocument?.defaultView?.rendererPlanUsageMeter || globalThis.rendererPlanUsageMeter;
        if (planMeter?.handleClick?.({ event, composerWrap, state })) return;
        if (globalThis.rendererContextMeterDetails?.handleClick?.({ event, composerWrap, state })) {
          return;
        }
        const chip = event.target.closest('[data-inv-chip="composer-tools"], [data-inv-chip="composer-model"]');
        if (chip) {
          const inv = typeof globalThis !== 'undefined' ? globalThis.inventory : null;
          const popoverApi = inv && inv.popover;
          const doc = composerWrap.ownerDocument;
          const popoverId = chip.getAttribute('aria-controls') || '';
          const popoverEl = doc && popoverId ? doc.getElementById(popoverId) : null;
          if (popoverApi && popoverEl) {
            popoverApi.toggle(popoverEl, { trigger: chip });
          }
          return;
        }

        // Full-row clickability for the tools popover: a click anywhere on a
        // toggle row (icon, label, empty space) flips its switch. Clicks that
        // land on the switch button itself already flow through the
        // document-level toggle handler, so bail to avoid a double toggle.
        const row = event.target.closest('.inv-composer-toggle-item');
        if (!row || event.target.closest('[data-inv-toggle]')) {
          return;
        }
        const track = row.querySelector('[data-inv-toggle]');
        if (track && !track.disabled) {
          track.click();
        }
      }, listenerOptions);
    }
  }

  return {
    SPELLCHECK_FIELD_SELECTOR,
    SPELLCHECK_SUGGESTION_LIMIT,
    SPELLCHECK_WAIT_MS,
    bindComposerContextMenu,
    bindTextFieldContextMenu,
    bindInteractiveComposerEvents,
    buildComposerClipboardItems,
    buildComposerContextMenuItems,
    buildTextFieldClipboardItems,
    createSpellcheckContextTracker,
    normalizeSpellcheckContext,
    resolveSpellcheckField,
  };
});
