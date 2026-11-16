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

  /* Settings > Chat > Jenny chat (row 144): "Jenny's model" and "Scheduled checks run on" (models under the 7B
   * floor are greyed out). Built once, then patched in place; with no store the rows stay, greyed out. */
  const MODEL_ROWS = Object.freeze([{ key: 'model', base: 'primaryModel' }, { key: 'check_model', base: 'checkModel' }]);
  const MARK = '\u0001';
  const modelBindings = new WeakMap();
  const tryRequire = (path) => { try { return typeof require === 'function' ? require(path) : null; } catch (_error) { return null; } };

  function modelRowCopy(key) {
    return key === 'model'
      ? [jt('settings.chat.models.jenny.label', "Jenny's model"),
        jt('settings.chat.models.jenny.help', 'The model the Jenny chat always uses, whatever you load in other chats or the Model Library.'),
        jt('settings.chat.models.jenny.first', "Follow the chat's picker")]
      : [jt('settings.chat.models.check.label', 'Scheduled checks run on'),
        jt('settings.chat.models.check.help', "A check that comes due loads this model and runs on it. Models under 7B can't run checks."),
        jt('settings.chat.models.check.first', "Same as Jenny's model")];
  }

  function modelLines(state, snap, utils, entries) {
    const find = (id) => entries.find((entry) => entry.id === id);
    const own = String((state?.sessions || []).find((session) => session?.id === snap.session_id)?.preferred_model || '').trim();
    const fallback = String(utils.resolveDefaultChatModel(state).model || '').trim();
    const checkId = snap.check_model || snap.model || own || fallback;
    const line = (text, id) => ({ text, mark: id });
    let jenny = { text: '' };
    if (snap.model) jenny = line(jt('settings.chat.models.jenny.pinned', 'Every Jenny chat turn runs on {model}. The picker in the Jenny chat is locked while this is set.', { model: MARK }), snap.model);
    else if (!own && fallback) jenny = line(jt('settings.chat.models.jenny.fromLibrary', 'Now: {model}, from the Model Library default.', { model: MARK }), fallback);
    let check = { text: '' };
    if (checkId) {
      const fit = utils.classifyCheckModel({ model: checkId, engineType: find(checkId)?.engineType, parameterSize: find(checkId)?.parameterSize });
      check = fit.fit ? line(jt('settings.chat.models.check.runsOn', 'Checks run on {model}.', { model: MARK }), checkId)
        : { text: jt('settings.chat.models.check.willWait', 'Checks will wait: {model}. Pick a bigger model here or above.', { model: MARK }), warn: true, mark: jt('settings.chat.models.check.underFloor', '{model} is under 7B', { model: checkId }) };
    }
    return { model: jenny, check_model: check };
  }

  function paintEffective(el, line) {
    const parts = String(line.text).split(MARK);
    el.replaceChildren(parts[0]);
    if (parts.length > 1) {
      const strong = el.ownerDocument.createElement('strong');
      strong.textContent = line.mark;
      el.append(strong, parts.slice(1).join(''));
    }
    el.classList.toggle('settings-field-effective--warn', line.warn === true);
  }

  function renderJennyChatModels(list, state, deps = {}) {
    if (!list || typeof list.querySelector !== 'function') return;
    const utils = globalThis.rendererComposerModelPickerUtils || tryRequire('../chat/renderer-composer-model-picker-utils');
    const settingsField = globalThis.inventory?.settingsField || tryRequire('../inventory/settings-field');
    const selectField = globalThis.inventory?.selectField || tryRequire('../inventory/select-field');
    if (!utils || typeof settingsField !== 'function' || typeof selectField !== 'function') return;
    const store = deps.store !== undefined ? deps.store : (globalThis.rendererPrimaryChatStore?.peekDefaultPrimaryChatStore?.() || null);
    const snap = store?.getSnapshot?.() || {};
    const ready = snap.status === 'ready';
    const entries = (Array.isArray(state?.modelList?.data) ? state.modelList.data : []).map((raw) => {
      const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
      return id ? { id, engineType: raw.engine_type || raw.engineType || '', parameterSize: raw.parameter_size || raw.parameterSize || '' } : null;
    }).filter(Boolean);
    const lines = modelLines(state, snap, utils, entries);
    if (!list.querySelector(`#${MODEL_ROWS[0].base}Select`)) {
      list.innerHTML = MODEL_ROWS.map(({ key, base }) => {
        const [label, help] = modelRowCopy(key);
        const control = selectField({ id: `${base}Select`, ariaLabel: label, describedBy: base + 'Help', dataset: { 'jenny-model-key': key }, options: [] });
        return settingsField({ id: `${base}Row`, variant: 'row', label, help, helpId: base + 'Help', controlHtml: control });
      }).join('');
      MODEL_ROWS.forEach(({ base }) => {
        const line = list.ownerDocument.createElement('p');
        line.className = 'settings-field-effective';
        line.id = `${base}Effective`;
        list.querySelector(`[data-settings-field="${base}Row"] .settings-field-text`)?.append(line);
      });
    }
    MODEL_ROWS.forEach(({ key, base }) => {
      const select = list.querySelector(`#${base}Select`);
      const row = list.querySelector(`[data-settings-field="${base}Row"]`);
      if (!select || !row) return;
      const current = String(snap[key] || '');
      const options = [{ value: '', label: modelRowCopy(key)[2] }].concat(entries.map((entry) => {
        const small = key === 'check_model' && !utils.classifyCheckModel({ model: entry.id, engineType: entry.engineType, parameterSize: entry.parameterSize }).fit;
        return { value: entry.id, label: small ? jt('settings.chat.models.check.tooSmall', '{model} · under 7B, too small for checks', { model: entry.id }) : entry.id, disabled: small };
      }));
      if (current && !entries.some((entry) => entry.id === current)) options.push({ value: current, label: current });
      const signature = JSON.stringify([options, current, ready]);
      if (select.dataset.signature !== signature) {
        select.innerHTML = selectField.optionsMarkup(options, current);
        select.value = current;
        select.dataset.signature = signature;
        select.dataset.previous = current;
      }
      select.disabled = !ready;
      row.classList.toggle('settings-field--unavailable', !ready);
      const effective = list.querySelector(`#${base}Effective`);
      if (effective) paintEffective(effective, ready ? lines[key] : { text: jt('settings.chat.models.unavailable', 'Available when the Jenny chat is on.') });
    });
    bindJennyChatModels(list, store, settingsField, () => renderJennyChatModels(list, state, deps));
  }

  function bindJennyChatModels(list, store, settingsField, repaint) {
    let binding = modelBindings.get(list);
    if (!binding) {
      binding = { store: null, off: null };
      modelBindings.set(list, binding);
      list.addEventListener('change', async (event) => {
        const select = event.target;
        if (!select?.matches?.('select[data-jenny-model-key]')) return;
        const row = select.closest('.settings-field');
        const saved = (await binding.store?.setModels?.({ [select.dataset.jennyModelKey]: select.value }))?.ok === true;
        if (saved) select.dataset.previous = select.value;
        else select.value = select.dataset.previous || '';
        settingsField.setFieldError(row, saved ? '' : jt('settings.chat.models.saveFailed', 'Could not save this choice. Try again.'));
      });
    }
    if (binding.store === store) return;
    if (binding.off) binding.off();
    binding.store = store;
    binding.off = store?.subscribe?.(repaint) || null;
  }

  return {
    renderToggleListInto,
    renderJennyChatModels,
    renderLazyManagers,
    renderSurfaceEffectCopy,
    renderSurfaceEffectPreview,
    disposeSurfaceEffectPreview,
    buildSurfaceEffectMetaText,
  };
});
