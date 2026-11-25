'use strict';

/* services/computer-use/owner-programs.js: the programs the owner added for computer use (row 196).
 *
 * One JSON file in Jenny's user-data folder:
 *   { "schema_version": 1, "programs": [ { "name": "...", "program": "C:\\...\\x.exe" } ] }
 * At most 100 entries. A file with an unknown schema or that does not parse reads as an empty list and is
 * never rewritten: `add` and `remove` refuse to touch it, so the owner's text is not lost to a bad read.
 * Every entry is checked again on every read, so a hand-edited file cannot smuggle in a relative path, a
 * `..` segment or a file that is not a program. All IO comes in as arguments. */

const { normalizeProgramPath } = require('./program-rules');

const SCHEMA_VERSION = 1;
const MAX_OWNER_PROGRAMS = 100;
const NAME_MAX = 120;
const PATH_MAX = 1024;

function isControlCode(code) { return code <= 0x1f || (code >= 0x7f && code <= 0x9f); }
/** True when the text holds a C0 or C1 control character. */
function hasControlChars(text) {
  for (let i = 0; i < text.length; i += 1) if (isControlCode(text.charCodeAt(i))) return true;
  return false;
}
/** The text without its C0 and C1 control characters. */
function stripControlChars(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) if (!isControlCode(text.charCodeAt(i))) out += text[i];
  return out;
}
// A drive path (`C:\...`) or a share path (`\\server\share\...`).
const ABSOLUTE_PATH = /^(?:[A-Za-z]:\\|\\\\[^\\/?*"<>|:]+\\[^\\/?*"<>|:]+\\)/;
// Characters Windows never allows in a file name; the drive colon is handled by the pattern above.
const BAD_FILE_CHARS = /[?*"<>|]/;

/** A clean name (control characters removed, trimmed), or '' when it is not 1-120 characters. */
function cleanProgramName(value) {
  if (typeof value !== 'string') return '';
  const text = stripControlChars(value).trim();
  return text.length >= 1 && text.length <= NAME_MAX ? text : '';
}

/** The program path as the owner wrote it (trimmed), or '' when it is not an absolute `.exe` path. */
function validProgramPath(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > PATH_MAX || hasControlChars(text)) return '';
  const slashed = text.replace(/\//g, '\\');
  if (slashed.startsWith('\\\\?\\') || slashed.startsWith('\\\\.\\')) return '';
  if (!ABSOLUTE_PATH.test(slashed) || BAD_FILE_CHARS.test(slashed.slice(2))) return '';
  if (slashed.split('\\').some((part) => part === '..' || part === '.')) return '';
  if (!slashed.toLowerCase().endsWith('.exe')) return '';
  return text;
}

/** @returns {{ name: string, program: string }|null} the entry cleaned, or null when it is not valid */
function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const name = cleanProgramName(entry.name);
  const program = validProgramPath(entry.program);
  return name && program ? { name, program } : null;
}

function createOwnerPrograms({ filePath, fs = require('fs'), writeJsonAtomic } = {}) {
  const writeFile = writeJsonAtomic || require('../backend/session-storage-fs-utils').writeJsonAtomicAsync;
  let queue = Promise.resolve();

  /** @returns {Promise<{ ok: boolean, programs: Array<{name: string, program: string}> }>} */
  async function readState() {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      return { ok: error?.code === 'ENOENT', programs: [] };
    }
    let data;
    try { data = JSON.parse(String(raw).replace(/^\uFEFF/, '')); } catch (_error) { return { ok: false, programs: [] }; }
    if (!data || typeof data !== 'object' || data.schema_version !== SCHEMA_VERSION || !Array.isArray(data.programs)) {
      return { ok: false, programs: [] };
    }
    const seen = new Set();
    const programs = [];
    for (const entry of data.programs) {
      const clean = cleanEntry(entry);
      if (!clean) continue;
      const key = normalizeProgramPath(clean.program);
      if (seen.has(key)) continue;
      seen.add(key);
      programs.push(clean);
      if (programs.length >= MAX_OWNER_PROGRAMS) break;
    }
    return { ok: true, programs };
  }

  async function save(programs) {
    await writeFile(filePath, { schema_version: SCHEMA_VERSION, programs });
  }

  // Writes run one at a time so two quick adds cannot overwrite each other.
  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function list() {
    return (await readState()).programs;
  }

  function add(entry) {
    return serialize(async () => {
      const clean = cleanEntry(entry);
      if (!clean) return { ok: false, reason: 'invalid' };
      const state = await readState();
      if (!state.ok) return { ok: false, reason: 'unreadable' };
      const key = normalizeProgramPath(clean.program);
      const index = state.programs.findIndex((item) => normalizeProgramPath(item.program) === key);
      if (index >= 0) state.programs[index] = clean;
      else if (state.programs.length >= MAX_OWNER_PROGRAMS) return { ok: false, reason: 'too_many' };
      else state.programs.push(clean);
      try { await save(state.programs); } catch (_error) { return { ok: false, reason: 'write_failed' }; }
      return { ok: true };
    });
  }

  function remove(program) {
    return serialize(async () => {
      if (typeof program !== 'string' || !program.trim()) return false;
      const state = await readState();
      if (!state.ok) return false;
      const key = normalizeProgramPath(program);
      const kept = state.programs.filter((item) => normalizeProgramPath(item.program) !== key);
      if (kept.length === state.programs.length) return false;
      try { await save(kept); } catch (_error) { return false; }
      return true;
    });
  }

  return { list, add, remove };
}

module.exports = {
  MAX_OWNER_PROGRAMS,
  cleanProgramName,
  createOwnerPrograms,
  hasControlChars,
  stripControlChars,
  validProgramPath,
};
