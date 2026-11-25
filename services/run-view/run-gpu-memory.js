'use strict';

/*
 * run-gpu-memory.js — how much graphics memory each project's program used last time (row 197, R3c).
 *
 * Main measures a running program a little after it starts and keeps the biggest figure it saw, one
 * number per project. Before a Run, the holder compares that number with what is free now and warns
 * when there is less (see run-view-composition.js `startWarning`). The number is advice, never a gate.
 *
 * Its own versioned file under the user data folder, and not run-command-store.js: that file's only
 * writer is the owner's confirm control. A file from a newer Jenny reads as empty and is never
 * overwritten; a damaged file reads as empty and the next record replaces it. At most 256 projects
 * (the one recorded longest ago goes first). Only main code calls `record`; no tool or renderer can.
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const RUN_GPU_MEMORY_SCHEMA_VERSION = 1;
const RUN_GPU_MEMORY_FILENAME = 'run-gpu-memory.json';
const DEFAULT_MAX_PROJECTS = 256;
const MAX_ID_CHARS = 200;
const MAX_MB = 1048576; // 1 TiB in MiB: far above any card, so a bad reading cannot be stored

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const idOk = (id) => typeof id === 'string' && id !== '' && id.length <= MAX_ID_CHARS;
const mbOk = (mb) => Number.isSafeInteger(mb) && mb > 0 && mb <= MAX_MB;
const refuse = (reason) => ({ ok: false, reason });

function createRunGpuMemoryStore({
  userDataPath, fs = nodeFs, now = Date.now, maxProjects = DEFAULT_MAX_PROJECTS,
} = {}) {
  if (typeof userDataPath !== 'string' || userDataPath === '') throw new TypeError('userDataPath is required');
  const filePath = path.join(userDataPath, RUN_GPU_MEMORY_FILENAME);
  let entries = null; // projectId -> { mb, at }
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
    if (!plainObject(raw) || !Number.isSafeInteger(raw.schema_version)) return entries;
    if (raw.schema_version > RUN_GPU_MEMORY_SCHEMA_VERSION) {
      readOnly = true;
      return entries;
    }
    if (raw.schema_version !== RUN_GPU_MEMORY_SCHEMA_VERSION || !plainObject(raw.projects)) return entries;
    for (const [id, value] of Object.entries(raw.projects)) {
      if (idOk(id) && plainObject(value) && mbOk(value.mb) && Number.isFinite(value.at) && entries.size < maxProjects) {
        entries.set(id, { mb: value.mb, at: value.at });
      }
    }
    return entries;
  }

  // Write `next` atomically (temp file, then rename); the in-memory map changes only when the file did.
  function commit(next) {
    const document = { schema_version: RUN_GPU_MEMORY_SCHEMA_VERSION, projects: {} };
    for (const [id, entry] of next) document.projects[id] = { mb: entry.mb, at: entry.at };
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

  // Megabytes the project's program used last time, or null.
  function get(projectId) {
    if (!idOk(projectId)) return null;
    return load().get(projectId)?.mb ?? null;
  }

  function record(projectId, mb) {
    if (!idOk(projectId)) return refuse('project_invalid');
    if (!mbOk(mb)) return refuse('mb_invalid');
    const current = load();
    if (readOnly) return refuse('store_newer');
    const next = new Map(current);
    next.delete(projectId); // so a fresh entry sorts as the newest
    next.set(projectId, { mb, at: now() });
    while (next.size > maxProjects) {
      let oldest = null;
      for (const [id, entry] of next) if (oldest === null || entry.at < next.get(oldest).at) oldest = id;
      next.delete(oldest);
    }
    return commit(next);
  }

  function forget(projectId) {
    const current = load();
    if (!current.has(projectId)) return { ok: true };
    if (readOnly) return refuse('store_newer');
    const next = new Map(current);
    next.delete(projectId);
    return commit(next);
  }

  return { forget, get, record };
}

module.exports = { RUN_GPU_MEMORY_FILENAME, RUN_GPU_MEMORY_SCHEMA_VERSION, createRunGpuMemoryStore };
