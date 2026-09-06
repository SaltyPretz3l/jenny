'use strict';

const { joinPath } = require('../store/fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('../store/json-file-io');

const FILE_NAME = 'full-host-crash-quarantine-v6.json';

class FullHostCrashQuarantineStore {
  constructor({ facade, baseDir } = {}) {
    this._facade = facade;
    this._dir = joinPath(baseDir, 'runtime');
  }

  async load() {
    const read = await readJsonFile(this._facade, joinPath(this._dir, FILE_NAME));
    if (read.status === 'missing') return { ok: true, entries: [] };
    if (read.status !== 'ok' || read.value?.schema_version !== 1
      || !Array.isArray(read.value.entries)) {
      return { ok: false, reason: 'crash_quarantine_store_corrupt', entries: [] };
    }
    return { ok: true, entries: read.value.entries };
  }

  async save(entries) {
    try {
      await writeJsonFileAtomic(this._facade, this._dir, FILE_NAME, {
        schema_version: 1, entries: Array.isArray(entries) ? entries.slice(-128) : [],
      });
      return { ok: true };
    } catch (_error) {
      return { ok: false, reason: 'crash_quarantine_store_unavailable' };
    }
  }
}

module.exports = { FILE_NAME, FullHostCrashQuarantineStore };
