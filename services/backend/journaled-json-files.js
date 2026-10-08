'use strict';

// File-level helpers of JournaledJsonStore: journal naming on disk, epoch
// discovery and reading a base file with its journals replayed.

const fs = require('fs');
const path = require('path');
const { FileJsonStore } = require('./file-json-store');
const { readFileWithRetry, unreadableReadResult } = require('./file-read-retry');
const { journalFileName, parseJournalFileName, replayJournal } = require('./session-journal');

const EPOCH_KEY = 'journal_epoch';
const EPOCH_PREFIX_BYTES = 64;
// Tolerates the whitespace of a pretty-printed (non-compact) base file.
const EPOCH_PREFIX_PATTERN = /^\{\s*"journal_epoch"\s*:\s*(\d+)\s*[,}]/;
const STATUS_RANK = { none: 0, ok: 1, torn_tail: 2, corrupt: 3 };

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function closeQuietly(fd) {
  try {
    fs.closeSync(fd);
  } catch (closeError) {
    void closeError;
  }
}

function logSafe(logger, level, event, details) {
  if (!logger) return;
  try {
    logger(level, event, details);
  } catch (loggerError) {
    void loggerError;
  }
}

function stemOf(filePath) {
  const name = path.basename(filePath);
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}

function journalPathOf(filePath, epoch) {
  return path.join(path.dirname(filePath), journalFileName(stemOf(filePath), epoch));
}

function listJournalEpochs(filePath) {
  let names;
  try {
    names = fs.readdirSync(path.dirname(filePath));
  } catch (listError) {
    void listError;
    return [];
  }
  const stem = stemOf(filePath);
  const epochs = [];
  for (const name of names) {
    const parsed = parseJournalFileName(name);
    if (parsed && parsed.stem === stem) epochs.push(parsed.epoch);
  }
  return epochs;
}

// Everything in the envelope except the journaled payload and the epoch. Any
// change here cannot be expressed as a journal delta, so it forces a base write.
function envelopeRestJson(value, payloadKey) {
  const rest = {};
  for (const key of Object.keys(value)) {
    if (key === payloadKey || key === EPOCH_KEY) continue;
    Object.defineProperty(rest, key, { value: value[key], enumerable: true, writable: true, configurable: true });
  }
  return JSON.stringify(rest);
}

// Epoch of the base on disk from its first bytes only; the file can be large.
// 0 for a base without an epoch. Throws when the file cannot be opened or read.
function readBaseEpochOrThrow(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(EPOCH_PREFIX_BYTES);
    const read = fs.readSync(fd, buffer, 0, EPOCH_PREFIX_BYTES, 0);
    const match = EPOCH_PREFIX_PATTERN.exec(buffer.toString('latin1', 0, read));
    const epoch = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(epoch) ? epoch : 0;
  } finally {
    closeQuietly(fd);
  }
}

// As above, with 0 for a missing or unreadable base.
function readBaseEpochPrefix(filePath) {
  try {
    return readBaseEpochOrThrow(filePath);
  } catch (readError) {
    void readError;
    return 0;
  }
}

// ---- Reading ----------------------------------------------------------------

function loadJournal(ctx, epoch, session) {
  let buffer;
  try {
    buffer = readFileWithRetry(journalPathOf(ctx.filePath, epoch), { encoding: null });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'absent' };
    // The journal exists but could not be read. Skipping it would serve the
    // base alone as if it were the whole value, and the next write would then
    // discard everything the journal holds: the whole read is unreadable.
    return { status: 'unreadable', error };
  }
  const result = replayJournal(session, buffer, { sessionId: ctx.journalId, epoch });
  const details = { filePath: ctx.filePath, epoch, status: result.status };
  if (result.status === 'header_mismatch') logSafe(ctx.logger, 'WARN', 'store.journal_ignored', details);
  if (result.status === 'corrupt') {
    logSafe(ctx.logger, 'ERROR', 'store.journal_corrupt', { ...details, validBytes: result.validBytes });
  }
  return result;
}

// The read result for a value whose journal exists but could not be read: the
// same `unreadable` shape FileJsonStore gives for an unreadable base, so callers
// leave the files alone and try again later.
function unreadableJournalResult(ctx, epoch, error) {
  logSafe(ctx.logger, 'WARN', 'store.journal_unreadable', {
    filePath: ctx.filePath, epoch, errorCode: (error && error.code) || null,
  });
  return {
    ...unreadableReadResult(journalPathOf(ctx.filePath, epoch), error, ctx.defaultValue, null),
    journalStatus: 'unreadable',
  };
}

// Journal processing shared by instance reads and the static readFile. `served`
// is a FileJsonStore disk result and is returned (mutated) with journalStatus.
function replayJournals(served, ctx) {
  served.journalStatus = 'none';
  ctx.baseEpoch = 0;
  if (served.missing || served.corrupted || !isPlainObject(served.value)) return served;
  const envelope = served.value;
  const epochValue = envelope[EPOCH_KEY];
  delete envelope[EPOCH_KEY];
  const payload = envelope[ctx.payloadKey];
  // A base with epoch 0 (not written by this class) never has a journal replayed.
  if (!isPlainObject(payload) || !Number.isInteger(epochValue) || epochValue < 1) return served;

  ctx.baseEpoch = epochValue;
  let session = payload;
  let worst = 'none';
  const adopt = (result) => {
    session = result.session;
    if (STATUS_RANK[result.status] > STATUS_RANK[worst]) worst = result.status;
  };
  const adoptable = (result) => result.status === 'ok' || result.status === 'torn_tail' || result.status === 'corrupt';

  const own = loadJournal(ctx, epochValue, session);
  if (own.status === 'unreadable') return unreadableJournalResult(ctx, epochValue, own.error);
  if (adoptable(own)) adopt(own);
  const ownComplete = own.status === 'absent' || own.status === 'ok';

  // Journal E+1 only exists on top of base E when base E+1 was lost. It holds
  // deltas relative to base E+1, so it applies after journal E only if that
  // base equalled the end of journal E (`continues`) and journal E was intact.
  const next = loadJournal(ctx, epochValue + 1, session);
  if (next.status === 'unreadable') return unreadableJournalResult(ctx, epochValue + 1, next.error);
  if (adoptable(next)) {
    if (next.continues === true && ownComplete) {
      adopt(next);
    } else {
      logSafe(ctx.logger, 'WARN', 'store.journal_ignored', {
        filePath: ctx.filePath,
        epoch: epochValue + 1,
        status: next.status,
        reason: next.continues === true ? 'previous_journal_incomplete' : 'not_continuation',
      });
    }
  }
  envelope[ctx.payloadKey] = session;
  served.journalStatus = worst;
  return served;
}

// Base and journals are separate reads. If another writer replaced the base
// in between (its epoch on disk is no longer the one that was read), the pieces
// do not belong together: read again, and give up as unreadable rather than
// return a mix.
function replayStable(readBase, ctx) {
  for (let attempt = 0; ; attempt += 1) {
    const served = replayJournals(readBase(), ctx);
    if (ctx.baseEpoch === 0 || served.unreadable || readBaseEpochPrefix(ctx.filePath) === ctx.baseEpoch) {
      return served;
    }
    if (attempt >= 1) {
      const error = Object.assign(new Error('base file replaced during read'), { code: 'EBASECHANGED' });
      return unreadableJournalResult(ctx, ctx.baseEpoch, error);
    }
  }
}

function readContext(filePath, options) {
  const { payloadKey, journalId, logger, defaultValue } = options || {};
  if (typeof payloadKey !== 'string' || payloadKey === '' || payloadKey === EPOCH_KEY || payloadKey === '__proto__') {
    throw new TypeError('JournaledJsonStore needs a payloadKey string');
  }
  if (journalId !== undefined && typeof journalId !== 'string') {
    throw new TypeError('JournaledJsonStore journalId must be a string');
  }
  return {
    filePath,
    payloadKey,
    journalId: journalId === undefined ? stemOf(filePath) : journalId,
    logger: typeof logger === 'function' ? logger : null,
    defaultValue,
  };
}

// A base file plus its journals, as a FileJsonStore read result with
// `journalStatus`. Creates no timers and keeps no state.
function readJournaledFile(filePath, options) {
  const ctx = readContext(filePath, options);
  const base = new FileJsonStore(filePath, { logger: ctx.logger });
  return replayStable(() => base.readWithStatus(ctx.defaultValue), ctx);
}

function deleteJournalFiles(filePath) {
  for (const epoch of listJournalEpochs(filePath)) {
    try {
      fs.unlinkSync(journalPathOf(filePath, epoch));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = {
  EPOCH_KEY,
  closeQuietly,
  deleteJournalFiles,
  envelopeRestJson,
  isPlainObject,
  journalPathOf,
  listJournalEpochs,
  logSafe,
  readBaseEpochOrThrow,
  readBaseEpochPrefix,
  readContext,
  readJournaledFile,
  replayStable,
};
