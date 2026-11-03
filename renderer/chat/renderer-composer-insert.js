/* renderer/chat/renderer-composer-insert.js - puts text at the caret of the
 * chat composer and focuses it, for "Ask Jenny" actions from side panels.
 * It never sends. Returns false when there is no composer to take it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerInsert = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // A blank line keeps an inserted block apart from the text before it.
  function separatorBefore(textBeforeCaret) {
    if (!textBeforeCaret || textBeforeCaret.endsWith('\n\n')) return '';
    return textBeforeCaret.endsWith('\n') ? '\n' : '\n\n';
  }

  // Pane 0's composer through the shared pane-node seam (renderer-bootstrap-dom.js).
  function paneZeroInput(documentRef) {
    return globalThis.rendererBootstrapDom?.resolveChatPaneDom?.(documentRef, null)?.chatInput || null;
  }

  function createComposerInsert(deps = {}) {
    const documentRef = deps.documentRef;
    const getInput = typeof deps.getInput === 'function' ? deps.getInput : () => paneZeroInput(documentRef);

    function insertIntoComposer({ text } = {}) {
      const input = getInput();
      if (!input || input.disabled || input.readOnly) return false;
      input.focus({ preventScroll: true });
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const insertion = separatorBefore(input.value.slice(0, start)) + String(text);
      let inserted;
      try { inserted = documentRef.execCommand('insertText', false, insertion) === true; } catch (_error) { inserted = false; }
      if (!inserted) {
        input.setRangeText(insertion, start, end, 'end');
        input.dispatchEvent(new documentRef.defaultView.Event('input', { bubbles: true }));
      }
      return true;
    }

    return { insertIntoComposer };
  }

  // The live composer of the page this script runs in.
  function insertIntoComposer(payload) {
    return createComposerInsert({ documentRef: globalThis.document }).insertIntoComposer(payload);
  }

  return { createComposerInsert, insertIntoComposer };
});
