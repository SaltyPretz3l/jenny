/* services/save-file-handler.js – F4/F5/F6 dialog:save-file IPC handler.
 *
 * Lets the renderer hand built content (Markdown/Plain/JSON) to Electron's
 * showSaveDialog + fs.writeFile pipeline. Distinct from sessions:export, which
 * remains the canonical attachments-inlined portable format.
 */
const fs = require('fs');
const path = require('path');

const { registerIpcInvokeHandlers } = require('./ipc-contract');
const { isChildPath } = require('./backend/path-utils');

const FORMAT_FILTER_MAP = {
  markdown: [{ name: 'Markdown', extensions: ['md'] }],
  plain: [{ name: 'Plain text', extensions: ['txt'] }],
  json: [{ name: 'JSON', extensions: ['json'] }],
  'session-json': [{ name: 'Jenny session export', extensions: ['json'] }],
};

const SUPPORTED_FORMATS = new Set(Object.keys(FORMAT_FILTER_MAP));

function resolveFilters(format, override) {
  if (Array.isArray(override) && override.length) {
    return [...override, { name: 'All files', extensions: ['*'] }];
  }
  const base = FORMAT_FILTER_MAP[format] || [];
  return [...base, { name: 'All files', extensions: ['*'] }];
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

    if (!SUPPORTED_FORMATS.has(format)) {
      const err = new Error(`Unsupported save-file format: "${format}"`);
      safelyLog(log, 'WARN', 'save_file.invalid_format', { format });
      throw err;
    }

    const filters = resolveFilters(format, overrideFilters);
    const dialogOptions = {
      title: 'Save…',
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
      await fs.promises.writeFile(targetPath, content, 'utf8');
      const bytesWritten = Buffer.byteLength(content, 'utf8');
      safelyLog(log, 'INFO', 'save_file.completed', {
        format,
        path: targetPath,
        bytesWritten,
      });
      return { canceled: false, path: targetPath, bytesWritten };
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

function registerSaveFileHandler({ ipcMainLike, dialog, getMainWindow, getProtectedRoots, log }) {
  if (!ipcMainLike || typeof ipcMainLike.handle !== 'function') {
    throw new TypeError('registerSaveFileHandler requires an ipcMain-like object.');
  }
  const handler = buildSaveFileHandler({ dialog, getMainWindow, getProtectedRoots, log });
  registerIpcInvokeHandlers(ipcMainLike, { 'dialog.saveFile': handler });
  return handler;
}

module.exports = {
  registerSaveFileHandler,
  buildSaveFileHandler,
  SUPPORTED_FORMATS,
  FORMAT_FILTER_MAP,
};
