/* renderer/features/renderer-chat-workspace-detail.js
 * Detail entry points for the session rail (row 59 checkpoint 2, contract C3).
 *
 *   window.rendererChatWorkspaceDetail.open({ surface, ownerSessionId, opener, resourceRef })
 *   window.rendererChatWorkspaceDetail.close()
 *
 * surface: 'outputs' | 'changes' | 'background_tasks' | 'context' | 'environment'.
 *   outputs          -> the artifact review panel (resourceRef: an artifact id opens that artifact)
 *   changes          -> the read-only working-tree Changes page (renderer-code-review-rail.js)
 *   background_tasks -> the context panel's Activity
 *   context          -> the composer context ring popover of the opener's pane
 *   environment      -> the project pill popover of the opener's pane
 *
 * Opening claims the one side panel for `ownerSessionId` (the explicit owner: a focus change never
 * retargets it) and remembers `opener`; close() hands focus back to it while it is still connected.
 * A second open while a panel is showing swaps the content in place: every opener below reuses the
 * panel that is already open, so the column does not move.
 *
 * The module owns no UI. Its openers are injected by the shell (configure) because the panels live in
 * controllers built elsewhere; the composer popovers are found through the opener's own pane.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatWorkspaceDetail = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SURFACES = Object.freeze(['outputs', 'changes', 'background_tasks', 'context', 'environment']);
  const MAX_ID_LENGTH = 200;
  const CONTEXT_RING_SELECTOR = '[data-inv-chip="composer-context-ring"]';
  // An attribute selector on purpose: a second pane repeats this id, and an id selector may resolve against the first.
  const PROJECT_PILL_SELECTOR = '[id="composerProjectPillSlot"] button';
  const ACTIVITY_BUTTON_SELECTOR = '[data-activity-open]:not([hidden])';

  function normalizeId(value) {
    const id = String(value == null ? '' : value).trim();
    return id && id.length <= MAX_ID_LENGTH ? id : '';
  }

  function createChatWorkspaceDetail(initialDeps) {
    let deps = { ...(initialDeps || {}) };
    let current = null; // { surface, ownerSessionId, opener }

    const call = (name, ...args) => (typeof deps[name] === 'function' ? deps[name](...args) : undefined);
    const windowRef = () => deps.windowRef || (typeof globalThis !== 'undefined' ? globalThis : null);
    const documentRef = (opener) => (opener && opener.ownerDocument) || deps.documentRef || (windowRef() && windowRef().document) || null;

    function log(level, event, payload) {
      try { call('log', level, event, payload); } catch (_error) { /* logging never blocks a panel */ }
    }

    // The composer controls of the opener's own pane (never another pane's, never the focused pane's).
    function findInPane(opener, selector) {
      const doc = documentRef(opener);
      const pane = opener && typeof opener.closest === 'function' ? opener.closest('.chat-pane') : null;
      const scope = pane || doc;
      return scope && typeof scope.querySelector === 'function' ? scope.querySelector(selector) : null;
    }

    function openOutputs(ownerSessionId, opener, resourceRef) {
      call('claimOwner', ownerSessionId);
      const result = call('openArtifact', normalizeId(resourceRef), { ownerSessionId, opener });
      return result !== false && typeof deps.openArtifact === 'function';
    }

    function openChanges(ownerSessionId, opener) {
      // The rail claims the owner itself (it must claim before it renders); this one is for fakes.
      return call('openChanges', { ownerSessionId, opener }) === true;
    }

    function openBackgroundTasks(ownerSessionId, opener) {
      call('claimOwner', ownerSessionId);
      if (typeof deps.openActivity === 'function') return deps.openActivity({ ownerSessionId, opener }) !== false;
      const button = findInPane(opener, ACTIVITY_BUTTON_SELECTOR);
      if (!button) return false;
      // The cluster button toggles: an Activity that is already open stays open (swap in place).
      if (button.getAttribute('aria-pressed') !== 'true') button.click();
      return true;
    }

    function openComposerPopover(opener, selector) {
      const control = findInPane(opener, selector);
      if (!control || control.disabled) return false;
      control.click();
      return true;
    }

    function open(request) {
      const options = request && typeof request === 'object' ? request : {};
      const surface = String(options.surface || '');
      const ownerSessionId = normalizeId(options.ownerSessionId);
      if (!SURFACES.includes(surface) || !ownerSessionId) {
        log('WARN', 'chat_workspace_detail.open_invalid', { surface: surface.slice(0, 40) });
        return false;
      }
      const opener = options.opener && typeof options.opener.focus === 'function' ? options.opener : null;
      let opened;
      try {
        if (surface === 'outputs') opened = openOutputs(ownerSessionId, opener, options.resourceRef);
        else if (surface === 'changes') opened = openChanges(ownerSessionId, opener);
        else if (surface === 'background_tasks') opened = openBackgroundTasks(ownerSessionId, opener);
        else if (surface === 'context') opened = openComposerPopover(opener, CONTEXT_RING_SELECTOR);
        else opened = openComposerPopover(opener, PROJECT_PILL_SELECTOR);
      } catch (error) {
        log('WARN', 'chat_workspace_detail.open_failed', { surface, message: String(error && error.message || error).slice(0, 200) });
        opened = false;
      }
      if (opened) current = { surface, ownerSessionId, opener };
      return opened;
    }

    // Close button / Escape paths run the panel's own close and then land here (or call here directly):
    // focus goes back to the row that opened the panel while that row is still in the document.
    function close() {
      const previous = current;
      current = null;
      if (previous && (previous.surface === 'outputs' || previous.surface === 'changes' || previous.surface === 'background_tasks')) {
        try { call('closePanel', previous); } catch (error) { log('WARN', 'chat_workspace_detail.close_failed', { message: String(error && error.message || error).slice(0, 200) }); }
      }
      const opener = previous && previous.opener;
      if (opener && opener.isConnected && typeof opener.focus === 'function') {
        opener.focus();
        return true;
      }
      return false;
    }

    // "Open in Workspace" for a working-tree file: the same cancelable seam the chat's path chips use.
    function openInWorkspace(path) {
      const target = String(path || '').trim();
      const win = windowRef();
      if (!target) return false;
      if (typeof deps.openInWorkspace === 'function') return deps.openInWorkspace(target) !== false;
      try {
        if (win && typeof win.CustomEvent === 'function' && typeof win.dispatchEvent === 'function') {
          const event = new win.CustomEvent('ide:open-file-at-line', {
            detail: { path: target, line: null, column: null, preferIde: true },
            bubbles: true,
            cancelable: true,
          });
          return win.dispatchEvent(event) === false;
        }
      } catch (_error) { /* an unclaimed open is simply false */ }
      return false;
    }

    // "Open in Git": the Workspace Git view (staging, commit and discard live only there).
    function openInGit() {
      if (typeof deps.openInGit !== 'function') return false;
      try { return deps.openInGit() !== false; } catch (error) {
        log('WARN', 'chat_workspace_detail.open_in_git_failed', { message: String(error && error.message || error).slice(0, 200) });
        return false;
      }
    }

    function configure(next) {
      deps = { ...deps, ...(next && typeof next === 'object' ? next : {}) };
    }

    return { open, close, openInWorkspace, openInGit, configure, getCurrent: () => (current ? { ...current } : null) };
  }

  const shared = createChatWorkspaceDetail({});
  return {
    open: shared.open,
    close: shared.close,
    openInWorkspace: shared.openInWorkspace,
    openInGit: shared.openInGit,
    configure: shared.configure,
    createChatWorkspaceDetail,
    SURFACES,
  };
});
