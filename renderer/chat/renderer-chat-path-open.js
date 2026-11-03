/* renderer/chat/renderer-chat-path-open.js
 * Preventing the cancelable `ide:open-file-at-line` event claims navigation.
 * Claimed opens try the preview panel, then the IDE; an IDE decline (binary,
 * oversize: the IDE toasts) ends there and a failure toasts. Clicks never fall
 * back to the OS default app (it would run a model-named `tool.exe`); only the
 * explicit "Open in Default App" menu item reaches it, through the main-process
 * external-open allowlist. `preferIde` skips the panel. Path chips suppress
 * propagation so opening a path does not toggle its row. Context menus exclude editable fields, text
 * selections, and non-path targets; a hover "more" button after each chip opens the same menu.
 * A file in another registered project (mode 'project') opens as a read-only preview, or in the IDE
 * after the Workspace switches to that project. Pure helpers live in
 * renderer/shared/workspace-path-resolve.js. Main-process containment stays authoritative.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatPathOpen = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var OPEN_FILE_EVENT = 'ide:open-file-at-line';
  // The shared rules (renderer/shared/workspace-path-resolve.js): window global in the app, node
  // require in tests. Eager before this file in index.html.
  var shared = globalThis.jennyWorkspacePathResolve || require('../shared/workspace-path-resolve');
  var normalizeRelPath = shared.normalizeRelPath;
  var isOpenableRelPath = shared.isOpenableRelPath;
  var clampLine = shared.clampLine;
  var paneOf = shared.paneOf;

  function noop() {}

  function createChatPathOpenController(deps) {
    var settings = deps || {};
    var windowRef = settings.windowRef
      || (typeof globalThis !== 'undefined' ? globalThis : {});
    var pathResolve = settings.pathResolve || windowRef.jennyWorkspacePathResolve || shared;
    var chatTimeline = settings.chatTimeline || null;
    var pathRoots = [chatTimeline].concat(Array.isArray(settings.pathRoots) ? settings.pathRoots : [])
      .filter(function uniqueRoot(rootEl, index, roots) {
        return rootEl && roots.indexOf(rootEl) === index;
      });
    // Split view: a second pane mounts after boot, so its timeline and inspector are found at
    // event time under `paneHost` (the document); pane 0's own roots keep direct listeners.
    var paneHost = settings.paneHost || null;
    var scope = shared.createPaneScope({ paneHost: paneHost, chatTimeline: chatTimeline, pathRoots: pathRoots });
    var otherPaneRoot = scope.otherPaneRoot;
    var insideTimeline = scope.insideTimeline;
    var insidePathRoot = scope.insidePathRoot;
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
    // Optional: the chat page's read-only file preview rail. The real fallback gate is the OWNERSHIP RESULT:
    // anything but a strict `true` (a bridge without a controller returns false, legacy noop wiring
    // resolves undefined) falls through to the IDE path.
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

    // Row 95: reveal a folder in the IDE explorer tree. Optional: without it a folder click toasts.
    var revealInIdeTree = typeof settings.revealInIdeTree === 'function' ? settings.revealInIdeTree : null;
    // Project links: openProjectFileInIde({ projectId, path, line, column }) switches the Workspace to
    // the project, then opens the file; getProjectRoots() -> [{ id, rootPath }] (cached, cheap).
    var openProjectFileInIde = typeof settings.openProjectFileInIde === 'function' ? settings.openProjectFileInIde : null;
    function projectRoots() { return typeof settings.getProjectRoots === 'function' ? settings.getProjectRoots() || [] : []; }

    var disposed = false;

    // Logs carry a code or name only: a bridge error message can hold an absolute path.
    function errorReason(error) {
      return String((error && (error.error_code || error.code || error.name)) || 'error').slice(0, 64);
    }

    // absolute_path_links: default ON; only an explicit false turns it off.
    function absoluteLinksOn() {
      var flags = state && state.features && state.features.featureFlags;
      return Boolean(pathResolve) && !(flags && flags.absolute_path_links === false);
    }

    function workspaceRootPath() {
      return state && state.workspaceRoot ? String(state.workspaceRoot.path || '').trim() : '';
    }

    // What a chip, inline path or menu target means (workspace-path-resolve.js classifyChipTarget):
    // 'open' | 'dir' (workspace-relative), 'project' (another registered project's file), 'copy'
    // (any other absolute path: Copy only), or null when it is not ours.
    function classifyTarget(raw, line, column, kind) {
      if (pathResolve && typeof pathResolve.classifyChipTarget === 'function') {
        return pathResolve.classifyChipTarget(raw, line, column, kind, {
          enabled: absoluteLinksOn(), workspaceRoot: workspaceRootPath(), projectRoots: projectRoots(), isOpenable: isOpenableRelPath, normalize: normalizeRelPath,
        });
      }
      var text = normalizeRelPath(raw);
      return isOpenableRelPath(text) ? { mode: 'open', path: text, line: line, column: column } : null;
    }

    function revealDirectory(relPath) {
      if (!revealInIdeTree) {
        toastOpenFailure(relPath, null);
        return Promise.resolve(false);
      }
      setActiveView('ide');
      return Promise.resolve(revealInIdeTree(relPath)).then(function settleReveal(done) {
        appendClientLog('INFO', 'chat.path_dir_reveal', { path: relPath, handled: done === true });
        if (done !== true) {
          toastOpenFailure(relPath, null);
        }
        return done === true;
      }).catch(function reportRevealFailure(error) {
        toastOpenFailure(relPath, error);
        return false;
      });
    }

    function copyDisplayPath(text) {
      var clipboard = windowRef.jennyShell && windowRef.jennyShell.clipboard;
      return Promise.resolve().then(function writeClipboard() {
        return clipboard.writeText(text);
      }).then(function toastCopied() {
        showToastMessage(jt('ide.pathMenu.copiedValue', 'Copied {value}', { value: text }), { dedupeKey: 'chat:path-copy' });
      }).catch(function toastCopyFailed() {
        showToastMessage(jt('ide.pathMenu.copyFailed', 'Could not copy to the clipboard.'), { tone: 'danger', dedupeKey: 'chat:path-copy' });
      });
    }

    // Sync eligibility for the IDE half. Until root state is hydrated at boot (renderer-shell-state-runtime-utils
    // applyWorkspaceRootStatePayload) we stay optimistic: the main process is the authority and the failure path toasts.
    function hasWorkspaceRoot() {
      var rootState = state && state.workspaceRoot;
      if (!rootState || typeof rootState !== 'object') {
        return true;
      }
      return Boolean(String(rootState.path || '').trim());
    }

    function toastOpenFailure(relPath, error) {
      var message = jt('chat.pathOpen.couldNotOpen', 'Couldn’t open {path}.', { path: relPath });
      var code = String((error && (error.error_code || error.code)) || '');
      if (code === 'CMP-WORKSPACEFS-0004') {
        message = jt('chat.pathOpen.fileNotFound', 'Couldn’t open {path} — file not found.', { path: relPath });
      } else if (code === 'CMP-WORKSPACEFS-0003') {
        message = jt('chat.pathOpen.outsideWorkspace', 'Couldn’t open {path} — outside the workspace.', { path: relPath });
      }
      showToastMessage(message, {
        title: jt('chat.pathOpen.openFileTitle', 'Open File'),
        tone: 'danger',
        dedupeKey: 'chat:path-open:' + relPath,
      });
    }

    // The DIRECT IDE route: Workspace view first, then the IDE's open-then-revealPosition seam. A
    // decline is final (the IDE already toasted); a failure toasts. Never the OS default app (F2).
    function openInIdePath(relPath, line, column, pane) {
      setActiveView('ide');
      return Promise.resolve(openIdeFileAtLine(relPath, line, column, pane === undefined ? undefined : { pane: pane }))
        .then(function settleIdeOpen(opened) {
          if (opened === true) {
            return true;
          }
          appendClientLog('WARN', 'chat.path_open_ide_declined', { path: relPath });
          return false;
        })
        .catch(function reportIdeFailure(error) {
          if (absoluteLinksOn() && revealInIdeTree && String((error && (error.error_code || error.code)) || '') === 'CMP-WORKSPACEFS-0005') {
            return revealDirectory(relPath); // the target is a folder: show it in the tree instead
          }
          appendClientLog('WARN', 'chat.path_open_ide_failed', {
            path: relPath,
            reason: errorReason(error),
          });
          toastOpenFailure(relPath, error);
          return false;
        });
    }

    // The panel can take a target only when it is wired and chat is the active view (the rail lives
    // on the chat page); a workspace file also needs a root (the rail reads through workspaceFs).
    function canUsePanel() {
      return typeof openFilePreviewTarget === 'function' && Boolean(state && state.ui && state.ui.activeView === 'chat');
    }
    function shouldPreferArtifactPanel() {
      return canUsePanel() && hasWorkspaceRoot();
    }
    var projectLinks = shared.createProjectLinks({
      preview: openFilePreviewTarget,
      ide: openProjectFileInIde,
      canPreview: canUsePanel,
      fail: function failProjectOpen(display, error) {
        if (error) appendClientLog('WARN', 'chat.project_path_open_failed', { reason: errorReason(error) });
        toastOpenFailure(display, error);
      },
    });

    // The claimed navigation: panel first (the user stays in chat), then the direct IDE route. A
    // panel that declines or rejects is not a failure; it hands the target back to the IDE.
    function openClaimedPath(relPath, line, column, options) {
      var pane = options ? options.pane : undefined;
      if (options && options.preferIde === true) {
        return openInIdePath(relPath, line, column, pane);
      }
      if (!shouldPreferArtifactPanel()) {
        return openInIdePath(relPath, line, column, pane);
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
          return openInIdePath(relPath, line, column, pane);
        })
        .catch(function reportPanelFailure(error) {
          appendClientLog('WARN', 'chat.path_open_panel_failed', {
            path: relPath,
            reason: errorReason(error),
          });
          return openInIdePath(relPath, line, column, pane);
        });
    }

    function handleOpenFileEvent(event) {
      if (disposed || !openIdeFileAtLine) {
        return;
      }
      var detail = event && event.detail && typeof event.detail === 'object'
        ? event.detail
        : {};
      if (detail.projectId != null) { // the preview panel's Open in IDE for a project file
        if (projectLinks.claim(detail) && typeof event.preventDefault === 'function') event.preventDefault();
        return;
      }
      var relPath = normalizeRelPath(detail.path);
      if (!isOpenableRelPath(relPath) || !hasWorkspaceRoot()) {
        // Unclaimed on purpose (absolute/escaping paths, rootless shells): the dispatcher shows its own cue.
        return;
      }
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      openClaimedPath(relPath, clampLine(detail.line), clampLine(detail.column), {
        preferIde: detail.preferIde === true,
        pane: detail.pane === 0 || detail.pane === 1 ? detail.pane : undefined,
      });
    }

    // Chips re-enter through the shared event so cite links and chips stay on one navigation flow;
    // an unclaimed one toasts rather than dying silently, never handing the path to the OS.
    function dispatchOpenForChip(relPath, line, column, pane) {
      var claimed = false;
      try {
        if (typeof windowRef.CustomEvent === 'function' && typeof windowRef.dispatchEvent === 'function') {
          var openEvent = new windowRef.CustomEvent(OPEN_FILE_EVENT, {
            detail: { path: relPath, line: line, column: column, pane: pane },
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
        toastOpenFailure(relPath, null);
      }
    }

    // Path-shaped inline code in prose navigates like a chip: models reference written files this way
    // (GUI finding 2026-07-20). A separator is required so property access (`state.ui.followLatest`)
    // stays inert; <pre> code is never a path; :line[:column] resolves.
    function resolveInlineCodePath(target) {
      if (!target || typeof target.closest !== 'function') {
        return null;
      }
      var code = target.closest('code');
      if (!code || code.closest('pre') || code.closest('[data-chat-path-open]')) {
        return null;
      }
      var rel = shared.parseInlineCodeRelPath(code.textContent);
      if (rel) {
        return rel;
      }
      var abs = absoluteLinksOn() ? pathResolve.parseAbsolutePathText(code.textContent) : null;
      return abs ? { path: abs.path, line: abs.line, column: abs.column, kind: abs.isDir ? 'dir' : '' } : null;
    }

    function handleChipClick(event) {
      if (disposed) {
        return;
      }
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var more = target.closest('.' + shared.MORE_CLASS);
      if (more) {
        event.stopPropagation(); // never toggles the row it sits in
        openMoreMenu(more, event);
        return;
      }
      var raw = null;
      var line = null;
      var column = null;
      var kind = '';
      var chip = target.closest('[data-chat-path-open]');
      if (chip && insidePathRoot(chip)) {
        raw = chip.getAttribute('data-chat-path-open');
        line = clampLine(chip.getAttribute('data-chat-path-line'));
        column = clampLine(chip.getAttribute('data-chat-path-column'));
        kind = chip.getAttribute('data-chat-path-kind') || '';
      } else if (insideTimeline(target)) {
        var inline = resolveInlineCodePath(target);
        if (inline) {
          raw = inline.path;
          line = inline.line;
          column = inline.column;
          kind = inline.kind || '';
        }
      }
      var resolved = raw ? classifyTarget(raw, line, column, kind) : null;
      if (!resolved) {
        return;
      }
      // Capture phase: stop the click before the row header's expand/collapse
      // toggle (a bubble-phase delegate on the same timeline root) sees it.
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      if (resolved.mode === 'dir') {
        revealDirectory(resolved.path);
      } else if (resolved.mode === 'open') {
        dispatchOpenForChip(resolved.path, resolved.line, resolved.column, paneOf(target));
      } else if (resolved.mode === 'project') {
        projectLinks.open(resolved, false);
      }
    }

    // Chips are focusable role=link spans inside the row header's role=button toggle; Enter/Space on
    // a focused chip activates the chip, not the toggle's own keydown delegate.
    function handleChipKeydown(event) {
      if (!event || (event.key !== 'Enter' && event.key !== ' ')) {
        return;
      }
      var target = event.target;
      if (target && typeof target.closest === 'function' && target.closest('.' + shared.MORE_CLASS)) {
        event.stopPropagation(); // the native button click opens the menu; the row toggle must not see the key
        return;
      }
      if (!target || typeof target.closest !== 'function' || !target.closest('[data-chat-path-open]')) {
        return;
      }
      handleChipClick(event);
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
          return { path: normalizeRelPath(citation.path), line: citation.line || null, column: null, kind: '' };
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
            kind: pathHost.getAttribute('data-chat-path-kind') || '',
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
            title: (options && options.title) || jt('chat.pathOpen.workspaceToastTitle', 'Workspace'),
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

    function classifyPicked(picked) {
      return picked ? classifyTarget(picked.path, picked.line, picked.column, picked.kind) : null;
    }

    // The path menu for one classified target; `place` carries the anchor (a point for a
    // right-click, the more button's element for the button). True when a menu was shown.
    function showTargetMenu(resolved, target, place) {
      var items = [];
      var copyItem = { label: jt('ide.pathMenu.copyPath', 'Copy Path'), action: function copyOutsidePath() { return copyDisplayPath(resolved.display); } };
      if (resolved.mode === 'copy') {
        items.push(copyItem);
      } else if (resolved.mode === 'project') {
        items = projectLinks.menuItems(resolved, jt, copyItem);
      } else if (resolved.mode === 'dir') {
        items.push({ label: jt('ide.tabs.revealInExplorer', 'Reveal in Explorer View'), action: function revealFolder() { return revealDirectory(resolved.path); } });
        items = items.concat(pathMenu && pathMenu.buildPathUtilityMenuItems ? pathMenu.buildPathUtilityMenuItems(resolved.path, 'directory') : []);
      }
      // Open Preview leads (the click default); "Open in IDE" is the explicit direct route.
      if (resolved.mode === 'open' && shouldPreferArtifactPanel()) {
        items.push({
          label: jt('chat.pathOpen.openPreview', 'Open Preview'),
          action: function openPreviewAction() {
            return openClaimedPath(resolved.path, resolved.line, resolved.column || null);
          },
        });
      }
      if (resolved.mode === 'open' && openIdeFileAtLine && hasWorkspaceRoot()) {
        items.push({
          label: jt('chat.pathOpen.openInIde', 'Open in IDE'),
          action: function openInIdeAction() {
            return openInIdePath(resolved.path, resolved.line, resolved.column || null, paneOf(target));
          },
        });
      }
      if (resolved.mode === 'open' && pathMenu && typeof pathMenu.buildPathUtilityMenuItems === 'function') {
        items = items.concat(pathMenu.buildPathUtilityMenuItems(resolved.path, 'file'));
      }
      // A leading separator with no items before it reads as a floating rule.
      while (items.length && items[0] && items[0].separator === true) {
        items.shift();
      }
      if (!items.length) {
        return false;
      }
      contextMenu.show(Object.assign({
        items: items,
        rootEl: otherPaneRoot(target) || chatTimeline || undefined,
        onActionError: function reportMenuActionError(error) {
          appendClientLog('WARN', 'chat.path_menu_action_failed', {
            path: resolved.path,
            reason: errorReason(error),
          });
        },
      }, place));
      return true;
    }

    function handleContextMenu(event) {
      if (disposed || !contextMenu || typeof contextMenu.show !== 'function') {
        return;
      }
      var target = event && event.target;
      if (shared.isEditableTarget(target) || shared.hasTextSelection(windowRef)) {
        return;
      }
      var resolved = classifyPicked(resolveContextTarget(target));
      if (!resolved) {
        return;
      }
      event.preventDefault();
      showTargetMenu(resolved, target, { anchorX: event.clientX, anchorY: event.clientY });
    }

    // Row 95 P1: a quiet "..." button after every path chip, inserted lazily on hover or focus
    // (the render path and cached HTML never carry it). It opens the chip's own context menu.
    function handleChipHover(event) {
      var target = event && event.target;
      var chip = !disposed && contextMenu && target && typeof target.closest === 'function' ? target.closest(shared.CHIP_SELECTOR) : null;
      if (chip && insidePathRoot(chip) && classifyTarget(chip.getAttribute('data-chat-path-open'), null, null, chip.getAttribute('data-chat-path-kind') || '')) {
        shared.ensureMoreButton(chip, jt('chat.pathOpen.moreForPath', 'More for this path'));
      }
    }

    function openMoreMenu(more, event) {
      var chip = more.previousElementSibling;
      if (!chip || !chip.matches(shared.CHIP_SELECTOR) || !insidePathRoot(chip) || !contextMenu || typeof contextMenu.show !== 'function') {
        return;
      }
      event.preventDefault();
      if (more.getAttribute('aria-expanded') === 'true') {
        contextMenu.hide(); // the anchor toggles its own open menu
        return;
      }
      var resolved = classifyPicked(resolveContextTarget(chip));
      if (resolved && showTargetMenu(resolved, chip, {
        anchorEl: more,
        restoreFocusTo: more,
        onHide: function collapseMore() { more.setAttribute('aria-expanded', 'false'); },
      })) {
        more.setAttribute('aria-expanded', 'true'); // after show(): it hides (and collapses) the previous menu first
      }
    }

    // [event, handler, capture]: on every path root, and (for another pane) through the pane host.
    var chipEvents = [
      ['click', handleChipClick, true], ['keydown', handleChipKeydown, true], ['contextmenu', handleContextMenu, false],
      ['pointerover', handleChipHover, false], ['focusin', handleChipHover, false],
    ];
    var paneEvents = chipEvents.map(function forPane(entry) { return [entry[0], scope.forOtherPane(entry[1]), entry[2]]; });

    function bindListeners(method) {
      pathRoots.forEach(function bindPathRoot(rootEl) {
        chipEvents.forEach(function bind(e) { rootEl[method](e[0], e[1], e[2]); });
      });
      if (paneHost && typeof paneHost[method] === 'function') {
        paneEvents.forEach(function bindPane(e) { paneHost[method](e[0], e[1], e[2]); });
      }
    }

    function attach() {
      if (typeof windowRef.addEventListener === 'function') {
        windowRef.addEventListener(OPEN_FILE_EVENT, handleOpenFileEvent);
      }
      if (pathResolve && typeof pathResolve.setContextProvider === 'function') {
        // The markdown chips and the prose pass read the flag and root through this at use time.
        pathResolve.setContextProvider(function absolutePathContext() {
          return { enabled: absoluteLinksOn(), workspaceRoot: workspaceRootPath(), projectRoots: projectRoots() };
        });
      }
      bindListeners('addEventListener');
      return function dispose() {
        disposed = true;
        if (pathResolve && typeof pathResolve.setContextProvider === 'function') {
          pathResolve.setContextProvider(null);
        }
        if (typeof windowRef.removeEventListener === 'function') {
          windowRef.removeEventListener(OPEN_FILE_EVENT, handleOpenFileEvent);
        }
        bindListeners('removeEventListener');
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
