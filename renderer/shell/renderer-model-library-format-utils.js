/* Pure formatting and identity helpers for the Model Library. Split out of
 * the former renderer-model-library.js (retired 2026-09-21), which sat at the 1015-line cap:
 * these helpers have no state, no DOM, and no dependency on the controller, so
 * they are the cohesive block to move rather than shrinking new feature code. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererModelLibraryFormatUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function formatHumanSize(bytes) {
    var n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) {
      return '';
    }
    if (n >= 1024 * 1024 * 1024) {
      return (Math.round((n / (1024 * 1024 * 1024)) * 10) / 10) + ' GB';
    }
    if (n >= 1024 * 1024) {
      return (Math.round((n / (1024 * 1024)) * 10) / 10) + ' MB';
    }
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function formatBytesShort(bytes) {
    var n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) {
      return '';
    }
    if (n >= 1024 * 1024 * 1024) {
      return (Math.round((n / (1024 * 1024 * 1024)) * 10) / 10) + 'GB';
    }
    if (n >= 1024 * 1024) {
      return (Math.round((n / (1024 * 1024)) * 10) / 10) + 'MB';
    }
    return Math.max(1, Math.round(n / 1024)) + 'KB';
  }

  // Ollama treats tags case-insensitively and a bare name as `:latest`, so the
  // loaded model ("gemma3") and its list id ("gemma3:latest") must compare
  // equal — the in-use guard is defeatable otherwise. Mirrors the IPC-handler
  // guard's canonicalization (ipc-handler-registration.js models.delete).
  function canonicalOllamaTag(value) {
    var tag = String(value || '').trim().toLowerCase();
    if (!tag) {
      return '';
    }
    var lastSegment = tag.slice(tag.lastIndexOf('/') + 1);
    return lastSegment.indexOf(':') === -1 ? tag + ':latest' : tag;
  }

  function boundedErrorMessage(error, fallback) {
    var message = String(error && error.message ? error.message : error || '').trim();
    if (!message) return fallback;
    return message
      .replace(/\b[A-Za-z]:\\[^\s]+/g, '[local path]')
      .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
      .slice(0, 240);
  }

  // Managed llama-server launch codes -> copy that names the fix, for the card
  // after a failed Use and the Tune drawer after a failed restart. Reads the RAW
  // message (before boundedErrorMessage); null for anything else. A missing
  // build's token is only main's own: the build tag it derived from the folder
  // (b\d{3,9}) or 'runtime'; whatever trails it never reaches the copy.
  function llamaServerFailureText(message, modelId) {
    var text = String(message == null ? '' : message);
    var model = String(modelId == null ? '' : modelId);
    var missing = /\bllama_server_runtime_missing:(b\d{3,9}|runtime)\b/.exec(text);
    if (missing) {
      return missing[1] === 'runtime'
        ? jt('models.library.runtime.buildMissingUnnamed', 'Could not start {model}: its llama-server build is missing. Choose a build in Tune.', { model: model })
        : jt('models.library.runtime.buildMissing', 'Could not start {model}: its llama-server build ({folder}) is missing. Choose a build in Tune.', { model: model, folder: missing[1] });
    }
    var unsupported = /\bllama_server_model_unsupported:(bundled|custom)\b/.exec(text);
    if (!unsupported) return null;
    return unsupported[1] === 'bundled'
      ? jt('models.library.runtime.bundledCantRead', 'Could not start {model}: the bundled llama-server can\'t read this file\'s format. Choose a build that can in Tune.', { model: model })
      : jt('models.library.runtime.buildCantRead', 'Could not start {model}: its llama-server build can\'t read this file\'s format. Choose a build that can in Tune.', { model: model });
  }

  return {
    formatHumanSize: formatHumanSize,
    formatBytesShort: formatBytesShort,
    canonicalOllamaTag: canonicalOllamaTag,
    boundedErrorMessage: boundedErrorMessage,
    llamaServerFailureText: llamaServerFailureText,
  };
});
