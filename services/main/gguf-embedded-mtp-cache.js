'use strict';

// `embeddedMtpLayers` for the local-GGUF scan: whether a model's own header
// declares an MTP head (`<arch>.nextn_predict_layers`), so the Tune drawer can
// tell "falls back to plain decoding" from "uses the head built into the
// model" before the first launch. A header read is 32 MB of tokenizer data on
// the worst case, so a read is made once per (path, size, mtime) and kept in
// a bounded map; the scan runs on every drawer open.

const fs = require('fs');
const path = require('path');

const { findFamily, loadAccelerationCatalog } = require('../backend/llama-server-acceleration');
const { readGgufHeader } = require('../gguf-header');
const { readEmbeddedMtpLayers } = require('./llama-server-acceleration-launch');

const DEFAULT_MAX_ENTRIES = 256;

// get(filePath) is an integer >= 0 (0: the header names no head) or null when
// the file is not a readable regular file or its header cannot be parsed.
function createEmbeddedMtpCache({
  readHeader = readGgufHeader,
  fsImpl = fs,
  max = DEFAULT_MAX_ENTRIES,
} = {}) {
  const cache = new Map();
  return {
    get(filePath) {
      try {
        const resolved = path.resolve(String(filePath));
        const info = fsImpl.lstatSync(resolved);
        if (!info.isFile()) return null;
        const key = `${resolved}\n${info.size}\n${info.mtimeMs}`;
        if (cache.has(key)) {
          // Least recently used goes first: a hit moves to the back.
          const hit = cache.get(key);
          cache.delete(key);
          cache.set(key, hit);
          return hit;
        }
        const layers = readEmbeddedMtpLayers(resolved, { readHeader });
        cache.set(key, layers);
        while (cache.size > max) cache.delete(cache.keys().next().value);
        return layers;
      } catch (_error) {
        return null;
      }
    },
    get size() { return cache.size; },
  };
}

// A reader for scan entries. It returns the fields to spread into an entry:
// { embeddedMtpLayers: n } when the header was read, and {} (the field absent,
// "unread") for a family the acceleration catalog does not mark `mtp: "yes"`
// and for a file whose header cannot be read. Absent rather than null keeps
// every existing consumer of a scan entry, and its exact-shape tests, as it was.
function createEmbeddedMtpReader({
  repoRoot, fsImpl = fs, loadCatalog = loadAccelerationCatalog, cache,
} = {}) {
  const headCache = cache || createEmbeddedMtpCache({ fsImpl });
  let catalog;
  const catalogOnce = () => {
    if (catalog === undefined) {
      try {
        catalog = loadCatalog({ repoRoot, fsImpl }).catalog || null;
      } catch (_error) {
        catalog = null;
      }
    }
    return catalog;
  };
  const eligible = (tag, mainGguf) => [tag, mainGguf].some((name) => {
    if (!name) return false;
    const family = findFamily(name, catalogOnce());
    return Boolean(family) && family.mtp === 'yes';
  });
  return (tag, dir, mainGguf) => {
    const layers = mainGguf && eligible(tag, mainGguf)
      ? headCache.get(path.join(dir, mainGguf))
      : null;
    return layers === null ? {} : { embeddedMtpLayers: layers };
  };
}

module.exports = { createEmbeddedMtpCache, createEmbeddedMtpReader };
