const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { hasDurableProof } = require('./conversation-store-port');
const {
  MAX_JOURNAL_EVENTS_PER_TURN,
  MAX_JOURNAL_PARTITIONS,
  MAX_JOURNAL_PARTITION_BYTES,
  MAX_JOURNAL_STARTUP_BYTES,
  validateLegacyJournal,
} = require('./turn-event-journal-contract');
const { normalizeId } = require('../shared/normalize');

const JOURNAL_SCHEMA_VERSION = 2;
const DEFAULT_COMPACTION_RECORD_LIMIT = 128;
const DEFAULT_COMPACTION_BYTE_LIMIT = 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

function normalizeEvents(events) {
  return Array.isArray(events)
    ? events.filter((event) => event && typeof event === 'object' && !Array.isArray(event))
    : [];
}

function cloneEvents(events) {
  return normalizeEvents(events).map((event) => JSON.parse(JSON.stringify(event)));
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function hashIdentity(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function buildTempPath(filePath) {
  return `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(5).toString('hex')}.tmp`;
}

class TurnEventJournal {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.rootPath = `${filePath}.journal${path.sep}v2`;
    this.manifestPath = path.join(this.rootPath, 'manifest.json');
    this._logger = typeof options.logger === 'function' ? options.logger : null;
    this._compactionRecordLimit = normalizePositiveInteger(
      options.compactionRecordLimit,
      DEFAULT_COMPACTION_RECORD_LIMIT
    );
    this._compactionByteLimit = normalizePositiveInteger(
      options.compactionByteLimit,
      DEFAULT_COMPACTION_BYTE_LIMIT
    );
    this._maxPartitions = normalizePositiveInteger(options.maxPartitions, MAX_JOURNAL_PARTITIONS);
    this._maxStartupBytes = normalizePositiveInteger(options.maxStartupBytes, MAX_JOURNAL_STARTUP_BYTES);
    this._maxPartitionBytes = normalizePositiveInteger(options.maxPartitionBytes, MAX_JOURNAL_PARTITION_BYTES);
    this._maxEventsPerTurn = normalizePositiveInteger(options.maxEventsPerTurn, MAX_JOURNAL_EVENTS_PER_TURN);
    this._turnsBySession = new Map();
    this._partitionStats = new Map();
    this._partitionCount = 0;
    this._totalPartitionBytes = 0;
    this._blockedPartitions = new Set();
    this._dirtyPaths = new Set();
    this._storageBlocked = false;
    this._initialize();
  }

  _log(level, event, details = {}) {
    if (!this._logger) {
      return;
    }
    try {
      this._logger(level, event, details);
    } catch (_error) {
      // Logging must never break recovery.
    }
  }

  _partitionKey(sessionId, turnId) {
    return `${sessionId}\u001f${turnId}`;
  }

  _partitionPath(sessionId, turnId) {
    return path.join(this.rootPath, hashIdentity(sessionId), `${hashIdentity(turnId)}.ndjson`);
  }

  _ensureWritable(sessionId = '', turnId = '') {
    if (this._storageBlocked) {
      throw new Error('Turn-event journal storage is blocked pending recovery');
    }
    const key = this._partitionKey(sessionId, turnId);
    if (this._blockedPartitions.has(key)) {
      throw new Error('Turn-event journal partition is blocked pending recovery');
    }
  }

  _initialize() {
    if (fs.existsSync(this.manifestPath)) {
      this._loadManifestAndPartitions();
      return;
    }
    if (fs.existsSync(this.filePath)) {
      try {
        this._migrateLegacyJournal();
      } catch (error) {
        this._storageBlocked = true;
        this._log('WARN', 'turn_journal.legacy_migration_blocked', {
          reason: 'partial_failure',
          errorCode: normalizeId(error?.code) || null,
        });
      }
      return;
    }
    const hasOrphanPartitions = this._hasOrphanPartitions();
    if (this._storageBlocked) {
      return;
    }
    if (hasOrphanPartitions) {
      this._writeManifest();
      this._loadManifestAndPartitions();
      this._log('WARN', 'turn_journal.orphan_partitions_recovered', {
        sessions: this._turnsBySession.size,
      });
      return;
    }
    this._writeManifest();
  }

  _hasOrphanPartitions() {
    if (!fs.existsSync(this.rootPath)) {
      return false;
    }
    try {
      return fs.readdirSync(this.rootPath, { withFileTypes: true }).some((entry) => {
        if (!entry.isDirectory()) {
          return false;
        }
        return fs.readdirSync(path.join(this.rootPath, entry.name))
          .some((name) => name.endsWith('.ndjson'));
      });
    } catch (error) {
      this._storageBlocked = true;
      this._log('WARN', 'turn_journal.orphan_scan_failed', {
        errorCode: normalizeId(error?.code) || null,
      });
      return false;
    }
  }

  _loadManifestAndPartitions() {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch (error) {
      this._storageBlocked = true;
      this._log('WARN', 'turn_journal.manifest_unreadable', {
        errorCode: normalizeId(error?.code) || null,
      });
      return;
    }
    if (Number(manifest?.schema_version) !== JOURNAL_SCHEMA_VERSION) {
      this._storageBlocked = true;
      this._log('WARN', 'turn_journal.future_or_invalid_manifest', {
        schemaVersion: Number(manifest?.schema_version) || 0,
      });
      return;
    }
    let sessionDirectories;
    try {
      sessionDirectories = fs.readdirSync(this.rootPath, { withFileTypes: true });
    } catch (error) {
      this._storageBlocked = true;
      this._log('WARN', 'turn_journal.partition_scan_failed', {
        errorCode: normalizeId(error?.code) || null,
      });
      return;
    }
    let partitionCount = 0;
    let startupBytes = 0;
    for (const sessionDirectory of sessionDirectories) {
      if (!sessionDirectory.isDirectory()) {
        continue;
      }
      const directoryPath = path.join(this.rootPath, sessionDirectory.name);
      let files;
      try {
        files = fs.readdirSync(directoryPath, { withFileTypes: true });
      } catch (error) {
        this._log('WARN', 'turn_journal.partition_directory_unreadable', {
          partition: sessionDirectory.name.slice(0, 16),
          errorCode: normalizeId(error?.code) || null,
        });
        this._storageBlocked = true;
        return;
      }
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.ndjson')) {
          const partitionPath = path.join(directoryPath, file.name);
          let partitionBytes;
          try {
            partitionBytes = fs.statSync(partitionPath).size;
          } catch (error) {
            this._log('WARN', 'turn_journal.partition_unreadable', {
              partition: file.name.slice(0, 16),
              errorCode: normalizeId(error?.code) || null,
            });
            this._storageBlocked = true;
            return;
          }
          partitionCount += 1;
          startupBytes += partitionBytes;
          if (
            partitionCount > this._maxPartitions
            || partitionBytes > this._maxPartitionBytes
            || startupBytes > this._maxStartupBytes
          ) {
            this._storageBlocked = true;
            this._log('WARN', 'turn_journal.startup_bound_exceeded', {
              partitionCount,
              partitionBytes,
              startupBytes,
            });
            return;
          }
          this._partitionCount = partitionCount;
          this._totalPartitionBytes = startupBytes;
          const loaded = this._loadPartition(partitionPath);
          if (loaded === false) {
            this._storageBlocked = true;
            return;
          }
          if (loaded.empty && loaded.identity && !loaded.blocked) {
            try {
              this._deletePartition(loaded.identity.sessionId, loaded.identity.turnId);
              partitionCount = this._partitionCount;
              startupBytes = this._totalPartitionBytes;
            } catch (error) {
              this._storageBlocked = true;
              this._log('WARN', 'turn_journal.empty_partition_reclaim_failed', {
                partition: file.name.slice(0, 16),
                errorCode: normalizeId(error?.code) || null,
              });
              return;
            }
          }
        }
      }
    }
  }

  _loadPartition(partitionPath) {
    let raw;
    try {
      raw = fs.readFileSync(partitionPath, 'utf8');
    } catch (error) {
      this._log('WARN', 'turn_journal.partition_unreadable', {
        partition: path.basename(partitionPath).slice(0, 16),
        errorCode: normalizeId(error?.code) || null,
      });
      return false;
    }
    const lines = raw.split('\n');
    let identity = null;
    let events = [];
    let blocked = false;
    let recordCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }
      if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
        blocked = true;
        this._log('WARN', 'turn_journal.record_too_large', {
          partition: path.basename(partitionPath).slice(0, 16),
          line: index + 1,
        });
        break;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch (_error) {
        const crashTruncatedTail = index === lines.length - 1 && !raw.endsWith('\n');
        this._log('WARN', crashTruncatedTail
          ? 'turn_journal.truncated_tail_ignored'
          : 'turn_journal.partition_corrupted', {
          partition: path.basename(partitionPath).slice(0, 16),
          line: index + 1,
        });
        if (crashTruncatedTail) {
          const rawBuffer = Buffer.from(raw, 'utf8');
          const lastNewline = rawBuffer.lastIndexOf(10);
          try {
            fs.truncateSync(partitionPath, lastNewline + 1);
            raw = rawBuffer.subarray(0, lastNewline + 1).toString('utf8');
          } catch (error) {
            this._log('WARN', 'turn_journal.truncated_tail_repair_failed', {
              partition: path.basename(partitionPath).slice(0, 16),
              errorCode: normalizeId(error?.code) || null,
            });
            blocked = true;
          }
        }
        if (!crashTruncatedTail) {
          blocked = true;
        }
        break;
      }
      const schemaVersion = Number(record?.schema_version);
      const sessionId = normalizeId(record?.session_id);
      const turnId = normalizeId(record?.turn_id);
      if (schemaVersion !== JOURNAL_SCHEMA_VERSION || !sessionId || !turnId) {
        blocked = true;
        this._log('WARN', 'turn_journal.partition_record_rejected', {
          partition: path.basename(partitionPath).slice(0, 16),
          schemaVersion: schemaVersion || 0,
        });
        break;
      }
      if (!identity) {
        identity = { sessionId, turnId };
      } else if (identity.sessionId !== sessionId || identity.turnId !== turnId) {
        blocked = true;
        this._log('WARN', 'turn_journal.partition_identity_mismatch', {
          partition: path.basename(partitionPath).slice(0, 16),
        });
        break;
      }
      const carriesEvents = record.op === 'snapshot' || record.op === 'append';
      if (
        carriesEvents
        && (!Array.isArray(record.events)
          || record.events.length > this._maxEventsPerTurn
          || record.events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)))
      ) {
        blocked = true;
        this._log('WARN', 'turn_journal.partition_events_rejected', {
          partition: path.basename(partitionPath).slice(0, 16),
        });
        break;
      }
      try {
        if (record.op === 'snapshot') {
          events = cloneEvents(record.events);
        } else if (record.op === 'append') {
          events = this._mergeEvents(events, record.events);
        } else if (record.op === 'clear') {
          events = [];
        } else {
          blocked = true;
          this._log('WARN', 'turn_journal.partition_operation_rejected', {
            partition: path.basename(partitionPath).slice(0, 16),
          });
          break;
        }
      } catch (_error) {
        blocked = true;
        this._log('WARN', 'turn_journal.partition_event_limit_exceeded', {
          partition: path.basename(partitionPath).slice(0, 16),
        });
        break;
      }
      recordCount += 1;
    }
    if (!identity) {
      this._log('WARN', 'turn_journal.partition_identity_missing', {
        partition: path.basename(partitionPath).slice(0, 16),
      });
      return false;
    }
    const key = this._partitionKey(identity.sessionId, identity.turnId);
    if (path.resolve(partitionPath) !== path.resolve(this._partitionPath(
      identity.sessionId,
      identity.turnId
    ))) {
      this._blockedPartitions.add(key);
      this._log('WARN', 'turn_journal.partition_path_identity_mismatch', {
        partition: path.basename(partitionPath).slice(0, 16),
      });
      return { blocked: true, empty: false, identity };
    }
    this._setTurnEvents(identity.sessionId, identity.turnId, events);
    this._partitionStats.set(key, { records: recordCount, bytes: Buffer.byteLength(raw, 'utf8') });
    if (blocked) {
      this._blockedPartitions.add(key);
    }
    return { blocked, empty: events.length === 0, identity };
  }

  // Precondition: `existingEvents` must already be journal-private (either the
  // stored array via _peekTurnEvents, or a fresh parse/clone). The result is a
  // new array that shares those event objects by reference, so callers must not
  // hand it to anything that mutates events. Only the incoming events cross a
  // trust boundary and are cloned here.
  _mergeEvents(existingEvents, incomingEvents) {
    const result = normalizeEvents(existingEvents);
    const seen = new Set(result.map((event) => normalizeId(event.event_id || event.eventId)).filter(Boolean));
    for (const event of normalizeEvents(incomingEvents)) {
      const eventId = normalizeId(event.event_id || event.eventId);
      if (eventId && seen.has(eventId)) {
        continue;
      }
      result.push(JSON.parse(JSON.stringify(event)));
      if (result.length > this._maxEventsPerTurn) {
        throw new Error('Turn-event journal turn exceeds the event limit');
      }
      if (eventId) {
        seen.add(eventId);
      }
    }
    return result;
  }

  // Read-only view of the stored events. Returns the journal's own array by
  // reference and must never escape the class or be mutated -- public reads go
  // through list(), which clones. Exists so the append() hot path can merge
  // without deep-cloning the whole turn on every single event.
  _peekTurnEvents(sessionId, turnId) {
    const turns = this._turnsBySession.get(sessionId);
    return turns?.get(turnId) || [];
  }

  _setTurnEvents(sessionId, turnId, events) {
    this._adoptTurnEvents(sessionId, turnId, cloneEvents(events));
  }

  // Takes ownership of `events` without copying. The caller must guarantee the
  // array and its event objects are already journal-private; anything holding a
  // reference to caller-supplied events must use _setTurnEvents instead.
  _adoptTurnEvents(sessionId, turnId, events) {
    let turns = this._turnsBySession.get(sessionId);
    if (!(turns instanceof Map)) {
      turns = new Map();
      this._turnsBySession.set(sessionId, turns);
    }
    turns.set(turnId, events);
  }

  _writeManifest() {
    fs.mkdirSync(this.rootPath, { recursive: true });
    this._writeAtomicJson(this.manifestPath, {
      schema_version: JOURNAL_SCHEMA_VERSION,
      storage: 'partitioned_ndjson',
    });
    this._fsyncDirectory(path.dirname(this.rootPath));
  }

  _writeAtomicJson(targetPath, value) {
    const tempPath = buildTempPath(targetPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, 'utf8');
    this._fsyncPath(tempPath);
    fs.renameSync(tempPath, targetPath);
    this._fsyncDirectory(path.dirname(targetPath));
  }

  _migrateLegacyJournal() {
    let legacy;
    let legacyBytes;
    try {
      const stats = fs.statSync(this.filePath);
      legacyBytes = stats.size;
      if (!stats.isFile() || legacyBytes > this._maxStartupBytes) {
        this._storageBlocked = true;
        this._log('WARN', 'turn_journal.legacy_migration_blocked', {
          reason: stats.isFile() ? 'source_too_large' : 'source_not_file',
          legacyBytes,
          maxStartupBytes: this._maxStartupBytes,
        });
        return;
      }
      legacy = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      this._storageBlocked = true;
      this._log('WARN', 'turn_journal.legacy_migration_blocked', {
        reason: 'unreadable',
        errorCode: normalizeId(error?.code) || null,
      });
      return;
    }
    const validation = validateLegacyJournal(legacy);
    if (!validation.ok) {
      this._storageBlocked = true;
      this._log('WARN', 'turn_journal.legacy_migration_blocked', {
        reason: validation.reason,
        ...(validation.schemaVersion != null ? { schemaVersion: validation.schemaVersion } : {}),
      });
      return;
    }
    const sessions = validation.sessions;
    for (const [sessionId, session] of Object.entries(sessions)) {
      const normalizedSessionId = normalizeId(sessionId);
      const turns = session.turns;
      for (const [turnId, events] of Object.entries(turns)) {
        const normalizedTurnId = normalizeId(turnId);
        if (!normalizedSessionId || !normalizedTurnId) {
          continue;
        }
        const normalizedEvents = cloneEvents(events);
        this._setTurnEvents(normalizedSessionId, normalizedTurnId, normalizedEvents);
        if (!this._compactPartition(normalizedSessionId, normalizedTurnId)) {
          throw new Error('Turn-event journal legacy partition exceeds storage bounds');
        }
      }
    }
    this.flush();
    // The completion marker is written last. A crash during import therefore
    // leaves the v1 source authoritative and the next startup idempotently
    // overwrites any partial partition snapshots.
    this._writeManifest();
    const retiredPath = `${this.filePath}.v1.migrated`;
    try {
      if (!fs.existsSync(retiredPath)) {
        fs.renameSync(this.filePath, retiredPath);
        this._fsyncDirectory(path.dirname(this.filePath));
      }
    } catch (error) {
      this._log('WARN', 'turn_journal.legacy_retire_failed', {
        errorCode: normalizeId(error?.code) || null,
      });
    }
    this._log('INFO', 'turn_journal.legacy_migrated', {
      sessions: this._turnsBySession.size,
    });
  }

  _appendRecord(sessionId, turnId, record, compactionEvents = null) {
    this._ensureWritable(sessionId, turnId);
    const partitionPath = this._partitionPath(sessionId, turnId);
    const payload = `${JSON.stringify({
      schema_version: JOURNAL_SCHEMA_VERSION,
      session_id: sessionId,
      turn_id: turnId,
      ...record,
    })}\n`;
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    if (payloadBytes > MAX_RECORD_BYTES) {
      throw new Error('Turn-event journal record exceeds the byte limit');
    }
    const key = this._partitionKey(sessionId, turnId);
    const stats = this._partitionStats.get(key) || { records: 0, bytes: 0 };
    const createsPartition = !this._partitionStats.has(key);
    if (createsPartition && this._partitionCount + 1 > this._maxPartitions) {
      throw new Error('Turn-event journal exceeds the runtime partition count limit');
    }
    if (stats.bytes + payloadBytes > this._maxPartitionBytes) {
      this._blockedPartitions.add(key);
      throw new Error('Turn-event journal partition exceeds the byte limit');
    }
    if (this._totalPartitionBytes + payloadBytes > this._maxStartupBytes) {
      throw new Error('Turn-event journal exceeds the runtime aggregate byte limit');
    }
    if (createsPartition) {
      fs.mkdirSync(path.dirname(partitionPath), { recursive: true });
    }
    fs.appendFileSync(partitionPath, payload, 'utf8');
    this._dirtyPaths.add(partitionPath);
    stats.records += 1;
    stats.bytes += payloadBytes;
    this._partitionStats.set(key, stats);
    if (createsPartition) {
      this._partitionCount += 1;
    }
    this._totalPartitionBytes += payloadBytes;
    if (
      stats.records >= this._compactionRecordLimit
      || stats.bytes >= this._compactionByteLimit
    ) {
      if (!this._compactPartition(sessionId, turnId, compactionEvents)) {
        this._blockedPartitions.add(key);
        throw new Error('Turn-event journal partition cannot be compacted within bounds');
      }
    }
    return partitionPath;
  }

  _compactPartition(sessionId, turnId, compactionEvents = null) {
    const events = compactionEvents == null
      ? this.list(sessionId, turnId)
      : cloneEvents(compactionEvents);
    const partitionPath = this._partitionPath(sessionId, turnId);
    const record = {
      schema_version: JOURNAL_SCHEMA_VERSION,
      session_id: sessionId,
      turn_id: turnId,
      op: 'snapshot',
      events,
    };
    const serialized = `${JSON.stringify(record)}\n`;
    const serializedBytes = Buffer.byteLength(serialized, 'utf8');
    if (serializedBytes > MAX_RECORD_BYTES) {
      this._log('WARN', 'turn_journal.compaction_bound_exceeded', {
        partition: hashIdentity(turnId).slice(0, 16),
        events: events.length,
      });
      return false;
    }
    const key = this._partitionKey(sessionId, turnId);
    const priorStats = this._partitionStats.get(key);
    const priorBytes = priorStats?.bytes || 0;
    const createsPartition = !fs.existsSync(partitionPath);
    if (createsPartition && this._partitionCount + 1 > this._maxPartitions) {
      return false;
    }
    if (this._totalPartitionBytes - priorBytes + serializedBytes > this._maxStartupBytes) {
      return false;
    }
    const tempPath = buildTempPath(partitionPath);
    fs.mkdirSync(path.dirname(partitionPath), { recursive: true });
    fs.writeFileSync(tempPath, serialized, 'utf8');
    this._fsyncPath(tempPath);
    fs.renameSync(tempPath, partitionPath);
    this._fsyncDirectory(path.dirname(partitionPath));
    this._dirtyPaths.delete(partitionPath);
    this._partitionStats.set(key, {
      records: 1,
      bytes: serializedBytes,
    });
    if (createsPartition) {
      this._partitionCount += 1;
    }
    this._totalPartitionBytes = this._totalPartitionBytes - priorBytes + serializedBytes;
    return true;
  }

  _restorePartition(sessionId, turnId, events) {
    try {
      this._setTurnEvents(sessionId, turnId, events);
      return this._compactPartition(sessionId, turnId, events);
    } catch (error) {
      this._blockedPartitions.add(this._partitionKey(sessionId, turnId));
      this._log('WARN', 'turn_journal.partition_rollback_failed', {
        partition: hashIdentity(turnId).slice(0, 16),
        errorCode: normalizeId(error?.code) || null,
      });
      return false;
    }
  }

  _deletePartition(sessionId, turnId) {
    this._ensureWritable(sessionId, turnId);
    const partitionPath = this._partitionPath(sessionId, turnId);
    const key = this._partitionKey(sessionId, turnId);
    const priorStats = this._partitionStats.get(key);
    const existed = fs.existsSync(partitionPath);
    const priorBytes = priorStats?.bytes
      ?? (existed ? fs.statSync(partitionPath).size : 0);
    if (existed) {
      fs.unlinkSync(partitionPath);
    }
    this._dirtyPaths.delete(partitionPath);
    this._partitionStats.delete(key);
    this._blockedPartitions.delete(key);
    if (existed) {
      this._partitionCount = Math.max(0, this._partitionCount - 1);
      this._totalPartitionBytes = Math.max(0, this._totalPartitionBytes - priorBytes);
    }
    const turns = this._turnsBySession.get(sessionId);
    turns?.delete(turnId);
    if (turns?.size === 0) {
      this._turnsBySession.delete(sessionId);
    }
    if (existed) {
      this._fsyncDirectory(path.dirname(partitionPath));
    }
    return existed;
  }

  _fsyncPath(filePath) {
    let handle = null;
    try {
      handle = fs.openSync(filePath, 'r+');
      fs.fsyncSync(handle);
      return true;
    } finally {
      if (handle != null) {
        fs.closeSync(handle);
      }
    }
  }

  _fsyncDirectory(directoryPath) {
    let handle = null;
    try {
      handle = fs.openSync(directoryPath, 'r');
      fs.fsyncSync(handle);
      return true;
    } catch (error) {
      // Windows does not expose directory fsync through Node. File fsync plus
      // atomic rename remains the strongest available barrier there.
      if (process.platform !== 'win32') {
        throw error;
      }
      this._log('DEBUG', 'turn_journal.directory_fsync_unavailable', {
        errorCode: normalizeId(error?.code) || null,
      });
      return false;
    } finally {
      if (handle != null) {
        fs.closeSync(handle);
      }
    }
  }

  append(sessionId, turnId, events) {
    const normalizedSessionId = normalizeId(sessionId);
    const normalizedTurnId = normalizeId(turnId);
    const sourceEvents = normalizeEvents(events);
    if (!normalizedSessionId || !normalizedTurnId || !sourceEvents.length) {
      return { appended: 0 };
    }
    // Merge against the stored array directly. Going through list() here would
    // deep-clone every event accumulated in the turn so far on every single
    // append, making journaling quadratic in events-per-turn on the main thread.
    const existing = this._peekTurnEvents(normalizedSessionId, normalizedTurnId);
    const existingLength = existing.length;
    const merged = this._mergeEvents(existing, sourceEvents);
    const appended = merged.length - existingLength;
    if (!appended) {
      return { appended: 0 };
    }
    const appendedEvents = merged.slice(existingLength);
    this._appendRecord(normalizedSessionId, normalizedTurnId, {
      op: 'append',
      events: appendedEvents,
    }, merged);
    // `merged` is a fresh array built from journal-private events, so storage
    // can take it as-is rather than cloning the whole turn a second time.
    this._adoptTurnEvents(normalizedSessionId, normalizedTurnId, merged);
    return { appended };
  }

  list(sessionId, turnId) {
    return cloneEvents(this._peekTurnEvents(normalizeId(sessionId), normalizeId(turnId)));
  }

  listAll() {
    const sessions = {};
    for (const [sessionId, turns] of this._turnsBySession.entries()) {
      const serializedTurns = {};
      for (const [turnId, events] of turns.entries()) {
        if (events.length) {
          serializedTurns[turnId] = cloneEvents(events);
        }
      }
      if (Object.keys(serializedTurns).length) {
        sessions[sessionId] = { turns: serializedTurns };
      }
    }
    return sessions;
  }

  // Scoped counterpart to listAll(): deep-clones only the requested session's
  // partitions instead of every session in the journal. Callers that only need
  // one session (e.g. computeInterruptedTurnReceipts on the chat.send hot path)
  // must use this instead of listAll()[sessionId] -- listAll() clones every
  // session's events on every call regardless of which one the caller keeps.
  // Reuses cloneEvents so mutation-safety semantics match listAll() exactly.
  listSession(sessionId) {
    const normalizedSessionId = normalizeId(sessionId);
    const turns = normalizedSessionId ? this._turnsBySession.get(normalizedSessionId) : null;
    if (!(turns instanceof Map)) {
      return {};
    }
    const serializedTurns = {};
    for (const [turnId, events] of turns.entries()) {
      if (events.length) {
        serializedTurns[turnId] = cloneEvents(events);
      }
    }
    return Object.keys(serializedTurns).length ? { turns: serializedTurns } : {};
  }

  purgeTurnsAfter(sessionId, survivingTurnIdSet, { commitResult = null, durable = false } = {}) {
    const normalizedSessionId = normalizeId(sessionId);
    if (!normalizedSessionId) {
      return { ok: false, purged: 0, durable: false, reason: 'invalid_session_id' };
    }
    if (commitResult && !hasDurableProof(commitResult)) {
      return { ok: false, purged: 0, durable: false, reason: 'invalid_commit_proof' };
    }
    if (durable && !commitResult) {
      return { ok: false, purged: 0, durable: false, reason: 'missing_commit_proof' };
    }
    const surviving = survivingTurnIdSet instanceof Set
      ? survivingTurnIdSet
      : new Set(Array.isArray(survivingTurnIdSet) ? survivingTurnIdSet : []);
    const turns = this._turnsBySession.get(normalizedSessionId);
    if (!(turns instanceof Map)) {
      return { ok: true, purged: 0, durable: true, reason: null };
    }
    const purgedEventsByTurn = new Map();
    let purged = 0;
    try {
      for (const [turnId, events] of turns.entries()) {
        if (surviving.has(turnId) || !events.length) {
          continue;
        }
        purgedEventsByTurn.set(turnId, events);
        this._deletePartition(normalizedSessionId, turnId);
        purged += 1;
      }
    } catch (_error) {
      for (const [turnId, events] of purgedEventsByTurn.entries()) {
        this._restorePartition(normalizedSessionId, turnId, events);
      }
      return { ok: false, purged, durable: false, reason: 'journal_write_failed' };
    }
    return { ok: true, purged, durable: durable, reason: null };
  }

  clear(sessionId, turnId, { commitResult = null } = {}) {
    const normalizedSessionId = normalizeId(sessionId);
    const normalizedTurnId = normalizeId(turnId);
    if (!normalizedSessionId || !normalizedTurnId) {
      return { ok: false, cleared: false, durable: false, reason: 'invalid_identity' };
    }
    if (!hasDurableProof(commitResult)) {
      return { ok: false, cleared: false, durable: false, reason: 'invalid_commit_proof' };
    }
    const existing = this.list(normalizedSessionId, normalizedTurnId);
    if (!existing.length) {
      return { ok: true, cleared: false, durable: true, reason: null };
    }
    try {
      this._deletePartition(normalizedSessionId, normalizedTurnId);
      return { ok: true, cleared: true, durable: true, reason: null };
    } catch (_error) {
      this._restorePartition(normalizedSessionId, normalizedTurnId, existing);
      return { ok: false, cleared: true, durable: false, reason: 'journal_write_failed' };
    }
  }

  _flushPaths(paths) {
    const uniquePaths = new Set(paths);
    for (const partitionPath of uniquePaths) {
      if (partitionPath && fs.existsSync(partitionPath)) {
        this._fsyncPath(partitionPath);
        this._dirtyPaths.delete(partitionPath);
      }
    }
    return true;
  }

  flush() {
    return this._flushPaths(Array.from(this._dirtyPaths));
  }

  async flushAsync() {
    return this.flush();
  }

  dispose() {
    this.flush();
  }

  async disposeAsync() {
    this.flush();
  }
}

module.exports = {
  JOURNAL_SCHEMA_VERSION,
  TurnEventJournal,
};
