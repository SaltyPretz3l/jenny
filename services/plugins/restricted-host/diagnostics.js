'use strict';

const MAX_EVENTS_PER_CONTRIBUTION = 128;
const MAX_EVENTS_GLOBAL = 1024;
const SENSITIVE_KEYS = /(?:token|secret|credential|authorization|cookie|path|url|payload|input|output|argv|env|handle)/i;
const SENSITIVE_VALUE = /(?:bearer\s+|api[_-]?key|secret|credential|authorization|cookie|-----BEGIN|https?:\/\/|[A-Za-z]:\\|\/(?:Users|home|tmp)\/)/i;

function boundedId(value) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(value || '')) ? String(value) : '';
}

function sanitizeFields(fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.test(key)) continue;
    if (typeof value === 'boolean' || Number.isSafeInteger(value)) safe[key] = value;
    else if (typeof value === 'string' && value.length <= 128
      && /^[\x20-\x7e]*$/.test(value) && !SENSITIVE_VALUE.test(value)) safe[key] = value;
  }
  return safe;
}

class RestrictedHostDiagnostics {
  constructor({ now = () => new Date().toISOString(), log = () => {} } = {}) {
    this._now = now;
    this._log = log;
    this._events = [];
    this._evictionCount = 0;
  }

  record(level, event, identity = {}, fields = {}) {
    const entry = Object.freeze({
      recorded_at: this._now(),
      level: ['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(level) ? level : 'INFO',
      event: boundedId(event),
      publisher_id: boundedId(identity.publisher_id),
      plugin_id: boundedId(identity.plugin_id),
      contribution_id: boundedId(identity.contribution_id),
      ...sanitizeFields(fields),
    });
    this._events.push(entry);
    const contributionKey = `${entry.publisher_id}\0${entry.plugin_id}\0${entry.contribution_id}`;
    const matching = this._events
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => `${item.publisher_id}\0${item.plugin_id}\0${item.contribution_id}` === contributionKey);
    while (matching.length > MAX_EVENTS_PER_CONTRIBUTION) {
      const evicted = matching.shift();
      this._events.splice(evicted.index, 1);
      this._evictionCount += 1;
      for (const candidate of matching) if (candidate.index > evicted.index) candidate.index -= 1;
    }
    while (this._events.length > MAX_EVENTS_GLOBAL) {
      this._events.shift();
      this._evictionCount += 1;
    }
    this._log(entry.level, `plugins.restricted_host.${entry.event}`, entry);
    return entry;
  }

  snapshot() {
    return Object.freeze({ events: this._events.map((entry) => ({ ...entry })), eviction_count: this._evictionCount });
  }
}

module.exports = {
  MAX_EVENTS_PER_CONTRIBUTION, MAX_EVENTS_GLOBAL, SENSITIVE_VALUE,
  sanitizeFields, RestrictedHostDiagnostics,
};
