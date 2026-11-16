/**
 * renderer/inventory/search-bar.js
 *
 * Inline non-modal find field primitive for Ctrl+F in-conversation search.
 * Row 156: it renders as one surface in the pane's session bar. Owns the only
 * raw HTML primitives the search feature needs:
 *   - one <input type="text"> for the query (placeholder "Find in this chat")
 *   - five <button>s: case-sensitivity toggle, whole-word toggle, prev, next,
 *     close (glyphs: "Aa", an underlined "ab", two chevrons, a cross)
 *   - one <output> for the "n of m" count (aria-live="polite"), empty while
 *     the field is empty
 *
 * The chat-side wrapper composes high-level state (matches, current index,
 * scan logic) and consumes these events:
 *   'input'       (query: string)         — every keystroke; wrapper debounces
 *   'next'        ()                      — next button or Enter on input
 *   'prev'        ()                      — prev button or Shift+Enter on input
 *   'close'       ()                      — close button or Esc on input
 *   'toggle-case' (newValue: boolean)     — Aa toggle pressed, or Alt+C on input
 *   'toggle-word' (newValue: boolean)     — whole-word toggle pressed, or Alt+W on input
 *
 * createFindToggle(doc, label, title) builds the magnifier button the chat
 * overlay mounts in a pane's session bar (CSS class chat-find-toggle).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/string-utils'));
    return;
  }
  root.inventorySearchBar = factory(root, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, stringUtils) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var escapeHtml = stringUtils && stringUtils.escapeHtml;
  var sanitizeToken = stringUtils && stringUtils.sanitizeToken;
  if (typeof escapeHtml !== 'function' || typeof sanitizeToken !== 'function') {
    throw new Error('inventorySearchBar: renderer/shared/string-utils.js must load before this module');
  }

  var FIND_SHAPE = 'viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
  var GLYPH_PREV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>';
  var GLYPH_NEXT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
  var GLYPH_CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>';

  // The class follows the action: chat-search-bar-<action>, plus
  // chat-search-bar-toggle for the two option toggles.
  function button(action, label, title, content, extraAttrs) {
    var toggle = action.indexOf('toggle-') === 0 ? ' chat-search-bar-toggle' : '';
    return '<button'
      + ' type="button"'
      + ' class="chat-search-bar-button' + toggle + ' chat-search-bar-' + action + '"'
      + ' data-search-action="' + action + '"'
      + (extraAttrs || '')
      + ' aria-label="' + escapeHtml(label) + '"'
      + ' title="' + escapeHtml(title) + '"'
      + '>' + content + '</button>';
  }

  function buildBarHtml(ids, keyShortcuts) {
    var matchCase = jt('inventory.searchBar.matchCase', 'Match case');
    var wholeWord = jt('inventory.searchBar.wholeWord', 'Whole word');
    return ''
      + '<div class="chat-search-bar" role="search" aria-label="' + escapeHtml(jt('inventory.searchBar.conversationSearch', 'Conversation search')) + '">'
      +   '<svg class="chat-search-bar-glyph" ' + FIND_SHAPE
      +   '<input'
      +     ' type="text"'
      +     ' class="chat-search-bar-input"'
      +     ' id="' + escapeHtml(ids.input) + '"'
      +     ' placeholder="' + escapeHtml(jt('inventory.searchBar.placeholder', 'Find in this chat')) + '"'
      +     ' aria-label="' + escapeHtml(jt('inventory.searchBar.inputLabel', 'Search messages in this conversation')) + '"'
      +     ' aria-controls="' + escapeHtml(ids.count) + '"'
      +     ' aria-keyshortcuts="' + escapeHtml(keyShortcuts) + '"'
      +     ' autocomplete="off"'
      +     ' spellcheck="false"'
      +     ' data-search-skip="true"'
      +   ' />'
      +   '<output'
      +     ' class="chat-search-bar-count"'
      +     ' id="' + escapeHtml(ids.count) + '"'
      +     ' aria-live="polite"'
      +     ' aria-atomic="true"'
      +     ' for="' + escapeHtml(ids.input) + '"'
      +   '></output>'
      +   '<div class="chat-search-bar-toggles" role="group" aria-label="' + escapeHtml(jt('inventory.searchBar.optionsLabel', 'Search options')) + '">'
      +     button('toggle-case', matchCase,
              jt('inventory.searchBar.matchCaseTitle', 'Match case (Alt+C)'), 'Aa', ' aria-pressed="false"')
      +     button('toggle-word', wholeWord,
              jt('inventory.searchBar.wholeWordTitle', 'Whole word (Alt+W)'), '<span class="chat-search-bar-word-glyph" aria-hidden="true">ab</span>', ' aria-pressed="false"')
      +   '</div>'
      +   '<div class="chat-search-bar-nav" role="group" aria-label="' + escapeHtml(jt('inventory.searchBar.matchNavigation', 'Match navigation')) + '">'
      +     button('prev', jt('inventory.searchBar.previousMatch', 'Previous match'),
              jt('inventory.searchBar.previousMatchTitle', 'Previous match (Shift+Enter)'), GLYPH_PREV, ' disabled')
      +     button('next', jt('inventory.searchBar.nextMatch', 'Next match'),
              jt('inventory.searchBar.nextMatchTitle', 'Next match (Enter)'), GLYPH_NEXT, ' disabled')
      +   '</div>'
      +   button('close', jt('inventory.searchBar.closeSearch', 'Close search'),
            jt('inventory.searchBar.closeSearchTitle', 'Close search (Esc)'), GLYPH_CLOSE)
      + '</div>';
  }

  function createSearchBar(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var hostId = sanitizeToken(options.hostId, 'inv-search-bar');
    // extraKeys: the host's own document keys (the chat overlay: F3, Shift+F3).
    var keyShortcuts = ['Enter', 'Shift+Enter', 'Escape'].concat(options.extraKeys || [], ['Alt+C', 'Alt+W']).join(' ');
    var inputId = hostId + '-input';
    var countId = hostId + '-count';

    var listeners = Object.create(null);
    var rootEl = null;
    var inputEl = null;
    var countEl = null;
    var caseToggleEl = null;
    var wordToggleEl = null;
    var navButtons = [];
    var caseSensitive = false;
    var wholeWord = false;

    function emit(event, value) {
      var subs = listeners[event];
      if (!subs || !subs.length) return;
      for (var i = 0; i < subs.length; i++) {
        try { subs[i](value); } catch (_e) { /* swallow listener failure */ }
      }
    }

    function on(event, callback) {
      if (typeof callback !== 'function') return function () {};
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);
      return function off() {
        var subs = listeners[event];
        if (!subs) return;
        var idx = subs.indexOf(callback);
        if (idx >= 0) subs.splice(idx, 1);
      };
    }

    function toggleCase() {
      caseSensitive = !caseSensitive;
      if (caseToggleEl) caseToggleEl.setAttribute('aria-pressed', caseSensitive ? 'true' : 'false');
      emit('toggle-case', caseSensitive);
    }

    function toggleWord() {
      wholeWord = !wholeWord;
      if (wordToggleEl) wordToggleEl.setAttribute('aria-pressed', wholeWord ? 'true' : 'false');
      emit('toggle-word', wholeWord);
    }

    function handleInput() {
      if (!inputEl) return;
      emit('input', inputEl.value);
    }

    // On the whole bar: Esc and Alt+C / Alt+W from any of its controls; Enter
    // steps only from the input (on a button it is that button's click).
    function handleKeydown(event) {
      var key = String(event.key || '');
      if (key === 'Enter' && event.target === inputEl) {
        event.preventDefault();
        emit(event.shiftKey ? 'prev' : 'next');
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        emit('close');
        return;
      }
      // Matched on the physical key too, for layouts that type another letter.
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        var lower = key.toLowerCase();
        if (lower === 'c' || event.code === 'KeyC') { event.preventDefault(); toggleCase(); return; }
        if (lower === 'w' || event.code === 'KeyW') { event.preventDefault(); toggleWord(); }
      }
    }

    function handleClick(event) {
      var target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-search-action]')
        : null;
      if (!target || !rootEl || !rootEl.contains(target) || target.disabled) return;
      var action = target.getAttribute('data-search-action');
      if (action === 'toggle-case') toggleCase();
      else if (action === 'toggle-word') toggleWord();
      else emit(action); // next, prev, close
    }

    function ensureBuilt() {
      if (rootEl || !doc) return rootEl;
      var wrapper = doc.createElement('div');
      wrapper.innerHTML = buildBarHtml({ input: inputId, count: countId }, keyShortcuts);
      rootEl = wrapper.firstElementChild;
      inputEl = rootEl.querySelector('.chat-search-bar-input');
      countEl = rootEl.querySelector('.chat-search-bar-count');
      caseToggleEl = rootEl.querySelector('.chat-search-bar-toggle-case');
      wordToggleEl = rootEl.querySelector('.chat-search-bar-toggle-word');
      navButtons = Array.from(rootEl.querySelectorAll('.chat-search-bar-prev, .chat-search-bar-next'));
      if (inputEl) {
        inputEl.addEventListener('input', handleInput);
      }
      rootEl.addEventListener('keydown', handleKeydown);
      rootEl.addEventListener('click', handleClick);
      return rootEl;
    }

    function mount(hostEl) {
      if (!hostEl || typeof hostEl.appendChild !== 'function') return;
      ensureBuilt();
      if (!rootEl) return;
      hostEl.appendChild(rootEl);
    }

    function unmount() {
      if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    }

    function setQuery(value) {
      ensureBuilt();
      if (!inputEl) return;
      var next = String(value == null ? '' : value);
      if (inputEl.value !== next) inputEl.value = next;
    }

    function getQuery() {
      return inputEl ? inputEl.value : '';
    }

    // The count says nothing until there is a query: an empty field shows no
    // count (not "No matches") and previous/next stay disabled.
    function setMatchInfo(current, total, options) {
      ensureBuilt();
      if (!countEl) return;
      var totalNum = Number(total) || 0;
      var hasQuery = Boolean(String(getQuery() || '').trim());
      var params = { current: Math.max(1, Math.min(totalNum, Number(current) || 0)), total: totalNum };
      // Capped: the list holds only the first matches, and the count says so.
      var capped = hasQuery && totalNum > 0 && Boolean(options && options.truncated === true);
      var nextText = '';
      if (capped) nextText = jt('inventory.searchBar.matchCountCappedPlus', '{current} of {total}+', params);
      else if (hasQuery && totalNum > 0) nextText = jt('inventory.searchBar.matchCount', '{current} of {total}', params);
      else if (hasQuery) nextText = jt('inventory.searchBar.noMatches', 'No matches');
      if (capped) countEl.setAttribute('title', jt('inventory.searchBar.matchCountCappedTitle', 'Only the first {total} matches are listed. Narrow the search to reach the rest.', params));
      else countEl.removeAttribute('title');
      // Skip identical writes — prevents aria-live re-announcing the same
      // count and avoids redundant DOM mutation when the user holds Enter.
      if (countEl.textContent !== nextText) countEl.textContent = nextText;
      var disable = !hasQuery || totalNum <= 0;
      navButtons.forEach(function syncNav(node) {
        if (node.disabled !== disable) node.disabled = disable;
      });
    }

    function getCaseSensitive() { return caseSensitive; }
    function getWholeWord() { return wholeWord; }

    function focusInput(selectAll) {
      ensureBuilt();
      if (!inputEl) return;
      inputEl.focus();
      if (selectAll) inputEl.select();
    }

    function dispose() {
      if (inputEl) {
        inputEl.removeEventListener('input', handleInput);
      }
      if (rootEl) {
        rootEl.removeEventListener('click', handleClick);
        rootEl.removeEventListener('keydown', handleKeydown);
        if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      }
      rootEl = null;
      inputEl = null;
      countEl = null;
      caseToggleEl = null;
      wordToggleEl = null;
      navButtons = [];
      listeners = Object.create(null);
    }

    return {
      mount: mount,
      unmount: unmount,
      setQuery: setQuery,
      getQuery: getQuery,
      setMatchInfo: setMatchInfo,
      getCaseSensitive: getCaseSensitive,
      getWholeWord: getWholeWord,
      focusInput: focusInput,
      on: on,
      dispose: dispose,
    };
  }

  function createFindToggle(doc, label, title) {
    var toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chat-timeline-utility-button chat-find-toggle';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-keyshortcuts', 'Control+F');
    toggle.title = title;
    toggle.innerHTML = '<svg ' + FIND_SHAPE;
    return toggle;
  }

  return { createSearchBar: createSearchBar, createFindToggle: createFindToggle };
});
