'use strict';

// The main-process check behind sketch.openFile (row 149, plan PROJECT_BOARD_2026-11-13 section 5.6): a node in a
// drawing written with `file=<path>` is model output, and clicking it may open only a file inside the chat's own
// project folder. The root comes only from the project authority's record of that session; nothing the renderer
// sends is a root. The walk below the root is services/fs-contained.js (real paths, no link followed, a link or
// junction anywhere on the way refuses the path); this file adds no second containment routine. It only turns the
// hostile text into plain segments first, and refuses before any filesystem call what must never reach one (a UNC
// or device path, a drive-relative path, a stream name, a Windows device name).
//
// The answer is { ok: true, relativePath, line, projectId } or { ok: false, reason } with a reason from REASONS. It
// never rejects, never carries an absolute path and never reads the file: the Workspace's own open path reads it.

const nodePath = require('node:path');
const { resolveContained } = require('../fs-contained');

const REASONS = Object.freeze(['no_session', 'no_root', 'outside', 'link', 'not_found', 'not_file', 'disabled']);
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_PATH = 1024;
const MAX_LINE = 10000000;
// CON, PRN, AUX, NUL, COM0-9, LPT0-9, with or without an extension, and the superscript digits Windows also reserves.
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;

const refuse = (reason) => ({ ok: false, reason });

function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function readLine(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_LINE ? value : null;
}

// Hostile text -> { segments } below the root, or { reason }. Lexical only: nothing here touches the disk.
function toSegments(rawPath, root, platform) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > MAX_PATH || hasControlCharacter(rawPath)) return { reason: 'outside' };
  // A UNC path (\\server\share), a device path (\\?\, \\.\) or either written with forward slashes: never looked up.
  if (/^[\\/]{2}/.test(rawPath)) return { reason: 'outside' };
  const windows = platform === 'win32';
  const pathApi = windows ? nodePath.win32 : nodePath.posix;
  let text = rawPath;
  const drive = /^[A-Za-z]:/.test(text);
  if (drive && !(windows && /^[A-Za-z]:[\\/]/.test(text))) return { reason: 'outside' }; // C:relative, or a drive on another platform
  if (drive || /^[\\/]/.test(text)) {
    // Absolute: accepted only when it names a place below the root (the walk then checks every real step).
    const relative = pathApi.relative(root, pathApi.resolve(root, windows ? text : text.replace(/\\/g, '/')));
    if (pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + pathApi.sep)) return { reason: 'outside' };
    text = relative;
  }
  const segments = [];
  for (const segment of text.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return { reason: 'outside' };
      segments.pop();
      continue;
    }
    // A stream name (a.txt:secret), or a segment Windows would read as another name (a trailing dot or space).
    if (segment.includes(':') || segment.endsWith('.') || segment.endsWith(' ')) return { reason: 'outside' };
    if (windows && WINDOWS_DEVICE_RE.test(segment)) return { reason: 'not_file' };
    segments.push(segment);
  }
  return { segments };
}

// fs-contained's bounded reasons -> the contract's.
function reasonForContainment(error) {
  const reason = String((error && (error.reason || error.code)) || '');
  if (reason === 'reparse_or_symlink') return 'link';
  if (reason === 'escapes_root') return 'outside';
  if (reason === 'unsafe_root') return 'no_root';
  // unsafe_target here is a file on the way used as a folder (the segments were checked above); the rest are IO codes.
  return 'not_found';
}

/** The contained file a path names below `root`, as { ok: true, relativePath } or { ok: false, reason }. */
function checkSketchPath(root, rawPath, { platform = process.platform, resolve = resolveContained } = {}) {
  const parsed = toSegments(rawPath, root, platform);
  if (parsed.reason) return refuse(parsed.reason);
  let resolved;
  try {
    resolved = resolve(root, parsed.segments);
  } catch (error) {
    return refuse(reasonForContainment(error));
  }
  if (!resolved) return refuse('not_found');
  if (!resolved.stat || !resolved.stat.isFile()) return refuse('not_file');
  return { ok: true, relativePath: parsed.segments.join('/') };
}

/**
 * open({ sessionId, path, line }) -> the answer. deps:
 *   captureSession(sessionId) -> { project_id, root_path }  the project authority's record; throws for an unknown session
 *   isEnabled() -> boolean                                     the sketch_blocks flag, read on every call
 *   platform, resolve                                          for tests
 */
function createSketchFileOpener({ captureSession, isEnabled = () => true, platform = process.platform, resolve = resolveContained } = {}) {
  return async function openSketchFile(request) {
    if (!isEnabled()) return refuse('disabled');
    const fields = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
    const sessionId = typeof fields.sessionId === 'string' && SESSION_ID_RE.test(fields.sessionId) ? fields.sessionId : '';
    if (!sessionId || typeof captureSession !== 'function') return refuse('no_session');
    let authority;
    try {
      authority = captureSession(sessionId);
    } catch (error) {
      return refuse(error && error.reason === 'session_not_found' ? 'no_session' : 'no_root');
    }
    const root = authority && typeof authority.root_path === 'string' ? authority.root_path : '';
    const projectId = authority && typeof authority.project_id === 'string' ? authority.project_id : '';
    if (!root || !projectId) return refuse('no_root');
    const checked = checkSketchPath(root, fields.path, { platform, resolve });
    if (!checked.ok) return checked;
    return { ok: true, relativePath: checked.relativePath, line: readLine(fields.line), projectId };
  };
}

module.exports = { REASONS, checkSketchPath, createSketchFileOpener };
