/* renderer/features/renderer-ide-welcome.js
 *
 * Welcome / Start surface for the empty editor state (#ideEmptyState). Owns the
 * empty-state copy, "Choose Folder" action, recent-files list, and keyboard
 * cheat-sheet.
 *
 * Recent files are a bounded, in-session MRU seeded from the hydrated open-tabs
 * snapshot and updated as files open. The cheat-sheet shares
 * renderer-ide-shortcuts so it never drifts from the "?" overlay.
 *
 * All buttons render through the inventory action-button primitive (no raw
 * button tags); the cheat-sheet markup is sanitized HTML built by
 * renderer-ide-shortcuts. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererIdeWelcome = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  'use strict';

  const RECENT_LIMIT = 8;
  const COPY_HAS_ROOT =
    'Open a file from the explorer to start editing, search across the workspace, or review Jenny’s changes.';
  const COPY_NO_ROOT = 'Choose a workspace folder to start editing files.';
  const COPY_NO_BRIDGE = 'Workspace file access is unavailable in this shell mode.';

  function defaultEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function basename(path) {
    const str = String(path || '');
    const slash = str.lastIndexOf('/');
    return slash === -1 ? str : str.slice(slash + 1);
  }

  function dirname(path) {
    const str = String(path || '');
    const slash = str.lastIndexOf('/');
    return slash === -1 ? '' : str.slice(0, slash);
  }

  function createIdeWelcome(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : defaultEscape;
    const actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    // Returns the workspaceFs bridge API (or null in restricted shell modes) so
    // the no-bridge / no-root / has-root copy matches the prior controller code.
    const getFsApi = typeof options.getFsApi === 'function' ? options.getFsApi : () => null;
    const buildShortcutsHtml = typeof options.buildShortcutsHtml === 'function'
      ? options.buildShortcutsHtml
      : () => '';
    const onOpenFile = typeof options.onOpenFile === 'function' ? options.onOpenFile : () => {};
    const onChooseFolder = typeof options.onChooseFolder === 'function' ? options.onChooseFolder : () => {};
    const disposalFence = asyncFence.createDisposalFence();
    const renderGate = asyncFence.createGenerationGate();

    const recent = [];
    let bound = false;
    let clickHandler = null;

    function noteOpened(path) {
      const normalized = String(path || '').trim();
      if (!normalized) {
        return;
      }
      const existing = recent.indexOf(normalized);
      if (existing !== -1) {
        recent.splice(existing, 1);
      }
      recent.unshift(normalized);
      if (recent.length > RECENT_LIMIT) {
        recent.length = RECENT_LIMIT;
      }
    }

    // Seed in reverse so the first path ends up most-recent (front of the MRU).
    function seedRecent(paths) {
      if (!Array.isArray(paths)) {
        return;
      }
      for (let i = paths.length - 1; i >= 0; i -= 1) {
        noteOpened(paths[i]);
      }
    }

    function drop(path) {
      const index = recent.indexOf(String(path || '').trim());
      if (index !== -1) {
        recent.splice(index, 1);
      }
    }

    // The "Choose Folder" button only renders while no workspace root is
    // configured; it shares the chooser dialog with the explorer tree. Behavior
    // mirrors the controller's prior renderEmptyStateAction verbatim so the
    // a11y contract (data-ide-choose-root + hidden toggle) is preserved.
    function renderAction(showChoose) {
      const container = getDom().ideEmptyStateAction || null;
      if (!container) {
        return;
      }
      const markup = showChoose && actionButton
        ? actionButton({
          label: 'Choose Folder',
          variant: 'primary',
          dataset: { 'ide-choose-root': '1' },
        })
        : '';
      if (container.innerHTML !== markup) {
        container.innerHTML = markup;
      }
      container.classList.toggle('hidden', !markup);
    }

    function buildRecentHtml() {
      if (!recent.length || !actionButton) {
        return '';
      }
      const rows = recent
        .map((path) => {
          const dir = dirname(path);
          const name = basename(path);
          return actionButton({
            plain: true,
            className: 'ide-welcome-recent-item',
            dataset: { 'ide-welcome-file': path },
            title: path,
            trustedHtml: '<span class="ide-welcome-recent-name">' + escapeHtml(name) + '</span>'
              + (dir ? '<span class="ide-welcome-recent-dir">' + escapeHtml(dir) + '</span>' : ''),
          });
        })
        .join('');
      return '<section class="ide-welcome-section">'
        + '<h3 class="ide-welcome-heading">Recent files</h3>'
        + '<div class="ide-welcome-recent-list">' + rows + '</div>'
        + '</section>';
    }

    // Progressive disclosure (GUI finding 2026-07-20): the full four-section
    // catalog pushed the only actionable control below the fold and diluted
    // the primary next step. Collapsed <details> keeps it one keypress away;
    // the `?` overlay still shows the identical catalog expanded.
    function buildShortcutsSection() {
      const body = buildShortcutsHtml();
      if (!body) {
        return '';
      }
      return '<details class="ide-welcome-section ide-welcome-shortcuts">'
        + '<summary class="ide-welcome-heading">Keyboard shortcuts</summary>'
        + '<div class="ide-welcome-shortcuts-body">' + body + '</div>'
        + '</details>';
    }

    // When a root is configured the primary #ideEmptyStateAction button is
    // hidden (its slot is the no-root call-to-action), so the welcome surface
    // carries a secondary "Open a different folder" affordance.
    function buildSwitchFolderHtml(hasRoot) {
      if (!hasRoot || !actionButton) {
        return '';
      }
      return '<div class="ide-welcome-actions">'
        + actionButton({
          label: 'Open a different folder…',
          variant: 'ghost',
          size: 'sm',
          dataset: { 'ide-welcome-choose-root': '1' },
        })
        + '</div>';
    }

    function ensureExtra() {
      const host = getDom().ideEmptyState || null;
      if (!host || typeof host.querySelector !== 'function') {
        return null;
      }
      let extra = host.querySelector('[data-ide-welcome-extra]');
      if (!extra) {
        const docRef = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!docRef) {
          return null;
        }
        extra = docRef.createElement('div');
        extra.className = 'ide-welcome';
        extra.setAttribute('data-ide-welcome-extra', '1');
        host.appendChild(extra);
      }
      return extra;
    }

    async function render(options = {}) {
      if (disposalFence.isDisposed()) return;
      renderGate.bump();
      const token = renderGate.capture();
      const dom = getDom();
      const hasRootOverride = typeof options.hasRoot === 'boolean';
      let hasRoot = options.hasRoot === true;
      const api = getFsApi();
      if (hasRootOverride) {
        if (dom.ideEmptyStateCopy) {
          dom.ideEmptyStateCopy.textContent = hasRoot ? COPY_HAS_ROOT : COPY_NO_ROOT;
        }
        renderAction(!hasRoot);
      } else if (!api || typeof api.getRootState !== 'function') {
        if (dom.ideEmptyStateCopy) {
          dom.ideEmptyStateCopy.textContent = COPY_NO_BRIDGE;
        }
        renderAction(false);
      } else {
        try {
          const rootState = await api.getRootState();
          if (disposalFence.isDisposed() || !renderGate.isCurrent(token)) return;
          hasRoot = Boolean(rootState && rootState.workspaceRoot);
          if (dom.ideEmptyStateCopy) {
            dom.ideEmptyStateCopy.textContent = hasRoot ? COPY_HAS_ROOT : COPY_NO_ROOT;
          }
          renderAction(!hasRoot);
        } catch (_error) {
          /* keep the static copy + last action state */
        }
      }
      if (disposalFence.isDisposed() || !renderGate.isCurrent(token)) return;
      const extra = ensureExtra();
      if (extra) {
        // Order: recent files, then the actionable "open a folder" CTA, then
        // the collapsed shortcut catalog — the primary action stays above the
        // fold (GUI finding 2026-07-20).
        const markup = buildRecentHtml() + buildSwitchFolderHtml(hasRoot) + buildShortcutsSection();
        if (extra.__jennyWelcomeMarkup !== markup) {
          extra.innerHTML = markup;
          extra.__jennyWelcomeMarkup = markup;
        }
      }
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (target.closest('[data-ide-choose-root]') || target.closest('[data-ide-welcome-choose-root]')) {
        event.preventDefault();
        onChooseFolder();
        return;
      }
      const fileEl = target.closest('[data-ide-welcome-file]');
      if (fileEl) {
        event.preventDefault();
        onOpenFile(fileEl.getAttribute('data-ide-welcome-file') || '');
      }
    }

    function bindEvents() {
      if (bound) {
        return;
      }
      const host = getDom().ideEmptyState || null;
      if (!host) {
        return;
      }
      bound = true;
      clickHandler = handleClick;
      host.addEventListener('click', clickHandler);
    }

    function dispose() {
      renderGate.bump();
      disposalFence.dispose();
      if (bound) {
        const host = getDom().ideEmptyState || null;
        if (host && clickHandler) {
          host.removeEventListener('click', clickHandler);
        }
      }
      bound = false;
      clickHandler = null;
      recent.length = 0;
    }

    return {
      render,
      bindEvents,
      dispose,
      noteOpened,
      seedRecent,
      drop,
    };
  }

  // Shared by the welcome surface and explorer no-root row. The injected API is
  // the shell transaction facade; it owns preflight, commit, and all refreshes.
  function createChooseWorkspaceRoot(deps) {
    const options = deps || {};
    const getWorkspaceRootApi = typeof options.getWorkspaceRootApi === 'function'
      ? options.getWorkspaceRootApi
      : () => null;
    const showShellErrorToast = typeof options.showShellErrorToast === 'function'
      ? options.showShellErrorToast
      : () => {};
    const toErrorMessage = typeof options.toErrorMessage === 'function'
      ? options.toErrorMessage
      : (error, fallback) => String(error?.message || error || fallback || '');
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : () => {};
    return async function chooseWorkspaceRoot() {
      const api = getWorkspaceRootApi();
      if (typeof api?.choose !== 'function') {
        showShellErrorToast('Workspace folder selection is unavailable in this shell mode.', {
          title: 'Workspace',
          dedupeKey: 'ide:root:no-bridge',
        });
        return false;
      }
      let result;
      try {
        result = await api.choose();
      } catch (error) {
        showShellErrorToast(toErrorMessage(error, 'Could not choose a workspace folder.'), {
          title: 'Workspace',
          dedupeKey: 'ide:root:choose',
        });
        appendClientLog('WARN', 'ide.choose_root_failed', {
          message: String(error?.message || error || ''),
        });
        return false;
      }
      if (result?.blocked === true) {
        // The shared service normally owns this feedback. Keep the return value
        // truthful for restricted/test shells without duplicating a toast.
        return false;
      }
      return result?.committed === true;
    };
  }

  return { createIdeWelcome, createChooseWorkspaceRoot };
});
