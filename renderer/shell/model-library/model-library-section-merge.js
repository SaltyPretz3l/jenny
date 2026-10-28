/* Model Library section › merge inputs: the flag readers, the state the card
 * grid depends on (its signature), and the merged card list built from the
 * loaded sources. The section owns the loaded sources; this helper owns the
 * signature of the state its last merge read. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.modelLibrarySectionMerge = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // deps: { state, windowRef, sourcesModule, mergeModule, loadFailureReader,
  //   getSourceData(), getEngineBlocks() }
  function createModelLibrarySectionMerge(deps) {
    var d = deps || {};
    var state = d.state || {};
    var windowRef = d.windowRef;
    var sourcesModule = d.sourcesModule;
    var mergeModule = d.mergeModule;
    var loadFailureReader = d.loadFailureReader;
    var contextSignature = '';

    function activeModel() {
      return String(state && state.status && state.status.model || '').trim();
    }

    function preferredLocalModel() {
      return String(state && state.offline && state.offline.preferredLocalModel || '').trim();
    }

    function accelerationFlagEnabled() {
      return state.features?.featureFlags?.llama_server_acceleration === true;
    }

    // The Image engine section follows the image_generate tool's kill switch.
    function imageEngineFlagEnabled() {
      return state.features?.featureFlags?.tools_image_generate_enabled === true;
    }

    // The NInfer block (row 54) follows its own kill switch; an ineligible GPU renders nothing.
    function ninferFlagEnabled() { return state.features?.featureFlags?.ninfer === true; }
    function ninferLibraryInput() { return d.getEngineBlocks()?.ninfer()?.libraryInput() || null; }

    function mergeSignature() {
      return [
        activeModel(),
        preferredLocalModel(),
        JSON.stringify(loadFailureReader.readModelLoadFailure(state.backend)),
        JSON.stringify(state.localEngines?.openaiCompatible?.managed || null),
        Boolean(state.accelerationCatalog),
        JSON.stringify(ninferLibraryInput()),
      ].join('\n');
    }

    // True when the state the last merge read has not changed since.
    function signatureUnchanged() {
      return mergeSignature() === contextSignature;
    }

    // GGUFs added to the library are cards of their own (flag on only). One
    // keyed apart (its name would share another model's card) takes its
    // served alias along, and is the active or default model by its exact tag
    // only, which the canonical match would pin on the other card.
    function libraryView(sourceData, managed) {
      var active = activeModel();
      var preferred = preferredLocalModel();
      if (!accelerationFlagEnabled()) return { installed: sourceData.installed, active: active, preferred: preferred };
      var rows = sourcesModule.projectLibraryGgufs({
        managed: managed,
        localGgufs: sourceData.localGgufs || [],
        ollamaTags: sourceData.ollamaTags,
        installed: sourceData.installed,
        recommendations: sourceData.recommendations,
      });
      var own = rows.filter(function (row) { return row.ownCardKey; }).map(function (row) { return row.id; });
      rows.forEach(function (row) { if (row.ownCardKey && row.id === active) row.loaded = true; });
      return {
        installed: sourceData.installed.filter(function (row) {
          return row.engine_type === 'ollama' || own.indexOf(String(row.id || '').toLowerCase()) < 0;
        }).concat(rows),
        active: own.indexOf(active) < 0 ? active : '',
        preferred: own.indexOf(preferred) < 0 ? preferred : '',
      };
    }

    function buildMerged() {
      var sourceData = d.getSourceData();
      if (!sourceData) return null;
      contextSignature = mergeSignature();
      var managed = state.localEngines?.openaiCompatible?.managed || null;
      var library = libraryView(sourceData, managed);
      var result = mergeModule.mergeModelLibrary({
        installed: library.installed,
        ollamaTags: sourceData.ollamaTags,
        recommendations: sourceData.recommendations,
        fitEstimates: sourceData.fitEstimates,
        hardware: sourceData.hardware,
        memory: sourceData.memory,
        catalogMeta: sourceData.catalogMeta,
        activeModel: library.active,
        loadFailure: loadFailureReader.readModelLoadFailure(state.backend),
        preferredLocalModel: library.preferred,
        // Kill switch: with the flag off none of the per-model engine inputs are
        // projected (no engine or Serving pills), so the library renders exactly
        // as it did before W4.
        managed: accelerationFlagEnabled() ? managed : null,
        localGgufs: accelerationFlagEnabled() ? (sourceData.localGgufs || []) : [],
        llamaServer: accelerationFlagEnabled() ? (sourceData.llamaServer || null) : null,
        acceleration: {
          enabled: accelerationFlagEnabled() && Boolean(state.accelerationCatalog),
          headroomMb: Number(state.accelerationCatalog?.defaults?.vramHeadroomMb) || 2048,
          families: state.accelerationCatalog?.families || [],
        },
        ninfer: ninferLibraryInput(),
      });
      // The pull-recommendation an empty chat offers is an Ollama tag; an NInfer row downloads through its block.
      var recommended = result.cards.find(function (card) { return card.recommended === true && card.fitState === 'fits' && card.installed !== true && card.selectedEngine !== 'ninfer'; });
      var previousTag = state.modelRecommendation?.tag;
      state.modelRecommendation = recommended ? { tag: recommended.tag, downloadSizeMb: recommended.downloadSizeMb } : null;
      if (previousTag !== state.modelRecommendation?.tag) windowRef.dispatchEvent(new windowRef.CustomEvent('jenny:model-state-changed'));
      return result;
    }

    return {
      activeModel: activeModel,
      preferredLocalModel: preferredLocalModel,
      accelerationFlagEnabled: accelerationFlagEnabled,
      imageEngineFlagEnabled: imageEngineFlagEnabled,
      ninferFlagEnabled: ninferFlagEnabled,
      ninferLibraryInput: ninferLibraryInput,
      signatureUnchanged: signatureUnchanged,
      buildMerged: buildMerged,
    };
  }

  return { createModelLibrarySectionMerge: createModelLibrarySectionMerge };
});
