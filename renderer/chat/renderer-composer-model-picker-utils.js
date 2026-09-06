(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerModelPickerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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
      return { key: 'codex-cli', label: 'Codex CLI', order: 50 };
    }
    if (engineType === 'chatgpt') {
      return { key: 'chatgpt', label: 'ChatGPT', order: 40 };
    }
    if (/^(?:hf\.co|huggingface\.co)\//i.test(id)) {
      return { key: 'huggingface', label: 'Hugging Face', order: 30 };
    }
    if (engineType === 'ollama') {
      return { key: 'ollama', label: 'Ollama', order: 10 };
    }
    if (engineType === 'vllm') {
      return { key: 'vllm', label: 'vLLM', order: 20 };
    }
    if (engineType === 'openai-compatible') {
      return { key: 'openai-compatible', label: 'OpenAI-compatible', order: 25 };
    }
    if (engineType === 'plugin_host') {
      return { key: 'plugins', label: 'Plugins', order: 60 };
    }
    // Name heuristic only when the catalog did not say which engine serves
    // the model: gpt-oss:20b on Ollama must stay in the Ollama group.
    if (/^gpt-/i.test(id)) {
      return { key: 'chatgpt', label: 'ChatGPT', order: 40 };
    }
    return { key: 'other', label: 'Other', order: 90 };
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
    var split = splitModelId(id);
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
      group: resolveModelGroup({ id: id, engineType: engineType }),
    };
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
  };
});
