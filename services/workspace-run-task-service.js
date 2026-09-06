/* Main-owned run-task service. Runs each command in an isolated child process,
 * assigns taskId-stamped events, and enforces one active task.
 */

const { startRunTask } = require('./backend/workspace-run-task-runner');
const { RUN_TASK_ERROR_CODES } = require('./backend/error-codes');
const { createTerminalOutputQueue } = require('./workspace-terminal-output-queue');

const MAX_CHUNK_BYTES = 64 * 1024; // per onData event, mirrors workspace-terminal-service.js
const MAX_LABEL_CHARS = 200;

class WorkspaceRunTaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceRunTaskError';
    this.code = code;
    this.error_code = code;
  }
}

class WorkspaceRunTaskService {
  constructor({
    configService,
    sendBridgeEvent,
    runnerImpl = startRunTask,
    spawnImpl,
    killTreeImpl,
    env = process.env,
    logger = null,
    scheduleOutputFlush,
    cancelOutputFlush,
  } = {}) {
    if (!configService) {
      throw new TypeError('WorkspaceRunTaskService requires configService');
    }
    this._configService = configService;
    this._sendBridgeEvent = typeof sendBridgeEvent === 'function' ? sendBridgeEvent : () => {};
    this._runner = typeof runnerImpl === 'function' ? runnerImpl : startRunTask;
    this._spawnImpl = spawnImpl;
    this._killTreeImpl = killTreeImpl;
    this._env = env;
    this._logger = typeof logger === 'function' ? logger : null;
    this._scheduleOutputFlush = scheduleOutputFlush;
    this._cancelOutputFlush = cancelOutputFlush;
    this._task = null; // { id, cwd, settled, outputQueue, controller }
    this._taskCounter = 0;
    this._disposed = false;
    this._disposePromise = null;
  }

  _log(level, event, details = {}) {
    if (this._logger) {
      try {
        this._logger(level, event, details);
      } catch (_error) {
        /* logging must never break a run */
      }
    }
  }

  _requireRoot() {
    const root = String(this._configService.getToolsWorkspaceRoot?.() || '').trim();
    if (!root) {
      throw new WorkspaceRunTaskError(
        RUN_TASK_ERROR_CODES.ROOT_MISSING,
        'No workspace root is configured; choose a workspace folder first.'
      );
    }
    return root;
  }

  hasActiveTask() {
    return Boolean(this._task);
  }

  _createOutputQueue(taskId) {
    return createTerminalOutputQueue({
      maxEventBytes: MAX_CHUNK_BYTES,
      schedule: this._scheduleOutputFlush,
      cancel: this._cancelOutputFlush,
      emit: (stream, chunk, droppedBytes) => {
        const payload = { taskId, stream, chunk };
        if (droppedBytes > 0) payload.droppedBytes = droppedBytes;
        try {
          this._sendBridgeEvent('workspaceRunTask.onData', payload);
        } catch (_error) {
          this._log('WARN', 'workspace_run_task.bridge_emit_failed', { event: 'data' });
        }
      },
      log: (droppedBytes) => this._log('WARN', 'workspace_run_task.output_dropped', { dropped_bytes: droppedBytes }),
    });
  }

  _settleTask(task, result) {
    if (!task || task.settled) {
      return;
    }
    task.settled = true;
    task.outputQueue.dispose({ flushPending: true });
    if (this._task === task) {
      this._task = null;
    }
    const payload = {
      taskId: task.id,
      status: result?.status || 'exited',
      code: result && typeof result.exitCode === 'number' ? result.exitCode : null,
      signal: result?.signal ? String(result.signal) : '',
    };
    if (result?.errorCode) {
      payload.errorCode = result.errorCode;
    }
    try {
      this._sendBridgeEvent('workspaceRunTask.onExit', payload);
    } catch (_error) {
      this._log('WARN', 'workspace_run_task.bridge_emit_failed', { event: 'exit' });
    }
  }

  // Spawns ONE run as an isolated child process. Never reuses or queues -
  // a second call while a task is active is refused (ALREADY_RUNNING),
  // mirroring the renderer's own one-run-at-a-time guard as defense in depth.
  async start({ command, label } = {}) {
    if (this._disposed) {
      throw new WorkspaceRunTaskError(RUN_TASK_ERROR_CODES.NO_TASK, 'The run-task service has been disposed.');
    }
    const cmd = String(command || '').trim();
    if (!cmd) {
      return { ok: false, code: RUN_TASK_ERROR_CODES.SPAWN_FAILED, message: 'No command to run.' };
    }
    if (this._task) {
      return {
        ok: false,
        code: RUN_TASK_ERROR_CODES.ALREADY_RUNNING,
        message: 'A task is already running.',
      };
    }
    let cwd;
    try {
      cwd = this._requireRoot();
    } catch (error) {
      return { ok: false, code: error.code || RUN_TASK_ERROR_CODES.ROOT_MISSING, message: error.message };
    }
    this._taskCounter += 1;
    const id = `run-${this._taskCounter}`;
    const outputQueue = this._createOutputQueue(id);
    const task = { id, cwd, settled: false, outputQueue, controller: null };
    this._task = task;
    const controller = this._runner({
      command: cmd,
      cwd,
      env: this._env,
      spawnImpl: this._spawnImpl,
      killProcessTree: this._killTreeImpl,
      onData: (stream, chunk) => outputQueue.push(stream, chunk),
    });
    task.controller = controller;
    void controller.done.then((result) => this._settleTask(task, result));
    this._log('INFO', 'workspace_run_task.started', { label: String(label || '').slice(0, MAX_LABEL_CHARS) });
    return { ok: true, taskId: id, cwd };
  }

  // Process-tree kill by taskId. Never throws across the IPC seam; an
  // unknown/stale/already-settled taskId is a structured no-op, not a reject
  // - this is exactly what makes a late-resolving start() after a renderer
  // timeout safe to clean up (kill an id that may already be gone).
  async kill({ taskId } = {}) {
    const wanted = String(taskId || '');
    const task = this._task;
    if (!task || (wanted && task.id !== wanted)) {
      return { killed: false };
    }
    const outcome = await task.controller.kill();
    return { killed: outcome?.terminated === true, terminationConfirmed: outcome?.terminated === true };
  }

  // Window close / app shutdown / workspace-root switch: never orphan a
  // running task's process tree.
  dispose() {
    this._disposed = true;
    if (!this._disposePromise) {
      this._disposePromise = (async () => {
        const task = this._task;
        if (!task) {
          return { disposed: true, terminationConfirmed: true };
        }
        const result = await this.kill({ taskId: task.id });
        return {
          disposed: result.killed === true,
          terminationConfirmed: result.terminationConfirmed === true,
        };
      })();
      void this._disposePromise.then((result) => {
        if (!result.disposed) this._disposePromise = null;
      });
    }
    return this._disposePromise;
  }
}

module.exports = {
  WorkspaceRunTaskService,
};
