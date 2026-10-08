/** Artifact panel (Canvas) chrome. Replaces panel children while preserving
 * the legacy ids consumed by the surface controller. */
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

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const CHEVRON_LEFT_SVG = '<svg class="icon-mirror-rtl" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6"></path></svg>';
  const CHEVRON_RIGHT_SVG = '<svg class="icon-mirror-rtl" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6l-6 6"></path></svg>';

  function noop() {}

  function isArtifactDirty(state, artifact) {
    const file = artifact?.generatedFile || null;
    if (!artifact || artifact.artifactType !== 'generated_file' || !file || file.editable !== true) return false;
    return state?.artifacts?.loadedArtifactId === file.artifactId
      && state?.artifacts?.dirtyContent !== state?.artifacts?.loadedArtifactContent;
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
      + step(jt('artifacts.review.previousVersion', 'Previous version'), CHEVRON_LEFT_SVG, info.prevId, info.index <= 1)
      + `<span class="artifact-panel-v2-stepper-count">v${info.index}/${info.count}</span>`
      + step(jt('artifacts.review.nextVersion', 'Next version'), CHEVRON_RIGHT_SVG, info.nextId, info.index >= info.count)
      + '</span>'
    );
  }

  function createArtifactPanelV2(deps) {
    const {
      panelEl = null,
      state = {},
      windowRef = typeof window !== 'undefined' ? window : null,
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
    // The owner's wrap state ({ apply(kind), toggle(kind) }, per body kind).
    let textWrapController = null;
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
          getArtifactSource: () => managerHooks.getSelectedArtifactSource?.(),
          isCurrentArtifact: (artifact) => currentArtifact?.id === artifact?.id && currentArtifact?.sessionId === artifact?.sessionId,
          toggleMaximize: () => managerHooks.toggleMaximize?.(),
          isMaximized: () => managerHooks.isMaximized?.() === true,
          isNarrow: () => panelEl?.dataset?.panelNarrow === 'true',
        }) || null;
      }
    }

    function installed() {
      if (didInstall) return true;
      if (!panelEl || typeof chromeRender?.buildPanelHtml !== 'function') return false;
      try {
        panelEl.innerHTML = chromeRender.buildPanelHtml();
        panelEl.classList.add('artifact-panel-v2');
        panelEl.classList.add('artifact-panel-v3');
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
      const mode = state.ui?.artifactReview?.mode || 'artifact';
      if (mode !== 'artifact') artifact = null;
      if (currentArtifact?.id !== artifact?.id || currentArtifact?.sessionId !== artifact?.sessionId) {
        actionsController?.closeOverflow?.();
        switcherController?.close?.();
      }
      currentArtifact = artifact || null;
      afterRenderV3(artifact, mode);
      if (mode !== 'artifact') {
        const title = panelEl.querySelector('.artifact-panel-title-text');
        if (title) title.textContent = mode === 'code_review' ? jt("artifactPanelV2Render.changes", "Changes") : mode === 'file_preview' ? jt("ide.filePreviewLabel", "File preview") : mode === 'notes' ? jt("projectNotes.title", "Notes") : jt("artifactPanelV2Render.tasks", "Tasks");
      }
    }

    function patchDirtyState(artifact) {
      if (!didInstall || (state.ui?.artifactReview?.mode || 'artifact') !== 'artifact') return;
      const dirty = isArtifactDirty(state, artifact);
      panelEl.querySelector('#artifactReviewSaveButton')?.classList.toggle('hidden', !dirty);
      panelEl.querySelector('#artifactReviewRevertButton')?.classList.toggle('hidden', !dirty);
      syncSaveState(artifact, dirty);
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
      if (savePending) target.textContent = jt('artifacts.status.saving', 'Saving…');
      else if (dirty) target.textContent = jt('artifacts.status.unsaved', 'Unsaved');
      else if (previousSavePending && !state?.artifacts?.lastError) {
        target.textContent = jt('artifacts.status.saved', 'Saved');
        saveStateTimer = windowRef?.setTimeout?.(() => target.classList.add('is-settled'), 0) || null;
      } else target.textContent = '';
      previousSavePending = savePending;
    }

    function setHidden(node, hidden) {
      node?.classList?.toggle('hidden', hidden);
    }

    function setDisabled(node, disabled) {
      if (!node) return;
      node.disabled = disabled;
      node.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }

    function afterRenderV3(artifact, mode = 'artifact') {
      setupV3Controllers();
      const artifactMode = mode === 'artifact';
      const artifacts = artifact ? managerHooks.getArtifacts?.() || [] : [];
      const dirty = isArtifactDirty(state, artifact);
      const capabilities = resolveCapabilities(artifact);
      const titleSlot = panelEl.querySelector('[data-artifact-panel-title-slot]');
      syncSlotHtml(titleSlot, chromeRender.buildTitleHtml({ artifact, artifactCount: switcherController ? artifacts.length : 1, dirty, kind: capabilities.kind, switcherOpen: switcherController?.isOpen?.() === true, formatLanguageLabel: projection?.formatLanguageLabel }));
      const viewSlot = panelEl.querySelector('[data-artifact-panel-view-slot]');
      syncSlotHtml(viewSlot, capabilities.hasPreview && capabilities.hasCode ? chromeRender.buildViewControlHtml(currentV3View(capabilities)) : '');

      const saveBtn = panelEl.querySelector('#artifactReviewSaveButton');
      const revertBtn = panelEl.querySelector('#artifactReviewRevertButton');
      saveBtn?.classList.toggle('hidden', !dirty);
      revertBtn?.classList.toggle('hidden', !dirty && !(artifact && state.artifacts.loadState === 'error'));
      const hasArtifact = Boolean(artifact);
      const sourceReady = hasArtifact && managerHooks.getSelectedArtifactSource?.() != null;
      const isImage = hasArtifact && capabilities.kind === 'image';
      // Tasks, code review, file preview and subagents share this header for
      // its Close only: the artifact actions hide there.
      const copyBtn = panelEl.querySelector('[data-artifact-panel-v2-copy]');
      const overflowBtn = panelEl.querySelector('[data-artifact-panel-overflow]');
      setHidden(copyBtn, !artifactMode);
      setDisabled(copyBtn, !sourceReady || isImage);
      setHidden(overflowBtn, !artifactMode);
      setDisabled(overflowBtn, !hasArtifact || !actionsController);
      setDisabled(panelEl.querySelector('#artifactPanelV2ProvenanceTrigger'), !hasArtifact);

      const info = artifact && versionHistoryUtils?.resolveArtifactVersionInfo?.(artifact, state);
      const slot = panelEl.querySelector('[data-artifact-panel-v2-stepper-slot]');
      syncSlotHtml(slot, buildStepperHtml(info));
      panelEl.querySelector('[data-artifact-panel-stepper-divider]')?.classList.toggle('hidden', !info || info.count < 2);

      const source = artifact ? managerHooks.getSelectedArtifactSource?.() : null;
      const meta = panelEl.querySelector('#artifactPanelV2FooterMeta');
      if (meta) meta.textContent = chromeRender.buildStatusMetaText(artifact, source);
      syncSaveState(artifact, dirty);

      // Maximize lives in More; the header shows a pressed Restore only while
      // maximized, in the Maximize slot, in every mode: More is artifact-only,
      // so Restore is the way back from a maximized file preview or code review.
      const maximized = managerHooks.isMaximized?.() === true;
      const restoreBtn = panelEl.querySelector('[data-artifact-panel-maximize]');
      setHidden(restoreBtn, !maximized);
      setDisabled(restoreBtn, !actionsController);
      syncTextWrapButton(mode);
    }

    // The text body the Wrap control governs, or null: a tool output ('output'),
    // or the code editor, a read-only source pre, the file-preview list ('code').
    function activeWrapKind(mode = state.ui?.artifactReview?.mode || 'artifact') {
      if (mode !== 'artifact' && mode !== 'file_preview') return null;
      if (panelEl.querySelector('.artifact-preview-content:not(.hidden) .artifact-output-viewer')) return 'output';
      const codeBody = panelEl.querySelector(
        '.artifact-editor-shell:not(.hidden), .artifact-preview-content:not(.hidden) .artifact-preview-pre, .artifact-file-preview-code'
      );
      return codeBody ? 'code' : null;
    }

    // Wrap: shown only for text bodies. The state lives on the panel (a class
    // the owner flips, Monaco's own option), never on the re-rendered body.
    function syncTextWrapButton(mode) {
      const btn = panelEl?.querySelector?.('[data-artifact-panel-wrap]');
      if (!btn) return;
      const kind = activeWrapKind(mode);
      btn.classList.toggle('hidden', !kind);
      if (!kind) return;
      const wrapped = textWrapController?.apply?.(kind) !== false;
      btn.setAttribute('aria-pressed', wrapped ? 'true' : 'false');
    }

    function toggleTextWrap() {
      const kind = activeWrapKind();
      if (!kind) return;
      textWrapController?.toggle?.(kind);
      syncTextWrapButton();
    }

    function setTextWrapController(controller) {
      textWrapController = controller && typeof controller === 'object' ? controller : null;
    }

    // Restore hides itself once the panel is back to size: hand focus to More,
    // or to the title where More is hidden or disabled, never to <body>.
    function keepFocusAfterRestore() {
      const restoreBtn = panelEl.querySelector('[data-artifact-panel-maximize]');
      if (!restoreBtn?.classList.contains('hidden')) return;
      const overflow = panelEl.querySelector('[data-artifact-panel-overflow]');
      const target = overflow && !overflow.classList.contains('hidden') && !overflow.disabled
        ? overflow
        : panelEl.querySelector('#artifactReviewDetailTitle');
      target?.focus?.({ preventScroll: true });
    }

    function handlePanelClick(event) {
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
        keepFocusAfterRestore();
        return;
      }
      const overflow = event.target.closest?.('[data-artifact-panel-overflow]');
      if (overflow) {
        actionsController?.showOverflow?.(currentArtifact, overflow);
        return;
      }
      if (event.target.closest?.('[data-artifact-panel-wrap]')) {
        toggleTextWrap();
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
      if (event.detail?.id !== 'artifact-view') return;
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

    return { installed, connect, afterRender, patchDirtyState, bind, dispose, setTextWrapController };
  }

  return { createArtifactPanelV2 };
});
