/* renderer/chat/renderer-chat-path-open.js
 * Preventing the cancelable `ide:open-file-at-line` event claims navigation.
 * Claimed opens try the preview panel, then the IDE, then the OS default app;
 * `preferIde` skips the panel. Path chips suppress propagation so opening a
 * path does not toggle its row. Context menus exclude editable fields, text
 * selections, and non-path targets. Main-process workspace containment stays
 * authoritative.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatPathOpen = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var OPEN_FILE_EVENT = 'ide:open-file-at-line';
  var MAX_PATH_LENGTH = 512;
  // Workspace-relative path shape for inline code spans: word-ish segments,
  // at least one separator, optional trailing :line[:column]. Backslashes are
  // normalized to slashes before matching; absolute/drive paths fail the
  // segment alphabet (':') and isOpenableRelPath, staying inert.
  var INLINE_CODE_PATH_RE = /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+(?::(\d+)(?::(\d+))?)?$/;

  function noop() {}

  function normalizeRelPath(value) {
    return String(value || '').trim().replace(/\\/g, '/');
  }

  // Parity clone of renderer-chat-codebase-cite-utils.js::isSafeRelPath (that
  // module keeps it private). Keep the two in lockstep: same alphabet, same
  // absolute/drive/parent-escape rejections.
  function isOpenableRelPath(value) {
    var p = String(value || '');
    if (!p || p.length > MAX_PATH_LENGTH) {
      return false;
    }
    for (var i = 0; i < p.length; i += 1) {
      var code = p.charCodeAt(i);
      if (code <= 0x20 || code === 0x7f) {
        return false;
      }
    }
    if (p.charAt(0) === '/' || /^[a-zA-Z]:/.test(p)) {
      return false;
    }
    var segments = p.split('/');
    for (var s = 0; s < segments.length; s += 1) {
      if (segments[s] === '..') {
        return false;
      }
    }
    return true;
  }

  function clampLine(value) {
    var n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }

  function createChatPathOpenController(deps) {
    var settings = deps || {};
    var windowRef = settings.windowRef
      || (typeof globalThis !== 'undefined' ? globalThis : {});
    var chatTimeline = settings.chatTimeline || null;
    var pathRoots = [chatTimeline].concat(Array.isArray(settings.pathRoots) ? settings.pathRoots : [])
      .filter(function uniqueRoot(rootEl, index, roots) {
        return rootEl && roots.indexOf(rootEl) === index;
      });
    var doc = (chatTimeline && chatTimeline.ownerDocument)
      || windowRef.document
      || null;
    var state = settings.state || {};
    var setActiveView = typeof settings.setActiveView === 'function'
      ? settings.setActiveView
      : noop;
    var openIdeFileAtLine = typeof settings.openIdeFileAtLine === 'function'
      ? settings.openIdeFileAtLine
      : null;
    // Optional: the chat page's read-only file preview rail. Production
    // wiring always supplies a function (the bridge wrapper), so the real
    // fallback gate is the OWNERSHIP RESULT: anything but a strict `true`
    // resolution (bridge without a controller returns false; legacy noop
    // wiring resolves undefined) falls through to the IDE path this module
    // shipped with. The typeof gate below only covers old test harnesses.
    var openFilePreviewTarget = typeof settings.openFilePreviewTarget === 'function'
      ? settings.openFilePreviewTarget
      : null;
    var showToastMessage = typeof settings.showToastMessage === 'function'
      ? settings.showToastMessage
      : noop;
    var appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog
      : noop;
    var contextMenu = settings.contextMenu
      || windowRef.inventoryContextMenu
      || null;
    var pathMenuFactory = settings.pathMenuFactory
      || windowRef.rendererIdePathMenu
      || null;
    var citeUtils = settings.citeUtils
      || windowRef.rendererChatCodebaseCiteUtils
      || null;
    var getWorkspaceFs = typeof settings.getWorkspaceFs === 'function'
      ? settings.getWorkspaceFs
      : function defaultGetWorkspaceFs() {
        return (windowRef.jennyShell && windowRef.jennyShell.workspaceFs) || null;
      };

    var disposed = false;

    // Sync eligibility for the IDE half: root state is hydrated at boot
    // (renderer-shell-state-runtime-utils applyWorkspaceRootStatePayload).
    // While it has not landed yet we stay optimistic — the main process is
    // the authority and the failure path falls back + toasts.
    function hasWorkspaceRoot() {
      var rootState = state && state.workspaceRoot;
      if (!rootState || typeof rootState !== 'object') {
        return true;
      }
      return Boolean(String(rootState.path || '').trim());
    }

    function toastOpenFailure(relPath, error) {
      var message = 'Couldn’t open ' + relPath + '.';
      var code = String((error && (error.error_code || error.code)) || '');
      if (code === 'CMP-WORKSPACEFS-0004') {
        message = 'Couldn’t open ' + relPath + ' — file not found.';
      } else if (code === 'CMP-WORKSPACEFS-0003') {
        message = 'Couldn’t open ' + relPath + ' — outside the workspace.';
      }
      showToastMessage(message, {
        title: 'Open File',
        tone: 'danger',
        dedupeKey: 'chat:path-open:' + relPath,
      });
    }

    function openInDefaultAppFallback(relPath) {
      var fsApi = getWorkspaceFs();
      if (!fsApi || typeof fsApi.openInDefaultApp !== 'function') {
        toastOpenFailure(relPath, null);
        return Promise.resolve(false);
      }
      return Promise.resolve(fsApi.openInDefaultApp({ path: relPath }))
        .then(function handled() { return true; })
        .catch(function reportFallbackFailure(error) {
          appendClientLog('WARN', 'chat.path_open_fallback_failed', {
            path: relPath,
            message: String((error && error.message) || error || ''),
          });
          toastOpenFailure(relPath, error);
          return false;
        });
    }

    // The DIRECT IDE route: Workspace view first (the surface rule
    // handleOpenChangeDiff pins), then the IDE's open-then-revealPosition
    // seam. Failure degrades to the OS default app, then a toast. This is
    // exactly the pre-panel openClaimedPath body — the context menu's
    // "Open in IDE" item and the panel's own escape hatch both target it, so
    // its behavior must stay byte-identical.
    function openInIdePath(relPath, line, column) {
      setActiveView('ide');
      return Promise.resolve(openIdeFileAtLine(relPath, line, column))
        .then(function settleIdeOpen(opened) {
          if (opened === true) {
            return true;
          }
          appendClientLog('WARN', 'chat.path_open_ide_declined', { path: relPath });
          return openInDefaultAppFallback(relPath);
        })
        .catch(function reportIdeFailure(error) {
          appendClientLog('WARN', 'chat.path_open_ide_failed', {
            path: relPath,
            message: String((error && error.message) || error || ''),
          });
          return openInDefaultAppFallback(relPath);
        });
    }

    // The panel is preferred only when it can actually take ownership: the
    // dep is wired, chat is the active view (the rail lives on the chat page),
    // and a workspace root is set (the rail reads through workspaceFs).
    function shouldPreferArtifactPanel() {
      return typeof openFilePreviewTarget === 'function'
        && state
        && state.ui
        && state.ui.activeView === 'chat'
        && hasWorkspaceRoot();
    }

    // The claimed navigation. Panel first (the user stays in chat), then the
    // direct IDE route, then the OS default app, then a toast. A panel that
    // declines (root vanished mid-open, no preview owner) or rejects is not a
    // failure — it just hands the target back to the IDE ladder.
    function openClaimedPath(relPath, line, column, options) {
      if (options && options.preferIde === true) {
        return openInIdePath(relPath, line, column);
      }
      if (!shouldPreferArtifactPanel()) {
        return openInIdePath(relPath, line, column);
      }
      return Promise.resolve()
        .then(function invokePanel() {
          return openFilePreviewTarget({ path: relPath, line: line, column: column });
        })
        .then(function settlePanelOpen(taken) {
          if (taken === true) {
            appendClientLog('INFO', 'chat.path_open_panel', { path: relPath, line: line });
            return true;
          }
          return openInIdePath(relPath, line, column);
        })
        .catch(function reportPanelFailure(error) {
          appendClientLog('WARN', 'chat.path_open_panel_failed', {
            path: relPath,
            message: String((error && error.message) || error || ''),
          });
          return openInIdePath(relPath, line, column);
        });
    }

    function handleOpenFileEvent(event) {
      if (disposed || !openIdeFileAtLine) {
        return;
      }
      var detail = event && event.detail && typeof event.detail === 'object'
        ? event.detail
        : {};
      var relPath = normalizeRelPath(detail.path);
      if (!isOpenableRelPath(relPath) || !hasWorkspaceRoot()) {
        // Unclaimed on purpose: the dispatcher's default-app fallback is the
        // right degradation for absolute/escaping paths and rootless shells.
        return;
      }
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      openClaimedPath(relPath, clampLine(detail.line), clampLine(detail.column), {
        preferIde: detail.preferIde === true,
      });
    }

    // Chips re-enter through the shared event so cite links and chips stay on
    // one navigation flow; when nothing claims it (IDE wiring absent) the chip
    // mirrors the cite-utils default-app fallback rather than dying silently.
    function dispatchOpenForChip(relPath, line, column) {
      var claimed = false;
      try {
        if (typeof windowRef.CustomEvent === 'function' && typeof windowRef.dispatchEvent === 'function') {
          var openEvent = new windowRef.CustomEvent(OPEN_FILE_EVENT, {
            detail: { path: relPath, line: line, column: column },
            bubbles: true,
            cancelable: true,
          });
          claimed = windowRef.dispatchEvent(openEvent) === false;
        }
      } catch (_error) {
        claimed = false;
      }
      appendClientLog('INFO', 'chat.tool_path_chip_open', { path: relPath, handled: claimed });
      if (!claimed) {
        openInDefaultAppFallback(relPath);
      }
    }

    // Path-shaped inline code in message prose ("`workspace/hellodemo.md`")
    // reads as clickable (inline code carries hover styling) and models
    // routinely reference written files this way, so make it navigate like a
    // chip (GUI finding 2026-07-20). At least one path separator is required
    // so property-access spans (`state.ui.followLatest`) stay inert; code
    // blocks (inside <pre>) are never treated as paths. An optional trailing
    // :line[:column] suffix resolves to the line.
    function resolveInlineCodePath(target) {
      if (!target || typeof target.closest !== 'function') {
        return null;
      }
      var code = target.closest('code');
      if (!code || code.closest('pre') || code.closest('[data-chat-path-open]')) {
        return null;
      }
      var text = normalizeRelPath(code.textContent);
      var match = INLINE_CODE_PATH_RE.exec(text);
      if (!match) {
        return null;
      }
      var path = text.replace(/:\d+(?::\d+)?$/, '');
      if (!isOpenableRelPath(path)) {
        return null;
      }
      return {
        path: path,
        line: match[1] ? clampLine(match[1]) : null,
        column: match[2] ? clampLine(match[2]) : null,
      };
    }

    function insideTimeline(node) {
      return !chatTimeline
        || typeof chatTimeline.contains !== 'function'
        || chatTimeline.contains(node);
    }

    function insidePathRoot(node) {
      return pathRoots.length === 0 || pathRoots.some(function containsNode(rootEl) {
        return typeof rootEl.contains !== 'function' || rootEl.contains(node);
      });
    }

    function handleChipClick(event) {
      if (disposed) {
        return;
      }
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var relPath = null;
      var line = null;
      var column = null;
      var chip = target.closest('[data-chat-path-open]');
      if (chip && insidePathRoot(chip)) {
        relPath = normalizeRelPath(chip.getAttribute('data-chat-path-open'));
        line = clampLine(chip.getAttribute('data-chat-path-line'));
        column = clampLine(chip.getAttribute('data-chat-path-column'));
      } else if (insideTimeline(target)) {
        var inline = resolveInlineCodePath(target);
        if (inline) {
          relPath = inline.path;
          line = inline.line;
          column = inline.column;
        }
      }
      if (!relPath || !isOpenableRelPath(relPath)) {
        return;
      }
      // Capture phase: stop the click before the row header's expand/collapse
      // toggle (a bubble-phase delegate on the same timeline root) sees it.
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      dispatchOpenForChip(relPath, line, column);
    }

    // Chips are focusable role=link spans nested inside the row header's
    // role=button toggle; Enter/Space on a focused chip must activate the chip
    // (and not fall through to the toggle's own keydown delegate).
    function handleChipKeydown(event) {
      if (!event || (event.key !== 'Enter' && event.key !== ' ')) {
        return;
      }
      var target = event.target;
      if (!target || typeof target.closest !== 'function' || !target.closest('[data-chat-path-open]')) {
        return;
      }
      handleChipClick(event);
    }

    function isEditableTarget(target) {
      if (!target) {
        return false;
      }
      var tag = String(target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return true;
      }
      return typeof target.closest === 'function'
        && Boolean(target.closest('[contenteditable="true"], [contenteditable=""]'));
    }

    function hasTextSelection() {
      try {
        var selection = windowRef.getSelection ? windowRef.getSelection() : null;
        return Boolean(selection && !selection.isCollapsed && String(selection.toString() || '').trim());
      } catch (_error) {
        return false;
      }
    }

    function resolveContextTarget(target) {
      if (!target || typeof target.closest !== 'function') {
        return null;
      }
      var citeAnchor = target.closest('a.codebase-cite-link');
      if (citeAnchor && citeUtils && typeof citeUtils.parseCodebaseCiteHref === 'function') {
        var citation = citeUtils.parseCodebaseCiteHref(
          citeAnchor.getAttribute('href'),
          doc && doc.location && doc.location.href
        );
        if (citation && citation.path) {
          return { path: normalizeRelPath(citation.path), line: citation.line || null };
        }
      }
      var pathHost = target.closest('[data-chat-path]');
      if (pathHost) {
        var relPath = normalizeRelPath(pathHost.getAttribute('data-chat-path'));
        if (relPath) {
          return {
            path: relPath,
            line: clampLine(pathHost.getAttribute('data-chat-path-line')),
            column: clampLine(pathHost.getAttribute('data-chat-path-column')),
          };
        }
      }
      return resolveInlineCodePath(target);
    }

    var pathMenu = pathMenuFactory && typeof pathMenuFactory.createIdePathMenu === 'function'
      ? pathMenuFactory.createIdePathMenu({
        getWorkspaceFsApi: getWorkspaceFs,
        windowRef: windowRef,
        showShellErrorToast: function showShellErrorToastAdapter(message, options) {
          showToastMessage(message, {
            title: (options && options.title) || 'Workspace',
            tone: 'danger',
            dedupeKey: (options && options.dedupeKey) || 'chat:path-menu',
          });
        },
        showToastMessage: showToastMessage,
        toErrorMessage: function toErrorMessage(error, fallback) {
          return String((error && error.message) || error || fallback || '');
        },
        appendClientLog: appendClientLog,
      })
      : null;

    function handleContextMenu(event) {
      if (disposed || !contextMenu || typeof contextMenu.show !== 'function') {
        return;
      }
      var target = event && event.target;
      if (isEditableTarget(target) || hasTextSelection()) {
        return;
      }
      var resolved = resolveContextTarget(target);
      if (!resolved || !isOpenableRelPath(resolved.path)) {
        return;
      }
      event.preventDefault();
      var items = [];
      // Open Preview leads: the in-chat rail is the default click behavior, so
      // the menu's first item must match it. "Open in IDE" stays the explicit
      // escape hatch and takes the DIRECT route (never the panel).
      if (shouldPreferArtifactPanel()) {
        items.push({
          label: 'Open Preview',
          action: function openPreviewAction() {
            return openClaimedPath(resolved.path, resolved.line, resolved.column || null);
          },
        });
      }
      if (openIdeFileAtLine && hasWorkspaceRoot()) {
        items.push({
          label: 'Open in IDE',
          action: function openInIdeAction() {
            return openInIdePath(resolved.path, resolved.line, resolved.column || null);
          },
        });
      }
      if (pathMenu && typeof pathMenu.buildPathUtilityMenuItems === 'function') {
        items = items.concat(pathMenu.buildPathUtilityMenuItems(resolved.path, 'file'));
      }
      // A leading separator with no items before it reads as a floating rule.
      while (items.length && items[0] && items[0].separator === true) {
        items.shift();
      }
      if (!items.length) {
        return;
      }
      contextMenu.show({
        items: items,
        anchorX: event.clientX,
        anchorY: event.clientY,
        rootEl: chatTimeline || undefined,
        onActionError: function reportMenuActionError(error) {
          appendClientLog('WARN', 'chat.path_menu_action_failed', {
            path: resolved.path,
            message: String((error && error.message) || error || ''),
          });
        },
      });
    }

    function attach() {
      if (typeof windowRef.addEventListener === 'function') {
        windowRef.addEventListener(OPEN_FILE_EVENT, handleOpenFileEvent);
      }
      pathRoots.forEach(function attachPathRoot(rootEl) {
        rootEl.addEventListener('click', handleChipClick, true);
        rootEl.addEventListener('keydown', handleChipKeydown, true);
        rootEl.addEventListener('contextmenu', handleContextMenu);
      });
      return function dispose() {
        disposed = true;
        if (typeof windowRef.removeEventListener === 'function') {
          windowRef.removeEventListener(OPEN_FILE_EVENT, handleOpenFileEvent);
        }
        pathRoots.forEach(function detachPathRoot(rootEl) {
          rootEl.removeEventListener('click', handleChipClick, true);
          rootEl.removeEventListener('keydown', handleChipKeydown, true);
          rootEl.removeEventListener('contextmenu', handleContextMenu);
        });
      };
    }

    return {
      attach: attach,
      // Exposed for tests; production consumers go through attach().
      handleOpenFileEvent: handleOpenFileEvent,
      handleChipClick: handleChipClick,
      handleContextMenu: handleContextMenu,
      // Exposed for tests: the direct (panel-bypassing) IDE route.
      openInIdePath: openInIdePath,
      isOpenableRelPath: isOpenableRelPath,
    };
  }

  return {
    createChatPathOpenController: createChatPathOpenController,
    isOpenableRelPath: isOpenableRelPath,
  };
});
