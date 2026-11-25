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

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var canonicalOllamaTag = formatUtils && formatUtils.canonicalOllamaTag;
  if (typeof canonicalOllamaTag !== 'function'
    || !fitUtils || typeof fitUtils.effectiveCatalogFitState !== 'function'
    || typeof fitUtils.fitLabelFor !== 'function'
    || typeof fitUtils.fitRatioFor !== 'function'
    || typeof fitUtils.fitTone !== 'function') {
    throw new Error('model-library-merge: missing required dependency');
  }

  var LOCAL_ENGINE_TYPES = Object.freeze(['ollama', 'vllm', 'openai-compatible']);

  // Row 201 C1 / OD-1: the one renderer predicate for a team model lives with the composer picker's helpers.
  // Resolved at call time: this script loads before them, and a test requires them directly.
  function pickerUtils() {
    if (globalThis.rendererComposerModelPickerUtils) return globalThis.rendererComposerModelPickerUtils;
    return typeof require === 'function' ? require('../../chat/renderer-composer-model-picker-utils') : null;
  }

  // Splits team model rows (a teammate's GPU) from the rows that are on this PC.
  function partitionTeamModels(installed) {
    var utils = pickerUtils();
    var local = [];
    var team = [];
    var seen = new Set();
    (Array.isArray(installed) ? installed : []).forEach(function (entry) {
      if (!utils || !utils.isTeamModel(entry)) { local.push(entry); return; }
      var source = objectOrEmpty(entry);
      var id = String(source.id || '').trim();
      var parsed = utils.parseTeamModel(id);
      if (!parsed || seen.has(id)) return;
      seen.add(id);
      var contextLength = Number(source.context_length);
      team.push({
        id: id,
        modelId: parsed.modelId,
        teamId: String(source.team_id || parsed.teamId),
        teamName: String(source.team_name || '').trim(),
        contextLength: Number.isSafeInteger(contextLength) && contextLength > 0 ? contextLength : 0,
      });
    });
    return { local: local, team: team };
  }

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
    var server = context.llamaServer;
    var serving = Boolean(server && server.state === 'ready' && managedAliasKey(server.alias) === managedAliasKey(tag));
    // Parked by the chat GPU handoff for an image render: stopped, identity kept.
    var paused = Boolean(server && server.state === 'stopped' && server.identityRetained === true && managedAliasKey(server.alias) === managedAliasKey(tag));
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
      // MTP would run on llama-server: a drafter file beside the model, or the GGUF's own head.
      mtpRunnable: Boolean(localGguf && (localGguf.drafterGguf || Number(localGguf.embeddedMtpLayers) > 0)),
      selectedEngine: selectedEngine,
      mtp: {
        eligible: eligible,
        enabled: mtpEnabled,
        headroomMb: cardHeadroomMb(family, context.acceleration, mtpEnabled),
      },
      serving: serving, servingPaused: paused,
      servingPort: serving ? context.llamaServer.port : 0,
      // The model's own llama-server build, shown as " · build N"; 0 = bundled.
      customBuild: selectedEngine === 'llama-server' && typeof perModel.runtimePath === 'string' && perModel.runtimePath !== '' ? Number(perModel.runtimeBuild) || 0 : 0,
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
      var key = source.libraryGguf === true && source.ownCardKey ? String(source.ownCardKey) : canonicalTag(tag); // see projectLibraryGgufs
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
          libraryGguf: source.libraryGguf === true,
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
      if (source.libraryGguf === true) current.libraryGguf = true;
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

  function buildCatalogCard(recommendation, installedEntry, ollamaTag, context, fitEstimate) {
    var tag = entryTag(recommendation);
    var key = canonicalTag(tag);
    var installed = Boolean(installedEntry || ollamaTag);
    var observed = fitEstimate && fitEstimate.fitSource === 'observed' ? fitEstimate : null;
    // Re-estimated at the window Jenny loads when that differs from the catalog's.
    var reestimated = installed && fitEstimate && fitEstimate.fitSource === 'estimated' ? fitEstimate : null;
    var resolvedFit = observed || reestimated || recommendation;
    var vramRequiredMb = nonNegativeNumber(resolvedFit.vramRequiredMb);
    var family = matchAccelerationFamily(tag, context.acceleration);
    var engine = engineFields(tag, family, context, installedEntry, ollamaTag);
    var headroomMb = engine.mtp.headroomMb;
    var fit = computeCardFit(resolvedFit, vramRequiredMb, context, headroomMb);
    return {
      key: key,
      tag: tag,
      displayName: String(recommendation.displayName || tag),
      tier: String(recommendation.tier || ''),
      params: String(recommendation.params || ''),
      quant: String(recommendation.quant || ''),
      contextLength: nonNegativeNumber(resolvedFit.contextLength),
      sizeBytes: installedEntry ? installedEntry.sizeBytes : (ollamaTag ? ollamaTag.sizeBytes : 0),
      downloadSizeMb: nonNegativeNumber(recommendation.downloadSizeMb),
      vramRequiredMb: vramRequiredMb,
      ramRequiredMb: nonNegativeNumber(resolvedFit.ramRequiredMb),
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
      fitSource: observed ? 'observed' : (reestimated ? 'estimated' : 'catalog'),
      fitConfidence: reestimated ? String(reestimated.fitConfidence || 'low') : 'high',
      accelerationEligible: isEligibleFamily(family),
      mtpRunnable: engine.mtpRunnable,
      accelerationHeadroomMb: headroomMb,
      managedKey: engine.managedKey,
      engines: engine.engines,
      selectedEngine: engine.selectedEngine,
      mtp: engine.mtp,
      serving: engine.serving, servingPaused: engine.servingPaused,
      servingPort: engine.servingPort,
      customBuild: engine.customBuild,
      libraryGguf: Boolean(installedEntry && installedEntry.libraryGguf),
      source: installed ? 'both' : 'catalog',
    };
  }

  function buildInstalledCard(entry, ollamaOnly, context, ollamaTag, fitEstimate) {
    var tag = entry.tag;
    var family = matchAccelerationFamily(tag, context.acceleration);
    var engine = engineFields(tag, family, context, ollamaOnly ? null : entry, ollamaTag);
    var params = entry.params || (fitEstimate ? fitEstimate.params : '') || '';
    var quant = entry.quant || (fitEstimate ? fitEstimate.quant : '') || '';
    // A local GGUF the estimator does not know still gets a rough need from its
    // file: the weights plus working memory, shown as an estimate.
    if (!fitEstimate && entry.libraryGguf === true && entry.sizeBytes > 0) {
      var fileNeedMb = Math.round((entry.sizeBytes / 1048576) * 1.15) + 768;
      fitEstimate = {
        vramRequiredMb: fileNeedMb, fitSource: 'estimated', fitConfidence: 'low',
        fitsInVram: fileNeedMb <= nonNegativeNumber(context.hardware.budgetMb),
      };
    }
    var hasEstimate = Boolean(fitEstimate) && context.hardware.detected;
    var fitState = 'unknown';
    var fitRatio = 0;
    var fitLabel = jt('models.library.merge.notInCatalog', 'Not in catalog');
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
      mtpRunnable: engine.mtpRunnable,
      accelerationHeadroomMb: engine.mtp.headroomMb,
      managedKey: engine.managedKey,
      engines: engine.engines,
      selectedEngine: engine.selectedEngine,
      mtp: engine.mtp,
      serving: engine.serving, servingPaused: engine.servingPaused,
      servingPort: engine.servingPort,
      customBuild: engine.customBuild,
      libraryGguf: entry.libraryGguf === true,
      source: 'installed',
    };
  }

  // Row 54: the pinned NInfer artifacts as library cards, only when the NInfer
  // block reports an eligible card (`source.ninfer`, see model-library-ninfer.js
  // libraryInput). "Best fit" is the eligibility verdict itself: the pin is
  // chosen for this GPU, so the card is recommended and fits; its VRAM need is
  // the artifact size. One owner per message: while the set-up runs the row
  // offers no Download (`ninferSetupRunning`).
  function buildNinferCards(source, context, installedByKey) {
    var ninfer = objectOrEmpty(source.ninfer);
    var pins = Array.isArray(ninfer.pins) ? ninfer.pins : [];
    var installed = Array.isArray(ninfer.installed) ? ninfer.installed : [];
    var manager = objectOrEmpty(ninfer.manager);
    var settings = objectOrEmpty(ninfer.settings);
    var budgetMb = nonNegativeNumber(context.hardware.budgetMb);
    return pins.map(function (entry) {
      var pin = objectOrEmpty(entry);
      var tag = String(pin.model_id || pin.id || '').trim();
      if (!tag) return null;
      var key = canonicalTag(tag);
      var present = installed.some(function (item) { return item && item.id === pin.id && item.present === true; });
      var aliasMatches = managedAliasKey(manager.alias) === managedAliasKey(tag);
      var serving = manager.state === 'ready' && aliasMatches;
      var paused = manager.state === 'stopped' && manager.identityRetained === true && aliasMatches;
      var sizeBytes = nonNegativeNumber(pin.size_bytes);
      var vramRequiredMb = Math.round(sizeBytes / 1048576);
      var supportsMtp = pin.supports_mtp === true;
      return {
        key: key,
        tag: tag,
        displayName: String(pin.display_name || tag),
        tier: '',
        params: '',
        quant: '',
        contextLength: nonNegativeNumber(pin.default_context_window),
        sizeBytes: present ? sizeBytes : 0,
        downloadSizeMb: present ? 0 : vramRequiredMb,
        vramRequiredMb: vramRequiredMb,
        ramRequiredMb: 0,
        installed: present,
        engineVisible: true,
        ollamaOnly: false,
        engineType: 'openai-compatible',
        available: true,
        active: key === context.activeKey || serving || Boolean(installedByKey && installedByKey.get(key)?.loaded),
        preferredLocal: Boolean(context.preferredKey && key === context.preferredKey),
        recommended: true,
        reason: '',
        fitState: 'fits',
        fitRatio: fitUtils.fitRatioFor(vramRequiredMb, budgetMb, 'fits'),
        fitLabel: fitUtils.fitLabelFor('fits', vramRequiredMb, budgetMb),
        fitSource: 'catalog',
        fitConfidence: 'high',
        accelerationEligible: false,
        mtpRunnable: false,
        accelerationHeadroomMb: 0,
        managedKey: managedModelKey(tag),
        engines: {
          ollama: { available: false },
          llamaServer: { available: false, modelPath: '', drafter: false },
        },
        selectedEngine: 'ninfer',
        mtp: { eligible: supportsMtp, enabled: supportsMtp && settings.mtp !== false, headroomMb: 0 },
        serving: serving, servingPaused: paused,
        servingPort: serving ? nonNegativeNumber(manager.port) : 0,
        customBuild: 0,
        libraryGguf: false,
        ninferArtifactId: String(pin.id || ''),
        ninferSetupRunning: ninfer.settingUp === true,
        source: present ? 'installed' : 'catalog',
      };
    }).filter(Boolean);
  }

  // Row 200: the Inkling 2 Mini card served by the owner's Strata install (`source.strata`, see
  // model-library-strata.js libraryInput). No VRAM figure; a pack failure or Windows block locks it with a reason.
  function buildStrataCards(source, context, installedByKey) {
    var strata = objectOrEmpty(source.strata);
    var tag = String(strata.id || '').trim();
    if (!tag) return [];
    var key = canonicalTag(tag);
    var manager = objectOrEmpty(strata.manager);
    var aliases = (Array.isArray(strata.aliases) && strata.aliases.length ? strata.aliases : [tag]).map(managedAliasKey);
    var aliasMatches = Boolean(manager.alias) && aliases.indexOf(managedAliasKey(manager.alias)) >= 0;
    var serving = manager.state === 'ready' && aliasMatches;
    var lock = objectOrEmpty(strata.lock);
    var card = {
      key: key,
      tag: tag,
      displayName: String(strata.displayName || tag),
      tier: '',
      params: String(strata.params || ''),
      quant: String(strata.quant || ''),
      contextLength: nonNegativeNumber(strata.contextLength),
      sizeBytes: nonNegativeNumber(strata.sizeBytes),
      downloadSizeMb: 0,
      vramRequiredMb: 0,
      ramRequiredMb: 0,
      installed: true,
      engineVisible: true,
      ollamaOnly: false,
      engineType: 'openai-compatible',
      available: true,
      active: key === context.activeKey || serving || Boolean(installedByKey && installedByKey.get(key)?.loaded),
      preferredLocal: Boolean(context.preferredKey && key === context.preferredKey),
      recommended: false,
      reason: '',
      fitState: 'unknown',
      fitRatio: 0,
      fitLabel: fitUtils.fitLabelFor('unknown', 0, 0),
      fitSource: 'catalog',
      fitConfidence: 'low',
      accelerationEligible: false,
      mtpRunnable: false,
      accelerationHeadroomMb: 0,
      managedKey: managedModelKey(tag),
      engines: {
        ollama: { available: false },
        llamaServer: { available: false, modelPath: '', drafter: false },
      },
      selectedEngine: 'strata',
      mtp: { eligible: false, enabled: false, headroomMb: 0 },
      serving: serving,
      servingPaused: manager.state === 'stopped' && manager.identityRetained === true && aliasMatches,
      servingPort: serving ? nonNegativeNumber(manager.port) : 0,
      customBuild: 0,
      libraryGguf: false,
      source: 'installed',
    };
    if (lock.message) {
      card.loadFailure = { cause: 'other', message: String(lock.message), context: null, at: '', engine: 'openai-compatible', model: tag, managed: 'strata' };
    }
    return [card];
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

  // The server's alias drops ':latest', so an own-card library GGUF ("mistral") and
  // Ollama's "mistral:latest" match the same alias. When the library model is the one
  // served (or parked), a card that runs on Ollama does not claim it too.
  function disownLibraryAlias(cards) {
    ['serving', 'servingPaused'].forEach(function (field) {
      if (!cards.some(function (card) { return card.libraryGguf === true && card[field] === true; })) return;
      cards.forEach(function (card) {
        if (card.libraryGguf === true || card[field] !== true || card.selectedEngine === 'llama-server') return;
        card[field] = false;
        if (field === 'serving') card.servingPort = 0;
      });
    });
  }

  function mergeModelLibrary(input) {
    var source = objectOrEmpty(input);
    var acceleration = normalizeAcceleration(source.acceleration);
    var hardware = normalizeHardware(
      source.hardware,
      source.memory,
      acceleration.headroomMb
    );
    var split = partitionTeamModels(source.installed);
    var installedByKey = normalizeInstalledEntries(split.local);
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
      var keptIndex = cardIndexByKey.get(key);
      // Catalog twins share a pull tag; keep the sidecar's recommended twin.
      if (usedKeys.has(key) && (recommendation.recommended !== true
          || cards[keptIndex].recommended === true)) return;
      var card = buildCatalogCard(
        recommendation,
        installedByKey.get(key),
        ollamaByKey.get(key),
        context,
        fitEstimatesByKey.get(key)
      );
      if (usedKeys.has(key)) {
        cards[keptIndex] = card;
        return;
      }
      usedKeys.add(key);
      cardIndexByKey.set(key, cards.length);
      cards.push(card);
    });

    // The engine lists an installed NInfer model too; its pin card owns that
    // row (size, context, MTP) rather than a bare "Not in catalog" card.
    // The engine lists a Strata-served model too (`managed: 'strata'`); its own card owns that row.
    var ninferCards = buildNinferCards(source, context, installedByKey);
    var strataCards = buildStrataCards(source, context, installedByKey);
    var managedKeys = new Set(ninferCards.concat(strataCards).map(function (card) { return card.key; }));
    installedByKey.forEach(function (entry, key) {
      if (usedKeys.has(key) || managedKeys.has(key)) return;
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
    ninferCards.concat(strataCards).forEach(function (card) {
      if (usedKeys.has(card.key)) return;
      usedKeys.add(card.key);
      cards.push(card);
    });
    disownLibraryAlias(cards);

    // item 1: the failed card carries its failure. An exact key wins; only when no card matches
    // exactly does a canonical match (an own-card GGUF keyed without a tag or in another case)
    // apply, so a same-name Ollama card and own card never share one failure.
    var failedKey = source.loadFailure && canonicalTag(source.loadFailure.model);
    var failed = failedKey ? cards.filter(function (card) { return card.key === failedKey; }) : [];
    if (failedKey && !failed.length) failed = cards.filter(function (card) { return canonicalTag(card.key) === failedKey; });
    failed.forEach(function (card) { card.loadFailure = source.loadFailure; });
    return {
      hardware: hardware,
      catalogMeta: source.catalogMeta && typeof source.catalogMeta === 'object'
        && !Array.isArray(source.catalogMeta) ? source.catalogMeta : null,
      cards: orderModelCards(cards),
      teamModels: split.team,
    };
  }

  return {
    LOCAL_ENGINE_TYPES: LOCAL_ENGINE_TYPES,
    canonicalFamilyToken: canonicalFamilyToken,
    entryTag: entryTag,
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
    fitTone: fitUtils.fitTone,
  };
});
