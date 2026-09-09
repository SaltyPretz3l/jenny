'use strict';

const { downloadDisposition } = require('./download-headers');
const { hostFailure } = require('./api-contract');

const SESSION_ID_PATTERN_BODY = '[A-Za-z0-9_-]{1,128}';
const ARTIFACT_ID_PATTERN_BODY = '[A-Za-z0-9_-]{1,512}';
const MIME_TYPES = new Set([
  'text/plain', 'text/html', 'text/markdown', 'image/svg+xml', 'image/png',
  'image/jpeg', 'image/webp', 'application/json',
]);

function isAuthorized(ctx) {
  return typeof ctx.authorized === 'function' ? ctx.authorized() === true : ctx.authorized === true;
}

function routeMatch(pathname) {
  return new RegExp(`^/api/v1/sessions/(${SESSION_ID_PATTERN_BODY})/artifacts/(${ARTIFACT_ID_PATTERN_BODY})$`, 'u').exec(pathname);
}

function failure(response, result, requestId) {
  const code = String(result?.error?.code || 'CMP-HOST-0005');
  const kind = {
    'CMP-HOST-0001': 'invalid',
    'CMP-HOST-0002': 'unauthorized',
    'CMP-HOST-0003': 'forbidden',
    'CMP-HOST-0004': 'conflict',
    'CMP-HOST-0006': 'persistence',
    'CMP-HOST-0007': 'limit',
  }[code] || 'unavailable';
  const envelope = hostFailure(kind, result?.error?.reason || 'artifact_unavailable', requestId,
    result?.error?.retryable === true);
  const status = { invalid: 400, unauthorized: 401, forbidden: 403, conflict: 409,
    limit: 429, persistence: 503, unavailable: 503 }[kind] || 503;
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(envelope));
}

/** Handle authenticated generated-artifact byte downloads. */
function createArtifactRoutes({ commands } = {}) {
  if (!commands || typeof commands.read !== 'function') {
    throw new TypeError('Artifact routes require the artifact command surface.');
  }
  return async function artifactRoutes(ctx = {}) {
    if (String(ctx.request?.method || '').toUpperCase() !== 'GET') return false;
    const match = routeMatch(String(ctx.pathname || ''));
    if (!match) return false;
    if (!isAuthorized(ctx)) {
      failure(ctx.response, { error: { code: 'CMP-HOST-0003', reason: 'client_required' } }, ctx.requestId);
      return true;
    }
    const result = await commands.read(match[1], match[2]);
    // Reading the file is an awaited authority boundary; do not send even a
    // valid result when the client lost its authenticated lease meanwhile.
    if (!isAuthorized(ctx)) {
      failure(ctx.response, { error: { code: 'CMP-HOST-0003', reason: 'client_required' } }, ctx.requestId);
      return true;
    }
    if (!result.ok) {
      failure(ctx.response, result, ctx.requestId);
      return true;
    }
    const trustedMime = MIME_TYPES.has(String(result.artifact?.mime_type || '').toLowerCase())
      ? String(result.artifact.mime_type).toLowerCase() : 'application/octet-stream';
    const fileName = String(result.artifact?.file_name || 'artifact.bin').slice(0, 512);
    ctx.response.setHeader('Cache-Control', 'no-store');
    ctx.response.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.response.setHeader('Content-Type', 'application/octet-stream');
    ctx.response.setHeader('X-Artifact-Mime-Type', trustedMime);
    ctx.response.setHeader('Content-Length', String(result.bytes.length));
    ctx.response.setHeader('Content-Disposition', downloadDisposition(fileName));
    ctx.response.writeHead(200);
    ctx.response.end(result.bytes);
    return true;
  };
}

module.exports = { createArtifactRoutes };
