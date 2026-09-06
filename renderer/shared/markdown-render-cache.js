/**
 * Bounded cache for sanitized, undecorated Markdown HTML (UMD).
 * Decoration stays outside the cache so generated DOM ids remain unique.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownRenderCache = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_ENTRIES = 200;
  // Keys duplicate the full Markdown source and values retain sanitized HTML;
  // 16 MiB keeps useful short-message reuse without letting 200 large renders
  // become an unbounded renderer-heap multiplier.
  const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

  function buildKey(parts) {
    return JSON.stringify(Array.isArray(parts) ? parts : [parts]);
  }

  function utf8ByteLength(value) {
    const source = String(value || '');
    let bytes = 0;
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xD800 && code <= 0xDBFF
          && source.charCodeAt(index + 1) >= 0xDC00
          && source.charCodeAt(index + 1) <= 0xDFFF) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function valueByteLength(value) {
    return utf8ByteLength(value);
  }

  function createMarkdownRenderCache(options) {
    const opts = options || {};
    const configuredMax = Number(opts.maxEntries);
    const maxEntries = Number.isSafeInteger(configuredMax) && configuredMax > 0
      ? configuredMax
      : DEFAULT_MAX_ENTRIES;
    const configuredMaxBytes = Number(opts.maxBytes);
    const maxBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
      ? configuredMaxBytes
      : DEFAULT_MAX_BYTES;
    const entries = new Map();
    let totalBytes = 0;
    const counters = {
      hits: 0,
      misses: 0,
      bypasses: 0,
      evictions: 0,
      byteEvictions: 0,
      entryEvictions: 0,
    };

    function get(parts) {
      const key = buildKey(parts);
      if (!entries.has(key)) {
        counters.misses += 1;
        return { hit: false, value: undefined };
      }
      const entry = entries.get(key);
      entries.delete(key);
      entries.set(key, entry);
      counters.hits += 1;
      return { hit: true, value: entry.value };
    }

    function set(parts, value) {
      const key = buildKey(parts);
      const bytes = utf8ByteLength(key) + valueByteLength(value);
      if (bytes > maxBytes) return value;
      if (entries.has(key)) {
        totalBytes -= entries.get(key).bytes;
        entries.delete(key);
      }
      entries.set(key, { value, bytes });
      totalBytes += bytes;
      while (totalBytes > maxBytes || entries.size > maxEntries) {
        const reason = totalBytes > maxBytes ? 'byte' : 'entry';
        const oldestKey = entries.keys().next().value;
        const oldest = entries.get(oldestKey);
        entries.delete(oldestKey);
        totalBytes -= oldest.bytes;
        counters.evictions += 1;
        if (reason === 'byte') counters.byteEvictions += 1;
        else counters.entryEvictions += 1;
      }
      return value;
    }

    function noteBypass() {
      counters.bypasses += 1;
    }

    function clear() {
      entries.clear();
      totalBytes = 0;
      counters.hits = 0;
      counters.misses = 0;
      counters.bypasses = 0;
      counters.evictions = 0;
      counters.byteEvictions = 0;
      counters.entryEvictions = 0;
    }

    function stats() {
      return {
        size: entries.size,
        max: maxEntries,
        bytes: totalBytes,
        maxBytes,
        hits: counters.hits,
        misses: counters.misses,
        bypasses: counters.bypasses,
        evictions: counters.evictions,
        byteEvictions: counters.byteEvictions,
        entryEvictions: counters.entryEvictions,
      };
    }

    return { get, set, noteBypass, clear, stats };
  }

  return {
    DEFAULT_MAX_ENTRIES,
    DEFAULT_MAX_BYTES,
    buildKey,
    createMarkdownRenderCache,
  };
});
