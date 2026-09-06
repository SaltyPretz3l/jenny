const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { normalizeString } = require('../renderer/shared/string-utils');
const { redactLogValue } = require('./log-entry-normalizer');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('./scheduler-schema-version');
const {
  normalizeAutomationRuns,
  normalizeScheduledTasks,
} = require('./scheduler-task-registry');
const {
  buildAutomationRunId,
  dispatchAutomationTask,
  hasActiveAutomationRun,
  reconcileAutomationRuns,
} = require('./scheduler-automation-runtime');
const { buildSchedulerSnapshot } = require('./scheduler-snapshot');
const { isWorkspaceRootChangeReason } = require('./workspace-root-change-reasons');
const {
  defaultIsProcessAlive,
  resolveBackgroundRuntimeRoot,
  resolveScheduledTasksPath,
  parseIsoMs,
  isTerminalAutomationStatus,
  getScheduledTasksVersion,
  hasNewerScheduledTasksVersion,
  readScheduledTasksJsonPayload,
  safeLogScheduledTasksVersion,
  readScheduledTasksFile,
  readScheduledTasksFileAsync,
  writeScheduledTasksFile,
} = require('./scheduler-tasks-store');

// The scheduler also watches the tasks file (see _reconcileScheduledTasksLocation),
// so edits are picked up promptly without a tight poll. A 1s poll caused constant
// synchronous lock-file create/delete + JSON rewrite churn every second (amplified
// by Defender real-time scanning), contributing to post-startup system lag. 5s is
// plenty for the belt-and-suspenders interval; due tasks still fire within it.
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_WATCH_DEBOUNCE_MS = 300;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_RETRY_MS = 100;
const DEFAULT_LOCK_STALE_MS = 15000;

function sanitizeLifecycleError(error) {
  const bounded = normalizeString(error?.message || error).slice(0, 240);
  const redacted = normalizeString(redactLogValue(bounded));
  return redacted
    .replace(/\[redacted:path\](?:[\\/][^\s"'`<>|]+)*/g, '[redacted]')
    .slice(0, 240);
}

class SchedulerService extends EventEmitter {
  constructor({
    userDataPath,
    configService,
    backendService,
    backgroundRuntimeRoot,
    logger,
    fsImpl,
    watchImpl,
    nowProvider,
    setIntervalImpl,
    clearIntervalImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
    isProcessAliveImpl,
    pollIntervalMs,
    watchDebounceMs,
    lockTimeoutMs,
    lockRetryMs,
    lockStaleMs,
  } = {}) {
    super();
    if (!userDataPath) {
      throw new Error('userDataPath is required for SchedulerService.');
    }
    if (!configService) {
      throw new Error('configService is required for SchedulerService.');
    }
    if (!backendService) {
      throw new Error('backendService is required for SchedulerService.');
    }

    this.userDataPath = userDataPath;
    this.configService = configService;
    this.backendService = backendService;
    this.backgroundRuntimeRoot = normalizeString(backgroundRuntimeRoot)
      || resolveBackgroundRuntimeRoot(userDataPath);
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.fs = fsImpl || fs;
    this.watchImpl = typeof watchImpl === 'function' ? watchImpl : fs.watch.bind(fs);
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.setIntervalImpl = typeof setIntervalImpl === 'function' ? setIntervalImpl : setInterval;
    this.clearIntervalImpl = typeof clearIntervalImpl === 'function' ? clearIntervalImpl : clearInterval;
    this.setTimeoutImpl = typeof setTimeoutImpl === 'function' ? setTimeoutImpl : setTimeout;
    this.clearTimeoutImpl = typeof clearTimeoutImpl === 'function' ? clearTimeoutImpl : clearTimeout;
    this.isProcessAliveImpl = typeof isProcessAliveImpl === 'function'
      ? isProcessAliveImpl
      : defaultIsProcessAlive;
    this.pollIntervalMs = Math.max(Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS, 100);
    this.watchDebounceMs = Math.max(Number(watchDebounceMs) || DEFAULT_WATCH_DEBOUNCE_MS, 50);
    this.lockTimeoutMs = Math.max(Number(lockTimeoutMs) || DEFAULT_LOCK_TIMEOUT_MS, 100);
    this.lockRetryMs = Math.max(Number(lockRetryMs) || DEFAULT_LOCK_RETRY_MS, 25);
    this.lockStaleMs = Math.max(Number(lockStaleMs) || DEFAULT_LOCK_STALE_MS, 1000);

    this.started = false;
    this._initialized = false;
    this._lifecycleGeneration = 0;
    this._lifecycle = {
      phase: 'stopped',
      relevant: false,
      qualifyingTaskCount: 0,
      reason: '',
      error: '',
      updatedAt: '',
    };
    this._pollTimer = null;
    this._watcher = null;
    this._watcherNeedsRebuild = false;
    this._watchDebounceTimer = null;
    this._tasksPath = '';
    this._tickPromise = null;
    this._lifecyclePromise = null;
    this._tickQueued = false;
    this._ignoreWatchEventsUntilMs = 0;
    this._lastNewerTasksWarningKey = '';
    this._lastSnapshotEmitKey = '';
    this._handleConfigChanged = this._handleConfigChanged.bind(this);
  }

  start() {
    if (this._initialized) {
      return this._lifecyclePromise || Promise.resolve(this.started);
    }
    this._initialized = true;
    this._lifecycleGeneration += 1;
    this.configService.on('changed', this._handleConfigChanged);
    try {
      this._reconcileScheduledTasksLocation();
    } catch (_error) {
      // _reconcileLifecycle owns the structured failure status and logging.
    }
    return this._requestLifecycleReconcile('startup');
  }

  _isLifecycleCurrent(generation) {
    return this._initialized && generation === this._lifecycleGeneration;
  }

  _startRuntime(reason, generation = this._lifecycleGeneration) {
    if (!this._isLifecycleCurrent(generation)) return Promise.resolve(false);
    if (this.started) return this._tickPromise || Promise.resolve(true);
    this.started = true;
    this._setLifecycle('running', { relevant: true, reason });
    this._pollTimer = this.setIntervalImpl(() => {
      void this.runTick('poll');
    }, this.pollIntervalMs);
    if (typeof this._pollTimer?.unref === 'function') {
      this._pollTimer.unref();
    }
    return this.runTick(reason);
  }

  _stopRuntime(reason) {
    this.started = false;
    if (this._pollTimer) {
      this.clearIntervalImpl(this._pollTimer);
      this._pollTimer = null;
    }
    this._tickQueued = false;
    this._setLifecycle('idle', { relevant: false, qualifyingTaskCount: 0, reason });
  }

  stop() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    this._lifecycleGeneration += 1;
    this._stopRuntime('shutdown');
    if (typeof this.configService.off === 'function') {
      this.configService.off('changed', this._handleConfigChanged);
    } else if (typeof this.configService.removeListener === 'function') {
      this.configService.removeListener('changed', this._handleConfigChanged);
    }
    if (this._watchDebounceTimer) {
      this.clearTimeoutImpl(this._watchDebounceTimer);
      this._watchDebounceTimer = null;
    }
    if (this._watcher && typeof this._watcher.close === 'function') {
      // Safe even if the watched directory was deleted while watched: close()
      // on such a zombie returns immediately and is the only thing that stops
      // its runaway event spew (see _isZombieWatchEvent). Never guard this
      // close behind an existence check of the watched directory.
      this._watcher.close();
    }
    this._watcher = null;
    // A later start() must reinstall the watcher even though the tasks path
    // is unchanged; without this, reconcile early-returns and a restarted
    // service would silently run poll-only.
    this._watcherNeedsRebuild = true;
    this._setLifecycle('stopped', { relevant: false, qualifyingTaskCount: 0, reason: 'shutdown' });
  }

  async runTick(reason = 'poll') {
    const generation = this._lifecycleGeneration;
    if (!this.started) {
      if (this._initialized) return this._reconcileLifecycle(reason, generation);
      return;
    }
    if (this._tickPromise) {
      this._tickQueued = true;
      return this._tickPromise;
    }
    this._tickPromise = this._runTick(reason, generation)
      .catch((error) => {
        this.logger('WARN', 'scheduler.tick_failed', {
          reason: normalizeString(reason),
          message: String(error?.message || error),
          code: normalizeString(error?.code),
        });
        return false;
      })
      .finally(async () => {
        this._tickPromise = null;
        this._emitSchedulerChangedSafely();
        if (this._tickQueued && this.started && this._initialized) {
          this._tickQueued = false;
          await this.runTick('queued');
        }
      });
    return this._tickPromise;
  }

  // Snapshot for the scheduler:get-state IPC bridge (Home dashboard widget).
  // Reads the tasks file on demand; the derivation lives in scheduler-snapshot.js.
  getStateSnapshot() {
    // Side-effect-free path resolution: _reconcileScheduledTasksLocation also
    // installs the tasks-file watcher, and a snapshot read must never do that
    // (a get-state on a never-started service would leave an unclosed watcher;
    // if its directory is later deleted, libuv's fs-event close handshake can
    // deadlock the whole process on Windows).
    const tasksPath = this._tasksPath || resolveScheduledTasksPath({
      workspaceRoot: this._resolveWorkspaceRoot(),
      userDataPath: this.userDataPath,
      backgroundRuntimeRoot: this.backgroundRuntimeRoot,
    });
    if (!tasksPath) {
      return { ...buildSchedulerSnapshot([], this.nowProvider()), relevant: false, lifecycle: { ...this._lifecycle } };
    }
    const payload = readScheduledTasksFile(tasksPath, {
      fsImpl: this.fs,
      logger: this.logger,
      nowProvider: this.nowProvider,
    });
    const qualifyingTaskCount = this._getQualifyingTasks(payload.tasks).length;
    const relevant = qualifyingTaskCount > 0 || this._lifecycle.phase === 'failed';
    return {
      ...buildSchedulerSnapshot(payload.tasks, this.nowProvider()),
      relevant,
      lifecycle: { ...this._lifecycle, qualifyingTaskCount },
    };
  }

  // Pushed on the existing tick cadence (no extra timer); deduped on the
  // upcoming/running content so idle polls do not spam the bridge.
  _emitSchedulerChangedSafely() {
    let snapshot;
    try {
      snapshot = this.getStateSnapshot();
    } catch (error) {
      this.logger('WARN', 'scheduler.snapshot_failed', {
        message: String(error?.message || error),
      });
      return;
    }
    const emitKey = JSON.stringify([snapshot.upcoming, snapshot.running, snapshot.relevant, snapshot.lifecycle]);
    if (emitKey === this._lastSnapshotEmitKey) {
      return;
    }
    this._lastSnapshotEmitKey = emitKey;
    this.emit('changed', snapshot);
  }

  async _runTick(reason, generation = this._lifecycleGeneration) {
    if (!this._isLifecycleCurrent(generation)) return false;
    const tasksPath = this._reconcileScheduledTasksLocation();
    if (!tasksPath) {
      return;
    }
    if (!await this._ensureTaskFile(tasksPath)) {
      return;
    }
    if (!this._isLifecycleCurrent(generation)) return false;
    let taskPayload = readScheduledTasksFile(tasksPath, {
      fsImpl: this.fs,
      logger: this.logger,
      nowProvider: this.nowProvider,
    });
    if (await reconcileAutomationRuns(this, tasksPath, taskPayload.tasks)) {
      if (!this._isLifecycleCurrent(generation)) return false;
      taskPayload = readScheduledTasksFile(tasksPath, {
        fsImpl: this.fs,
        logger: this.logger,
        nowProvider: this.nowProvider,
      });
    }
    if (!this._isBackendReady()) {
      return;
    }
    for (const task of taskPayload.tasks) {
      if (!this._isLifecycleCurrent(generation)) return false;
      await this._runScheduledTask(tasksPath, task, { reason, generation });
    }
    return true;
  }

  async _runScheduledTask(tasksPath, task, { reason, generation } = {}) {
    if (generation !== undefined && !this._isLifecycleCurrent(generation)) return;
    if (!task || task.enabled === false || !this._isTaskDue(task)) {
      return;
    }
    const taskId = normalizeString(task.id);
    const taskName = normalizeString(task.task).toLowerCase();
    const policy = task.policy && typeof task.policy === 'object' && !Array.isArray(task.policy)
      ? task.policy
      : {};
    const requiredFlags = Array.isArray(policy.requires_feature_flags)
      ? policy.requires_feature_flags.map((flag) => normalizeString(flag).toLowerCase()).filter(Boolean)
      : [];
    const missingFlag = requiredFlags.find((flag) => this.backendService.featureFlags?.[flag] !== true);
    if (missingFlag) {
      await this._safeRecordTaskResult(tasksPath, {
        status: 'skipped',
        task: taskName,
        reason: 'feature_disabled',
      }, taskId, { reason, taskName });
      return;
    }
    if (policy.defer_when_chat_active === true && this._hasActiveChatStreams()) {
      const result = {
        status: 'skipped',
        task: taskName,
        reason: 'active_chat_stream',
      };
      await this._safeRecordTaskResult(tasksPath, result, taskId, { reason, taskName });
      this._logTaskResult(reason, task, result);
      return;
    }
    if (task.kind === 'automation') {
      if (hasActiveAutomationRun(task)) {
        return;
      }
      const result = await dispatchAutomationTask(this, tasksPath, task);
      this._logTaskResult(reason, task, result);
      return;
    }
    this.logger('WARN', 'scheduler.task_kind_rejected', {
      reason,
      taskId,
      task: taskName,
      kind: normalizeString(task.kind),
    });
  }

  _isTaskDue(task) {
    const intervalSeconds = Number(task?.trigger?.interval_seconds || 1);
    const intervalMs = Math.max(Number.isFinite(intervalSeconds) ? intervalSeconds : 1, 1) * 1000;
    const lastRunMs = Math.max(
      parseIsoMs(task?.last_result_at),
      parseIsoMs(task?.last_started_at),
      parseIsoMs(task?.last_completed_at)
    );
    return lastRunMs <= 0 || (this.nowProvider().getTime() - lastRunMs) >= intervalMs;
  }

  async _runBackgroundTask(taskName, params) {
    if (typeof this.backendService.runBackgroundTask === 'function') {
      return this.backendService.runBackgroundTask(taskName, params);
    }
    return {
      status: 'skipped',
      task: taskName,
      reason: 'runner_unavailable',
    };
  }

  _logTaskResult(reason, task, result = {}) {
    const status = normalizeString(result.status);
    const detail = normalizeString(result.reason);
    const payload = {
      reason,
      taskId: normalizeString(task.id),
      task: normalizeString(task.task).toLowerCase(),
      status,
      detail,
    };
    this.logger('INFO', 'scheduler.task_result', payload);
  }

  _handleConfigChanged(_state, context = {}) {
    const reason = normalizeString(context.reason);
    if (
      !reason
      || isWorkspaceRootChangeReason(reason)
    ) {
      this._reconcileScheduledTasksLocation();
      this._scheduleLifecycleReconcile('config');
    }
  }

  _resolveWorkspaceRoot() {
    return normalizeString(this.configService.getState?.()?.toolsWorkspaceRoot);
  }

  _getQualifyingTasks(tasks) {
    return (Array.isArray(tasks) ? tasks : []).filter((task) => (
      task?.enabled !== false && task?.kind === 'automation'
    ));
  }

  _setLifecycle(phase, patch = {}) {
    this._lifecycle = {
      ...this._lifecycle,
      ...patch,
      phase: normalizeString(phase) || 'failed',
      error: normalizeString(patch.error),
      updatedAt: this.nowProvider().toISOString(),
    };
  }

  _requestLifecycleReconcile(reason) {
    const generation = this._lifecycleGeneration;
    const prior = this._lifecyclePromise || Promise.resolve();
    const pending = prior.then(() => this._reconcileLifecycle(reason, generation));
    const tracked = pending.finally(() => {
      if (this._lifecyclePromise === tracked) this._lifecyclePromise = null;
    });
    this._lifecyclePromise = tracked;
    return tracked;
  }

  async _reconcileLifecycle(reason, generation = this._lifecycleGeneration) {
    if (!this._isLifecycleCurrent(generation)) return false;
    this._setLifecycle('starting', { reason, error: '' });
    try {
      const tasksPath = this._reconcileScheduledTasksLocation();
      const taskFileExists = Boolean(tasksPath && this.fs.existsSync(tasksPath));
      const existingPayload = taskFileExists
        ? readScheduledTasksJsonPayload(tasksPath, { fsImpl: this.fs })
        : null;
      if (taskFileExists && (!existingPayload || typeof existingPayload !== 'object' || Array.isArray(existingPayload))) {
        throw new Error('Scheduled task state is malformed or unreadable.');
      }
      if (hasNewerScheduledTasksVersion(existingPayload)) {
        throw new Error(
          `Scheduled task schema ${getScheduledTasksVersion(existingPayload)} is newer than this Jenny build.`
        );
      }
      if (tasksPath && !await this._ensureTaskFile(tasksPath)) {
        throw new Error('Scheduled task state could not be reconciled.');
      }
      if (!this._isLifecycleCurrent(generation)) return false;
      const rawPayload = tasksPath
        ? readScheduledTasksJsonPayload(tasksPath, { fsImpl: this.fs })
        : { tasks: [] };
      if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
        throw new Error('Scheduled task state is malformed or unreadable.');
      }
      const payload = tasksPath ? readScheduledTasksFile(tasksPath, {
        fsImpl: this.fs,
        logger: this.logger,
        nowProvider: this.nowProvider,
      }) : { tasks: [] };
      const qualifyingTasks = this._getQualifyingTasks(payload.tasks);
      if (!this._isLifecycleCurrent(generation)) return false;
      if (!qualifyingTasks.length) {
        this._stopRuntime(reason || 'no_enabled_tasks');
        this._emitSchedulerChangedSafely();
        return false;
      }
      this._setLifecycle('running', {
        relevant: true,
        qualifyingTaskCount: qualifyingTasks.length,
        reason,
        error: '',
      });
      if (!this.started) await this._startRuntime(reason || 'task_state', generation);
      else await this.runTick(reason || 'task_state');
      return this._isLifecycleCurrent(generation);
    } catch (error) {
      if (!this._isLifecycleCurrent(generation)) return false;
      this._stopRuntime(reason || 'reconcile_failed');
      this._setLifecycle('failed', {
        relevant: true,
        reason,
        error: sanitizeLifecycleError(error),
      });
      this.logger('WARN', 'scheduler.lifecycle_reconcile_failed', {
        reason: normalizeString(reason),
        message: String(error?.message || error),
        code: normalizeString(error?.code),
      });
      this._emitSchedulerChangedSafely();
      return false;
    }
  }

  _isBackendReady() {
    return normalizeString(this.backendService.getBackendStatus?.()?.phase).toLowerCase() === 'ready';
  }

  _hasActiveChatStreams() {
    const activeStreams = this.backendService?.activeStreams;
    if (!activeStreams || typeof activeStreams !== 'object') {
      return false;
    }
    if (typeof activeStreams.size === 'number') {
      return activeStreams.size > 0;
    }
    if (Array.isArray(activeStreams)) {
      return activeStreams.length > 0;
    }
    return Object.keys(activeStreams).length > 0;
  }

  _reconcileScheduledTasksLocation() {
    const nextTasksPath = resolveScheduledTasksPath({
      workspaceRoot: this._resolveWorkspaceRoot(),
      userDataPath: this.userDataPath,
      backgroundRuntimeRoot: this.backgroundRuntimeRoot,
    });
    if (nextTasksPath === this._tasksPath && !this._watcherNeedsRebuild) {
      return nextTasksPath;
    }
    this._watcherNeedsRebuild = false;
    this._tasksPath = nextTasksPath;
    if (this._watcher && typeof this._watcher.close === 'function') {
      // Unconditional close is correct even when the watched directory no
      // longer exists — see the hazard note on _isZombieWatchEvent.
      this._watcher.close();
    }
    this._watcher = null;

    const watchDirectory = path.dirname(nextTasksPath);
    this.fs.mkdirSync(watchDirectory, { recursive: true });
    try {
      this._watcher = this.watchImpl(watchDirectory, (_eventType, filename) => {
        // Zombie detection must run before every other filter: the spew
        // events carry a full path, so _shouldIgnoreWatchEvent would swallow
        // them (and the self-write ignore window would too) while the
        // process keeps burning CPU on the callback itself.
        if (this._isZombieWatchEvent(filename)) {
          this._disposeZombieWatcher(watchDirectory);
          return;
        }
        if (this._shouldIgnoreWatchEvent(nextTasksPath, filename)) {
          return;
        }
        this._scheduleLifecycleReconcile('watch');
      });
      // Same posture as the poll timer: the watcher must never pin the event
      // loop. getStateSnapshot() reconciles the tasks location on demand, so
      // a snapshot read on a never-started service (where stop() no-ops)
      // would otherwise leave a live FSWatcher holding the process open.
      if (typeof this._watcher.unref === 'function') {
        this._watcher.unref();
      }
      if (typeof this._watcher.on === 'function') {
        const failedWatcher = this._watcher;
        this._watcher.on('error', (error) => {
          try { failedWatcher.close?.(); } finally {
            if (this._watcher === failedWatcher) {
              this._watcher = null;
              this._watcherNeedsRebuild = true;
            }
          }
          this.logger('WARN', 'scheduler.watch_error', {
            message: String(error?.message || error),
            tasksPath: nextTasksPath,
          });
        });
      }
    } catch (error) {
      this.logger('WARN', 'scheduler.watch_unavailable', {
        message: String(error?.message || error),
        tasksPath: nextTasksPath,
      });
      this._watcher = null;
      this._watcherNeedsRebuild = true;
    }
    return nextTasksPath;
  }

  _scheduleLifecycleReconcile(reason) {
    if (!this._initialized) return;
    if (this._watchDebounceTimer) {
      this.clearTimeoutImpl(this._watchDebounceTimer);
    }
    this._watchDebounceTimer = this.setTimeoutImpl(() => {
      this._watchDebounceTimer = null;
      if (!this._initialized) return;
      void this._requestLifecycleReconcile(reason);
    }, this.watchDebounceMs);
    if (typeof this._watchDebounceTimer?.unref === 'function') {
      this._watchDebounceTimer.unref();
    }
  }

  // Windows fs.watch hazard (measured on node v24.16.0 / Windows 11 26200,
  // 2026-06-11; closest upstream report is nodejs/node#61398): deleting the
  // watched directory out from under an open FSWatcher emits NO error event
  // — instead the watcher spews endless 'rename' events (~200k/s observed,
  // pegging a core at 100%) whose filename is the FULL watched path. A healthy non-recursive watcher only
  // ever reports bare basenames, so a path separator in the filename is the
  // zombie signature. Deliberate non-checks, verified standalone:
  // - close() on the zombie returns instantly and stops the spew (it does
  //   NOT deadlock; the "fs-event close handshake deadlock" recorded around
  //   commit 913377c was a misdiagnosis of this spew/leak pinning the loop),
  //   so close sites must stay unconditional — an existence guard would leak
  //   the spewing handle instead.
  // - fs.existsSync(watchDirectory) is no confirmation: the path may already
  //   have been recreated (e.g. by _ensureTaskFile) while the zombie still
  //   watches the deleted inode.
  _isZombieWatchEvent(filename) {
    const name = normalizeString(filename);
    return name.includes('\\') || name.includes('/');
  }

  _disposeZombieWatcher(watchDirectory) {
    if (!this._watcher) {
      return;
    }
    try {
      if (typeof this._watcher.close === 'function') {
        this._watcher.close();
      }
    } catch (error) {
      this.logger('WARN', 'scheduler.watch_zombie_close_failed', {
        message: String(error?.message || error),
        watchDirectory,
      });
    }
    this._watcher = null;
    // The next runTick reconcile (poll cadence, <=5s) recreates the
    // directory and installs a fresh watcher; until then the poll loop
    // still picks up task changes.
    this._watcherNeedsRebuild = true;
    this.logger('WARN', 'scheduler.watch_zombie_disposed', {
      watchDirectory,
      tasksPath: this._tasksPath,
    });
    this._scheduleLifecycleReconcile('watch_rebuild');
  }

  _shouldIgnoreWatchEvent(tasksPath, filename) {
    if (Date.now() < this._ignoreWatchEventsUntilMs) {
      return true;
    }
    const normalizedFilename = normalizeString(filename);
    if (!normalizedFilename) {
      return false;
    }
    return normalizedFilename !== path.basename(tasksPath);
  }

  _logNewerScheduledTasksVersion(event, tasksPath, observedVersion) {
    safeLogScheduledTasksVersion(this.logger, event, tasksPath, observedVersion);
  }

  _shouldBlockScheduledTasksWrite(tasksPath, payload) {
    if (!hasNewerScheduledTasksVersion(payload)) {
      this._lastNewerTasksWarningKey = '';
      return false;
    }
    const observedVersion = getScheduledTasksVersion(payload);
    const warningKey = `${tasksPath}:${observedVersion}`;
    if (warningKey === this._lastNewerTasksWarningKey) {
      return true;
    }
    this._lastNewerTasksWarningKey = warningKey;
    this._logNewerScheduledTasksVersion(
      'scheduler.tasks_newer_schema_detected',
      tasksPath,
      observedVersion
    );
    this._logNewerScheduledTasksVersion(
      'scheduler.tasks_newer_schema_write_blocked',
      tasksPath,
      observedVersion
    );
    return true;
  }

  async _ensureTaskFile(tasksPath) {
    // Fast path: if the tasks file already exists and is fully normalized there
    // is nothing to write, so skip acquiring the lock (avoiding the per-tick
    // lock-file create/delete churn). Newer-schema payloads fall through to the
    // locked path so the existing block/warn logic still runs.
    const existing = readScheduledTasksJsonPayload(tasksPath, { fsImpl: this.fs });
    if (
      existing
      && !hasNewerScheduledTasksVersion(existing)
      && JSON.stringify(normalizeScheduledTasks(existing, this.nowProvider())) === JSON.stringify(existing)
    ) {
      return true;
    }
    return this._withTaskFileLock(tasksPath, async () => {
      const existingPayload = readScheduledTasksJsonPayload(tasksPath, { fsImpl: this.fs });
      if (this._shouldBlockScheduledTasksWrite(tasksPath, existingPayload)) {
        return false;
      }
      const normalizedPayload = normalizeScheduledTasks(existingPayload, this.nowProvider());
      if (
        existingPayload
        && JSON.stringify(normalizedPayload) === JSON.stringify(existingPayload)
      ) {
        return true;
      }
      this._markSelfWriteWindow();
      writeScheduledTasksFile(tasksPath, normalizedPayload, { fsImpl: this.fs });
      return true;
    });
  }

  async _recordTaskResult(tasksPath, result = {}, taskId = '') {
    return this._withTaskFileLock(tasksPath, async () => {
      const rawPayload = readScheduledTasksJsonPayload(tasksPath, { fsImpl: this.fs });
      if (this._shouldBlockScheduledTasksWrite(tasksPath, rawPayload)) {
        return false;
      }
      const payload = normalizeScheduledTasks(rawPayload, this.nowProvider());
      const resolvedTaskId = normalizeString(taskId)
        || normalizeString(result.task_id);
      const task = payload.tasks.find((entry) => entry.id === resolvedTaskId);
      if (!task) {
        return true;
      }
      const nowIso = this.nowProvider().toISOString();
      const status = normalizeString(result.status).toLowerCase() || 'skipped';
      const patch = {
        last_status: status,
        last_reason: normalizeString(result.reason),
        last_result_at: nowIso,
      };
      if (status === 'started') {
        patch.last_started_at = nowIso;
      } else if (status === 'completed') {
        patch.last_completed_at = nowIso;
      }
      const scalarChanged = this._applyTaskPatch(task, patch);
      const automationRunsChanged = this._recordAutomationRun(task, result, {
        nowIso,
        status,
        taskId: resolvedTaskId,
      });
      if (!scalarChanged && !automationRunsChanged) {
        return true;
      }
      task.updated_at = nowIso;
      this._markSelfWriteWindow();
      writeScheduledTasksFile(tasksPath, payload, { fsImpl: this.fs });
      return true;
    });
  }

  async _safeRecordTaskResult(tasksPath, result = {}, taskId = '', context = {}) {
    try {
      return await this._recordTaskResult(tasksPath, result, taskId);
    } catch (error) {
      this.logger('WARN', 'scheduler.task_result_persist_failed', {
        reason: normalizeString(context.reason),
        taskId: normalizeString(taskId)
          || normalizeString(result.task_id),
        task: normalizeString(context.taskName || result.task).toLowerCase(),
        status: normalizeString(result.status).toLowerCase(),
        message: String(error?.message || error),
        code: normalizeString(error?.code),
      });
      return false;
    }
  }

  _recordAutomationRun(task, result, { nowIso, status, taskId }) {
    if (task?.kind !== 'automation') {
      return false;
    }
    const runId = normalizeString(result.run_id)
      || normalizeString(result.automation_run_id)
      || this._deriveAutomationRunId(taskId, result, nowIso);
    const previousRuns = Array.isArray(task.automation_runs) ? task.automation_runs : [];
    const nextRun = {
      run_id: runId,
      status,
      reason: normalizeString(result.reason),
      started_at: normalizeString(result.started_at)
        || (status === 'started' ? nowIso : normalizeString(task.last_started_at)),
      completed_at: normalizeString(result.completed_at)
        || (isTerminalAutomationStatus(status) ? nowIso : ''),
      summary: normalizeString(result.summary),
      budget: result.budget,
      artifacts: result.artifacts,
      result_ref: normalizeString(result.result_ref),
    };
    const nextRuns = previousRuns.filter((entry) => normalizeString(entry?.run_id) !== runId);
    nextRuns.push(nextRun);
    const retentionMaxRuns = Number(task.retention?.max_runs);
    const normalizedRuns = normalizeAutomationRuns(
      nextRuns,
      Number.isFinite(retentionMaxRuns) ? retentionMaxRuns : undefined
    );
    const changed = JSON.stringify(previousRuns) !== JSON.stringify(normalizedRuns);
    if (changed) {
      task.automation_runs = normalizedRuns;
    }
    return changed;
  }

  _deriveAutomationRunId(taskId, result, nowIso) {
    return buildAutomationRunId({
      taskId: `${normalizeString(taskId)}:${normalizeString(result.task)}`,
      startedAt: nowIso,
    });
  }

  _applyTaskPatch(task, patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      const normalizedValue = value == null ? '' : value;
      if (task[key] === normalizedValue) {
        continue;
      }
      task[key] = normalizedValue;
      changed = true;
    }
    return changed;
  }

  async _withTaskFileLock(tasksPath, work) {
    const lockPath = `${tasksPath}.lock`;
    const owner = {
      pid: process.pid,
      token: `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`,
      acquired_at: this.nowProvider().toISOString(),
    };
    const acquired = await this._acquireLock(lockPath, owner);
    if (!acquired) {
      this.logger('WARN', 'scheduler.lock_timeout', {
        tasksPath,
      });
      return false;
    }
    try {
      const result = await work();
      return typeof result === 'boolean' ? result : true;
    } finally {
      this._releaseLock(lockPath, owner.token);
    }
  }

  _markSelfWriteWindow() {
    this._ignoreWatchEventsUntilMs = Date.now() + this.watchDebounceMs + 25;
  }

  async _acquireLock(lockPath, owner) {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() <= deadline) {
      try {
        this.fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        this.fs.writeFileSync(lockPath, JSON.stringify(owner, null, 2), {
          encoding: 'utf8',
          flag: 'wx',
        });
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
        if (this._recoverStaleLock(lockPath)) {
          continue;
        }
        await this._wait(this.lockRetryMs);
      }
    }
    return false;
  }

  _recoverStaleLock(lockPath) {
    let raw;
    try {
      raw = this.fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
      // Already gone — another worker reclaimed it between our EEXIST and here.
      return error?.code === 'ENOENT';
    }
    let payload = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed;
      }
    } catch (_parseError) {
      payload = null;
    }
    if (!payload) {
      // Corrupt or empty lock contents — typically a torn write left behind
      // when a previous run was hard-killed mid-write (e.g. an NTFS file whose
      // metadata committed but whose data blocks did not, leaving whitespace).
      // Such a lock can never name a live owner, so the pid/age checks below
      // would never fire and the scheduler would retry this lock forever.
      // Reclaim it once it has sat unchanged for the stale window.
      return this._reclaimCorruptLock(lockPath);
    }
    const ownerPid = Number(payload?.pid || 0);
    const acquiredAtMs = parseIsoMs(payload?.acquired_at);
    const staleByPid = ownerPid > 0 && !this.isProcessAliveImpl(ownerPid);
    const staleByAge = acquiredAtMs > 0 && (Date.now() - acquiredAtMs) >= this.lockStaleMs;
    if (!staleByPid && !staleByAge) {
      return false;
    }
    try {
      this.fs.unlinkSync(lockPath);
      this.logger('INFO', 'scheduler.lock_recovered', {
        lockPath,
        ownerPid,
        staleByPid,
        staleByAge,
      });
      return true;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }

  _reclaimCorruptLock(lockPath) {
    // Use the file's mtime as the age signal (a corrupt lock has no parseable
    // acquired_at). Mirror staleByAge's threshold so we never nuke a lock that
    // a peer is still mid-creating — only one that has been corrupt and idle
    // for the full stale window.
    let ageMs = Infinity;
    try {
      const mtimeMs = Number(this.fs.statSync(lockPath)?.mtimeMs);
      if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
        ageMs = Date.now() - mtimeMs;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return true;
      }
      // Readable but un-stat-able: fall through and reclaim defensively.
    }
    if (ageMs < this.lockStaleMs) {
      return false;
    }
    try {
      this.fs.unlinkSync(lockPath);
      this.logger('INFO', 'scheduler.lock_recovered', {
        lockPath,
        ownerPid: 0,
        staleByPid: false,
        staleByAge: true,
        corrupt: true,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
      });
      return true;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }

  _releaseLock(lockPath, token) {
    try {
      const payload = JSON.parse(this.fs.readFileSync(lockPath, 'utf8'));
      if (normalizeString(payload?.token) !== normalizeString(token)) {
        return;
      }
      this.fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger('WARN', 'scheduler.lock_release_failed', {
          lockPath,
          message: String(error?.message || error),
        });
      }
    }
  }

  _wait(ms) {
    return new Promise((resolve) => {
      const timer = this.setTimeoutImpl(resolve, Math.max(Number(ms) || 0, 1));
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    });
  }
}

module.exports = {
  SCHEDULED_TASKS_SCHEMA_VERSION,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WATCH_DEBOUNCE_MS,
  SchedulerService,
  defaultIsProcessAlive,
  normalizeScheduledTasks,
  readScheduledTasksFile,
  readScheduledTasksFileAsync,
  resolveBackgroundRuntimeRoot,
  resolveScheduledTasksPath,
  writeScheduledTasksFile,
};
