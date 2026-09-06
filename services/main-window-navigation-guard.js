'use strict';

/*
 * main-window-navigation-guard.js — pins the main app window to its own document.
 *
 * The chat renderer shows model- and user-authored markdown that routinely
 * contains http(s) links (citations, references, pasted URLs). The main window
 * is loaded via loadFile('index.html'), is frameless, and has no in-app back
 * button, so a plain top-level navigation (clicking `<a href="https://…">`)
 * would replace the entire app UI with the external page and strand the user.
 * window.open / target="_blank" links would likewise spawn uncontrolled child
 * windows.
 *
 * Electron does not block this by default, and the page CSP governs sub-resource
 * loads, not top-level navigation. The browser TOOL guards its own BrowserView
 * (services/backend/browser-session-service.js); this module attaches the
 * canonical "limit navigation + handle window.open" guards
 * (https://www.electronjs.org/docs/latest/tutorial/security) to the MAIN window
 * only:
 *   - same-document navigations (reload, hash routing, query changes) are allowed,
 *   - http(s) targets are opened in the OS default browser,
 *   - everything else is denied.
 *
 * Note: only renderer-initiated navigations fire `will-navigate` /
 * `will-redirect`; programmatic loadFile/reload and in-page hash routing do not,
 * so this guard never interferes with the app's own loading or routing.
 */

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function urlScheme(value) {
  const raw = String(value || '').trim();
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  return match ? match[1].toLowerCase() : '';
}

/* Return the document identity key: protocol + host + pathname, lowercased.
 * Hash and query string are deliberately excluded — they represent same-document
 * routing rather than a navigation to a different resource. */
function documentIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`.toLowerCase();
  } catch (_e) {
    return raw.toLowerCase();
  }
}

/* A navigation that keeps us on our own loaded document. "Same document" means
 * the same protocol + host + pathname — hash routing and query-only changes are
 * allowed; a different local file (e.g. report.html resolved against the app's
 * file:// base) would replace the frameless window and strand the user, so it
 * must be blocked exactly like an external http(s) link. */
function isSameDocumentNavigation(targetUrl, currentUrl) {
  const target = String(targetUrl || '').trim();
  if (!target) return true;
  if (target === String(currentUrl || '').trim()) return true;
  const targetId = documentIdentity(target);
  const currentId = documentIdentity(String(currentUrl || '').trim());
  return targetId !== '' && targetId === currentId;
}

function attachMainWindowNavigationGuards({ windowRef, shell, log = () => {} } = {}) {
  if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) {
    return false;
  }
  const webContents = windowRef.webContents;
  if (!webContents || typeof webContents.on !== 'function') {
    return false;
  }

  function openExternal(url) {
    if (!shell || typeof shell.openExternal !== 'function') {
      return;
    }
    try {
      Promise.resolve(shell.openExternal(url)).catch(() => {});
    } catch (_error) {
      /* opening externally is best-effort; never throw from a guard */
    }
  }

  function getCurrentUrl() {
    try {
      return typeof webContents.getURL === 'function' ? webContents.getURL() : '';
    } catch (_error) {
      return '';
    }
  }

  function handleAttemptedNavigation(event, url) {
    if (isSameDocumentNavigation(url, getCurrentUrl())) {
      return;
    }
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    const external = isHttpUrl(url);
    if (external) {
      openExternal(String(url).trim());
    }
    // Redaction (AGENTS.md §7): log the scheme + whether we handed it off, never
    // the full URL — chat links can carry tokens or PII in the query string.
    log('WARN', 'window.navigation_blocked', {
      external,
      scheme: urlScheme(url),
    });
  }

  webContents.on('will-navigate', handleAttemptedNavigation);
  webContents.on('will-redirect', handleAttemptedNavigation);

  if (typeof webContents.setWindowOpenHandler === 'function') {
    webContents.setWindowOpenHandler((details = {}) => {
      const url = String(details.url || '').trim();
      const external = isHttpUrl(url);
      if (external) {
        openExternal(url);
      }
      log('WARN', 'window.window_open_denied', {
        external,
        scheme: urlScheme(url),
      });
      return { action: 'deny' };
    });
  }

  return true;
}

module.exports = {
  attachMainWindowNavigationGuards,
  isHttpUrl,
  isSameDocumentNavigation,
};
