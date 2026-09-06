'use strict';

/**
 * Classifies browser URLs before navigation.
 *
 * Decision shape:
 *   {
 *     decision: 'allow' | 'ask' | 'deny',
 *     reason: string,
 *     display_url: string,
 *     host: string,
 *     scheme: string,
 *     allowed_without_approval: boolean,
 *   }
 *
 * Policy defaults:
 * - http://localhost and http://127.0.0.1 (any port): allow.
 * - file:// under the configured allowed roots: allow.
 * - artifact:// pseudo-scheme stays denied until a resolver can map it to a
 *   session-owned artifact file.
 * - http(s) to an external host: ask only when explicitly enabled;
 *   credentialed URLs are denied before any approval or navigation attempt.
 * - data:, javascript:, blob:, view-source:, chrome:, ftp:, file: outside
 *   the allowed roots: deny.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const ALLOWED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_HTTP_SCHEMES = new Set(['http:', 'https:']);
const ALWAYS_UNSAFE_SCHEMES = new Set([
  'data:',
  'javascript:',
  'blob:',
  'view-source:',
  'chrome:',
  'chrome-extension:',
  'ftp:',
  'about:',
]);

function _safeParseUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
}

function _normalizedHost(parsed) {
  if (!parsed) return '';
  return String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function _redactedDisplayUrl(parsed, rawUrl) {
  if (!parsed) return String(rawUrl || '');
  if (!parsed.username && !parsed.password) return parsed.toString();
  const copy = new URL(parsed.toString());
  copy.username = '';
  copy.password = '';
  return copy.toString();
}

function _isLocalHttpUrl(parsed) {
  if (!parsed) return false;
  if (!ALLOWED_HTTP_SCHEMES.has(parsed.protocol)) return false;
  return ALLOWED_LOCAL_HOSTS.has(_normalizedHost(parsed));
}

function _hasExplicitNonDefaultPort(parsed) {
  if (!parsed) return false;
  return String(parsed.port || '').trim() !== '';
}

function _normalizeFileUrlPath(parsed) {
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname || '');
  } catch {
    pathname = parsed.pathname || '';
  }
  // Strip leading `/` on Windows-style `/C:/...` paths.
  if (pathname.length >= 3 && pathname[0] === '/' && /^[A-Za-z]:/.test(pathname.slice(1))) {
    return pathname.slice(1);
  }
  return pathname;
}

function _isWithinAllowedFileRoots(parsed, allowedRoots) {
  if (!parsed || parsed.protocol !== 'file:') return false;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return false;
  const normalized = _normalizeFileUrlPath(parsed);
  const candidateSlashed = normalized.replace(/\\/g, '/').endsWith('/')
    ? normalized.replace(/\\/g, '/')
    : `${normalized.replace(/\\/g, '/')}/`;
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !root) continue;
    const normalizedRoot = root.replace(/\\/g, '/');
    const rootSlashed = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    if (candidateSlashed.startsWith(rootSlashed)) {
      return true;
    }
  }
  return false;
}

function _isPathInside(pathImpl, parentPath, childPath) {
  const relative = pathImpl.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !pathImpl.isAbsolute(relative));
}

/**
 * Classify a URL request from the model.
 *
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {string[]} [options.allowedFileRoots] - workspace roots that file:// URLs may target
 * @param {boolean} [options.allowExternalUrls] - opt-in switch for external HTTP(S) (default false)
 * @returns {{decision: 'allow'|'ask'|'deny', reason: string, display_url: string, host: string, scheme: string, allowed_without_approval: boolean}}
 */
function _decision(parsed, displayUrl, decision, reason) {
  return {
    decision,
    reason,
    display_url: displayUrl,
    host: _normalizedHost(parsed),
    scheme: parsed ? parsed.protocol : '',
    allowed_without_approval: decision === 'allow',
  };
}

function classifyBrowserUrl(rawUrl, options = {}) {
  const parsed = _safeParseUrl(rawUrl);
  if (!parsed) {
    return _decision(null, String(rawUrl || ''), 'deny', 'unparseable_url');
  }

  const scheme = parsed.protocol;
  const displayUrl = _redactedDisplayUrl(parsed, rawUrl);
  const allowedRoots = Array.isArray(options.allowedFileRoots)
    ? options.allowedFileRoots
    : [];
  const allowExternal = options.allowExternalUrls === true;

  if (ALWAYS_UNSAFE_SCHEMES.has(scheme)) {
    return _decision(parsed, displayUrl, 'deny', `unsafe_scheme:${scheme}`);
  }
  if (scheme === 'artifact:') {
    return _decision(parsed, displayUrl, 'deny', 'artifact_url_unresolved');
  }
  if (parsed.username || parsed.password) {
    return _decision(parsed, displayUrl, 'deny', 'credentialed_url');
  }
  if (_isLocalHttpUrl(parsed) && !_hasExplicitNonDefaultPort(parsed)) {
    return _decision(parsed, displayUrl, 'deny', 'localhost_http_missing_port');
  }
  if (_isLocalHttpUrl(parsed)) {
    return _decision(parsed, displayUrl, 'allow', 'localhost_http');
  }
  if (scheme === 'file:') {
    return _isWithinAllowedFileRoots(parsed, allowedRoots)
      ? _decision(parsed, displayUrl, 'allow', 'workspace_file_url')
      : _decision(parsed, displayUrl, 'deny', 'file_url_outside_allowed_roots');
  }
  if (ALLOWED_HTTP_SCHEMES.has(scheme)) {
    return allowExternal
      ? _decision(parsed, displayUrl, 'ask', 'external_url')
      : _decision(parsed, displayUrl, 'deny', 'external_url_disabled');
  }
  return _decision(parsed, displayUrl, 'deny', `unknown_scheme:${scheme}`);
}

async function _realpath(value, fsImpl, pathImpl) {
  const resolved = pathImpl.resolve(String(value || ''));
  return fsImpl.realpath(resolved);
}

async function _isFileUrlWithinAllowedRootsRealpath(parsed, allowedRoots, options = {}) {
  if (!parsed || parsed.protocol !== 'file:') return false;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return false;
  const fsImpl = options.fsImpl || fs;
  const pathImpl = options.pathImpl || path;
  const candidatePath = pathImpl.resolve(_normalizeFileUrlPath(parsed));
  const realCandidate = await fsImpl.realpath(candidatePath).catch(() => '');
  if (!realCandidate) {
    return false;
  }
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const realRoot = await _realpath(root, fsImpl, pathImpl).catch(() => '');
    if (realRoot && _isPathInside(pathImpl, realRoot, realCandidate)) {
      return true;
    }
  }
  return false;
}

function _isFileUrlWithinAllowedRootsRealpathSync(parsed, allowedRoots, options = {}) {
  if (!parsed || parsed.protocol !== 'file:') return false;
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return false;
  const fsImpl = options.fsImpl || fsSync;
  const pathImpl = options.pathImpl || path;
  let realCandidate;
  try {
    const candidatePath = pathImpl.resolve(_normalizeFileUrlPath(parsed));
    realCandidate = fsImpl.realpathSync(candidatePath);
  } catch (_) {
    return false;
  }
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    try {
      const realRoot = fsImpl.realpathSync(pathImpl.resolve(root));
      if (realRoot && _isPathInside(pathImpl, realRoot, realCandidate)) {
        return true;
      }
    } catch (_) {
      // Ignore unavailable roots; the caller fails closed when none match.
    }
  }
  return false;
}

function _shouldRealpathCheckFilePolicy(policy) {
  return policy?.scheme === 'file:'
    && (policy.decision === 'allow' || policy.reason === 'file_url_outside_allowed_roots');
}

async function classifyBrowserUrlForOpen(rawUrl, options = {}) {
  const base = classifyBrowserUrl(rawUrl, options);
  if (!_shouldRealpathCheckFilePolicy(base)) {
    return base;
  }
  const parsed = _safeParseUrl(rawUrl);
  const allowedRoots = Array.isArray(options.allowedFileRoots)
    ? options.allowedFileRoots
    : [];
  const contained = await _isFileUrlWithinAllowedRootsRealpath(parsed, allowedRoots, options);
  return contained
    ? _decision(parsed, base.display_url, 'allow', 'workspace_file_url')
    : _decision(parsed, base.display_url, 'deny', 'file_url_outside_allowed_roots');
}

function classifyBrowserUrlWithRealpathSync(rawUrl, options = {}) {
  const base = classifyBrowserUrl(rawUrl, options);
  if (!_shouldRealpathCheckFilePolicy(base)) {
    return base;
  }
  const parsed = _safeParseUrl(rawUrl);
  const allowedRoots = Array.isArray(options.allowedFileRoots)
    ? options.allowedFileRoots
    : [];
  const contained = _isFileUrlWithinAllowedRootsRealpathSync(parsed, allowedRoots, options);
  return contained
    ? _decision(parsed, base.display_url, 'allow', 'workspace_file_url')
    : _decision(parsed, base.display_url, 'deny', 'file_url_outside_allowed_roots');
}

module.exports = {
  classifyBrowserUrl,
  classifyBrowserUrlForOpen,
  classifyBrowserUrlWithRealpathSync,
  ALLOWED_LOCAL_HOSTS,
};
