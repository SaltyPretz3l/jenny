/* Shared generated-image figure primitive (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.inventoryArtifactFigure = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';
  const escapeHtml = stringUtils.escapeHtml;
  const positiveInteger = (value) => Number.isInteger(value) && value > 0;

  function renderFigure(opts) {
    const o = opts || {};
    const labels = o.labels || {};
    const attrs = ` data-artifact-id="${escapeHtml(o.artifactId)}" data-session-id="${escapeHtml(o.sessionId)}" data-artifact-call-id="${escapeHtml(o.callId)}"`;
    const action = (name, label, primary) => `<button type="button" class="inv-artifact-figure-action${primary ? ' inv-artifact-figure-action--primary' : ''}" data-inv-artifact-action="${name}"${attrs}>${escapeHtml(label)}</button>`;
    return `<figure class="inv-artifact-figure" data-artifact-call-id="${escapeHtml(o.callId)}"${o.state ? ` data-inv-artifact-image-state="${escapeHtml(o.state)}"` : ''}>`
      + `<button type="button" class="inv-artifact-figure-frame" data-inv-artifact-action="panel"${attrs} aria-label="${escapeHtml(labels.openAria)}" title="${escapeHtml(labels.openAria)}">`
      + `<img class="inv-artifact-figure-image" data-inv-artifact-image-key="${escapeHtml(o.imageKey)}" alt="${escapeHtml(o.title)}"`
      + (positiveInteger(o.width) ? ` width="${o.width}"` : '')
      + (positiveInteger(o.height) ? ` height="${o.height}"` : '')
      + ` decoding="async"${o.src ? ` src="${escapeHtml(o.src)}"` : ''}>`
      + `<span class="inv-artifact-figure-unavailable">${escapeHtml(labels.unavailable)}</span></button>`
      + '<figcaption class="inv-artifact-figure-caption">'
      + (o.meta ? `<span class="inv-artifact-figure-meta">${escapeHtml(o.meta)}</span>` : '')
      + (o.artifactId ? '<span class="inv-artifact-figure-actions">'
        + action('panel', labels.open, true) + action('save-as', labels.saveAs)
        + action('copy', labels.copy) + action('reveal', labels.reveal) + '</span>' : '')
      + (o.prompt ? `<span class="inv-artifact-figure-prompt" title="${escapeHtml(o.promptTitle || o.prompt)}">${escapeHtml(o.prompt)}</span>` : '')
      + '</figcaption></figure>';
  }

  function renderPendingFigure(opts) {
    const o = opts || {};
    const labels = o.labels || {};
    const ratio = positiveInteger(o.width) && positiveInteger(o.height) ? `${o.width} / ${o.height}` : '1 / 1';
    return '<div class="inv-artifact-figure inv-artifact-figure--pending" role="status">'
      + `<div class="inv-artifact-figure-placeholder" style="aspect-ratio: ${ratio}">`
      + `<span class="inv-artifact-figure-pending-title">${escapeHtml(labels.title)}</span>`
      + `<span class="inv-artifact-figure-pending-note">${escapeHtml(labels.note)}</span>`
      + `<button type="button" class="inv-artifact-figure-action" data-inv-image-cancel>${escapeHtml(labels.cancel)}</button>`
      + '</div></div>';
  }

  return { renderFigure, renderPendingFigure };
});
