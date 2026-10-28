/* renderer/features/renderer-ide-terminal-find.js - the find bar of the Workspace PTY
 * terminal (row 82 T1). A bar inside the panel (built from the inventory text-field and
 * action-button primitives) drives xterm's SearchAddon: Ctrl+F while the terminal has focus
 * opens it (pre-filled from a one-line selection), typing searches incrementally,
 * Enter/F3 = next, Shift+Enter/Shift+F3 = previous, Esc closes and refocuses the terminal.
 *
 * The bar keeps its own state, so the panel's markup rebuild (a fresh host element) just
 * re-renders it. Match colours come from the --ide-terminal-find-match(-active) tokens on
 * the terminal host. Without a SearchAddon the bar never opens and Ctrl+F reaches the shell. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalFind = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const PREFILL_MAX_CHARS = 200;
  const FALLBACK_MATCH = '#515c6a';
  const FALLBACK_ACTIVE = '#a8ac94';

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    return typeof require === 'function' ? require(requirePath) : null;
  }

  // xterm wants #RRGGBB for match backgrounds: accept #rgb, #rrggbb and rgb(r, g, b).
  function toHexColor(value, fallback) {
    const text = String(value || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(text);
    if (m) {
      return '#' + m[1].split('').map((ch) => ch + ch).join('').toLowerCase();
    }
    if (/^#[0-9a-f]{6}$/i.test(text)) {
      return text.toLowerCase();
    }
    m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(text);
    if (m) {
      return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
    }
    return fallback;
  }

  // ctx: { windowRef, getFindHost, getThemeHost, getSearchAddon, getTerminal,
  //        focusTerminal, logIgnoredError }
  const INPUT_DEBOUNCE_MS = 120;

  function createTerminalFind(ctx) {
    const windowRef = ctx.windowRef;
    const getFindHost = typeof ctx.getFindHost === 'function' ? ctx.getFindHost : () => null;
    const getThemeHost = typeof ctx.getThemeHost === 'function' ? ctx.getThemeHost : () => null;
    const getSearchAddon = typeof ctx.getSearchAddon === 'function' ? ctx.getSearchAddon : () => null;
    const getTerminal = typeof ctx.getTerminal === 'function' ? ctx.getTerminal : () => null;
    const focusTerminal = typeof ctx.focusTerminal === 'function' ? ctx.focusTerminal : noop;
    const logIgnoredError = typeof ctx.logIgnoredError === 'function' ? ctx.logIgnoredError : noop;
    // Typing re-searches the whole buffer (25,000 lines at the scrollback ceiling), so the
    // input is debounced; Enter / F3 search at once.
    const timers = ctx.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
    let inputTimer = null;
    const textField = resolveModule('inventoryTextField', '../inventory/text-field');
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');

    let open = false;
    let query = '';
    let countText = '';
    let lastResults = null;
    let boundHost = null;
    let inputEl = null;
    let countEl = null;
    let subscribedAddon = null;

    const isAvailable = () => Boolean(getSearchAddon() && textField && actionButton && getFindHost());

    function buildMarkup() {
      const button = (action, glyph, label, title) => actionButton({
        plain: true,
        className: 'ide-terminal-find__button',
        ariaLabel: label,
        title,
        trustedHtml: glyph,
        dataset: { 'ide-terminal-find-action': action },
      });
      return textField({
        className: 'ide-terminal-find__input',
        ariaLabel: jt('ide.terminal.findInputLabel', 'Find in terminal'),
        placeholder: jt('ide.terminal.findPlaceholder', 'Find'),
        value: query,
        spellcheck: false,
        dataset: { 'ide-terminal-find-input': '' },
      })
        + '<span class="ide-terminal-find__count" data-ide-terminal-find-count aria-live="polite"></span>'
        + button('prev', '↑', jt('ide.terminal.findPrevious', 'Previous match'), jt('ide.terminal.findPreviousTitle', 'Previous match (Shift+Enter)'))
        + button('next', '↓', jt('ide.terminal.findNext', 'Next match'), jt('ide.terminal.findNextTitle', 'Next match (Enter)'))
        + button('close', '×', jt('ide.terminal.findClose', 'Close find'), jt('ide.terminal.findCloseTitle', 'Close find (Esc)'));
    }

    function paintCount() {
      if (countEl) {
        countEl.textContent = countText;
      }
    }

    function setCount(text) {
      countText = text;
      paintCount();
    }

    function describeResults(found) {
      if (!query) {
        return '';
      }
      if (!found || (lastResults && lastResults.resultCount === 0)) {
        return jt('ide.terminal.findNoResults', 'No results');
      }
      if (!lastResults) {
        return '';
      }
      return lastResults.resultIndex >= 0
        ? jt('ide.terminal.findCount', '{index} of {count}', { index: lastResults.resultIndex + 1, count: lastResults.resultCount })
        : jt('ide.terminal.findCountMany', '{count}+ results', { count: lastResults.resultCount });
    }

    function subscribeResults(addon) {
      if (subscribedAddon === addon || typeof addon?.onDidChangeResults !== 'function') {
        return;
      }
      subscribedAddon = addon;
      try {
        addon.onDidChangeResults((event) => {
          lastResults = event && typeof event === 'object' ? event : null;
        });
      } catch (error) { logIgnoredError('find_results', error); }
    }

    function decorations() {
      let read = () => '';
      const host = getThemeHost();
      if (host && typeof windowRef?.getComputedStyle === 'function') {
        try {
          const styles = windowRef.getComputedStyle(host);
          read = (name) => styles.getPropertyValue(name);
        } catch (error) { logIgnoredError('find_colors', error); }
      }
      const match = toHexColor(read('--ide-terminal-find-match'), FALLBACK_MATCH);
      const active = toHexColor(read('--ide-terminal-find-match-active'), FALLBACK_ACTIVE);
      return {
        matchBackground: match,
        matchOverviewRuler: match,
        activeMatchBackground: active,
        activeMatchBorder: active,
        activeMatchColorOverviewRuler: active,
      };
    }

    function clearDecorations() {
      const addon = getSearchAddon();
      if (addon && typeof addon.clearDecorations === 'function') {
        try { addon.clearDecorations(); } catch (error) { logIgnoredError('find_clear', error); }
      }
    }

    // direction 'next' | 'prev'; incremental keeps the current match while typing.
    function search(direction, incremental) {
      const addon = getSearchAddon();
      if (!addon) {
        return false;
      }
      subscribeResults(addon);
      lastResults = null;
      if (!query) {
        clearDecorations();
        setCount('');
        return false;
      }
      let found = false;
      try {
        const options = { incremental: incremental === true && direction === 'next', decorations: decorations() };
        found = (direction === 'prev' ? addon.findPrevious(query, options) : addon.findNext(query, options)) === true;
      } catch (error) { logIgnoredError('find_search', error); }
      setCount(describeResults(found));
      return found;
    }

    function handleInputKey(event) {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key || '').toLowerCase() === 'f') {
        event.preventDefault();
        inputEl?.select?.();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Enter' || event.key === 'F3') {
        event.preventDefault();
        event.stopPropagation();
        search(event.shiftKey ? 'prev' : 'next', false);
      }
    }

    function bind(host) {
      host.innerHTML = buildMarkup();
      inputEl = host.querySelector('[data-ide-terminal-find-input]');
      countEl = host.querySelector('[data-ide-terminal-find-count]');
      boundHost = host;
      paintCount();
      inputEl?.addEventListener('input', () => {
        query = String(inputEl.value || '');
        if (inputTimer !== null) timers.clearTimeout(inputTimer);
        inputTimer = timers.setTimeout(() => {
          inputTimer = null;
          search('next', true);
        }, INPUT_DEBOUNCE_MS);
      });
      inputEl?.addEventListener('keydown', handleInputKey);
      host.addEventListener('click', (event) => {
        const action = event.target?.closest?.('[data-ide-terminal-find-action]')?.dataset?.ideTerminalFindAction;
        if (action === 'close') {
          close();
        } else if (action === 'next' || action === 'prev') {
          search(action, false);
        }
      });
    }

    // The panel renders on every IDE pass and rebuilds its markup now and then: a new
    // host element gets the bar re-rendered from the state kept here.
    function syncHost() {
      const host = getFindHost();
      if (!host) {
        boundHost = null;
        inputEl = null;
        countEl = null;
        return;
      }
      if (host !== boundHost) {
        bind(host);
      }
      host.hidden = !open;
    }

    function selectionPrefill() {
      const term = getTerminal();
      try {
        if (term && typeof term.hasSelection === 'function' && term.hasSelection()) {
          const text = String(term.getSelection() || '').trim();
          if (text && text.length <= PREFILL_MAX_CHARS && !/[\r\n]/.test(text)) {
            return text;
          }
        }
      } catch (error) { logIgnoredError('find_prefill', error); }
      return '';
    }

    function show() {
      if (!isAvailable()) {
        return false;
      }
      const prefill = selectionPrefill();
      if (prefill) {
        query = prefill;
      }
      open = true;
      syncHost();
      if (inputEl) {
        inputEl.value = query;
        inputEl.focus?.();
        inputEl.select?.();
      }
      if (prefill) {
        search('next', true);
      }
      return true;
    }

    function close() {
      if (!open) {
        return;
      }
      open = false;
      if (inputTimer !== null) { timers.clearTimeout(inputTimer); inputTimer = null; }
      if (boundHost) {
        boundHost.hidden = true;
      }
      clearDecorations();
      focusTerminal();
    }

    // The find half of the terminal's custom key handler. Returns true when the
    // event belongs to the find bar (xterm must not also handle it); acts on keydown only.
    function handleTerminalKey(event) {
      const key = String(event.key || '');
      const isDown = event.type === 'keydown';
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && key.toLowerCase() === 'f') {
        if (!isAvailable()) {
          return false;
        }
        if (isDown) {
          event.preventDefault();
          show();
        }
        return true;
      }
      if (!open) {
        return false;
      }
      if (key === 'F3') {
        if (isDown) {
          event.preventDefault();
          search(event.shiftKey ? 'prev' : 'next', false);
        }
        return true;
      }
      if (key === 'Escape') {
        if (isDown) {
          event.preventDefault();
          close();
        }
        return true;
      }
      return false;
    }

    function dispose() {
      if (open) {
        clearDecorations();
      }
      open = false;
      boundHost = null;
      inputEl = null;
      countEl = null;
      subscribedAddon = null;
    }

    return {
      close,
      dispose,
      getCountText: () => countText,
      handleTerminalKey,
      isOpen: () => open,
      next: () => search('next', false),
      prev: () => search('prev', false),
      show,
      syncHost,
    };
  }

  return {
    createTerminalFind,
    toHexColor,
  };
});
