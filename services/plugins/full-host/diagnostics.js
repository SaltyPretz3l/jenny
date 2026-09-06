'use strict';

const MAX_EVENTS = 512;
const SAFE_ID = /^[a-z0-9][a-z0-9_.:-]{0,95}$/;
const SENSITIVE_KEY = /(?:secret|token|credential|authorization|cookie|path|argv|env|payload|prompt|output|stderr)/i;
const SENSITIVE_VALUE = /(?:bearer\s|api[_-]?key|secret|-----BEGIN|https?:\/\/|[A-Za-z]:\\|\/(?:Users|home|tmp)\/)/i;

function safeFields(fields = {}) {
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === 'boolean' || Number.isSafeInteger(value)) result[key] = value;
    else if (typeof value === 'string' && value.length <= 128 && !SENSITIVE_VALUE.test(value)) result[key] = value;
  }
  return result;
}

class FullHostDiagnostics {
  constructor({ now = () => new Date().toISOString(), log = () => {} } = {}) {
    this._now = now;
    this._log = log;
    this._events = [];
    this._evictions = 0;
  }

  record(level, event, identity = {}, fields = {}) {
    const entry = Object.freeze({
      recorded_at: this._now(),
      level: ['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(level) ? level : 'INFO',
      event: SAFE_ID.test(String(event || '')) ? String(event) : 'invalid_event',
      publisher_id: SAFE_ID.test(String(identity.publisher_id || '')) ? String(identity.publisher_id) : '',
      plugin_id: SAFE_ID.test(String(identity.plugin_id || '')) ? String(identity.plugin_id) : '',
      contribution_id: SAFE_ID.test(String(identity.contribution_id || '')) ? String(identity.contribution_id) : '',
      ...safeFields(fields),
    });
    this._events.push(entry);
    while (this._events.length > MAX_EVENTS) { this._events.shift(); this._evictions += 1; }
    this._log(entry.level, `plugins.full_host.${entry.event}`, entry);
    return entry;
  }

  snapshot() { return { events: this._events.map((item) => ({ ...item })), eviction_count: this._evictions }; }
}

module.exports = { MAX_EVENTS, FullHostDiagnostics };
