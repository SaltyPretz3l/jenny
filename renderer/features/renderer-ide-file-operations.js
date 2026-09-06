/* renderer/features/renderer-ide-file-operations.js
 *
 * Single owner for renderer text-file operation ordering and document identity.
 * Every bridge result is checked against the open intent, controller epoch,
 * canonical path key, workspace root/generation, document id, and edit version
 * before a caller may mutate editor state. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeFileOperations = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_PREVIEW_PATH_REVISIONS = 512;
  const IMAGE_MIME_BY_EXTENSION = Object.freeze({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  });

  function normalizePath(value) {
    return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  }

  function isWindowsPlatform(platform) {
    return /^(win|windows)/i.test(String(platform || ''));
  }

  function createPathKey(path, platform) {
    const normalized = normalizePath(path);
    return isWindowsPlatform(platform) ? normalized.toLocaleLowerCase('en-US') : normalized;
  }

  function operationError(result, fallback) {
    const error = new Error(String(result?.message || fallback || 'Workspace file operation failed.'));
    error.code = String(result?.code || result?.error_code || 'workspace_file_operation_failed');
    error.error_code = error.code;
    error.details = result?.details && typeof result.details === 'object' ? result.details : {};
    return error;
  }

  function createIdeFileOperations(options = {}) {
    const getWorkspaceFsApi = typeof options.getWorkspaceFsApi === 'function'
      ? options.getWorkspaceFsApi
      : () => null;
    const platform = String(options.platform
      || (typeof navigator !== 'undefined' ? navigator.platform : '')
      || (typeof process !== 'undefined' ? process.platform : ''));
    const documents = new Map();
    const pathAliases = new Map();
    const previewPathRevisions = new Map();
    let activeContext = null;
    let controllerEpoch = 1;
    let documentSequence = 0;
    let openIntentSequence = 0;
    let previewIntentSequence = 0;
    let externalChangeSequence = 0;
    let previewRevisionEpoch = 0;
    let operationSequence = 0;
    let disposed = false;
    let queueTail = Promise.resolve();

    function pathKey(path) {
      return createPathKey(path, platform);
    }

    function cloneToken(token) {
      return token ? Object.freeze({ ...token }) : null;
    }

    function canonicalKey(path) {
      const key = pathKey(path);
      return pathAliases.get(key) || key;
    }

    function getMutable(path) {
      return documents.get(canonicalKey(path)) || null;
    }

    function registerPathIdentity(requestedPath, result) {
      const canonical = String(result?.pathKey || '');
      if (!canonical) return;
      pathAliases.set(canonical, canonical);
      pathAliases.set(pathKey(requestedPath), canonical);
      if (result.requestedPath) pathAliases.set(pathKey(result.requestedPath), canonical);
    }

    function getDocumentToken(path) {
      return cloneToken(getMutable(path));
    }

    function resolvePath(path) {
      return getMutable(path)?.path || normalizePath(path);
    }

    function currentContextMatches(rootId, generation) {
      return !activeContext || (
        activeContext.rootId === rootId
        && activeContext.generation === generation
      );
    }

    function validateReadResult(result, requestedPath, { allowPreview = false } = {}) {
      if (!result || result.ok !== true) throw operationError(result, 'Could not read the workspace file.');
      const canonicalPath = normalizePath(result.path);
      const canonicalKey = String(result.pathKey || '');
      const requestedKey = String(result.requestedPathKey || '');
      if (!canonicalPath
        || !canonicalKey
        || !requestedKey
        || canonicalKey !== pathKey(canonicalPath)
        || requestedKey !== pathKey(requestedPath)
        || typeof result.rootId !== 'string'
        || !result.rootId
        || !Number.isSafeInteger(result.generation)
        || typeof result.fileVersion !== 'string'
        || !result.fileVersion
        || typeof result.content !== 'string'
        || (!allowPreview && result.editable !== true)) {
        throw operationError({
          code: 'workspace_file_result_invalid',
          message: 'The workspace returned an invalid or stale file response.',
        });
      }
      return { ...result, path: canonicalPath, pathKey: canonicalKey };
    }

    function validateWriteResult(result, snapshot) {
      if (!result || result.ok !== true) throw operationError(result, 'Could not save the workspace file.');
      if (normalizePath(result.path) !== snapshot.path
        || String(result.pathKey || '') !== snapshot.pathKey
        || result.rootId !== snapshot.rootId
        || result.generation !== snapshot.generation
        || typeof result.fileVersion !== 'string'
        || !result.fileVersion) {
        throw operationError({
          code: 'workspace_file_result_invalid',
          message: 'The workspace returned an invalid or stale save response.',
        });
      }
      return result;
    }

    function base64DecodedSize(value) {
      if (typeof value !== 'string' || value.length % 4 !== 0) return -1;
      if (value && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1;
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
      return (value.length / 4) * 3 - padding;
    }

    function imageMimeForPath(path) {
      const fileName = normalizePath(path).split('/').pop() || '';
      const dotIndex = fileName.lastIndexOf('.');
      return dotIndex > 0 ? IMAGE_MIME_BY_EXTENSION[fileName.slice(dotIndex + 1).toLowerCase()] || '' : '';
    }

    function validateImageResult(result, requestedPath) {
      if (!result || result.ok !== true) throw operationError(result, 'Could not read the workspace image.');
      const canonicalPath = normalizePath(result.path);
      const canonicalKey = String(result.pathKey || '');
      const requestedKey = String(result.requestedPathKey || '');
      const expectedMime = imageMimeForPath(canonicalPath);
      const requestedMime = imageMimeForPath(requestedPath);
      if (!canonicalPath
        || !canonicalKey
        || !requestedKey
        || canonicalKey !== pathKey(canonicalPath)
        || requestedKey !== pathKey(requestedPath)
        || typeof result.rootId !== 'string'
        || !result.rootId
        || !Number.isSafeInteger(result.generation)
        || typeof result.fileVersion !== 'string'
        || !result.fileVersion
        || result.kind !== 'image'
        || result.representation !== 'base64'
        || !expectedMime
        || requestedMime !== expectedMime
        || result.mime !== expectedMime
        || !Number.isSafeInteger(result.size)
        || result.size < 0
        || result.size > MAX_IMAGE_BYTES
        || base64DecodedSize(result.base64) !== result.size
        || result.editable !== false
        || result.truncated !== false) {
        throw operationError({
          code: 'workspace_file_result_invalid',
          message: 'The workspace returned an invalid or stale image response.',
        });
      }
      return { ...result, path: canonicalPath, pathKey: canonicalKey };
    }

    function runQueued(run) {
      operationSequence += 1;
      const operationId = operationSequence;
      const operationEpoch = controllerEpoch;
      const execute = queueTail.then(async () => {
        if (disposed || operationEpoch !== controllerEpoch) {
          throw operationError({ code: 'workspace_file_operation_stale', message: 'The file operation is no longer current.' });
        }
        const result = await run({ operationId, controllerEpoch: operationEpoch });
        if (disposed || operationEpoch !== controllerEpoch) {
          throw operationError({ code: 'workspace_file_operation_stale', message: 'The file operation is no longer current.' });
        }
        return result;
      });
      queueTail = execute.catch(() => undefined);
      return execute;
    }

    function beginOpen(path) {
      openIntentSequence += 1;
      return Object.freeze({
        id: openIntentSequence,
        path: normalizePath(path),
        pathKey: pathKey(path),
        controllerEpoch,
      });
    }

    function isOpenIntentCurrent(intent) {
      return Boolean(intent
        && !disposed
        && intent.id === openIntentSequence
        && intent.controllerEpoch === controllerEpoch);
    }

    function cancelOpenIntents() {
      openIntentSequence += 1;
    }

    async function readForOpen(intent, { preview = false } = {}) {
      if (!isOpenIntentCurrent(intent)) return { stale: true, payload: null };
      return runQueued(async () => {
        if (!isOpenIntentCurrent(intent)) return { stale: true, payload: null };
        const api = getWorkspaceFsApi();
        if (typeof api?.readText !== 'function') {
          throw operationError({
            code: 'versioned_file_bridge_unavailable',
            message: 'Versioned workspace file access is unavailable.',
          });
        }
        const result = await api.readText({ path: intent.path, intent: preview ? 'preview' : 'edit' });
        if (!isOpenIntentCurrent(intent)) return { stale: true, payload: null };
        const payload = validateReadResult(result, intent.path, { allowPreview: preview });
        if (!currentContextMatches(payload.rootId, payload.generation)) return { stale: true, payload: null };
        return { stale: false, payload };
      });
    }

    async function readImageForOpen(intent) {
      if (!isOpenIntentCurrent(intent)) return { stale: true, payload: null };
      return runQueued(async () => {
        if (!isOpenIntentCurrent(intent)) return { stale: true, payload: null };
        const api = getWorkspaceFsApi();
        if (typeof api?.readImage !== 'function') {
          throw operationError({
            code: 'versioned_file_bridge_unavailable',
            message: 'Versioned workspace image access is unavailable.',
          });
        }
        const result = await api.readImage({ path: intent.path });
        if (!isOpenIntentCurrent(intent)) return { stale: true, payload: null };
        const payload = validateImageResult(result, intent.path);
        if (!currentContextMatches(payload.rootId, payload.generation)) return { stale: true, payload: null };
        return { stale: false, payload };
      });
    }

    function beginPreview(path) {
      previewIntentSequence += 1;
      const normalized = normalizePath(path);
      return Object.freeze({
        id: previewIntentSequence,
        path: normalized,
        pathKey: pathKey(normalized),
        controllerEpoch,
        externalChangeSequence,
      });
    }

    function isPreviewIntentCurrent(intent) {
      return Boolean(intent
        && !disposed
        && intent.id === previewIntentSequence
        && intent.controllerEpoch === controllerEpoch);
    }

    function previewChangedSinceIntent(intent, payload = null) {
      const keys = new Set([
        intent?.pathKey,
        intent?.path ? canonicalKey(intent.path) : '',
        String(payload?.pathKey || ''),
        String(payload?.requestedPathKey || ''),
      ]);
      return [...keys].some((key) => key
        && (previewPathRevisions.get(key) ?? previewRevisionEpoch) > (intent?.externalChangeSequence || 0));
    }

    function cancelPreviewIntents() {
      previewIntentSequence += 1;
    }

    function getPreviewRequestSignature(path) {
      const key = canonicalKey(path);
      return `${controllerEpoch}:${key}:${previewPathRevisions.get(key) ?? previewRevisionEpoch}`;
    }

    function setPreviewPathRevision(key) {
      if (!key) return;
      if (previewPathRevisions.has(key)) previewPathRevisions.delete(key);
      previewPathRevisions.set(key, externalChangeSequence);
      while (previewPathRevisions.size > MAX_PREVIEW_PATH_REVISIONS) {
        const oldest = previewPathRevisions.entries().next().value;
        previewPathRevisions.delete(oldest[0]);
        previewRevisionEpoch = Math.max(previewRevisionEpoch, oldest[1]);
      }
    }

    function noteExternalChange(path) {
      externalChangeSequence += 1;
      const requestedKey = pathKey(path);
      const targetKey = canonicalKey(path);
      setPreviewPathRevision(requestedKey);
      setPreviewPathRevision(targetKey);
      for (const [alias, canonical] of pathAliases) {
        if (canonical === targetKey) setPreviewPathRevision(alias);
      }
    }

    async function readForPreview(intent, { maxBytes = 1_500_000 } = {}) {
      if (!isPreviewIntentCurrent(intent)) return { stale: true, payload: null };
      return runQueued(async () => {
        if (!isPreviewIntentCurrent(intent)) return { stale: true, payload: null };
        const api = getWorkspaceFsApi();
        if (typeof api?.readText !== 'function') {
          throw operationError({
            code: 'versioned_file_bridge_unavailable',
            message: 'Versioned workspace preview access is unavailable.',
          });
        }
        const result = await api.readText({ path: intent.path, intent: 'preview', maxBytes });
        if (!isPreviewIntentCurrent(intent)) return { stale: true, payload: null };
        const payload = validateReadResult(result, intent.path, { allowPreview: true });
        if (!currentContextMatches(payload.rootId, payload.generation)
          || previewChangedSinceIntent(intent, payload)) return { stale: true, payload: null };
        registerPathIdentity(intent.path, payload);
        return { stale: false, payload };
      });
    }

    function commitDocumentOpen(intent, payload, documentKind) {
      if (!isOpenIntentCurrent(intent)) return null;
      const result = documentKind === 'image'
        ? validateImageResult(payload, intent.path)
        : validateReadResult(payload, intent.path);
      if (!currentContextMatches(result.rootId, result.generation)) return null;
      registerPathIdentity(intent.path, result);
      activeContext = Object.freeze({ rootId: result.rootId, generation: result.generation });
      documentSequence += 1;
      const token = {
        path: result.path,
        pathKey: result.pathKey,
        rootId: result.rootId,
        generation: result.generation,
        documentId: `document-${controllerEpoch}-${documentSequence}`,
        editVersion: 0,
        dirty: false,
        fileVersion: result.fileVersion,
        editable: result.editable === true,
        documentKind,
        controllerEpoch,
      };
      documents.set(token.pathKey, token);
      return cloneToken(token);
    }

    function commitOpen(intent, payload) {
      return commitDocumentOpen(intent, payload, 'text');
    }

    function commitImageOpen(intent, payload) {
      return commitDocumentOpen(intent, payload, 'image');
    }

    function noteEdit(path) {
      const token = getMutable(path);
      if (!token) return false;
      token.editVersion += 1;
      return true;
    }

    function noteDirty(path, dirty) {
      const token = getMutable(path);
      if (!token) return false;
      token.dirty = dirty === true;
      return true;
    }

    function captureSave(path, { content, savedVersionId } = {}) {
      const token = getMutable(path);
      if (!token
        || token.editable !== true
        || token.controllerEpoch !== controllerEpoch
        || typeof content !== 'string') return null;
      return Object.freeze({
        ...token,
        content,
        savedVersionId: savedVersionId == null ? null : savedVersionId,
      });
    }

    function sameDocument(snapshot) {
      const token = snapshot && documents.get(snapshot.pathKey);
      return Boolean(token
        && !disposed
        && token.documentId === snapshot.documentId
        && token.rootId === snapshot.rootId
        && token.generation === snapshot.generation
        && token.controllerEpoch === snapshot.controllerEpoch
        && snapshot.controllerEpoch === controllerEpoch);
    }

    async function write(snapshot) {
      if (!sameDocument(snapshot)) {
        throw operationError({ code: 'workspace_file_operation_stale', message: 'The editor document changed before it could be saved.' });
      }
      return runQueued(async () => {
        if (!sameDocument(snapshot)) {
          throw operationError({ code: 'workspace_file_operation_stale', message: 'The editor document changed before it could be saved.' });
        }
        const api = getWorkspaceFsApi();
        if (typeof api?.writeText !== 'function') {
          throw operationError({
            code: 'versioned_file_bridge_unavailable',
            message: 'Versioned workspace file access is unavailable.',
          });
        }
        const result = await api.writeText({
          path: snapshot.path,
          content: snapshot.content,
          expectedGeneration: snapshot.generation,
          expectedFileVersion: snapshot.fileVersion,
        });
        return validateWriteResult(result, snapshot);
      });
    }

    function acceptWrite(snapshot, result) {
      if (!sameDocument(snapshot)) return { current: false, exactEdit: false };
      const token = documents.get(snapshot.pathKey);
      token.fileVersion = result.fileVersion;
      const exactEdit = token.editVersion === snapshot.editVersion;
      return { current: true, exactEdit };
    }

    function canApplyWrite(snapshot) {
      if (!sameDocument(snapshot)) return false;
      return documents.get(snapshot.pathKey).editVersion === snapshot.editVersion;
    }

    async function readForMutation(path) {
      const requestedPath = normalizePath(path);
      return runQueued(async ({ operationId, controllerEpoch: operationEpoch }) => {
        const api = getWorkspaceFsApi();
        if (typeof api?.readText !== 'function') throw operationError(null, 'Versioned workspace file access is unavailable.');
        const result = validateReadResult(await api.readText({ path: requestedPath, intent: 'edit' }), requestedPath);
        if (!currentContextMatches(result.rootId, result.generation)) {
          throw operationError({ code: 'workspace_file_operation_stale', message: 'The workspace root changed during the file read.' });
        }
        return Object.freeze({
          ...result,
          documentId: `mutation-${operationEpoch}-${operationId}`,
          editVersion: 0,
          dirty: false,
          controllerEpoch: operationEpoch,
        });
      });
    }

    async function writeMutation(snapshot, content) {
      if (!snapshot || snapshot.controllerEpoch !== controllerEpoch || typeof content !== 'string') {
        throw operationError({ code: 'workspace_file_operation_stale', message: 'The file mutation is no longer current.' });
      }
      return runQueued(async () => {
        if (snapshot.controllerEpoch !== controllerEpoch) {
          throw operationError({ code: 'workspace_file_operation_stale', message: 'The file mutation is no longer current.' });
        }
        const api = getWorkspaceFsApi();
        if (typeof api?.writeText !== 'function') throw operationError(null, 'Versioned workspace file access is unavailable.');
        const result = await api.writeText({
          path: snapshot.path,
          content,
          expectedGeneration: snapshot.generation,
          expectedFileVersion: snapshot.fileVersion,
        });
        return validateWriteResult(result, snapshot);
      });
    }

    function captureReload(path, { allowDirty = false } = {}) {
      const token = getMutable(path);
      return token && (allowDirty || token.dirty !== true) ? cloneToken(token) : null;
    }

    function reloadIsCurrent(snapshot, { allowDirty = false } = {}) {
      if (!sameDocument(snapshot)) return false;
      const token = documents.get(snapshot.pathKey);
      return token.editVersion === snapshot.editVersion
        && token.fileVersion === snapshot.fileVersion
        && (allowDirty || token.dirty !== true);
    }

    async function readForReload(snapshot, reloadOptions = {}) {
      if (!reloadIsCurrent(snapshot, reloadOptions)) return { stale: true, payload: null };
      return runQueued(async () => {
        if (!reloadIsCurrent(snapshot, reloadOptions)) return { stale: true, payload: null };
        const api = getWorkspaceFsApi();
        if (typeof api?.readText !== 'function') throw operationError(null, 'Versioned workspace file access is unavailable.');
        const result = await api.readText({ path: snapshot.path, intent: 'edit' });
        const payload = validateReadResult(result, snapshot.path);
        if (!reloadIsCurrent(snapshot, reloadOptions)
          || payload.rootId !== snapshot.rootId
          || payload.generation !== snapshot.generation) return { stale: true, payload: null };
        return { stale: false, payload };
      });
    }

    async function readImageForReload(snapshot) {
      if (!reloadIsCurrent(snapshot) || snapshot.documentKind !== 'image') {
        return { stale: true, payload: null };
      }
      return runQueued(async () => {
        if (!reloadIsCurrent(snapshot) || snapshot.documentKind !== 'image') {
          return { stale: true, payload: null };
        }
        const api = getWorkspaceFsApi();
        if (typeof api?.readImage !== 'function') {
          throw operationError(null, 'Versioned workspace image access is unavailable.');
        }
        const result = await api.readImage({ path: snapshot.path });
        const payload = validateImageResult(result, snapshot.path);
        if (!reloadIsCurrent(snapshot)
          || payload.rootId !== snapshot.rootId
          || payload.generation !== snapshot.generation) return { stale: true, payload: null };
        return { stale: false, payload };
      });
    }

    function commitReload(snapshot, payload, reloadOptions = {}) {
      if (!reloadIsCurrent(snapshot, reloadOptions)) return false;
      const token = documents.get(snapshot.pathKey);
      if (token.editVersion !== snapshot.editVersion
        || (reloadOptions.allowDirty !== true && token.dirty === true)) return false;
      token.fileVersion = payload.fileVersion;
      if (reloadOptions.allowDirty === true) token.dirty = false;
      return true;
    }

    function canCommitReload(snapshot, payload, reloadOptions = {}) {
      return reloadIsCurrent(snapshot, reloadOptions)
        && payload?.rootId === snapshot.rootId
        && payload?.generation === snapshot.generation
        && String(payload?.pathKey || '') === snapshot.pathKey;
    }

    function close(path) {
      const key = canonicalKey(path);
      const removed = documents.delete(key);
      for (const [alias, canonical] of pathAliases) {
        if (canonical === key) pathAliases.delete(alias);
      }
      return removed;
    }

    function reset(context = null) {
      controllerEpoch += 1;
      openIntentSequence += 1;
      previewIntentSequence += 1;
      documents.clear();
      pathAliases.clear();
      previewPathRevisions.clear();
      queueTail = Promise.resolve();
      activeContext = context
        && typeof context.rootId === 'string'
        && Number.isSafeInteger(context.generation)
        ? Object.freeze({ rootId: context.rootId, generation: context.generation })
        : null;
    }

    function acceptsWatcherPayload(payload) {
      if (!activeContext) return true;
      const context = payload?.context || payload;
      return context?.rootId === activeContext.rootId
        && context?.generation === activeContext.generation;
    }

    function dispose() {
      disposed = true;
      reset();
    }

    return {
      acceptWrite,
      acceptsWatcherPayload,
      beginOpen,
      beginPreview,
      canApplyWrite,
      canCommitReload,
      cancelOpenIntents,
      cancelPreviewIntents,
      captureReload,
      captureSave,
      close,
      commitOpen,
      commitImageOpen,
      commitReload,
      createPathKey: pathKey,
      dispose,
      getDocumentToken,
      getPreviewRequestSignature,
      isOpenIntentCurrent,
      isDocumentCurrent: sameDocument,
      noteDirty,
      noteEdit,
      noteExternalChange,
      readForPreview,
      readImageForOpen,
      readImageForReload,
      readForOpen,
      readForMutation,
      readForReload,
      reset,
      resolvePath,
      write,
      writeMutation,
    };
  }

  return {
    createIdeFileOperations,
    createPathKey,
  };
});
