'use strict';

const { workspaceRootId } = require('./workspace-root-identity');

function normalizeRoot(value) {
  return String(value || '').trim();
}

function clampInt(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizePathList(paths) {
  if (Array.isArray(paths)) return paths.filter((value) => value != null && String(value).trim());
  return paths != null && String(paths).trim() ? [paths] : [];
}

function linkedSignal(...signals) {
  const active = signals.filter((signal) => signal && typeof signal.addEventListener === 'function');
  if (active.length === 0) return { signal: null, dispose: () => {} };
  if (active.length === 1) return { signal: active[0], dispose: () => {} };
  const controller = new AbortController();
  const abort = (event) => {
    if (!controller.signal.aborted) controller.abort(event?.target?.reason);
  };
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of active) signal.removeEventListener('abort', abort);
    },
  };
}

class WorkspaceGitOperationContext {
  constructor({ rootContextProvider = null, rootProvider } = {}) {
    this._rootContextProvider = typeof rootContextProvider === 'function'
      ? rootContextProvider
      : () => null;
    this._rootProvider = typeof rootProvider === 'function' ? rootProvider : () => '';
    this._writeTails = new Map();
  }

  acquire({ kind = 'read', signal = null } = {}) {
    let coordinator;
    try {
      coordinator = this._rootContextProvider();
    } catch (_error) {
      return { acquired: false, code: 'root_context_unavailable' };
    }
    if (coordinator && typeof coordinator.acquireOperation === 'function') {
      const lease = coordinator.acquireOperation({
        kind: kind === 'mutation' ? 'mutation' : 'read',
        cancellable: kind !== 'mutation',
      });
      if (lease?.acquired !== true) {
        return { acquired: false, code: lease?.code || 'root_transitioning' };
      }
      const root = normalizeRoot(lease.context?.rootPath);
      if (!root) {
        lease.release();
        return { acquired: false, code: 'no_root' };
      }
      const combined = linkedSignal(signal, lease.signal);
      let released = false;
      return {
        acquired: true,
        root,
        context: lease.context,
        signal: combined.signal,
        isCurrent: () => !released && lease.isCurrent(),
        release: () => {
          if (released) return false;
          released = true;
          combined.dispose();
          lease.release();
          return true;
        },
      };
    }

    const root = normalizeRoot(this._rootProvider());
    if (!root) return { acquired: false, code: 'no_root' };
    let released = false;
    return {
      acquired: true,
      root,
      context: { rootPath: root, rootId: workspaceRootId(root), generation: 0, phase: 'ready' },
      signal,
      isCurrent: () => !released && normalizeRoot(this._rootProvider()) === root,
      release: () => {
        if (released) return false;
        released = true;
        return true;
      },
    };
  }

  async runSerialized(rootKey, callback) {
    const key = String(rootKey || 'root');
    const previous = this._writeTails.get(key) || Promise.resolve();
    let releaseTail;
    const tail = new Promise((resolve) => { releaseTail = resolve; });
    this._writeTails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await callback();
    } finally {
      releaseTail();
      if (this._writeTails.get(key) === tail) this._writeTails.delete(key);
    }
  }
}

module.exports = {
  WorkspaceGitOperationContext,
  clampInt,
  linkedSignal,
  normalizePathList,
};
