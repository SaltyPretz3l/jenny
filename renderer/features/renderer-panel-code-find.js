/* renderer/features/renderer-panel-code-find.js - find in file for the chat side panel's
 * read-only code bodies (file preview rows, Changes diff rows). attach(bodyEl, adapter) wires
 * Ctrl/Cmd+F inside the body to an inline find field (`div.panel-code-find`, inserted as the
 * body's previous sibling): input, "i of n" count, previous/next/close. Enter = next,
 * Shift+Enter = previous (wrapping), Escape closes and focuses the body.
 *
 * Matches are searched in each row's text element (adapter.textSelector inside each
 * adapter.rowSelector element) and painted with the CSS Custom Highlight API (ranges over the
 * row's text nodes; the code DOM is never mutated). Without the API the current match's row
 * gets an `is-find-current` class instead. A MutationObserver re-runs the query after the body
 * re-renders while the field is open. The field is removed from the DOM when closed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPanelCodeFind = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_MATCHES = 5000;
  const INPUT_DEBOUNCE_MS = 80;
  const HIGHLIGHT_ALL = 'panel-code-find';
  const HIGHLIGHT_CURRENT = 'panel-code-find-current';
  const SHOW_TEXT = 4;

  function fallbackTranslate(key, fallback, params) {
    return params
      ? String(fallback).replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m))
      : fallback;
  }

  // rowTexts: string[]; returns non-overlapping matches in row order, capped at MAX_MATCHES.
  function findMatches(rowTexts, query) {
    const needle = String(query || '').toLowerCase();
    const matches = [];
    if (!needle) {
      return matches;
    }
    for (let row = 0; row < rowTexts.length; row += 1) {
      const text = String(rowTexts[row]).toLowerCase();
      let from = 0;
      let at = text.indexOf(needle, from);
      while (at !== -1) {
        matches.push({ row, start: at, end: at + needle.length });
        if (matches.length >= MAX_MATCHES) {
          return matches;
        }
        from = at + needle.length;
        at = text.indexOf(needle, from);
      }
    }
    return matches;
  }

  // The field is built from the inventory primitives (renderer/inventory/), never raw elements.
  function resolvePrimitive(given, globalName, requirePath) {
    if (typeof given === 'function') return given;
    if (typeof globalThis[globalName] === 'function') return globalThis[globalName];
    return typeof require === 'function' ? require(requirePath) : null;
  }

  function createPanelCodeFind({ documentRef, windowRef, jt: translate, textField: givenTextField, actionButton: givenActionButton } = {}) {
    const jt = typeof translate === 'function' ? translate : fallbackTranslate;
    const textField = resolvePrimitive(givenTextField, 'inventoryTextField', '../inventory/text-field');
    const actionButton = resolvePrimitive(givenActionButton, 'inventoryActionButton', '../inventory/action-button');
    const attachments = new Set();

    function highlightRegistry() {
      return windowRef.CSS && windowRef.CSS.highlights && typeof windowRef.Highlight === 'function'
        ? windowRef.CSS.highlights
        : null;
    }

    function fromHtml(html) {
      const template = documentRef.createElement('template');
      template.innerHTML = html;
      return template.content.firstElementChild;
    }

    function buildInput() {
      const label = jt('panelCode.find.inputLabel', 'Find in file');
      const placeholder = jt('panelCode.find.placeholder', 'Find');
      const wrapper = fromHtml(textField({ className: 'panel-code-find-field', ariaLabel: label, placeholder, spellcheck: false }));
      const input = wrapper.querySelector('input');
      input.classList.add('panel-code-find-input');
      return { node: wrapper, input };
    }

    function buildButton(action, glyph, label, title) {
      return fromHtml(actionButton({ plain: true, className: 'panel-code-find-' + action, ariaLabel: label, title, trustedHtml: glyph }));
    }

    function attach(bodyEl, { rowSelector, textSelector }) {
      let isOpen = false;
      let query = '';
      let matches = [];
      let index = -1;
      let rows = [];
      let inputTimer = null;
      let refreshHandle = null;
      let observer = null;
      let currentRow = null;
      let ranges = [];
      let appliedAll = null;
      let appliedCurrent = null;
      let field = null;
      let input = null;
      let countEl = null;

      function ensureField() {
        if (!field) {
          field = documentRef.createElement('div');
          field.className = 'panel-code-find';
          const built = buildInput();
          input = built.input;
          countEl = documentRef.createElement('span');
          countEl.className = 'panel-code-find-count';
          countEl.setAttribute('aria-live', 'polite');
          const prev = buildButton('prev', '↑', jt('panelCode.find.previous', 'Previous match'), jt('panelCode.find.previousTitle', 'Previous match (Shift+Enter)'));
          const next = buildButton('next', '↓', jt('panelCode.find.next', 'Next match'), jt('panelCode.find.nextTitle', 'Next match (Enter)'));
          const close = buildButton('close', '×', jt('panelCode.find.close', 'Close find'), jt('panelCode.find.closeTitle', 'Close find (Esc)'));
          field.append(built.node, countEl, prev, next, close);
          input.addEventListener('input', onInput);
          input.addEventListener('keydown', onFieldKey);
          prev.addEventListener('click', () => step(-1));
          next.addEventListener('click', () => step(1));
          close.addEventListener('click', closeField);
        }
        if (field.nextSibling !== bodyEl) {
          bodyEl.parentNode.insertBefore(field, bodyEl);
        }
      }

      function collectRows() {
        rows = Array.from(bodyEl.querySelectorAll(rowSelector), (row) => {
          const textEl = row.querySelector(textSelector);
          return { row, textEl, text: textEl ? textEl.textContent : '' };
        });
      }

      // Maps [start, end) of the element's text to a Range across its text nodes.
      function rangeFor(textEl, start, end) {
        const walker = documentRef.createTreeWalker(textEl, SHOW_TEXT);
        const range = documentRef.createRange();
        let offset = 0;
        let startSet = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = node.nodeValue.length;
          if (!startSet && start < offset + length) {
            range.setStart(node, start - offset);
            startSet = true;
          }
          if (startSet && end <= offset + length) {
            range.setEnd(node, end - offset);
            break;
          }
          offset += length;
        }
        return range;
      }

      function clearHighlights() {
        const registry = highlightRegistry();
        if (registry) {
          if (appliedAll && registry.get(HIGHLIGHT_ALL) === appliedAll) registry.delete(HIGHLIGHT_ALL);
          if (appliedCurrent && registry.get(HIGHLIGHT_CURRENT) === appliedCurrent) registry.delete(HIGHLIGHT_CURRENT);
        }
        appliedAll = null;
        appliedCurrent = null;
        if (currentRow) {
          currentRow.classList.remove('is-find-current');
          currentRow = null;
        }
      }

      // rebuild: a new search maps every match to a range once; a step only swaps the current one.
      function paintHighlights(rebuild) {
        const registry = highlightRegistry();
        if (rebuild) {
          clearHighlights();
          ranges = registry ? matches.map((m) => rangeFor(rows[m.row].textEl, m.start, m.end)) : [];
          if (ranges.length) {
            appliedAll = new windowRef.Highlight(...ranges);
            registry.set(HIGHLIGHT_ALL, appliedAll);
          }
        }
        if (registry && appliedCurrent && registry.get(HIGHLIGHT_CURRENT) === appliedCurrent) registry.delete(HIGHLIGHT_CURRENT);
        appliedCurrent = null;
        if (currentRow) {
          currentRow.classList.remove('is-find-current');
          currentRow = null;
        }
        if (index < 0) {
          return;
        }
        if (!registry) {
          currentRow = rows[matches[index].row].row;
          currentRow.classList.add('is-find-current');
          return;
        }
        appliedCurrent = new windowRef.Highlight(ranges[index]);
        appliedCurrent.priority = 1;
        registry.set(HIGHLIGHT_CURRENT, appliedCurrent);
      }

      function paintCount() {
        if (!query) {
          countEl.textContent = '';
        } else if (!matches.length) {
          countEl.textContent = jt('panelCode.find.noResults', 'No results');
        } else {
          const params = { index: index + 1, count: matches.length };
          countEl.textContent = matches.length >= MAX_MATCHES
            ? jt('panelCode.find.countCapped', '{index} of {count}+', params)
            : jt('panelCode.find.count', '{index} of {count}', params);
        }
      }

      function paint(scroll, rebuild) {
        paintCount();
        paintHighlights(rebuild);
        if (scroll && index >= 0) {
          const row = rows[matches[index].row].row;
          if (typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
          }
        }
      }

      // keepIndex: a re-render re-runs the query and stays on the same match number when valid.
      function runSearch(keepIndex) {
        collectRows();
        matches = findMatches(rows.map((r) => r.text), query);
        const previous = index;
        index = !matches.length ? -1 : (keepIndex && previous >= 0 && previous < matches.length ? previous : 0);
        paint(!keepIndex, true);
      }

      function step(direction) {
        if (!matches.length) {
          return;
        }
        index = (index + direction + matches.length) % matches.length;
        paint(true, false);
      }

      function flushInput() {
        if (inputTimer !== null) {
          windowRef.clearTimeout(inputTimer);
          inputTimer = null;
          runSearch(false);
          return true;
        }
        return false;
      }

      function onInput() {
        query = input.value;
        if (inputTimer !== null) {
          windowRef.clearTimeout(inputTimer);
        }
        inputTimer = windowRef.setTimeout(() => {
          inputTimer = null;
          runSearch(false);
        }, INPUT_DEBOUNCE_MS);
      }

      function stop(event) {
        event.preventDefault();
        event.stopPropagation();
      }

      function onFieldKey(event) {
        if (isFindShortcut(event)) {
          stop(event);
          input.select();
        } else if (event.key === 'Escape') {
          stop(event);
          closeField();
        } else if (event.key === 'Enter' && !event.isComposing) {
          stop(event);
          if (!flushInput()) {
            step(event.shiftKey ? -1 : 1);
          }
        }
      }

      function onBodyKey(event) {
        if (isFindShortcut(event)) {
          stop(event);
          openField();
        } else if (event.key === 'Escape' && isOpen) {
          stop(event);
          closeField();
        }
      }

      const isRowNode = (node) => node.nodeType === 1 && (node.matches(rowSelector) || !!node.querySelector(rowSelector));
      function touchesRows(record) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target?.closest(rowSelector)) return true;
        return [...record.addedNodes, ...record.removedNodes].some(isRowNode);
      }

      function scheduleRefresh() {
        if (refreshHandle !== null) {
          return;
        }
        const run = () => {
          refreshHandle = null;
          refresh();
        };
        refreshHandle = typeof windowRef.requestAnimationFrame === 'function'
          ? windowRef.requestAnimationFrame(run)
          : windowRef.setTimeout(run, 16);
      }

      function cancelRefresh() {
        if (refreshHandle === null) {
          return;
        }
        if (typeof windowRef.cancelAnimationFrame === 'function' && typeof windowRef.requestAnimationFrame === 'function') {
          windowRef.cancelAnimationFrame(refreshHandle);
        } else {
          windowRef.clearTimeout(refreshHandle);
        }
        refreshHandle = null;
      }

      function openField() {
        ensureField();
        isOpen = true;
        input.value = query;
        input.focus();
        input.select();
        if (query) {
          runSearch(true);
        }
        if (!observer) {
          // Changes outside the rows (the live elapsed ticker on the Changes page) leave matches as they are.
          observer = new windowRef.MutationObserver((records) => {
            if (records.some(touchesRows)) scheduleRefresh();
          });
          observer.observe(bodyEl, { childList: true, subtree: true, characterData: true });
        }
      }

      function teardownSearch() {
        isOpen = false;
        if (inputTimer !== null) {
          windowRef.clearTimeout(inputTimer);
          inputTimer = null;
        }
        cancelRefresh();
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        clearHighlights();
        if (field) {
          field.remove();
        }
      }

      function closeField() {
        if (!isOpen) {
          return;
        }
        teardownSearch();
        bodyEl.focus();
      }

      function refresh() {
        if (isOpen && query) {
          runSearch(true);
        }
      }

      function detach() {
        teardownSearch();
        bodyEl.removeEventListener('keydown', onBodyKey);
        attachments.delete(handle);
      }

      const handle = { open: openField, close: closeField, refresh, detach };
      bodyEl.addEventListener('keydown', onBodyKey);
      attachments.add(handle);
      return handle;
    }

    function dispose() {
      Array.from(attachments).forEach((handle) => handle.detach());
    }

    return { attach, dispose };
  }

  function isFindShortcut(event) {
    return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && String(event.key || '').toLowerCase() === 'f';
  }

  return { createPanelCodeFind, findMatches };
});
