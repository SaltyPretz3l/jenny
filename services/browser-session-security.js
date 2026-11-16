'use strict';

/**
 * What one hidden browser session may load: permission and window-open denial,
 * the request filter, the navigation guards, and the URL policy they share.
 * BrowserSessionService owns the sessions; this module owns their limits.
 *
 * `deps` is `{ fsImpl, pathImpl, logger }` from the owning service.
 */

const { classifyBrowserUrlWithRealpathSync } = require('./browser-url-policy');

// Allowed roots are realpath-resolved once per session; every request
// still resolves its own candidate path.
function resolvedFileRoots(session, { fsImpl, pathImpl }) {
  if (Array.isArray(session.resolvedFileRoots)) return session.resolvedFileRoots;
  const resolved = [];
  for (const root of session.allowedFileRoots || []) {
    try {
      resolved.push(fsImpl.realpathSync(pathImpl.resolve(root)));
    } catch (_) {
      // An unavailable root never matches; the classifier fails closed.
    }
  }
  session.resolvedFileRoots = resolved;
  return resolved;
}

function classifyAllowedUrl(rawUrl, session, deps) {
  const policy = classifyBrowserUrlWithRealpathSync(rawUrl, {
    allowedFileRoots: resolvedFileRoots(session, deps),
    allowedFileRootsResolved: true,
    fsImpl: deps.fsImpl,
    pathImpl: deps.pathImpl,
  });
  let allowed = policy.decision === 'allow'
    && (!session.strictWorkspaceOnly || policy.reason === 'workspace_file_url');
  // A render of an earlier state may ask for a file that is no longer on disk.
  // The realpath check above cannot pass for it; the override table ran its own
  // containment check when the session opened and serves it from memory.
  if (!allowed
    && policy.reason === 'file_url_outside_allowed_roots'
    && session.fileOverrides?.servesMissingFile(rawUrl) === true) {
    allowed = true;
  }
  return { allowed, policy };
}

const MAX_BLOCKED_HOSTS = 4;

// Which external hosts the request filter turned away, so a render can say why
// a page came out bare. Bounded; the host is lower-cased and never empty.
function noteBlockedExternalHost(session, policy) {
  if (policy?.reason !== 'external_url_disabled') return;
  const host = typeof policy.host === 'string' ? policy.host.trim().toLowerCase() : '';
  if (!host) return;
  if (!Array.isArray(session.blockedExternalHosts)) session.blockedExternalHosts = [];
  if (session.blockedExternalHosts.length < MAX_BLOCKED_HOSTS && !session.blockedExternalHosts.includes(host)) {
    session.blockedExternalHosts.push(host);
  }
}

const MAX_BLOCKED_PAGE_ASSETS = 16;
const MAX_ASSET_URL_LENGTH = 2000;

// The external scripts the request filter turned away, so a caller that takes
// pictures can ask whether the page waits on one. Bounded. A refused
// stylesheet is not recorded: a page still draws without its web fonts.
function noteBlockedPageAsset(session, policy, details) {
  if (policy?.reason !== 'external_url_disabled') return;
  const type = details?.resourceType;
  const url = typeof details?.url === 'string' ? details.url : '';
  if (type !== 'script' || !url || url.length > MAX_ASSET_URL_LENGTH) return;
  if (!Array.isArray(session.blockedPageAssets)) session.blockedPageAssets = [];
  const assets = session.blockedPageAssets;
  if (assets.length < MAX_BLOCKED_PAGE_ASSETS && !assets.some((asset) => asset.url === url)) assets.push({ type, url });
}

// Read in the page: every script tag with its address and whether it is async.
const PAGE_SCRIPT_TAGS_SCRIPT = '(() => Array.from(document.scripts).filter((tag) => tag.src).slice(0, 400)'
  + '.map((tag) => ({ url: String(tag.src), async: tag.async === true })))()';

// True when the page waits on one of the blocked scripts: every one counts
// unless each tag that asked for it is async (an analytics tag, a script the
// page adds from code); a script with no tag is a module the page imports. `scriptTags` not being a list means the page could
// not be asked, and in doubt the answer is yes.
function waitsOnBlockedAsset(blockedAssets, scriptTags) {
  const blocked = Array.isArray(blockedAssets) ? blockedAssets : [];
  if (blocked.length === 0) return false;
  if (!Array.isArray(scriptTags)) return true;
  return blocked.some((asset) => {
    const tags = scriptTags.filter((tag) => tag?.url === asset.url);
    return tags.length === 0 || tags.some((tag) => tag.async !== true);
  });
}

function preventDisallowedNavigation(event, nextUrl, session, source, deps) {
  const policyResult = classifyAllowedUrl(nextUrl, session, deps);
  if (policyResult.allowed) {
    return;
  }
  event?.preventDefault?.();
  deps.logger('WARN', 'browser.navigation_blocked', {
    sessionId: session.sessionId,
    source,
    reason: policyResult.policy.reason,
    host: policyResult.policy.host,
    scheme: policyResult.policy.scheme,
  });
}

function configureWebContentsSecurity(session, deps) {
  const webContents = session.webContents;
  if (!webContents) {
    return;
  }
  if (typeof webContents.setWebRTCIPHandlingPolicy === 'function') {
    try {
      webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    } catch (_) {
      // Older Electron: the hidden window still has no media permissions.
    }
  }
  if (typeof webContents.setWindowOpenHandler === 'function') {
    webContents.setWindowOpenHandler((details = {}) => {
      const policyResult = classifyAllowedUrl(details.url, session, deps);
      deps.logger('WARN', 'browser.window_open_denied', {
        sessionId: session.sessionId,
        reason: 'window_open_disabled',
        host: policyResult.policy.host,
        scheme: policyResult.policy.scheme,
      });
      return { action: 'deny' };
    });
  }
  const browserSession = webContents.session;
  if (browserSession && typeof browserSession.setPermissionRequestHandler === 'function') {
    browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      deps.logger('WARN', 'browser.permission_denied', {
        sessionId: session.sessionId,
        permission: String(permission || '').slice(0, 80),
      });
      callback(false);
    });
  }
  if (browserSession && typeof browserSession.setPermissionCheckHandler === 'function') {
    browserSession.setPermissionCheckHandler(() => false);
  }
  if (browserSession && typeof browserSession.setDevicePermissionHandler === 'function') {
    browserSession.setDevicePermissionHandler(() => false);
  }
  // Recorded so a strict session can refuse to open without the filter
  // instead of silently loading unfiltered.
  session.requestFilterInstalled = Boolean(
    browserSession?.webRequest && typeof browserSession.webRequest.onBeforeRequest === 'function'
  );
  if (session.requestFilterInstalled) {
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const policyResult = classifyAllowedUrl(details?.url, session, deps);
      if (!policyResult.allowed) {
        noteBlockedExternalHost(session, policyResult.policy);
        noteBlockedPageAsset(session, policyResult.policy, details);
        deps.logger('WARN', 'browser.request_blocked', {
          sessionId: session.sessionId,
          reason: policyResult.policy.reason,
          host: policyResult.policy.host,
          scheme: policyResult.policy.scheme,
          resourceType: String(details?.resourceType || '').slice(0, 80),
        });
        callback({ cancel: true });
        return;
      }
      callback({});
    });
  }
  webContents.on?.('will-navigate', (event, nextUrl) => {
    preventDisallowedNavigation(event, nextUrl, session, 'will_navigate', deps);
  });
  webContents.on?.('will-redirect', (event, nextUrl) => {
    preventDisallowedNavigation(event, nextUrl, session, 'will_redirect', deps);
  });
}

function clearWebContentsSecurity(session) {
  const browserSession = session.webContents?.session;
  try {
    session.fileOverrides?.dispose();
  } catch (_) {
    // Best-effort cleanup; the handler lives on a partition nothing reuses.
  }
  try {
    browserSession?.webRequest?.onBeforeRequest?.(null);
  } catch (_) {
    // Best-effort cleanup; the owning in-memory partition is session-scoped.
  }
  try {
    browserSession?.setPermissionRequestHandler?.(null);
    browserSession?.setPermissionCheckHandler?.(null);
    browserSession?.setDevicePermissionHandler?.(null);
  } catch (_) {
    // Best-effort cleanup.
  }
}

module.exports = {
  classifyAllowedUrl,
  clearWebContentsSecurity,
  configureWebContentsSecurity,
  PAGE_SCRIPT_TAGS_SCRIPT,
  waitsOnBlockedAsset,
  resolvedFileRoots,
};
