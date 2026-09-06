'use strict';

const { safeEmitLog } = require('./backend/session-store-logging');
const {
  normalizeWorkspaceIdeStore,
  touchWorkspaceIdeRoot,
  updateWorkspaceIdeStore,
  workspaceIdeStateForRoot,
} = require('./workspace-ide-config-schema');

function statesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reportRuntimeEvictions(service, evictedRootIds) {
  const evicted = Array.isArray(evictedRootIds) ? evictedRootIds.length : 0;
  if (evicted > 0) {
    safeEmitLog(service._logger, 'WARN', 'workspace_ide.root_lru_evicted', { evicted });
  }
  return evicted;
}

const workspaceIdeMethods = {
  getWorkspaceIdeState(rootId = '') {
    return workspaceIdeStateForRoot(this.state.workspaceIde, rootId);
  },

  getWorkspaceIdeStore() {
    return normalizeWorkspaceIdeStore(this.state.workspaceIde);
  },

  updateWorkspaceIdePreferences(patch = {}) {
    return this._applyWorkspaceIdeStore('', patch, { preferencesOnly: true }).state;
  },

  tryUpdateWorkspaceIdePreferences(patch = {}) {
    return this._applyWorkspaceIdeStore('', patch, { preferencesOnly: true });
  },

  updateWorkspaceIdeState(rootId, patch = {}) {
    return this._applyWorkspaceIdeStore(rootId, patch, { preferencesOnly: false }).state;
  },

  tryUpdateWorkspaceIdeState(rootId, patch = {}) {
    return this._applyWorkspaceIdeStore(rootId, patch, { preferencesOnly: false });
  },

  touchWorkspaceIdeRoot(rootId) {
    const outcome = touchWorkspaceIdeRoot(this.state.workspaceIde, rootId, { includeEvictions: true });
    const nextStore = outcome.store;
    let evictedRootCount = 0;
    if (!statesEqual(nextStore, this.state.workspaceIde) && !this._shouldBlockConfigWrite()) {
      this._commitWorkspaceIdeStore(nextStore, 'workspace_ide_root_touched');
      evictedRootCount = reportRuntimeEvictions(this, outcome.evictedRootIds);
    }
    const state = this.getWorkspaceIdeState(rootId);
    return evictedRootCount > 0 ? { ...state, evictedRootCount } : state;
  },

  _applyWorkspaceIdeStore(rootId, patch, options) {
    if (this._shouldBlockConfigWrite()) {
      return {
        updated: false,
        changed: false,
        blocked: true,
        code: 'config_write_blocked',
        state: this.getWorkspaceIdeState(rootId),
      };
    }
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const outcome = updateWorkspaceIdeStore(
      this.state.workspaceIde, rootId, source, { ...options, includeEvictions: true }
    );
    const nextStore = outcome.store;
    const changed = !statesEqual(nextStore, this.state.workspaceIde);
    if (options?.preferencesOnly && (changed || this._workspaceWriteDirty)) {
      try {
        this._commitWorkspaceIdePreferences(nextStore, 'workspace_ide_preferences_updated');
      } catch (error) {
        const code = error?.code === 'config_write_blocked'
          ? 'config_write_blocked'
          : 'config_write_failed';
        return {
          updated: false,
          changed: false,
          blocked: code === 'config_write_blocked',
          code,
          state: this.getWorkspaceIdeState(rootId),
        };
      }
    } else if (changed) {
      this._commitWorkspaceIdeStore(nextStore, 'workspace_ide_state_updated');
      reportRuntimeEvictions(this, outcome.evictedRootIds);
    }
    return {
      updated: true,
      changed,
      blocked: false,
      state: this.getWorkspaceIdeState(rootId),
    };
  },

  _commitWorkspaceIdeStore(nextStore, reason) {
    this.state = { ...this.state, workspaceIde: nextStore };
    this._workspaceWriteDirty = true;
    this._scheduleWorkspaceWrite();
    this.emit('changed', this.getState(), { reason });
  },

  _commitWorkspaceIdePreferences(nextStore, reason) {
    const normalized = this._normalizeState({ ...this.state, workspaceIde: nextStore });
    if (!this._persistState(normalized, 'shell_config.workspace_ide_preferences_write_failed')) {
      const error = new Error('Workspace IDE preferences could not be persisted.');
      error.code = 'config_write_blocked';
      throw error;
    }
    this._clearPendingWorkspaceTimer();
    this._workspaceWriteRetryCount = 0;
    this.state = normalized;
    this.emit('changed', this.getState(), { reason });
  },
};

module.exports = { workspaceIdeMethods };
