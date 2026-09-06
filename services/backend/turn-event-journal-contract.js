'use strict';

const LEGACY_JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_PARTITIONS = 4096;
const MAX_JOURNAL_STARTUP_BYTES = 256 * 1024 * 1024;
const MAX_JOURNAL_PARTITION_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_EVENTS_PER_TURN = 20_000;

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function validateLegacyJournal(payload) {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'malformed_root' };
  }
  if (Number(payload.schema_version) !== LEGACY_JOURNAL_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'unsupported_schema',
      schemaVersion: Number(payload.schema_version) || 0,
    };
  }
  if (!isRecord(payload.sessions)) {
    return { ok: false, reason: 'malformed_sessions' };
  }
  let partitionCount = 0;
  for (const [sessionId, session] of Object.entries(payload.sessions)) {
    if (!String(sessionId).trim() || !isRecord(session) || !isRecord(session.turns)) {
      return { ok: false, reason: 'malformed_session' };
    }
    for (const [turnId, events] of Object.entries(session.turns)) {
      partitionCount += 1;
      if (
        !String(turnId).trim()
        || !Array.isArray(events)
        || events.length > MAX_JOURNAL_EVENTS_PER_TURN
        || events.some((event) => !isRecord(event))
      ) {
        return { ok: false, reason: 'malformed_turn' };
      }
      if (partitionCount > MAX_JOURNAL_PARTITIONS) {
        return { ok: false, reason: 'partition_limit' };
      }
    }
  }
  return { ok: true, sessions: payload.sessions };
}

module.exports = {
  MAX_JOURNAL_EVENTS_PER_TURN,
  MAX_JOURNAL_PARTITIONS,
  MAX_JOURNAL_PARTITION_BYTES,
  MAX_JOURNAL_STARTUP_BYTES,
  validateLegacyJournal,
};
