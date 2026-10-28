/* Settings > Tools: provider-scoped preferences for the next delegation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.rendererSettingsSubagents = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || ((key, fallback) => fallback);
  const controllers = new WeakMap();
  const providers = ['chatgpt', 'codex-cli'];
  const clone = (row) => ({ defaultModel: row?.defaultModel || '', defaultEffort: row?.defaultEffort || '',
    preferredModels: Array.isArray(row?.preferredModels) ? [...row.preferredModels] : [],
    allowedModels: Array.isArray(row?.allowedModels) ? [...row.allowedModels] : [], maxEffort: row?.maxEffort || '' });
  const empty = () => clone();
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const effortLabels = () => ({
    default: jt('settings.subagents.effortDefault', 'Provider default'),
    none: jt('settings.subagents.effortNone', 'None'),
    minimal: jt('settings.subagents.effortMinimal', 'Minimal'),
    low: jt('settings.subagents.effortLow', 'Low'),
    medium: jt('settings.subagents.effortMedium', 'Medium'),
    high: jt('settings.subagents.effortHigh', 'High'),
    xhigh: jt('settings.subagents.effortXhigh', 'Extra high'),
    max: jt('settings.subagents.effortMax', 'Maximum'),
  });
  // The accessible name of each routing select, by its field id.
  const selectLabels = () => ({
    provider: jt('settings.subagents.provider', 'Provider'),
    model: jt('settings.subagents.defaultModel', 'Default model'),
    effort: jt('settings.subagents.defaultEffort', 'Default effort'),
    maximum: jt('settings.subagents.maximumEffort', 'Maximum effort'),
    allowed: jt('settings.subagents.allowedModels', 'Allowed models'),
    preferred: jt('settings.subagents.addPreferred', 'Add preferred model'),
  });

  function createSubagentRoutingController(options = {}) {
    const windowRef = options.windowRef || globalThis;
    const container = options.container;
    const inventory = options.inventory || windowRef.inventory || {};
    const getFeatures = options.getFeatures || (() => ({}));
    const getBridge = options.getBridge || (() => windowRef.jennyShell?.features);
    let provider = 'chatgpt';
    const drafts = {};
    const baselines = {};
    let catalog = {};
    let busy = false;
    let loading = false;
    let disposed = false;
    let generation = 0;
    let message = '';
    let failed = false;
    let unsubscribe = null;
    let bound = false;
    let lastHost = null;
    let lastMarkup = '';
    let actionFocusId = '';
    let actionFocusFallback = null;
    const saved = (id = provider) => clone(getFeatures().subagentRouting?.[id]);
    const draft = () => {
      if (drafts[provider] && equal(drafts[provider], baselines[provider]) && !equal(baselines[provider], saved())) delete drafts[provider];
      if (!drafts[provider]) { baselines[provider] = saved(); drafts[provider] = saved(); }
      return drafts[provider];
    };
    const toolDisabled = () => getFeatures().tools?.subagents === false || getFeatures().availability?.tools?.subagents?.enabled === false;
    const dirty = () => !equal(draft(), saved());
    const models = () => (Array.isArray(catalog[provider]?.models) ? catalog[provider].models : []).slice(0, 128);
    const efforts = () => {
      const row = models().find((model) => model.id === draft().defaultModel);
      return Array.isArray(row?.reasoning_efforts) ? row.reasoning_efforts.filter((effort) => Object.hasOwn(effortLabels(), effort)) : [];
    };
    function row(id, label, controlHtml, help = '') {
      return inventory.settingsField?.({ id, label, help, controlHtml, variant: 'row', className: 'settings-field--sub' }) || '';
    }
    function select(id, value, choices, disabled = false) {
      return inventory.selectField?.({ id: `subagent-${id}`, value, options: choices, disabled: busy || toolDisabled() || disabled,
        ariaLabel: selectLabels()[id], dataset: { 'subagent-field': id } }) || '';
    }
    function button(action, label, index, disabled = false, model = '', list = 'preferred') {
      return inventory.actionButton?.({ label, ariaLabel: model ? `${label}: ${model}` : label,
        domId: `subagent-action-${action}-${list}-${model ? Array.from(model, (char) => char.codePointAt(0).toString(16)).join('-') : 'provider'}`, disabled: busy || toolDisabled() || disabled, variant: 'secondary',
        dataset: { 'subagent-action': action, ...(index === undefined ? {} : { index: String(index), list }) } }) || '';
    }
    function render(restoreActionFocus = false) {
      if (disposed) return;
      const host = container?.querySelector?.('[data-subagent-routing-host]');
      if (!host) return;
      const current = draft();
      const available = models();
      const inherit = jt('settings.subagents.inherit', 'Inherit primary');
      const modelChoices = [{ value: '', label: inherit }, ...available.map((model) => ({ value: model.id,
        label: model.label || model.id, disabled: model.available === false }))];
      if (current.defaultModel && !available.some((model) => model.id === current.defaultModel)) {
        modelChoices.push({ value: current.defaultModel, label: current.defaultModel, disabled: true });
      }
      const effortChoices = [{ value: '', label: jt('settings.subagents.effortAutomatic', 'Automatic') }, ...efforts().map((effort) => ({ value: effort, label: effortLabels()[effort] }))];
      if (current.defaultEffort && !effortChoices.some((choice) => choice.value === current.defaultEffort)) {
        effortChoices.push({ value: current.defaultEffort, label: effortLabels()[current.defaultEffort] || current.defaultEffort, disabled: true });
      }
      const staleDefault = current.defaultModel && !available.some((model) => model.id === current.defaultModel && model.available !== false);
      const staleEffort = current.defaultEffort && !efforts().includes(current.defaultEffort);
      let status = message || (staleEffort && !staleDefault ? jt('settings.subagents.defaultEffortUnavailable', 'Saved default effort is no longer available. Delegation uses a supported effort automatically.') : '') || (staleDefault ? jt('settings.subagents.defaultUnavailable', 'Saved default is no longer available. Delegation uses an available model automatically.') : '');
      if (!status) status = loading ? jt('settings.subagents.catalogLoading', 'Checking available models…')
        : !available.length ? jt('settings.subagents.catalogEmpty', 'No model catalog is available for this provider. Connect it in Models and refresh.')
          : catalog[provider]?.available === false ? jt('settings.subagents.providerUnavailable', 'This provider is unavailable. Saved preferences apply when it is ready.')
            : catalog[provider]?.stale ? jt('settings.subagents.catalogStale', 'Showing a cached model catalog. Refresh to check availability.') : '';
      const markup = row('subagent-routing-provider', jt('settings.subagents.title', 'Subagent routing'), select('provider', provider,
        [{ value: 'chatgpt', label: jt('settings.subagents.chatgpt', 'ChatGPT') }, { value: 'codex-cli', label: jt('settings.subagents.codexCli', 'Codex CLI') }]),
      jt('settings.subagents.help', 'Defaults and preferred models guide delegation on the next turn. The primary agent can override them; running subagents keep their selections.'))
        + row('subagent-routing-model', jt('settings.subagents.defaultModel', 'Default model'), select('model', current.defaultModel, modelChoices))
        + row('subagent-routing-effort', jt('settings.subagents.defaultEffort', 'Default effort'), select('effort', current.defaultEffort, effortChoices, !efforts().length && !current.defaultEffort))
        + row('subagent-routing-preferred', jt('settings.subagents.preferredModels', 'Preferred models in order'), select('preferred', '',
          [{ value: '', label: jt('settings.subagents.addPreferred', 'Add preferred model') }, ...available
            .filter((model) => !current.preferredModels.includes(model.id)).map((model) => ({ value: model.id, label: model.label || model.id, disabled: model.available === false }))], current.preferredModels.length >= 16),
        jt('settings.subagents.preferredHelp', 'Earlier models are preferred. This list does not restrict the primary agent’s choices.'))
        + current.preferredModels.map((id, index) => row(`subagent-preferred-${index}`, `${index + 1}. ${available.find((model) => model.id === id)?.label || id}`,
          button('up', jt('settings.subagents.moveUp', 'Move up'), index, index === 0, id)
          + button('down', jt('settings.subagents.moveDown', 'Move down'), index, index === current.preferredModels.length - 1, id)
          + button('remove', jt('settings.subagents.remove', 'Remove'), index, false, id))).join('')
        + row('subagent-routing-allowed', jt('settings.subagents.allowedModels', 'Allowed models'), select('allowed', '',
          [{ value: '', label: jt('settings.subagents.addAllowed', 'Add allowed model') }, ...available
            .filter((model) => !current.allowedModels.includes(model.id)).map((model) => ({ value: model.id, label: model.label || model.id, disabled: model.available === false }))], current.allowedModels.length >= 16),
        jt('settings.subagents.allowedHelp', 'An empty list allows every available model. A populated list restricts every subagent to these models.'))
        + current.allowedModels.map((id, index) => row(`subagent-allowed-${index}`, available.find((model) => model.id === id)?.label || id,
          button('remove', jt('settings.subagents.remove', 'Remove'), index, false, id, 'allowed'))).join('')
        + row('subagent-routing-maximum', jt('settings.subagents.maximumEffort', 'Maximum effort'), select('maximum', current.maxEffort,
          [{ value: '', label: jt('settings.subagents.noMaximum', 'No maximum') }, ...Object.keys(effortLabels()).filter((effort) => effort !== 'default').map((effort) => ({ value: effort, label: effortLabels()[effort] }))]),
        jt('settings.subagents.maximumHelp', 'This limit applies to explicit choices, defaults and inherited effort. The primary agent cannot override it.'))
        + row('subagent-routing-actions', '', button('save', jt('settings.subagents.save', 'Save routing'), undefined, !dirty())
          + button('reset', jt('settings.subagents.reset', 'Reset provider'), undefined, equal(current, empty()) && equal(saved(), empty()))
          + button('refresh', jt('settings.subagents.refresh', 'Refresh models'), undefined, loading));
      host.setAttribute('aria-disabled', String(toolDisabled()));
      host.classList.toggle('settings-field--disabled', toolDisabled());
      let statusNode = host.querySelector('[data-subagent-routing-status]');
      if (!statusNode) {
        statusNode = host.ownerDocument.createElement('div');
        statusNode.setAttribute('data-subagent-routing-status', '');
        statusNode.setAttribute('role', 'status');
        statusNode.setAttribute('aria-live', 'polite');
        host.append(statusNode);
      }
      statusNode.textContent = status;
      statusNode.setAttribute('data-tone', failed ? 'danger' : 'default');
      if (host === lastHost && markup === lastMarkup) return;
      const activeElement = host.ownerDocument.activeElement;
      const focusedId = (restoreActionFocus && activeElement === actionFocusFallback && actionFocusId)
        || (host.contains(activeElement) ? activeElement.id : '');
      let content = host.querySelector('[data-subagent-routing-content]');
      if (!content) { content = host.ownerDocument.createElement('div'); content.setAttribute('data-subagent-routing-content', ''); host.prepend(content); }
      content.innerHTML = markup;
      lastHost = host;
      lastMarkup = markup;
      if (focusedId) {
        const previous = host.ownerDocument.getElementById(focusedId);
        const focusTarget = previous && !previous.disabled ? previous : previous?.closest('.settings-field')?.querySelector('button:not(:disabled)')
          || host.querySelector('[data-subagent-action=save]:not(:disabled)') || host.querySelector('select:not(:disabled)');
        focusTarget?.focus({ preventScroll: true });
      }
    }
    // The action control that had focus, so a settle can hand focus back to it.
    function captureActionFocus() {
      const active = container?.ownerDocument?.activeElement;
      actionFocusId = container?.querySelector('[data-subagent-routing-host]')?.contains(active) ? active.id : '';
    }
    function adopt(payload) {
      if (!payload) return;
      catalog = payload.subagentModelCatalogs || catalog;
      options.applyFeatures?.(payload);
    }
    // Re-entering Tools re-reads the catalog only once it is this old.
    const SHOWN_REFRESH_MS = 30000;
    let loadedAt = 0;
    function refreshIfStale() {
      if (Date.now() - loadedAt >= SHOWN_REFRESH_MS) void refresh();
    }
    async function refresh() {
      if (disposed || loading || busy) return;
      const token = ++generation;
      captureActionFocus();
      loading = true;
      message = '';
      failed = false;
      render();
      actionFocusFallback = container?.ownerDocument?.activeElement;
      try {
        // The shared model read primes the existing authenticated catalog owner.
        await windowRef.jennyShell?.models?.list?.().catch(() => null);
        const payload = await getBridge()?.getState?.();
        if (disposed || token !== generation) return;
        adopt(payload);
        loadedAt = Date.now();
      } catch (_error) {
        if (disposed || token !== generation) return;
        failed = true;
        message = jt('settings.subagents.catalogFailed', 'Model availability could not be checked. Try refreshing again.');
      } finally {
        if (!disposed && token === generation) { loading = false; render(true); actionFocusId = ''; }
      }
    }
    async function save(reset = false) {
      if (disposed || busy || toolDisabled()) return;
      captureActionFocus();
      const selectedProvider = provider;
      const submitted = reset ? empty() : clone(draft());
      generation += 1; // Invalidate catalog reads that captured pre-save settings.
      loading = false;
      busy = true;
      failed = false;
      message = '';
      render();
      actionFocusFallback = container?.ownerDocument?.activeElement;
      try {
        const payload = await getBridge()?.updateSettings?.({ subagentRouting: { [selectedProvider]: submitted } });
        if (disposed) return;
        if (!payload?.subagentRouting?.[selectedProvider] || !equal(clone(payload.subagentRouting[selectedProvider]), submitted)) throw new Error('routing_not_confirmed');
        adopt(payload);
        drafts[selectedProvider] = clone(submitted);
        baselines[selectedProvider] = clone(submitted);
        message = jt('settings.subagents.saved', 'Routing saved for the next turn.');
      } catch (_error) {
        if (disposed) return;
        failed = true;
        message = jt('settings.subagents.saveFailed', 'Routing could not be saved. Your draft is kept; try again.');
      } finally {
        if (!disposed) { busy = false; render(true); actionFocusId = ''; }
      }
    }
    function change(event) {
      if (busy || disposed || toolDisabled()) return;
      actionFocusId = '';
      const target = event.target;
      const field = target?.dataset?.subagentField;
      if (!field) return;
      if (field === 'provider' && providers.includes(target.value)) provider = target.value;
      else if (field === 'model') {
        draft().defaultModel = target.value;
        if (!efforts().includes(draft().defaultEffort)) draft().defaultEffort = '';
      } else if (field === 'effort') draft().defaultEffort = target.value;
      else if (field === 'maximum') draft().maxEffort = target.value;
      else if (field === 'allowed' && target.value && !draft().allowedModels.includes(target.value) && draft().allowedModels.length < 16) draft().allowedModels.push(target.value);
      else if (field === 'preferred' && target.value && !draft().preferredModels.includes(target.value) && draft().preferredModels.length < 16) {
        draft().preferredModels.push(target.value);
      }
      message = '';
      failed = false;
      render();
    }
    function click(event) {
      const target = event.target?.closest?.('[data-subagent-action]');
      if (!target || busy || disposed || toolDisabled()) return;
      const action = target.dataset.subagentAction;
      if (action === 'save' || action === 'reset') { void save(action === 'reset'); return; }
      if (action === 'refresh') { void refresh(); return; }
      const index = Number(target.dataset.index);
      const list = target.dataset.list === 'allowed' ? draft().allowedModels : draft().preferredModels;
      if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
      if (action === 'remove') list.splice(index, 1);
      const other = action === 'up' ? index - 1 : action === 'down' ? index + 1 : -1;
      if (other >= 0 && other < list.length) [list[index], list[other]] = [list[other], list[index]];
      message = '';
      render();
    }
    function bind() {
      if (bound || disposed || !container) return;
      bound = true;
      controllers.set(container, controller);
      catalog = getFeatures().subagentModelCatalogs || {};
      container.addEventListener('change', change);
      container.addEventListener('click', click);
      unsubscribe = getBridge()?.onChanged?.((payload) => {
        if (disposed) return;
        generation += 1;
        loading = false;
        for (const id of providers) if (drafts[id] && equal(drafts[id], baselines[id])) delete drafts[id];
        adopt(payload);
        render();
      });
      render();
      void refresh();
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      unsubscribe?.();
      container?.removeEventListener?.('change', change);
      container?.removeEventListener?.('click', click);
      controllers.delete(container);
    }
    const controller = { bind, render, refresh, refreshIfStale, dispose, save };
    return controller;
  }
  return { createSubagentRoutingController, sync: (container) => controllers.get(container)?.render() };
});
