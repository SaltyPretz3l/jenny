(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model-library/model-library-merge'));
    return;
  }
  root.rendererModelTuningEngineUtils = factory(root.modelLibraryMerge);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (mergeUtils) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function modelPathName(path) {
    return String(path || '').split(/[\\/]/).pop() || '';
  }

  function formatGb(mb) {
    return (Math.round(mb / 1024 * 10) / 10) + ' GB';
  }

  // The managed llama-server is ready and serving this model (alias keys match).
  function servesModel(serverStatus, modelId) {
    return serverStatus?.state === 'ready'
      && mergeUtils.managedAliasKey(serverStatus?.alias) === mergeUtils.managedAliasKey(modelId);
  }

  function deriveEngineView(input) {
    var source = input || {};
    var settings = source.engineSettings || {};
    var managed = settings?.localEngines?.openaiCompatible?.managed || {};
    var catalog = settings?.accelerationCatalog || {};
    var key = mergeUtils.managedModelKey(source.activeModelId);
    var persisted = managed?.perModel?.[key] || null;
    var tagEntries = (Array.isArray(source.localGgufs?.entries) ? source.localGgufs.entries : []).filter(function (entry) {
      return mergeUtils.managedModelKey(entry?.tag) === key && String(entry?.mainGguf || '').trim();
    });
    var family = mergeUtils.matchAccelerationFamily(source.activeModelId, {
      enabled: true,
      families: Array.isArray(catalog?.families) ? catalog.families : [],
    });
    var familyHeadroom = Number(family?.vramHeadroomMb);
    var models = Array.isArray(source.shellState?.modelList?.data) ? source.shellState.modelList.data : [];
    var draft = persisted ? {
      engine: persisted.engine,
      mtp: persisted?.mtp?.mode === 'mtp',
      modelPath: persisted.modelPath || '',
    } : {
      engine: source.engineType === 'openai-compatible' ? 'llama-server' : 'ollama',
      mtp: false,
      modelPath: '',
    };
    // The model's own llama-server build ('' runs the bundled one). Main records
    // the build number at pick time; the renderer only ever displays it.
    draft.runtimePath = persisted?.runtimePath || '';
    draft.runtimeBuild = Number(persisted?.runtimeBuild) || 0;
    // A persisted/picked path names the directory whose drafter matters: take
    // the scanned entry for THAT path, else synthesize one with no drafter,
    // else fall back to the first entry scanned for the tag.
    var ggufEntry;
    if (draft.modelPath) {
      ggufEntry = tagEntries.find(function (entry) {
        return mergeUtils.joinModelPath(entry.dir, entry.mainGguf) === draft.modelPath;
      }) || {
        dir: draft.modelPath.replace(/[\\/][^\\/]*$/, ''),
        mainGguf: modelPathName(draft.modelPath),
        drafterGguf: '',
        source: '',
        ollamaBlob: false,
      };
    } else {
      ggufEntry = tagEntries[0] || null;
    }
    var effectiveModelPath = draft.modelPath || (ggufEntry
      ? mergeUtils.joinModelPath(ggufEntry.dir, ggufEntry.mainGguf) : '');
    var ollamaFacts = source.engineHints && source.engineHints.ollama;
    return {
      key: key,
      persisted: persisted,
      ggufEntry: ggufEntry,
      eligible: mergeUtils.isEligibleFamily(family),
      familyMtp: String(family && family.mtp || ''),
      lastPickDir: String(managed.lastPickDir || ''),
      libraryRoots: Array.isArray(managed.libraryRoots) ? managed.libraryRoots.slice() : [],
      headroomMb: Number.isFinite(familyHeadroom) && familyHeadroom >= 0
        ? familyHeadroom : (Number(catalog?.defaults?.vramHeadroomMb) || 2048),
      // The library card's merged verdict wins when the caller hands it over;
      // the model-list scan is the fallback for a drawer opened elsewhere.
      ollamaAvailable: ollamaFacts
        ? ollamaFacts.available === true
        : source.engineType === 'ollama' || models.some(function (entry) {
          var id = String(entry?.id || entry?.model || entry || '').trim();
          return id === source.activeModelId
            && String(entry?.engine_type || entry?.engineType || '').toLowerCase() === 'ollama';
        }),
      // The scan can't prove Ollama lacks the model (a served llama-server alias
      // hides Ollama's copy of the same tag): only card facts may say so.
      ollamaFromScan: !ollamaFacts,
      effectiveModelPath: effectiveModelPath,
      serving: servesModel(source.serverStatus, source.activeModelId),
      runtimeBuild: draft.runtimeBuild,
      draft: draft,
      baseline: {
        engine: draft.engine, mtp: draft.mtp, modelPath: draft.modelPath,
        runtimePath: draft.runtimePath, runtimeBuild: draft.runtimeBuild,
      },
    };
  }

  // The build is a change (and is sent) only while the model runs on llama-server:
  // another file, or the saved file picked again with a different build (new
  // files copied over it; main takes a fresh pick of the saved path).
  function runtimeChanged(view, draft) {
    if (draft.engine !== 'llama-server') return false;
    var path = String(draft.runtimePath || '');
    var base = view.baseline || {};
    return path !== String(base.runtimePath || '')
      || (path !== '' && (Number(draft.runtimeBuild) || 0) !== (Number(base.runtimeBuild) || 0));
  }

  // Dirty set relative to the draft's own seed (persisted entry, else the
  // engine the model already runs on), so an untouched drawer shows no change.
  function engineDirtyFields(view, draft) {
    var base = view.baseline;
    var dirty = [];
    if (draft.engine !== base.engine) dirty.push('engine');
    if (draft.engine === 'llama-server' && draft.mtp !== base.mtp) dirty.push('mtp');
    if (draft.modelPath !== base.modelPath) dirty.push('modelPath');
    if (runtimeChanged(view, draft)) dirty.push('runtimePath');
    return dirty;
  }

  // A picked GGUF re-targets the draft AND the drafter lookup: the picked
  // directory decides whether MTP has a drafter file.
  function applyPickedGguf(view, draft, result) {
    draft.modelPath = result.path;
    view.effectiveModelPath = result.path;
    view.ggufEntry = {
      dir: String(result.dir || ''),
      mainGguf: modelPathName(result.path),
      drafterGguf: String(result.drafterGguf || ''),
      source: '',
    };
  }

  // Main refuses a pick on another machine (a UNC path); a share works once it
  // is mapped to a drive letter.
  function networkPathText() {
    return jt('models.library.networkPath', 'Jenny can\'t use network locations here. Map the share to a drive letter, then choose it from that drive.');
  }

  // llamaServer.chooseGguf fail-soft shapes: the dialog failed, or it worked
  // and the chosen file was rejected.
  function pickerFailureText(result) {
    if (result && result.reason === 'network_path') return networkPathText();
    return result && result.reason === 'not_gguf' ? jt('models.library.tuning.notGguf', 'That file is not a GGUF model.') : jt('models.library.tuning.pickerFailed', 'Could not open the file picker.');
  }

  function pickerDefaultDir(view, draft) {
    if (!view || !draft) return '';
    if (draft.modelPath) return String(draft.modelPath).replace(/[\\/][^\\/]*$/, '');
    if (view.ggufEntry && view.ggufEntry.source !== 'ollama' && view.ggufEntry.dir) {
      return String(view.ggufEntry.dir);
    }
    if (view.lastPickDir) return String(view.lastPickDir);
    if (view.libraryRoots && view.libraryRoots[0]) return String(view.libraryRoots[0]);
    return '';
  }

  // llamaServer.chooseRuntime: a pick re-targets the draft's build (Apply is the
  // commit). Cancel ({picked:false}) and failures leave the draft alone.
  function applyPickedRuntime(view, draft, result) {
    if (!draft || !result || result.ok !== true || result.picked !== true
        || typeof result.path !== 'string' || !result.path) return false;
    var build = Number(result.build);
    draft.runtimePath = result.path;
    draft.runtimeBuild = Number.isSafeInteger(build) && build > 0 ? build : 0;
    return true;
  }

  function runtimeDir(runtimePath) {
    var path = String(runtimePath || '');
    return /[\\/]/.test(path) ? path.replace(/[\\/][^\\/]*$/, '') : '';
  }

  // The build row's value: "Bundled", or the runtime's folder name plus its
  // build ("llama-prism-b10683-cuda13.3 · build 10683"); the full path is the title.
  function runtimeValueText(draft) {
    var path = String(draft && draft.runtimePath || '');
    if (!path) return jt('models.library.tuning.bundledBuild', 'Bundled');
    var folder = modelPathName(runtimeDir(path)) || path;
    var build = Number(draft.runtimeBuild);
    return Number.isSafeInteger(build) && build > 0
      ? jt('models.library.tuning.buildValue', '{folder} · build {build}', { folder: folder, build: build })
      : folder;
  }

  // llamaServer.chooseRuntime {ok:false, reason} -> status copy.
  function runtimePickerFailureText(result) {
    var reason = String(result && result.reason || '');
    if (reason === 'not_llama_server') return jt('models.library.tuning.notLlamaServer', 'That file is not a llama-server program.');
    if (reason === 'runtime_probe_failed') return jt('models.library.tuning.runtimeProbeFailed', 'That llama-server didn\'t report a build number, so Jenny can\'t use it.');
    if (reason === 'runtime_missing') return jt('models.library.tuning.runtimeGone', 'That file is no longer there.');
    if (reason === 'network_path') return networkPathText();
    return jt('models.library.tuning.pickerFailed', 'Could not open the file picker.');
  }

  function runtimePickerDefaultDir(draft) {
    return runtimeDir(draft && draft.runtimePath);
  }

  function buildManagedPatch(activeModelId, view, draft) {
    var entry = {
      engine: draft.engine,
      tag: activeModelId,
      modelPath: draft.modelPath || (draft.engine === 'llama-server' ? view.effectiveModelPath : ''),
      mtp: { mode: draft.engine === 'llama-server' && draft.mtp && view.eligible ? 'mtp' : 'off' },
    };
    // updateManagedLlamaServer REPLACES the entry, so carry the fields this
    // drawer does not edit (draftNMax) instead of resetting them.
    var persistedDraftNMax = Number(view.persisted?.mtp?.draftNMax);
    if (Number.isInteger(persistedDraftNMax) && persistedDraftNMax >= 1) entry.mtp.draftNMax = persistedDraftNMax;
    // The build goes only when it changed: an absent key keeps the saved one
    // (main's reconcile), '' clears it, and main records the build number itself.
    if (runtimeChanged(view, draft)) entry.runtimePath = String(draft.runtimePath || '');
    var perModel = {};
    perModel[view.key] = entry;
    var managed = { enabled: true, perModel: perModel };
    if (draft.modelPath) managed.lastPickDir = String(draft.modelPath).replace(/[\\/][^\\/]*$/, '');
    var request = { payload: { managed: managed }, entry: entry };
    // Never sent: the picked build is what the reply must carry back.
    var build = Number(draft.runtimeBuild);
    if (entry.runtimePath && Number.isSafeInteger(build) && build > 0) request.runtimeBuild = build;
    return request;
  }

  function returnedEntryMatches(localEngines, key, expected, expectedBuild) {
    var entry = localEngines?.openaiCompatible?.managed?.perModel?.[key];
    return Boolean(entry && entry.engine === expected.engine && entry.tag === expected.tag
      && String(entry.modelPath || '') === expected.modelPath
      && entry?.mtp?.mode === expected.mtp.mode
      // Only a build the request sent is checked; an omitted one is main's to keep.
      && (!Object.prototype.hasOwnProperty.call(expected, 'runtimePath')
        || String(entry.runtimePath || '') === String(expected.runtimePath))
      // A picked build must come back too: an echo main did not take keeps the old number.
      && (!(Number(expectedBuild) > 0) || Number(entry.runtimeBuild) === Number(expectedBuild)));
  }

  function engineStatusText(view, draft, serverStatus) {
    if (view && view.serving) {
      var statusText = jt('models.library.tuning.servingOn', 'Serving on :{port}', { port: serverStatus.port })
        + (serverStatus.accelerationMode === 'mtp' ? jt('models.library.tuning.mtpOnSuffix', ' \u00b7 MTP on') : '');
      if (!draft || !draft.mtp || serverStatus.accelerationMode === 'mtp'
          || !Object.prototype.hasOwnProperty.call(serverStatus, 'accelerationReason')) {
        return statusText;
      }
      if (serverStatus.accelerationMode === 'unknown') return statusText + jt('models.library.tuning.mtpUnknownSuffix', ' \u00b7 MTP state unknown');
      var reason = String(serverStatus.accelerationReason || '');
      if (reason === 'drafter_missing') {
        return statusText + jt('models.library.tuning.mtpNoDrafterSuffix', ' \u00b7 MTP off: no drafter file beside this model');
      }
      if (reason === 'spawn_failed') {
        return statusText + jt('models.library.tuning.mtpSpawnFailedSuffix', ' \u00b7 MTP off: the server would not start with it');
      }
      if (reason.indexOf('mtp_ineligible:') === 0) {
        return statusText + jt('models.library.tuning.mtpUnsupportedSuffix', ' \u00b7 MTP off: unsupported by this build or family');
      }
      return statusText + jt('models.library.tuning.mtpOffSuffix', ' \u00b7 MTP off');
    }
    if (draft && draft.engine === 'llama-server') return jt('models.library.tuning.startsOnUse', 'Starts when you press Use');
    return view && !view.effectiveModelPath ? jt('models.library.tuning.chooseGgufThenApply', 'Choose… the .gguf for this model, then Apply, then Use') : '';
  }

  function engineNote(view) {
    if (!view.eligible) {
      if (view.familyMtp === 'unverified') return jt('models.library.tuning.mtpFamilyUnverified', 'MTP not verified for this family yet (no separate file needed)');
      if (view.familyMtp === 'no') return jt('models.library.tuning.mtpFamilyUnsupported', 'MTP not supported for this family');
      return jt('models.library.tuning.modelUnverified', 'Not verified for this model');
    }
    if (view.ggufEntry && !view.ggufEntry.drafterGguf) {
      if (view.ggufEntry.source === 'ollama' || view.ggufEntry.ollamaBlob === true) {
        return jt('models.library.tuning.ollamaDrafterMissing', 'MTP drafter not found beside Ollama\'s copy · add its folder under GGUF folders');
      }
      return jt('models.library.tuning.drafterMissing', 'Drafter file missing · falls back to plain decoding');
    }
    return jt('models.library.tuning.mtpVramUsage', 'MTP uses about {memory} more VRAM', { memory: formatGb(view.headroomMb) });
  }

  // Tune drawer > Engine section markup (per-model engine choice + MTP + GGUF
  // picker). Pure: every dependency arrives through ctx so the drawer stays
  // the only owner of state and event wiring.
  function buildEngineSectionHtml(ctx) {
    var view = ctx.view;
    var draft = ctx.draft;
    var escapeHtml = ctx.escapeHtml;
    if (!ctx.segmentedControl || !ctx.toggleSwitch || !ctx.actionButton || !view || !draft) {
      return '<p>' + escapeHtml(jt('models.library.tuning.controlsUnavailable', 'Engine controls are unavailable.')) + '</p>';
    }
    var path = view.effectiveModelPath;
    var llamaServer = draft.engine === 'llama-server';
    var ollamaCopy = (!draft.modelPath && view.ggufEntry && view.ggufEntry.source === 'ollama')
      || /^sha256-[0-9a-f]{64}$/i.test(modelPathName(path));
    var pathLabel = ollamaCopy ? 'Ollama\'s copy' : (modelPathName(path) || jt('models.library.tuning.notFoundForTag', 'Not found for this tag'));
    var chooseGgufText = jt('models.library.tuning.chooseGgufAria', 'Choose a GGUF file');
    return '<section class="model-tuning-section model-tuning-engine" data-model-tuning-engine>'
      + '<h4 class="model-tuning-section-title">Engine</h4>'
      + '<p class="model-tuning-section-hint">' + escapeHtml(view.ollamaAvailable || view.ollamaFromScan
        ? jt('models.library.tuning.engineHint', 'Ollama or Jenny\'s own llama-server. llama-server can speed up verified models with multi-token prediction.')
        : jt('models.library.tuning.engineHintNoOllama', 'Ollama doesn\'t have this model, so it runs on Jenny\'s own llama-server.')) + '</p>'
      + '<div class="model-tuning-row" data-model-tuning-row="engine">'
      + '<span class="model-tuning-row-label">' + escapeHtml(jt('models.library.tuning.runWith', 'Run with')) + '</span>'
      + '<div class="model-tuning-row-control">'
      + ctx.segmentedControl({
        id: 'modelTuningEngine',
        ariaLabel: jt('models.library.tuning.engineLabel', 'Inference engine'),
        value: draft.engine,
        options: [
          { value: 'ollama', label: 'Ollama', disabled: !view.ollamaAvailable },
          { value: 'llama-server', label: 'llama-server', disabled: !path && draft.engine !== 'llama-server' },
        ],
        disabled: ctx.pending,
        dataset: { 'model-tuning-field': 'engine' },
      })
      + '</div>'
      + '<span class="model-tuning-row-range" data-dirty="false">' + escapeHtml(ctx.statusText) + '</span>'
      + '</div>'
      + '<div class="model-tuning-row model-tuning-row--mtp" data-model-tuning-row="mtp"' + (llamaServer ? '' : ' hidden') + '>'
      + '<span class="model-tuning-row-label"></span>'
      + '<div class="model-tuning-row-control">'
      + ctx.toggleSwitch({
        id: 'modelTuningMtp',
        label: jt('models.library.tuning.mtpLabel', 'Multi-token prediction'),
        checked: Boolean(draft.mtp && view.eligible),
        disabled: ctx.pending || !view.eligible,
      })
      + '</div>'
      + '<span class="model-tuning-row-range" data-dirty="false">' + escapeHtml(engineNote(view)) + '</span>'
      + '</div>'
      + '<div class="model-tuning-row model-tuning-row--gguf" data-model-tuning-row="modelPath">'
      + '<span class="model-tuning-row-label">' + escapeHtml(jt('models.library.tuning.ggufFile', 'GGUF file')) + '</span>'
      + '<div class="model-tuning-row-control">'
      + '<code class="model-tuning-gguf-path" data-model-tuning-gguf title="' + escapeHtml(path) + '">'
      + escapeHtml(pathLabel) + '</code>'
      + '</div>'
      + ctx.actionButton({ id: 'choose-model-gguf', label: jt('models.library.tuning.choose', 'Choose…'), ariaLabel: chooseGgufText, title: chooseGgufText, variant: 'ghost', size: 'sm', disabled: ctx.pending })
      + '</div>'
      + buildRuntimeRowHtml(ctx)
      + '</section>';
  }

  // actionButton has no `hidden` option: the attribute goes on the button's own tag.
  function hiddenButtonHtml(html) {
    return String(html).replace(/^<(\w+)/, '<$1 hidden');
  }

  // Tune drawer > Engine > "llama-server build", under GGUF file with the same
  // row grammar; only when the bridge can pick a build. "Use bundled" is always
  // rendered (hidden while unused) so a pick can toggle it without a re-render.
  function buildRuntimeRowHtml(ctx) {
    var draft = ctx && ctx.draft;
    if (!ctx || ctx.runtimeRowAvailable !== true || !draft || typeof ctx.actionButton !== 'function') return '';
    var escapeHtml = ctx.escapeHtml;
    var path = String(draft.runtimePath || '');
    var chooseBuildText = jt('models.library.tuning.chooseBuildAria', 'Choose a llama-server build');
    var useBundled = ctx.actionButton({ id: 'use-bundled-llama-server', label: jt('models.library.tuning.useBundled', 'Use bundled'), variant: 'ghost', size: 'sm', disabled: ctx.pending });
    return '<div class="model-tuning-row model-tuning-row--gguf" data-model-tuning-row="runtimePath"'
      + (draft.engine === 'llama-server' ? '' : ' hidden') + '>'
      + '<span class="model-tuning-row-label">' + escapeHtml(jt('models.library.tuning.llamaServerBuild', 'llama-server build')) + '</span>'
      + '<div class="model-tuning-row-control">'
      + '<code class="model-tuning-gguf-path" data-model-tuning-runtime title="' + escapeHtml(path) + '">'
      + escapeHtml(runtimeValueText(draft)) + '</code>'
      + '</div>'
      + '<div class="model-tuning-row-actions">'
      + ctx.actionButton({ id: 'choose-llama-server-runtime', label: jt('models.library.tuning.choose', 'Choose…'), ariaLabel: chooseBuildText, title: chooseBuildText, variant: 'ghost', size: 'sm', disabled: ctx.pending })
      + (path ? useBundled : hiddenButtonHtml(useBundled))
      + '</div>'
      + '</div>';
  }

  // Status line after the drawer applies a patch. Preflight warnings refine
  // the 'applied' copy; the null-prototype map keeps 'constructor' & co. inert.
  var APPLY_STATUS_COPY = Object.assign(Object.create(null), {
    rolled_back: jt('models.library.tuning.runtimeRejected', 'The runtime rejected the change. Previous settings were restored.'),
    degraded: jt('models.library.tuning.rollbackUnconfirmed', 'The runtime could not confirm rollback. Check Diagnostics before sending.'),
    hardware_fit_unverified: jt('models.library.tuning.hardwareFitUnverified', 'Applied. Ollama reports this native context limit, but Jenny could not independently verify RAM or VRAM fit.'),
    hardware_fit_estimated: jt('models.library.tuning.hardwareFitEstimated', 'Applied. Fit estimated from model size and your hardware; not yet measured on this machine.'),
  });

  function applyStatusMessage(result) {
    var status = String((result && result.status) || '');
    if (status === 'applied') {
      var warning = String((result && result.preflight && result.preflight.warning) || '');
      return APPLY_STATUS_COPY[warning] || jt('models.library.tuning.appliedAcknowledged', 'Applied. The runtime acknowledged this model profile.');
    }
    return APPLY_STATUS_COPY[status]
      || jt('models.library.tuning.notApplied', 'Not applied: {reason}.', { reason: String((result && result.reason) || 'validation failed').replaceAll('_', ' ') });
  }

  return {
    applyPickedGguf: applyPickedGguf,
    applyPickedRuntime: applyPickedRuntime,
    applyStatusMessage: applyStatusMessage,
    buildEngineSectionHtml: buildEngineSectionHtml,
    buildRuntimeRowHtml: buildRuntimeRowHtml,
    deriveEngineView: deriveEngineView,
    engineDirtyFields: engineDirtyFields,
    engineNote: engineNote,
    engineStatusText: engineStatusText,
    pickerDefaultDir: pickerDefaultDir,
    pickerFailureText: pickerFailureText,
    buildManagedPatch: buildManagedPatch,
    formatGb: formatGb,
    modelPathName: modelPathName,
    returnedEntryMatches: returnedEntryMatches,
    runtimePickerDefaultDir: runtimePickerDefaultDir,
    runtimePickerFailureText: runtimePickerFailureText,
    runtimeValueText: runtimeValueText,
    servesModel: servesModel,
  };
});
