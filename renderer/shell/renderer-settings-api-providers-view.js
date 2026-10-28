/* renderer/shell/renderer-settings-api-providers-view.js
 *
 * Markup for the Settings > Models API-key provider rows (row 78, variant A):
 * one row per provider inside the Cloud models group, the editor in place under
 * its row, and the "Add a provider" row. Pure render functions over the main
 * process's state plus the controller's UI state; no key material ever reaches
 * this module (the state carries a hasKey boolean only).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsApiProvidersView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  function fill(template, params) {
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
  }
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t)
    || globalThis.jennyI18nFallback
    || function (_key, fallback, params) { return fill(fallback, params); };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn)
    || function (_key, count, params, one, other) { return fill(count === 1 ? one : other, { count, ...params }); };

  const CUSTOM_PRESET_ID = 'custom';
  // A sample URL, not copy: the same in every locale.
  const ENDPOINT_EXAMPLE = 'https://llm.example.com/v1';
  const TRANSPORT_AUTH = Object.freeze({
    openai_chat_completions_v1: ['api_key_bearer', 'api_key_header', 'none'],
    openai_responses_v1: ['api_key_bearer'],
    anthropic_messages_v1: ['api_key_header'],
  });

  function transportLabel(transport) {
    return ({
      openai_chat_completions_v1: jt('settings.apiProviders.formatChatCompletions', 'OpenAI Chat Completions'),
      openai_responses_v1: jt('settings.apiProviders.formatResponses', 'OpenAI Responses'),
      anthropic_messages_v1: jt('settings.apiProviders.formatAnthropic', 'Anthropic Messages'),
    })[transport] || transport;
  }

  function authLabel(profile) {
    return ({
      api_key_bearer: jt('settings.apiProviders.authBearer', 'Bearer token'),
      api_key_header: jt('settings.apiProviders.authHeader', 'x-api-key header'),
      none: jt('settings.apiProviders.authNone', 'No key'),
    })[profile] || profile;
  }

  function hostOf(endpoint) {
    try {
      return new URL(String(endpoint || '')).host;
    } catch (_error) {
      return '';
    }
  }

  function formatTokens(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1000000) return `${Math.round(n / 100000) / 10}M`.replace('.0M', 'M');
    if (n >= 1000) return `${Math.round(n / 1000)}K`;
    return String(Math.round(n));
  }

  function formatUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '';
    return `$${n >= 1 ? n.toFixed(2) : n.toFixed(n >= 0.1 ? 2 : 3)}`;
  }

  function sourceText(source) {
    return ({
      pin: jt('settings.apiProviders.sourcePin', 'Pinned by you'),
      preset: jt('settings.apiProviders.sourcePreset', "From Jenny's preset"),
      provider: jt('settings.apiProviders.sourceProvider', "From the provider's model list"),
      catalog: jt('settings.apiProviders.sourceCatalog', 'From the bundled models.dev catalog'),
      fallback: jt('settings.apiProviders.sourceFallback', 'Not reported: Jenny assumes 32K context and 4K output. Set your own with Limits…'),
    })[source] || '';
  }

  // Failures the main process reports by code; never provider text.
  function errorText(code, label, status) {
    const name = label || jt('settings.apiProviders.theProvider', 'The provider');
    return ({
      unauthorized: jt('settings.apiProviders.errorUnauthorized', '{provider} refused the key ({status}). Check it and replace it.', { provider: name, status: status || 401 }),
      rate_limited: jt('settings.apiProviders.errorRateLimited', '{provider} is rate limiting requests. Try again in a minute.', { provider: name }),
      provider_unavailable: jt('settings.apiProviders.errorUnavailable', '{provider} is not answering right now. Try again later.', { provider: name }),
      http_error: jt('settings.apiProviders.errorHttp', '{provider} refused the request ({status}).', { provider: name, status: status || '?' }),
      timeout: jt('settings.apiProviders.errorTimeout', '{provider} did not answer in time.', { provider: name }),
      network_error: jt('settings.apiProviders.errorNetwork', 'Jenny could not reach {provider}. Check the address and your connection.', { provider: name }),
      redirect_refused: jt('settings.apiProviders.errorRedirect', '{provider} tried to redirect the request elsewhere, so Jenny stopped.', { provider: name }),
      invalid_endpoint: jt('settings.apiProviders.errorEndpoint', 'Use an https address, or http only for a server on this computer or your local network.'),
      key_missing: jt('settings.apiProviders.errorKeyMissing', 'Save a key first.'),
      invalid_key: jt('settings.apiProviders.errorInvalidKey', 'That does not look like an API key: paste it without spaces or line breaks.'),
      invalid_label: jt('settings.apiProviders.errorLabel', 'Give it a name of up to 64 characters.'),
      invalid_model: jt('settings.apiProviders.errorModel', 'That model ID is not valid.'),
      limit_reached: jt('settings.apiProviders.errorLimit', 'That is the most this list can hold. Turn something off first.'),
      too_large: jt('settings.apiProviders.errorTooLarge', "{provider}'s model list is too large to read.", { provider: name }),
      invalid_response: jt('settings.apiProviders.errorResponse', "{provider}'s answer was not a model list.", { provider: name }),
      storage_unavailable: jt('settings.apiProviders.errorStorage', "This device's secure store is not available, so Jenny cannot keep a key."),
    })[code] || jt('settings.apiProviders.errorGeneric', 'Jenny could not complete that request. Try again.');
  }

  function createView({ inventory, textField, selectField }) {
    function button(id, label, variant, extra) {
      return inventory.actionButton({ id, label, variant: variant || 'secondary', size: 'sm', ...(extra || {}) });
    }

    function badge(tone, label) {
      return inventory.badge({ tone, size: 'sm', text: label });
    }

    function row(options) {
      return inventory.settingsField({ variant: 'row', ...options });
    }

    function enabledCount(instance) {
      return instance.models.filter((model) => model.enabled).length;
    }

    function keyBadge(instance) {
      if (instance.authProfile === 'none') return badge('muted', jt('settings.apiProviders.noKeyNeeded', 'No key needed'));
      return instance.hasKey
        ? badge('success', jt('settings.apiProviders.keySaved', 'Key saved'))
        : badge('warning', jt('settings.apiProviders.noKey', 'No key'));
    }

    function usable(instance) {
      return instance.authProfile === 'none' || instance.hasKey;
    }

    function providerRow(instance, ui, localOnly) {
      const open = ui.editing === instance.id;
      const count = enabledCount(instance);
      let help = usable(instance)
        ? jtn('settings.apiProviders.modelsInComposer', count, {}, '{count} model in Composer', '{count} models in Composer')
        : jt('settings.apiProviders.addKeyToUse', 'Add a key to use it.');
      if (localOnly && usable(instance)) {
        help = jt('settings.apiProviders.localOnly', 'Force local inference is on, so this provider will not run. Turn it off in Offline.');
      }
      const label = open
        ? jt('settings.apiProviders.done', 'Done')
        : (usable(instance) ? jt('settings.apiProviders.edit', 'Edit') : jt('settings.apiProviders.addKey', 'Add key'));
      return row({
        id: `apiProvider-${instance.id}`,
        label: instance.label,
        help: `${help} · ${hostOf(instance.endpoint)}`,
        controlHtml: keyBadge(instance)
          + button('apiProvidersToggleEditor', label, open ? 'secondary' : 'ghost', { dataset: { instance: instance.id } }),
        dataset: { 'api-provider': instance.id },
      }) + (open ? `<div class="api-providers-editor" data-api-provider-editor="${escapeHtml(instance.id)}">${editor(instance, ui)}</div>` : '');
    }

    function keyRow(instance, ui) {
      if (instance.authProfile === 'none') {
        return row({ id: 'apiProvidersKey', label: jt('settings.apiProviders.apiKey', 'API key'),
          help: jt('settings.apiProviders.noKeyHelp', 'This endpoint is set to send no key.'), controlHtml: '' });
      }
      const editing = !instance.hasKey || ui.replacingKey === instance.id;
      const control = editing
        ? textField({ id: 'apiProvidersKeyInput', type: 'password', ariaLabel: jt('settings.apiProviders.apiKey', 'API key'),
          placeholder: jt('settings.apiProviders.pasteKey', 'Paste API key'), maxLength: 4096, spellcheck: false,
          className: 'api-providers-field', dataset: { 'api-provider-key': instance.id } })
          + button('apiProvidersSaveKey', jt('settings.apiProviders.saveKey', 'Save key'), 'primary', { dataset: { instance: instance.id } })
          + (instance.hasKey ? button('apiProvidersCancelReplace', jt('settings.apiProviders.cancel', 'Cancel'), 'ghost', { dataset: { instance: instance.id } }) : '')
        : `<span class="api-providers-key-state">${badge('success', jt('settings.apiProviders.saved', 'Saved'))}`
          + button('apiProvidersReplaceKey', jt('settings.apiProviders.replaceKey', 'Replace…'), 'ghost', { dataset: { instance: instance.id } })
          + button('apiProvidersClearKey', jt('settings.apiProviders.removeKey', 'Remove key'), 'ghost', { dataset: { instance: instance.id } })
          + '</span>';
      return row({
        id: 'apiProvidersKey',
        label: jt('settings.apiProviders.apiKey', 'API key'),
        help: instance.hasKey
          ? jt('settings.apiProviders.keyHelpSaved', "Stored in this device's secure store. Replacing it never shows the old one.")
          : jt('settings.apiProviders.keyHelpNew', "Stored in this device's secure store and sent only to {host}. Jenny never shows it again.", { host: hostOf(instance.endpoint) }),
        controlHtml: control,
      });
    }

    function modelMeta(model) {
      const limits = model.limits || {};
      const sources = limits.sources || {};
      const context = formatTokens(limits.context_length);
      const caps = [
        limits.tools ? jt('settings.apiProviders.tools', 'tools') : jt('settings.apiProviders.noTools', 'no tools'),
        limits.vision ? jt('settings.apiProviders.vision', 'vision') : '',
        limits.reasoning ? jt('settings.apiProviders.reasoning', 'reasoning') : '',
      ].filter(Boolean).join(' · ');
      const cost = model.costPerMtokUsd && formatUsd(model.costPerMtokUsd.input) && formatUsd(model.costPerMtokUsd.output)
        ? ' · ' + escapeHtml(jt('settings.apiProviders.costPerMillion', '{input} in / {output} out per 1M tokens',
          { input: formatUsd(model.costPerMtokUsd.input), output: formatUsd(model.costPerMtokUsd.output) }))
        : '';
      return `<span class="api-providers-model-meta"><span class="api-providers-source" data-source="${escapeHtml(sources.context_length || '')}"`
        + ` title="${escapeHtml(sourceText(sources.context_length))}">${escapeHtml(jt('settings.apiProviders.contextShort', '{tokens} context', { tokens: context }))}</span>`
        + ` · ${escapeHtml(caps)}${cost} · `
        + inventory.actionButton({ id: 'apiProvidersLimits', label: jt('settings.apiProviders.limits', 'Limits…'), plain: true,
          className: 'cloud-models-link', dataset: { model: model.id } })
        + '</span>';
    }

    function pinRow(model) {
      const pin = model.pin || {};
      const limits = model.limits || {};
      return '<div class="api-providers-pin" role="group">'
        + textField({ id: 'apiProvidersPinContext', type: 'number', min: 1024, step: 1024, className: 'api-providers-number',
          label: jt('settings.apiProviders.pinContext', 'Context'), value: String(pin.contextLength || limits.context_length || '') })
        + textField({ id: 'apiProvidersPinOutput', type: 'number', min: 256, step: 256, className: 'api-providers-number',
          label: jt('settings.apiProviders.pinOutput', 'Max output'), value: String(pin.maxOutputTokens || limits.max_output_tokens || '') })
        + button('apiProvidersSavePin', jt('settings.apiProviders.savePin', 'Pin'), 'secondary', { dataset: { model: model.id } })
        + button('apiProvidersClearPin', jt('settings.apiProviders.clearPin', 'Use provider values'), 'ghost', { dataset: { model: model.id } })
        + '</div>';
    }

    function modelRow(model, ui) {
      return `<div class="api-providers-model" data-api-model="${escapeHtml(model.id)}">`
        + inventory.checkbox({ id: '', checked: model.enabled === true, className: 'api-providers-model-check',
          ariaLabel: jt('settings.apiProviders.showInComposer', 'Show {model} in Composer', { model: model.id }),
          dataset: { 'api-model-toggle': model.id } })
        + `<span class="api-providers-model-id" title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</span>`
        + modelMeta(model)
        + (ui.pinOpen === model.id ? pinRow(model) : '')
        + '</div>';
    }

    function sortedModels(instance) {
      return [...instance.models].sort((left, right) => (
        Number(right.enabled === true) - Number(left.enabled === true) || left.id.localeCompare(right.id)
      ));
    }

    function loadedText(instance) {
      const at = Date.parse(instance.discovery.fetchedAt || '');
      if (!Number.isFinite(at)) return '';
      let when;
      try {
        when = new Intl.DateTimeFormat(globalThis.jennyI18n?.locale || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
      } catch (_error) {
        when = new Date(at).toISOString();
      }
      return ' · ' + jt('settings.apiProviders.loadedAt', 'loaded {when}', { when });
    }

    function modelList(instance, ui) {
      const models = sortedModels(instance);
      const loaded = Boolean(instance.discovery.fetchedAt);
      const busy = ui.busy === `discover:${instance.id}`;
      const head = '<div class="api-providers-models-head">'
        + (models.length > 6
          ? textField({ id: 'apiProvidersSearch', type: 'search', className: 'api-providers-field',
            ariaLabel: jt('settings.apiProviders.searchModels', 'Search models'),
            placeholder: jt('settings.apiProviders.searchCount', 'Search {count} models', { count: models.length }),
            value: ui.query || '', dataset: { 'api-provider-search': instance.id } })
          : '<span class="api-providers-grow"></span>')
        + button('apiProvidersDiscover', busy ? jt('settings.apiProviders.loading', 'Loading…')
          : (loaded ? jt('settings.apiProviders.reload', 'Reload') : jt('settings.apiProviders.loadModels', 'Load models')),
        loaded ? 'secondary' : 'primary', { disabled: busy || !usable(instance), dataset: { instance: instance.id } })
        + '</div>';
      const body = models.length
        ? `<div class="api-providers-models-list" role="group" aria-label="${escapeHtml(jt('settings.apiProviders.modelsLabel', 'Models'))}">`
          + models.map((model) => modelRow(model, ui)).join('') + '</div>'
        : `<p class="api-providers-empty">${escapeHtml(jt('settings.apiProviders.emptyList', 'Save the key, then Load models.'))}</p>`;
      const count = enabledCount(instance);
      const foot = '<div class="api-providers-models-foot"><span class="api-providers-grow">'
        + escapeHtml(jt('settings.apiProviders.enabledOfTotal', '{enabled} of {total} in Composer', { enabled: count, total: models.length }) + loadedText(instance))
        + '</span>'
        + textField({ id: 'apiProvidersAddModelInput', className: 'api-providers-field api-providers-field--short', maxLength: 200,
          ariaLabel: jt('settings.apiProviders.addModelId', 'Add model ID'), placeholder: jt('settings.apiProviders.addModelId', 'Add model ID'),
          spellcheck: false, dataset: { 'api-provider-add-model': instance.id } })
        + button('apiProvidersAddModel', jt('settings.apiProviders.add', 'Add'), 'ghost', { dataset: { instance: instance.id } })
        + '</div>';
      const error = instance.discovery.error
        ? `<p class="settings-field-error" role="alert">${escapeHtml(errorText(instance.discovery.error.code, instance.label, instance.discovery.error.status))}`
          + (models.length ? ' ' + escapeHtml(jt('settings.apiProviders.keptList', 'The list below is from the last successful load.')) : '') + '</p>'
        : '';
      return `<div class="api-providers-models">${head}${body}${foot}</div>${error}`;
    }

    function removeRow(instance, ui) {
      const confirming = ui.confirmRemove === instance.id;
      return row({
        id: 'apiProvidersRemove',
        label: confirming
          ? jt('settings.apiProviders.removeConfirmLabel', 'Remove {provider}?', { provider: instance.label })
          : jt('settings.apiProviders.removeLabel', 'Remove this provider'),
        help: jt('settings.apiProviders.removeHelp', 'Deletes its key and its model list from this device.'),
        controlHtml: confirming
          ? button('apiProvidersRemoveConfirm', jt('settings.apiProviders.remove', 'Remove'), 'danger', { dataset: { instance: instance.id } })
            + button('apiProvidersRemoveCancel', jt('settings.apiProviders.cancel', 'Cancel'), 'ghost')
          : button('apiProvidersRemoveAsk', jt('settings.apiProviders.removeAsk', 'Remove…'), 'danger', { dataset: { instance: instance.id } }),
      });
    }

    function editor(instance, ui) {
      const custom = !instance.presetId;
      const error = ui.errors[instance.id]
        ? `<p class="settings-field-error" role="alert">${escapeHtml(ui.errors[instance.id])}</p>` : '';
      return row({ id: 'apiProvidersName', label: jt('settings.apiProviders.name', 'Name'),
        help: jt('settings.apiProviders.nameHelp', 'Shown as the group name in Composer.'),
        controlHtml: textField({ id: 'apiProvidersNameInput', value: instance.label, maxLength: 64, className: 'api-providers-field',
          ariaLabel: jt('settings.apiProviders.name', 'Name'), dataset: { 'api-provider-name': instance.id } }) })
        + row({ id: 'apiProvidersEndpoint', label: jt('settings.apiProviders.endpoint', 'Endpoint'),
          help: custom
            ? `${transportLabel(instance.transport)} · ${authLabel(instance.authProfile)}`
            : jt('settings.apiProviders.endpointPreset', 'Set by the preset.'),
          controlHtml: `<span class="api-providers-host">${escapeHtml(instance.endpoint)}</span>` })
        + keyRow(instance, ui) + error + modelList(instance, ui) + removeRow(instance, ui);
    }

    function customForm(ui) {
      const draft = ui.customDraft;
      const auths = TRANSPORT_AUTH[draft.transport] || TRANSPORT_AUTH.openai_chat_completions_v1;
      const busy = ui.busy === 'add';
      return '<div class="api-providers-editor" data-api-provider-custom>'
        + row({ id: 'apiProvidersCustomName', label: jt('settings.apiProviders.name', 'Name'),
          help: jt('settings.apiProviders.nameHelp', 'Shown as the group name in Composer.'),
          controlHtml: textField({ id: 'apiProvidersCustomNameInput', value: draft.label, maxLength: 64, className: 'api-providers-field',
            ariaLabel: jt('settings.apiProviders.name', 'Name'), dataset: { 'api-custom': 'label' } }) })
        + row({ id: 'apiProvidersCustomEndpoint', label: jt('settings.apiProviders.endpoint', 'Endpoint'),
          help: jt('settings.apiProviders.endpointHelp', 'https only, except a server on this computer or your local network.'),
          controlHtml: textField({ id: 'apiProvidersCustomEndpointInput', value: draft.endpoint, maxLength: 2048, spellcheck: false,
            placeholder: ENDPOINT_EXAMPLE, className: 'api-providers-field',
            ariaLabel: jt('settings.apiProviders.endpointUrl', 'Endpoint URL'), dataset: { 'api-custom': 'endpoint' } }) })
        + row({ id: 'apiProvidersCustomFormat', label: jt('settings.apiProviders.format', 'API format'),
          help: jt('settings.apiProviders.formatHelp', 'Most servers use Chat Completions.'),
          controlHtml: selectField({ id: 'apiProvidersCustomFormatSelect', ariaLabel: jt('settings.apiProviders.format', 'API format'),
            value: draft.transport, dataset: { 'api-custom': 'transport' },
            options: Object.keys(TRANSPORT_AUTH).map((value) => ({ value, label: transportLabel(value) })) }) })
        + row({ id: 'apiProvidersCustomAuth', label: jt('settings.apiProviders.signIn', 'Sign-in'),
          help: jt('settings.apiProviders.signInHelp', 'How the key is sent.'),
          controlHtml: selectField({ id: 'apiProvidersCustomAuthSelect', ariaLabel: jt('settings.apiProviders.signIn', 'Sign-in'),
            value: auths.includes(draft.authProfile) ? draft.authProfile : auths[0], disabled: auths.length === 1,
            dataset: { 'api-custom': 'authProfile' }, options: auths.map((value) => ({ value, label: authLabel(value) })) }) })
        + (ui.errors.add ? `<p class="settings-field-error" role="alert">${escapeHtml(ui.errors.add)}</p>` : '')
        + row({ id: 'apiProvidersCustomActions', label: '', help: '',
          controlHtml: button('apiProvidersCustomSubmit', busy ? jt('settings.apiProviders.adding', 'Adding…') : jt('settings.apiProviders.addEndpoint', 'Add endpoint'), 'primary', { disabled: busy })
            + button('apiProvidersCustomCancel', jt('settings.apiProviders.cancel', 'Cancel'), 'ghost') })
        + '</div>';
    }

    function addRow(state, ui) {
      if (state.instances.length >= state.maxInstances) return '';
      const options = state.presets.map((preset) => ({ value: preset.id, label: preset.label }))
        .concat([{ value: CUSTOM_PRESET_ID, label: jt('settings.apiProviders.customEndpoint', 'Custom endpoint') }]);
      const busy = ui.busy === 'add';
      return row({
        id: 'apiProvidersAdd',
        label: jt('settings.apiProviders.addLabel', 'Add a provider'),
        help: jt('settings.apiProviders.addHelp', 'Use your own API key with a hosted model service, or point Jenny at any compatible endpoint.'),
        error: ui.customDraft ? '' : (ui.errors.add || ''),
        controlHtml: selectField({ id: 'apiProvidersPresetSelect', ariaLabel: jt('settings.apiProviders.provider', 'Provider'),
          value: ui.addPreset, options, dataset: { 'api-provider-preset': '' } })
          + button('apiProvidersAdd', busy && !ui.customDraft ? jt('settings.apiProviders.adding', 'Adding…') : jt('settings.apiProviders.add', 'Add'), 'secondary', { disabled: busy }),
      }) + (ui.customDraft ? customForm(ui) : '');
    }

    function render(state, ui) {
      if (!state.enabled) return '';
      return state.instances.map((instance) => providerRow(instance, ui, state.localOnly)).join('') + addRow(state, ui);
    }

    return { render };
  }

  return { createView, errorText, formatTokens, formatUsd, hostOf, CUSTOM_PRESET_ID, TRANSPORT_AUTH };
});
