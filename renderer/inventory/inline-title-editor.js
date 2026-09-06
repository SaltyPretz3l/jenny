/* renderer/inventory/inline-title-editor.js
 *
 * Inventory primitive for in-place single-line title editing (session rows,
 * and any future list rows). Unlike inline-text-editor.js (markup-string
 * builder for the chat message editor), this primitive owns the live DOM
 * swap: it hides the title element, inserts an <input> in its place, and
 * restores on settle. Enter commits, Escape cancels, blur commits. All key
 * and click events are stopped from bubbling so list-level delegated
 * handlers (row open, arrow-key roving focus) never fire mid-edit.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryInlineTitleEditor = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EDITOR_CLASS = 'inv-inline-title-editor';

  /**
   * Start an inline edit on a title element.
   *
   * @param {object} opts
   * @param {HTMLElement} opts.titleEl — element whose text is being edited; hidden while editing
   * @param {string} [opts.initialValue] — initial input value (defaults to titleEl text)
   * @param {string} [opts.ariaLabel] — input aria-label (default "Rename")
   * @param {number} [opts.maxLength] — input maxlength (default 120)
   * @param {(value: string) => void} [opts.onCommit] — called once with the trimmed value
   *   when it is non-empty and differs from the initial value
   * @param {() => void} [opts.onCancel] — called once on Escape, empty, or unchanged value
   * @returns {{ input: HTMLInputElement, dispose: () => void } | null}
   */
  function startInlineTitleEdit(opts) {
    var settings = opts || {};
    var titleEl = settings.titleEl;
    if (!titleEl || !titleEl.ownerDocument) {
      return null;
    }
    var doc = titleEl.ownerDocument;
    if (titleEl.parentNode && titleEl.parentNode.querySelector('.' + EDITOR_CLASS)) {
      return null;
    }
    var initialValue = String(
      settings.initialValue != null ? settings.initialValue : titleEl.textContent || ''
    ).trim();
    var onCommit = typeof settings.onCommit === 'function' ? settings.onCommit : function () {};
    var onCancel = typeof settings.onCancel === 'function' ? settings.onCancel : function () {};

    var input = doc.createElement('input');
    input.type = 'text';
    input.className = EDITOR_CLASS;
    input.value = initialValue;
    input.maxLength = Number.isFinite(settings.maxLength) ? settings.maxLength : 120;
    input.setAttribute('aria-label', String(settings.ariaLabel || 'Rename'));

    var previousDisplay = titleEl.style.display;
    titleEl.style.display = 'none';
    titleEl.insertAdjacentElement('afterend', input);

    var settled = false;

    function restore() {
      if (settled) return;
      settled = true;
      if (input.parentNode) input.parentNode.removeChild(input);
      titleEl.style.display = previousDisplay;
    }

    function commit() {
      if (settled) return;
      var value = String(input.value || '').trim();
      restore();
      if (!value || value === initialValue) {
        onCancel();
        return;
      }
      onCommit(value);
    }

    function cancel() {
      if (settled) return;
      restore();
      onCancel();
    }

    input.addEventListener('keydown', function handleEditorKeydown(event) {
      // List rows have their own Enter/Escape/arrow delegated handlers —
      // nothing typed in the editor may reach them.
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });
    input.addEventListener('click', function handleEditorClick(event) {
      event.stopPropagation();
    });
    input.addEventListener('blur', function handleEditorBlur() {
      commit();
    });

    input.focus();
    input.select();

    return { input: input, dispose: cancel };
  }

  return {
    EDITOR_CLASS: EDITOR_CLASS,
    startInlineTitleEdit: startInlineTitleEdit,
  };
});
