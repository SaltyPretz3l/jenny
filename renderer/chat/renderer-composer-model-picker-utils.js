(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerModelPickerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function splitModelId(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return { id: '', family: '', tag: '', tagHead: '', org: '', engineHint: '' };
    }

    var id = value.trim();
    var remainder = id;
    var org = '';
    var engineHint = '';
    if (/^codex-cli\//i.test(remainder)) {
      engineHint = 'codex-cli';
      remainder = remainder.replace(/^codex-cli\//i, '');
    } else if (/^(?:hf\.co|huggingface\.co)\//i.test(remainder)) {
      engineHint = 'huggingface';
      remainder = remainder.replace(/^(?:hf\.co|huggingface\.co)\//i, '');
      var slashIndex = remainder.indexOf('/');
      org = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
      remainder = slashIndex === -1 ? '' : remainder.slice(slashIndex + 1);
    }

    var colonIndex = remainder.indexOf(':');
    var family = colonIndex === -1 ? remainder : remainder.slice(0, colonIndex);
    var tag = colonIndex === -1 ? '' : remainder.slice(colonIndex + 1);
    var tagHead = tag
      .split('-')
      .slice(0, 2)
      .join('-')
      .slice(0, 12)
      .replace(/-+$/, '');
    return { id: id, family: family, tag: tag, tagHead: tagHead, org: org, engineHint: engineHint };
  }

  function resolveModelGroup(input) {
    var source = input || {};
    var id = typeof source.id === 'string' ? source.id.trim() : '';
    var engineType = String(source.engineType || '').trim().toLowerCase();
    if (/^codex-cli\//i.test(id) || engineType === 'codex-cli') {
      return { key: 'codex-cli', label: jt('composer.modelPicker.codexCliGroup', 'Codex CLI'), order: 50 };
    }
    if (engineType === 'chatgpt') {
      return { key: 'chatgpt', label: 'ChatGPT', order: 40 };
    }
    // Row 78: each API-key provider is its own group, named by the user's label.
    if (engineType === 'api-provider') {
      var instanceId = String(source.apiProviderInstanceId || '').trim();
      var providerLabel = String(source.provider || '').trim();
      return { key: 'api-provider:' + instanceId, label: providerLabel || instanceId, order: 60 };
    }
    if (/^(?:hf\.co|huggingface\.co)\//i.test(id)) {
      return { key: 'huggingface', label: jt('composer.modelPicker.huggingFaceGroup', 'Hugging Face'), order: 30 };
    }
    if (engineType === 'ollama') {
      return { key: 'ollama', label: 'Ollama', order: 10 };
    }
    if (engineType === 'vllm') {
      return { key: 'vllm', label: 'vLLM', order: 20 };
    }
    // A managed server's model is not a user-run endpoint: name the runtime.
    if (engineType === 'openai-compatible' && source.managed === 'ninfer') {
      return { key: 'ninfer', label: 'NInfer', order: 22 };
    }
    if (engineType === 'openai-compatible' && source.managed === 'llama-server') {
      return { key: 'llama-server', label: 'llama-server', order: 23 };
    }
    if (engineType === 'openai-compatible') {
      return { key: 'openai-compatible', label: jt('composer.modelPicker.openAiCompatibleGroup', 'OpenAI-compatible'), order: 25 };
    }
    // Name heuristic only when the catalog did not say which engine serves
    // the model: gpt-oss:20b on Ollama must stay in the Ollama group.
    if (/^gpt-/i.test(id)) {
      return { key: 'chatgpt', label: 'ChatGPT', order: 40 };
    }
    return { key: 'other', label: jt('composer.modelPicker.otherGroup', 'Other'), order: 90 };
  }

  function defaultCanonicalize(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeCatalogEntry(raw, options) {
    var config = options || {};
    var source = typeof raw === 'string'
      ? { id: raw }
      : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
    var id = typeof source.id === 'string' ? source.id.trim() : '';
    if (!id) {
      return null;
    }

    var engineType = String(source.engine_type || source.engineType || '').trim().toLowerCase();
    var capabilities = source.capabilities && typeof source.capabilities === 'object'
      ? source.capabilities
      : {};
    var loadedModel = String(config.loadedModel || '').trim();
    var canonicalize = config.canonicalize || defaultCanonicalize;
    // A provider row shows the provider's own model id, not the namespaced one.
    var split = engineType === 'api-provider'
      ? { family: String(source.apiProviderModelId || source.label || id), tag: '', tagHead: '', org: '', engineHint: '' }
      : splitModelId(id);
    return {
      id: id,
      engineType: engineType,
      available: source.available !== false,
      reason: String(source.reason || '').trim(),
      sizeBytes: Number.isFinite(source.size) && source.size > 0 ? source.size : 0,
      parameterSize: String(source.parameter_size || ''),
      quantizationLevel: String(source.quantization_level || ''),
      vision: capabilities.vision === true,
      thinking: capabilities.thinking === true || capabilities.reasoning_effort === true,
      insert: capabilities.insert === true,
      defaultReasoningEffort: String(capabilities.default_reasoning_effort || '').trim().toLowerCase(),
      loaded: Boolean(loadedModel) && canonicalize(id) === canonicalize(loadedModel),
      family: split.family,
      tag: split.tag,
      tagHead: split.tagHead,
      org: split.org,
      engineHint: split.engineHint,
      group: resolveModelGroup({
        id: id,
        engineType: engineType,
        managed: source.managed,
        apiProviderInstanceId: source.apiProviderInstanceId,
        provider: source.provider,
      }),
      hint: apiProviderHint(engineType, source),
    };
  }

  // One line under an API-key provider row that cannot run as listed.
  function apiProviderHint(engineType, source) {
    if (engineType !== 'api-provider') return '';
    if (source.hasKey === false) {
      return jt('composer.modelPicker.apiProviderNoKey', 'Add a key in Settings › Models');
    }
    return source.limitsUnknown === true
      ? jt('composer.modelPicker.apiProviderLimitsUnknown', 'Limits unknown: set them in Settings')
      : '';
  }

  function groupCatalogEntries(models, options) {
    var buckets = new Map();
    var catalog = Array.isArray(models) ? models : [];
    catalog.forEach(function (raw) {
      var entry = normalizeCatalogEntry(raw, options);
      if (!entry) {
        return;
      }
      var bucket = buckets.get(entry.group.key);
      if (!bucket) {
        bucket = {
          key: entry.group.key,
          label: entry.group.label,
          order: entry.group.order,
          entries: [],
          firstSeen: buckets.size,
        };
        buckets.set(entry.group.key, bucket);
      }
      bucket.entries.push(entry);
    });

    return Array.from(buckets.values())
      .sort(function (left, right) {
        return left.order - right.order || left.firstSeen - right.firstSeen;
      })
      .map(function (bucket) {
        return {
          key: bucket.key,
          label: bucket.label,
          order: bucket.order,
          entries: bucket.entries,
        };
      });
  }

  function filterGroups(groups, query) {
    var normalizedQuery = String(query || '').trim().toLowerCase();
    if (!normalizedQuery) {
      return groups;
    }
    return groups
      .map(function (group) {
        return {
          key: group.key,
          label: group.label,
          order: group.order,
          entries: group.entries.filter(function (entry) {
            return entry.id.toLowerCase().includes(normalizedQuery);
          }),
        };
      })
      .filter(function (group) {
        return group.entries.length > 0;
      });
  }

  function effortSegmentLabel(value) {
    var input = String(value || '').trim();
    var labels = {
      default: 'Default',
      none: 'Off',
      minimal: 'Min',
      low: 'Low',
      medium: 'Med',
      high: 'High',
      xhigh: 'X-high',
      max: 'Max',
    };
    return labels[input.toLowerCase()] || input || 'Default';
  }

  function getEffortSuffix(effort, effortSupported) {
    var normalizedEffort = String(effort || '').trim().toLowerCase();
    if (effortSupported !== true || !normalizedEffort || normalizedEffort === 'default') {
      return '';
    }
    return ' · ' + effortSegmentLabel(effort);
  }

  // The model a "Default" chat (preferred_model '') runs on: the Settings
  // default for local inference unless a cloud engine is active, otherwise the
  // loaded model. Mirrors backend-chat-model-resolution.js resolveDefaultChatModel.
  function resolveDefaultChatModel(state) {
    var source = state || {};
    var status = source.status || {};
    var modelList = source.modelList || {};
    var loaded = String(status.model || modelList.active_model || '').trim();
    var loadedEngine = String(status.engine || status.engine_type || modelList.engine_type || '').trim().toLowerCase();
    var preferred = String((source.offline && source.offline.preferredLocalModel) || '').trim();
    var cloud = loadedEngine === 'chatgpt' || loadedEngine === 'codex-cli' || loadedEngine === 'api-provider';
    if (!preferred || preferred === loaded || cloud) return { model: loaded, engineType: loadedEngine };
    // The catalog lists one engine family at a time, so an unlisted default (NInfer while Ollama
    // runs) is still the default; its engine is known only when listed.
    var models = Array.isArray(modelList.data) ? modelList.data : [];
    var entry = models.find(function (model) { return String((model && (model.id || model.name)) || '') === preferred; });
    return { model: preferred, engineType: String((entry && (entry.engine_type || entry.engineType)) || '').trim().toLowerCase() };
  }

  function formatComposerModelPillLabel(input) {
    var source = input || {};
    var preferredModel = String(source.preferredModel || '').trim();
    var backendModel = String(source.backendModel || '').trim();
    var effortSuffix = getEffortSuffix(source.effort, source.effortSupported);
    if (preferredModel) {
      var preferred = splitModelId(preferredModel);
      return preferred.family + (preferred.tagHead ? ' · ' + preferred.tagHead : '') + effortSuffix;
    }
    if (backendModel) {
      return 'Default · ' + splitModelId(backendModel).family + effortSuffix;
    }
    return 'Default' + effortSuffix;
  }

  function buildPillTitle(input) {
    var source = input || {};
    var preferredModel = String(source.preferredModel || '').trim();
    var backendModel = String(source.backendModel || '').trim();
    var title = preferredModel
      ? 'Model: ' + preferredModel
      : (backendModel ? 'Model: default (' + backendModel + ')' : 'Model: default');
    if (source.effortSupported === true) {
      title += '. Thinking: ' + effortSegmentLabel(source.effort);
    }
    return title;
  }

  return {
    splitModelId: splitModelId,
    resolveModelGroup: resolveModelGroup,
    normalizeCatalogEntry: normalizeCatalogEntry,
    groupCatalogEntries: groupCatalogEntries,
    filterGroups: filterGroups,
    effortSegmentLabel: effortSegmentLabel,
    formatComposerModelPillLabel: formatComposerModelPillLabel,
    buildPillTitle: buildPillTitle,
    resolveDefaultChatModel: resolveDefaultChatModel,
  };
});
