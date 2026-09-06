'use strict';

// Shared temp-file + fsync + rename recipe over the injected fs facade
// (fs-facade.js). Every durable-write module in this tree (active-pointer,
// mutation-lease, operation-receipts, cleanup-state, journal) needs the exact
// same crash-safe sequence that services/backend/file-json-store.js already
// proved out for the non-plugin session store: write full content to a
// same-directory temp path, fsync the temp file, rename it over the real
// path, then best-effort fsync the directory. Centralizing it here means a
// fix to the recipe lands once, and each call site stays a one-line call
// instead of five.
//
// Nothing here decides WHAT is safe to write or WHEN -- that is domain policy
// owned by each store module. This module only knows how to get bytes onto
// (simulated) disk durably and how to read them back without throwing on
// expected conditions (missing file, corrupt JSON, a torn journal line).

const crypto = require('node:crypto');
const { joinPath } = require('./fs-facade');

function buildTempName(fileName) {
  return `${fileName}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

// Reads a JSON file and never throws: distinguishes "does not exist yet" from
// "exists but is not valid JSON" so callers can treat corruption as a fail-
// closed signal instead of an absence.
async function readJsonFile(facade, filePath) {
  let raw;
  try {
    raw = await facade.readFile(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { status: 'missing', value: null, error: null };
    }
    return { status: 'corrupted', value: null, error: error.message || String(error) };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw), error: null };
  } catch (parseError) {
    return { status: 'corrupted', value: null, error: parseError.message || String(parseError) };
  }
}

async function readTextFile(facade, filePath, defaultValue = '') {
  try {
    return await facade.readFile(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultValue;
    throw error;
  }
}

// First half of the recipe: get the full new content durably onto disk under a
// temp name, without touching the real path. On a failure during the temp-
// write/fsync steps the half-written temp file is best-effort cleaned up (never
// masking the original error). Split out from the rename so a caller that must
// re-check a precondition at the last possible instant (active-pointer.js's
// lease guard) can do so with only the atomic rename left to perform.
async function stageTextFile(facade, dirPath, fileName, text) {
  await facade.mkdir(dirPath);
  const filePath = joinPath(dirPath, fileName);
  const tempPath = joinPath(dirPath, buildTempName(fileName));
  try {
    await facade.writeFile(tempPath, text);
    await facade.fsyncFile(tempPath);
  } catch (error) {
    try {
      await facade.remove(tempPath);
    } catch (cleanupError) {
      void cleanupError;
    }
    throw error;
  }
  return { filePath, tempPath };
}

async function stageJsonFile(facade, dirPath, fileName, value) {
  return stageTextFile(facade, dirPath, fileName, JSON.stringify(value, null, 2));
}

// Second half: the single atomic call that publishes staged bytes, plus a
// best-effort directory fsync. A failed rename discards the unpublished temp
// file without masking the original error.
async function commitStagedFile(facade, dirPath, { filePath, tempPath }, { fsyncDirectory = true } = {}) {
  try {
    await facade.renameFile(tempPath, filePath);
  } catch (error) {
    await discardStagedFile(facade, { tempPath });
    throw error;
  }
  if (fsyncDirectory) {
    await facade.fsyncDir(dirPath);
  }
  return { filePath };
}

// Best-effort discard of staged bytes a caller decided not to publish.
async function discardStagedFile(facade, staged) {
  try {
    await facade.remove(staged.tempPath);
  } catch (error) {
    void error;
  }
}

// The crash-injectable sequence itself. Every step is a separate facade call
// so a wrapping (e.g. W4 crash-injecting) facade can fail between any two of
// them: mkdir -> write temp -> fsync temp -> rename -> fsync dir.
async function writeTextFileAtomic(facade, dirPath, fileName, text, options = {}) {
  const staged = await stageTextFile(facade, dirPath, fileName, text);
  return commitStagedFile(facade, dirPath, staged, options);
}

async function writeJsonFileAtomic(facade, dirPath, fileName, value, options = {}) {
  const payload = JSON.stringify(value, null, 2);
  return writeTextFileAtomic(facade, dirPath, fileName, payload, options);
}

// Bounded JSONL append via read-modify-write. This is intentionally NOT a
// true streaming append: the journal is degraded-observability evidence, not
// an authority or idempotency source (PLUG-D01/D15), so a read-modify-write
// that stays within the same crash-safe temp+rename recipe is an acceptable
// trade for correctness and simplicity over raw append throughput. `maxLines`
// bounds the journal so it can never grow without limit; the oldest lines are
// dropped first (ring-buffer semantics).
async function appendJsonLine(facade, dirPath, fileName, entry, { maxLines = 2000 } = {}) {
  const filePath = joinPath(dirPath, fileName);
  const raw = await readTextFile(facade, filePath, '');
  const { entries } = parseJsonLines(raw);
  entries.push(entry);
  const bounded = maxLines > 0 && entries.length > maxLines ? entries.slice(entries.length - maxLines) : entries;
  const text = bounded.map((item) => JSON.stringify(item)).join('\n') + (bounded.length ? '\n' : '');
  await writeTextFileAtomic(facade, dirPath, fileName, text);
  return { entryCount: bounded.length };
}

// Tolerant JSONL parse: a corrupt trailing line (partial write, bit rot) is
// skipped and counted rather than thrown, matching the journal's "never a
// competing authority" posture -- a malformed line must not make the whole
// evidence log unreadable.
function parseJsonLines(raw) {
  const lines = String(raw || '').split('\n').filter((line) => line.trim().length > 0);
  const entries = [];
  let corruptCount = 0;
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      void error;
      corruptCount += 1;
    }
  }
  return { entries, corruptCount };
}

async function readJsonLines(facade, dirPath, fileName) {
  const filePath = joinPath(dirPath, fileName);
  const raw = await readTextFile(facade, filePath, '');
  return parseJsonLines(raw);
}

module.exports = {
  buildTempName,
  readJsonFile,
  readTextFile,
  stageJsonFile,
  commitStagedFile,
  discardStagedFile,
  writeTextFileAtomic,
  writeJsonFileAtomic,
  appendJsonLine,
  readJsonLines,
  parseJsonLines,
};
