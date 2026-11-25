'use strict';

/* services/computer-use/program-finder.js: find a program by name and start it (row 196).
 *
 * Three sources, in order of trust: the owner's own list, Start menu shortcuts, Store apps. `find` returns
 * at most five matches and nothing more: whether a program may be granted is not decided here (the grant
 * gate judges the program file, and programs the rules call `never` are returned like any other so that the
 * gate can say why it refuses them). `launch` starts only what `find` returned in this process, by the id
 * `find` put on the match; the name, the program and the AUMID the caller sends back are ignored.
 *
 * Every Electron or OS call is injected: `readShortcutLink` (Electron `shell.readShortcutLink`),
 * `openPath` (`shell.openPath`, resolves '' on success), `spawnDetached` (starts a process without a
 * shell), and `fs`. Names, titles and paths are never logged and never put in a command. */

const path = require('node:path');
const { normalizeProgramPath } = require('./program-rules');
const { cleanProgramName, stripControlChars, validProgramPath } = require('./owner-programs');
const { AUMID_PATTERN } = require('./start-apps');

const MAX_MATCHES = 5;
const MAX_RETURNED = 200;
const QUERY_MAX = 120;
const SCAN_MAX_DEPTH = 4;
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_FOLDERS = 500;
const YIELD_EVERY = 50;
const SOURCE_TRUST = Object.freeze({ owner: 0, start_menu: 1, store: 2 });

function cleanQuery(value) {
  if (typeof value !== 'string') return '';
  const text = stripControlChars(value).trim();
  return text.length >= 1 && text.length <= QUERY_MAX ? text : '';
}

function isWordStart(text, index) {
  return index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]);
}

/** 3 exact, 2 starts with, 1 a word of the name starts with the query, 0 no match. Case-insensitive. */
function scoreName(candidateName, query) {
  const name = candidateName.toLowerCase();
  const wanted = query.toLowerCase();
  if (name === wanted) return 3;
  if (name.startsWith(wanted)) return 2;
  for (let i = 1; i < name.length; i += 1) {
    if (isWordStart(name, i) && /[\p{L}\p{N}]/u.test(name[i]) && name.startsWith(wanted, i)) return 1;
  }
  return 0;
}

function absoluteFolder(value) {
  return typeof value === 'string' && /^(?:[A-Za-z]:\\|\\\\)/.test(value) ? value : '';
}

function yieldToEventLoop() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function createProgramFinder({
  ownerPrograms,
  startApps,
  readShortcutLink,
  fs = require('fs'),
  env = process.env,
  openPath,
  spawnDetached,
  now = Date.now,
  shortcutTtlMs = 300000,
} = {}) {
  const returned = new Map(); // id -> { name, program, source, aumid }
  let counter = 0;
  let shortcutCache = null; // { entries, expires }
  let shortcutScan = null;
  let generation = 0;

  const systemRoot = absoluteFolder(env.SystemRoot) || 'C:\\Windows';
  const explorerPath = path.win32.join(systemRoot, 'explorer.exe');

  async function isFile(file) {
    try { return (await fs.promises.stat(file)).isFile(); } catch (_error) { return false; }
  }

  async function readShortcut(lnkPath) {
    let target;
    try { target = readShortcutLink(lnkPath)?.target; } catch (_error) { return null; }
    const program = validProgramPath(target);
    if (!program || !(await isFile(program))) return null;
    const base = path.win32.basename(lnkPath);
    const name = cleanProgramName(base.slice(0, -'.lnk'.length));
    return name ? { name, program } : null;
  }

  // Breadth first over both Start menu folders, within the folder depth, folder count and file limits.
  async function scanShortcuts() {
    const roots = [env.ProgramData, env.APPDATA].map(absoluteFolder).filter(Boolean)
      .map((root) => path.win32.join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    const queue = roots.map((dir) => ({ dir, depth: 0 }));
    const entries = [];
    let files = 0;
    let folders = 0;
    for (let next = 0; next < queue.length && folders < SCAN_MAX_FOLDERS && files < SCAN_MAX_FILES; next += 1) {
      const { dir, depth } = queue[next];
      folders += 1;
      let items;
      try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_error) { continue; }
      for (const item of items) {
        if (files >= SCAN_MAX_FILES) break;
        const full = path.win32.join(dir, item.name);
        if (item.isDirectory() || item.isSymbolicLink()) {
          if (depth >= SCAN_MAX_DEPTH) continue;
          try {
            const info = await fs.promises.lstat(full);
            if (info.isDirectory() && !info.isSymbolicLink()) queue.push({ dir: full, depth: depth + 1 });
          } catch (_error) { /* gone or unreadable */ }
        } else if (item.isFile()) {
          files += 1;
          if (!item.name.toLowerCase().endsWith('.lnk')) continue;
          const entry = await readShortcut(full);
          if (entry) entries.push(entry);
          if (files % YIELD_EVERY === 0) await yieldToEventLoop();
        }
      }
    }
    return entries;
  }

  function shortcuts() {
    if (shortcutCache && now() < shortcutCache.expires) return Promise.resolve(shortcutCache.entries);
    if (!shortcutScan) {
      const mine = generation;
      shortcutScan = scanShortcuts().catch(() => []).then((entries) => {
        if (mine === generation) shortcutCache = { entries, expires: now() + shortcutTtlMs };
        return entries;
      }).finally(() => { if (mine === generation) shortcutScan = null; });
    }
    return shortcutScan;
  }

  function refresh() {
    generation += 1;
    shortcutCache = null;
    shortcutScan = null;
    try { startApps?.clear?.(); } catch (_error) { /* a cache that will not clear is only stale */ }
  }

  async function safeList(source) {
    try {
      const list = await source();
      return Array.isArray(list) ? list : [];
    } catch (_error) {
      return [];
    }
  }

  async function candidates() {
    const [owner, menu, store] = await Promise.all([
      safeList(() => ownerPrograms.list()),
      safeList(() => shortcuts()),
      safeList(() => startApps.list()),
    ]);
    const out = [];
    for (const item of owner) {
      const name = cleanProgramName(item?.name);
      const program = validProgramPath(item?.program);
      if (name && program) out.push({ name, program, source: 'owner' });
    }
    for (const item of menu) out.push({ name: item.name, program: item.program, source: 'start_menu' });
    for (const item of store) {
      const name = cleanProgramName(item?.name);
      const aumid = typeof item?.aumid === 'string' && AUMID_PATTERN.test(item.aumid) ? item.aumid : '';
      if (name && aumid) out.push({ name, program: validProgramPath(item.program) || null, source: 'store', aumid });
    }
    return out;
  }

  function remember(entry) {
    counter += 1;
    const id = `pf${counter}`;
    returned.set(id, entry);
    while (returned.size > MAX_RETURNED) returned.delete(returned.keys().next().value);
    return id;
  }

  async function find(name) {
    const query = cleanQuery(name);
    if (!query) return [];
    const scored = [];
    for (const candidate of await candidates()) {
      const score = scoreName(candidate.name, query);
      if (score > 0) scored.push({ ...candidate, score });
    }
    // One entry per program file, the most trusted source (then the better match) kept.
    const byProgram = new Map();
    const unique = [];
    for (const item of scored) {
      if (!item.program) { unique.push(item); continue; }
      const key = normalizeProgramPath(item.program);
      const held = byProgram.get(key);
      if (!held) { byProgram.set(key, item); unique.push(item); continue; }
      const better = SOURCE_TRUST[item.source] < SOURCE_TRUST[held.source]
        || (item.source === held.source && item.score > held.score);
      if (better) { unique[unique.indexOf(held)] = item; byProgram.set(key, item); }
    }
    unique.sort((a, b) => b.score - a.score
      || SOURCE_TRUST[a.source] - SOURCE_TRUST[b.source]
      || a.name.length - b.name.length
      || a.name.localeCompare(b.name));
    return unique.slice(0, MAX_MATCHES).map((item) => {
      const id = remember({ name: item.name, program: item.program, source: item.source, aumid: item.aumid });
      return { id, name: item.name, program: item.program, source: item.source };
    });
  }

  async function launch(match) {
    const id = match && typeof match === 'object' ? match.id : undefined;
    const entry = typeof id === 'string' ? returned.get(id) : undefined;
    if (!entry) return { ok: false, reason: 'invalid' };
    if (entry.source === 'store') {
      if (!AUMID_PATTERN.test(String(entry.aumid))) return { ok: false, reason: 'invalid' };
      try {
        await spawnDetached(explorerPath, [`shell:AppsFolder\\${entry.aumid}`]);
      } catch (_error) {
        return { ok: false, reason: 'failed' };
      }
      return { ok: true };
    }
    const program = validProgramPath(entry.program);
    if (!program) return { ok: false, reason: 'invalid' };
    if (!(await isFile(program))) return { ok: false, reason: 'not_found' };
    try {
      return (await openPath(program)) === '' ? { ok: true } : { ok: false, reason: 'failed' };
    } catch (_error) {
      return { ok: false, reason: 'failed' };
    }
  }

  return { find, launch, refresh };
}

module.exports = {
  MAX_MATCHES,
  MAX_RETURNED,
  SCAN_MAX_DEPTH,
  SCAN_MAX_FILES,
  createProgramFinder,
  scoreName,
};
