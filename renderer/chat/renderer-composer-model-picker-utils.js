(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerModelPickerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // api-provider/<instance>/<modelId> shows the provider's own model id.
  function displayModelId(value) {
    var id = String(value || '').trim();
    var match = /^api-provider\/[a-z][a-z0-9-]{1,31}\/(.+)$/.exec(id);
    return match ? match[1] : id;
  }

  function splitModelId(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return { id: '', family: '', tag: '', tagHead: '', org: '', engineHint: '' };
    }

    var id = value.trim();
    var remainder = displayModelId(id);
    var org = '';
    var engineHint = '';
    // A team model (team/<teamId>/<modelId>) shows the team's own model id.
    var teamMatch = /^team\/team_[A-Za-z0-9_-]{1,64}\/(.+)$/.exec(remainder);
    if (teamMatch) {
      engineHint = 'team';
      remainder = teamMatch[1];
    } else if (/^codex-cli\//i.test(remainder)) {
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
    // Row 123: each team is its own group, named by the team.
    var teamId = String(source.teamId || '').trim();
    if (teamId && engineType === 'openai-compatible') {
      return { key: 'team:' + teamId, label: String(source.teamName || '').trim() || teamId, order: 65 };
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
        teamId: source.team_id,
        teamName: source.team_name,
      }),
      hint: apiProviderHint(engineType, source) || teamEngineHint(source),
    };
  }

  // The notice (D7) under every team row: who can read what a team model is sent.
  function teamEngineHint(source) {
    if (!source.team_id) return '';
    return jt('team.engine.notice', 'The team’s host and the person whose hardware responds can read your prompts and replies.');
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

  // The effort select names "none" Minimal for a model that cannot turn thinking off.
  function effortSegmentLabel(value, fullLabel) {
    var input = String(value || '').trim();
    if (input === 'none' && fullLabel === 'Minimal') input = 'minimal';
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

  function selectedEffortLabel(source) {
    var selected = (source.effortOptions || []).find(function (option) { return option.value === source.effort; });
    return effortSegmentLabel(source.effort, selected && selected.label);
  }

  function getEffortSuffix(source) {
    var normalizedEffort = String(source.effort || '').trim().toLowerCase();
    if (source.effortSupported !== true || !normalizedEffort || normalizedEffort === 'default') {
      return '';
    }
    return ' · ' + selectedEffortLabel(source);
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
    var effortSuffix = getEffortSuffix(source);
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
      ? 'Model: ' + displayModelId(preferredModel)
      : (backendModel ? 'Model: default (' + displayModelId(backendModel) + ')' : 'Model: default');
    if (source.effortSupported === true) {
      title += '. Thinking: ' + selectedEffortLabel(source);
    }
    return title;
  }

  // Row 144: port of services/model-size-class.js (a test compares the two).
  var CLOUD_ENGINES = { chatgpt: 1, 'codex-cli': 1, 'api-provider': 1 };
  function positive(value) { return value > 0 && Number.isFinite(value) ? value : null; }
  function sizeFromText(text) {
    var best = null;
    String(text || '').replace(/(?:(\d+)x)?(\d+(?:\.\d+)?)b(?![a-z0-9])/gi, function (all, experts, size) {
      var value = positive(parseFloat(size) * (experts ? Number(experts) : 1));
      if (value !== null && (best === null || value > best)) best = value;
      return all;
    });
    return best;
  }
  function sizeFromLabel(label) {
    var text = typeof label === 'string' ? label.trim() : '';
    var match = /^(\d+(?:\.\d+)?)\s*([BM])/i.exec(text);
    if (/^\d+x/i.test(text)) return sizeFromText(text);
    return match ? positive(parseFloat(match[1]) / (/m/i.test(match[2]) ? 1000 : 1)) : null;
  }
  function classifyCheckModel(input) {
    var source = input || {};
    if (CLOUD_ENGINES[String(source.engineType || '').trim().toLowerCase()] === 1) return { fit: true, params_b: null, source: 'cloud' };
    var engine = sizeFromLabel(source.parameterSize);
    var size = engine !== null ? engine : sizeFromText(source.model);
    if (size === null) return { fit: false, params_b: null, source: 'unknown' };
    return { fit: size >= 7, params_b: Math.round(size * 10) / 10, source: engine !== null ? 'engine' : 'name' };
  }

  // Jenny's pinned model, for the Jenny chat's session only.
  function resolvePinnedModel(snapshot, sessionId) {
    var snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    if (snap.status !== 'ready' || !sessionId || snap.session_id !== sessionId) return '';
    return typeof snap.model === 'string' ? snap.model.trim() : '';
  }

  return {
    sizeFromText: sizeFromText,
    sizeFromLabel: sizeFromLabel,
    classifyCheckModel: classifyCheckModel,
    resolvePinnedModel: resolvePinnedModel,
    displayModelId: displayModelId,
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
