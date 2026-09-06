/** Artifact Panel V2/V3 chrome. Replaces panel children while preserving the
 * legacy ids consumed by the surface controller; flag-off remains a no-op. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/action-button'),
      require('../inventory/popover'),
      require('./renderer-artifact-version-history-utils'),
      require('./renderer-artifact-panel-chrome-render'),
      require('./renderer-artifact-view-capabilities'),
      require('./renderer-artifact-panel-switcher'),
      require('./renderer-artifact-panel-actions'),
      require('./renderer-artifacts-projection')
    );
    return;
  }
  root.rendererArtifactPanelV2 = factory(
    root.inventoryActionButton,
    root.inventoryPopover,
    root.rendererArtifactVersionHistoryUtils,
    root.rendererArtifactPanelChromeRender,
    root.rendererArtifactViewCapabilities,
    root.rendererArtifactPanelSwitcher,
    root.rendererArtifactPanelActions,
    root.rendererArtifactsProjection
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryActionButton, inventoryPopover, versionHistoryUtils, chromeRender, viewCapabilities, switcherModule, actionsModule, projection) {
  'use strict';

  const CHEVRON_LEFT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6"></path></svg>';
  const CHEVRON_RIGHT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6l-6 6"></path></svg>';
  const COLLAPSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6"></path></svg>';
  const EDIT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"></path><path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"></path><path d="M16 5l3 3"></path></svg>';
  const COPY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"></path></svg>';
  const FOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"></path></svg>';
  const MESSAGE_CIRCLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20l-3 -3h-2a3 3 0 0 1 -3 -3v-6a3 3 0 0 1 3 -3h10a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3h-2l-3 3"></path></svg>';
  const TRASH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"></path><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"></path></svg>';
  const HISTORY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8l0 4l2 2"></path><path d="M3.05 11a9 9 0 1 1 .5 4"></path><path d="M3 4v4h4"></path></svg>';

  function noop() {}

  function isFlagEnabled(state) {
    return state?.features?.featureFlags?.artifact_panel_v2 === true;
  }

  function isV3Enabled(state) {
    return state?.features?.featureFlags?.artifact_panel_v3 === true;
  }

  function formatArtifactKindLabel(kind) {
    return String(kind || '').trim().replace(/_/g, ' ');
  }

  function formatFooterTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return '';
    try {
      return parsed.toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    } catch (_error) {
      return raw;
    }
  }

  function buildFooterMetaText(artifact) {
    if (!artifact) return '';
    const segments = [];
    const kind = artifact.artifactType === 'generated_file'
      ? formatArtifactKindLabel(artifact.generatedFile?.artifactKind || 'document')
      : artifact.artifactType === 'image'
        ? 'image'
        : artifact.artifactType === 'tool_output'
          ? 'tool output'
          : '';
    if (kind) segments.push(kind);
    const time = formatFooterTimestamp(artifact.timestamp);
    if (time) segments.push(time);
    return segments.join(' · ');
  }

  function isArtifactDirty(state, artifact) {
    const file = artifact?.generatedFile || null;
    if (!artifact || artifact.artifactType !== 'generated_file' || !file || file.editable !== true) return false;
    return state?.artifacts?.loadedArtifactId === file.artifactId
      && state?.artifacts?.dirtyContent !== state?.artifacts?.loadedArtifactContent;
  }

  function headerHtml() {
    return (
      '<div class="artifact-panel-v2-header">'
      + '<span class="artifact-panel-v2-title" id="artifactReviewDetailTitle"></span>'
      + '<div class="artifact-panel-v2-header-actions">'
      + inventoryActionButton({
        plain: true,
        domId: 'artifactReviewCollapseButton',
        className: 'artifact-panel-v2-icon-btn',
        ariaLabel: 'Collapse panel',
        title: 'Collapse panel',
        trustedHtml: COLLAPSE_SVG,
      })
      + '</div>'
      + '</div>'
    );
  }

  function toolbarHtml() {
    return (
      '<div class="artifact-panel-v2-toolbar">'
      + '<span class="artifact-panel-v2-save-revert" data-artifact-panel-v2-save-revert>'
      + inventoryActionButton({
        plain: true,
        domId: 'artifactReviewSaveButton',
        className: 'artifact-panel-v2-text-btn artifact-panel-v2-save-btn hidden',
        ariaLabel: 'Save artifact',
        title: 'Save',
        label: 'Save',
      })
      + inventoryActionButton({
        plain: true,
        domId: 'artifactReviewRevertButton',
        className: 'artifact-panel-v2-text-btn hidden',
        ariaLabel: 'Revert artifact',
        title: 'Revert',
        label: 'Revert',
      })
      + '</span>'
      + inventoryActionButton({
        plain: true,
        className: 'artifact-panel-v2-icon-btn',
        ariaLabel: 'Edit source',
        title: 'Edit source',
        ariaPressed: false,
        dataset: { 'artifact-panel-v2-edit': '' },
        trustedHtml: EDIT_SVG,
      })
      + inventoryActionButton({
        plain: true,
        className: 'artifact-panel-v2-icon-btn',
        ariaLabel: 'Copy',
        title: 'Copy',
        dataset: { 'artifact-panel-v2-copy': '' },
        trustedHtml: COPY_SVG,
      })
      + inventoryActionButton({
        plain: true,
        domId: 'artifactReviewRevealButton',
        className: 'artifact-panel-v2-icon-btn',
        ariaLabel: 'Reveal in folder',
        title: 'Reveal in folder',
        trustedHtml: FOLDER_SVG,
      })
      + inventoryActionButton({
        plain: true,
        domId: 'artifactReviewJumpButton',
        className: 'artifact-panel-v2-icon-btn',
        ariaLabel: 'Jump to chat',
        title: 'Jump to chat',
        trustedHtml: MESSAGE_CIRCLE_SVG,
      })
      + '<span class="artifact-panel-v2-toolbar-spacer" data-artifact-panel-v2-stepper-slot></span>'
      + inventoryActionButton({
        plain: true,
        domId: 'artifactReviewDeleteButton',
        className: 'artifact-panel-v2-icon-btn artifact-panel-v2-delete-btn',
        ariaLabel: 'Delete artifact',
        title: 'Delete artifact',
        trustedHtml: TRASH_SVG,
      })
      + inventoryActionButton({
        plain: true,
        domId: 'artifactReviewOpenExternalButton',
        className: 'artifact-panel-v2-icon-btn hidden',
        ariaLabel: 'Open artifact externally',
        title: 'Open artifact externally',
      })
      + '</div>'
    );
  }

  function contentHtml() {
    return (
      '<div class="artifact-review-scroll artifact-panel-v2-scroll">'
      + '<div class="artifact-panel-v2-empty" id="artifactReviewDetailEmpty">Select an artifact</div>'
      + '<div class="artifact-review-detail-panel hidden" id="artifactReviewDetailPanel">'
      // Hidden nodes the controller still writes to (kicker/path/status/meta/note/dirtyBadge).
      + '<div class="hidden" id="artifactReviewDetailKicker"></div>'
      + '<div class="hidden" id="artifactReviewDetailPath"></div>'
      + '<div class="hidden" id="artifactReviewDetailStatus"></div>'
      + '<div class="hidden" id="artifactReviewDetailMeta"></div>'
      + '<div class="hidden" id="artifactReviewDetailNote"></div>'
      + '<span class="hidden" id="artifactReviewDirtyBadge"></span>'
      + '<div class="artifact-panel-v2-content-host" id="artifactReviewPreviewShell">'
      + '<div class="artifact-editor-shell hidden" id="artifactReviewEditorShell">'
      + '<div class="artifact-editor-host" id="artifactReviewEditorHost" aria-label="Artifact editor"></div>'
      + '<textarea class="artifact-editor-fallback hidden" id="artifactReviewEditorFallback" spellcheck="false" aria-label="Artifact editor fallback"></textarea>'
      + '</div>'
      + '<div class="artifact-preview-content hidden" id="artifactReviewPreviewContent"></div>'
      + '</div>'
      + '</div>'
      + '</div>'
    );
  }

  function footerHtml() {
    const popoverHtml = inventoryPopover({
      id: 'artifact-panel-v2-provenance',
      domId: 'artifactPanelV2ProvenancePopover',
      className: 'artifact-panel-v2-provenance-popover',
      ariaLabel: 'Provenance',
      trustedHtml: '<div class="artifacts-provenance-timeline" id="artifactReviewProvenanceTimeline"></div>',
    });
    return (
      '<div class="artifact-panel-v2-footer">'
      + '<span class="artifact-panel-v2-footer-meta" id="artifactPanelV2FooterMeta"></span>'
      + '<span class="hidden" id="artifactReviewStatus"></span>'
      + inventoryActionButton({
        plain: true,
        domId: 'artifactPanelV2ProvenanceTrigger',
        className: 'artifact-panel-v2-icon-btn artifact-panel-v2-footer-action',
        ariaLabel: 'Provenance',
        title: 'Provenance',
        ariaHaspopup: 'dialog',
        ariaControls: 'artifactPanelV2ProvenancePopover',
        trustedHtml: HISTORY_SVG,
      })
      + popoverHtml
      + '</div>'
    );
  }

  function buildStepperHtml(info) {
    if (!info || info.count < 2) return '';
    const step = (label, glyph, targetId, disabled) => inventoryActionButton({
      plain: true,
      className: 'artifact-panel-v2-icon-btn artifact-panel-v2-stepper-btn',
      ariaLabel: label,
      title: label,
      disabled,
      dataset: disabled || !targetId ? {} : { 'artifact-select': targetId },
      trustedHtml: glyph,
    });
    return (
      '<span class="artifact-panel-v2-stepper">'
      + step('Previous version', CHEVRON_LEFT_SVG, info.prevId, info.index <= 1)
      + `<span class="artifact-panel-v2-stepper-count">v${info.index}/${info.count}</span>`
      + step('Next version', CHEVRON_RIGHT_SVG, info.nextId, info.index >= info.count)
      + '</span>'
    );
  }

  function createArtifactPanelV2(deps) {
    const {
      panelEl = null,
      state = {},
      windowRef = typeof window !== 'undefined' ? window : null,
      escapeHtml = (value) => String(value ?? ''),
      appendClientLog = noop,
      showToastMessage = noop,
    } = deps || {};

    let didInstall = false;
    let bound = false;
    let managerHooks = {};
    let switcherController = null;
    let actionsController = null;
    let saveStateTimer = null;
    let saveStateArtifactKey = '';
    let previousSavePending = false;
    let currentArtifact = null;
    const renderedSlotHtml = new WeakMap();

    function resolveCapabilities(artifact) {
      return viewCapabilities?.resolveArtifactViewCapabilities?.(artifact, {
        isImageArtifact: projection?.isImageArtifact,
        isMarkdownGeneratedArtifact: projection?.isMarkdownGeneratedArtifact,
        isMermaidGeneratedArtifact: projection?.isMermaidGeneratedArtifact,
        isHtmlGeneratedArtifact: projection?.isHtmlGeneratedArtifact,
        isSvgGeneratedArtifact: projection?.isSvgGeneratedArtifact,
        isChartGeneratedArtifact: projection?.isChartGeneratedArtifact,
        extractMermaidSourceFromToolArtifact: projection?.extractMermaidSourceFromToolArtifact,
      }) || { hasPreview: false, hasCode: true, defaultView: 'code', kind: 'text' };
    }

    function setupV3Controllers() {
      if (!isV3Enabled(state)) return;
      const overlayManager = windowRef?.rendererOverlayManagerController || null;
      if (!switcherController) {
        switcherController = switcherModule?.createArtifactPanelSwitcher?.({
          panelEl, documentRef: panelEl?.ownerDocument, overlayManager, resolveCapabilities,
          onSelect: (artifactId) => managerHooks.selectArtifact?.(artifactId),
        }) || null;
      }
      if (!actionsController) {
        actionsController = actionsModule?.createArtifactPanelActions?.({
          panelEl, windowRef, formatLanguageLabel: projection?.formatLanguageLabel, appendClientLog, showToastMessage,
          getArtifactSource: () => managerHooks.getSelectedArtifactSource?.() || '',
          toggleMaximize: () => managerHooks.toggleMaximize?.(),
        }) || null;
      }
    }

    function installed() {
      if (didInstall) return true;
      if (!panelEl || !isFlagEnabled(state)) return false;
      try {
        panelEl.innerHTML = isV3Enabled(state) && chromeRender?.buildPanelHtml
          ? chromeRender.buildPanelHtml()
          : headerHtml() + toolbarHtml() + contentHtml() + footerHtml();
        panelEl.classList.add('artifact-panel-v2');
        panelEl.classList.toggle('artifact-panel-v3', isV3Enabled(state));
        didInstall = true;
        setupV3Controllers();
      } catch (error) {
        appendClientLog('ERROR', 'artifacts.panel_v2_install_failed', {
          message: String(error?.message || error || ''),
        });
        return false;
      }
      return true;
    }

    function connect(hooks) {
      managerHooks = hooks && typeof hooks === 'object' ? hooks : {};
      setupV3Controllers();
    }

    function getProvenancePopoverEl() {
      return panelEl?.querySelector?.('#artifactPanelV2ProvenancePopover') || null;
    }

    function afterRender(artifact) {
      if (!didInstall) return;
      currentArtifact = artifact || null;
      if (isV3Enabled(state)) {
        afterRenderV3(artifact);
        return;
      }
      const footerMeta = panelEl.querySelector('#artifactPanelV2FooterMeta');
      if (footerMeta) footerMeta.textContent = buildFooterMetaText(artifact);

      const dirty = isArtifactDirty(state, artifact);
      const saveBtn = panelEl.querySelector('#artifactReviewSaveButton');
      const revertBtn = panelEl.querySelector('#artifactReviewRevertButton');
      if (saveBtn) saveBtn.classList.toggle('hidden', !dirty);
      if (revertBtn) revertBtn.classList.toggle('hidden', !dirty);

      const isImage = Boolean(artifact) && artifact.artifactType === 'image';
      // Edit only does something for markdown generated artifacts (the
      // read<->source toggle is a no-op everywhere else -- code kinds render
      // unconditionally in-editor); an affordance that cannot act must not
      // render enabled, so hide it rather than show a dead-looking control.
      const isMarkdownToggleable = typeof managerHooks.isSelectedArtifactMarkdownGenerated === 'function'
        && managerHooks.isSelectedArtifactMarkdownGenerated() === true;
      const editBtn = panelEl.querySelector('[data-artifact-panel-v2-edit]');
      const copyBtn = panelEl.querySelector('[data-artifact-panel-v2-copy]');
      if (editBtn) {
        editBtn.classList.toggle('hidden', !isMarkdownToggleable);
        editBtn.disabled = !isMarkdownToggleable;
        const mode = isMarkdownToggleable && typeof managerHooks.getArtifactDocumentViewMode === 'function'
          ? managerHooks.getArtifactDocumentViewMode('split')
          : null;
        editBtn.setAttribute('aria-pressed', mode === 'source' ? 'true' : 'false');
      }
      if (copyBtn) {
        copyBtn.disabled = isImage;
        copyBtn.setAttribute('aria-disabled', isImage ? 'true' : 'false');
      }

      const slot = panelEl.querySelector('[data-artifact-panel-v2-stepper-slot]');
      if (slot) {
        const info = artifact && typeof versionHistoryUtils?.resolveArtifactVersionInfo === 'function'
          ? versionHistoryUtils.resolveArtifactVersionInfo(artifact, state)
          : null;
        slot.innerHTML = buildStepperHtml(info);
      }
    }

    function currentV3View(capabilities) {
      if (capabilities.kind === 'markdown') {
        return managerHooks.getArtifactDocumentViewMode?.('split') === 'source' ? 'code' : 'preview';
      }
      return managerHooks.getArtifactViewMode?.(capabilities.kind) === 'edit'
        ? 'code'
        : capabilities.defaultView;
    }

    function syncSlotHtml(slot, html) {
      if (!slot || renderedSlotHtml.get(slot) === html) return;
      const active = slot.ownerDocument?.activeElement;
      const focusKey = slot.contains(active)
        ? { id: active.id || '', value: active.dataset?.value, artifactId: active.dataset?.artifactSelect }
        : null;
      slot.innerHTML = html;
      renderedSlotHtml.set(slot, html);
      if (!focusKey) return;
      const candidates = slot.querySelectorAll('button, [tabindex]');
      const target = [...candidates].find((node) => (focusKey.id && node.id === focusKey.id)
        || (focusKey.value !== undefined && node.dataset?.value === focusKey.value)
        || (focusKey.artifactId !== undefined && node.dataset?.artifactSelect === focusKey.artifactId));
      target?.focus?.({ preventScroll: true });
    }

    function syncSaveState(artifact, dirty) {
      const target = panelEl.querySelector('[data-artifact-save-state]');
      if (!target) return;
      const artifactKey = artifact ? `${String(artifact.sessionId || '')}::${String(artifact.id || '')}` : '';
      if (artifactKey !== saveStateArtifactKey) {
        saveStateArtifactKey = artifactKey;
        previousSavePending = false;
      }
      const savePending = Boolean(artifactKey && state?.artifacts?.savePending);
      if (saveStateTimer) windowRef?.clearTimeout?.(saveStateTimer);
      saveStateTimer = null;
      target.classList.remove('is-settled');
      if (savePending) target.textContent = 'Saving…';
      else if (dirty) target.textContent = 'Unsaved';
      else if (previousSavePending && !state?.artifacts?.lastError) {
        target.textContent = 'Saved';
        saveStateTimer = windowRef?.setTimeout?.(() => target.classList.add('is-settled'), 0) || null;
      } else target.textContent = '';
      previousSavePending = savePending;
    }

    function afterRenderV3(artifact) {
      setupV3Controllers();
      const artifacts = managerHooks.getArtifacts?.() || [];
      const dirty = isArtifactDirty(state, artifact);
      const capabilities = resolveCapabilities(artifact);
      const titleSlot = panelEl.querySelector('[data-artifact-panel-title-slot]');
      syncSlotHtml(titleSlot, chromeRender.buildTitleHtml({ artifact, artifactCount: switcherController ? artifacts.length : 1, dirty, kind: capabilities.kind, switcherOpen: switcherController?.isOpen?.() === true }));
      const viewSlot = panelEl.querySelector('[data-artifact-panel-view-slot]');
      syncSlotHtml(viewSlot, capabilities.hasPreview && capabilities.hasCode ? chromeRender.buildViewControlHtml(currentV3View(capabilities)) : '');

      const saveBtn = panelEl.querySelector('#artifactReviewSaveButton');
      const revertBtn = panelEl.querySelector('#artifactReviewRevertButton');
      saveBtn?.classList.toggle('hidden', !dirty);
      revertBtn?.classList.toggle('hidden', !dirty);
      const hasArtifact = Boolean(artifact);
      const isImage = hasArtifact && capabilities.kind === 'image';
      const copyBtn = panelEl.querySelector('[data-artifact-panel-v2-copy]');
      const downloadBtn = panelEl.querySelector('[data-artifact-panel-download]');
      const overflowBtn = panelEl.querySelector('[data-artifact-panel-overflow]');
      const provenanceBtn = panelEl.querySelector('#artifactPanelV2ProvenanceTrigger');
      if (copyBtn) { copyBtn.disabled = !hasArtifact || isImage; copyBtn.setAttribute('aria-disabled', copyBtn.disabled ? 'true' : 'false'); }
      if (downloadBtn) { downloadBtn.disabled = !hasArtifact || isImage || !actionsController; downloadBtn.setAttribute('aria-disabled', downloadBtn.disabled ? 'true' : 'false'); downloadBtn.classList.toggle('hidden', isImage); }
      if (overflowBtn) { overflowBtn.disabled = !hasArtifact || !actionsController; overflowBtn.setAttribute('aria-disabled', overflowBtn.disabled ? 'true' : 'false'); }
      if (provenanceBtn) { provenanceBtn.disabled = !hasArtifact; provenanceBtn.setAttribute('aria-disabled', provenanceBtn.disabled ? 'true' : 'false'); }

      const info = artifact && versionHistoryUtils?.resolveArtifactVersionInfo?.(artifact, state);
      const slot = panelEl.querySelector('[data-artifact-panel-v2-stepper-slot]');
      syncSlotHtml(slot, buildStepperHtml(info));
      panelEl.querySelector('[data-artifact-panel-stepper-divider]')?.classList.toggle('hidden', !info || info.count < 2);

      const source = managerHooks.getSelectedArtifactSource?.();
      const meta = panelEl.querySelector('#artifactPanelV2FooterMeta');
      if (meta) meta.textContent = chromeRender.buildStatusMetaText(artifact, source, projection?.formatLanguageLabel);
      syncSaveState(artifact, dirty);

      const maximized = managerHooks.isMaximized?.() === true;
      const maximizeBtn = panelEl.querySelector('[data-artifact-panel-maximize]');
      if (maximizeBtn) {
        const label = maximized ? 'Restore panel size' : 'Maximize panel';
        maximizeBtn.disabled = !actionsController;
        maximizeBtn.setAttribute('aria-disabled', maximizeBtn.disabled ? 'true' : 'false');
        maximizeBtn.setAttribute('aria-label', label);
        maximizeBtn.setAttribute('title', label);
        maximizeBtn.setAttribute('aria-pressed', maximized ? 'true' : 'false');
        maximizeBtn.innerHTML = maximized ? chromeRender.ICONS.restore : chromeRender.ICONS.maximize;
      }
      syncTextWrapButton();
    }

    // Wrap toggle: visible whenever the active body is text-like — the code
    // editor shell, a read-only source <pre>, or the file-preview list. The
    // tool-output viewer is excluded (it carries its own inline Wrap control).
    // managerHooks.syncTextWrap applies the state to every body and returns it.
    function syncTextWrapButton() {
      const btn = panelEl?.querySelector?.('[data-artifact-panel-wrap]');
      if (!btn) return;
      const textBody = panelEl.querySelector(
        '.artifact-editor-shell:not(.hidden), .artifact-preview-content:not(.hidden) .artifact-preview-pre, .artifact-file-preview-code'
      );
      btn.classList.toggle('hidden', !textBody);
      if (!textBody) return;
      const wrapped = managerHooks.syncTextWrap?.() !== false;
      btn.setAttribute('aria-pressed', wrapped ? 'true' : 'false');
    }

    function handlePanelClick(event) {
      if (isV3Enabled(state)) {
        handlePanelV3Click(event);
        return;
      }
      const editBtn = event.target.closest?.('[data-artifact-panel-v2-edit]');
      if (editBtn) {
        if (typeof managerHooks.toggleEdit === 'function') {
          managerHooks.toggleEdit();
        } else if (typeof managerHooks.setArtifactDocumentViewMode === 'function') {
          const current = typeof managerHooks.getArtifactDocumentViewMode === 'function'
            ? managerHooks.getArtifactDocumentViewMode('split')
            : 'read';
          managerHooks.setArtifactDocumentViewMode('split', current === 'source' ? 'read' : 'source');
        }
        return;
      }
      const copyBtn = event.target.closest?.('[data-artifact-panel-v2-copy]');
      if (copyBtn) {
        if (typeof managerHooks.copySelectedArtifact === 'function') {
          managerHooks.copySelectedArtifact();
        }
        return;
      }
      const stepperBtn = event.target.closest?.('.artifact-panel-v2-stepper-btn[data-artifact-select]');
      if (stepperBtn) {
        const targetId = stepperBtn.dataset.artifactSelect;
        if (targetId && typeof managerHooks.selectArtifact === 'function') {
          managerHooks.selectArtifact(targetId);
        }
        return;
      }
      const provenanceTrigger = event.target.closest?.('#artifactPanelV2ProvenanceTrigger');
      if (provenanceTrigger) {
        const popEl = getProvenancePopoverEl();
        if (popEl && inventoryPopover?.toggle) {
          inventoryPopover.toggle(popEl, { trigger: provenanceTrigger });
        }
      }
    }

    function handlePanelV3Click(event) {
      const titleButton = event.target.closest?.('[data-artifact-switcher-trigger]');
      if (titleButton) {
        if (switcherController?.isOpen?.()) switcherController.close();
        else switcherController?.open?.({
          artifacts: managerHooks.getArtifacts?.() || [],
          currentArtifactId: currentArtifact?.id,
          triggerEl: titleButton,
        });
        return;
      }
      if (event.target.closest?.('[data-artifact-panel-maximize]')) {
        actionsController?.toggleMaximize?.();
        return;
      }
      const overflow = event.target.closest?.('[data-artifact-panel-overflow]');
      if (overflow) {
        actionsController?.showOverflow?.(currentArtifact, overflow);
        return;
      }
      if (event.target.closest?.('[data-artifact-panel-download]')) {
        actionsController?.download?.(currentArtifact);
        return;
      }
      if (event.target.closest?.('[data-artifact-panel-wrap]')) {
        managerHooks.toggleTextWrap?.();
        syncTextWrapButton();
        return;
      }
      if (event.target.closest?.('[data-artifact-panel-v2-copy]')) {
        managerHooks.copySelectedArtifact?.();
        return;
      }
      const stepperBtn = event.target.closest?.('.artifact-panel-v2-stepper-btn[data-artifact-select]');
      if (stepperBtn?.dataset?.artifactSelect) {
        managerHooks.selectArtifact?.(stepperBtn.dataset.artifactSelect);
        return;
      }
      const provenanceTrigger = event.target.closest?.('#artifactPanelV2ProvenanceTrigger');
      if (provenanceTrigger) {
        const popEl = getProvenancePopoverEl();
        if (popEl && inventoryPopover?.toggle) inventoryPopover.toggle(popEl, { trigger: provenanceTrigger });
      }
    }

    function handleSegmentedChange(event) {
      if (!isV3Enabled(state) || event.detail?.id !== 'artifact-view') return;
      const viewSlot = panelEl.querySelector('[data-artifact-panel-view-slot]');
      if (viewSlot) renderedSlotHtml.delete(viewSlot);
      const capabilities = resolveCapabilities(currentArtifact);
      const code = event.detail.value === 'code';
      if (capabilities.kind === 'markdown') {
        managerHooks.setArtifactDocumentViewMode?.('split', code ? 'source' : 'read');
      } else {
        managerHooks.setArtifactViewMode?.(capabilities.kind, code ? 'edit' : 'preview');
      }
    }

    function bind() {
      if (bound || !panelEl) return;
      bound = true;
      panelEl.addEventListener('click', handlePanelClick);
      panelEl.addEventListener('inv-segmented-change', handleSegmentedChange);
      const rootForPopover = panelEl.ownerDocument || windowRef?.document || null;
      if (rootForPopover && inventoryPopover?.initPopoverHandlers) {
        inventoryPopover.initPopoverHandlers(rootForPopover);
      }
    }

    function dispose() {
      if (bound && panelEl) {
        panelEl.removeEventListener('click', handlePanelClick);
        panelEl.removeEventListener('inv-segmented-change', handleSegmentedChange);
      }
      bound = false;
      switcherController?.dispose?.();
      switcherController = null;
      actionsController?.dispose?.();
      actionsController = null;
      if (saveStateTimer) windowRef?.clearTimeout?.(saveStateTimer);
      saveStateTimer = null;
    }

    return { installed, connect, afterRender, bind, dispose };
  }

  return { createArtifactPanelV2 };
});
