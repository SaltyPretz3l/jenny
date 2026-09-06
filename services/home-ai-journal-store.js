'use strict';

const path = require('path');
const { FileJsonStore } = require('./backend/file-json-store');
const { normalizeString } = require('./backend/path-utils');

// Attribution/undo journal for assistant-made Home mutations.
//
// Every write Jenny makes to the Home surfaces (calendar events, proactive
// reminders) appends one entry here alongside the entity's own
// `sourceKind: 'assistant'` stamp. The entry carries the INVERSE operation
// plus a `postHash` fingerprint of the entity as Jenny left it, so a later
// one-click undo can prove the user has not edited the record since — an undo
// must restore what Jenny changed, never clobber a subsequent human edit.
//
// Retention is a small ring: at most MAX_LIVE_ENTRIES undoable ("live")
// entries, FIFO-evicted. Superseded/undone entries are kept as history until
// the hard MAX_TOTAL_ENTRIES bound, which keeps the file trivially small and
// removes any need for compaction.
const JOURNAL_STORE_FILE = 'home-ai-journal.json';
const JOURNAL_STORE_VERSION = 1;
const MAX_LIVE_ENTRIES = 20;
const MAX_TOTAL_ENTRIES = 60;
const MAX_JOURNAL_LABEL_CHARS = 200;
const JOURNAL_ENTITIES = Object.freeze(['calendar_event', 'reminder']);
const JOURNAL_OPS = Object.freeze(['create', 'update', 'delete']);
const JOURNAL_INVERSE_KINDS = Object.freeze(['delete', 'restore', 'update']);

function isLiveEntry(entry) {
  return !entry.undoneAt && !entry.supersededAt;
}

// Pure over its input: retention runs against a candidate array so a caller can
// persist the result BEFORE adopting it as the in-memory ring.
function evictEntries(entries) {
  let next = entries.slice();
  const live = next.filter((entry) => isLiveEntry(entry));
  while (live.length > MAX_LIVE_ENTRIES) {
    const oldest = live.shift();
    next = next.filter((entry) => entry !== oldest);
  }
  if (next.length > MAX_TOTAL_ENTRIES) {
    next = next.slice(next.length - MAX_TOTAL_ENTRIES);
  }
  return next;
}

function normalizeInverse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = value;
  const kind = normalizeString(source.kind);
  if (!JOURNAL_INVERSE_KINDS.includes(kind)) {
    return null;
  }
  const payload = source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
    ? source.payload
    : null;
  if ((kind === 'restore' || kind === 'update') && !payload) {
    return null;
  }
  return {
    kind,
    payload,
  };
}

function normalizeEntry(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = normalizeString(source.id);
  const entity = normalizeString(source.entity);
  const entityId = normalizeString(source.entityId);
  const op = normalizeString(source.op);
  const inverse = normalizeInverse(source.inverse);
  if (!id || !entityId || !JOURNAL_ENTITIES.includes(entity) || !JOURNAL_OPS.includes(op) || !inverse) {
    return null;
  }
  return {
    id,
    at: normalizeString(source.at),
    entity,
    entityId,
    op,
    label: normalizeString(source.label).slice(0, MAX_JOURNAL_LABEL_CHARS),
    sessionId: normalizeString(source.sessionId),
    inverse,
    postHash: typeof source.postHash === 'string' ? source.postHash : 'null',
    undoneAt: normalizeString(source.undoneAt),
    supersededAt: normalizeString(source.supersededAt),
  };
}

class HomeAiJournalStore {
  constructor({ userDataPath, store, logger = () => {} } = {}) {
    if (!store && !userDataPath) {
      throw new Error('userDataPath (or an injected store) is required for HomeAiJournalStore.');
    }
    this.store = store || new FileJsonStore(path.join(userDataPath, JOURNAL_STORE_FILE), { logger });
    const raw = this.store.read({});
    this.entries = (Array.isArray(raw?.entries) ? raw.entries : [])
      .map((entry) => normalizeEntry(entry))
      .filter(Boolean)
      .slice(-MAX_TOTAL_ENTRIES);
    this._idCounter = 0;
  }

  list() {
    return this.entries.map((entry) => ({ ...entry, inverse: { ...entry.inverse } }));
  }

  find(entryId) {
    const id = normalizeString(entryId);
    return id ? this.entries.find((entry) => entry.id === id) || null : null;
  }

  nextId(now) {
    this._idCounter += 1;
    return `jnl_${now.getTime().toString(36)}_${this._idCounter.toString(36)}`;
  }

  // Appending for an entity supersedes that entity's earlier live entry: only
  // the newest write to a record is undoable, so an undo can never rewind past
  // a change the model made afterwards.
  //
  // Persist-then-swap, never mutate-then-persist: the supersede stamps and the
  // new entry are built on COPIES, written to disk, and only adopted as
  // `this.entries` once the write returned. A throwing store therefore leaves
  // memory byte-identical to disk instead of stranding an in-memory
  // `supersededAt` that no persisted entry justifies.
  append(entry, now) {
    const normalized = normalizeEntry(entry);
    if (!normalized) {
      throw new Error('home journal entry is malformed');
    }
    const stampedAt = now.toISOString();
    const candidate = this.entries.map((existing) => (
      existing.entity === normalized.entity
        && existing.entityId === normalized.entityId
        && isLiveEntry(existing)
        ? { ...existing, inverse: { ...existing.inverse }, supersededAt: stampedAt }
        : existing
    ));
    candidate.push(normalized);
    const next = evictEntries(candidate);
    this._persist(next);
    this.entries = next;
    return normalized;
  }

  // Deliberately NOT persist-then-swap like append: the inverse operation has
  // already been applied to the entity by the time this runs, so if the write
  // fails the safe in-memory state is "undone" — an entry that stayed live
  // would let the session undo the same change twice.
  markUndone(entryId, now) {
    const entry = this.find(entryId);
    if (!entry) {
      return null;
    }
    entry.undoneAt = now.toISOString();
    this._persist(this.entries);
    return entry;
  }

  _persist(entries) {
    this.store.writeImmediate({ version: JOURNAL_STORE_VERSION, entries });
  }
}

module.exports = {
  MAX_LIVE_ENTRIES,
  HomeAiJournalStore,
};
