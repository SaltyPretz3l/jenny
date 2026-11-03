'use strict';

/* Read-only file reads scoped to a registered project's folder. The primary
 * chat (and every chat) links files in projects that are not the current IDE
 * workspace; this serves a preview of them without switching roots. The
 * renderer names a project id and a project-relative path; the folder always
 * comes from the project store. Same lexical gate and realpath containment as
 * WorkspaceIdeService, so a `..`, absolute path, or symlink/junction escape is
 * refused. No writes, no watchers, no root transitions. */

const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');
const { TextDecoder } = require('node:util');

const { ToolPathPolicy } = require('./tools/tool-path-policy');
const { WORKSPACE_FS_ERROR_CODES: CODES, workspaceFsError } = require('./workspace-ide-errors');
const { buildPathLogHint, normalizeWorkspaceRelPath } = require('./workspace-ide-path-guard');
const { readCappedFile } = require('./workspace-ide-file-reads');
const { IMAGE_READ_MAX_BYTES } = require('./workspace-ide-image-reads');
const {
  getMatchingImageDescriptor,
  imageBytesMatchDescriptor,
} = require('./versioned-workspace-file-bytes');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./projects/project-schema');

// Matches the versioned service's default read cap (DEFAULT_MAX_BYTES).
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasControlChar(value) {
  return Array.prototype.some.call(String(value || ''), (ch) => ch.charCodeAt(0) < 0x20);
}

// A cap can land inside a multi-byte sequence; drop at most the 3 trailing
// bytes of that partial character instead of calling the file non-UTF-8.
function decodeUtf8(bytes, { truncated }) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const minLength = truncated ? Math.max(0, bytes.length - 3) : bytes.length;
  for (let length = bytes.length; length >= minLength; length -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, length));
    } catch (_error) {
      // try one byte shorter
    }
  }
  return null;
}

class ProjectFilePreviewService {
  constructor({
    projectService,
    fs = fsPromises,
    path = nodePath,
    logger = null,
    maxReadBytes = PREVIEW_MAX_BYTES,
    maxImageBytes = IMAGE_READ_MAX_BYTES,
  } = {}) {
    this._projectService = projectService;
    this._fs = fs;
    this._path = path;
    this._logger = typeof logger === 'function' ? logger : null;
    this._maxReadBytes = maxReadBytes;
    this._maxImageBytes = maxImageBytes;
    this._pathPolicy = new ToolPathPolicy({ fs, path, logger });
  }

  async readText(payload = {}) {
    const maxBytes = this._textLimit(payload);
    const { realPath, relPath, stats } = await this._resolveFile(payload);
    const bytes = await this._readBytes(realPath, maxBytes, relPath, 'read_text');
    const size = Math.max(stats.size, bytes.length);
    const truncated = size > maxBytes;
    const window = bytes.subarray(0, maxBytes);
    const fileVersion = `${stats.size}:${Math.trunc(Number(stats.mtimeMs) || 0)}`;
    const binary = { ok: true, content: '', editable: false, truncated: false, size, fileVersion };
    if (window.includes(0)) return binary;
    const hasBom = window.length >= UTF8_BOM.length && window.subarray(0, 3).equals(UTF8_BOM);
    const content = decodeUtf8(hasBom ? window.subarray(3) : window, { truncated });
    if (content === null) return binary;
    return { ok: true, content, truncated, editable: true, size, fileVersion };
  }

  async readImage(payload = {}) {
    const requested = this._normalizeRel(payload.path);
    if (!getMatchingImageDescriptor(requested, requested)) throw this._unsupportedImage(requested);
    const { realPath, relPath, stats } = await this._resolveFile(payload, requested);
    const descriptor = getMatchingImageDescriptor(relPath, realPath);
    if (!descriptor) throw this._unsupportedImage(relPath);
    if (stats.size > this._maxImageBytes) throw this._imageTooLarge(relPath, stats.size);
    const bytes = await this._readBytes(realPath, this._maxImageBytes, relPath, 'read_image');
    if (bytes.length > this._maxImageBytes) throw this._imageTooLarge(relPath, bytes.length);
    if (!imageBytesMatchDescriptor(bytes, descriptor)) throw this._unsupportedImage(relPath);
    return { ok: true, mime: descriptor.mime, base64: bytes.toString('base64'), size: bytes.length };
  }

  _textLimit(payload) {
    if (payload.maxBytes === undefined) return this._maxReadBytes;
    if (!Number.isSafeInteger(payload.maxBytes) || payload.maxBytes <= 0) {
      throw workspaceFsError(CODES.PATH_INVALID, 'Preview byte limit must be a positive safe integer.');
    }
    return Math.min(payload.maxBytes, this._maxReadBytes);
  }

  _normalizeRel(value) {
    if (hasControlChar(value)) {
      throw workspaceFsError(CODES.PATH_INVALID, 'Path must be a project-relative path.');
    }
    return normalizeWorkspaceRelPath(value);
  }

  async _projectRoot(projectId) {
    const id = normalizeProjectId(projectId);
    const refuse = (message) => workspaceFsError(CODES.ROOT_MISSING, message);
    if (!id || id !== projectId || id === GENERAL_PROJECT_ID) throw refuse('No project folder to read from.');
    const project = typeof this._projectService?.get === 'function' ? this._projectService.get(id) : null;
    const root = typeof project?.root_path === 'string' ? project.root_path.trim() : '';
    if (!root) throw refuse('That project has no folder.');
    try {
      if ((await this._fs.stat(root)).isDirectory()) return root;
    } catch (_error) {
      // falls through to the refusal below
    }
    throw refuse('The project folder is not available.');
  }

  async _resolveFile(payload, normalizedRel = null) {
    const root = await this._projectRoot(payload.projectId);
    const relPath = normalizedRel || this._normalizeRel(payload.path);
    const resolved = this._path.resolve(root, relPath);
    let realPath;
    try {
      realPath = await this._pathPolicy.assertInsideRoot(resolved, { workingDirectory: root });
    } catch (error) {
      if (error?.code && String(error.code).startsWith('CMP-')) throw error;
      throw workspaceFsError(
        CODES.PATH_OUTSIDE_ROOT,
        'Path resolves outside the project folder.',
        buildPathLogHint(relPath)
      );
    }
    let stats;
    try {
      stats = await this._fs.stat(realPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw workspaceFsError(CODES.NOT_FOUND, 'File not found in the project.', buildPathLogHint(relPath));
      }
      throw this._ioError('stat', relPath, error);
    }
    if (!stats.isFile()) {
      throw workspaceFsError(CODES.NOT_A_FILE, 'Path is not a regular file.', buildPathLogHint(relPath));
    }
    return { realPath, relPath, stats };
  }

  async _readBytes(realPath, maxBytes, relPath, operation) {
    try {
      return await readCappedFile(this._fs, realPath, maxBytes);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw workspaceFsError(CODES.NOT_FOUND, 'File not found in the project.', buildPathLogHint(relPath));
      }
      throw this._ioError(operation, relPath, error);
    }
  }

  _unsupportedImage(relPath) {
    return workspaceFsError(
      CODES.IMAGE_UNSUPPORTED,
      'Only supported image files can be opened as images.',
      buildPathLogHint(relPath)
    );
  }

  _imageTooLarge(relPath, size) {
    return workspaceFsError(
      CODES.IMAGE_TOO_LARGE,
      'Image is too large to preview.',
      { ...buildPathLogHint(relPath), size, max_bytes: this._maxImageBytes }
    );
  }

  _ioError(operation, relPath, error) {
    const hint = buildPathLogHint(relPath);
    this._logger?.('WARN', 'project_file_preview.io_failed', {
      operation, os_code: String(error?.code || '').slice(0, 32), ...hint,
    });
    return workspaceFsError(CODES.IO_FAILED, 'The project file could not be read.', {
      operation, os_code: String(error?.code || '').slice(0, 32), ...hint,
    });
  }
}

function createProjectFilePreviewService(options) {
  return new ProjectFilePreviewService(options);
}

module.exports = { PREVIEW_MAX_BYTES, ProjectFilePreviewService, createProjectFilePreviewService };
