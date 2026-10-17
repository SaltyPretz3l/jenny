/* Shared chat image primitive (UMD): one framed image for generated, attached and tool-output
 * images, the hover/focus tool cluster on it, the pending card, and the generation-details
 * mapping the artifact panel and the image viewer share. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.inventoryArtifactFigure = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = stringUtils.escapeHtml;
  const positiveInteger = (value) => Number.isInteger(Number(value)) && Number(value) > 0;
  const present = (value) => value !== undefined && value !== null && value !== '';
  const ICON_PATHS = {
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    'save-as': '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    reveal: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
  const ratioStyle = (width, height) => (positiveInteger(width) && positiveInteger(height) ? ` style="--inv-image-ratio: ${Number(width)} / ${Number(height)}"` : '');

  /* Every chat image addresses itself as kind + id + session: the viewer opens it with
   * data-image-viewer-open, and each tool is a data-image-action on the same identity. */
  function identity(kind, id, sessionId) {
    return ` data-image-kind="${escapeHtml(kind)}" data-image-id="${escapeHtml(id)}" data-session-id="${escapeHtml(sessionId)}"`;
  }

  function renderTools(kind, id, sessionId, actions, labels) {
    const names = { copy: labels.copy, 'save-as': labels.saveAs, reveal: labels.reveal, panel: labels.panel };
    return `<span class="inv-artifact-figure-actions" role="group" aria-label="${escapeHtml(labels.actions)}">`
      + actions.map((action) => `<button type="button" class="inv-artifact-figure-tool" data-image-action="${action}"${identity(kind, id, sessionId)}`
        + ` aria-label="${escapeHtml(names[action])}" title="${escapeHtml(names[action])}">${icon(action)}</button>`).join('')
      + '</span>';
  }

  /* A disabled frame (an unavailable image) announces itself unavailable and keeps its "View …"
   * label in data-inv-artifact-view-aria for the card utils to restore after a successful retry. */
  function renderMedia({ kind, id, sessionId, image, viewAria, actions, labels, width, height, unavailable, disabled }) {
    const aria = disabled ? labels.unavailable : viewAria;
    const open = id
      ? `<button type="button" class="inv-artifact-figure-frame" data-image-viewer-open="${escapeHtml(kind)}" data-image-id="${escapeHtml(id)}" data-session-id="${escapeHtml(sessionId)}"`
        + (disabled ? ` aria-disabled="true" data-inv-artifact-view-aria="${escapeHtml(viewAria)}"` : '')
        + ` aria-label="${escapeHtml(aria)}" title="${escapeHtml(aria)}">${image}${unavailable || ''}</button>`
      : `<span class="inv-artifact-figure-frame">${image}${unavailable || ''}</span>`;
    return `<div class="inv-artifact-figure-media"${ratioStyle(width, height)}>${open}`
      + (id && actions.length ? renderTools(kind, id, sessionId, actions, labels) : '') + '</div>';
  }

  /* A generated image artifact. The image source can arrive later: the card utils hydrate
   * img[data-inv-artifact-image-key] and flip data-inv-artifact-image-state. */
  function renderFigure(opts) {
    const o = opts || {};
    const labels = o.labels || {};
    const image = `<img class="inv-artifact-figure-image" data-inv-artifact-image-key="${escapeHtml(o.imageKey)}" alt="${escapeHtml(o.title)}"`
      + (positiveInteger(o.width) ? ` width="${Number(o.width)}"` : '')
      + (positiveInteger(o.height) ? ` height="${Number(o.height)}"` : '')
      + ` decoding="async"${o.src ? ` src="${escapeHtml(o.src)}"` : ''}>`;
    return `<figure class="inv-artifact-figure" data-artifact-call-id="${escapeHtml(o.callId)}"${o.state ? ` data-inv-artifact-image-state="${escapeHtml(o.state)}"` : ''}>`
      + renderMedia({ kind: 'artifact', id: o.artifactId, sessionId: o.sessionId, image, viewAria: labels.viewAria,
        actions: ['copy', 'save-as', 'reveal', 'panel'], labels, width: o.width, height: o.height, disabled: o.state === 'unavailable',
        unavailable: `<span class="inv-artifact-figure-unavailable">${escapeHtml(labels.unavailable)}</span>` })
      + (o.title || o.meta || o.prompt ? '<figcaption class="inv-artifact-figure-caption">'
        + (o.title ? `<span class="inv-artifact-figure-title" title="${escapeHtml(o.title)}">${escapeHtml(o.title)}</span>` : '')
        + (o.meta ? `<span class="inv-artifact-figure-meta">${escapeHtml(o.meta)}</span>` : '')
        + (o.prompt ? `<span class="inv-artifact-figure-prompt" title="${escapeHtml(o.promptTitle || o.prompt)}">${escapeHtml(o.prompt)}</span>` : '')
        + '</figcaption>' : '')
      + '</figure>';
  }

  /* An attached or tool-output image with a ready source. Without an id it cannot be addressed,
   * so it renders framed but without the viewer button or tools. */
  function renderSourceFigure(opts) {
    const o = opts || {};
    const labels = o.labels || {};
    const kind = o.kind === 'tool' ? 'tool' : 'attachment';
    const image = `<img class="inv-artifact-figure-image" src="${escapeHtml(o.src)}" alt="${escapeHtml(o.alt)}" decoding="async">`;
    return `<figure class="inv-artifact-figure inv-artifact-figure--${kind}">`
      + renderMedia({ kind, id: o.id, sessionId: o.sessionId, image, viewAria: labels.viewAria, actions: ['copy', 'save-as'], labels,
        unavailable: `<span class="inv-artifact-figure-unavailable">${escapeHtml(labels.unavailable)}</span>` })
      + (o.caption ? `<figcaption class="inv-artifact-figure-caption"><span class="inv-artifact-figure-title" title="${escapeHtml(o.caption)}">${escapeHtml(o.caption)}</span></figcaption>` : '')
      + '</figure>';
  }

  function renderPendingFigure(opts) {
    const o = opts || {};
    const labels = o.labels || {};
    const ratio = positiveInteger(o.width) && positiveInteger(o.height) ? `${Number(o.width)} / ${Number(o.height)}` : '1 / 1';
    return '<div class="inv-artifact-figure inv-artifact-figure--pending" role="status">'
      + `<div class="inv-artifact-figure-placeholder" style="aspect-ratio: ${ratio}">`
      + `<span class="inv-artifact-figure-pending-title">${escapeHtml(labels.title)}</span>`
      + `<span class="inv-artifact-figure-pending-note">${escapeHtml(labels.note)}</span>`
      + `<button type="button" class="inv-artifact-figure-action" data-inv-image-cancel>${escapeHtml(labels.cancel)}</button>`
      + '</div></div>';
  }

  /* The markdown "View image" reference to a generated image. */
  function renderViewerButton(opts) {
    const o = opts || {};
    return `<button type="button" class="inv-artifact-view-image" data-image-viewer-open="artifact" data-image-id="${escapeHtml(o.artifactId)}" data-session-id="${escapeHtml(o.sessionId)}">${escapeHtml(o.label)}</button>`;
  }

  function renderUnavailableReference(label) {
    return `<span class="inv-artifact-image-reference-unavailable">${escapeHtml(label)}</span>`;
  }

  /* Generation details of one generated image from its tool result; null when there are none. */
  function generationDetails(toolResult, artifact) {
    const text = (value) => String(value ?? '').trim();
    const number = (value) => (value === '' || value == null || !Number.isFinite(Number(value)) ? undefined : Number(value));
    const provenance = toolResult?.metadata?.provenance;
    const fileName = text(artifact?.display_path).split(/[\\/]/).pop();
    if (!provenance && !fileName) return null;
    const source = provenance || {};
    const durationMs = number(toolResult.duration_ms);
    const details = {
      prompt: text(source.image_prompt),
      negativePrompt: text(source.image_negative_prompt),
      seed: number(source.seed),
      steps: number(source.steps),
      cfgScale: number(source.cfg_scale),
      // F9: the set id is an opaque key; show the saved label (or family and quant).
      model: text(source.model_label) || [text(source.family), text(source.quant)].filter(Boolean).join(' · '),
      seconds: durationMs > 0 ? Math.round(durationMs / 1000) : undefined,
      fileName,
    };
    return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== '' && value !== undefined));
  }

  /* [label, value] rows for the details facts list, present values only. */
  function detailRows(details, size) {
    const d = details || {};
    const steps = present(d.steps) ? String(d.steps) + (present(d.cfgScale) ? ` · ${jt('imageViewer.cfg', 'CFG')} ${d.cfgScale}` : '') : '';
    return [[jt('imageViewer.size', 'Size'), size || ''], [jt('imageViewer.seed', 'Seed'), present(d.seed) ? String(d.seed) : ''],
      [jt('imageViewer.steps', 'Steps'), steps], [jt('imageViewer.model', 'Model'), d.model],
      [jt('imageViewer.time', 'Time'), Number.isFinite(d.seconds) ? jt('imageViewer.seconds', '{seconds} s', { seconds: Math.round(d.seconds) }) : ''],
      [jt('imageViewer.file', 'File'), d.fileName]].filter((row) => present(row[1]));
  }

  /* The details block under an image in the artifact panel; '' when there is nothing to show.
   * The Copy prompt button carries data-image-copy-prompt for the host to wire. */
  function renderDetails(details, size) {
    const d = details || {};
    const rows = detailRows(d, size);
    if (!d.prompt && !d.negativePrompt && !rows.length) return '';
    const copy = jt('imageViewer.copyPrompt', 'Copy prompt');
    return `<section class="inv-image-details" aria-label="${escapeHtml(jt('imageViewer.details', 'Details'))}">`
      + (d.prompt ? '<div class="inv-image-details-head">'
        + `<h3>${escapeHtml(jt('imageViewer.promptLabel', 'Prompt'))}</h3>`
        + `<button type="button" class="inv-image-details-copy" data-image-copy-prompt aria-label="${escapeHtml(copy)}" title="${escapeHtml(copy)}">${icon('copy')}</button></div>`
        + `<p class="inv-image-details-prompt">${escapeHtml(d.prompt)}</p>` : '')
      + (d.negativePrompt ? `<h3>${escapeHtml(jt('imageViewer.avoidLabel', 'Avoid'))}</h3><p class="inv-image-details-prompt inv-image-details-prompt--avoid">${escapeHtml(d.negativePrompt)}</p>` : '')
      + (rows.length ? '<dl class="inv-image-details-facts">' + rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('') + '</dl>' : '')
      + '</section>';
  }

  return { renderFigure, renderSourceFigure, renderPendingFigure, renderViewerButton, renderUnavailableReference,
    generationDetails, detailRows, renderDetails };
});
