/* renderer/features/renderer-ide-pdf-toolbar.js - toolbar markup and the
 * keyboard map for the Workspace IDE PDF pane (renderer-ide-pdf-host.js).
 * The host owns state and runs the actions; this module only names them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePdfToolbar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Find option toggles: action -> the pdf.js find-state key it flips.
  const FIND_OPTIONS = Object.freeze({
    'find-case': 'caseSensitive',
    'find-word': 'entireWord',
    'find-accents': 'matchDiacritics',
  });

  const SIDEBAR_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>'
    + '<path d="M6 3v10" stroke="currentColor" stroke-width="1.2"/></svg>';

  function buildToolbarMarkup({ actionButton, textField }) {
    const button = (action, label, options = {}) => actionButton({
      plain: true,
      className: `ide-pdf-button${options.mode ? ' ide-pdf-mode-button' : ''}${options.className ? ` ${options.className}` : ''}`,
      label,
      title: options.title || label,
      ariaLabel: label,
      ariaPressed: options.mode || options.toggle ? options.pressed === true : undefined,
      dataset: { 'ide-pdf-action': action },
      ...(options.html ? { trustedHtml: options.html } : {}),
    });
    const pageField = textField({
      id: 'idePdfPage',
      value: '1',
      ariaLabel: jt('ide.pdf.pageNumber', 'Page number'),
      className: 'ide-pdf-page-field',
      dataset: { 'ide-pdf-page': 'true' },
    });
    const findField = textField({
      id: 'idePdfFind',
      value: '',
      placeholder: jt('ide.pdf.searchPlaceholder', 'Find in document'),
      ariaLabel: jt('ide.pdf.search', 'Search PDF'),
      className: 'ide-pdf-find-field',
      dataset: { 'ide-pdf-find': 'true' },
    });
    const separator = '<span class="ide-pdf-separator" aria-hidden="true"></span>';
    return '<div class="ide-pdf-toolbar">'
      + '<div class="ide-pdf-toolbar-row">'
      + button('sidebar', jt('ide.pdf.sidebar', 'Sidebar'), {
        toggle: true, className: 'ide-pdf-icon-button', html: SIDEBAR_ICON,
        title: jt('ide.pdf.sidebarTitle', 'Show or hide the sidebar (F4)'),
      })
      + separator
      + button('prev', jt('ide.pdf.previousPage', 'Previous'))
      + button('next', jt('ide.pdf.nextPage', 'Next'))
      + pageField
      + '<span class="ide-pdf-page-readout"></span>'
      + separator
      + button('zoom-out', jt('ide.pdf.zoomOut', 'Zoom out'), { title: jt('ide.pdf.zoomOutTitle', 'Zoom out (Ctrl+-)') })
      + button('zoom-in', jt('ide.pdf.zoomIn', 'Zoom in'), { title: jt('ide.pdf.zoomInTitle', 'Zoom in (Ctrl+=)') })
      + button('fit-width', jt('ide.pdf.fitWidth', 'Fit width'), { title: jt('ide.pdf.fitWidthTitle', 'Fit width (Ctrl+0)') })
      + button('fit-page', jt('ide.pdf.fitPage', 'Fit page'))
      + separator
      + findField
      + '<span class="ide-pdf-find-options" role="group" aria-label="' + actionButton.escapeHtml(jt('ide.pdf.findOptions', 'Find options')) + '">'
      + button('find-case', jt('ide.pdf.matchCase', 'Match case'), { toggle: true, html: 'Aa', className: 'ide-pdf-find-option' })
      + button('find-word', jt('ide.pdf.wholeWords', 'Whole words'), { toggle: true, html: '<span class="ide-pdf-underline">ab</span>', className: 'ide-pdf-find-option' })
      + button('find-accents', jt('ide.pdf.matchAccents', 'Match accents'), { toggle: true, html: '&eacute;', className: 'ide-pdf-find-option' })
      + '</span>'
      + button('find-prev', jt('ide.pdf.previousMatch', 'Previous match'), {
        html: '&uarr;', className: 'ide-pdf-icon-button', title: jt('ide.pdf.previousMatchTitle', 'Previous match (Shift+F3)'),
      })
      + button('find-next', jt('ide.pdf.nextMatch', 'Next match'), {
        html: '&darr;', className: 'ide-pdf-icon-button', title: jt('ide.pdf.nextMatchTitle', 'Next match (F3)'),
      })
      + '<span class="ide-pdf-find-readout"></span>'
      + '</div>'
      + '<div class="ide-pdf-toolbar-row ide-pdf-toolbar-row--edit">'
      + button('select', jt('ide.pdf.selectMode', 'Select'), { mode: true, pressed: true })
      + button('highlight', jt('ide.pdf.highlightMode', 'Highlight'), { mode: true })
      + button('text', jt('ide.pdf.textMode', 'Text'), { mode: true })
      + button('draw', jt('ide.pdf.drawMode', 'Draw'), { mode: true })
      + '<span class="ide-pdf-note">'
      + actionButton.escapeHtml(jt('ide.pdf.editScope', 'Annotations and form fields are saved into the PDF. Existing text and layout cannot be edited here.'))
      + '</span></div></div>';
  }

  // Inputs, text areas and pdf.js FreeText editors (contenteditable) keep
  // their own caret keys; page keys only act on the pages themselves.
  function isEditableTarget(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  }

  const PAGE_KEYS = Object.freeze({ PageDown: 'page-next', PageUp: 'page-prev', Home: 'page-first', End: 'page-last' });

  // Names the pane action for a keydown, or null. Shift/Alt chords on S and F
  // belong to the IDE (Ctrl+Shift+F is workspace search); Ctrl+PageUp/Down
  // switch tabs. Ctrl+=/-/0 zoom the PDF while focus is in the pane, the way
  // artifact review keeps its own Ctrl+0 ahead of the app zoom handler.
  function keyAction(event) {
    const key = String(event?.key || '');
    const code = String(event?.code || '');
    const ctrl = Boolean(event?.ctrlKey || event?.metaKey);
    if (event?.isComposing || event?.altKey) return null;
    if (ctrl && !event.shiftKey) {
      const lower = key.toLowerCase();
      if (lower === 's') return 'save';
      if (lower === 'f') return 'find-focus';
    }
    if (ctrl) {
      if (key === '=' || key === '+' || code === 'NumpadAdd') return 'zoom-in';
      if (!event.shiftKey && (key === '-' || code === 'NumpadSubtract')) return 'zoom-out';
      if (!event.shiftKey && (key === '0' || code === 'Numpad0')) return 'fit-width';
      return null;
    }
    if (key === 'F3') return event.shiftKey ? 'find-prev' : 'find-next';
    if (key === 'F4' && !event.shiftKey) return 'sidebar';
    if (key === 'Escape' && event.target?.matches?.('[data-ide-pdf-find]')) return 'find-close';
    if (PAGE_KEYS[key] && !event.shiftKey && !isEditableTarget(event.target)
      && !event.target?.closest?.('.ide-pdf-sidebar')) return PAGE_KEYS[key];
    return null;
  }

  return { FIND_OPTIONS, buildToolbarMarkup, keyAction };
});
