/* renderer/features/renderer-workspace-git-client.js - thin typed renderer
 * client over the window.jennyShell.workspaceGit.* bridge (the Tier-2 SCM
 * foundation). Mirrors the controller's getWorkspaceFsApi() by-ref pattern but
 * as a standalone module so the IDE git features consume THIS, never the raw
 * bridge. Every method guards bridge presence and NEVER throws: a missing
 * bridge resolves a synthetic { available:false } degrade shape, and an
 * unexpected rejection resolves a structured failure shape (so a thrown
 * validation error - bad path/ref/empty message - surfaces as data, not an
 * exception). The service itself already degrades-never for environmental
 * cases ({available:false}/{isRepo:false}); this client only adds the
 * bridge-absent and defensive-catch guards on top. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspaceGitClient = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The 14 bridge methods, each an ipcRenderer.invoke pass-through. Listed
  // once so the typed surface and the degrade shapes stay in lock-step.
  const GIT_METHODS = [
    'getStatus', 'getDiff', 'getCommitDiff', 'getFileAtHead', 'getLog', 'getBranches',
    'blameRange', 'stage', 'unstage', 'commit', 'discardFile', 'checkout',
    'stash', 'undoLastCommit',
  ];

  function bridgeUnavailable(op) {
    return { ok: false, available: false, isRepo: false, op, reason: 'bridge_unavailable' };
  }

  // A present-bridge call that rejected: the only rejections the service raises
  // are input-validation errors (CMP-GIT-0002/0003/0010/0011/0020), so preserve
  // the code/message as data rather than letting the promise reject.
  function callFailed(op, error) {
    return {
      ok: false,
      available: true,
      isRepo: true,
      op,
      error_code: (error && error.code) || null,
      reason: 'call_failed',
      message: String((error && error.message) || error || ''),
    };
  }

  function createWorkspaceGitClient(deps) {
    const options = deps || {};
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const windowRef = options.windowRef || globalRef.window || globalRef;

    // Re-read live on every call: the bridge appears once at preload and never
    // changes, but a getter keeps this resilient to a late-arriving bridge.
    function getApi() {
      return (windowRef && windowRef.jennyShell && windowRef.jennyShell.workspaceGit) || null;
    }

    function isAvailable() {
      const api = getApi();
      return Boolean(api && typeof api.getStatus === 'function');
    }

    async function call(op, payload) {
      const api = getApi();
      if (!api || typeof api[op] !== 'function') {
        return bridgeUnavailable(op);
      }
      try {
        return await api[op](payload);
      } catch (error) {
        return callFailed(op, error);
      }
    }

    const client = { getApi, isAvailable };
    for (const method of GIT_METHODS) {
      client[method] = (payload) => call(method, payload || {});
    }
    return client;
  }

  return {
    createWorkspaceGitClient,
    GIT_METHODS,
  };
});
