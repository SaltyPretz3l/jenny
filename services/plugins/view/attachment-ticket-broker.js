'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PLUGIN_SESSION_LIMITS } = require('../../plugin-session-budgets');
const { readBoundedRegularFile } = require('../artifacts/bounded-file-reader');

const TICKET_TTL_MS = PLUGIN_SESSION_LIMITS.attachment_ticket_ttl_ms;
const MAX_TICKET_ASSET_BYTES = PLUGIN_SESSION_LIMITS.artifact_bytes;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_EXTENSION_TO_MEDIA_TYPE = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
]);
const IMAGE_MEDIA_TYPES = new Set(IMAGE_EXTENSION_TO_MEDIA_TYPE.values());

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function boundedId(value, max = 160) {
  return String(value || '').trim().slice(0, max);
}

function attachmentFromSession(session, attachmentId) {
  const wanted = boundedId(attachmentId);
  if (!wanted) return null;
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    const attachment = (Array.isArray(message?.attachments) ? message.attachments : [])
      .find((item) => boundedId(item?.id) === wanted);
    if (attachment) return { message, attachment };
  }
  return null;
}

function imageMediaType(attachment) {
  const metadataType = String(attachment?.mimeType || '').trim().toLowerCase();
  if (IMAGE_MEDIA_TYPES.has(metadataType)) return metadataType;
  return IMAGE_EXTENSION_TO_MEDIA_TYPE.get(path.extname(String(attachment?.assetPath || '')).toLowerCase())
    || 'image/png';
}

class AttachmentTicketBroker {
  constructor({ sessionStore, attachmentAssetStore, now = () => Date.now(),
    randomBytes = crypto.randomBytes, fsImpl = fs, log = () => {},
    revealPath = async () => false, ttlMs = TICKET_TTL_MS } = {}) {
    if (!sessionStore || !attachmentAssetStore) {
      throw new TypeError('attachment ticket broker requires session and attachment stores');
    }
    this.sessionStore = sessionStore;
    this.attachmentAssetStore = attachmentAssetStore;
    this.now = now;
    this.randomBytes = randomBytes;
    this.fs = fsImpl;
    this.log = log;
    this.revealPath = revealPath;
    this.ttlMs = Math.max(1, Number(ttlMs) || TICKET_TTL_MS);
    this.tickets = new Map();
  }

  _issue({ viewInstanceId, generationId, sessionId, sessionIncarnation, operationId,
    attachmentId, attachmentDigest, webContentsId, artifactDigest } = {}) {
    this.sweep();
    const fields = {
      viewInstanceId: boundedId(viewInstanceId),
      generationId: boundedId(generationId),
      sessionId: boundedId(sessionId),
      sessionIncarnation: boundedId(sessionIncarnation),
      operationId: boundedId(operationId),
      attachmentId: boundedId(attachmentId),
      attachmentDigest: boundedId(attachmentDigest, 64).toLowerCase(),
      webContentsId: Number(webContentsId),
      artifactDigest: boundedId(artifactDigest, 64).toLowerCase(),
    };
    if (Object.values(fields).some((value) => value === '')
      || !Number.isSafeInteger(fields.webContentsId)
      || !/^[0-9a-f]{64}$/.test(fields.attachmentDigest)
      || !/^[0-9a-f]{64}$/.test(fields.artifactDigest)) {
      return { ok: false, reason: 'attachment_ticket_binding_invalid' };
    }
    const session = this.sessionStore.getSession(fields.sessionId);
    const found = attachmentFromSession(session, fields.attachmentId);
    if (!found || String(session?.session_incarnation || '') !== fields.sessionIncarnation) {
      return { ok: false, reason: 'attachment_ticket_session_stale' };
    }
    const token = this.randomBytes(32).toString('hex');
    if (!TOKEN_PATTERN.test(token) || this.tickets.has(token)) {
      return { ok: false, reason: 'attachment_ticket_entropy_failed' };
    }
    this.tickets.set(token, Object.freeze({ ...fields, expiresAt: this.now() + this.ttlMs }));
    return {
      ok: true,
      token,
      expires_at: new Date(this.now() + this.ttlMs).toISOString(),
      url: `jenny-plugin-view://${fields.artifactDigest}/__attachment/${token}`,
    };
  }

  issueForAttachment(binding = {}) {
    const session = this.sessionStore.getSession(boundedId(binding.sessionId));
    const found = attachmentFromSession(session, binding.attachmentId);
    if (!found || String(session?.session_incarnation || '') !== boundedId(binding.sessionIncarnation)) {
      return { ok: false, reason: 'attachment_ticket_session_stale' };
    }
    const read = this._readBoundedAttachment(found);
    if (!read.ok) return read;
    return this._issue({ ...binding, attachmentDigest: digest(read.bytes) });
  }

  resolve({ token, viewInstanceId, generationId, webContentsId, artifactDigest } = {}) {
    this.sweep();
    const normalizedToken = boundedId(token, 64).toLowerCase();
    const ticket = TOKEN_PATTERN.test(normalizedToken) ? this.tickets.get(normalizedToken) : null;
    if (!ticket) return { ok: false, reason: 'attachment_ticket_invalid' };
    if (ticket.viewInstanceId !== boundedId(viewInstanceId)
      || ticket.generationId !== boundedId(generationId)
      || ticket.webContentsId !== Number(webContentsId)
      || ticket.artifactDigest !== boundedId(artifactDigest, 64).toLowerCase()) {
      return { ok: false, reason: 'attachment_ticket_binding_mismatch' };
    }
    const session = this.sessionStore.getSession(ticket.sessionId);
    const found = attachmentFromSession(session, ticket.attachmentId);
    if (!found || String(session?.session_incarnation || '') !== ticket.sessionIncarnation) {
      this.tickets.delete(normalizedToken);
      return { ok: false, reason: 'attachment_ticket_session_stale' };
    }
    const read = this._readBoundedAttachment(found);
    if (!read.ok) return read;
    const { bytes } = read;
    const actualDigest = digest(bytes);
    if (actualDigest !== ticket.attachmentDigest) {
      this.tickets.delete(normalizedToken);
      this.log('plugin.view.attachment_ticket_rejected', {
        reason_code: 'attachment_digest_mismatch',
      });
      return { ok: false, reason: 'attachment_ticket_digest_mismatch' };
    }
    return { ok: true, bytes, sha256: actualDigest, mediaType: imageMediaType(found.attachment) };
  }

  async reveal({ sessionId, sessionIncarnation, attachmentId } = {}) {
    const session = this.sessionStore.getSession(boundedId(sessionId));
    const found = attachmentFromSession(session, attachmentId);
    if (!found || String(session?.session_incarnation || '') !== boundedId(sessionIncarnation)) {
      return { ok: false, reason: 'attachment_reveal_binding_mismatch' };
    }
    const realPath = this.attachmentAssetStore.resolveManagedAssetRealPath(
      found.attachment.assetPath, { kind: 'image' }
    );
    if (!realPath) return { ok: false, reason: 'attachment_reveal_unavailable' };
    try {
      await this.revealPath(realPath);
      return { ok: true, revealed: true };
    } catch (_error) {
      return { ok: false, reason: 'attachment_reveal_failed' };
    }
  }

  _readBoundedAttachment(found) {
    const realPath = this.attachmentAssetStore.resolveManagedAssetRealPath(
      found.attachment.assetPath, { kind: 'image' }
    );
    if (!realPath) return { ok: false, reason: 'attachment_ticket_asset_unavailable' };
    const read = readBoundedRegularFile({
      fsImpl: this.fs, filePath: realPath, maxBytes: MAX_TICKET_ASSET_BYTES,
    });
    if (read.ok) return { ok: true, bytes: read.buffer };
    return read.reason === 'unavailable'
      ? { ok: false, reason: 'attachment_ticket_asset_unavailable' }
      : { ok: false, reason: 'attachment_ticket_asset_rejected' };
  }

  revokeView(viewInstanceId) {
    return this._revoke((ticket) => ticket.viewInstanceId === boundedId(viewInstanceId));
  }

  sweep() {
    const now = this.now();
    return this._revoke((ticket) => ticket.expiresAt <= now);
  }

  dispose() {
    const count = this.tickets.size;
    this.tickets.clear();
    return count;
  }

  _revoke(predicate) {
    let revoked = 0;
    for (const [token, ticket] of this.tickets) {
      if (!predicate(ticket)) continue;
      this.tickets.delete(token);
      revoked += 1;
    }
    return revoked;
  }
}

module.exports = {
  AttachmentTicketBroker,
  MAX_TICKET_ASSET_BYTES,
  TICKET_TTL_MS,
  attachmentFromSession,
  digest,
};
