/** Pure string builders for Artifact Panel V3 Canvas chrome. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), require('../inventory/popover'), require('../inventory/segmented-control'));
    return;
  }
  root.rendererArtifactPanelChromeRender = factory(root.inventoryActionButton, root.inventoryPopover, root.inventorySegmentedControl);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, inventoryPopover, segmentedControl) {
  'use strict';

  var ICONS = {
    'file-code': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4"></path><path d="M5 3h9l5 5v13H5z"></path><path d="m10 13-2 2 2 2"></path><path d="m14 13 2 2-2 2"></path></svg>',
    'file-text': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4"></path><path d="M5 3h9l5 5v13H5z"></path><path d="M9 13h6M9 17h6"></path></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="12" r="2"></circle><circle cx="18" cy="6" r="2"></circle><circle cx="18" cy="18" r="2"></circle><path d="m8 11 8-4M8 13l8 4"></path></svg>',
    'chart-bar': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19h16"></path><path d="M6 16V9h3v7M11 16V5h3v11M16 16v-4h3v4"></path></svg>',
    browser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18M7 6.5h.01M10 6.5h.01"></path></svg>',
    photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="8.5" cy="9" r="1.5"></circle><path d="m4 17 5-5 4 4 2-2 5 4"></path></svg>',
    'terminal-2': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 7 4 4-4 4M12 17h7"></path></svg>',
    'chevron-down': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>',
    'chevron-right': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>',
    'text-wrap': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h12a3 3 0 0 1 0 6h-3"></path><path d="m15 16-2 2 2 2"></path><path d="M4 18h5"></path></svg>',
    maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"></path></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"></path></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 20h14"></path></svg>',
    'external-link': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8v4l2 2"></path><path d="M3.05 11a9 9 0 1 1 .5 4M3 4v4h4"></path></svg>',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function titleForArtifact(artifact) {
    return String(artifact?.title || artifact?.generatedFile?.title || artifact?.generatedFile?.fileName || 'Artifact').trim() || 'Artifact';
  }

  function glyphNameForKind(kind) {
    if (kind === 'markdown') return 'file-text';
    if (kind === 'mermaid') return 'share';
    if (kind === 'chart') return 'chart-bar';
    if (kind === 'html' || kind === 'svg') return 'browser';
    if (kind === 'image') return 'photo';
    if (kind === 'text') return 'terminal-2';
    return 'file-code';
  }

  function kindGlyphHtml(kind) { return ICONS[glyphNameForKind(kind)] || ICONS['file-code']; }

  function typeChipForArtifact(artifact, kind) {
    var fileName = String(artifact?.generatedFile?.fileName || artifact?.generatedFile?.displayPath || '');
    var match = fileName.match(/\.([A-Za-z0-9]+)$/);
    if (match) return match[1].toUpperCase();
    if (kind === 'image') return 'IMAGE';
    if (kind === 'mermaid') return 'MERMAID';
    if (artifact?.artifactType === 'tool_output') return 'TOOL';
    return '';
  }

  function buildTitleHtml(input) {
    var title = titleForArtifact(input?.artifact);
    var glyph = input?.artifact
      ? '<span class="artifact-panel-kind-glyph" aria-hidden="true">' + kindGlyphHtml(input?.kind) + '</span>'
      : '';
    var titleContent = '<span class="artifact-panel-title-text">' + escapeHtml(title) + '</span>';
    var titleNode = input?.artifactCount >= 2
      ? actionButton({ plain: true, domId: 'artifactReviewDetailTitle', className: 'artifact-panel-title', ariaLabel: 'Select an artifact', title: 'Select an artifact', ariaHaspopup: 'listbox', ariaExpanded: input.switcherOpen === true, ariaControls: 'artifactPanelSwitcher', dataset: { 'artifact-switcher-trigger': '' }, trustedHtml: titleContent + '<span class="artifact-panel-title-chevron">' + ICONS['chevron-down'] + '</span>' })
      : '<span class="artifact-panel-title" id="artifactReviewDetailTitle">' + titleContent + '</span>';
    var chip = typeChipForArtifact(input?.artifact, input?.kind);
    return glyph + titleNode + (chip ? '<span class="artifact-panel-type-chip">' + escapeHtml(chip) + '</span>' : '')
      + (input?.dirty ? '<span class="artifact-panel-dirty-dot" title="Unsaved changes" aria-hidden="true"></span>' : '');
  }

  // Header "Open in IDE": rendered hidden/disabled and revealed by
  // syncArtifactPanelOpenIdeButton (renderer-artifacts-utils.js) only in
  // `file_preview` rail mode. It carries data-file-preview-open-ide so the
  // file preview controller's existing panel-level click/keydown delegation
  // (renderer-artifact-file-preview.js) opens the current preview target
  // through the cancelable ide:open-file-at-line seam — no second handler.
  function buildOpenIdeButtonHtml() {
    return actionButton({
      plain: true,
      className: 'artifact-panel-icon-btn artifact-panel-open-ide hidden',
      ariaLabel: 'Open in IDE',
      title: 'Open in IDE',
      disabled: true,
      dataset: { 'artifact-panel-open-ide': '', 'file-preview-open-ide': 'true' },
      trustedHtml: ICONS['external-link'],
    });
  }

  function buildHeaderHtml() {
    return '<div class="artifact-panel-header"><div class="artifact-panel-header-primary" data-artifact-panel-title-slot><span class="artifact-panel-title" id="artifactReviewDetailTitle"><span class="artifact-panel-title-text">Artifact</span></span></div><div class="artifact-panel-header-actions">'
      + buildOpenIdeButtonHtml()
      + actionButton({ plain: true, className: 'artifact-panel-icon-btn artifact-panel-maximize', ariaLabel: 'Maximize panel', title: 'Maximize panel', ariaPressed: false, dataset: { 'artifact-panel-maximize': '' }, trustedHtml: ICONS.maximize })
      + actionButton({ plain: true, className: 'artifact-panel-icon-btn artifact-panel-overflow', ariaLabel: 'More actions', title: 'More actions', ariaHaspopup: 'menu', ariaExpanded: false, dataset: { 'artifact-panel-overflow': '' }, trustedHtml: ICONS.dots })
      + actionButton({ plain: true, domId: 'artifactReviewCollapseButton', className: 'artifact-panel-icon-btn', ariaLabel: 'Collapse panel', title: 'Collapse panel', trustedHtml: ICONS['chevron-right'] })
      + '</div></div>';
  }

  // Wrap toggle: rendered hidden and revealed by syncTextWrapButton
  // (renderer-artifact-panel-v2-render.js) whenever the active body is
  // text-like (editor shell, read-only source pre, or the file-preview list).
  // The tool-output viewer keeps its own inline Wrap control.
  function buildWrapButtonHtml() {
    return actionButton({
      plain: true,
      className: 'artifact-panel-icon-btn artifact-panel-wrap hidden',
      ariaLabel: 'Wrap long lines',
      title: 'Wrap long lines',
      ariaPressed: true,
      dataset: { 'artifact-panel-wrap': '' },
      trustedHtml: ICONS['text-wrap'],
    });
  }

  function buildControlsHtml() {
    return '<div class="artifact-panel-controls"><div class="artifact-panel-controls-view" data-artifact-panel-view-slot></div><div class="artifact-panel-controls-actions">'
      + '<span data-artifact-panel-v2-stepper-slot></span><span class="artifact-panel-divider hidden" data-artifact-panel-stepper-divider></span>'
      + buildWrapButtonHtml()
      + actionButton({ plain: true, className: 'artifact-panel-icon-btn artifact-panel-copy', ariaLabel: 'Copy', title: 'Copy', dataset: { 'artifact-panel-v2-copy': '' }, trustedHtml: ICONS.copy })
      + actionButton({ plain: true, className: 'artifact-panel-icon-btn artifact-panel-download', ariaLabel: 'Download', title: 'Download', dataset: { 'artifact-panel-download': '' }, trustedHtml: ICONS.download })
      + '<span class="artifact-panel-save-revert" data-artifact-panel-v2-save-revert>'
      + actionButton({ plain: true, domId: 'artifactReviewRevertButton', className: 'artifact-panel-text-btn hidden', ariaLabel: 'Revert', title: 'Revert', label: 'Revert' })
      + actionButton({ plain: true, domId: 'artifactReviewSaveButton', className: 'artifact-panel-text-btn artifact-panel-save-btn hidden', ariaLabel: 'Save', title: 'Save', label: 'Save' })
      + '</span></div></div>';
  }

  function buildViewControlHtml(value) {
    return segmentedControl({ id: 'artifact-view', className: 'inv-segmented--compact', ariaLabel: 'Artifact view', value: value, options: [{ value: 'preview', label: 'Preview' }, { value: 'code', label: 'Code' }] });
  }

  function buildContentHtml() {
    return '<div class="artifact-review-scroll artifact-panel-v2-scroll"><div class="artifact-panel-v2-empty" id="artifactReviewDetailEmpty">Select an artifact</div>'
      + '<div class="artifact-review-detail-panel hidden" id="artifactReviewDetailPanel"><div class="hidden" id="artifactReviewDetailKicker"></div><div class="hidden" id="artifactReviewDetailPath"></div><div class="hidden" id="artifactReviewDetailStatus"></div><div class="hidden" id="artifactReviewDetailMeta"></div><div class="hidden" id="artifactReviewDetailNote"></div><span class="hidden" id="artifactReviewDirtyBadge"></span>'
      + '<div class="artifact-panel-v2-content-host" id="artifactReviewPreviewShell"><div class="artifact-editor-shell hidden" id="artifactReviewEditorShell"><div class="artifact-editor-host" id="artifactReviewEditorHost" aria-label="Artifact editor"></div><textarea class="artifact-editor-fallback hidden" id="artifactReviewEditorFallback" spellcheck="false" aria-label="Artifact editor fallback"></textarea></div><div class="artifact-preview-content hidden" id="artifactReviewPreviewContent"></div></div></div></div>';
  }

  function buildStatusHtml() {
    var popover = inventoryPopover({ id: 'artifact-panel-v2-provenance', domId: 'artifactPanelV2ProvenancePopover', className: 'artifact-panel-v2-provenance-popover', ariaLabel: 'Provenance', trustedHtml: '<div class="artifacts-provenance-timeline" id="artifactReviewProvenanceTimeline"></div>' });
    return '<div class="artifact-panel-status"><span class="artifact-panel-status-meta" id="artifactPanelV2FooterMeta"></span><span class="hidden" id="artifactReviewStatus"></span><span class="artifact-panel-save-state" data-artifact-save-state aria-live="polite"></span>'
      + actionButton({ plain: true, domId: 'artifactPanelV2ProvenanceTrigger', className: 'artifact-panel-icon-btn artifact-panel-v2-footer-action', ariaLabel: 'Provenance', title: 'Provenance', ariaHaspopup: 'dialog', ariaControls: 'artifactPanelV2ProvenancePopover', trustedHtml: ICONS.history }) + popover + '</div>';
  }

  function buildHiddenLegacyActionsHtml() {
    return '<div class="artifact-panel-hidden-actions" aria-hidden="true">'
      + actionButton({ plain: true, domId: 'artifactReviewRevealButton', className: 'hidden', ariaLabel: 'Reveal in folder' })
      + actionButton({ plain: true, domId: 'artifactReviewOpenExternalButton', className: 'hidden', ariaLabel: 'Open externally' })
      + actionButton({ plain: true, domId: 'artifactReviewJumpButton', className: 'hidden', ariaLabel: 'Jump to chat' })
      + actionButton({ plain: true, domId: 'artifactReviewDeleteButton', className: 'hidden', ariaLabel: 'Delete artifact' })
      + '</div>';
  }

  function buildPanelHtml() { return buildHeaderHtml() + buildControlsHtml() + buildContentHtml() + buildStatusHtml() + buildHiddenLegacyActionsHtml(); }

  function byteLength(value) {
    var text = String(value || '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function formatByteSize(value) {
    var bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatFooterTimestamp(value) {
    var parsed = new Date(String(value || ''));
    if (Number.isNaN(parsed.getTime())) return '';
    try { return parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (_error) { return ''; }
  }

  function buildStatusMetaText(artifact, source, formatLanguageLabel) {
    if (!artifact) return '';
    var file = artifact.generatedFile || {};
    var label = file.language && typeof formatLanguageLabel === 'function'
      ? formatLanguageLabel(file.language)
      : artifact.artifactType === 'image' ? 'image' : artifact.artifactType === 'tool_output' ? 'tool output' : String(file.artifactKind || '');
    var segments = [];
    if (label) segments.push(String(label).toLowerCase());
    if (source !== undefined && source !== null) segments.push(formatByteSize(byteLength(source)));
    var turn = Number(artifact.turnIndex || artifact.turnNumber);
    if (Number.isInteger(turn) && turn > 0) segments.push('turn ' + turn);
    var time = formatFooterTimestamp(artifact.timestamp);
    if (time) segments.push(time);
    return segments.join(' · ');
  }

  return { ICONS: ICONS, buildPanelHtml: buildPanelHtml, buildOpenIdeButtonHtml: buildOpenIdeButtonHtml, buildTitleHtml: buildTitleHtml, buildViewControlHtml: buildViewControlHtml, buildStatusMetaText: buildStatusMetaText, formatByteSize: formatByteSize, formatFooterTimestamp: formatFooterTimestamp, kindGlyphHtml: kindGlyphHtml, titleForArtifact: titleForArtifact };
});
