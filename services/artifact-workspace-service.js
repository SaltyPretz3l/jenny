'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const {
  inferLanguageFromPath,
  normalizeArtifactKind,
  normalizeGeneratedArtifactMetadata,
  normalizeLanguage,
  normalizeMimeType,
} = require('./artifact-metadata-utils');
const {
  ARTIFACT_ERROR_CODES,
  artifactError,
} = require('./artifact-workspace-errors');
const { parsePngDimensions } = require('./png-metadata-utils');
const { createPreviewScreenshot } = require('./preview-screenshot-store');
const { isJennyStateDirRoot } = require('./workspace-root-identity');
const { ArtifactSessionAuthority, createSessionArtifactWorkspaceFacade } = require('./artifact-session-authority');
const { cloneSessionArtifactsForBranch } = require('./artifact-branch-workspace');
const {
  deleteSessionArtifactsForScope,
  prepareSessionArtifactDeletion,
} = require('./artifact-session-cleanup');

const MAX_EDITABLE_BYTES = 512 * 1024;
const MAX_BINARY_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_BRANCH_CLONE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_BRANCH_CLONE_ENTRIES = 5000;
const SESSION_ARTIFACT_ROOT = path.join('.jenny', 'artifacts');
const REDACTED_PATH_TOKEN = '[redacted:path]';
const IMAGE_PREVIEW_DATA_URL_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);
const EXTENSION_PATTERN = /^\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DANGEROUS_ARTIFACT_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.cpl',
  '.deb',
  '.dll',
  '.docm',
  '.exe',
  '.hta',
  '.jar',
  '.js',
  '.jse',
  '.lnk',
  '.msi',
  '.msp',
  '.pptm',
  '.ps1',
  '.psm1',
  '.reg',
  '.scr',
  '.url',
  '.vbe',
  '.vbs',
  '.wsh',
  '.wsf',
  '.xlsm',
]);

function slugify(value, fallback = 'artifact') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function sanitizeSessionId(sessionId) {
  const normalized = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw artifactError(
      ARTIFACT_ERROR_CODES.INVALID_SESSION,
      'A valid session id is required for artifact operations.'
    );
  }
  return normalized;
}

function buildArtifactId(sessionId, fileName) {
  const seed = crypto.randomBytes(4).toString('hex');
  return `artifact_file_${sanitizeSessionId(sessionId)}_${slugify(fileName, 'file')}_${seed}`;
}

function normalizeExtension(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  const candidate = normalized.startsWith('.') ? normalized : `.${normalized}`;
  if (!EXTENSION_PATTERN.test(candidate)) {
    throw artifactError(
      ARTIFACT_ERROR_CODES.EXTENSION_INVALID,
      'Artifact extension must be a simple file extension.'
    );
  }
  return candidate;
}

function extensionFromValue(value, pathImpl = path) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) {
    return '';
  }
  const extension = pathImpl.extname(token).toLowerCase();
  if (extension) {
    return extension;
  }
  return token.startsWith('.') ? token : `.${token}`;
}

function isDangerousArtifactExtension(value, pathImpl = path) {
  return DANGEROUS_ARTIFACT_EXTENSIONS.has(extensionFromValue(value, pathImpl));
}

function isRedactedArtifactPath(value) {
  return String(value || '').trim() === REDACTED_PATH_TOKEN;
}

function isDataUrlPreviewMimeType(value) {
  return IMAGE_PREVIEW_DATA_URL_MIME_TYPES.has(String(value || '').trim().toLowerCase());
}

function toRendererSafeArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    return artifact;
  }
  return {
    ...artifact,
    absolute_path: String(artifact.absolute_path || '').trim() ? REDACTED_PATH_TOKEN : '',
  };
}

function isPathInside(pathImpl, parentPath, childPath) {
  const relative = pathImpl.relative(parentPath, childPath);
  return !relative.startsWith('..') && !pathImpl.isAbsolute(relative);
}

function getEditableStateForContent(content) {
  return Buffer.byteLength(String(content || ''), 'utf8') <= MAX_EDITABLE_BYTES;
}

function extensionForArtifact({ artifactKind, language, extension, fileName }) {
  const explicitExtension = normalizeExtension(extension);
  if (explicitExtension) {
    return explicitExtension;
  }
  const fileNameExtension = path.extname(String(fileName || '').trim()).toLowerCase();
  if (fileNameExtension) {
    return fileNameExtension;
  }
  const normalizedLanguage = normalizeLanguage(language);
  const normalizedKind = normalizeArtifactKind(artifactKind);
  if (normalizedKind === 'image') {
    return '.png';
  }
  switch (normalizedLanguage) {
    case 'markdown':
      return '.md';
    case 'javascript':
      return '.js';
    case 'typescript':
      return '.ts';
    case 'python':
      return '.py';
    case 'powershell':
      return '.ps1';
    case 'shell':
    case 'bash':
      return '.sh';
    case 'json':
      return '.json';
    case 'html':
      return '.html';
    case 'css':
      return '.css';
    case 'yaml':
      return '.yml';
    case 'toml':
      return '.toml';
    case 'sql':
      return '.sql';
    default:
      return normalizedKind === 'script' ? '.txt' : '.md';
  }
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  return '';
}

function normalizeFileStem(value, fallback) {
  const normalized = slugify(value, fallback);
  return normalized || fallback;
}
class ArtifactWorkspaceService {
  constructor({
    configService,
    sessionMessageReader,
    openPathImpl,
    showItemInFolderImpl,
    logger,
    fsImpl,
    pathImpl,
    projectAuthorityProvider,
  } = {}) {
    this._configService = configService || null;
    this._sessionMessageReader = typeof sessionMessageReader === 'function'
      ? sessionMessageReader
      : async () => [];
    this._openPathImpl = typeof openPathImpl === 'function' ? openPathImpl : null;
    this._showItemInFolderImpl = typeof showItemInFolderImpl === 'function'
      ? showItemInFolderImpl
      : null;
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._fs = fsImpl || fs;
    this._path = pathImpl || path;
    this._sessionAuthority = new ArtifactSessionAuthority({
      configService: this._configService, projectAuthorityProvider, sanitizeSessionId,
    });
    this._writeLocks = new Map();
    this._pruneProtectedSessionIds = new Map();
  }

  forSessionAuthority(authority, sessionId) {
    if (!this._sessionAuthority.hasProvider) {
      throw new TypeError('Session artifact authority requires a project authority provider.');
    }
    return createSessionArtifactWorkspaceFacade(this, authority, sessionId, sanitizeSessionId);
  }

  _captureSessionScope(sessionId, admittedAuthority = null, options) {
    return this._sessionAuthority.capture(sessionId, admittedAuthority, options); }

  _assertSessionScopeCurrent(scope) {
    return this._sessionAuthority.assertCurrent(scope); }

  getWorkspaceRoot() {
    if (this._sessionAuthority.hasProvider) return '';
    const configured = this._configService?.getState?.().toolsWorkspaceRoot;
    return String(configured || '').trim(); }

  async requireWorkspaceRoot() {
    if (this._sessionAuthority.hasProvider) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
        'A session project authority is required for artifact operations.',
        { reason: 'session_authority_required' }
      );
    }
    return this._requireWorkspaceRootForScope(this._captureSessionScope('legacy-artifact-session'));
  }

  async _requireWorkspaceRootForScope(scope) {
    this._assertSessionScopeCurrent(scope);
    const workspaceRoot = scope.rootPath;
    if (!workspaceRoot) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_MISSING,
        'Tools workspace root is not configured.'
      );
    }
    const resolved = this._path.resolve(workspaceRoot);
    // Defense in depth: reject a root that is Jenny's own .jenny state
    // directory even if it was persisted before the coordinator/picker guard
    // existed. Every consumer appends its own .jenny/... suffix, so using
    // this as a root would materialize a doubled .jenny/.jenny/... tree.
    if (isJennyStateDirRoot(resolved)) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_STATE_DIR,
        'Tools workspace root cannot be Jenny\'s own internal state directory (.jenny).'
      );
    }
    const stats = await this._fs.stat(resolved).catch(() => null);
    this._assertSessionScopeCurrent(scope);
    if (!stats?.isDirectory()) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.WORKSPACE_ROOT_UNAVAILABLE,
        'Tools workspace root is unavailable.'
      );
    }
    return resolved;
  }

  async getSessionScratchDir(sessionId) {
    return this._getSessionScratchDir(sanitizeSessionId(sessionId), null); }

  async _getSessionScratchDir(sessionId, admittedAuthority) {
    const scope = this._captureSessionScope(sessionId, admittedAuthority);
    const workspaceRoot = await this._requireWorkspaceRootForScope(scope);
    return this._buildSessionScratchDir(workspaceRoot, sessionId);
  }

  _buildSessionScratchDir(workspaceRoot, sessionId) {
    return this._path.join(
      workspaceRoot,
      SESSION_ARTIFACT_ROOT,
      sanitizeSessionId(sessionId)
    );
  }

  _assertPathInside(parentPath, targetPath, code, message) {
    if (!isPathInside(this._path, parentPath, targetPath)) {
      throw artifactError(code, message);
    }
  }

  async _writeSessionArtifact(sessionId, { prepare }, scope) {
    const workspaceRoot = await this._requireWorkspaceRootForScope(scope);
    const scratchDir = this._buildSessionScratchDir(workspaceRoot, sessionId);
    this._assertSessionScopeCurrent(scope);
    await this._fs.mkdir(scratchDir, { recursive: true });
    this._assertSessionScopeCurrent(scope);

    const realWorkspaceRoot = await this._fs.realpath(workspaceRoot);
    this._assertSessionScopeCurrent(scope);
    const realScratchDir = await this._fs.realpath(scratchDir);
    this._assertSessionScopeCurrent(scope);
    this._assertPathInside(
      realWorkspaceRoot,
      realScratchDir,
      ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
      'Session scratch directory escapes the configured workspace root.'
    );

    const { artifactKind, title, fileStem, extension, write, metadata } = prepare();
    let fileName = '';
    let absolutePath = '';
    await this._withArtifactWriteLock(`${realScratchDir}:create:${fileStem}${extension}`, async () => {
      this._assertSessionScopeCurrent(scope);
      fileName = `${fileStem}${extension}`;
      absolutePath = this._path.join(realScratchDir, fileName);
      let suffix = 2;
      while (await this._pathExists(absolutePath)) {
        this._assertSessionScopeCurrent(scope);
        fileName = `${fileStem}-${suffix}${extension}`;
        absolutePath = this._path.join(realScratchDir, fileName);
        suffix += 1;
      }
      this._assertSessionScopeCurrent(scope);
      await write(absolutePath, scope);
    });

    this._assertSessionScopeCurrent(scope);
    const realWrittenPath = await this._fs.realpath(absolutePath);
    this._assertSessionScopeCurrent(scope);
    if (!isPathInside(this._path, realScratchDir, realWrittenPath)) {
      await this._fs.rm(absolutePath, { force: true }).catch(() => {});
      throw artifactError(
        ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
        'Artifact real path escaped the session scratch directory.'
      );
    }

    const displayPath = this._path.relative(realWorkspaceRoot, realWrittenPath).replace(/\\/g, '/');
    const normalizedMetadata = normalizeGeneratedArtifactMetadata(metadata({
      fileName,
      displayPath,
      realWrittenPath,
    }));

    return {
      output: `Created ${artifactKind} "${title}" at ${displayPath}`,
      metadata: normalizedMetadata,
    };
  }

  async createArtifact(sessionId, input = {}) {
    return this._createArtifact(sanitizeSessionId(sessionId), input, null); }

  async _createArtifact(sessionId, input = {}, admittedAuthority = null) {
    const safeSessionId = sanitizeSessionId(sessionId);
    const scope = this._captureSessionScope(safeSessionId, admittedAuthority);
    return this._writeSessionArtifact(safeSessionId, {
      prepare: () => {
        const artifactKind = normalizeArtifactKind(input.artifactKind || input.artifact_kind);
        const title = String(input.title || '').trim() || (artifactKind === 'script' ? 'Scratch script' : 'Scratch document');
        const language = normalizeLanguage(input.language);
        const requestedFileName = String(input.fileName || input.file_name || '').trim();
        const extension = extensionForArtifact({
          artifactKind,
          language,
          extension: input.extension,
          fileName: requestedFileName,
        });
        const fileStem = normalizeFileStem(
          requestedFileName ? this._path.basename(requestedFileName, this._path.extname(requestedFileName)) : title,
          artifactKind === 'script' ? 'scratch-script' : 'scratch-doc'
        );
        const content = String(input.content || '');
        return {
          artifactKind,
          title,
          fileStem,
          extension,
          write: (absolutePath, writeScope) => this._writeFileAtomic(absolutePath, content, writeScope),
          metadata: ({ fileName, displayPath, realWrittenPath }) => ({
            artifact_id: buildArtifactId(safeSessionId, fileName),
            artifact_kind: artifactKind,
            title,
            file_name: fileName,
            display_path: displayPath,
            absolute_path: realWrittenPath,
            language: language || inferLanguageFromPath(fileName),
            editable: getEditableStateForContent(content),
            status: 'available',
          }),
        };
      },
    }, scope);
  }

  async createBinaryArtifact(sessionId, input = {}) {
    return this._createBinaryArtifact(sanitizeSessionId(sessionId), input, null); }

  async _createBinaryArtifact(sessionId, input = {}, admittedAuthority = null) {
    const safeSessionId = sanitizeSessionId(sessionId);
    const scope = this._captureSessionScope(safeSessionId, admittedAuthority);
    if (input.previewScreenshot === true) {
      return createPreviewScreenshot(this, safeSessionId, input, buildArtifactId, scope);
    }
    const content = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content || []);
    if (content.length > MAX_BINARY_ARTIFACT_BYTES) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.OVERSIZED,
        'Binary artifact exceeds Jenny\'s screenshot artifact limit.'
      );
    }

    return this._writeSessionArtifact(safeSessionId, {
      prepare: () => {
        const artifactKind = normalizeArtifactKind(input.artifactKind || input.artifact_kind);
        const mimeType = String(input.mimeType || input.mime_type || '').trim().toLowerCase();
        const title = String(input.title || '').trim() || 'Generated image';
        const requestedFileName = String(input.fileName || input.file_name || '').trim();
        const extension = normalizeExtension(input.extension)
          || this._path.extname(requestedFileName).toLowerCase()
          || extensionForMimeType(mimeType)
          || (artifactKind === 'image' ? '.png' : '.bin');
        const fileStem = normalizeFileStem(
          requestedFileName ? this._path.basename(requestedFileName, this._path.extname(requestedFileName)) : title,
          artifactKind === 'image' ? 'generated-image' : 'binary-artifact'
        );
        return {
          artifactKind,
          title,
          fileStem,
          extension,
          write: (absolutePath, writeScope) => this._writeBufferAtomic(absolutePath, content, writeScope),
          metadata: ({ fileName, displayPath, realWrittenPath }) => {
            const hasValidatedPngDimensions = (input.png_validated === true || input.pngValidated === true)
              && Number(input.width) > 0
              && Number(input.height) > 0;
            const dimensions = mimeType === 'image/png' && !hasValidatedPngDimensions
              ? parsePngDimensions(content)
              : { width: 0, height: 0 };
            return {
              artifact_id: buildArtifactId(safeSessionId, fileName),
              artifact_kind: artifactKind,
              title,
              file_name: fileName,
              display_path: displayPath,
              absolute_path: realWrittenPath,
              language: '',
              mime_type: mimeType,
              width: Number(input.width || dimensions.width || 0),
              height: Number(input.height || dimensions.height || 0),
              editable: false,
              status: 'available',
            };
          },
        };
      },
    }, scope);
  }

  async readArtifact(sessionId, artifactId) {
    return this._readArtifact(sanitizeSessionId(sessionId), artifactId, null); }

  async _readArtifact(sessionId, artifactId, admittedAuthority) {
    const scope = this._captureSessionScope(sessionId, admittedAuthority);
    const artifact = await this._resolveArtifact(sessionId, artifactId, {}, scope);
    if (artifact.status !== 'available') {
      throw artifactError(
        ARTIFACT_ERROR_CODES.FILE_UNAVAILABLE,
        'Artifact file is unavailable.'
      );
    }
    if (!artifact.editable) {
      const mimeType = normalizeMimeType(artifact.mime_type);
      if (artifact.artifact_kind === 'image' && isDataUrlPreviewMimeType(mimeType)) {
        this._assertSessionScopeCurrent(scope);
        const stats = await this._fs.stat(artifact.absolute_path).catch(() => null);
        this._assertSessionScopeCurrent(scope);
        if (stats?.isFile() && Number(stats.size || 0) <= MAX_BINARY_ARTIFACT_BYTES) {
          this._assertSessionScopeCurrent(scope);
          const buffer = await this._fs.readFile(artifact.absolute_path);
          this._assertSessionScopeCurrent(scope);
          if (buffer.length > MAX_BINARY_ARTIFACT_BYTES) {
            return { artifact: toRendererSafeArtifact(artifact), content: '' };
          }
          return {
            artifact: toRendererSafeArtifact(artifact),
            content: '',
            asset_data_url: `data:${mimeType};base64,${buffer.toString('base64')}`,
          };
        }
      }
      return { artifact: toRendererSafeArtifact(artifact), content: '' };
    }
    this._assertSessionScopeCurrent(scope);
    const content = await this._fs.readFile(artifact.absolute_path, 'utf8');
    this._assertSessionScopeCurrent(scope);
    return { artifact: toRendererSafeArtifact(artifact), content };
  }

  async saveArtifact(sessionId, artifactId, content) {
    return this._saveArtifact(sanitizeSessionId(sessionId), artifactId, content, null); }

  async _saveArtifact(sessionId, artifactId, content, admittedAuthority) {
    const scope = this._captureSessionScope(sessionId, admittedAuthority);
    return this._withArtifactWriteLock(
      `${scope.rootPath}:${sessionId}:${String(artifactId || '').trim()}`,
      async () => {
        this._assertSessionScopeCurrent(scope);
        const artifact = await this._resolveArtifact(
          sessionId, artifactId, { requireEditable: true }, scope
        );
        const normalizedContent = String(content || '');
        if (!getEditableStateForContent(normalizedContent)) {
          throw artifactError(
            ARTIFACT_ERROR_CODES.OVERSIZED,
            'Artifact exceeds Jenny\'s 512 KB inline editor limit.'
          );
        }
        this._assertSessionScopeCurrent(scope);
        await this._writeFileAtomic(artifact.absolute_path, normalizedContent, scope);
        return {
          artifact: toRendererSafeArtifact({
            ...artifact,
            status: 'available',
          }),
        };
      }
    );
  }

  async revealArtifact(sessionId, artifactId) {
    return this._revealArtifact(sanitizeSessionId(sessionId), artifactId, null); }

  async _revealArtifact(sessionId, artifactId, admittedAuthority) {
    const scope = this._captureSessionScope(sessionId, admittedAuthority);
    const artifact = await this._resolveArtifact(sessionId, artifactId, {}, scope);
    this._assertArtifactCanExternalAction(artifact, 'revealed');
    if (!this._showItemInFolderImpl) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.REVEAL_UNAVAILABLE,
        'Reveal in folder is unavailable.'
      );
    }
    this._assertSessionScopeCurrent(scope);
    this._showItemInFolderImpl(artifact.absolute_path);
    return { ok: true, artifact: toRendererSafeArtifact(artifact) };
  }

  async openArtifactExternal(sessionId, artifactId) {
    return this._openArtifactExternal(sanitizeSessionId(sessionId), artifactId, null); }

  async _openArtifactExternal(sessionId, artifactId, admittedAuthority) {
    const scope = this._captureSessionScope(sessionId, admittedAuthority);
    const artifact = await this._resolveArtifact(sessionId, artifactId, {}, scope);
    this._assertArtifactCanExternalAction(artifact, 'opened');
    if (!this._openPathImpl) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.OPEN_UNAVAILABLE,
        'Open externally is unavailable.'
      );
    }
    this._assertSessionScopeCurrent(scope);
    const result = await this._openPathImpl(artifact.absolute_path);
    this._assertSessionScopeCurrent(scope);
    return { ok: !result, result, artifact: toRendererSafeArtifact(artifact) };
  }

  async resolveArtifact(sessionId, artifactId, { requireEditable = false } = {}) {
    return this._resolveArtifactForSession(
      sanitizeSessionId(sessionId), artifactId, { requireEditable }, null
    );
  }

  async _resolveArtifactForSession(sessionId, artifactId, options = {}, admittedAuthority = null) {
    const scope = this._captureSessionScope(sessionId, admittedAuthority);
    return this._resolveArtifact(sessionId, artifactId, options, scope);
  }

  async _resolveArtifact(sessionId, artifactId, { requireEditable = false } = {}, scope) {
    const targetId = String(artifactId || '').trim();
    const safeSessionId = sanitizeSessionId(sessionId);
    if (!targetId) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.INVALID_ARTIFACT_ID,
        'Artifact id is required.'
      );
    }

    const workspaceRoot = await this._requireWorkspaceRootForScope(scope);
    const sessionScratchDir = this._buildSessionScratchDir(workspaceRoot, safeSessionId);
    const messages = await Promise.resolve(this._sessionMessageReader(safeSessionId));
    this._assertSessionScopeCurrent(scope);
    const toolResults = Array.isArray(messages) ? messages : [];
    for (const message of toolResults) {
      const artifacts = Array.isArray(message?.tool_result?.generated_artifacts)
        ? message.tool_result.generated_artifacts
        : [];
      const match = artifacts.find((entry) => String(entry?.artifact_id || '').trim() === targetId);
      if (!match) {
        continue;
      }
      const normalized = normalizeGeneratedArtifactMetadata(match);
      if (!normalized) {
        continue;
      }
      const storedAbsolutePath = String(normalized.absolute_path || '').trim();
      const resolvedPath = isRedactedArtifactPath(storedAbsolutePath)
        ? this._path.resolve(this._path.join(workspaceRoot, normalized.display_path))
        : this._path.resolve(storedAbsolutePath);
      const rootResolved = this._path.resolve(workspaceRoot);
      this._assertPathInside(
        rootResolved,
        resolvedPath,
        ARTIFACT_ERROR_CODES.PATH_OUTSIDE_ROOT,
        'Artifact path is outside the configured workspace root.'
      );
      const sessionScratchResolved = this._path.resolve(sessionScratchDir);
      this._assertPathInside(
        sessionScratchResolved,
        resolvedPath,
        ARTIFACT_ERROR_CODES.PATH_OUTSIDE_SCRATCH,
        'Artifact path is outside the session scratch directory.'
      );
      // Symlink/junction guard: require the real path to stay within the
      // real session scratch directory (which in turn lives inside the
      // real workspace root). This blocks junctions that would let an
      // artifact read/write escape the per-session sandbox even when the
      // lexical path looks confined.
      this._assertSessionScopeCurrent(scope);
      const stats = await this._fs.stat(resolvedPath).catch(() => null);
      this._assertSessionScopeCurrent(scope);
      let effectivePath;
      const realScratchDir = await this._fs
        .realpath(sessionScratchResolved)
        .catch(() => sessionScratchResolved);
      this._assertSessionScopeCurrent(scope);
      const realWorkspaceRoot = await this._fs
        .realpath(rootResolved)
        .catch(() => rootResolved);
      this._assertSessionScopeCurrent(scope);
      this._assertPathInside(
        realWorkspaceRoot,
        realScratchDir,
        ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
        'Session scratch directory escapes the workspace root.'
      );
      const realParentDir = await this._fs
        .realpath(this._path.dirname(resolvedPath))
        .catch(() => this._path.dirname(resolvedPath));
      this._assertSessionScopeCurrent(scope);
      this._assertPathInside(
        realScratchDir,
        realParentDir,
        ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
        'Artifact real path escapes the session scratch directory.'
      );
      if (stats) {
        const realPath = await this._fs.realpath(resolvedPath).catch(() => resolvedPath);
        this._assertSessionScopeCurrent(scope);
        this._assertPathInside(
          realScratchDir,
          realPath,
          ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
          'Artifact real path escapes the session scratch directory.'
        );
        effectivePath = realPath;
      } else {
        effectivePath = this._path.join(realParentDir, this._path.basename(resolvedPath));
      }
      const actualDisplayPath = this._path.relative(rootResolved, effectivePath).replace(/\\/g, '/');
      const refreshed = {
        ...normalized,
        file_name: this._path.basename(effectivePath),
        display_path: actualDisplayPath,
        absolute_path: effectivePath,
        status: stats?.isFile() ? 'available' : 'missing',
        editable: Boolean(normalized.editable) && Boolean(stats?.isFile()) && Number(stats.size || 0) <= MAX_EDITABLE_BYTES,
      };
      if (requireEditable && !refreshed.editable) {
        throw artifactError(
          ARTIFACT_ERROR_CODES.NOT_EDITABLE,
          'Artifact is not editable in Jenny.'
        );
      }
      this._assertSessionScopeCurrent(scope);
      return refreshed;
    }
    throw artifactError(
      ARTIFACT_ERROR_CODES.NOT_FOUND,
      'Artifact not found for this session.'
    );
  }

  _assertArtifactCanExternalAction(artifact, actionName) {
    if (artifact.status !== 'available') {
      throw artifactError(
        ARTIFACT_ERROR_CODES.FILE_UNAVAILABLE,
        'Artifact file is unavailable.'
      );
    }
    if (isDangerousArtifactExtension(artifact.file_name || artifact.absolute_path, this._path)) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.DANGEROUS_EXTENSION,
        `Artifact extension is dangerous and cannot be ${actionName} externally.`
      );
    }
  }

  async _resolveRealPath(targetPath) {
    return this._fs.realpath(targetPath);
  }

  async _assertRealPathInside(targetPath, parentPath) {
    const realTarget = await this._resolveRealPath(targetPath);
    const realParent = await this._resolveRealPath(parentPath);
    if (!isPathInside(this._path, realParent, realTarget)) {
      throw artifactError(
        ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
        'Resolved path escapes the expected parent directory.'
      );
    }
    return realTarget;
  }

  async deleteSessionArtifacts(sessionId) {
    return this._deleteSessionArtifacts(sanitizeSessionId(sessionId), null); }

  async _deleteSessionArtifacts(sessionId, admittedAuthority) {
    const safeSessionId = sanitizeSessionId(sessionId);
    const scope = this._captureSessionScope(safeSessionId, admittedAuthority);
    return deleteSessionArtifactsForScope(this, safeSessionId, scope, SESSION_ARTIFACT_ROOT);
  }

  _prepareSessionArtifactDeletion(sessionId, admittedAuthority) {
    return prepareSessionArtifactDeletion(
      this, sanitizeSessionId(sessionId), admittedAuthority, SESSION_ARTIFACT_ROOT
    );
  }

  /**
   * Delete a single artifact file from disk. Only the file is removed;
   * artifact metadata remains in session messages (transcript-derived)
   * so conversation history is preserved.
   */
  async deleteArtifact(sessionId, artifactId) {
    return this._deleteArtifact(sanitizeSessionId(sessionId), artifactId, null); }

  async _deleteArtifact(sessionId, artifactId, admittedAuthority) {
    const scope = this._captureSessionScope(sessionId, admittedAuthority);
    const artifact = await this._resolveArtifact(sessionId, artifactId, {}, scope);
    // File already removed externally — treat as successful deletion.
    if (artifact.status !== 'available') {
      return { deleted: true, artifact: toRendererSafeArtifact(artifact) };
    }
    const scratchDir = this._buildSessionScratchDir(scope.rootPath, sessionId);
    await this._assertRealPathInside(artifact.absolute_path, scratchDir);
    this._assertSessionScopeCurrent(scope);
    await this._fs.rm(artifact.absolute_path, { force: true });
    this._logger('INFO', 'artifacts.file_deleted', {
      sessionId: sanitizeSessionId(sessionId),
      artifactId: String(artifactId || ''),
    });
    return { deleted: true, artifact: toRendererSafeArtifact(artifact) };
  }

  /**
   * Hold a session's scratch dir out of pruneOrphanedArtifacts while a fork
   * copies artifacts into it: the branch id only reaches listSessions() once
   * the branch persists, so an unprotected mid-copy dir reads as orphaned.
   * Ref-counted; callers must invoke the returned release fn (idempotent
   * per holder) once the branch persists or the copy is abandoned.
   */
  markSessionPruneProtected(sessionId) {
    const safeSessionId = sanitizeSessionId(sessionId);
    this._pruneProtectedSessionIds.set(
      safeSessionId,
      (this._pruneProtectedSessionIds.get(safeSessionId) || 0) + 1
    );
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const count = this._pruneProtectedSessionIds.get(safeSessionId) || 0;
      if (count <= 1) {
        this._pruneProtectedSessionIds.delete(safeSessionId);
      } else {
        this._pruneProtectedSessionIds.set(safeSessionId, count - 1);
      }
    };
  }

  /**
   * Copy the source session's artifact scratch dir into a branch session's
   * scratch dir so a fork can carry its generated artifacts (B2 of the
   * fork-artifact plan). Returns a structured result and never throws:
   *   { cloned: true, files, bytes, rewriteEntry } |
   *   { cloned: false, reason, bytes? } with reason one of
   *   workspace_root_unavailable | source_scratch_missing |
   *   size_cap_exceeded | entry_cap_exceeded | copy_failed.
   * A failed copy removes the partial target dir it created. `rewriteEntry`
   * rebases one `generated_artifacts` entry (id, display_path,
   * absolute_path) onto the branch; it returns null for entries that do not
   * normalize or whose display_path sits outside the source scratch dir -
   * callers fall back to strip-and-mark (B1) semantics for those.
   */
  async cloneSessionArtifactsForBranch(sourceSessionId, targetSessionId, { maxTotalBytes, maxEntries } = {}) {
    return this._cloneSessionArtifactsForBranch(
      sourceSessionId, targetSessionId, { maxTotalBytes, maxEntries }, null
    );
  }

  async _cloneSessionArtifactsForBranch(
    sourceSessionId,
    targetSessionId,
    { maxTotalBytes, maxEntries } = {},
    admittedAuthority = null
  ) {
    return cloneSessionArtifactsForBranch(
      this,
      sourceSessionId,
      targetSessionId,
      { maxTotalBytes, maxEntries },
      admittedAuthority,
      {
        maxTotalBytes: MAX_BRANCH_CLONE_TOTAL_BYTES,
        maxEntries: MAX_BRANCH_CLONE_ENTRIES,
        sessionArtifactRoot: SESSION_ARTIFACT_ROOT,
        isRedactedArtifactPath,
        sanitizeSessionId,
      }
    );
  }

  /**
   * @param {string[]|Function} activeSessionIds - Active session ids, or a
   *   provider re-invoked immediately before each deletion. Callers should
   *   pass a provider: a fork can persist a branch session (and release its
   *   prune protection) while a prune pass is mid-flight, and only a fresh
   *   re-resolve keeps that branch's freshly copied dir from being deleted
   *   on a stale snapshot.
   */
  async pruneOrphanedArtifacts(activeSessionIds) {
    if (this._sessionAuthority.hasProvider) return { removed: 0 };
    return this._pruneOrphanedArtifacts(activeSessionIds, null, null); }

  async _pruneOrphanedArtifacts(activeSessionIds, admittedAuthority, admittedSessionId) {
    let scope = null;
    if (admittedAuthority && admittedSessionId) {
      scope = this._captureSessionScope(admittedSessionId, admittedAuthority);
    }
    // Legacy artifact dirs cannot prove orphan ownership across projects that share a root;
    // scoped facades therefore leave cleanup to explicit session deletion.
    if (scope?.kind === 'project') return { removed: 0 };
    const workspaceRoot = scope ? scope.rootPath : this.getWorkspaceRoot();
    if (!workspaceRoot) return { removed: 0 };
    const artifactsRoot = this._path.join(
      this._path.resolve(workspaceRoot),
      SESSION_ARTIFACT_ROOT
    );
    if (scope) this._assertSessionScopeCurrent(scope);
    const stats = await this._fs.stat(artifactsRoot).catch(() => null);
    if (scope) this._assertSessionScopeCurrent(scope);
    if (!stats?.isDirectory()) return { removed: 0 };
    const resolveActiveSet = () => {
      // Fail closed: if the active set cannot be resolved, prune nothing.
      try {
        const ids = typeof activeSessionIds === 'function'
          ? activeSessionIds()
          : activeSessionIds;
        return new Set(
          (Array.isArray(ids) ? ids : []).map((id) => sanitizeSessionId(id))
        );
      } catch (_error) {
        return null;
      }
    };
    const activeSet = resolveActiveSet();
    if (!activeSet) return { removed: 0 };
    const entries = await this._fs.readdir(artifactsRoot, { withFileTypes: true });
    if (scope) this._assertSessionScopeCurrent(scope);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (activeSet.has(entry.name)) continue;
      // In-flight fork copies register protection BEFORE creating the dir
      // and release it only AFTER the branch session persists. Checking
      // protection first and then re-resolving the active set therefore
      // closes the stale-snapshot race: a dir that is no longer protected
      // is either already persisted (fresh set contains it) or genuinely
      // orphaned.
      if (this._pruneProtectedSessionIds.has(entry.name)) continue;
      const freshActiveSet = resolveActiveSet();
      if (!freshActiveSet || freshActiveSet.has(entry.name)) continue;
      const fullPath = this._path.join(artifactsRoot, entry.name);
      try {
        await this._assertRealPathInside(fullPath, artifactsRoot);
        if (scope) this._assertSessionScopeCurrent(scope);
        await this._fs.rm(fullPath, { recursive: true, force: true });
        removed += 1;
      } catch (_) {
        // Skip entries that resolve outside the artifacts root (e.g. symlinks).
      }
    }
    if (removed) {
      this._logger('INFO', 'artifacts.orphans_pruned', { removed });
    }
    return { removed };
  }

  async _pathExists(targetPath) {
    try {
      await this._fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async _writeFileAtomic(targetPath, content, scope = null) {
    const tempPath = `${targetPath}.tmp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      if (scope) this._assertSessionScopeCurrent(scope);
      await this._fs.writeFile(tempPath, String(content || ''), 'utf8');
      if (scope) this._assertSessionScopeCurrent(scope);
      await this._fs.rename(tempPath, targetPath);
      if (scope) this._assertSessionScopeCurrent(scope);
    } catch (error) {
      await this._fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async _writeBufferAtomic(targetPath, content, scope = null) {
    const tempPath = `${targetPath}.tmp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      if (scope) this._assertSessionScopeCurrent(scope);
      await this._fs.writeFile(tempPath, Buffer.isBuffer(content) ? content : Buffer.from(content || []));
      if (scope) this._assertSessionScopeCurrent(scope);
      await this._fs.rename(tempPath, targetPath);
      if (scope) this._assertSessionScopeCurrent(scope);
    } catch (error) {
      await this._fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  _withArtifactWriteLock(lockKey, action) {
    const key = String(lockKey || '').trim() || 'artifact';
    const previous = this._writeLocks.get(key) || Promise.resolve();
    const next = previous.then(action, action);
    const cleanup = next.finally(() => {
      if (this._writeLocks.get(key) === next) {
        this._writeLocks.delete(key);
      }
    });
    cleanup.catch(() => {});
    this._writeLocks.set(key, next);
    return next;
  }
}

module.exports = {
  DANGEROUS_ARTIFACT_EXTENSIONS,
  MAX_BINARY_ARTIFACT_BYTES,
  MAX_BRANCH_CLONE_TOTAL_BYTES,
  MAX_EDITABLE_BYTES,
  SESSION_ARTIFACT_ROOT,
  ArtifactWorkspaceService,
  isDangerousArtifactExtension,
};
