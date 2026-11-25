'use strict';

/*
 * run-command-store.js — the project's run command (row 197, "The run
 * command" and "Where the command is kept").
 *
 * One command per project, set and confirmed only by the owner. Under D5 A the
 * model may restart a confirmed command with no card, so a confirmation is a
 * standing permission and is bound to exactly what the owner looked at:
 *
 *   - the project id, root id, root revision and worktree it was confirmed
 *     for. Any change (a rebound folder, a new revision, a chat in another
 *     worktree) reads back as needs_confirmation, never confirmed;
 *   - a profile restore marks every command needs_confirmation (invalidateAll);
 *   - deleting the project deletes its command.
 *
 * The store lives in its own versioned file under the user data folder: not
 * in the project record (closed key set) and not in the portable preferences,
 * so it never travels in an export. A file from a newer Jenny is read as empty
 * and never overwritten; a damaged file or an entry that does not validate
 * reads as no command (asking again is the safe direction). Nothing that the
 * model can call writes here; the owner's confirm control is the only writer.
 *
 * Containment of `cwd` and `watch` here is by text (relative, no `..`); the
 * run service checks the real path against the root before every start.
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');
const { normalizeEnv } = require('../mcp-config-store');

const RUN_COMMAND_SCHEMA_VERSION = 1;
const RUN_COMMANDS_FILENAME = 'run-commands.json';
const DEFAULT_MAX_PROJECTS = 256;
const MAX_BUILD_CHARS = 2000;
const MAX_TEXT_CHARS = 1024;
const MAX_ID_CHARS = 200;
const MAX_ARGS = 64;
const MAX_WATCH = 16;
const COMMAND_KEYS = new Set(['build', 'program', 'args', 'cwd', 'env', 'watch']);
const INVALIDATION_REASONS = new Set(['restore']);
const CONTROL_RE = /\p{Cc}/u;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max) {
  return typeof value === 'string' && value.length <= max && !CONTROL_RE.test(value);
}

// A folder inside the project, by text: relative, no drive, no `..` segment.
function relativeInside(value, { allowEmpty }) {
  if (!cleanText(value, MAX_TEXT_CHARS)) return false;
  if (value === '') return allowEmpty;
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return value.split(/[\\/]/).every((segment) => segment !== '..');
}

// On Windows a path with a root but no drive or share (one leading slash or backslash) counts as absolute to
// Node, but the helper refuses it: such a program is refused when it is confirmed and again before it starts.
const UNANCHORED_RE = /^[\\/](?![\\/])/;
function unanchoredOnWindows(program, platform = process.platform) {
  return platform === 'win32' && typeof program === 'string' && UNANCHORED_RE.test(program);
}

function refuse(reason) {
  return { ok: false, reason };
}

function normalizeRunCommand(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => !COMMAND_KEYS.has(key))) {
    return refuse('command_invalid');
  }
  const build = value.build ?? '';
  if (!cleanText(build, MAX_BUILD_CHARS)) return refuse('build_invalid');
  const { program } = value;
  if (!cleanText(program, MAX_TEXT_CHARS) || program.trim() === '') return refuse('program_invalid');
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((arg) => cleanText(arg, MAX_TEXT_CHARS))) {
    return refuse('args_invalid');
  }
  const cwd = value.cwd ?? '';
  if (!relativeInside(cwd, { allowEmpty: true })) return refuse('cwd_invalid');
  const env = normalizeEnv(value.env ?? {});
  if (!env.ok) return refuse(env.reason);
  const watch = value.watch ?? [];
  if (!Array.isArray(watch) || watch.length > MAX_WATCH
    || !watch.every((folder) => relativeInside(folder, { allowEmpty: false }))) {
    return refuse('watch_invalid');
  }
  return { ok: true, value: { build, program, args: [...args], cwd, env: env.value, watch: [...watch] } };
}

function normalizeBinding({ projectId, rootId, rootRevision, worktree = null } = {}) {
  const idOk = (id) => cleanText(id, MAX_ID_CHARS) && id !== '';
  if (!idOk(projectId) || !idOk(rootId) || !Number.isSafeInteger(rootRevision) || rootRevision < 0) return null;
  if (worktree !== null && (!cleanText(worktree, MAX_TEXT_CHARS) || worktree === '')) return null;
  return { projectId, rootId, rootRevision, worktree };
}

// One stored entry, or null when it does not validate.
function readEntry(key, raw) {
  if (!plainObject(raw)) return null;
  const binding = normalizeBinding({
    projectId: raw.project_id, rootId: raw.root_id, rootRevision: raw.root_revision, worktree: raw.worktree,
  });
  if (!binding || binding.projectId !== key) return null;
  const command = normalizeRunCommand(raw.command);
  if (!command.ok) return null;
  const invalidated = raw.invalidated ?? null;
  if (invalidated !== null && !INVALIDATION_REASONS.has(invalidated)) return null;
  if (!Number.isSafeInteger(raw.confirmed_at)) return null;
  return { ...binding, command: command.value, confirmedAt: raw.confirmed_at, invalidated };
}

function writeEntry(entry) {
  return {
    project_id: entry.projectId,
    root_id: entry.rootId,
    root_revision: entry.rootRevision,
    worktree: entry.worktree,
    command: entry.command,
    confirmed_at: entry.confirmedAt,
    invalidated: entry.invalidated,
  };
}

function copyCommand(command) {
  return { ...command, args: [...command.args], env: { ...command.env }, watch: [...command.watch] };
}

function createRunCommandStore({
  userDataPath, fs = nodeFs, now = Date.now, maxProjects = DEFAULT_MAX_PROJECTS, platform = process.platform,
} = {}) {
  if (typeof userDataPath !== 'string' || userDataPath === '') throw new TypeError('userDataPath is required');
  const filePath = path.join(userDataPath, RUN_COMMANDS_FILENAME);
  let entries = null;
  let readOnly = false;

  function load() {
    if (entries) return entries;
    entries = new Map();
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return entries;
    }
    if (!plainObject(raw) || !Number.isSafeInteger(raw.version)) return entries;
    if (raw.version > RUN_COMMAND_SCHEMA_VERSION) {
      readOnly = true;
      return entries;
    }
    if (raw.version !== RUN_COMMAND_SCHEMA_VERSION || !plainObject(raw.commands)) return entries;
    for (const [key, value] of Object.entries(raw.commands)) {
      const entry = readEntry(key, value);
      if (entry && entries.size < maxProjects) entries.set(key, entry);
    }
    return entries;
  }

  // Write `next` atomically; the in-memory map changes only when the file did.
  function commit(next) {
    const document = { version: RUN_COMMAND_SCHEMA_VERSION, commands: {} };
    for (const [key, entry] of next) document.commands[key] = writeEntry(entry);
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let handle = null;
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      handle = fs.openSync(tempPath, 'wx');
      fs.writeFileSync(handle, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;
      fs.renameSync(tempPath, filePath);
    } catch {
      if (handle !== null) {
        try { fs.closeSync(handle); } catch { /* already closed */ }
      }
      try { fs.unlinkSync(tempPath); } catch { /* nothing to remove */ }
      return refuse('write_failed');
    }
    entries = next;
    return { ok: true };
  }

  function get(bindingInput) {
    const binding = normalizeBinding(bindingInput);
    if (!binding) return { status: 'none' };
    const entry = load().get(binding.projectId);
    if (!entry) return { status: 'none' };
    let reason = null;
    if (entry.invalidated) reason = entry.invalidated;
    else if (entry.rootId !== binding.rootId || entry.rootRevision !== binding.rootRevision) reason = 'rebind';
    else if (entry.worktree !== binding.worktree) reason = 'worktree';
    const shown = { command: copyCommand(entry.command), confirmedAt: entry.confirmedAt };
    return reason ? { status: 'needs_confirmation', reason, ...shown } : { status: 'confirmed', ...shown };
  }

  // The owner's confirm control is the only caller.
  function confirm({ command, ...bindingInput } = {}) {
    const binding = normalizeBinding(bindingInput);
    if (!binding) return refuse('binding_invalid');
    const normalized = normalizeRunCommand(command);
    if (!normalized.ok) return normalized;
    if (unanchoredOnWindows(normalized.value.program, platform)) return refuse('program_not_anchored');
    const current = load();
    if (readOnly) return refuse('store_newer');
    if (!current.has(binding.projectId) && current.size >= maxProjects) return refuse('too_many_projects');
    const next = new Map(current);
    next.set(binding.projectId, { ...binding, command: normalized.value, confirmedAt: now(), invalidated: null });
    return commit(next);
  }

  function invalidateAll(reason) {
    if (!INVALIDATION_REASONS.has(reason)) return refuse('reason_invalid');
    const current = load();
    if (readOnly) return refuse('store_newer');
    if (current.size === 0) return { ok: true };
    const next = new Map([...current].map(([key, entry]) => [key, { ...entry, invalidated: reason }]));
    return commit(next);
  }

  function deleteProject(projectId) {
    const current = load();
    if (!current.has(projectId)) return { ok: true };
    if (readOnly) return refuse('store_newer');
    const next = new Map(current);
    next.delete(projectId);
    return commit(next);
  }

  return { confirm, deleteProject, get, invalidateAll };
}

module.exports = {
  RUN_COMMAND_SCHEMA_VERSION,
  RUN_COMMANDS_FILENAME,
  createRunCommandStore,
  normalizeRunCommand,
  unanchoredOnWindows,
};
