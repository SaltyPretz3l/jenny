'use strict';

// Writes window-state.json for services/window-state-service.js. A write that
// would only refresh updatedAt is skipped. Async writes (debounced move/resize,
// maximize/unmaximize) run one at a time and keep only the newest queued state.
// The synchronous write (window 'close', display repairs) is final: it drops
// the queue and fences an in-flight async write off its commit.

const fs = require('fs');

function errorDetails(error) {
  return {
    name: String(error?.name || 'Error'),
    code: String(error?.code || 'unknown'),
  };
}

function sameRect(left, right) {
  return Boolean(left && right)
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

class WindowStateWriter {
  constructor({ userDataPath, filePath, stateVersion, initialState = null, log = () => {} }) {
    this.userDataPath = userDataPath;
    this.filePath = filePath;
    this.stateVersion = stateVersion;
    this.log = log;
    // The state last committed to disk (or read from it at startup).
    this.lastState = initialState;
    this._queuedState = null;
    this._writeLoop = null;
    this._syncWriteGeneration = 0;
    this._tempFileSeq = 0;
  }

  _tempPath() {
    this._tempFileSeq += 1;
    return `${this.filePath}.${process.pid}.${Date.now()}.${this._tempFileSeq}.tmp`;
  }

  // updatedAt is ignored: a write that would only refresh it is skipped.
  _matchesLastState(state) {
    const last = this.lastState;
    return Boolean(last && state)
      && Number(last.version) === this.stateVersion
      && last.isMaximized === state.isMaximized
      && last.displayId === state.displayId
      && sameRect(last.normalBounds, state.normalBounds);
  }

  _commitWrittenState(state) {
    this.lastState = state;
    this.log('DEBUG', 'window.state_saved', {
      isMaximized: state.isMaximized === true,
      displayId: state.displayId,
    });
  }

  _logSaveFailure(error) {
    this.log('WARN', 'window.state_save_failed', {
      ...errorDetails(error),
    });
  }

  // Synchronous write, kept for the window 'close' (quit must not lose it) and
  // display repairs. It is final: any queued async write is dropped and an
  // in-flight one is fenced off its rename, so an older state never lands
  // after it.
  writeSync(state) {
    this._queuedState = null;
    this._syncWriteGeneration += 1;
    if (this._matchesLastState(state)) {
      return true;
    }
    const tempPath = this._tempPath();
    try {
      fs.mkdirSync(this.userDataPath, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
      this._commitWrittenState(state);
      return true;
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_cleanupError) {
        // The next successful write will replace the canonical state file.
      }
      this._logSaveFailure(error);
      return false;
    }
  }

  // Resolves true once the state is on disk (or already was).
  enqueue(state) {
    this._queuedState = state;
    if (!this._writeLoop) {
      this._writeLoop = this._drainWriteQueue();
    }
    return this._writeLoop;
  }

  async _drainWriteQueue() {
    // Yield first so `_writeLoop` is assigned before the loop can finish and
    // clear it; a state queued in the same tick then joins this loop.
    await null;
    let saved = false;
    try {
      while (this._queuedState) {
        const state = this._queuedState;
        this._queuedState = null;
        saved = this._matchesLastState(state)
          ? true
          : await this._writeStateAsync(state, this._syncWriteGeneration);
      }
    } finally {
      this._writeLoop = null;
    }
    return saved;
  }

  // The temp file is written asynchronously; the rename that commits it stays
  // synchronous so it is ordered against writeSync on the main thread: a sync
  // write that landed while the temp file was being written wins, and this
  // older state is discarded instead of renamed over it.
  async _writeStateAsync(state, generation) {
    const tempPath = this._tempPath();
    try {
      await fs.promises.mkdir(this.userDataPath, { recursive: true });
      await fs.promises.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
      if (generation !== this._syncWriteGeneration) {
        await fs.promises.unlink(tempPath);
        return false;
      }
      fs.renameSync(tempPath, this.filePath);
      this._commitWrittenState(state);
      return true;
    } catch (error) {
      try {
        await fs.promises.unlink(tempPath);
      } catch (_cleanupError) {
        // The next successful write will replace the canonical state file.
      }
      this._logSaveFailure(error);
      return false;
    }
  }

  // Resolves once every queued async write has settled.
  whenSettled() {
    return this._writeLoop ? this._writeLoop.then(() => undefined) : Promise.resolve();
  }
}

module.exports = { WindowStateWriter, errorDetails };
