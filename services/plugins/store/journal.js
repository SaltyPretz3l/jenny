'use strict';

// The bounded `journal.jsonl` evidence log (PLUG-D01, PLUG-D15, "Durable
// generation commit" step 6). It is NEVER a competing authority and NEVER an
// idempotency source -- operation-receipts.js alone owns idempotency, and
// active-pointer.js alone owns authority. A journal write failure after a
// pointer commit is degraded observability, not an implicit rollback: callers
// must treat appendJournalEntry failures as non-fatal to the mutation that
// already committed.
//
// Every entry is tagged with a monotonic-within-process sequence number so
// readers can detect gaps (e.g. after compaction or a lost write) without the
// journal itself being trusted as the source of truth for what happened.

const { appendJsonLine, readJsonLines } = require('./json-file-io');

const JOURNAL_FILE = 'journal.jsonl';
const DEFAULT_MAX_ENTRIES = 2000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidEntryShape(entry) {
  return (
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && isNonEmptyString(entry.kind)
    && isNonEmptyString(entry.recorded_at)
  );
}

// Appends one evidence entry. Never throws for a domain reason (only a
// facade-level I/O failure propagates, which callers are expected to catch
// and log as degraded observability rather than fail their mutation).
async function appendJournalEntry(facade, baseDir, entry, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (!isValidEntryShape(entry)) {
    throw new Error("journal: entry must be an object with string 'kind' and 'recorded_at' fields");
  }
  return appendJsonLine(facade, baseDir, JOURNAL_FILE, entry, { maxLines: maxEntries });
}

// Tolerant read: a torn/corrupt trailing line is skipped and counted, never
// thrown, because the journal must remain readable evidence even when it is
// not perfectly well-formed.
async function readJournal(facade, baseDir) {
  const { entries, corruptCount } = await readJsonLines(facade, baseDir, JOURNAL_FILE);
  const validEntries = [];
  let malformedCount = corruptCount;
  for (const entry of entries) {
    if (isValidEntryShape(entry)) {
      validEntries.push(entry);
    } else {
      malformedCount += 1;
    }
  }
  return { entries: validEntries, malformedCount };
}

module.exports = {
  JOURNAL_FILE,
  DEFAULT_MAX_ENTRIES,
  appendJournalEntry,
  readJournal,
};
