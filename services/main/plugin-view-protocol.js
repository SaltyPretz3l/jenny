'use strict';

const crypto = require('node:crypto');

const PLUGIN_VIEW_SCHEME = 'jenny-plugin-view';
const PLUGIN_VIEW_PRIVILEGED_SCHEME = Object.freeze({
  scheme: PLUGIN_VIEW_SCHEME,
  privileges: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: false,
    corsEnabled: false,
  }),
});
const DIGEST_RE = /^[0-9a-f]{64}$/;
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'",
  "img-src 'self'", "font-src 'self'", "connect-src 'none'",
  "worker-src 'none'", "frame-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join('; ');

function safePathname(url) {
  if (url.search || url.hash) return null;
  let value;
  try { value = decodeURIComponent(url.pathname.slice(1)); } catch (_error) { return null; }
  if (!value || value.includes('\\') || value.includes('\0') || value.split('/').includes('..')) return null;
  return value;
}

function rawPathHasTraversal(rawUrl) {
  const authorityEnd = rawUrl.indexOf('/', rawUrl.indexOf('://') + 3);
  if (authorityEnd < 0) return false;
  const rawPath = rawUrl.slice(authorityEnd).split(/[?#]/, 1)[0];
  try {
    return rawPath.split('/').some((segment) => {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..' || decoded.includes('\\') || decoded.includes('\0');
    });
  } catch (_error) { return true; }
}

function response(body, status, mediaType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': mediaType,
      'Content-Security-Policy': CSP,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

function createPluginViewProtocolHandler({ resolveAsset, resolveAttachment = null,
  log = () => {} } = {}) {
  if (typeof resolveAsset !== 'function') throw new TypeError('plugin view protocol requires resolveAsset');
  return async function handle(request) {
    let url;
    try { url = new URL(request.url); } catch (_error) { return response('Not found', 404); }
    const artifactDigest = url.hostname.toLowerCase();
    const assetPath = safePathname(url);
    if (url.protocol !== `${PLUGIN_VIEW_SCHEME}:` || !DIGEST_RE.test(artifactDigest) || !assetPath
      || rawPathHasTraversal(String(request.url || ''))) {
      return response('Not found', 404);
    }
    let asset;
    try {
      const ticketMatch = /^__attachment\/([0-9a-f]{64})$/.exec(assetPath);
      asset = ticketMatch && typeof resolveAttachment === 'function'
        ? await resolveAttachment({ artifactDigest, token: ticketMatch[1] })
        : await resolveAsset({ artifactDigest, path: assetPath });
    } catch (_error) {
      log('plugin.view.asset_failed', { reason_code: 'asset_resolution_failed' });
      return response('Unavailable', 503);
    }
    const mediaType = asset?.mediaType || asset?.media_type;
    if (!asset?.bytes || typeof mediaType !== 'string' || !DIGEST_RE.test(asset.sha256 || '')) {
      return response('Not found', 404);
    }
    const bytes = Buffer.from(asset.bytes);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== asset.sha256) {
      log('plugin.view.asset_failed', { reason_code: 'asset_digest_mismatch' });
      return response('Integrity failure', 409);
    }
    return response(bytes, 200, mediaType);
  };
}

async function installPluginViewProtocol(session, options) {
  if (!session?.protocol?.handle) throw new TypeError('plugin view session protocol unavailable');
  if (typeof session.protocol.isProtocolHandled === 'function'
    && await session.protocol.isProtocolHandled(PLUGIN_VIEW_SCHEME)) return;
  await session.protocol.handle(PLUGIN_VIEW_SCHEME, createPluginViewProtocolHandler(options));
}

module.exports = {
  PLUGIN_VIEW_SCHEME,
  PLUGIN_VIEW_PRIVILEGED_SCHEME,
  PLUGIN_VIEW_CSP: CSP,
  createPluginViewProtocolHandler,
  installPluginViewProtocol,
};
