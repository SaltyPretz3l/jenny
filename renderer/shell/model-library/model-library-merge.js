/* Pure projection of installed local models and ranked catalog entries. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../renderer-model-library-format-utils'),
      require('./model-library-fit')
    );
    return;
  }
  root.modelLibraryMerge = factory(root.rendererModelLibraryFormatUtils, root.modelLibraryFit);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (formatUtils, fitUtils) {
  'use strict';

  var canonicalOllamaTag = formatUtils && formatUtils.canonicalOllamaTag;
  if (typeof canonicalOllamaTag !== 'function'
    || !fitUtils || typeof fitUtils.effectiveCatalogFitState !== 'function'
    || typeof fitUtils.fitLabelFor !== 'function'
    || typeof fitUtils.fitRatioFor !== 'function'
    || typeof fitUtils.fitTone !== 'function') {
    throw new Error('model-library-merge: missing required dependency');
  }

  var LOCAL_ENGINE_TYPES = Object.freeze(['ollama', 'vllm', 'openai-compatible']);

  function canonicalTag(value) {
    return canonicalOllamaTag(value);
  }

  // Mirrors sidecar/ai/app_profiles.canonicalize_model_name and
  // services/backend/llama-server-acceleration.js::canonicalizeModelToken.
  // Shared fixtures keep these dependency-free boundary helpers in sync.
  function canonicalFamilyToken(tag) {
    var key = String(tag).trim().toLowerCase();
    var base = key.slice(key.lastIndexOf('/') + 1).split(':', 1)[0];
    return base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Mirrors services/shell-config-engines.js::managedModelKey (size tag preserved).
  function managedModelKey(tag) {
    return canonicalFamilyToken(String(tag == null ? '' : tag).replace(/:/g, '-'));
  }

  // The manager stores its alias as stripLatestTag(modelTag), so 'gemma3:latest'
  // is served under 'gemma3'. Compare served-vs-selected through this, never
  // through managedModelKey alone, which keys perModel storage and must keep the
  // suffix it was written with.
  function managedAliasKey(tag) {
    return managedModelKey(String(tag == null ? '' : tag).replace(/:latest$/i, ''));
  }

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  // Joins a GGUF directory and file name with the directory's own separator
  // style (shared with the Tune drawer's engine view-model).
  function joinModelPath(dir, file) {
    var base = String(dir == null ? '' : dir).trim().replace(/[\\/]+$/, '');
    var name = String(file == null ? '' : file).trim().replace(/^[\\/]+/, '');
    if (!base) return name;
    return base + (base.indexOf('\\') >= 0 ? '\\' : '/') + name;
  }

  function nonNegativeNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function normalizeAcceleration(acceleration) {
    var source = objectOrEmpty(acceleration);
    var enabled = source.enabled === true;
    return {
      enabled: enabled,
      headroomMb: enabled ? nonNegativeNumber(source.headroomMb) : 0,
      families: Array.isArray(source.families) ? source.families : [],
    };
  }

  function matchAccelerationFamily(tag, acceleration) {
    if (!acceleration.enabled) return null;
    var token = canonicalFamilyToken(tag);
    for (var i = 0; i < acceleration.families.length; i += 1) {
      var family = objectOrEmpty(acceleration.families[i]);
      var prefixes = Array.isArray(family.matchPrefixes) ? family.matchPrefixes : [];
      for (var j = 0; j < prefixes.length; j += 1) {
        if (typeof prefixes[j] === 'string' && prefixes[j].length > 0
            && token.startsWith(prefixes[j])) {
          return family;
        }
      }
    }
    return null;
  }

  // "MTP ready" is a shipped claim — only verified families ("yes") qualify.
  function isEligibleFamily(family) {
    return Boolean(family && family.mtp === 'yes');
  }

  // Headroom is a per-model cost: only a card that would actually accelerate
  // pays it (gemma4's separate drafter needs ~512 MB, not the 2 GB default),
  // and ineligible models keep their full budget.
  function cardHeadroomMb(family, acceleration, mtpEnabled) {
    if (!mtpEnabled || !isEligibleFamily(family)) return 0;
    var value = Number(family.vramHeadroomMb);
    return Number.isFinite(value) && value >= 0 ? value : acceleration.headroomMb;
  }

  function firstValue(source, keys) {
    for (var i = 0; i < keys.length; i += 1) {
      if (source[keys[i]] !== undefined && source[keys[i]] !== null) {
        return source[keys[i]];
      }
    }
    return undefined;
  }

  function stringValue(source, keys) {
    var value = firstValue(source, keys);
    return value === undefined ? '' : String(value).trim();
  }

  function engineFields(tag, family, context, installedEntry, ollamaTag) {
    var managedKey = managedModelKey(tag);
    var perModel = objectOrEmpty(context.managed.perModel[managedKey]);
    var localGguf = context.localGgufs.get(managedKey) || null;
    var persistedPath = String(perModel.modelPath || '').trim();
    var mainGguf = localGguf ? String(localGguf.mainGguf || '').trim() : '';
    var modelPath = persistedPath || (mainGguf ? joinModelPath(localGguf.dir, mainGguf) : '');
    var selectedEngine = context.managed.enabled === true
      && perModel.engine === 'llama-server' ? 'llama-server' : 'ollama';
    var eligible = isEligibleFamily(family);
    var mtpEnabled = selectedEngine === 'llama-server'
      && objectOrEmpty(perModel.mtp).mode === 'mtp'
      && eligible;
    var serving = Boolean(context.llamaServer
      && context.llamaServer.state === 'ready'
      && managedAliasKey(context.llamaServer.alias) === managedAliasKey(tag));
    return {
      managedKey: managedKey,
      engines: {
        ollama: {
          // Catalog-only cards are pull targets; an installed card is Ollama-
          // runnable when Ollama installed it or Ollama lists the tag itself.
          available: Boolean(!installedEntry || installedEntry.engineType === 'ollama' || ollamaTag),
        },
        llamaServer: {
          available: Boolean(persistedPath || mainGguf),
          modelPath: modelPath,
          drafter: Boolean(localGguf && localGguf.drafterGguf),
        },
      },
      selectedEngine: selectedEngine,
      mtp: {
        eligible: eligible,
        enabled: mtpEnabled,
        headroomMb: cardHeadroomMb(family, context.acceleration, mtpEnabled),
      },
      serving: serving,
      servingPort: serving ? context.llamaServer.port : 0,
    };
  }

  function normalizeHardware(hardware, memory, accelerationHeadroomMb) {
    var profile = objectOrEmpty(hardware);
    var rawGpu = objectOrEmpty(profile.gpu);
    var gpu = Object.keys(rawGpu).length ? rawGpu : profile;
    var profileMemory = objectOrEmpty(profile.memory);
    var rawMemory = Object.keys(objectOrEmpty(memory)).length
      ? objectOrEmpty(memory)
      : profileMemory;
    var vramMb = nonNegativeNumber(firstValue(gpu, ['vramMb', 'vram_mb']));
    var unifiedMemoryMb = nonNegativeNumber(firstValue(gpu, [
      'unifiedMemoryMb',
      'unified_memory_mb',
    ]));
    var memoryArchitecture = stringValue(gpu, ['memoryArchitecture', 'memory_architecture']);
    var type = stringValue(gpu, ['type', 'gpuType']).toLowerCase();
    var hasGpuFields = Object.keys(rawGpu).length > 0
      || ['type', 'gpuType', 'name', 'vramMb', 'vram_mb', 'unifiedMemoryMb', 'unified_memory_mb']
        .some(function (key) { return Object.prototype.hasOwnProperty.call(profile, key); });
    var detected = profile.detected === false ? false : hasGpuFields;
    var explicitBudget = nonNegativeNumber(firstValue(profile, ['budgetMb', 'budget_mb']));
    var usesUnifiedMemory = type === 'metal' || memoryArchitecture === 'unified';
    // Hand-mirrors sidecar/runtime/hardware_profile.py::_UNIFIED_MODEL_MEMORY_FRACTION
    // because the sidecar does not export budget_mb.
    var budgetMb = explicitBudget
      || (usesUnifiedMemory ? Math.floor(unifiedMemoryMb * 0.5) : vramMb);

    return {
      detected: detected,
      type: type || (detected ? 'cpu' : ''),
      name: stringValue(gpu, ['name', 'gpuName']),
      vramMb: vramMb,
      memoryArchitecture: memoryArchitecture,
      unifiedMemoryMb: unifiedMemoryMb,
      ramTotalMb: nonNegativeNumber(firstValue(rawMemory, ['totalMb', 'total_mb'])),
      ramAvailableMb: nonNegativeNumber(firstValue(rawMemory, ['availableMb', 'available_mb'])),
      budgetMb: budgetMb,
      accelerationHeadroomMb: accelerationHeadroomMb,
    };
  }

  function entryTag(entry) {
    if (typeof entry === 'string') return entry.trim();
    var source = objectOrEmpty(entry);
    return stringValue(source, ['pullTag', 'modelId', 'id', 'name', 'model', 'tag']);
  }

  function normalizeInstalledEntries(installed) {
    var byKey = new Map();
    (Array.isArray(installed) ? installed : []).forEach(function (entry) {
      var source = objectOrEmpty(entry);
      var tag = entryTag(entry);
      var key = canonicalTag(tag);
      if (!key) return;
      var sizeBytes = nonNegativeNumber(firstValue(source, ['sizeBytes', 'size']));
      var engineType = stringValue(source, ['engineType', 'engine_type']).toLowerCase();
      var available = source.available !== false;
      var params = stringValue(source, ['params', 'parameterSize', 'parameter_size']);
      var quant = stringValue(source, ['quant', 'quantizationLevel', 'quantization_level']);
      var digest = stringValue(source, ['digest']);
      var current = byKey.get(key);
      if (!current) {
        byKey.set(key, {
          key: key,
          tag: tag,
          displayName: stringValue(source, ['displayName', 'display_name']) || tag,
          sizeBytes: sizeBytes,
          engineType: engineType,
          available: available,
          loaded: source.loaded === true || source.active === true || source.isLoaded === true,
          params: params,
          quant: quant,
          digest: digest,
        });
        return;
      }
      if (!current.sizeBytes && sizeBytes) current.sizeBytes = sizeBytes;
      if (!current.engineType && engineType) current.engineType = engineType;
      if (!available) current.available = false;
      if (source.loaded === true || source.active === true || source.isLoaded === true) {
        current.loaded = true;
      }
      if (!current.params && params) current.params = params;
      if (!current.quant && quant) current.quant = quant;
      if (!current.digest && digest) current.digest = digest;
    });
    return byKey;
  }

  function normalizeOllamaTags(ollamaTags) {
    var byKey = new Map();
    (Array.isArray(ollamaTags) ? ollamaTags : []).forEach(function (entry) {
      var source = objectOrEmpty(entry);
      var tag = entryTag(entry);
      var key = canonicalTag(tag);
      if (!key) return;
      var sizeBytes = nonNegativeNumber(firstValue(source, ['sizeBytes', 'size']));
      var current = byKey.get(key);
      if (!current) {
        byKey.set(key, { tag: tag, sizeBytes: sizeBytes });
      } else if (!current.sizeBytes && sizeBytes) {
        current.sizeBytes = sizeBytes;
      }
    });
    return byKey;
  }

  // Single shared computation point for the fit-shaped fields so the catalog
  // and installed builders cannot drift: given a recommendation-shaped input
  // (a real catalog recommendation, or an estimator entry projected the same
  // way) plus the per-card MTP headroom, derive fitState/fitRatio/fitLabel.
  function computeCardFit(recommendation, vramRequiredMb, context, headroomMb) {
    var effectiveBudgetMb = Math.max(context.hardware.budgetMb - headroomMb, 0);
    var fitState = fitUtils.effectiveCatalogFitState(
      recommendation,
      vramRequiredMb,
      context,
      effectiveBudgetMb
    );
    return {
      effectiveBudgetMb: effectiveBudgetMb,
      fitState: fitState,
      fitRatio: fitUtils.fitRatioFor(vramRequiredMb, effectiveBudgetMb, fitState),
      fitLabel: fitUtils.fitLabelFor(fitState, vramRequiredMb, effectiveBudgetMb),
    };
  }

  function buildCatalogCard(recommendation, installedEntry, ollamaTag, context) {
    var tag = entryTag(recommendation);
    var key = canonicalTag(tag);
    var installed = Boolean(installedEntry || ollamaTag);
    var vramRequiredMb = nonNegativeNumber(recommendation.vramRequiredMb);
    var family = matchAccelerationFamily(tag, context.acceleration);
    var engine = engineFields(tag, family, context, installedEntry, ollamaTag);
    var headroomMb = engine.mtp.headroomMb;
    var fit = computeCardFit(recommendation, vramRequiredMb, context, headroomMb);
    return {
      key: key,
      tag: tag,
      displayName: String(recommendation.displayName || tag),
      tier: String(recommendation.tier || ''),
      params: String(recommendation.params || ''),
      quant: String(recommendation.quant || ''),
      contextLength: nonNegativeNumber(recommendation.contextLength),
      sizeBytes: installedEntry ? installedEntry.sizeBytes : (ollamaTag ? ollamaTag.sizeBytes : 0),
      downloadSizeMb: nonNegativeNumber(recommendation.downloadSizeMb),
      vramRequiredMb: vramRequiredMb,
      ramRequiredMb: nonNegativeNumber(recommendation.ramRequiredMb),
      installed: installed,
      engineVisible: Boolean(installedEntry),
      ollamaOnly: Boolean(ollamaTag && !installedEntry),
      engineType: installedEntry ? installedEntry.engineType : '',
      available: installedEntry ? installedEntry.available : true,
      active: Boolean((installedEntry && installedEntry.loaded) || key === context.activeKey),
      preferredLocal: Boolean(context.preferredKey && key === context.preferredKey),
      recommended: recommendation.recommended,
      reason: recommendation.reason,
      fitState: fit.fitState,
      fitRatio: fit.fitRatio,
      fitLabel: fit.fitLabel,
      fitSource: 'catalog',
      fitConfidence: 'high',
      accelerationEligible: isEligibleFamily(family),
      accelerationHeadroomMb: headroomMb,
      managedKey: engine.managedKey,
      engines: engine.engines,
      selectedEngine: engine.selectedEngine,
      mtp: engine.mtp,
      serving: engine.serving,
      servingPort: engine.servingPort,
      source: installed ? 'both' : 'catalog',
    };
  }

  function buildInstalledCard(entry, ollamaOnly, context, ollamaTag, fitEstimate) {
    var tag = entry.tag;
    var family = matchAccelerationFamily(tag, context.acceleration);
    var engine = engineFields(tag, family, context, ollamaOnly ? null : entry, ollamaTag);
    var params = entry.params || (fitEstimate ? fitEstimate.params : '') || '';
    var quant = entry.quant || (fitEstimate ? fitEstimate.quant : '') || '';
    var hasEstimate = Boolean(fitEstimate) && context.hardware.detected;
    var fitState = 'unknown';
    var fitRatio = 0;
    var fitLabel = 'Not in catalog';
    var fitSource = '';
    var fitConfidence = '';
    var vramRequiredMb = 0;
    var ramRequiredMb = 0;
    var contextLength = 0;
    if (hasEstimate) {
      vramRequiredMb = nonNegativeNumber(fitEstimate.vramRequiredMb);
      ramRequiredMb = nonNegativeNumber(fitEstimate.ramRequiredMb);
      contextLength = nonNegativeNumber(fitEstimate.contextLength);
      var fit = computeCardFit(fitEstimate, vramRequiredMb, context, engine.mtp.headroomMb);
      fitState = fit.fitState;
      fitRatio = fit.fitRatio;
      fitLabel = fit.fitLabel;
      // Diagnostics resolves observed > estimated; anything else is an estimate.
      fitSource = fitEstimate.fitSource === 'observed' ? 'observed' : 'estimated';
      fitConfidence = String(fitEstimate.fitConfidence || fitEstimate.confidence || 'low');
    }
    return {
      key: entry.key,
      tag: tag,
      displayName: entry.displayName || tag,
      tier: '',
      params: String(params),
      quant: String(quant),
      contextLength: contextLength,
      sizeBytes: entry.sizeBytes || 0,
      downloadSizeMb: 0,
      vramRequiredMb: vramRequiredMb,
      ramRequiredMb: ramRequiredMb,
      installed: true,
      engineVisible: !ollamaOnly,
      ollamaOnly: ollamaOnly,
      engineType: entry.engineType || '',
      available: entry.available !== false,
      active: Boolean(entry.loaded || entry.key === context.activeKey),
      preferredLocal: Boolean(context.preferredKey && entry.key === context.preferredKey),
      recommended: undefined,
      reason: undefined,
      fitState: fitState,
      fitRatio: fitRatio,
      fitLabel: fitLabel,
      fitSource: fitSource,
      fitConfidence: fitConfidence,
      accelerationEligible: isEligibleFamily(family),
      accelerationHeadroomMb: engine.mtp.headroomMb,
      managedKey: engine.managedKey,
      engines: engine.engines,
      selectedEngine: engine.selectedEngine,
      mtp: engine.mtp,
      serving: engine.serving,
      servingPort: engine.servingPort,
      source: 'installed',
    };
  }

  function orderModelCards(cards) {
    var source = Array.isArray(cards) ? cards : [];
    return source.filter(function (card) { return card && card.installed === true; })
      .concat(source.filter(function (card) {
        return card && card.installed !== true && card.recommended === true;
      }))
      .concat(source.filter(function (card) {
        return card && card.installed !== true && card.recommended !== true;
      }));
  }

  function filterModelCards(cards, filterId) {
    var source = Array.isArray(cards) ? cards : [];
    if (filterId === 'installed') {
      return source.filter(function (card) { return card && card.installed === true; });
    }
    if (filterId === 'recommended') {
      return source.filter(function (card) { return card && card.recommended === true; });
    }
    return source.slice();
  }

  function isLocalEngine(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
    return LOCAL_ENGINE_TYPES.includes(String(card.engineType || '').toLowerCase());
  }

  // A card whose engine list entry carried no engine_type (normalizeInstalled
  // defaults it to '') is local: only a NAMED non-local engine is Cloud. The
  // grouping and the row renderer share this one predicate so they cannot
  // drift - a card grouped under "Installed" always keeps Tune and the
  // overflow menu (the only Remove path in the row view).
  function isLocalOrUnknownEngine(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
    return isLocalEngine(card) || !card.engineType;
  }

  function groupModelCards(cards) {
    var groups = [
      { id: 'in-use', label: 'In use', cards: [] },
      { id: 'installed', label: 'Installed', cards: [] },
      { id: 'cloud', label: 'Cloud', cards: [] },
      { id: 'available', label: 'Available to download', cards: [] },
    ];
    var source = Array.isArray(cards) ? cards : [];
    source.forEach(function (card) {
      if (!card || typeof card !== 'object' || Array.isArray(card)) return;
      if (card.active === true) {
        groups[0].cards.push(card);
      } else if (card.installed !== true) {
        groups[3].cards.push(card);
      } else if (isLocalOrUnknownEngine(card)) {
        groups[1].cards.push(card);
      } else {
        groups[2].cards.push(card);
      }
    });
    return groups;
  }

  function filterCounts(cards) {
    var counts = { all: 0, installed: 0, recommended: 0 };
    var source = Array.isArray(cards) ? cards : [];
    source.forEach(function (card) {
      if (!card || typeof card !== 'object' || Array.isArray(card)) return;
      counts.all += 1;
      if (card.installed === true) counts.installed += 1;
      if (card.recommended === true) counts.recommended += 1;
    });
    return counts;
  }

  function mergeModelLibrary(input) {
    var source = objectOrEmpty(input);
    var acceleration = normalizeAcceleration(source.acceleration);
    var hardware = normalizeHardware(
      source.hardware,
      source.memory,
      acceleration.headroomMb
    );
    var installedByKey = normalizeInstalledEntries(source.installed);
    var ollamaByKey = normalizeOllamaTags(source.ollamaTags);
    var fitEstimatesByKey = new Map();
    (Array.isArray(source.fitEstimates) ? source.fitEstimates : []).forEach(function (entry) {
      var value = objectOrEmpty(entry);
      var key = canonicalTag(value.modelId);
      if (key && !fitEstimatesByKey.has(key)) fitEstimatesByKey.set(key, value);
    });
    var managedSource = objectOrEmpty(source.managed);
    var localGgufs = new Map();
    (Array.isArray(source.localGgufs) ? source.localGgufs : []).forEach(function (entry) {
      var value = objectOrEmpty(entry);
      var key = managedModelKey(value.tag);
      if (key && !localGgufs.has(key)) localGgufs.set(key, value);
    });
    var context = {
      hardware: hardware,
      acceleration: acceleration,
      managed: {
        enabled: managedSource.enabled === true,
        perModel: objectOrEmpty(managedSource.perModel),
      },
      localGgufs: localGgufs,
      llamaServer: source.llamaServer && typeof source.llamaServer === 'object'
        && !Array.isArray(source.llamaServer) ? source.llamaServer : null,
      activeKey: canonicalTag(source.activeModel),
      preferredKey: canonicalTag(source.preferredLocalModel),
    };
    var cards = [];
    var usedKeys = new Set();
    var cardIndexByKey = new Map();

    (Array.isArray(source.recommendations) ? source.recommendations : []).forEach(function (item) {
      var recommendation = objectOrEmpty(item);
      var key = canonicalTag(entryTag(recommendation));
      if (!key) return;
      if (usedKeys.has(key)) {
        var keptIndex = cardIndexByKey.get(key);
        // Catalog twins share a pull tag; preserve whichever twin the sidecar
        // actually flagged so the single rendered card keeps its badge.
        if (recommendation.recommended === true && cards[keptIndex].recommended !== true) {
          cards[keptIndex] = buildCatalogCard(
            recommendation,
            installedByKey.get(key),
            ollamaByKey.get(key),
            context
          );
        }
        return;
      }
      usedKeys.add(key);
      cardIndexByKey.set(key, cards.length);
      cards.push(buildCatalogCard(
        recommendation,
        installedByKey.get(key),
        ollamaByKey.get(key),
        context
      ));
    });

    installedByKey.forEach(function (entry, key) {
      if (usedKeys.has(key)) return;
      usedKeys.add(key);
      cards.push(buildInstalledCard(
        entry,
        false,
        context,
        ollamaByKey.get(key) || null,
        fitEstimatesByKey.get(key) || null
      ));
    });
    ollamaByKey.forEach(function (entry, key) {
      if (usedKeys.has(key)) return;
      usedKeys.add(key);
      cards.push(buildInstalledCard({
        key: key,
        tag: entry.tag,
        displayName: entry.tag,
        sizeBytes: entry.sizeBytes,
      }, true, context, entry, fitEstimatesByKey.get(key) || null));
    });

    return {
      hardware: hardware,
      catalogMeta: source.catalogMeta && typeof source.catalogMeta === 'object'
        && !Array.isArray(source.catalogMeta) ? source.catalogMeta : null,
      cards: orderModelCards(cards),
    };
  }

  return {
    LOCAL_ENGINE_TYPES: LOCAL_ENGINE_TYPES,
    canonicalFamilyToken: canonicalFamilyToken,
    managedAliasKey: managedAliasKey,
    managedModelKey: managedModelKey,
    joinModelPath: joinModelPath,
    matchAccelerationFamily: matchAccelerationFamily,
    isEligibleFamily: isEligibleFamily,
    mergeModelLibrary: mergeModelLibrary,
    orderModelCards: orderModelCards,
    filterModelCards: filterModelCards,
    isLocalEngine: isLocalEngine,
    isLocalOrUnknownEngine: isLocalOrUnknownEngine,
    groupModelCards: groupModelCards,
    filterCounts: filterCounts,
    fitTone: fitUtils.fitTone,
  };
});
