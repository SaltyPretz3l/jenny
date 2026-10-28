/* renderer/features/renderer-ide-path-menu.js - IDE explorer path/OS utility
 * context-menu items, extracted from renderer-ide-controller.js to keep that
 * file under the size ceiling. Builds the "Reveal in File Explorer", "Open in
 * Default App", and Copy Path / Relative Path / Name items shared by tree rows
 * (files AND directories) and editor tabs. Pure menu-item factory: all shell
 * I/O (workspace-fs reveal/open, clipboard) and user-facing toasts arrive
 * through deps, so the module has no DOM or global coupling of its own. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePathMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function noop() {}

  /**
   * @param {Object} deps
   * @param {() => (Object|null)} deps.getWorkspaceFsApi - workspace-fs bridge getter
   * @param {Object} deps.windowRef - window/global ref (clipboard lives at jennyShell.clipboard)
   * @param {Function} deps.showShellErrorToast
   * @param {Function} deps.showToastMessage
   * @param {Function} deps.toErrorMessage
   * @param {Function} deps.appendClientLog
   */
  function createIdePathMenu(deps) {
    const settings = deps || {};
    const getWorkspaceFsApi = typeof settings.getWorkspaceFsApi === 'function'
      ? settings.getWorkspaceFsApi
      : () => null;
    const windowRef = settings.windowRef
      || (typeof globalThis !== 'undefined' ? globalThis : {});
    const showShellErrorToast = typeof settings.showShellErrorToast === 'function'
      ? settings.showShellErrorToast
      : noop;
    const showToastMessage = typeof settings.showToastMessage === 'function'
      ? settings.showToastMessage
      : noop;
    const toErrorMessage = typeof settings.toErrorMessage === 'function'
      ? settings.toErrorMessage
      : (error, fallback) => String(error?.message || error || fallback || '');
    const appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog
      : noop;

    // One workspace-fs OS action ({ path } payload): an unavailable bridge or a
    // failure becomes one deduped toast (failures are logged too).
    async function runOsAction(method, path, { unavailable, failed, dedupeKey, logEvent }) {
      const api = getWorkspaceFsApi();
      const toastMeta = { title: jt('ide.explorer.workspace', 'Workspace'), dedupeKey };
      if (typeof api?.[method] !== 'function') {
        showShellErrorToast(unavailable, toastMeta);
        return;
      }
      try {
        await api[method]({ path });
      } catch (error) {
        showShellErrorToast(toErrorMessage(error, failed), toastMeta);
        appendClientLog('WARN', logEvent, { message: String(error?.message || error || '') });
      }
    }

    // OS-level reveal: opens the system file manager with the item selected
    // (distinct from revealInExplorer, which targets Jenny's explorer panel).
    const revealInFileExplorer = (path) => runOsAction('revealInFolder', path, {
      unavailable: jt('ide.pathMenu.revealUnavailable', 'Reveal in File Explorer is unavailable in this shell mode.'),
      failed: jt('ide.pathMenu.revealFailed', 'Could not reveal the item.'),
      dedupeKey: 'ide:path:reveal',
      logEvent: 'ide.reveal_in_folder_failed',
    });

    const openInDefaultApp = (path) => runOsAction('openInDefaultApp', path, {
      unavailable: jt('ide.pathMenu.openDefaultUnavailable', 'Open in Default App is unavailable in this shell mode.'),
      failed: jt('ide.pathMenu.openFailed', 'Could not open the item.'),
      dedupeKey: 'ide:path:open-default',
      logEvent: 'ide.open_default_app_failed',
    });

    async function copyTextToClipboard(text, dedupeKey) {
      const clipboard = windowRef.jennyShell?.clipboard;
      try {
        await clipboard.writeText(text);
        showToastMessage(jt('ide.pathMenu.copiedValue', 'Copied {value}', { value: text }), { dedupeKey });
      } catch (error) {
      showShellErrorToast(toErrorMessage(error, jt('ide.pathMenu.copyFailed', 'Could not copy to the clipboard.')), {
          title: jt('ide.explorer.workspace', 'Workspace'),
          dedupeKey,
        });
      }
    }

    // Absolute path = workspace root + relative path in the root's native
    // separator style (the renderer only ever holds POSIX-relative paths).
    async function copyAbsolutePath(path) {
      const api = getWorkspaceFsApi();
      let root = '';
      try {
        const rootState = await api?.getRootState?.();
        root = String(rootState?.workspaceRoot || '');
      } catch (_error) {
        /* fall through to the no-root toast */
      }
      if (!root) {
        showShellErrorToast(jt('ide.pathMenu.noWorkspaceRoot', 'No workspace root is configured.'), {
          title: jt('ide.explorer.workspace', 'Workspace'),
          dedupeKey: 'ide:path:copy-abs',
        });
        return;
      }
      const usesBackslash = root.includes('\\');
      const joined = root.replace(/[\\/]+$/, '')
        + (usesBackslash ? '\\' : '/')
        + (usesBackslash ? path.replace(/\//g, '\\') : path);
      await copyTextToClipboard(joined, 'ide:path:copy-abs');
    }

    // Path/OS utilities shared by tree rows (files AND directories) and tabs.
    function buildPathUtilityMenuItems(path, kind = 'file') {
      const items = [
        { separator: true },
        { label: jt('ide.pathMenu.revealInFileExplorer', 'Reveal in File Explorer'), action: () => revealInFileExplorer(path) },
      ];
      if (kind !== 'directory') {
        items.push({ label: jt('ide.pathMenu.openInDefaultApp', 'Open in Default App'), action: () => openInDefaultApp(path) });
      }
      items.push(
        { separator: true },
        { label: jt('ide.pathMenu.copyPath', 'Copy Path'), action: () => copyAbsolutePath(path) },
        { label: jt('ide.pathMenu.copyRelativePath', 'Copy Relative Path'), action: () => copyTextToClipboard(path, 'ide:path:copy-rel') },
        { label: jt('ide.pathMenu.copyName', 'Copy Name'), action: () => copyTextToClipboard(path.split('/').pop() || path, 'ide:path:copy-name') }
      );
      return items;
    }

    return { buildPathUtilityMenuItems };
  }

  return { createIdePathMenu };
});
