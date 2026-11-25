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

  /* Row 194: "which model does which job" is edited in Settings > Models > Model roles (a module loaded on first use).
   * Chat and Tools keep one read-only row with a link there. */
  const modelBindings = new WeakMap();
  const tryRequire = (path) => { try { return typeof require === 'function' ? require(path) : null; } catch (_error) { return null; } };
  const inventoryPart = (name, path) => globalThis.inventory?.[name] || tryRequire(path);

  function rolesPointerRow(id, title, text) {
    const link = inventoryPart('actionButton', '../inventory/action-button')({ plain: true, className: 'settings-row-link',
      label: jt('settings.roles.pointer.link', 'Change in Models'), dataset: { 'open-model-roles': 'true' } });
    return inventoryPart('settingsField', '../inventory/settings-field')({ id, variant: 'row', label: title, help: text, className: 'roles-pointer', controlHtml: link });
  }

  // Opens Settings > Models and moves focus to the Model roles heading. The block mounts after its
  // module loads, so the first visit in a session waits for the heading (up to about two seconds).
  function openModelRoles(documentRef, { delayMs = 50, tries = 40 } = {}) {
    documentRef.getElementById('settingsNav-models')?.click();
    let left = tries;
    const focusHeading = () => {
      const heading = documentRef.getElementById('modelRolesHeading');
      if (!heading) { if ((left -= 1) > 0) setTimeout(focusHeading, delayMs); return; }
      heading.scrollIntoView?.({ block: 'center' }); // 'start' leaves it under the sticky Running now panel
      heading.focus({ preventScroll: true });
    };
    setTimeout(focusHeading, 0);
  }

  const rolesBlocks = new WeakMap();
  // Loads the Model roles block on first use, then paints it; options: { windowRef, documentRef, state, onDefaultChange }.
  function mountModelRoles(options) {
    const win = options.windowRef || globalThis;
    const ready = () => win.rendererSettingsModelRoles || tryRequire('./renderer-settings-model-roles');
    const run = () => {
      let block = rolesBlocks.get(options.documentRef);
      if (!block) { block = ready()?.createModelRolesBlock?.(options) || null; if (block) rolesBlocks.set(options.documentRef, block); }
      block?.render();
      return block;
    };
    if (ready()) return Promise.resolve(run());
    return Promise.resolve(win.scriptLoaderUtils?.ensureScript?.({ src: 'renderer/shell/renderer-settings-model-roles.js', isReady: () => Boolean(win.rendererSettingsModelRoles) }))
      .then((loaded) => (loaded ? run() : null), () => null);
  }

  function renderJennyChatModels(list, state, deps = {}) {
    const utils = globalThis.rendererComposerModelPickerUtils || tryRequire('../chat/renderer-composer-model-picker-utils');
    if (!list || typeof list.querySelector !== 'function' || !utils) return;
    const store = deps.store !== undefined ? deps.store : (globalThis.rendererPrimaryChatStore?.peekDefaultPrimaryChatStore?.() || null);
    const snap = store?.getSnapshot?.() || {};
    const own = String((state?.sessions || []).find((session) => session?.id === snap.session_id)?.preferred_model || '').trim();
    const now = own || String(utils.resolveDefaultChatModel(state).model || '').trim();
    const checkId = snap.check_model || snap.model || now;
    const checks = checkId ? jt('settings.chat.models.pointer.checks', ' Scheduled checks run on {model}.', { model: utils.displayModelId(checkId) }) : '';
    const text = snap.status !== 'ready' ? jt('settings.chat.models.unavailable', 'Available when the Jenny chat is on.')
      : (snap.model ? utils.displayModelId(snap.model) + '.' : now ? jt('settings.chat.models.pointer.follows', "Follows the chat's picker, now {model}.", { model: utils.displayModelId(now) })
        : jt('settings.chat.models.pointer.followsBare', "Follows the chat's picker.")) + checks;
    const html = rolesPointerRow('jennyModelPointer', jt('settings.chat.models.jenny.label', "Jenny's model"), text);
    if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
    let binding = modelBindings.get(list);
    if (!binding) {
      binding = { store: undefined, off: null };
      modelBindings.set(list, binding);
      list.addEventListener('click', (event) => { if (event.target?.closest?.('[data-open-model-roles]')) openModelRoles(list.ownerDocument); });
    }
    if (binding.store === store) return;
    binding.off?.();
    binding.store = store;
    binding.off = store?.subscribe?.(() => renderJennyChatModels(list, state, deps)) || null;
  }

  return {
    renderToggleListInto,
    renderJennyChatModels,
    rolesPointerRow,
    openModelRoles,
    mountModelRoles,
    renderLazyManagers,
    renderSurfaceEffectCopy,
    renderSurfaceEffectPreview,
    disposeSurfaceEffectPreview,
    buildSurfaceEffectMetaText,
  };
});
