(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererKnowledgeScope = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createKnowledgeView() {
    return {
      roots: [],
      pendingRemoveId: '',
      addBusy: false,
      addInputValue: '',
      errorMessage: '',
      sessionId: '',
      projectId: '',
      revision: null,
    };
  }

  function createKnowledgeScopeRuntime(deps) {
    var d = deps || {};
    var state = d.state || {};
    var view = d.view || {};
    var getBridge = d.getBridge;
    var guard = d.disposalFence.guard;
    var normalizeRoots = d.normalizeRoots;
    var render = d.render;
    var onScopeChanged = d.onScopeChanged;
    var onSnapshotApplied = d.onSnapshotApplied;
    var appendClientLog = d.appendClientLog;
    var loadingScopeKey = '';
    var loadingRequestId = 0;
    var nextRequestId = 0;
    var queuedRefreshScopeKey = '';

    function capture() {
      var sessionId = String(state.currentSessionId || '').trim();
      if (!sessionId) return null;
      var sessions = Array.isArray(state.sessions) ? state.sessions : [];
      var session = sessions.find(function (entry) {
        return String(entry && entry.id || '').trim() === sessionId;
      });
      var projectId = String(session && session.project_id || '').trim();
      return projectId ? { sessionId: sessionId, projectId: projectId } : null;
    }

    function key(scope) {
      return scope ? scope.sessionId + '\u0000' + scope.projectId : '';
    }

    function isCurrent(scope) {
      return key(capture()) === key(scope);
    }

    function isView(scope) {
      return Boolean(scope && view.sessionId === scope.sessionId && view.projectId === scope.projectId);
    }

    function prepare(scope) {
      if (isView(scope)) return;
      if (typeof onScopeChanged === 'function') onScopeChanged();
      queuedRefreshScopeKey = '';
      view.roots = [];
      view.pendingRemoveId = '';
      view.addBusy = false;
      view.addInputValue = '';
      view.errorMessage = '';
      view.sessionId = scope.sessionId;
      view.projectId = scope.projectId;
      view.revision = null;
    }

    function payload(scope, extra) {
      return Object.assign({
        session_id: scope.sessionId,
        project_id: scope.projectId,
      }, extra || {});
    }

    function storeSnapshot(snapshot) {
      var revision = Number.isSafeInteger(snapshot && snapshot.revision)
        && snapshot.revision >= 0 ? snapshot.revision : null;
      if (revision !== null && Number.isSafeInteger(view.revision) && revision < view.revision) {
        return false;
      }
      view.roots = normalizeRoots(snapshot);
      view.revision = revision;
      if (typeof onSnapshotApplied === 'function') onSnapshotApplied();
      return true;
    }

    function load(requestedScope) {
      var bridge = getBridge();
      if (!bridge || typeof bridge.getState !== 'function') return Promise.resolve(false);
      var scope = requestedScope || capture();
      if (!scope) return Promise.resolve(false);
      prepare(scope);
      var requestKey = key(scope);
      var requestId = ++nextRequestId;
      loadingScopeKey = requestKey;
      loadingRequestId = requestId;
      return Promise.resolve()
        .then(guard(function () { return bridge.getState(payload(scope)); }))
        .then(guard(function (snapshot) {
          if (!isCurrent(scope) || snapshot && snapshot.projectId !== scope.projectId) return false;
          return storeSnapshot(snapshot);
        }))
        .catch(guard(function (error) {
          if (isCurrent(scope)) {
            appendClientLog('WARN', 'knowledge_folders.get_state_failed', {
              message: error && error.message ? error.message : String(error),
            });
          }
          return false;
        }))
        .then(guard(function (applied) {
          if (loadingRequestId === requestId) {
            loadingScopeKey = '';
            loadingRequestId = 0;
          }
          if (queuedRefreshScopeKey === requestKey && isCurrent(scope) && !loadingScopeKey) {
            queuedRefreshScopeKey = '';
            return load(scope).then(function (rerunApplied) {
              return applied === true || rerunApplied === true;
            });
          }
          return applied;
        }));
    }

    function refresh(scope) {
      return load(scope).then(guard(function (applied) {
        if (applied === true && isCurrent(scope || capture())) render();
      }));
    }

    function applyChanged(snapshot) {
      var scope = capture();
      if (!scope || !isView(scope)) return;
      if (snapshot && snapshot.projectId !== scope.projectId) {
        if (Number.isSafeInteger(snapshot.revision)
          && (!Number.isSafeInteger(view.revision) || snapshot.revision > view.revision)) {
          if (loadingScopeKey === key(scope)) queuedRefreshScopeKey = key(scope);
          else void refresh(scope);
        }
        return;
      }
      if (storeSnapshot(snapshot)) render();
    }

    return {
      applyChanged: applyChanged,
      capture: capture,
      isCurrent: isCurrent,
      isLoading: function (scope) { return loadingScopeKey === key(scope); },
      isView: isView,
      payload: payload,
      prepare: prepare,
      refresh: refresh,
    };
  }

  return {
    createKnowledgeScopeRuntime: createKnowledgeScopeRuntime,
    createKnowledgeView: createKnowledgeView,
  };
});
