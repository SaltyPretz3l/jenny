/* services/save-file-handler.js – F4/F5/F6 dialog:save-file IPC handler.
 *
 * Lets the renderer hand built content (Markdown/Plain/JSON) to Electron's
 * showSaveDialog + fs.writeFile pipeline. Distinct from sessions:export, which
 * remains the canonical attachments-inlined portable format.
 *
 * It is also the transcript export boundary (HB-012): a payload marked
 * `anonymizePaths: true` (the chat transcript exports) has its absolute host
 * paths anonymised on the way out, while the app itself keeps presenting real
 * paths. Other saves (artifact downloads, usage CSV, audit logs) are written
 * byte-exact.
 */
const fs = require('fs');
const path = require('path');

const { registerIpcInvokeHandlers } = require('./ipc-contract');
const { isChildPath } = require('./backend/path-utils');
const { redactTranscriptExportContent } = require('./backend/transcript-export-redaction');
const teamExportFormat = require('./team-export-format');

const FORMAT_FILTER_MAP = {
  markdown: [{ name: 'Markdown', extensions: ['md'] }],
  plain: [{ name: 'Plain text', extensions: ['txt'] }],
  json: [{ name: 'JSON', extensions: ['json'] }],
  'session-json': [{ name: 'Jenny session export', extensions: ['json'] }],
};

const SUPPORTED_FORMATS = new Set(Object.keys(FORMAT_FILTER_MAP));

// A picture or other bytes (sketch export, slice S6): `encoding: 'base64'` marks `content` as base64 text, at most
// 32 MiB of it. It is decoded here and written as bytes; it is never redacted, so it cannot be combined with
// `anonymizePaths`, and it is a single-file save, so not with `contents` or `document` either.
const MAX_BASE64_CHARS = 32 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// The decoded bytes for an `encoding: 'base64'` payload, or null for an ordinary text save. Throws when the
// payload is refused; the caller does this before the dialog opens.
function readBase64Content(input, anonymizePaths) {
  if (input.encoding === undefined || input.encoding === null) return null;
  if (input.encoding !== 'base64') throw new Error('Unsupported save-file encoding.');
  if (anonymizePaths || input.contents !== undefined || input.document !== undefined) {
    throw new Error('A base64 save cannot be combined with anonymizePaths, contents or document.');
  }
  const content = input.content;
  if (typeof content === 'string' && content.length > MAX_BASE64_CHARS) throw new Error('The export is too large to write.');
  if (typeof content !== 'string' || !BASE64_PATTERN.test(content)) throw new Error('The content is not valid base64.');
  return Buffer.from(content, 'base64');
}

function resolveFilters(format, override) {
  if (Array.isArray(override) && override.length) {
    return [...override, { name: 'All files', extensions: ['*'] }];
  }
  const base = FORMAT_FILTER_MAP[format] || [];
  return [...base, { name: 'All files', extensions: ['*'] }];
}

// Several formats in one save (owner, 2026-11-12, team export): the dialog offers each, in order, and only the
// one whose type was picked is written. `contents` gives the text per format (the save formats below, a string
// each; a map without the named format is refused); `document` is a team export, built here in the picked format
// only (services/team-export-format.js). Returns { formats, textFor } or null for an ordinary one-format save.
function readFormats(input, format) {
  if (input.document !== undefined) {
    const doc = teamExportFormat.readDocument(input.document);
    if (!doc || format !== 'markdown') throw new Error('The export document is not one this app writes.');
    return { formats: ['markdown', 'json'], textFor: (picked) => teamExportFormat.buildFormat(doc, picked) };
  }
  const value = input.contents;
  if (value === undefined) return null;
  const contents = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (SUPPORTED_FORMATS.has(key) && key !== 'session-json' && typeof value[key] === 'string') contents[key] = value[key];
    }
  }
  if (!Object.prototype.hasOwnProperty.call(contents, format)) throw new Error(`No text was given for the "${format}" format.`);
  return { formats: [format, ...Object.keys(contents).filter((key) => key !== format)], textFor: (picked) => contents[picked] };
}

// Writes beside the target and renames over it, so a failed write never leaves a cut-off file at the path.
async function writeWhole(targetPath, text) {
  const temporary = targetPath + '.' + process.pid + '-' + Date.now() + '.tmp';
  try {
    await fs.promises.writeFile(temporary, text, 'utf8');
    await fs.promises.rename(temporary, targetPath);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {}); // a file this call made; never a directory
    throw error;
  }
}

// The format whose extension the picked path carries; the first format when the name has none of them.
function formatForPath(targetPath, formats, fallback) {
  const extension = path.extname(targetPath).slice(1).toLowerCase();
  for (const key of formats) {
    if ((FORMAT_FILTER_MAP[key][0].extensions || []).includes(extension)) return key;
  }
  return fallback;
}

function normalizeString(value) {
  return String(value == null ? '' : value);
}

function safelyLog(log, level, name, payload) {
  if (!log || typeof log.write !== 'function') return;
  try {
    log.write(level, name, payload);
  } catch (_error) {
    /* swallow logging errors */
  }
}

// Real path of the nearest resolvable ancestor plus the lexical tail, so a
// junction/symlink that points into a protected root cannot slip past the
// lexical comparison. Never throws: an unresolvable ancestor (EPERM etc.) is
// treated like a missing one, and the filesystem root falls back to lexical.
async function resolveRealTarget(targetPath) {
  let existingPath = targetPath;
  const missingSegments = [];
  while (true) {
    try {
      const realPath = await fs.promises.realpath(existingPath);
      return path.resolve(realPath, ...missingSegments.reverse());
    } catch (_error) {
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) return path.resolve(targetPath);
      missingSegments.push(path.basename(existingPath));
      existingPath = parentPath;
    }
  }
}

function buildSaveFileHandler({ dialog, getMainWindow, getProtectedRoots, log }) {
  if (!dialog || typeof dialog.showSaveDialog !== 'function') {
    throw new TypeError('save-file-handler requires an Electron dialog with showSaveDialog().');
  }
  const resolveProtectedRoots = typeof getProtectedRoots === 'function'
    ? getProtectedRoots
    : () => [];

  return async function handleSaveFile(_event, payload) {
    const input = (payload && typeof payload === 'object') ? payload : {};
    const defaultName = normalizeString(input.defaultName).trim();
    const content = normalizeString(input.content);
    const format = normalizeString(input.format).trim().toLowerCase();
    const overrideFilters = Array.isArray(input.filters) ? input.filters : null;
    const anonymizePaths = input.anonymizePaths === true;
    // An optional localized dialog title (bounded); the default stays 'Save…'.
    const title = normalizeString(input.title).trim().slice(0, 200);

    if (!SUPPORTED_FORMATS.has(format)) {
      const err = new Error(`Unsupported save-file format: "${format}"`);
      safelyLog(log, 'WARN', 'save_file.invalid_format', { format });
      throw err;
    }

    let bytes;
    try {
      bytes = readBase64Content(input, anonymizePaths);
    } catch (error) {
      safelyLog(log, 'WARN', 'save_file.invalid_encoding', { format });
      throw error;
    }

    let several;
    try {
      several = readFormats(input, format);
    } catch (error) {
      safelyLog(log, 'WARN', 'save_file.invalid_contents', { format });
      throw error;
    }
    // Several formats: just their types, the given (localized) names first, no "All files".
    const filters = several
      ? (overrideFilters && overrideFilters.length ? overrideFilters : several.formats.map((key) => FORMAT_FILTER_MAP[key][0]))
      : resolveFilters(format, overrideFilters);
    const dialogOptions = {
      title: title || 'Save…',
      defaultPath: defaultName || `jenny-export.${(filters[0].extensions || ['txt'])[0]}`,
      filters,
    };

    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

    if (!result || result.canceled || !result.filePath) {
      safelyLog(log, 'INFO', 'save_file.canceled', { format });
      return { canceled: true, path: '', bytesWritten: 0 };
    }

    const targetPath = path.resolve(result.filePath);
    const picked = several ? formatForPath(targetPath, several.formats, format) : format;
    const realTargetPath = await resolveRealTarget(targetPath);
    const protectedRoots = resolveProtectedRoots();
    for (const root of protectedRoots) {
      const normalizedRoot = root ? path.resolve(root) : '';
      const realRoot = normalizedRoot ? await resolveRealTarget(normalizedRoot) : '';
      if (realRoot && (realTargetPath === realRoot || isChildPath(realRoot, realTargetPath))) {
        safelyLog(log, 'WARN', 'save_file.refused_protected_path', {
          format,
          targetPath,
          protectedRoot: normalizedRoot,
        });
        throw new Error('Refusing to write inside a protected Jenny directory.');
      }
    }

    try {
      const text = several ? several.textFor(picked) : content;
      if (!bytes && typeof text !== 'string') throw new Error('The export is too large to write.');
      const exportContent = bytes || (anonymizePaths ? redactTranscriptExportContent(text, picked) : text);
      await writeWhole(targetPath, exportContent);
      const bytesWritten = Buffer.byteLength(exportContent, 'utf8');
      safelyLog(log, 'INFO', 'save_file.completed', {
        format: picked,
        path: targetPath,
        bytesWritten,
      });
      return { canceled: false, path: targetPath, bytesWritten, format: picked };
    } catch (error) {
      safelyLog(log, 'ERROR', 'save_file.failed', {
        format,
        path: targetPath,
        message: error && error.message ? error.message : String(error),
      });
      throw error;
    }
  };
}

function registerSaveFileHandler({
  ipcMainLike, dialog, getMainWindow, getProtectedRoots, log, authorization = {},
}) {
  if (!ipcMainLike || typeof ipcMainLike.handle !== 'function') {
    throw new TypeError('registerSaveFileHandler requires an ipcMain-like object.');
  }
  const handler = buildSaveFileHandler({ dialog, getMainWindow, getProtectedRoots, log });
  registerIpcInvokeHandlers(ipcMainLike, { 'dialog.saveFile': handler }, authorization);
  return handler;
}

module.exports = {
  registerSaveFileHandler,
  buildSaveFileHandler,
  SUPPORTED_FORMATS,
  FORMAT_FILTER_MAP,
};
