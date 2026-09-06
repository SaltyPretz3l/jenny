/**
 * renderer/inventory/search-bar.js
 *
 * Inline non-modal search bar primitive for Ctrl+F in-conversation search.
 * Owns the only raw HTML primitives the search
 * feature needs:
 *   - one <input type="text"> for the query
 *   - five <button>s: prev, next, close, case-sensitivity toggle,
 *     whole-word toggle
 *   - one <output> for the "n of m" badge (aria-live="polite")
 *
 * The chat-side wrapper composes high-level state (matches, current index,
 * scan logic) and consumes these events:
 *   'input'       (query: string)         — every keystroke; wrapper debounces
 *   'next'        ()                      — next button or Enter on input
 *   'prev'        ()                      — prev button or Shift+Enter on input
 *   'close'       ()                      — close button or Esc on input
 *   'toggle-case' (newValue: boolean)     — Aa toggle pressed
 *   'toggle-word' (newValue: boolean)     — \b toggle pressed
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/string-utils'));
    return;
  }
  root.inventorySearchBar = factory(root, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, stringUtils) {
  'use strict';

  var escapeHtml = stringUtils && stringUtils.escapeHtml;
  var sanitizeToken = stringUtils && stringUtils.sanitizeToken;
  if (typeof escapeHtml !== 'function' || typeof sanitizeToken !== 'function') {
    throw new Error('inventorySearchBar: renderer/shared/string-utils.js must load before this module');
  }

  function buildBarHtml(ids) {
    return ''
      + '<div class="chat-search-bar" role="search" aria-label="Conversation search">'
      +   '<input'
      +     ' type="text"'
      +     ' class="chat-search-bar-input"'
      +     ' id="' + escapeHtml(ids.input) + '"'
      +     ' aria-label="Search messages in this conversation"'
      +     ' aria-controls="' + escapeHtml(ids.count) + '"'
      +     ' aria-keyshortcuts="Enter Shift+Enter Escape"'
      +     ' autocomplete="off"'
      +     ' spellcheck="false"'
      +     ' data-search-skip="true"'
      +   ' />'
      +   '<div class="chat-search-bar-toggles" role="group" aria-label="Search options">'
      +     '<button'
      +       ' type="button"'
      +       ' class="chat-search-bar-button chat-search-bar-toggle chat-search-bar-toggle-case"'
      +       ' data-search-action="toggle-case"'
      +       ' aria-pressed="false"'
      +       ' aria-label="Match case"'
      +       ' title="Match case"'
      +     '>Aa</button>'
      +     '<button'
      +       ' type="button"'
      +       ' class="chat-search-bar-button chat-search-bar-toggle chat-search-bar-toggle-word"'
      +       ' data-search-action="toggle-word"'
      +       ' aria-pressed="false"'
      +       ' aria-label="Whole word"'
      +       ' title="Whole word"'
      +     '>“W”</button>'
      +   '</div>'
      +   '<output'
      +     ' class="chat-search-bar-count"'
      +     ' id="' + escapeHtml(ids.count) + '"'
      +     ' aria-live="polite"'
      +     ' aria-atomic="true"'
      +     ' for="' + escapeHtml(ids.input) + '"'
      +   '>No matches</output>'
      +   '<div class="chat-search-bar-nav" role="group" aria-label="Match navigation">'
      +     '<button'
      +       ' type="button"'
      +       ' class="chat-search-bar-button chat-search-bar-prev"'
      +       ' data-search-action="prev"'
      +       ' aria-label="Previous match"'
      +       ' title="Previous match (Shift+Enter)"'
      +     '>↑</button>'
      +     '<button'
      +       ' type="button"'
      +       ' class="chat-search-bar-button chat-search-bar-next"'
      +       ' data-search-action="next"'
      +       ' aria-label="Next match"'
      +       ' title="Next match (Enter)"'
      +     '>↓</button>'
      +   '</div>'
      +   '<button'
      +     ' type="button"'
      +     ' class="chat-search-bar-button chat-search-bar-close"'
      +     ' data-search-action="close"'
      +     ' aria-label="Close search"'
      +     ' title="Close search (Esc)"'
      +   '>×</button>'
      + '</div>';
  }

  function createSearchBar(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var hostId = sanitizeToken(options.hostId, 'inv-search-bar');
    var inputId = hostId + '-input';
    var countId = hostId + '-count';

    var listeners = Object.create(null);
    var rootEl = null;
    var inputEl = null;
    var countEl = null;
    var caseToggleEl = null;
    var wordToggleEl = null;
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

    function handleInput() {
      if (!inputEl) return;
      emit('input', inputEl.value);
    }

    function handleKeydown(event) {
      var key = String(event.key || '');
      if (key === 'Enter') {
        event.preventDefault();
        emit(event.shiftKey ? 'prev' : 'next');
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        emit('close');
      }
    }

    function handleClick(event) {
      var target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-search-action]')
        : null;
      if (!target || !rootEl || !rootEl.contains(target)) return;
      var action = target.getAttribute('data-search-action');
      if (action === 'next') { emit('next'); return; }
      if (action === 'prev') { emit('prev'); return; }
      if (action === 'close') { emit('close'); return; }
      if (action === 'toggle-case') {
        caseSensitive = !caseSensitive;
        if (caseToggleEl) caseToggleEl.setAttribute('aria-pressed', caseSensitive ? 'true' : 'false');
        emit('toggle-case', caseSensitive);
        return;
      }
      if (action === 'toggle-word') {
        wholeWord = !wholeWord;
        if (wordToggleEl) wordToggleEl.setAttribute('aria-pressed', wholeWord ? 'true' : 'false');
        emit('toggle-word', wholeWord);
      }
    }

    function ensureBuilt() {
      if (rootEl || !doc) return rootEl;
      var wrapper = doc.createElement('div');
      wrapper.innerHTML = buildBarHtml({ input: inputId, count: countId });
      rootEl = wrapper.firstElementChild;
      inputEl = rootEl.querySelector('.chat-search-bar-input');
      countEl = rootEl.querySelector('.chat-search-bar-count');
      caseToggleEl = rootEl.querySelector('.chat-search-bar-toggle-case');
      wordToggleEl = rootEl.querySelector('.chat-search-bar-toggle-word');
      if (inputEl) {
        inputEl.addEventListener('input', handleInput);
        inputEl.addEventListener('keydown', handleKeydown);
      }
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

    function setMatchInfo(current, total, options) {
      ensureBuilt();
      if (!countEl) return;
      var totalNum = Number(total) || 0;
      var nextText;
      if (totalNum <= 0) {
        nextText = 'No matches';
      } else {
        var currentNum = Math.max(1, Math.min(totalNum, Number(current) || 0));
        nextText = currentNum + ' of ' + totalNum + (options && options.truncated === true ? '+' : '');
      }
      // Skip identical writes — prevents aria-live re-announcing the same
      // count and avoids redundant DOM mutation when the user holds Enter.
      if (countEl.textContent !== nextText) countEl.textContent = nextText;
    }

    function setCaseSensitive(value) {
      ensureBuilt();
      caseSensitive = !!value;
      if (caseToggleEl) caseToggleEl.setAttribute('aria-pressed', caseSensitive ? 'true' : 'false');
    }

    function setWholeWord(value) {
      ensureBuilt();
      wholeWord = !!value;
      if (wordToggleEl) wordToggleEl.setAttribute('aria-pressed', wholeWord ? 'true' : 'false');
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
        inputEl.removeEventListener('keydown', handleKeydown);
      }
      if (rootEl) {
        rootEl.removeEventListener('click', handleClick);
        if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      }
      rootEl = null;
      inputEl = null;
      countEl = null;
      caseToggleEl = null;
      wordToggleEl = null;
      listeners = Object.create(null);
    }

    return {
      mount: mount,
      unmount: unmount,
      setQuery: setQuery,
      getQuery: getQuery,
      setMatchInfo: setMatchInfo,
      setCaseSensitive: setCaseSensitive,
      setWholeWord: setWholeWord,
      getCaseSensitive: getCaseSensitive,
      getWholeWord: getWholeWord,
      focusInput: focusInput,
      on: on,
      dispose: dispose,
    };
  }

  return { createSearchBar: createSearchBar };
});
