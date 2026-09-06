/**
 * Converts a decorated Markdown fragment into independently patchable units.
 * Exact HTML is retained so a hash collision can never suppress a DOM update.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownStreamUnits = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fingerprintHtml(value) {
    const source = String(value || '');
    let hash = 5381;
    for (let index = 0; index < source.length; index += 1) {
      hash = ((hash << 5) + hash) + source.charCodeAt(index);
      hash >>>= 0;
    }
    return `unit_${source.length}_${hash.toString(16)}`;
  }

  function toRevealUnit(node, escapeHtml) {
    if (!node) return null;
    if (node.nodeType === 3) {
      const text = String(node.textContent || '');
      if (!text.trim()) return null;
      const html = typeof escapeHtml === 'function' ? escapeHtml(text) : text;
      const fingerprint = fingerprintHtml(html);
      return { html, fingerprint, sourceHtml: html, sourceFingerprint: fingerprint };
    }
    if (node.nodeType !== 1) return null;
    const html = String(node.outerHTML || '').trim();
    if (!html) return null;
    const fingerprint = fingerprintHtml(html);
    return { html, fingerprint, sourceHtml: html, sourceFingerprint: fingerprint };
  }

  function normalizePreviousUnit(value) {
    if (value && typeof value === 'object') {
      return {
        fingerprint: String(value.sourceFingerprint || value.fingerprint || ''),
        html: typeof value.sourceHtml === 'string'
          ? value.sourceHtml
          : (typeof value.html === 'string' ? value.html : null),
      };
    }
    return { fingerprint: String(value || ''), html: null };
  }

  function findChangedStartIndex(previousUnits, nextUnits) {
    const previous = Array.isArray(previousUnits) ? previousUnits : [];
    const next = Array.isArray(nextUnits) ? nextUnits : [];
    const sharedLength = Math.min(previous.length, next.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const prior = normalizePreviousUnit(previous[index]);
      const current = normalizePreviousUnit(next[index]);
      if (prior.fingerprint !== current.fingerprint) return index;
      if (prior.html !== null && current.html !== null && prior.html !== current.html) return index;
    }
    return previous.length === next.length ? -1 : sharedLength;
  }

  function buildModel(nodes, html, previousUnits, escapeHtml) {
    const units = Array.from(nodes || [])
      .map((node) => toRevealUnit(node, escapeHtml))
      .filter(Boolean);
    return {
      html: String(html || ''),
      units,
      fingerprints: units.map((unit) => unit.fingerprint),
      changedStartIndex: findChangedStartIndex(previousUnits, units),
    };
  }

  return {
    fingerprintHtml,
    toRevealUnit,
    findChangedStartIndex,
    buildModel,
  };
});
