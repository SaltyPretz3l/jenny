'use strict';

// Team boards T1 (row 151, plan PROJECT_BOARD_2026-11-13 sections 6.3 and 8.2): the host's journal of applied
// batches for one board. Pure: no IO, no clock.
//
//   { schema_version: 1, floor_rev, entries: [ { rev, batch_id, actor, at, applied, inverse } ] }
//
// - Oldest first, one entry per applied batch, `rev` the board's rev after it. Caps: LIMITS.journal_batches entries
//   and LIMITS.journal_bytes of entry JSON (board-model.js pushJournal does the arithmetic); the oldest go first and
//   `floor_rev` becomes the rev of the last one dropped. An entry over the byte cap alone is kept without its
//   inverse, then without its applied batch too.
// - `since` serves the batches after a rev only when it can serve all of them in order: below the floor, past the
//   head, across a hole or across an entry with no applied batch it answers `snapshot`. It never returns an inverse.
// - `hasBatch` says whether a batch id is among the entries. The store asks before it applies: the model's own
//   ring names the board's last 32 batch ids, the journal up to 200, so a batch sent again later than the ring
//   remembers is still answered as a duplicate while the journal holds it.
// - On load, a journal one entry short of its document (a crash between the two writes) raises `floor_rev` to the
//   document's rev, so `since` never serves a list with a hole; entries past the document's rev are dropped.

const model = require('../../../services/boards/board-model');

const JOURNAL_SCHEMA_VERSION = 1;
const ENTRY_KEYS = Object.freeze(['rev', 'batch_id', 'actor', 'at', 'applied', 'inverse']);
const JOURNAL_KEYS = Object.freeze(['schema_version', 'floor_rev', 'entries']);
const CAPS = Object.freeze({ batches: model.LIMITS.journal_batches, bytes: model.LIMITS.journal_bytes });
// The model's own token and ISO time rules (the model re-checks every batch actor with the same ones).
const { isIso, isToken } = model;

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const isRev = (v) => Number.isSafeInteger(v) && v >= 0;
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function emptyJournal(floorRev) {
  return { schema_version: JOURNAL_SCHEMA_VERSION, floor_rev: floorRev, entries: [] };
}

function validEntry(entry) {
  return isPlainObject(entry) && exactKeys(entry, ENTRY_KEYS) && isRev(entry.rev) && entry.rev > 0
    && isToken(entry.batch_id) && isToken(entry.actor) && isIso(entry.at)
    && (entry.applied === null || isPlainObject(entry.applied))
    && (entry.inverse === null || (isPlainObject(entry.inverse) && entry.applied !== null));
}

function validJournal(raw) {
  if (!isPlainObject(raw) || !exactKeys(raw, JOURNAL_KEYS) || raw.schema_version !== JOURNAL_SCHEMA_VERSION) return false;
  if (!isRev(raw.floor_rev) || !Array.isArray(raw.entries) || raw.entries.length > CAPS.batches) return false;
  let last = 0;
  for (const entry of raw.entries) {
    if (!validEntry(entry) || entry.rev <= last) return false;
    last = entry.rev;
  }
  return true;
}

/**
 * A stored journal read against its document's rev: { status: 'ok' | 'newer' | 'damaged', journal }. A newer
 * journal gives no journal (the caller refuses and never rewrites it); a damaged one starts empty at the document's
 * rev; a missing one is `readJournal(null, rev)` and starts the same way.
 */
function readJournal(raw, boardRev) {
  if (raw === null || raw === undefined) return { status: 'ok', journal: emptyJournal(boardRev) };
  const version = isPlainObject(raw) ? raw.schema_version : undefined;
  if (Number.isSafeInteger(version) && version > JOURNAL_SCHEMA_VERSION) return { status: 'newer', journal: null };
  if (!validJournal(raw)) return { status: 'damaged', journal: emptyJournal(boardRev) };
  const entries = raw.entries.filter((entry) => entry.rev <= boardRev);
  const last = entries.length ? entries[entries.length - 1].rev : raw.floor_rev;
  let floor = Math.min(raw.floor_rev, boardRev);
  if (entries.length !== raw.entries.length || last < boardRev) floor = boardRev;
  return { status: 'ok', journal: { schema_version: JOURNAL_SCHEMA_VERSION, floor_rev: floor, entries } };
}

/** The journal with one more entry, inside the caps; a new object (the input is not changed). */
function pushEntry(journal, entry) {
  let kept = entry;
  if (bytesOf(kept) > CAPS.bytes) kept = { ...kept, inverse: null };
  if (bytesOf(kept) > CAPS.bytes) kept = { ...kept, applied: null, inverse: null };
  const pushed = model.pushJournal(journal.entries, kept, CAPS);
  if (!pushed.ok) return emptyJournal(Math.max(journal.floor_rev, entry.rev));
  const combined = journal.entries.concat([kept]);
  const floor = pushed.dropped > 0 ? Math.max(journal.floor_rev, combined[pushed.dropped - 1].rev) : journal.floor_rev;
  return { schema_version: JOURNAL_SCHEMA_VERSION, floor_rev: floor, entries: pushed.journal };
}

/**
 * The batches after `afterRev` up to the board's `rev`, paged under `maxBytes` of JSON: { snapshot: false, batches,
 * more } or { snapshot: true }. A first batch alone over `maxBytes` is a snapshot too (no page could carry it).
 */
function since(journal, boardRev, afterRev, maxBytes) {
  if (afterRev < journal.floor_rev || afterRev > boardRev) return { snapshot: true };
  const range = journal.entries.filter((entry) => entry.rev > afterRev);
  let expect = afterRev + 1;
  for (const entry of range) {
    if (entry.rev !== expect || entry.applied === null) return { snapshot: true };
    expect += 1;
  }
  if (expect !== boardRev + 1) return { snapshot: true };
  const batches = [];
  let used = 2;
  let more = false;
  for (const entry of range) {
    const item = { rev: entry.rev, batch_id: entry.batch_id, actor: entry.actor, at: entry.at, applied: entry.applied };
    const size = bytesOf(item) + (batches.length ? 1 : 0);
    if (used + size > maxBytes) {
      more = true;
      break;
    }
    batches.push(item);
    used += size;
  }
  if (more && batches.length === 0) return { snapshot: true };
  return { snapshot: false, batches, more };
}

const RESTORED = Object.freeze({ 'card.add': 'card', 'connector.add': 'connector', 'group.add': 'group' });
// What the model keeps from a restore as the batch gives it, and only the host's own record may vouch for.
const HOST_FIELDS = Object.freeze(['created_by', 'created_at', 'geo_rev', 'content_rev', 'alias']);

/** The item a restore (`card.add`, `connector.add` or `group.add` with `restore: true`) brings back, or null. */
function restoredItem(op) {
  if (!isPlainObject(op) || op.restore !== true || !Object.hasOwn(RESTORED, op.op)) return null;
  const item = op[RESTORED[op.op]];
  return isPlainObject(item) && typeof item.id === 'string' ? item : null;
}

/**
 * A batch's operations with the host's own word for what a restore brings back. A `restore: true` add (the undo of
 * a removal) makes the model keep the item's creator, its creation time, its revisions and its short name as the
 * batch gives them; on the host a member's word for those is never kept (a revision at the integer ceiling makes
 * the next move write a document nothing can read; the highest short name stops every later add). They are replaced
 * by what the journal recorded when that item was removed (the newest such record, and for a card only one of the
 * same kind), or dropped when the journal no longer holds that removal: the item then counts as made now by the
 * member who restored it, at revision 0, under the next short name. Anything else in the batch is returned as it
 * came.
 */
function withHostAttribution(journal, ops) {
  if (!Array.isArray(ops) || !ops.some(restoredItem)) return ops;
  const recorded = new Map();
  for (let at = journal.entries.length - 1; at >= 0; at -= 1) {
    const undo = journal.entries[at].inverse?.ops;
    for (const op of Array.isArray(undo) ? undo : []) {
      const item = restoredItem(op);
      if (item && !recorded.has(`${op.op}:${item.id}`)) recorded.set(`${op.op}:${item.id}`, item);
    }
  }
  return ops.map((op) => {
    const given = restoredItem(op);
    if (!given) return op;
    const item = { ...given };
    for (const field of HOST_FIELDS) delete item[field];
    const known = recorded.get(`${op.op}:${item.id}`);
    if (known && known.kind === item.kind) {
      for (const field of HOST_FIELDS) if (known[field] !== undefined) item[field] = known[field];
    }
    return { ...op, [RESTORED[op.op]]: item };
  });
}

// A batch id only the host writes: a revert (`revert-<the rev it takes back>-<id>`) or an accepted proposal. A
// member's batch may not carry one (board-commands.js), so `history` can trust what an id says.
const HOST_BATCH_PREFIXES = Object.freeze(['revert-', 'proposal-']);
const REVERT_OF_RE = /^revert-(\d{1,15})-/u;
const OP_NAME_RE = /^[a-z]{1,16}\.[a-z_]{1,16}$/u;
const isHostBatchId = (value) => typeof value === 'string' && HOST_BATCH_PREFIXES.some((prefix) => value.startsWith(prefix));

/**
 * The journal as a list people can read, newest first (slice T9): for each batch its rev, actor and time, how it
 * came (`kind`: 'change', 'proposal' for an accepted proposal, 'revert' with the rev it took back in `of_rev`), how
 * many operations of each name it applied (`ops`, null when the entry no longer holds them), whether its way back
 * is still held (`takeable`) and whether a later batch took it back (`reverted`). Counts only: no board text.
 */
function history(journal) {
  const taken = new Set();
  const changes = journal.entries.map((entry) => {
    const of = REVERT_OF_RE.exec(entry.batch_id);
    const ofRev = of ? Number(of[1]) : null;
    if (ofRev !== null) taken.add(ofRev);
    let ops = null;
    if (Array.isArray(entry.applied?.ops)) {
      ops = {};
      for (const op of entry.applied.ops) {
        if (typeof op?.op === 'string' && OP_NAME_RE.test(op.op)) ops[op.op] = (ops[op.op] ?? 0) + 1;
      }
    }
    const kind = entry.batch_id.startsWith('revert-') ? 'revert' : (entry.batch_id.startsWith('proposal-') ? 'proposal' : 'change');
    return { rev: entry.rev, actor: entry.actor, at: entry.at, kind, of_rev: ofRev, ops, takeable: Boolean(entry.inverse) };
  });
  return changes.reverse().map((change) => ({ ...change, reverted: taken.has(change.rev) }));
}

/** True while the journal holds a batch with this id. */
function hasBatch(journal, batchId) {
  return journal.entries.some((entry) => entry.batch_id === batchId);
}

/** The entry with `rev`, inverse included, or null. */
function findEntry(journal, rev) {
  return journal.entries.find((entry) => entry.rev === rev) ?? null;
}

module.exports = {
  CAPS, JOURNAL_SCHEMA_VERSION, emptyJournal, findEntry, hasBatch, history, isHostBatchId, isIso, isToken, pushEntry,
  readJournal, since, withHostAttribution,
};
