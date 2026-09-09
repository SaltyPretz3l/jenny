/* renderer/shell/renderer-settings-lazy-renderers.js - Lazy Settings render helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsLazyRenderers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Render inventory switches into a stable .settings-toggle-list container.
  // Dependencies resolve at call time so this UMD module remains lightweight.
  function renderToggleListInto(target, fields, escapeHtml) {
    if (!target) { return; }
    const support = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSupport)
      || (typeof require === 'function' ? require('./renderer-settings-support') : null);
    const toggleSwitch = (typeof globalThis !== 'undefined' && globalThis.inventory && globalThis.inventory.toggleSwitch)
      || (typeof require === 'function' ? require('../inventory/toggle-switch').toggleSwitch : null);
    target.innerHTML = support && typeof support.buildSettingsToggleListMarkup === 'function'
      ? support.buildSettingsToggleListMarkup({ fields, escapeHtml, toggleSwitch })
      : '';
  }

  function renderOfflineSummary(options) {
    const {
      offlineDom,
      offlineState,
      renderStatusRowContainer,
      buildSettingsSummaryModel,
      escapeHtml,
    } = options;
    if (!offlineDom.offlineSummary) {
      return;
    }
    renderStatusRowContainer(offlineDom.offlineSummary, buildSettingsSummaryModel({
      tone: offlineState.mode === 'local_only'
        ? (offlineState.localChatReady ? 'success' : 'warning')
        : offlineState.localChatReady
          ? 'default'
          : String(offlineState.unavailableReason || '').trim()
            ? 'warning'
            : 'default',
      label: jt('settings.shell.forceLocalInference', 'Force local inference'),
      message: String(offlineState.summary || '').trim()
        || (offlineState.mode === 'local_only'
          ? (offlineState.localChatReady
            ? jt('settings.offline.forcedWithModel', 'Force local inference is on with {model}.', { model: String(offlineState.preferredLocalModel || 'a local model') })
            : String(offlineState.unavailableReason || jt('settings.offline.forcedNotReady', 'Force local inference is enabled but not ready.')))
          : offlineState.localChatReady
            ? jt('settings.offline.localRuntimeReady', 'Local runtime is ready with {model}.', { model: String(offlineState.preferredLocalModel || 'a local model') })
            : jt('settings.offline.forcedOff', 'Force local inference is off.')),
      badgeText: offlineState.mode === 'local_only'
        ? 'Forced'
        : offlineState.localChatReady
          ? 'Ready'
          : 'Optional',
    }), escapeHtml);
  }

  // Maps registry cost classes to user-facing GPU-use text.
  const COST_CLASS_COPY = Object.freeze({
    low: jt('settings.appearance.gpuUseLight', 'light on your GPU'),
    medium: jt('settings.appearance.gpuUseModerate', 'moderate GPU use'),
    high: jt('settings.appearance.gpuUseHeavy', 'heavier GPU use'),
  });

  function buildSurfaceEffectMetaText(preset) {
    if (!preset || preset.id === 'none') { return ''; }
    const parts = [];
    const cost = COST_CLASS_COPY[String(preset.costClass || '').toLowerCase()];
    if (cost) { parts.push(cost); }
    const recommended = Array.isArray(preset.recommendedPalettes) ? preset.recommendedPalettes : [];
    if (recommended.length) {
      parts.push(jt('settings.appearance.surfaceEffectRecommendedPalettes', 'looks best with the {palettes} palette', { palettes: recommended.join(' or ') }));
    }
    return parts.join(' · ');
  }

  // The renderer consumes the registry description, cost class, and recommended palettes.
  function renderSurfaceEffectCopy(options) {
    const { descriptionEl, metaEl, preset } = options;
    if (descriptionEl) {
      descriptionEl.textContent = String((preset && preset.description) || '').trim()
        || jt('settings.appearance.surfaceEffectFallback', 'An ambient layer behind Home and Chat.');
    }
    if (metaEl) {
      const meta = buildSurfaceEffectMetaText(preset);
      metaEl.textContent = meta;
      metaEl.hidden = !meta;
    }
  }

  // Resolved at call time so this UMD module stays dependency-free, matching
  // renderToggleListInto above. One preview instance for the process.
  let surfaceEffectPreview = null;
  function resolveSurfaceEffectPreviewModule() {
    return (typeof globalThis !== 'undefined' && globalThis.rendererSurfaceEffectPreview)
      || (typeof require === 'function' ? require('./renderer-surface-effect-preview') : null);
  }

  function renderSurfaceEffectPreview(options) {
    const { host, effectId, visible, windowRef, documentRef, reducedMotionQuery } = options || {};
    if (!host) { return null; }
    if (!surfaceEffectPreview) {
      const previewModule = resolveSurfaceEffectPreviewModule();
      if (!previewModule || typeof previewModule.createSurfaceEffectPreview !== 'function') { return null; }
      surfaceEffectPreview = previewModule.createSurfaceEffectPreview({
        windowRef, documentRef, reducedMotionQuery,
      });
    }
    surfaceEffectPreview.render({ host, effectId, visible });
    return surfaceEffectPreview;
  }

  // Called from the settings renderer's dispose(): the preview must never
  // outlive the panel, or it keeps a rAF alive behind a closed Settings view.
  function disposeSurfaceEffectPreview() {
    if (surfaceEffectPreview) {
      surfaceEffectPreview.dispose();
      surfaceEffectPreview = null;
    }
  }

  // Personality v3 has no summary row: the section header carries the one
  // aria-live status line instead (spec D, "no badge, no summary row").
  function renderLazySummaries(options) {
    renderOfflineSummary(options);
  }

  const LAZY_MANAGER_RENDERERS = Object.freeze([
    ['offline', 'renderOfflineManager'],
    ['skills', 'renderSkillsManager'],
    ['personality', 'renderPersonalityEditor'],
  ]);

  function renderLazyManagers(options) {
    const shouldRenderLazySection = options.shouldRenderLazySection || function fallbackShouldRenderLazySection() { return false; };
    for (let index = 0; index < LAZY_MANAGER_RENDERERS.length; index += 1) {
      const [sectionId, rendererKey] = LAZY_MANAGER_RENDERERS[index];
      if (shouldRenderLazySection(sectionId)) {
        options[rendererKey]();
      }
    }
  }

  return {
    renderToggleListInto,
    renderLazyManagers,
    renderLazySummaries,
    renderSurfaceEffectCopy,
    renderSurfaceEffectPreview,
    disposeSurfaceEffectPreview,
    buildSurfaceEffectMetaText,
  };
});
