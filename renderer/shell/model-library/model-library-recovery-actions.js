/* Recovery clicks for the library's classified model-load failure. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../shared/model-load-failure'), require('../renderer-model-library-format-utils'));
    return;
  }
  root.rendererModelLibraryRecoveryActions = factory(root.jennyModelLoadFailure, root.rendererModelLibraryFormatUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (defaultReader, formatUtils) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function tuningWording(result) {
    var utils = globalThis.rendererModelTuningEngineUtils
      || (typeof require === 'function' ? require('../renderer-model-tuning-engine-utils') : null);
    return typeof utils?.applyStatusMessage === 'function' ? utils.applyStatusMessage(result) : '';
  }

  function createModelLibraryRecoveryActions(deps) {
    var d = deps || {};
    var reader = d.reader || defaultReader;
    var inFlight = false;

    function controlsUnavailable() {
      d.setStatusMessage(jt('models.library.runtime.controlsUnavailable', 'Model lifecycle controls are unavailable right now.'));
    }

    async function handle(action, tag) {
      var failure = reader.readModelLoadFailure(d.state.backend);
      if (!failure || formatUtils.canonicalOllamaTag(failure.model) !== formatUtils.canonicalOllamaTag(tag)) return;
      switch (action) {
        case 'retry': return d.runtimeActions.handleUse(tag);
        case 'showFits': return d.setFilter('recommended');
        case 'diagnostics': return d.openDiagnostics?.();
        case 'loadSmaller': {
          var tuning = d.windowRef.jennyShell?.modelTuning;
          if (typeof tuning?.update !== 'function') return controlsUnavailable();
          if (inFlight) return;
          inFlight = true;
          try {
            var result = await tuning.update({ modelId: tag, contextLength: reader.retryContext(failure) });
            // A refused or rolled-back change reads as the Tune drawer would say it.
            if (result?.status !== 'applied') return d.setStatusMessage(tuningWording(result) || jt('models.library.tuning.notApplied', 'Not applied: {reason}.', { reason: String(result?.reason || 'validation failed').replaceAll('_', ' ') }));
            return d.runtimeActions.handleUse(tag);
          } catch (error) {
            return d.setStatusMessage(formatUtils.boundedErrorMessage(error, jt('models.library.runtime.controlsUnavailable', 'Model lifecycle controls are unavailable right now.')));
          } finally { inFlight = false; }
        }
        case 'copyDetails': {
          var clipboard = d.windowRef.navigator?.clipboard;
          if (typeof clipboard?.writeText !== 'function') {
            d.setStatusMessage(jt('settings.modelLibrary.clipboardUnavailable', 'Clipboard access is unavailable right now.'));
            return;
          }
          try {
            await clipboard.writeText(reader.failureDetails(failure));
            d.setStatusMessage('Copied ' + tag);
          } catch (_error) {
            d.setStatusMessage(jt('settings.modelLibrary.copyFailed', 'Could not copy {tag} to the clipboard.', { tag: tag }));
          }
          return;
        }
        default: return;
      }
    }
    return { handle: handle };
  }
  return { createModelLibraryRecoveryActions: createModelLibraryRecoveryActions };
});
