'use strict';

const { hostFailure } = require('./api-contract');
const { downloadDisposition } = require('./download-headers');
const { projectMessage } = require('./session-snapshots');

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_UPLOAD_BYTES = 1_000_000;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'text/plain']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const ID_PATTERN_BODY = '[A-Za-z0-9_-]{1,128}';

function authorized(ctx) {
  return typeof ctx.authorized === 'function' ? ctx.authorized() === true : ctx.authorized === true;
}

function contentType(request) {
  return String(request?.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

function json(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function failure(response, result, requestId) {
  const kind = result?.error?.kind || 'unavailable';
  const reason = result?.error?.reason || 'asset_unavailable';
  const status = { invalid: 400, unauthorized: 401, forbidden: 403, conflict: 409,
    limit: 429, persistence: 503, unavailable: 503 }[kind] || 503;
  const envelope = hostFailure(kind, reason, requestId, result?.error?.retryable === true);
  if (result?.error?.limit_bytes) {
    envelope.error.limit_bytes = result.error.limit_bytes;
    envelope.error.actual_bytes = result.error.actual_bytes;
  }
  json(response, status, envelope);
}

async function readBody(request, maximum) {
  const declared = request?.headers?.['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > maximum)) return null;
  if (Buffer.isBuffer(request?.body)) return request.body.length <= maximum ? request.body : null;
  const chunks = [];
  let length = 0;
  for await (const chunk of request || []) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > maximum) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeDisplayName(value) {
  if (value === undefined) return '';
  try { return decodeURIComponent(String(value)); } catch (_error) { return null; }
}

function routeIds(pathname, suffix) {
  const pattern = new RegExp(`^/api/v1/sessions/(${ID_PATTERN_BODY})/${suffix}/(${ID_PATTERN_BODY})$`, 'u');
  return pattern.exec(pathname);
}

/**
 * Handle the bounded attachment and canonical message routes.
 * Returns false when `pathname` is outside this route family.
 */
function createAssetRoutes({ commands } = {}) {
  if (!commands || typeof commands.upload !== 'function'
    || typeof commands.readAttachment !== 'function' || typeof commands.readMessage !== 'function') {
    throw new TypeError('Asset routes require the asset command surface.');
  }

  return async function assetRoutes(ctx = {}) {
    const method = String(ctx.request?.method || '').toUpperCase();
    const pathname = String(ctx.pathname || '');
    const isUpload = pathname === '/api/v1/attachments' && method === 'POST';
    const attachmentMatch = method === 'GET' ? routeIds(pathname, 'attachments') : null;
    const messageMatch = method === 'GET' ? routeIds(pathname, 'messages') : null;
    if (!isUpload && !attachmentMatch && !messageMatch) return false;
    if (!authorized(ctx)) {
      failure(ctx.response, { error: { kind: 'forbidden', reason: 'client_required' } }, ctx.requestId);
      return true;
    }
    if (isUpload) {
      const type = contentType(ctx.request);
      if (!UPLOAD_TYPES.has(type)) {
        failure(ctx.response, { error: { kind: 'invalid', reason: 'mime_type_unsupported' } }, ctx.requestId);
        return true;
      }
      const bytes = await readBody(ctx.request, type === 'text/plain' ? MAX_TEXT_UPLOAD_BYTES : MAX_UPLOAD_BYTES);
      if (!bytes) {
        failure(ctx.response, { error: { kind: 'limit', reason: 'attachment_size_limit' } }, ctx.requestId);
        return true;
      }
      // Authorization is intentionally checked again after consuming the body.
      if (!authorized(ctx)) {
        failure(ctx.response, { error: { kind: 'forbidden', reason: 'client_required' } }, ctx.requestId);
        return true;
      }
      const displayName = decodeDisplayName(ctx.request?.headers?.['x-file-name']);
      if (displayName === null) {
        failure(ctx.response, { error: { kind: 'invalid', reason: 'display_name_invalid' } }, ctx.requestId);
        return true;
      }
      const result = await commands.upload({ deviceId: ctx.deviceId, bytes, displayName, mimeType: type });
      if (!authorized(ctx)) { failure(ctx.response, { error: { kind: 'forbidden', reason: 'client_required' } }, ctx.requestId); return true; }
      if (!result.ok) failure(ctx.response, result, ctx.requestId);
      else json(ctx.response, 201, result);
      return true;
    }
    const sessionId = attachmentMatch?.[1] || messageMatch?.[1];
    const valueId = attachmentMatch?.[2] || messageMatch?.[2];
    if (!ID_PATTERN.test(sessionId) || !ID_PATTERN.test(valueId)) {
      failure(ctx.response, { error: { kind: 'invalid', reason: 'reference_invalid' } }, ctx.requestId);
      return true;
    }
    if (attachmentMatch) {
      const result = await commands.readAttachment(sessionId, valueId);
      if (!authorized(ctx)) { failure(ctx.response, { error: { kind: 'forbidden', reason: 'client_required' } }, ctx.requestId); return true; }
      if (!result.ok) { failure(ctx.response, result, ctx.requestId); return true; }
      const type = String(result.attachment?.mime_type || '').toLowerCase();
      if (!UPLOAD_TYPES.has(type)) {
        failure(ctx.response, { error: { kind: 'forbidden', reason: 'attachment_type_forbidden' } }, ctx.requestId);
        return true;
      }
      const name = String(result.attachment?.display_name || 'attachment').replace(/[\r\n"]/gu, '_').slice(0, 240);
      ctx.response.setHeader('Cache-Control', 'no-store');
      ctx.response.setHeader('X-Content-Type-Options', 'nosniff');
      ctx.response.setHeader('Content-Type', type);
      ctx.response.setHeader('Content-Length', String(result.bytes.length));
      ctx.response.setHeader('Content-Disposition', downloadDisposition(name));
      ctx.response.end(result.bytes);
      return true;
    }
    const result = await commands.readMessage(sessionId, valueId);
      if (!authorized(ctx)) { failure(ctx.response, { error: { kind: 'forbidden', reason: 'client_required' } }, ctx.requestId); return true; }
    if (!result.ok) { failure(ctx.response, result, ctx.requestId); return true; }
    const message = projectMessage(result.message);
    if (!message) {
      failure(ctx.response, { error: { kind: 'unavailable', reason: 'message_projection_failed' } }, ctx.requestId);
      return true;
    }
    json(ctx.response, 200, { ok: true, message });
    return true;
  };
}

module.exports = { createAssetRoutes };
