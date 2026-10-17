/* Image viewer DOM primitive. Behavior belongs to renderer-image-viewer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.inventoryImageViewer = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';
  const escapeHtml = stringUtils.escapeHtml;
  const DASH = ' stroke-dasharray="3 2.5"';
  const ICONS = {
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    save: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    folder: '<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
    more: '<circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
    fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
    actual: '<path d="M5 9l2-1.5V16"/><path d="M17 9l2-1.5V16"/><path d="M12 10.5h.01M12 14.5h.01"/>',
    rotate: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>',
    rotateLeft: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><path d="M12 9v3l2 2"/>',
    edit: '<path d="M5 19h4L19 9l-4-4L5 15z"/><path d="m13 7 4 4"/>',
    pan: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.6-2.2L4 15.5a1.5 1.5 0 0 1 2.3-1.9L8 15.5"/>',
    box: `<rect x="5" y="6" width="14" height="12" rx="1"${DASH}/>`,
    ellipse: `<ellipse cx="12" cy="12" rx="8" ry="6"${DASH}/>`,
    freehand: `<path d="M5 15c2-6 5-8 7-6s-1 6 2 6 3-5 5-6"${DASH}/>`,
    clear: '<path d="M6 6l12 12M18 6 6 18"/>',
    send: '<path d="M5 12h13"/><path d="m13 6 6 6-6 6"/>',
    prev: '<path d="m14 6-6 6 6 6"/>',
    next: '<path d="m10 6 6 6-6 6"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

  function createView(documentRef, labels) {
    const root = documentRef.createElement('div');
    root.id = 'imageViewer';
    root.className = 'image-viewer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'imageViewerTitle');
    const icon = (action, name, label, extra = '') => `<button type="button" class="image-viewer-icon" data-image-viewer-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${extra}>${svg(name)}</button>`;
    const text = (action, label, name, className = 'image-viewer-text') => `<button type="button" class="${className}" data-image-viewer-action="${action}">${name ? svg(name) : ''}${escapeHtml(label)}</button>`;
    const item = (action, name, label) => `<button type="button" role="menuitem" data-image-viewer-action="${action}">${svg(name)}${escapeHtml(label)}</button>`;
    const rule = '<span class="image-viewer-rule" aria-hidden="true"></span>';
    root.innerHTML = '<header class="image-viewer-header"><div class="image-viewer-heading">'
      + `<h2 id="imageViewerTitle">${escapeHtml(labels.title)}</h2><p class="image-viewer-meta"></p></div>`
      + '<div class="image-viewer-actions">'
      + icon('copy', 'copy', labels.copy) + icon('save-as', 'save', labels.saveAs) + icon('open', 'external', labels.open)
      + icon('reveal', 'folder', labels.reveal)
      + '<span class="image-viewer-more-anchor">' + icon('more', 'more', labels.more, ' aria-haspopup="menu" aria-expanded="false"')
      + '<div class="image-viewer-more" role="menu" hidden>'
      + item('open-with', 'external', labels.openWith) + item('rotate-left', 'rotateLeft', labels.rotateLeft)
      + item('reset', 'reset', labels.reset) + item('menu-copy-prompt', 'copy', labels.copyPrompt)
      + '</div></span>' + rule
      + icon('details', 'info', labels.details, ' aria-pressed="false"') + icon('close', 'close', labels.close)
      + '</div></header>'
      + '<div class="image-viewer-stage" tabindex="0" role="group"><img class="image-viewer-image" draggable="false" alt=""><canvas class="image-viewer-selection" width="0" height="0" aria-hidden="true"></canvas>'
      + '<div class="image-viewer-placeholder" hidden><span class="image-viewer-spinner" aria-hidden="true"></span><strong></strong>'
      + text('placeholder-reveal', labels.reveal, 'folder') + '</div>'
      + icon('prev', 'prev', labels.previous, ' data-image-viewer-nav="prev"') + icon('next', 'next', labels.next, ' data-image-viewer-nav="next"')
      + '<p class="image-viewer-status" role="status" aria-live="polite"></p>'
      + `<div class="image-viewer-pill" role="toolbar" aria-label="${escapeHtml(labels.controls)}" hidden><div class="image-viewer-pill-group image-viewer-view-actions">`
      + icon('out', 'minus', labels.zoomOut)
      + `<label class="image-viewer-zoom-label"><span class="image-viewer-sr-only">${escapeHtml(labels.zoom)}</span><input class="image-viewer-percent" type="number" min="0.1" max="800" step="10" value="100" inputmode="decimal"><span aria-hidden="true">%</span></label>`
      + icon('in', 'plus', labels.zoomIn) + rule + icon('actual', 'actual', labels.actual) + icon('fit', 'fit', labels.fit)
      + icon('rotate-right', 'rotate', labels.rotateRight)
      + `<span class="image-viewer-edit-entry">${rule}${text('edit', labels.editRegion, 'edit')}</span>`
      + '</div><div class="image-viewer-pill-group image-viewer-edit-actions" hidden>'
      + `<span class="image-viewer-pill-label">${escapeHtml(labels.editHint)}</span>`
      + icon('select-pan', 'pan', labels.pan) + icon('select-box', 'box', labels.box) + icon('select-ellipse', 'ellipse', labels.ellipse)
      + icon('select-freehand', 'freehand', labels.freehand) + rule + icon('clear-selection', 'clear', labels.clearSelection) + rule
      + text('edit-cancel', labels.editCancel) + text('send-edit', labels.sendEdit, 'send', 'image-viewer-text image-viewer-text--primary')
      + '</div></div>'
      + '<div class="image-viewer-menu" role="menu" hidden><button type="button" role="menuitem" data-image-viewer-action="menu-send-edit">' + escapeHtml(labels.sendEdit) + '</button></div></div>'
      + `<aside class="image-viewer-details" aria-label="${escapeHtml(labels.details)}" hidden>`
      + `<div class="image-viewer-prompt-block"><h3>${escapeHtml(labels.promptLabel)}</h3><p class="image-viewer-prompt"></p>`
      + text('copy-prompt', labels.copyPrompt, '', 'image-viewer-link') + '</div>'
      + `<div class="image-viewer-avoid-block"><h3>${escapeHtml(labels.avoidLabel)}</h3><p class="image-viewer-prompt image-viewer-prompt--avoid"></p></div>`
      + '<dl class="image-viewer-facts"></dl></aside>';
    const stage = root.querySelector('.image-viewer-stage');
    stage.setAttribute('aria-label', labels.stage);
    const placeholder = root.querySelector('.image-viewer-placeholder');
    const details = root.querySelector('.image-viewer-details');
    return { root, stage, menu: root.querySelector('.image-viewer-menu'), more: root.querySelector('.image-viewer-more'),
      buttons: [...root.querySelectorAll('[data-image-viewer-action]')], image: root.querySelector('img'),
      percent: root.querySelector('input'), status: root.querySelector('.image-viewer-status'),
      title: root.querySelector('h2'), meta: root.querySelector('.image-viewer-meta'), selectionCanvas: root.querySelector('canvas'),
      pill: root.querySelector('.image-viewer-pill'), viewControls: root.querySelector('.image-viewer-view-actions'),
      editEntry: root.querySelector('.image-viewer-edit-entry'), editControls: root.querySelector('.image-viewer-edit-actions'),
      placeholder, placeholderText: placeholder.querySelector('strong'), spinner: placeholder.querySelector('.image-viewer-spinner'),
      details, prompt: details.querySelector('.image-viewer-prompt'), avoid: details.querySelector('.image-viewer-prompt--avoid'),
      facts: details.querySelector('dl') };
  }

  /* Fills the details column; rows are [label, value] pairs already filtered to present values. */
  function fillDetails(view, { prompt, negativePrompt, rows }) {
    view.prompt.textContent = prompt || '';
    view.prompt.parentElement.hidden = !prompt;
    view.avoid.textContent = negativePrompt || '';
    view.avoid.parentElement.hidden = !negativePrompt;
    const doc = view.facts.ownerDocument;
    view.facts.replaceChildren(...rows.flatMap(([label, value]) => {
      const term = doc.createElement('dt'); term.textContent = label;
      const description = doc.createElement('dd'); description.textContent = value;
      return [term, description];
    }));
    view.facts.hidden = !rows.length;
  }

  return { createView, fillDetails };
});
