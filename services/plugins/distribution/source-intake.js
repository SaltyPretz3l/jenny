'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function digest(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }

function normalizeReusableUrl(raw, { allowLoopbackHttp = false } = {}) {
  let url;
  try { url = new URL(raw); } catch (_error) { return { ok: false, reason: 'source_locator_invalid' }; }
  const loopback = ['127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  if (url.username || url.password) return { ok: false, reason: 'source_userinfo_rejected' };
  if (url.hash) return { ok: false, reason: 'source_fragment_rejected' };
  if (url.search) return { ok: false, reason: 'source_query_rejected' };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowLoopbackHttp)) {
    return { ok: false, reason: 'source_https_required' };
  }
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  return { ok: true, locator: url.href, locator_digest: digest(url.href), origin: url.origin };
}

async function normalizeOfflineRoot(raw, { realpath }) {
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || typeof realpath !== 'function') {
    return { ok: false, reason: 'offline_root_invalid' };
  }
  try {
    const root = path.resolve(await realpath(raw));
    return { ok: true, real_root: root, root_digest: digest(root) };
  } catch (_error) { return { ok: false, reason: 'offline_root_unavailable' }; }
}

function publicSourceIdentity(source, extra = {}) {
  if (source.kind === 'local_package') return { kind: source.kind, package_path_digest: source.locator_digest };
  if (source.kind === 'https_url') return { kind: source.kind, url_digest: source.locator_digest };
  if (source.kind === 'git') return { kind: source.kind, repository_url_digest: source.locator_digest, pinned_commit: extra.pinnedCommit };
  if (source.kind === 'signed_catalog') return { kind: source.kind, catalog_id: source.source_id, target_path_digest: extra.targetPathDigest, tuf_root_digest: extra.tufRootDigest };
  return { kind: source.kind, mirror_id: source.source_id, target_path_digest: extra.targetPathDigest, tuf_root_digest: extra.tufRootDigest };
}

function sourceTrustMatches(identity, trustSource) {
  if (!identity || !trustSource || identity.kind !== trustSource.kind) return false;
  if (identity.kind === 'local_package') return identity.package_path_digest === trustSource.package_path_digest;
  if (identity.kind === 'https_url') return identity.url_digest === trustSource.url_digest;
  if (identity.kind === 'git') return identity.repository_url_digest === trustSource.repository_url_digest
    && identity.pinned_commit === trustSource.pinned_commit;
  if (identity.kind === 'signed_catalog') return identity.catalog_id === trustSource.catalog_id
    && identity.tuf_root_digest === trustSource.tuf_root_digest;
  if (identity.kind === 'offline_mirror') return identity.mirror_id === trustSource.mirror_id
    && identity.tuf_root_digest === trustSource.tuf_root_digest;
  return false;
}

module.exports = { digest, normalizeReusableUrl, normalizeOfflineRoot, publicSourceIdentity, sourceTrustMatches };
