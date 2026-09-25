'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('node:path');

const { t } = require('../i18n-main');
const { PROJECT_ERROR_CODES } = require('../backend/error-codes');

const MAX_DRAFT_IMAGE_RECEIPTS = 4096;
const MAX_ATTACHMENT_ID_CHARS = 256;
const MAX_ASSET_PATH_CHARS = 4096;
const importScopes = new WeakMap();

function boundedToken(value, maxChars) {
  const token = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex -- capability identifiers reject control bytes.
  return token && token.length <= maxChars && !/[\u0000-\u001f\u007f]/u.test(token)
    ? token
    : '';
}

function readSessionSummary(sessionStore, sessionId) {
  if (!sessionStore || !sessionId) return null;
  if (typeof sessionStore.getSessionSummary === 'function') {
    return sessionStore.getSessionSummary(sessionId);
  }
  if (typeof sessionStore.peekSession === 'function') {
    return sessionStore.peekSession(sessionId);
  }
  if (typeof sessionStore.getSession === 'function') {
    return sessionStore.getSession(sessionId);
  }
  return null;
}

function readSessionRecord(sessionStore, sessionId) {
  if (!sessionStore || !sessionId) return null;
  if (typeof sessionStore.peekSession === 'function') {
    return sessionStore.peekSession(sessionId);
  }
  if (typeof sessionStore.getSession === 'function') {
    return sessionStore.getSession(sessionId);
  }
  return null;
}

function sessionIdentity(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const sessionId = boundedToken(record.id, 128);
  const projectId = boundedToken(record.project_id, 128);
  const incarnation = boundedToken(record.created_at, 128)
    || boundedToken(record.session_incarnation, 128);
  return sessionId && projectId && incarnation
    ? { sessionId, projectId, incarnation }
    : null;
}

function sameSessionIdentity(left, right) {
  return Boolean(left && right
    && left.sessionId === right.sessionId
    && left.projectId === right.projectId
    && left.incarnation === right.incarnation);
}

function sameOptionalSessionIdentity(left, right) {
  return (!left && !right) || sameSessionIdentity(left, right);
}

function projectAuthorityIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const projectId = boundedToken(value.project_id, 128);
  const rootId = value.root_id == null ? null : boundedToken(value.root_id, 256);
  const deviceId = value.device_id == null ? null : boundedToken(value.device_id, 256);
  const inode = value.inode == null ? null : boundedToken(value.inode, 256);
  if (!projectId || (value.root_id != null && !rootId)
    || (value.device_id != null && !deviceId) || (value.inode != null && !inode)
    || !Number.isSafeInteger(value.root_revision) || value.root_revision < 0) return null;
  return {
    project_id: projectId,
    root_id: rootId,
    root_revision: value.root_revision,
    device_id: deviceId,
    inode,
  };
}

function sameProjectAuthority(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function canonicalImageReferences(record) {
  const references = [];
  for (const message of Array.isArray(record?.messages) ? record.messages : []) {
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      if (String(attachment?.kind || '').trim().toLowerCase() === 'image') {
        references.push({
          id: String(attachment.id || '').trim(),
          assetPath: String(attachment.assetPath || '').trim(),
        });
      }
    }
  }
  return references;
}

function normalizedPathKey(value) {
  const normalized = path.resolve(String(value || ''));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

class SessionAttachmentAuthority {
  constructor({ sessionStore, attachmentAssetStore, projectAuthority = null,
    maxReceipts = MAX_DRAFT_IMAGE_RECEIPTS } = {}) {
    if (!sessionStore) throw new TypeError('Session attachment authority requires a session store.');
    if (!attachmentAssetStore
      || typeof attachmentAssetStore.resolveManagedAssetRealPath !== 'function') {
      throw new TypeError('Session attachment authority requires an attachment asset store.');
    }
    if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0) {
      throw new TypeError('Session attachment receipt capacity is invalid.');
    }
    this._sessionStore = sessionStore;
    this._assetStore = attachmentAssetStore;
    this._projectAuthority = projectAuthority;
    this._maxReceipts = maxReceipts;
    this._receipts = new Map();
  }

  captureImportScope(sessionId = '') {
    const id = String(sessionId || '').trim();
    let identity = null;
    if (id) {
      identity = sessionIdentity(readSessionSummary(this._sessionStore, id));
      if (!identity || identity.sessionId !== id) {
        throw new Error(t('main.attachments.importSessionUnavailable', 'Attachment import session is unavailable.'));
      }
    }
    const authority = identity ? this._captureProjectAuthority(id, identity) : null;
    const scope = Object.freeze({});
    importScopes.set(scope, Object.freeze({ authority, identity, owner: this }));
    return scope;
  }

  registerImportedImages(scope, attachments) {
    const captured = importScopes.get(scope);
    if (!captured || captured.owner !== this) {
      throw new Error(t('main.attachments.importScopeInvalid', 'Attachment import scope is invalid.'));
    }
    if (captured.identity) {
      const current = sessionIdentity(
        readSessionSummary(this._sessionStore, captured.identity.sessionId)
      );
      if (!sameSessionIdentity(current, captured.identity)) {
        throw new Error(t('main.attachments.importSessionChanged', 'Attachment import session changed before the import completed.'));
      }
      if (!this._projectAuthorityCurrent(
        captured.identity.sessionId, captured.identity, captured.authority
      )) {
        throw new Error(t('main.attachments.importSessionChanged', 'Attachment import session changed before the import completed.'));
      }
    }
    this._settleReceipts();
    const images = (Array.isArray(attachments) ? attachments : [])
      .filter((entry) => String(entry?.kind || '').trim().toLowerCase() === 'image')
      .map((entry) => this._normalizeImage(entry));
    const incoming = new Map();
    for (const image of images) {
      const existingIncoming = incoming.get(image.id);
      if (existingIncoming && existingIncoming.assetPath !== image.assetPath) {
        throw new Error(t('main.attachments.importImageConflict', 'Attachment import contains a conflicting image identity.'));
      }
      incoming.set(image.id, image);
    }
    let added = 0;
    for (const image of incoming.values()) {
      const existing = this._receipts.get(image.id);
      if (!existing) {
        added += 1;
        continue;
      }
      if (existing.assetPath !== image.assetPath
        || existing.sha256 !== image.sha256
        || !sameOptionalSessionIdentity(existing.identity, captured.identity)) {
        throw new Error(t('main.attachments.importReceiptConflict', 'Attachment import conflicts with an existing receipt.'));
      }
    }
    if (this._receipts.size + added > this._maxReceipts) {
      throw new Error(t('main.attachments.importCapacityFull', 'Attachment import receipt capacity is full.'));
    }
    for (const image of incoming.values()) {
      if (!this._receipts.has(image.id)) {
        this._receipts.set(image.id, {
          id: image.id,
          assetPath: image.assetPath,
          sha256: image.sha256,
          authority: captured.authority,
          identity: captured.identity,
          reservedSessionId: '',
        });
      }
    }
    return images.length;
  }

  authorizeManagedSend(attachments, { requestedSessionId = '', resolvedSessionId = '' } = {}) {
    const requested = String(requestedSessionId || '').trim();
    const resolved = String(resolvedSessionId || '').trim();
    if (!resolved || (requested && requested !== resolved)) {
      throw new Error(t('main.attachments.sessionIdentityInvalid', 'Image attachment session identity is invalid.'));
    }
    const invalidatedReceiptIds = this._settleReceipts();
    const identity = requested
      ? sessionIdentity(readSessionSummary(this._sessionStore, requested))
      : null;
    if (requested && (!identity || identity.sessionId !== requested)) {
      throw new Error(t('main.attachments.sessionUnavailable', 'Image attachment session is unavailable.'));
    }
    if (!requested && readSessionSummary(this._sessionStore, resolved)) {
      throw new Error(t('main.attachments.newSessionIdentityInUse', 'New-session image attachment identity is already in use.'));
    }
    const normalized = (Array.isArray(attachments) ? attachments : [])
      .map((entry) => ({ entry, image: this._normalizeImage(entry) }));
    const toReserve = [];
    const unresolved = [];
    for (const { image } of normalized) {
      const receipt = this._receipts.get(image.id);
      if (!receipt) {
        if (invalidatedReceiptIds.has(image.id)) {
          throw new Error(t('main.attachments.notAuthorizedForSession', 'Image attachment is not authorized for this session.'));
        }
        unresolved.push(image);
        continue;
      }
      if (receipt.assetPath !== image.assetPath || receipt.sha256 !== image.sha256) {
        throw new Error(t('main.attachments.notAuthorizedForSession', 'Image attachment is not authorized for this session.'));
      }
      if (requested) {
        if (!sameSessionIdentity(receipt.identity, identity)
          || !this._projectAuthorityCurrent(requested, identity, receipt.authority)) {
          throw new Error(t('main.attachments.notAuthorizedForSession', 'Image attachment is not authorized for this session.'));
        }
      } else {
        if (receipt.identity || (receipt.reservedSessionId
          && receipt.reservedSessionId !== resolved)) {
          throw new Error(t('main.attachments.notAuthorizedForNewSession', 'Image attachment is not authorized for this new session.'));
        }
        toReserve.push(receipt);
      }
    }
    if (unresolved.length) {
      if (!requested) {
        throw new Error(t('main.attachments.notAuthorizedForNewSession', 'Image attachment is not authorized for this new session.'));
      }
      const sessionRecord = readSessionRecord(this._sessionStore, requested);
      const canonical = new Set(canonicalImageReferences(sessionRecord).map((entry) => (
        `${entry.id}\0${normalizedPathKey(entry.assetPath)}`
      )));
      if (unresolved.some((image) => !canonical.has(
        `${image.id}\0${normalizedPathKey(image.assetPath)}`
      ))) {
        throw new Error(t('main.attachments.notAuthorizedForSession', 'Image attachment is not authorized for this session.'));
      }
    }
    for (const receipt of toReserve) receipt.reservedSessionId = resolved;
    for (const { entry, image } of normalized) entry.assetPath = image.assetPath;
    let active = true;
    const release = () => {
      if (!active) return false;
      active = false;
      for (const receipt of toReserve) {
        if (!receipt.identity && receipt.reservedSessionId === resolved) {
          receipt.reservedSessionId = '';
        }
      }
      return true;
    };
    const finalizeCreatedSession = (createdSession) => {
      if (!active || !toReserve.length) {
        active = false;
        return false;
      }
      const createdIdentity = sessionIdentity(createdSession);
      const currentIdentity = sessionIdentity(readSessionSummary(this._sessionStore, resolved));
      if (!createdIdentity || createdIdentity.sessionId !== resolved
        || !sameSessionIdentity(createdIdentity, currentIdentity)
        || toReserve.some((receipt) => this._receipts.get(receipt.id) !== receipt
          || receipt.identity || receipt.reservedSessionId !== resolved)) {
        release();
        throw new Error(t('main.attachments.newSessionBindingFailed', 'New-session image attachment binding could not be finalized.'));
      }
      // Capture once before mutating any receipt: a failed authority read leaves
      // the complete batch reserved and releasable.
      const createdAuthority = this._captureProjectAuthority(resolved, createdIdentity);
      for (const receipt of toReserve) {
        receipt.identity = createdIdentity;
        receipt.authority = createdAuthority;
        receipt.reservedSessionId = '';
      }
      active = false;
      return true;
    };
    return Object.freeze({
      count: normalized.length,
      finalizeCreatedSession,
      release,
    });
  }

  noteCanonicalAttachmentsPersisted(sessionId) {
    const id = String(sessionId || '').trim();
    const identity = sessionIdentity(readSessionSummary(this._sessionStore, id));
    const record = identity ? readSessionRecord(this._sessionStore, id) : null;
    if (!identity || !record) return 0;
    const canonical = new Set(canonicalImageReferences(record).map((entry) => (
      `${entry.id}\0${normalizedPathKey(entry.assetPath)}`
    )));
    let deletedCount = 0;
    for (const [attachmentId, receipt] of this._receipts) {
      if (sameSessionIdentity(receipt.identity, identity)
        && canonical.has(`${attachmentId}\0${normalizedPathKey(receipt.assetPath)}`)) {
        this._receipts.delete(attachmentId);
        deletedCount += 1;
      }
    }
    return deletedCount;
  }

  revokeAssetPaths(assetPaths) {
    const keys = new Set((Array.isArray(assetPaths) ? assetPaths : [])
      .map(normalizedPathKey));
    let deletedCount = 0;
    for (const [id, receipt] of this._receipts) {
      if (keys.has(normalizedPathKey(receipt.assetPath))) {
        this._receipts.delete(id);
        deletedCount += 1;
      }
    }
    return deletedCount;
  }

  _normalizeImage(entry) {
    const id = boundedToken(entry?.id, MAX_ATTACHMENT_ID_CHARS);
    const suppliedPath = String(entry?.assetPath || '').trim();
    if (!id || !suppliedPath || suppliedPath.length > MAX_ASSET_PATH_CHARS) {
      throw new Error(t('main.attachments.imageIdentityInvalid', 'Image attachment identity is invalid.'));
    }
    const assetPath = this._assetStore.resolveManagedAssetRealPath(suppliedPath, {
      kind: 'image',
    });
    if (!assetPath || assetPath.length > MAX_ASSET_PATH_CHARS) {
      throw new Error(t('main.attachments.managedStoreRequired', 'Image attachments must come from the app-managed local asset store.'));
    }
    return { id, assetPath, sha256: fileSha256(assetPath) };
  }

  _captureProjectAuthority(sessionId, identity) {
    if (!this._projectAuthority) return null;
    let captured;
    try {
      captured = this._projectAuthority.captureSession(sessionId);
    } catch (error) {
      // An unavailable project root must not block explicit image imports for its
      // sessions; every other capture failure is a real authority error.
      if (error?.code === PROJECT_ERROR_CODES.UNAVAILABLE) return null;
      throw error;
    }
    const authority = projectAuthorityIdentity(captured);
    if (!authority || authority.project_id !== identity.projectId) {
      throw new Error(t('main.attachments.sessionUnavailable', 'Image attachment session is unavailable.'));
    }
    return authority;
  }

  _projectAuthorityCurrent(sessionId, identity, expected) {
    if (expected === null) return true;
    if (!this._projectAuthority) return false;
    try {
      return sameProjectAuthority(
        this._captureProjectAuthority(sessionId, identity), expected
      );
    } catch (_error) {
      return false;
    }
  }

  _settleReceipts() {
    const records = new Map();
    const invalidated = new Set();
    const getRecord = (sessionId) => {
      if (!records.has(sessionId)) {
        records.set(sessionId, readSessionSummary(this._sessionStore, sessionId));
      }
      return records.get(sessionId);
    };
    for (const [id, receipt] of this._receipts) {
      if (!receipt.identity) continue;
      const current = sessionIdentity(getRecord(receipt.identity.sessionId));
      if (!sameSessionIdentity(current, receipt.identity)
        || !this._projectAuthorityCurrent(
          receipt.identity.sessionId, receipt.identity, receipt.authority
        )) {
        this._receipts.delete(id);
        invalidated.add(id);
        continue;
      }
    }
    return invalidated;
  }
}

function ensureSessionAttachmentAuthority(service) {
  if (service?.sessionAttachmentAuthority instanceof SessionAttachmentAuthority) {
    return service.sessionAttachmentAuthority;
  }
  if (!service?.sessionStore || !service?.attachmentAssetStore) return null;
  const authority = new SessionAttachmentAuthority({
    sessionStore: service.sessionStore,
    attachmentAssetStore: service.attachmentAssetStore,
    projectAuthority: service.projectAuthority || null,
  });
  service.sessionAttachmentAuthority = authority;
  return authority;
}

module.exports = {
  MAX_DRAFT_IMAGE_RECEIPTS,
  SessionAttachmentAuthority,
  ensureSessionAttachmentAuthority,
};
