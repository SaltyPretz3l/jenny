/* renderer/shared/model-load-failure.js
 *
 * One reading of a classified model-load failure for every surface that
 * tells it (library row, composer chip and line, Diagnostics). The facts come
 * from Electron's lifecycle (`state.backend.model_lifecycle.failure`, carried
 * only in the `model_unavailable` phase); this module turns them into plain
 * words and the one recovery that matches the cause. No DOM, no state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.jennyModelLoadFailure = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t)
    || globalThis.jennyI18nFallback
    || function (key, fallback, params) {
      return params
        ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => (
          Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
        : fallback;
    };

  const CAUSES = new Set(['out_of_memory', 'engine_unreachable', 'timeout', 'other']);
  const SMALLER_CONTEXT = 8192;
  // The Tune steps below an attempted window; the retry picks the first one under it.
  const CONTEXT_STEPS = [4096, 8192, 16384, 32768, 65536, 131072];

  function readModelLoadFailure(backend) {
    if (!backend || typeof backend !== 'object' || backend.phase !== 'model_unavailable') return null;
    const failure = backend.model_lifecycle?.failure;
    if (!failure || typeof failure !== 'object' || !CAUSES.has(failure.cause)) return null;
    const model = String(failure.model || backend.model_lifecycle?.requested_model || '').trim();
    if (!model) return null;
    return {
      cause: failure.cause,
      message: String(failure.message || '').trim(),
      context: Number.isSafeInteger(failure.context) && failure.context > 0 ? failure.context : null,
      at: typeof failure.at === 'string' ? failure.at : '',
      engine: String(failure.engine || backend.model_lifecycle?.engine || '').trim(),
      model,
    };
  }

  function engineLabel(engine) {
    const key = String(engine || '').trim().toLowerCase();
    if (key === 'ollama') return 'Ollama';
    if (key === 'openai-compatible') return 'llama-server';
    return key || jt('loadFailure.engineGeneric', 'The engine');
  }

  // The context the memory retry loads at: the Tune step under the attempted
  // window, or 8K when the attempt is unknown or already small.
  function retryContext(failure) {
    const attempted = failure?.context;
    if (!attempted) return SMALLER_CONTEXT;
    const below = CONTEXT_STEPS.filter((step) => step < attempted);
    return below.length ? below[below.length - 1] : SMALLER_CONTEXT;
  }

  // Plain words, as a sentence (library note, Diagnostics reason).
  function causeSentence(failure) {
    const engine = engineLabel(failure?.engine);
    switch (failure?.cause) {
      case 'out_of_memory':
        return jt('loadFailure.cause.outOfMemory', 'Not enough memory to load it. A smaller context needs less.');
      case 'engine_unreachable':
        return jt('loadFailure.cause.engineUnreachable', "{engine} isn't responding.", { engine });
      case 'timeout':
        return jt('loadFailure.cause.timeout', 'Loading took too long and was stopped.');
      default:
        return failure?.message
          ? jt('loadFailure.cause.other', '{engine}: {message}', { engine, message: failure.message })
          : jt('loadFailure.cause.unknown', '{engine} could not load it.', { engine });
    }
  }

  // The same cause as a short phrase (the composer line: "qwen3:8b didn't load · not enough memory").
  function causePhrase(failure) {
    const engine = engineLabel(failure?.engine);
    switch (failure?.cause) {
      case 'out_of_memory': return jt('loadFailure.phrase.outOfMemory', 'not enough memory');
      case 'engine_unreachable': return jt('loadFailure.phrase.engineUnreachable', "{engine} isn't responding", { engine });
      case 'timeout': return jt('loadFailure.phrase.timeout', 'loading took too long');
      default: return failure?.message || jt('loadFailure.phrase.unknown', 'the engine refused it');
    }
  }

  // The recovery that matches the cause, in display order. Ids are the library
  // row actions; the composer line shows the first one and "Other models".
  function recoveryActions(failure) {
    switch (failure?.cause) {
      case 'out_of_memory':
        // An attempt at or under the lowest Tune step has no smaller window to offer.
        return failure.context && failure.context <= CONTEXT_STEPS[0] ? ['showFits'] : ['loadSmaller', 'showFits'];
      case 'engine_unreachable': return ['diagnostics', 'retry'];
      case 'timeout': return ['retry'];
      default: return ['retry', 'copyDetails'];
    }
  }

  // What "Copy details" puts on the clipboard: the facts, one per line.
  function failureDetails(failure) {
    return ['model', 'engine', 'cause', 'context', 'at', 'message']
      .filter((key) => failure && failure[key])
      .map((key) => `${key}: ${failure[key]}`)
      .join('\n');
  }

  return {
    CAUSES,
    causePhrase,
    causeSentence,
    engineLabel,
    failureDetails,
    readModelLoadFailure,
    recoveryActions,
    retryContext,
  };
});
