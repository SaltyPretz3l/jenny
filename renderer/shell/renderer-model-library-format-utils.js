/* Pure formatting and identity helpers for the Model Library. Split out of
 * renderer-model-library.js, which sat exactly at the 1015-line file-size cap:
 * these four have no state, no DOM, and no dependency on the controller, so
 * they are the cohesive block to move rather than shrinking new feature code. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererModelLibraryFormatUtils = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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

  return {
    formatHumanSize: formatHumanSize,
    formatBytesShort: formatBytesShort,
    canonicalOllamaTag: canonicalOllamaTag,
    boundedErrorMessage: boundedErrorMessage,
  };
});
