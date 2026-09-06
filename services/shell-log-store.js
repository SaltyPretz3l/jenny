const { LOG_RETENTION } = require('../renderer/shared/log-contract-utils');

function cloneLogDetails(details) {
  if (!details || typeof details !== 'object') {
    return details;
  }
  try {
    return structuredClone(details);
  } catch (_error) {
    try {
      return JSON.parse(JSON.stringify(details));
    } catch (_jsonError) {
      return Array.isArray(details) ? details.slice() : { ...details };
    }
  }
}

function cloneLogEntry(entry = {}) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  return {
    ...source,
    details: cloneLogDetails(source.details),
    data: cloneLogDetails(source.data),
  };
}

class ShellLogStore {
  constructor({ limit = LOG_RETENTION.mainStoreLimit, maxBytes = Infinity } = {}) {
    this.limit = Math.max(50, Number(limit) || LOG_RETENTION.mainStoreLimit);
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : Infinity;
    this.entries = [];
    this.nextEntryId = 1;
    this.totalBytes = 0;
    this.droppedByLevel = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    this.droppedBySource = {};
  }

  append(entry) {
    const normalized = {
      ts: new Date().toISOString(),
      level: 'INFO',
      event: 'shell.event',
      details: {},
      ...entry,
    };
    if (!String(normalized.entry_id || '').trim()) {
      normalized.entry_id = `log_${this.nextEntryId}`;
      this.nextEntryId += 1;
    }

    const stored = cloneLogEntry(normalized);
    this.entries.push(stored);
    this.totalBytes += this._entryBytes(stored);
    while (this.entries.length > this.limit || this.totalBytes > this.maxBytes) {
      this._evictOne();
    }
    return cloneLogEntry(stored);
  }

  _entryBytes(entry) {
    try { return Buffer.byteLength(JSON.stringify(entry), 'utf8'); } catch (_error) { return 0; }
  }

  _evictOne() {
    if (this.entries.length === 0) return;
    let index = this.entries.findIndex((entry) => String(entry.level).toUpperCase() === 'DEBUG');
    if (index < 0) index = this.entries.findIndex((entry) => String(entry.level).toUpperCase() === 'INFO');
    if (index < 0) index = 0;
    const [removed] = this.entries.splice(index, 1);
    if (!removed) return;
    this.totalBytes = Math.max(0, this.totalBytes - this._entryBytes(removed));
    const level = String(removed.level || 'INFO').toUpperCase();
    this.droppedByLevel[level] = (this.droppedByLevel[level] || 0) + 1;
    const source = String(removed.layer || removed.source || 'electron').trim().toLowerCase() || 'electron';
    this.droppedBySource[source] = (this.droppedBySource[source] || 0) + 1;
  }

  list() {
    return this.entries.map((entry) => cloneLogEntry(entry));
  }

  getStats() {
    return {
      retained_count: this.entries.length,
      retained_bytes: this.totalBytes,
      dropped_count: Object.values(this.droppedByLevel).reduce((sum, count) => sum + count, 0),
      dropped_by_level: { ...this.droppedByLevel },
      dropped_by_source: { ...this.droppedBySource },
    };
  }
}

module.exports = {
  cloneLogEntry,
  ShellLogStore,
};
