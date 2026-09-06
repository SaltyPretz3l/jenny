(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererComposerModelPicker = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SVG_ATTRIBUTES = 'viewBox="0 0 16 16" fill="none" stroke="currentColor" '
    + 'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const EYE_GLYPH = `<svg ${SVG_ATTRIBUTES}><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>`;
  const BULB_GLYPH = `<svg ${SVG_ATTRIBUTES}><path d="M6 13h4M6.5 11a4.5 4.5 0 1 1 3 0z"/></svg>`;
  const CODE_GLYPH = `<svg ${SVG_ATTRIBUTES}><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/></svg>`;

  function resolveInventoryPrimitive(globalName, requirePath) {
    if (typeof root[globalName] === 'function') {
      return root[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function createComposerModelPicker(deps) {
    const options = deps || {};
    const state = options.state || {};
    const documentRef = options.documentRef
      || (typeof document !== 'undefined' ? document : null);
    const inventory = options.inventory || root.inventory || {};
    const actionButton = typeof inventory.actionButton === 'function'
      ? inventory.actionButton
      : resolveInventoryPrimitive('inventoryActionButton', '../inventory/action-button');
    const textField = typeof inventory.textField === 'function'
      ? inventory.textField
      : resolveInventoryPrimitive('inventoryTextField', '../inventory/text-field');
    const popover = typeof inventory.popover === 'function'
      ? inventory.popover
      : resolveInventoryPrimitive('inventoryPopover', '../inventory/popover');
    const utils = options.utils || root.rendererComposerModelPickerUtils || {};
    const formatUtils = options.formatUtils || root.rendererModelLibraryFormatUtils || {};
    const escapeHtml = typeof actionButton?.escapeHtml === 'function'
      ? actionButton.escapeHtml
      : (value) => String(value == null ? '' : value);

    let popoverEl = null;
    let host = null;
    let modelSelect = null;
    let effortSelect = null;
    let query = '';
    let signature = '';
    let bound = false;

    function readCarrierInputs() {
      const preferredModel = String(modelSelect?.value || '').trim();
      const effort = String(effortSelect?.value || '');
      return {
        preferredModel,
        effort,
        effortOptions: effortSelect
          ? [...effortSelect.options].map((option) => ({
            value: option.value,
            label: option.textContent,
          }))
          : [],
        effortSupported: effortSelect?.dataset?.reasoningSupported === 'true',
        effortLocked: effortSelect?.getAttribute?.('aria-disabled') === 'true',
        backendModel: String(state.status?.model || state.modelList?.active_model || '').trim(),
        loadedModel: String(state.status?.model || '').trim(),
      };
    }

    function glyph(enabled, label, svg) {
      if (!enabled) return '';
      const safeLabel = escapeHtml(label);
      return `<span class="composer-model-picker-glyph" role="img" title="${safeLabel}" aria-label="${safeLabel}">${svg}</span>`;
    }

    function nameHtml(family, tagText) {
      return '<span class="composer-model-picker-name">'
        + `<span class="composer-model-picker-family">${escapeHtml(family)}</span>`
        + `<span class="composer-model-picker-tag">${escapeHtml(tagText)}</span>`
        + '</span>';
    }

    function metaHtml(entry) {
      const source = entry || {};
      let size = '';
      if (Number(source.sizeBytes) > 0) {
        const sizeDetails = [source.parameterSize, source.quantizationLevel]
          .map((value) => String(value || ''))
          .filter(Boolean);
        const sizeTitle = sizeDetails.length
          ? ` title="${escapeHtml(sizeDetails.join(' · '))}"`
          : '';
        size = `<span class="composer-model-picker-size"${sizeTitle}>${escapeHtml(formatUtils.formatHumanSize(source.sizeBytes))}</span>`;
      }
      const loaded = source.loaded
        ? '<span class="composer-model-picker-loaded status-dot status-dot--ok" role="img" title="Loaded now" aria-label="Loaded now"></span>'
        : '';
      const check = source.selected
        ? '<span class="composer-model-picker-check" aria-hidden="true">&#10003;</span>'
        : '';
      return '<span class="composer-model-picker-meta">'
        + glyph(source.vision, 'Vision', EYE_GLYPH)
        + glyph(source.thinking, 'Thinking', BULB_GLYPH)
        + glyph(source.insert, 'Code completion', CODE_GLYPH)
        + size + loaded + check
        + '</span>';
    }

    function modelOptionHtml(entry, preferredModel, locked) {
      const selected = entry.id === preferredModel;
      const tagText = entry.tag
        ? `${entry.engineHint === 'huggingface' ? ' · ' : ':'}${entry.tag}`
        : '';
      const title = entry.retained
        ? `${entry.id} — not in the current catalog`
        : entry.available
          ? entry.id + (entry.org ? ` (${entry.org})` : '')
          : `${entry.id} — unavailable${entry.reason ? `: ${entry.reason}` : ''}`;
      return actionButton({
        plain: true,
        role: 'option',
        className: 'composer-model-picker-option'
          + (selected ? ' is-active' : '')
          + (!entry.available ? ' is-unavailable' : ''),
        ariaSelected: selected,
        disabled: locked || !entry.available,
        dataset: { 'picker-model': entry.id },
        title,
        trustedHtml: nameHtml(entry.family, tagText) + metaHtml({ ...entry, selected }),
      });
    }

    function thinkingHtml(inputs, defaultEffortHint) {
      if (!inputs.effortSupported || inputs.effortOptions.length <= 1) return '';
      const segments = inputs.effortOptions.map((option) => {
        const active = option.value === inputs.effort;
        const title = option.value === 'default'
          ? 'Model default' + (
            defaultEffortHint && defaultEffortHint !== 'default'
              ? ` (${utils.effortSegmentLabel(defaultEffortHint)})`
              : ''
          )
          : `Thinking: ${option.label}`;
        return actionButton({
          plain: true,
          role: 'radio',
          className: `composer-model-picker-segment${active ? ' is-active' : ''}`,
          disabled: inputs.effortLocked,
          dataset: { 'picker-effort': option.value },
          title,
          trustedHtml: escapeHtml(utils.effortSegmentLabel(option.value)),
        });
      }).join('');
      return '<div class="composer-model-picker-thinking">'
        + '<span class="composer-model-picker-thinking-label">Thinking</span>'
        + '<div class="composer-model-picker-segments" role="radiogroup" aria-label="Thinking effort">'
        + segments
        + '</div></div>';
    }

    function render() {
      if (!host || !modelSelect || !effortSelect
          || typeof actionButton !== 'function'
          || typeof textField !== 'function'
          || typeof utils.groupCatalogEntries !== 'function'
          || typeof utils.filterGroups !== 'function'
          || typeof formatUtils.canonicalOllamaTag !== 'function'
          || typeof formatUtils.formatHumanSize !== 'function') {
        return;
      }

      const inputs = readCarrierInputs();
      const models = Array.isArray(state.modelList?.data) ? state.modelList.data : [];
      const locked = modelSelect.getAttribute('aria-disabled') === 'true';
      const groups = utils.groupCatalogEntries(models, {
        loadedModel: inputs.loadedModel,
        canonicalize: formatUtils.canonicalOllamaTag,
      });
      const totalCount = groups.reduce((total, group) => total + group.entries.length, 0);
      const allEntries = groups.flatMap((group) => group.entries);
      // The carrier keeps a session's saved model even when the refreshed
      // catalog no longer lists it (buildModelOptionsArray appends it as
      // "(selected)"); the visible list must show that authoritative value.
      const retainedEntry = inputs.preferredModel
        && !allEntries.some((entry) => entry.id === inputs.preferredModel)
        ? {
          ...utils.normalizeCatalogEntry(inputs.preferredModel, {
            loadedModel: inputs.loadedModel,
            canonicalize: formatUtils.canonicalOllamaTag,
          }),
          retained: true,
        }
        : null;
      const defaultEffortHint = allEntries
        .find((entry) => entry.id === inputs.preferredModel)?.defaultReasoningEffort || '';
      const visibleGroups = utils.filterGroups(groups, query);
      const visibleEntries = visibleGroups.flatMap((group) => group.entries);
      const nextSignature = [
        inputs.preferredModel,
        inputs.backendModel,
        inputs.loadedModel,
        String(locked),
        String(inputs.effortLocked),
        String(inputs.effortSupported),
        inputs.effort,
        defaultEffortHint,
        inputs.effortOptions.map((option) => `${option.value}=${option.label}`).join('|'),
        query,
        String(totalCount),
        groups.map((group) => group.key).join('|'),
        retainedEntry ? `retained:${retainedEntry.loaded}` : '',
        ...visibleEntries.map((entry) => (
          `${entry.id}|${entry.group.key}|${entry.available}|${entry.reason}|${entry.loaded}|`
            + `${entry.sizeBytes}|${entry.parameterSize}|${entry.quantizationLevel}|`
            + `${entry.defaultReasoningEffort}|${entry.vision}${entry.thinking}${entry.insert}`
        )),
      ].join('\u0000');
      if (nextSignature === signature) return;

      const focusKey = focusedPickerKey();
      const backendLoaded = Boolean(inputs.loadedModel && inputs.backendModel)
        && formatUtils.canonicalOllamaTag(inputs.loadedModel)
          === formatUtils.canonicalOllamaTag(inputs.backendModel);
      const defaultTitle = inputs.backendModel
        ? `Use the backend default model (${inputs.backendModel})`
        : 'Use the backend default model';
      const defaultSelected = inputs.preferredModel === '';
      const defaultOption = actionButton({
        plain: true,
        role: 'option',
        className: `composer-model-picker-option${defaultSelected ? ' is-active' : ''}`,
        ariaSelected: defaultSelected,
        disabled: locked,
        dataset: { 'picker-model': '' },
        title: defaultTitle,
        trustedHtml: nameHtml('Default', inputs.backendModel ? ` · ${inputs.backendModel}` : '')
          + metaHtml({ loaded: backendLoaded, selected: defaultSelected }),
      });
      const search = totalCount > 8
        ? '<div class="composer-model-picker-search">'
          + textField({
            id: 'composerModelPickerSearch',
            value: query,
            placeholder: 'Search models',
            ariaLabel: 'Search models',
            className: 'composer-model-picker-search-field',
            dataset: { 'picker-search': '1' },
          })
          + '</div>'
        : '';
      const showGroups = groups.length > 1;
      const catalogOptions = visibleGroups.map((group) => (
        (showGroups
          ? `<div class="composer-model-picker-group" role="presentation">${escapeHtml(group.label)}</div>`
          : '')
        + group.entries.map((entry) => (
          modelOptionHtml(entry, inputs.preferredModel, locked)
        )).join('')
      )).join('');
      const empty = query && visibleEntries.length === 0
        ? '<div class="composer-model-picker-empty" role="note">No models match</div>'
        : '';
      const retainedOption = retainedEntry
        ? modelOptionHtml(retainedEntry, inputs.preferredModel, locked)
        : '';

      host.innerHTML = search
        + '<div class="composer-model-picker-list" role="listbox" aria-label="Model" id="composerModelPickerList">'
        + defaultOption + retainedOption + catalogOptions + empty
        + '</div>'
        + thinkingHtml(inputs, defaultEffortHint)
        + '<div class="inv-popover-footer">Applies to this chat. Defaults live in Settings.</div>';
      signature = nextSignature;

      const searchInput = host.querySelector('[data-picker-search]');
      if (searchInput) {
        searchInput.setAttribute('aria-controls', 'composerModelPickerList');
        searchInput.setAttribute('autocomplete', 'off');
      }
      host.querySelectorAll('.composer-model-picker-option.is-unavailable').forEach((button) => {
        button.setAttribute('aria-disabled', 'true');
      });
      host.querySelectorAll('[data-picker-effort]').forEach((button) => {
        button.setAttribute(
          'aria-checked',
          button.dataset.pickerEffort === inputs.effort ? 'true' : 'false'
        );
      });
      restorePickerFocus(focusKey);
    }

    // A rebuild replaces every node; remember which control had focus by
    // identity (not element) so a render mid-keyboard-navigation or during a
    // save round-trip does not drop focus to <body>.
    function focusedPickerKey() {
      const active = documentRef.activeElement;
      if (!active || !host.contains(active) || typeof active.matches !== 'function') return null;
      if (active.matches('[data-picker-search]')) return { type: 'search' };
      if (active.matches('[data-picker-model]')) return { type: 'model', id: active.dataset.pickerModel };
      if (active.matches('[data-picker-effort]')) return { type: 'effort', value: active.dataset.pickerEffort };
      return null;
    }

    function restorePickerFocus(focusKey) {
      if (!focusKey) return;
      if (focusKey.type === 'search') {
        const searchInput = host.querySelector('[data-picker-search]');
        if (searchInput) {
          searchInput.focus();
          const caret = searchInput.value.length;
          searchInput.setSelectionRange?.(caret, caret);
        }
        return;
      }
      const selector = focusKey.type === 'model' ? '[data-picker-model]' : '[data-picker-effort]';
      const wanted = focusKey.type === 'model' ? focusKey.id : focusKey.value;
      const target = [...host.querySelectorAll(selector)].find((button) => (
        (focusKey.type === 'model' ? button.dataset.pickerModel : button.dataset.pickerEffort) === wanted
      ));
      target?.focus?.();
    }

    function syncPill() {
      const pill = documentRef?.getElementById?.('composerModelPill');
      if (!pill || !modelSelect || !effortSelect
          || typeof utils.formatComposerModelPillLabel !== 'function'
          || typeof utils.buildPillTitle !== 'function'
          || typeof formatUtils.canonicalOllamaTag !== 'function') {
        return;
      }
      const inputs = readCarrierInputs();
      const label = utils.formatComposerModelPillLabel(inputs);
      const labelEl = pill.querySelector('.inv-chip-label');
      if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
      const title = utils.buildPillTitle(inputs);
      const ariaLabel = `Model and reasoning effort. ${title}`;
      if (pill.getAttribute('title') !== title) pill.setAttribute('title', title);
      if (pill.getAttribute('aria-label') !== ariaLabel) pill.setAttribute('aria-label', ariaLabel);

      const resolvedModel = inputs.preferredModel || inputs.backendModel;
      const isLoaded = Boolean(resolvedModel && inputs.loadedModel)
        && formatUtils.canonicalOllamaTag(resolvedModel)
          === formatUtils.canonicalOllamaTag(inputs.loadedModel);
      let dot = pill.querySelector('.composer-model-pill-dot');
      if (isLoaded) {
        if (!dot) {
          dot = documentRef.createElement('span');
          dot.className = 'composer-model-pill-dot status-dot status-dot--ok';
          dot.setAttribute('aria-hidden', 'true');
        }
        if (pill.firstChild !== dot) pill.insertBefore(dot, pill.firstChild);
      } else if (dot) {
        dot.remove();
      }
    }

    function renderIfOpen() {
      syncPill();
      if (popoverEl && typeof popover?.isOpen === 'function' && popover.isOpen(popoverEl)) {
        render();
      }
    }

    function hasSelectOption(select, value) {
      return [...select.options].some((option) => option.value === value);
    }

    function dispatchChange(select) {
      const EventCtor = select.ownerDocument?.defaultView?.Event;
      if (typeof EventCtor === 'function') {
        select.dispatchEvent(new EventCtor('change', { bubbles: true }));
      }
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const modelButton = target.closest('[data-picker-model]');
      if (modelButton) {
        if (modelButton.disabled || modelSelect.getAttribute('aria-disabled') === 'true') return;
        const id = modelButton.dataset.pickerModel;
        const preferredModel = String(modelSelect.value || '').trim();
        if (id === preferredModel) {
          popover.close(popoverEl, { restoreFocus: true });
          return;
        }
        if (!hasSelectOption(modelSelect, id)) return;
        modelSelect.value = id;
        dispatchChange(modelSelect);
        popover.close(popoverEl, { restoreFocus: true });
        return;
      }

      const effortButton = target.closest('[data-picker-effort]');
      if (!effortButton || effortButton.disabled
          || effortSelect.getAttribute('aria-disabled') === 'true') return;
      const value = effortButton.dataset.pickerEffort;
      if (effortSelect.value !== value && hasSelectOption(effortSelect, value)) {
        effortSelect.value = value;
        dispatchChange(effortSelect);
      }
      // Patch the segments in place: rebuilding host.innerHTML here would
      // detach the clicked button while its click is still bubbling, and the
      // inventory click-away handler would then read it as an outside click.
      host.querySelectorAll('[data-picker-effort]').forEach((button) => {
        const active = button.dataset.pickerEffort === effortSelect.value;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    }

    function handleInput(event) {
      if (!event.target?.matches?.('[data-picker-search]')) return;
      query = event.target.value;
      render();
    }

    function handleKeydown(event) {
      if (event.key === 'Escape') return;
      const searchInput = event.target?.matches?.('[data-picker-search]');
      const modelButton = event.target?.closest?.('[data-picker-model]');
      const effortButton = event.target?.closest?.('[data-picker-effort]');
      const modelOptions = [...host.querySelectorAll('[data-picker-model]:not([disabled])')];

      if (searchInput && event.key === 'ArrowDown') {
        modelOptions[0]?.focus?.();
        event.preventDefault();
        return;
      }
      if (searchInput && event.key === 'Enter') {
        const firstModel = modelOptions.find((button) => button.dataset.pickerModel !== '')
          || modelOptions[0];
        firstModel?.click?.();
        event.preventDefault();
        return;
      }
      if (modelButton) {
        if (event.key === 'Enter' || event.key === ' ') {
          modelButton.click();
          event.preventDefault();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
            || !modelOptions.length) return;
        const currentIndex = modelOptions.indexOf(modelButton);
        if (currentIndex < 0) return;
        let nextIndex;
        if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % modelOptions.length;
        else if (event.key === 'ArrowUp') {
          nextIndex = (currentIndex - 1 + modelOptions.length) % modelOptions.length;
        } else if (event.key === 'Home') nextIndex = 0;
        else nextIndex = modelOptions.length - 1;
        modelOptions[nextIndex].focus();
        event.preventDefault();
        return;
      }
      if (effortButton && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const segments = [...host.querySelectorAll('[data-picker-effort]:not([disabled])')];
        const currentIndex = segments.indexOf(effortButton);
        if (currentIndex < 0 || !segments.length) return;
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        segments[(currentIndex + offset + segments.length) % segments.length].click();
        event.preventDefault();
      }
    }

    function handlePopoverToggle(event) {
      if (event.detail?.id !== 'composer-model') return;
      if (event.detail.open === true) {
        render();
        const searchInput = host.querySelector('[data-picker-search]');
        const activeOption = host.querySelector('.composer-model-picker-option.is-active');
        const firstOption = host.querySelector('[data-picker-model]:not([disabled])');
        (searchInput || activeOption || firstOption)?.focus?.();
        return;
      }
      if (event.detail.open === false) {
        query = '';
        render();
      }
    }

    function bind() {
      if (bound || !documentRef) return;
      popoverEl = documentRef.getElementById('composerModelPopover');
      if (!popoverEl) return;
      host = popoverEl.querySelector('[data-composer-model-picker]');
      if (!host) {
        host = documentRef.createElement('div');
        host.className = 'composer-model-picker';
        host.setAttribute('data-composer-model-picker', '');
        popoverEl.insertBefore(host, popoverEl.firstChild);
      }
      modelSelect = documentRef.getElementById('composerModelSelect');
      effortSelect = documentRef.getElementById('composerEffortSelect');
      host.addEventListener('click', handleClick);
      host.addEventListener('keydown', handleKeydown);
      host.addEventListener('input', handleInput);
      popoverEl.addEventListener('inv-popover-toggle', handlePopoverToggle);
      bound = true;
    }

    function dispose() {
      if (bound) {
        host.removeEventListener('click', handleClick);
        host.removeEventListener('keydown', handleKeydown);
        host.removeEventListener('input', handleInput);
        popoverEl.removeEventListener('inv-popover-toggle', handlePopoverToggle);
      }
      bound = false;
      if (root.rendererComposerModelPicker?.instance === instance) {
        root.rendererComposerModelPicker.instance = null;
      }
      if (moduleApi.instance === instance) moduleApi.instance = null;
    }

    const instance = { bind, render, renderIfOpen, syncPill, dispose };
    moduleApi.instance = instance;
    if (!root.rendererComposerModelPicker) root.rendererComposerModelPicker = moduleApi;
    root.rendererComposerModelPicker.instance = instance;
    return instance;
  }

  const moduleApi = { createComposerModelPicker };
  return moduleApi;
});
