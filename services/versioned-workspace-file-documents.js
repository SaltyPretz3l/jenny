'use strict';

const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');
const { createFileVersion } = require('./versioned-workspace-file-bytes');
const { buildPathHint, replaceFileBytes } = require('./versioned-workspace-file-replace');

const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const DOCUMENT_FORMATS = Object.freeze({
  docx: {
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  pdf: { extension: 'pdf', mime: 'application/pdf' },
});

function getDocumentDescriptor(relPath) {
  const fileName = String(relPath || '').replace(/\\/g, '/').split('/').pop() || '';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return null;
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  const format = DOCUMENT_FORMATS[extension];
  return format
    ? Object.freeze({ format: extension, extension: format.extension, mime: format.mime })
    : null;
}

function getMatchingDocumentDescriptor(requestedPath, canonicalPath) {
  const requested = getDocumentDescriptor(requestedPath);
  const canonical = getDocumentDescriptor(canonicalPath);
  return requested && canonical && requested.format === canonical.format ? canonical : null;
}

function documentBytesMatchDescriptor(bytes, descriptor) {
  if (!Buffer.isBuffer(bytes) || !descriptor) return false;
  if (descriptor.format === 'docx') {
    return bytes.length >= 4
      && bytes[0] === 0x50
      && bytes[1] === 0x4b
      && bytes[2] === 0x03
      && bytes[3] === 0x04;
  }
  return descriptor.format === 'pdf'
    && bytes.length >= 5
    && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}

function buildDocumentMetadata(state, context, requestedPathKey, descriptor, { includeBytes }) {
  return {
    path: state.displayPath,
    pathKey: state.pathKey,
    requestedPath: state.requestedPath,
    requestedPathKey,
    size: state.bytes.length,
    mtimeMs: state.stats.mtimeMs,
    rootId: context.rootId,
    generation: context.generation,
    fileVersion: state.fileVersion,
    kind: 'document',
    format: descriptor.format,
    representation: 'base64',
    mime: descriptor.mime,
    ...(includeBytes ? { base64: state.bytes.toString('base64') } : {}),
    editable: true,
    truncated: false,
  };
}

function unsupportedDocument(relPath, message) {
  return workspaceFsError(
    WORKSPACE_FS_ERROR_CODES.DOCUMENT_UNSUPPORTED,
    message,
    buildPathHint(relPath)
  );
}

async function readDocument(service, payload) {
  const relPath = service._normalizeRelPath(payload.path);
  if (!getDocumentDescriptor(relPath)) {
    throw unsupportedDocument(
      relPath,
      'Only PDF and DOCX workspace documents can be opened as documents.'
    );
  }
  const capturedContext = service._captureContext();
  try {
    return await service._withResourceLease('read', relPath, capturedContext, async (lease) => {
      const root = await service._prepareRoot(lease);
      const target = await service._resolveTarget(root, relPath, lease);
      const descriptor = getMatchingDocumentDescriptor(relPath, target.displayPath);
      if (!descriptor) {
        throw unsupportedDocument(
          relPath,
          'Only PDF and DOCX workspace documents can be opened as documents.'
        );
      }
      const state = await service._openStableBytes(root, target, lease, 'read-document', {
        maxBytes: service._maxDocumentBytes,
        tooLargeCode: WORKSPACE_FS_ERROR_CODES.DOCUMENT_TOO_LARGE,
        tooLargeMessage: 'Document is too large to open.',
      });
      if (!documentBytesMatchDescriptor(state.bytes, descriptor)) {
        throw unsupportedDocument(relPath, 'The file is not a valid PDF or DOCX document.');
      }
      service._assertCurrent(lease);
      return buildDocumentMetadata(
        state,
        lease.context,
        service._pathKey(state.requestedPath),
        descriptor,
        { includeBytes: true }
      );
    });
  } catch (error) {
    if (service._structured(error)) throw error;
    throw service._ioError('read_document', relPath, error);
  }
}

function validateWriteDocumentPayload(service, payload) {
  const relPath = service._normalizeRelPath(payload?.path);
  const descriptor = getDocumentDescriptor(relPath);
  if (!descriptor || payload?.format !== descriptor.format) {
    throw unsupportedDocument(
      relPath,
      'Document format must match a PDF or DOCX file extension.'
    );
  }
  if (typeof payload.base64 !== 'string'
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.base64)
    || payload.base64.length % 4 !== 0) {
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING,
      'Document bytes must be valid base64.',
      buildPathHint(relPath)
    );
  }
  if (!Number.isSafeInteger(payload.expectedGeneration) || payload.expectedGeneration < 0) {
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.STALE_GENERATION,
      'A valid workspace generation is required before saving.'
    );
  }
  if (typeof payload.expectedFileVersion !== 'string'
    || !payload.expectedFileVersion
    || payload.expectedFileVersion.length > 256) {
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT,
      'A valid file version is required before saving.',
      buildPathHint(relPath)
    );
  }
  const bytes = Buffer.from(payload.base64, 'base64');
  if (bytes.length === 0 || bytes.length > service._maxDocumentBytes) {
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.DOCUMENT_TOO_LARGE,
      'Document bytes must be non-empty and within the save limit.',
      { ...buildPathHint(relPath), size: bytes.length, max_bytes: service._maxDocumentBytes }
    );
  }
  if (!documentBytesMatchDescriptor(bytes, descriptor)) {
    throw unsupportedDocument(
      relPath,
      `Saved bytes are not a valid ${descriptor.format.toUpperCase()} document.`
    );
  }
  return { relPath, descriptor, bytes };
}

async function writeDocument(service, payload) {
  const { relPath, descriptor, bytes } = validateWriteDocumentPayload(service, payload);
  const capturedContext = service._captureContext(payload.expectedGeneration);
  try {
    return await service._withResourceLease('mutation', relPath, capturedContext, async (lease) => {
      const root = await service._prepareRoot(lease);
      const initialTarget = await service._resolveTarget(root, relPath, lease);
      const lockKey = `${lease.context.rootId}:${lease.context.generation}:${initialTarget.pathKey}`;
      return await service._withPathLock(lockKey, lease, {
        operationId: lease.operationId,
        path: initialTarget.displayPath,
      }, async () => {
        const target = await service._resolveTarget(root, relPath, lease);
        if (target.pathKey !== initialTarget.pathKey) {
          throw workspaceFsError(
            WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT,
            'The file path identity changed before saving.',
            buildPathHint(relPath)
          );
        }
        const current = await service._openStableBytes(root, target, lease, 'write-current', {
          maxBytes: service._maxDocumentBytes,
          tooLargeCode: WORKSPACE_FS_ERROR_CODES.DOCUMENT_TOO_LARGE,
          tooLargeMessage: 'Document is too large to save.',
        });
        if (current.fileVersion !== payload.expectedFileVersion) {
          throw workspaceFsError(
            WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT,
            'File changed on disk since it was loaded.',
            {
              ...buildPathHint(relPath),
              current_file_version: current.fileVersion,
            }
          );
        }
        if (bytes.equals(current.bytes)) {
          return buildDocumentMetadata(
            current,
            lease.context,
            service._pathKey(current.requestedPath),
            descriptor,
            { includeBytes: false }
          );
        }
        const landed = await replaceFileBytes(service, {
          root,
          target,
          relPath,
          current,
          bytes,
          lease,
          buildLanded: (snapshot, landedBytes) => ({
            ...snapshot,
            bytes: landedBytes,
            fileVersion: createFileVersion(snapshot.stats, landedBytes),
          }),
        });
        return buildDocumentMetadata(
          landed,
          lease.context,
          service._pathKey(landed.requestedPath),
          descriptor,
          { includeBytes: false }
        );
      });
    });
  } catch (error) {
    if (service._structured(error)) throw error;
    throw service._ioError('write_document', relPath, error);
  }
}

module.exports = {
  DEFAULT_MAX_DOCUMENT_BYTES,
  DOCUMENT_FORMATS,
  buildDocumentMetadata,
  documentBytesMatchDescriptor,
  getDocumentDescriptor,
  getMatchingDocumentDescriptor,
  readDocument,
  writeDocument,
};
