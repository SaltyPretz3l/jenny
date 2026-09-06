'use strict';

const { isDeepStrictEqual } = require('node:util');
const { FileJsonStore } = require('./file-json-store');
const { normalizeTerminalKind } = require('./chat-lifecycle-contracts');
const { normalizeMessageFields } = require('./message-normalization');

const TERMINAL_REPAIR_SCHEMA_VERSION = 1;
const MAX_PENDING_TERMINAL_REPAIRS = 256;
const MAX_RETAINED_DISCARDED_REPAIRS = 64;
const MAX_TERMINAL_REPAIR_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_TERMINAL_REPAIR_MESSAGES = 512;
const MAX_TERMINAL_REPAIR_TOOL_REPAIRS = 512;
const MAX_TERMINAL_REPAIR_TURN_EVENTS = 4096;

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeGeneration(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRepairState(value) {
  return value === 'discarded' ? 'discarded' : 'pending';
}

function createRepairMap(source = null) {
  return Object.assign(Object.create(null), source || {});
}

function cloneJsonRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return null;
  }
}

function normalizeTerminalSnapshot(value) {
  const source = cloneJsonRecord(value);
  if (!source) return null;
  const kind = normalizeTerminalKind(source.kind || source.terminal?.kind);
  const messages = Array.isArray(source.messages)
    ? source.messages.slice(0, MAX_TERMINAL_REPAIR_MESSAGES)
      .map((message) => normalizeMessageFields(message))
      .filter(Boolean)
    : null;
  const toolRepairs = Array.isArray(source.tool_repairs || source.toolRepairs)
    ? (source.tool_repairs || source.toolRepairs).slice(0, MAX_TERMINAL_REPAIR_TOOL_REPAIRS)
      .map((repair) => cloneJsonRecord(repair))
      .filter(Boolean)
    : null;
  const turnEvents = Array.isArray(source.turn_events || source.turnEvents)
    ? (source.turn_events || source.turnEvents).slice(0, MAX_TERMINAL_REPAIR_TURN_EVENTS)
      .map((event) => cloneJsonRecord(event))
      .filter(Boolean)
    : null;
  const preferencePatch = cloneJsonRecord(
    source.preference_patch || source.preferencePatch || {}
  );
  const terminal = cloneJsonRecord(source.terminal || {}) || {};
  if (
    !kind
    || !messages
    || messages.length !== source.messages.length
    || !toolRepairs
    || toolRepairs.length !== (source.tool_repairs || source.toolRepairs).length
    || !turnEvents
    || turnEvents.length !== (source.turn_events || source.turnEvents).length
    || !preferencePatch
  ) {
    return null;
  }
  const snapshot = {
    kind,
    terminal: { ...terminal, kind },
    messages,
    tool_repairs: toolRepairs,
    turn_events: turnEvents,
    preference_patch: preferencePatch,
    title: source.title == null ? null : String(source.title).trim(),
    requires_tool_replan: source.requires_tool_replan === true
      || source.requiresToolReplan === true,
  };
  try {
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_TERMINAL_REPAIR_SNAPSHOT_BYTES) {
      return null;
    }
  } catch (_error) {
    return null;
  }
  return snapshot;
}

function normalizeRepairArtifact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = normalizeId(value.session_id || value.sessionId);
  const sessionIncarnation = normalizeId(
    value.session_incarnation || value.sessionIncarnation
  );
  const turnGeneration = normalizeGeneration(
    value.turn_generation ?? value.turnGeneration
  );
  const turnId = normalizeId(value.turn_id || value.turnId);
  const streamId = normalizeId(value.stream_id || value.streamId);
  const messageSource = value.message == null ? null : value.message;
  const normalizedMessage = messageSource == null ? null : normalizeMessageFields(messageSource);
  const terminalSnapshot = normalizeTerminalSnapshot(
    value.terminal_snapshot || value.terminalSnapshot
  );
  const messageId = normalizeId(normalizedMessage?.id);
  if (
    !sessionId
    || !sessionIncarnation
    || turnGeneration === null
    || !turnId
    || !streamId
    || (messageSource != null && (!messageId || normalizedMessage?.role !== 'assistant'))
    || !terminalSnapshot
  ) {
    return null;
  }
  const artifactId = normalizeId(value.artifact_id || value.artifactId)
    || `${sessionId}:${sessionIncarnation}:${turnGeneration}`;
  const createdAt = normalizeId(value.created_at || value.createdAt)
    || new Date().toISOString();
  const updatedAt = normalizeId(value.updated_at || value.updatedAt) || createdAt;
  const message = normalizedMessage
    ? (({ durability: _durability, ...clean }) => clean)(normalizedMessage)
    : null;
  return {
    artifact_id: artifactId,
    session_id: sessionId,
    session_incarnation: sessionIncarnation,
    turn_generation: turnGeneration,
    turn_id: turnId,
    stream_id: streamId,
    message,
    terminal_snapshot: terminalSnapshot,
    reason: normalizeId(value.reason) || 'write_failed',
    scope: normalizeId(value.scope) || 'assistant',
    state: normalizeRepairState(value.state),
    discard_requested: value.discard_requested === true || value.discardRequested === true,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function normalizeStorePayload(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const repairs = createRepairMap();
  const sourceRepairs = source.repairs && typeof source.repairs === 'object'
    && !Array.isArray(source.repairs)
    ? source.repairs
    : {};
  for (const candidate of Object.values(sourceRepairs)) {
    const repair = normalizeRepairArtifact(candidate);
    if (repair) repairs[repair.artifact_id] = repair;
  }
  return {
    schema_version: TERMINAL_REPAIR_SCHEMA_VERSION,
    repairs,
  };
}

function buildResult({ ok, durable, reason = null, artifact = null } = {}) {
  return {
    ok: ok === true,
    durable: durable === true,
    reason: reason ? String(reason) : null,
    artifact,
  };
}

class TerminalRepairStore {
  constructor(filePath, { logger = null, writeDebounceMs = 0 } = {}) {
    this.filePath = filePath;
    this._logger = typeof logger === 'function' ? logger : null;
    this._store = new FileJsonStore(filePath, {
      logger: this._logger,
      writeDebounceMs,
    });
    const raw = this._store.read({
      schema_version: TERMINAL_REPAIR_SCHEMA_VERSION,
      repairs: {},
    });
    this._newerSchemaVersion = Number(raw?.schema_version || 0)
      > TERMINAL_REPAIR_SCHEMA_VERSION
      ? Number(raw.schema_version)
      : 0;
    this._payload = this._newerSchemaVersion
      ? { schema_version: TERMINAL_REPAIR_SCHEMA_VERSION, repairs: createRepairMap() }
      : normalizeStorePayload(raw);
  }

  hasNewerSchema() {
    return this._newerSchemaVersion > 0;
  }

  listPending(sessionId = '') {
    const normalizedSessionId = normalizeId(sessionId);
    return Object.values(this._payload.repairs)
      .filter((repair) => repair.state === 'pending')
      .filter((repair) => !normalizedSessionId || repair.session_id === normalizedSessionId)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
      .map((repair) => structuredClone(repair));
  }

  get(artifactId) {
    const normalizedArtifactId = normalizeId(artifactId);
    const repair = Object.prototype.hasOwnProperty.call(
      this._payload.repairs,
      normalizedArtifactId
    ) ? this._payload.repairs[normalizedArtifactId] : null;
    return repair ? structuredClone(repair) : null;
  }

  findByIdentity(identity = {}) {
    const sessionId = normalizeId(identity.session_id || identity.sessionId);
    const sessionIncarnation = normalizeId(
      identity.session_incarnation || identity.sessionIncarnation
    );
    const turnGeneration = normalizeGeneration(
      identity.turn_generation ?? identity.turnGeneration ?? identity.generation
    );
    if (!sessionId || !sessionIncarnation || turnGeneration === null) return null;
    const repair = Object.values(this._payload.repairs).find((entry) => (
      entry.session_id === sessionId
      && entry.session_incarnation === sessionIncarnation
      && entry.turn_generation === turnGeneration
    ));
    return repair ? structuredClone(repair) : null;
  }

  savePending(value) {
    const repair = normalizeRepairArtifact({ ...value, state: 'pending' });
    if (!repair) return buildResult({ reason: 'invalid_artifact' });
    if (this.hasNewerSchema()) return buildResult({ reason: 'newer_schema' });
    const existing = this._payload.repairs[repair.artifact_id];
    if (existing) {
      if (
        existing.session_id !== repair.session_id
        || existing.session_incarnation !== repair.session_incarnation
        || existing.turn_generation !== repair.turn_generation
        || existing.turn_id !== repair.turn_id
        || existing.stream_id !== repair.stream_id
        || normalizeId(existing.message?.id) !== normalizeId(repair.message?.id)
        || !isDeepStrictEqual(existing.message, repair.message)
        || !isDeepStrictEqual(existing.terminal_snapshot, repair.terminal_snapshot)
      ) {
        return buildResult({ reason: 'artifact_identity_conflict' });
      }
      if (existing.state === 'pending') {
        if (existing.discard_requested) {
          return buildResult({
            reason: 'artifact_discard_pending',
            artifact: structuredClone(existing),
          });
        }
        return this._ensureDurable(existing);
      }
      return buildResult({ reason: 'artifact_discarded', artifact: structuredClone(existing) });
    }
    const pendingCount = this.listPending().length;
    if (!existing && pendingCount >= MAX_PENDING_TERMINAL_REPAIRS) {
      return buildResult({ reason: 'capacity_exceeded' });
    }
    return this._replaceAndPersist(repair);
  }

  markDiscarded(artifactId, identity = {}) {
    const normalizedArtifactId = normalizeId(artifactId);
    const existing = this._payload.repairs[normalizedArtifactId];
    if (!existing) return buildResult({ reason: 'artifact_not_found' });
    if (!this._matchesIdentity(existing, identity)) {
      return buildResult({ reason: 'stale_identity' });
    }
    if (existing.state === 'discarded') return this._ensureDurable(existing);
    return this._replaceAndPersist({
      ...existing,
      state: 'discarded',
      discard_requested: true,
      updated_at: new Date().toISOString(),
    });
  }

  markDiscardPending(artifactId, identity = {}) {
    const normalizedArtifactId = normalizeId(artifactId);
    const existing = this._payload.repairs[normalizedArtifactId];
    if (!existing) return buildResult({ reason: 'artifact_not_found' });
    if (!this._matchesIdentity(existing, identity)) {
      return buildResult({ reason: 'stale_identity' });
    }
    if (existing.state === 'discarded' || existing.discard_requested) {
      return this._ensureDurable(existing);
    }
    return this._replaceAndPersist({
      ...existing,
      discard_requested: true,
      updated_at: new Date().toISOString(),
    });
  }

  clearResolved(artifactId, identity = {}) {
    const normalizedArtifactId = normalizeId(artifactId);
    const existing = this._payload.repairs[normalizedArtifactId];
    if (!existing) return buildResult({ ok: true, durable: true, reason: 'already_cleared' });
    if (!this._matchesIdentity(existing, identity)) {
      return buildResult({ reason: 'stale_identity' });
    }
    if (this.hasNewerSchema()) return buildResult({ reason: 'newer_schema' });
    const next = {
      schema_version: TERMINAL_REPAIR_SCHEMA_VERSION,
      repairs: createRepairMap(this._payload.repairs),
    };
    delete next.repairs[normalizedArtifactId];
    return this._persist(next, null);
  }

  deleteSession(sessionId) {
    const normalizedSessionId = normalizeId(sessionId);
    if (!normalizedSessionId) return buildResult({ reason: 'invalid_session_id' });
    if (this.hasNewerSchema()) return buildResult({ reason: 'newer_schema' });
    const nextRepairs = createRepairMap();
    let removed = 0;
    for (const [artifactId, repair] of Object.entries(this._payload.repairs)) {
      if (repair.session_id === normalizedSessionId) {
        removed += 1;
      } else {
        nextRepairs[artifactId] = repair;
      }
    }
    if (!removed) {
      return buildResult({ ok: true, durable: true, reason: 'already_cleared' });
    }
    return this._persist({
      schema_version: TERMINAL_REPAIR_SCHEMA_VERSION,
      repairs: nextRepairs,
    }, null);
  }

  flush() {
    try {
      this._store.flush();
      return true;
    } catch (error) {
      this._logWriteFailure(error);
      return false;
    }
  }

  dispose() {
    this.flush();
  }

  _matchesIdentity(repair, identity) {
    return repair.session_id === normalizeId(identity.session_id || identity.sessionId)
      && repair.session_incarnation === normalizeId(
        identity.session_incarnation || identity.sessionIncarnation
      )
      && repair.turn_generation === normalizeGeneration(
        identity.turn_generation ?? identity.turnGeneration
      );
  }

  _replaceAndPersist(repair) {
    const nextRepairs = createRepairMap(this._payload.repairs);
    nextRepairs[repair.artifact_id] = repair;
    const discarded = Object.values(nextRepairs)
      .filter((entry) => entry.state === 'discarded')
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    for (const entry of discarded.slice(MAX_RETAINED_DISCARDED_REPAIRS)) {
      delete nextRepairs[entry.artifact_id];
    }
    return this._persist({
      schema_version: TERMINAL_REPAIR_SCHEMA_VERSION,
      repairs: nextRepairs,
    }, repair);
  }

  _ensureDurable(repair) {
    try {
      if (this._store.hasPendingWrite()) this._store.flush();
      return buildResult({ ok: true, durable: true, artifact: structuredClone(repair) });
    } catch (error) {
      this._logWriteFailure(error);
      return buildResult({ reason: 'write_failed', artifact: structuredClone(repair) });
    }
  }

  _persist(next, artifact) {
    try {
      this._store.writeImmediate(next);
      this._payload = next;
      return buildResult({
        ok: true,
        durable: true,
        artifact: artifact ? structuredClone(artifact) : null,
      });
    } catch (error) {
      this._logWriteFailure(error);
      return buildResult({ reason: 'write_failed', artifact: artifact && structuredClone(artifact) });
    }
  }

  _logWriteFailure(error) {
    try {
      this._logger?.('WARN', 'terminal_repair.write_failed', {
        errorName: String(error?.name || 'Error').slice(0, 80),
      });
    } catch (_) {
      // Diagnostics cannot alter repair ownership.
    }
  }
}

module.exports = {
  TERMINAL_REPAIR_SCHEMA_VERSION,
  TerminalRepairStore,
};
