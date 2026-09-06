(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./model-library/model-library-merge'));
    return;
  }
  root.rendererModelTuningEngineUtils = factory(root.modelLibraryMerge);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (mergeUtils) {
  'use strict';

  function modelPathName(path) {
    return String(path || '').split(/[\\/]/).pop() || '';
  }

  function formatGb(mb) {
    return (Math.round(mb / 1024 * 10) / 10) + ' GB';
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
      ollamaAvailable: source.engineHints && source.engineHints.ollama
        ? source.engineHints.ollama.available === true
        : source.engineType === 'ollama' || models.some(function (entry) {
          var id = String(entry?.id || entry?.model || entry || '').trim();
          return id === source.activeModelId
            && String(entry?.engine_type || entry?.engineType || '').toLowerCase() === 'ollama';
        }),
      effectiveModelPath: effectiveModelPath,
      serving: source.serverStatus?.state === 'ready'
        && mergeUtils.managedAliasKey(source.serverStatus?.alias)
          === mergeUtils.managedAliasKey(source.activeModelId),
      draft: draft,
      baseline: { engine: draft.engine, mtp: draft.mtp, modelPath: draft.modelPath },
    };
  }

  // Dirty set relative to the draft's own seed (persisted entry, else the
  // engine the model already runs on), so an untouched drawer shows no change.
  function engineDirtyFields(view, draft) {
    var base = view.baseline;
    var dirty = [];
    if (draft.engine !== base.engine) dirty.push('engine');
    if (draft.engine === 'llama-server' && draft.mtp !== base.mtp) dirty.push('mtp');
    if (draft.modelPath !== base.modelPath) dirty.push('modelPath');
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

  // llamaServer.chooseGguf fail-soft shapes: the dialog failed, or it worked
  // and the chosen file was rejected.
  function pickerFailureText(result) {
    return result && result.reason === 'not_gguf' ? 'That file is not a GGUF model.' : 'Could not open the file picker.';
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
    var perModel = {};
    perModel[view.key] = entry;
    var managed = { enabled: true, perModel: perModel };
    if (draft.modelPath) managed.lastPickDir = String(draft.modelPath).replace(/[\\/][^\\/]*$/, '');
    return { payload: { managed: managed }, entry: entry };
  }

  function returnedEntryMatches(localEngines, key, expected) {
    var entry = localEngines?.openaiCompatible?.managed?.perModel?.[key];
    return Boolean(entry && entry.engine === expected.engine && entry.tag === expected.tag
      && String(entry.modelPath || '') === expected.modelPath
      && entry?.mtp?.mode === expected.mtp.mode);
  }

  function engineStatusText(view, draft, serverStatus) {
    if (view && view.serving) {
      var statusText = 'Serving on :' + serverStatus.port
        + (serverStatus.accelerationMode === 'mtp' ? ' \u00b7 MTP on' : '');
      if (!draft || !draft.mtp || serverStatus.accelerationMode === 'mtp'
          || !Object.prototype.hasOwnProperty.call(serverStatus, 'accelerationReason')) {
        return statusText;
      }
      if (serverStatus.accelerationMode === 'unknown') return statusText + ' \u00b7 MTP state unknown';
      var reason = String(serverStatus.accelerationReason || '');
      if (reason === 'drafter_missing') {
        return statusText + ' \u00b7 MTP off: no drafter file beside this model';
      }
      if (reason === 'spawn_failed') {
        return statusText + ' \u00b7 MTP off: the server would not start with it';
      }
      if (reason.indexOf('mtp_ineligible:') === 0) {
        return statusText + ' \u00b7 MTP off: unsupported by this build or family';
      }
      return statusText + ' \u00b7 MTP off';
    }
    if (draft && draft.engine === 'llama-server') return 'Starts when you press Use';
    return view && !view.effectiveModelPath ? 'Choose… the .gguf for this model, then Apply, then Use' : '';
  }

  function engineNote(view) {
    if (!view.eligible) {
      if (view.familyMtp === 'unverified') return 'MTP not verified for this family yet (no separate file needed)';
      if (view.familyMtp === 'no') return 'MTP not supported for this family';
      return 'Not verified for this model';
    }
    if (view.ggufEntry && !view.ggufEntry.drafterGguf) {
      if (view.ggufEntry.source === 'ollama' || view.ggufEntry.ollamaBlob === true) {
        return 'MTP drafter not found beside Ollama\'s copy · add its folder under GGUF folders';
      }
      return 'Drafter file missing · falls back to plain decoding';
    }
    return 'MTP uses about ' + formatGb(view.headroomMb) + ' more VRAM';
  }

  // Tune drawer > Engine section markup (per-model engine choice + MTP + GGUF
  // picker). Pure: every dependency arrives through ctx so the drawer stays
  // the only owner of state and event wiring.
  function buildEngineSectionHtml(ctx) {
    var view = ctx.view;
    var draft = ctx.draft;
    var escapeHtml = ctx.escapeHtml;
    if (!ctx.segmentedControl || !ctx.toggleSwitch || !ctx.actionButton || !view || !draft) {
      return '<p>Engine controls are unavailable.</p>';
    }
    var path = view.effectiveModelPath;
    var llamaServer = draft.engine === 'llama-server';
    var ollamaCopy = (!draft.modelPath && view.ggufEntry && view.ggufEntry.source === 'ollama')
      || /^sha256-[0-9a-f]{64}$/i.test(modelPathName(path));
    var pathLabel = ollamaCopy ? 'Ollama\'s copy' : (modelPathName(path) || 'Not found for this tag');
    return '<section class="model-tuning-section model-tuning-engine" data-model-tuning-engine>'
      + '<h4 class="model-tuning-section-title">Engine</h4>'
      + '<p class="model-tuning-section-hint">Ollama or Jenny\'s own llama-server. llama-server can speed up verified models with multi-token prediction.</p>'
      + '<div class="model-tuning-row" data-model-tuning-row="engine">'
      + '<span class="model-tuning-row-label">Run with</span>'
      + '<div class="model-tuning-row-control">'
      + ctx.segmentedControl({
        id: 'modelTuningEngine',
        ariaLabel: 'Inference engine',
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
        label: 'Multi-token prediction',
        checked: Boolean(draft.mtp && view.eligible),
        disabled: ctx.pending || !view.eligible,
      })
      + '</div>'
      + '<span class="model-tuning-row-range" data-dirty="false">' + escapeHtml(engineNote(view)) + '</span>'
      + '</div>'
      + '<div class="model-tuning-row model-tuning-row--gguf" data-model-tuning-row="modelPath">'
      + '<span class="model-tuning-row-label">GGUF file</span>'
      + '<div class="model-tuning-row-control">'
      + '<code class="model-tuning-gguf-path" data-model-tuning-gguf title="' + escapeHtml(path) + '">'
      + escapeHtml(pathLabel) + '</code>'
      + '</div>'
      + ctx.actionButton({ id: 'choose-model-gguf', label: 'Choose…', variant: 'ghost', size: 'sm', disabled: ctx.pending })
      + '</div>'
      + '</section>';
  }

  // Status line after the drawer applies a patch. Preflight warnings refine
  // the 'applied' copy; the null-prototype map keeps 'constructor' & co. inert.
  var APPLY_STATUS_COPY = Object.assign(Object.create(null), {
    rolled_back: 'The runtime rejected the change. Previous settings were restored.',
    degraded: 'The runtime could not confirm rollback. Check Diagnostics before sending.',
    hardware_fit_unverified: 'Applied. Ollama reports this native context limit, but Jenny could not independently verify RAM or VRAM fit.',
    hardware_fit_estimated: 'Applied. Fit estimated from model size and your hardware; not yet measured on this machine.',
  });

  function applyStatusMessage(result) {
    var status = String((result && result.status) || '');
    if (status === 'applied') {
      var warning = String((result && result.preflight && result.preflight.warning) || '');
      return APPLY_STATUS_COPY[warning] || 'Applied. The runtime acknowledged this model profile.';
    }
    return APPLY_STATUS_COPY[status]
      || 'Not applied: ' + String((result && result.reason) || 'validation failed').replaceAll('_', ' ') + '.';
  }

  return {
    applyPickedGguf: applyPickedGguf,
    applyStatusMessage: applyStatusMessage,
    buildEngineSectionHtml: buildEngineSectionHtml,
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
  };
});
