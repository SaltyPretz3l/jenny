'use strict';

const crypto = require('crypto');
const {
  containsJennyStateDirSegment,
  isJennyStateDirRoot,
  normalizeWorkspaceRootPath,
  workspaceRootId,
} = require('./workspace-root-identity');

const DEFAULT_TRANSITION_TTL_MS = 120_000;
const DEFAULT_MUTATION_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
// Rejecting the .jenny state directory as a workspace root is the fix for an
// observed misconfiguration: every consumer appends its own `.jenny/...`
// suffix onto the configured root, so a root of (or inside) `.jenny` itself
// materializes a doubled `.jenny/.jenny/...` tree.
const JENNY_STATE_DIR_ROOT_MESSAGE = 'This folder is Jenny\'s own internal state '
  + 'directory (.jenny) and can\'t be used as the tools workspace root. Choose the '
  + 'folder\'s parent directory instead.';
const JENNY_STATE_DIR_SEGMENT_MESSAGE = 'The selected folder is inside Jenny\'s own '
  + 'internal state directory (.jenny) and can\'t be used as the tools workspace root. '
  + 'Choose a folder outside .jenny.';

function defaultNormalizeRootPath(value) {
  return normalizeWorkspaceRootPath(value);
}

function defaultRootIdFactory(rootPath) {
  return workspaceRootId(rootPath);
}

function freezeContext(context) {
  const phase = context.phase === 'transitioning'
    ? 'transitioning'
    : context.phase === 'error'
      ? 'error'
      : 'ready';
  return Object.freeze({
    rootPath: String(context.rootPath || ''),
    rootId: context.rootId == null ? null : String(context.rootId),
    generation: Number(context.generation) || 0,
    phase,
  });
}

function safeErrorCode(error) {
  const candidate = String(error && error.code || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate)
    ? candidate
    : 'workspace_root_transition_failed';
}

function stageMessage(stage) {
  return {
    stop: 'Workspace root services could not be stopped.',
    persistence: 'Workspace root persistence failed.',
    refresh: 'Managed runtime root refresh failed.',
    participants: 'A workspace root participant failed to commit.',
    start: 'Workspace root services could not be started.',
  }[stage] || 'Workspace root transition failed.';
}

function normalizeBlocker(participantId, blocker) {
  if (!blocker) return null;
  const reason = typeof blocker === 'string'
    ? blocker
    : String(blocker.reason || blocker.code || 'participant_active');
  return {
    id: participantId,
    reason: reason.trim().slice(0, 80) || 'participant_active',
  };
}

class WorkspaceRootCoordinator {
  constructor({
    initialRootPath = '',
    normalizeRootPath = defaultNormalizeRootPath,
    rootIdFactory = defaultRootIdFactory,
    chooseTarget = async () => ({ canceled: true, path: '' }),
    applyRootPath = async () => {},
    restoreRootPath = async () => {},
    refreshManagedRoot = async () => {},
    stopRootServices = async () => {},
    startRootServices = async () => {},
    transitionIdFactory = () => crypto.randomUUID(),
    operationIdFactory = () => crypto.randomUUID(),
    transitionTtlMs = DEFAULT_TRANSITION_TTL_MS,
    mutationDrainTimeoutMs = DEFAULT_MUTATION_DRAIN_TIMEOUT_MS,
    hookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    logger = null,
  } = {}) {
    this._normalizeRootPath = normalizeRootPath;
    this._rootIdFactory = rootIdFactory;
    this._chooseTarget = chooseTarget;
    this._applyRootPath = applyRootPath;
    this._restoreRootPath = restoreRootPath;
    this._refreshManagedRoot = refreshManagedRoot;
    this._stopRootServices = stopRootServices;
    this._startRootServices = startRootServices;
    this._transitionIdFactory = transitionIdFactory;
    this._operationIdFactory = operationIdFactory;
    this._transitionTtlMs = Math.max(1, Number(transitionTtlMs) || DEFAULT_TRANSITION_TTL_MS);
    this._mutationDrainTimeoutMs = Math.max(
      1,
      Number(mutationDrainTimeoutMs) || DEFAULT_MUTATION_DRAIN_TIMEOUT_MS
    );
    this._hookTimeoutMs = Math.max(1, Number(hookTimeoutMs) || DEFAULT_HOOK_TIMEOUT_MS);
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
    this._logger = logger;

    const rootPath = this._normalizeRootPath(initialRootPath);
    this._state = {
      rootPath,
      rootId: this._rootIdFactory(rootPath),
      generation: 0,
      phase: 'ready',
    };
    this._transition = null;
    this._transitionTimer = null;
    this._transitionTimerToken = null;
    this._selectionInFlight = false;
    this._commitInFlight = null;
    this._commitTransitionId = null;
    this._operations = new Map();
    this._mutationWaiters = new Set();
    this._participants = new Map();
  }

  captureContext() {
    return freezeContext(this._state);
  }

  isCurrent(context) {
    if (!context || this._state.phase !== 'ready') return false;
    return context.rootId === this._state.rootId
      && Number(context.generation) === this._state.generation;
  }

  acquireOperation({ kind = 'read', cancellable = true } = {}) {
    const context = this.captureContext();
    if (this._state.phase !== 'ready') {
      return {
        acquired: false,
        code: this._state.phase === 'error' ? 'root_recovery_required' : 'root_transitioning',
        context,
      };
    }
    const normalizedKind = kind === 'mutation' ? 'mutation' : 'read';
    const operationId = String(this._operationIdFactory());
    const abortController = new AbortController();
    let released = false;
    const record = {
      id: operationId,
      kind: normalizedKind,
      cancellable: cancellable !== false,
      context,
      abortController,
    };
    this._operations.set(operationId, record);

    const release = () => {
      if (released) return false;
      released = true;
      this._operations.delete(operationId);
      if (normalizedKind === 'mutation') this._resolveMutationWaitersIfDrained();
      return true;
    };
    return {
      acquired: true,
      operationId,
      context,
      signal: abortController.signal,
      release,
      isCurrent: () => !released && (
        normalizedKind === 'mutation'
          ? this._isMutationContextCurrent(context)
          : this.isCurrent(context)
      ),
    };
  }

  registerParticipant(participant) {
    const id = String(participant && participant.id || '').trim();
    if (!id) throw new TypeError('workspace root participant id is required');
    if (this._participants.has(id)) {
      throw new Error(`workspace root participant already registered: ${id}`);
    }
    const normalized = { ...participant, id };
    this._participants.set(id, normalized);
    return () => this._participants.get(id) === normalized && this._participants.delete(id);
  }

  async prepareChoose(options = {}) {
    if (this._selectionInFlight || this._transition) {
      return this._prepareBlocked('transition_in_progress');
    }
    this._selectionInFlight = true;
    let selected;
    try {
      selected = await this._chooseTarget(options);
    } catch (error) {
      this._log('warn', 'workspace_root.choose_failed', { code: safeErrorCode(error) });
      return {
        prepared: false,
        canceled: false,
        changed: false,
        blocked: true,
        code: 'target_selection_failed',
        context: this.captureContext(),
      };
    } finally {
      this._selectionInFlight = false;
    }
    if (!selected || selected.canceled === true || !selected.path) {
      return {
        prepared: false,
        canceled: true,
        changed: false,
        context: this.captureContext(),
      };
    }
    // Picker-only: reject a target anywhere inside .jenny, not only a root
    // whose final segment is .jenny. Choosing a folder INSIDE the state
    // directory is equally wrong, but this stricter check only applies to
    // interactive selection, not the trusted prepareTarget entrypoint (e.g.
    // worktree roots) or prepareClear.
    if (containsJennyStateDirSegment(this._normalizeRootPath(selected.path))) {
      this._log('warn', 'workspace_root.state_dir_segment_rejected', {});
      return this._prepareBlocked('workspace_root_inside_state_dir', {
        message: JENNY_STATE_DIR_SEGMENT_MESSAGE,
      });
    }
    return this._prepareTarget(selected.path);
  }

  async prepareClear() {
    if (this._selectionInFlight || this._transition) {
      return this._prepareBlocked('transition_in_progress');
    }
    return this._prepareTarget('');
  }

  // Trusted main-process services (worktree selection, setup reset) use this
  // direct-target entrypoint. It is intentionally not exposed over preload;
  // renderer-originated selection must go through prepareChoose/prepareClear.
  async prepareTarget(rootPath) {
    if (this._selectionInFlight || this._transition) {
      return this._prepareBlocked('transition_in_progress');
    }
    return this._prepareTarget(rootPath);
  }

  cancel({ transitionId } = {}) {
    const transition = this._matchingTransition(transitionId);
    if (!transition) return this._cancelRefused('transition_not_found');
    if (this._commitInFlight) return this._cancelRefused('commit_in_progress');
    this._finishTransitionAt(transition.previous);
    return {
      canceled: true,
      changed: false,
      context: this.captureContext(),
    };
  }

  commit({ transitionId, terminateProcesses = false } = {}) {
    if (this._commitInFlight) {
      if (String(transitionId || '') === this._commitTransitionId) return this._commitInFlight;
      return Promise.resolve(this._commitRefused('commit_in_progress'));
    }
    const transition = this._matchingTransition(transitionId);
    if (!transition) return Promise.resolve(this._commitRefused('transition_not_found'));

    this._clearTransitionTimer();
    this._commitTransitionId = transition.id;
    this._commitInFlight = this._commitPreparedTransition(transition, terminateProcesses)
      .finally(() => {
        this._commitInFlight = null;
        this._commitTransitionId = null;
      });
    return this._commitInFlight;
  }

  _prepareTarget(targetValue) {
    if (this._transition) return this._prepareBlocked('transition_in_progress');
    const rootPath = this._normalizeRootPath(targetValue);
    // Universal seam: every set-root path (prepareChoose, prepareClear, and
    // the trusted direct prepareTarget entrypoint) converges here. A root
    // whose final segment is .jenny is rejected regardless of entrypoint;
    // rootPath is empty for prepareClear, which is never rejected.
    if (rootPath && isJennyStateDirRoot(rootPath)) {
      this._log('warn', 'workspace_root.state_dir_root_rejected', {});
      return this._prepareBlocked('workspace_root_is_state_dir', {
        message: JENNY_STATE_DIR_ROOT_MESSAGE,
      });
    }
    const rootId = this._rootIdFactory(rootPath);
    if (rootId === this._state.rootId && this._state.phase === 'ready') {
      return {
        prepared: false,
        canceled: false,
        changed: false,
        noop: true,
        context: this.captureContext(),
      };
    }

    const previous = freezeContext(this._state);
    const generation = this._state.generation + 1;
    const candidate = freezeContext({ rootPath, rootId, generation, phase: 'transitioning' });
    const transition = {
      id: String(this._transitionIdFactory()),
      previous,
      candidate,
    };
    this._transition = transition;
    this._armTransitionTimer(transition.id);
    return {
      prepared: true,
      transitionId: transition.id,
      canceled: false,
      changed: true,
      candidate,
      previous,
    };
  }

  _beginTransition(transition) {
    if (this._state.phase === 'transitioning') return;
    this._state = {
      rootPath: transition.previous.rootPath,
      rootId: transition.previous.rootId,
      generation: transition.candidate.generation,
      phase: 'transitioning',
    };
    this._abortCancellableOperations();
  }

  async _commitPreparedTransition(transition, terminateProcesses) {
    let readiness = await this._ensureParticipantsReady(transition, terminateProcesses);
    if (!readiness.ready) return readiness.result;
    this._beginTransition(transition);

    if (!await this._waitForMutationDrain()) {
      this._armTransitionTimer(transition.id);
      const blockers = this._activeMutationBlockers();
      this._log('warn', 'workspace_root.mutation_drain_timed_out', {
        activeCount: this._countMutationOperations(),
        reportedCount: blockers.length,
      });
      return this._commitRefused('mutations_active', {
        blocked: true,
        blockers,
      });
    }

    // A process can become active while an older mutation is draining. Recheck
    // immediately before stopping services and changing persistence so a late
    // terminal, PTY, or test run cannot escape the transition barrier.
    readiness = await this._ensureParticipantsReady(transition, terminateProcesses);
    if (!readiness.ready) return readiness.result;

    let stage = 'stop';
    try {
      await this._runTransactionStep(() => this._stopRootServices(
        this._previousContext(transition, 'commit')
      ));
      stage = 'persistence';
      await this._runTransactionStep(() => this._applyRootPath(
        this._candidateContext(transition, 'commit')
      ));
      stage = 'refresh';
      await this._runTransactionStep(() => this._refreshManagedRoot(
        this._candidateContext(transition, 'commit')
      ));
      stage = 'participants';
      await this._notifyParticipants('onCommitted', transition, 'commit');
      stage = 'start';
      await this._runTransactionStep(() => this._startRootServices(
        this._candidateContext(transition, 'commit')
      ));
    } catch (error) {
      return this._rollbackTransition(transition, stage, error);
    }

    this._finishTransitionAt(transition.candidate, 'ready');
    return {
      committed: true,
      changed: true,
      rolledBack: false,
      previous: transition.previous,
      context: this.captureContext(),
    };
  }

  async _rollbackTransition(transition, stage, error) {
    const rollbackErrors = [];
    if (error && error.uncertain === true) {
      rollbackErrors.push({ stage: `uncertain:${stage}`, code: safeErrorCode(error) });
    }
    const attempt = async (rollbackStage, callback) => {
      try {
        await this._runTransactionStep(callback);
      } catch (rollbackError) {
        rollbackErrors.push({ stage: rollbackStage, code: safeErrorCode(rollbackError) });
      }
    };
    // startRootServices(candidate) can perform visible work before rejecting.
    // Stop that partially-started target before restoring persistence and
    // restarting the previous root, otherwise both roots can remain live.
    await attempt('stop', () => this._stopRootServices(
      this._candidateContext(transition, 'rollback_cleanup')
    ));
    await attempt('restore', () => this._restoreRootPath(
      this._previousContext(transition, 'rollback')
    ));
    await attempt('refresh', () => this._refreshManagedRoot(
      this._previousContext(transition, 'rollback')
    ));
    rollbackErrors.push(...await this._notifyParticipantsIsolated(
      'onRolledBack', transition, 'rollback'
    ));
    await attempt('start', () => this._startRootServices(
      this._previousContext(transition, 'rollback')
    ));
    this._finishTransitionAt(
      transition.previous,
      rollbackErrors.length > 0 ? 'error' : transition.previous.phase
    );
    const result = {
      committed: false,
      changed: false,
      rolledBack: true,
      code: 'commit_failed',
      stage,
      error: { code: safeErrorCode(error), message: stageMessage(stage) },
      context: this.captureContext(),
    };
    if (rollbackErrors.length > 0) {
      result.rollbackIncomplete = true;
      result.rollbackErrors = rollbackErrors;
    }
    this._log('warn', 'workspace_root.commit_rolled_back', {
      stage,
      code: result.error.code,
      rollbackIncomplete: result.rollbackIncomplete === true,
    });
    return result;
  }

  async _collectBlockers(transition) {
    const blockers = [];
    for (const participant of this._participants.values()) {
      if (typeof participant.getBlocker !== 'function') continue;
      try {
        const blocker = normalizeBlocker(
          participant.id,
          await this._runBounded(`participant_check:${participant.id}`, () => (
            participant.getBlocker(this._hookContext(transition, 'check'))
          ))
        );
        if (blocker) blockers.push(blocker);
      } catch (error) {
        blockers.push({
          id: participant.id,
          reason: error && error.uncertain === true
            ? 'participant_check_timeout'
            : 'participant_check_failed',
        });
        this._log('warn', 'workspace_root.participant_check_failed', {
          participantId: participant.id,
          code: safeErrorCode(error),
        });
      }
    }
    return blockers;
  }

  async _ensureParticipantsReady(transition, terminateProcesses) {
    let blockers = await this._collectBlockers(transition);
    if (blockers.length === 0) return { ready: true };
    if (terminateProcesses !== true) {
      this._armTransitionTimer(transition.id);
      return { ready: false, result: this._participantsBlocked(blockers) };
    }
    const terminationFailure = await this._terminateBlockers(blockers, transition);
    if (terminationFailure) {
      this._armTransitionTimer(transition.id);
      return {
        ready: false,
        result: this._commitRefused('participant_termination_failed', {
          blocked: true,
          blockers: [terminationFailure],
        }),
      };
    }
    blockers = await this._collectBlockers(transition);
    if (blockers.length > 0) {
      this._armTransitionTimer(transition.id);
      return { ready: false, result: this._participantsBlocked(blockers) };
    }
    return { ready: true };
  }

  async _terminateBlockers(blockers, transition) {
    for (const blocker of blockers) {
      const participant = this._participants.get(blocker.id);
      if (!participant || typeof participant.terminate !== 'function') return blocker;
      try {
        await this._runBounded(`participant_terminate:${participant.id}`, () => (
          participant.terminate(this._hookContext(transition, 'terminate'))
        ));
      } catch (error) {
        this._log('warn', 'workspace_root.participant_termination_failed', {
          participantId: blocker.id,
          code: safeErrorCode(error),
        });
        return { id: blocker.id, reason: 'termination_failed' };
      }
    }
    return null;
  }

  async _notifyParticipants(method, transition, reason) {
    for (const participant of this._participants.values()) {
      if (typeof participant[method] === 'function') {
        await this._runTransactionStep(() => (
          participant[method](this._hookContext(transition, reason))
        ));
      }
    }
  }

  async _notifyParticipantsIsolated(method, transition, reason) {
    const errors = [];
    for (const participant of this._participants.values()) {
      if (typeof participant[method] !== 'function') continue;
      try {
        await this._runTransactionStep(() => (
          participant[method](this._hookContext(transition, reason))
        ));
      } catch (error) {
        errors.push({ stage: `participant:${participant.id}`, code: safeErrorCode(error) });
        this._log('warn', 'workspace_root.participant_rollback_failed', {
          participantId: participant.id,
          code: safeErrorCode(error),
        });
      }
    }
    return errors;
  }

  _waitForMutationDrain() {
    if (!this._hasMutationOperations()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let finished = false;
      let timer = null;
      const finish = (drained) => {
        if (finished) return;
        finished = true;
        this._mutationWaiters.delete(onDrained);
        this._clearTimeout(timer);
        resolve(drained);
      };
      const onDrained = () => finish(true);
      timer = this._setTimeout(() => finish(false), this._mutationDrainTimeoutMs);
      this._mutationWaiters.add(onDrained);
      if (!this._hasMutationOperations()) finish(true);
    });
  }

  _resolveMutationWaitersIfDrained() {
    if (this._hasMutationOperations()) return;
    for (const resolve of [...this._mutationWaiters]) resolve();
  }

  _hasMutationOperations() {
    return this._countMutationOperations() > 0;
  }

  _countMutationOperations() {
    let count = 0;
    for (const operation of this._operations.values()) {
      if (operation.kind === 'mutation') count += 1;
    }
    return count;
  }

  _activeMutationBlockers() {
    return [...this._operations.values()]
      .filter((operation) => operation.kind === 'mutation')
      .slice(0, 16)
      .map((operation) => ({
        id: String(operation.id || '').slice(0, 64) || 'mutation',
        reason: 'mutation_active',
      }));
  }

  _isMutationContextCurrent(context) {
    return this._state.phase !== 'error'
      && context.rootId === this._state.rootId
      && context.rootPath === this._state.rootPath;
  }

  _runBounded(stage, callback) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this._setTimeout(() => {
        const error = new Error(`Workspace root stage timed out: ${stage}`);
        error.code = 'workspace_root_stage_timeout';
        error.uncertain = true;
        reject(error);
      }, this._hookTimeoutMs);
    });
    return Promise.race([Promise.resolve().then(callback), timeout])
      .finally(() => this._clearTimeout(timer));
  }

  // Transactional stages can mutate persistence, the managed sidecar, or
  // watcher ownership. Racing them against a timer would allow a timed-out
  // promise to complete after rollback and silently re-apply the candidate
  // root. The concrete stage owners provide their own bounded contracts; the
  // coordinator preserves linear settlement and never overlaps compensation.
  _runTransactionStep(callback) {
    return Promise.resolve().then(callback);
  }

  _abortCancellableOperations() {
    for (const operation of this._operations.values()) {
      if (operation.cancellable && !operation.abortController.signal.aborted) {
        operation.abortController.abort('workspace_root_transition');
      }
    }
  }

  _matchingTransition(transitionId) {
    const id = String(transitionId || '');
    return this._transition && this._transition.id === id ? this._transition : null;
  }

  _finishTransitionAt(context, phase = context.phase) {
    this._clearTransitionTimer();
    this._state = {
      rootPath: context.rootPath,
      rootId: context.rootId,
      generation: this._state.generation,
      phase: phase === 'error' ? 'error' : 'ready',
    };
    this._transition = null;
  }

  _armTransitionTimer(transitionId) {
    this._clearTransitionTimer();
    const timerToken = {};
    this._transitionTimerToken = timerToken;
    const timer = this._setTimeout(() => {
      if (
        this._transitionTimerToken !== timerToken
        || this._commitInFlight
        || !this._matchingTransition(transitionId)
      ) return;
      const transition = this._transition;
      this._finishTransitionAt(transition.previous);
      this._log('info', 'workspace_root.transition_expired', {});
    }, this._transitionTtlMs);
    if (typeof timer?.unref === 'function') timer.unref();
    if (this._transitionTimerToken === timerToken) {
      this._transitionTimer = timer;
    } else {
      this._clearTimeout(timer);
    }
  }

  _clearTransitionTimer() {
    this._transitionTimerToken = null;
    if (this._transitionTimer != null) this._clearTimeout(this._transitionTimer);
    this._transitionTimer = null;
  }

  _candidateContext(transition, reason) {
    return {
      ...transition.candidate,
      phase: 'transitioning',
      transitionId: transition.id,
      reason,
    };
  }

  _previousContext(transition, reason) {
    return {
      ...transition.previous,
      generation: this._state.generation,
      phase: 'transitioning',
      transitionId: transition.id,
      reason,
    };
  }

  _hookContext(transition, reason) {
    return {
      transitionId: transition.id,
      reason,
      previous: transition.previous,
      candidate: transition.candidate,
    };
  }

  _prepareBlocked(code, extra = {}) {
    return {
      prepared: false,
      canceled: false,
      changed: false,
      blocked: true,
      code,
      context: this.captureContext(),
      ...extra,
    };
  }

  _participantsBlocked(blockers) {
    return this._commitRefused('participants_active', { blocked: true, blockers });
  }

  _commitRefused(code, extra = {}) {
    return {
      committed: false,
      changed: false,
      code,
      context: this.captureContext(),
      ...extra,
    };
  }

  _cancelRefused(code) {
    return { canceled: false, changed: false, code, context: this.captureContext() };
  }

  _log(level, event, details) {
    if (typeof this._logger !== 'function') return;
    try {
      this._logger(level, event, details);
    } catch (_error) {
      // Observability must never break the transition state machine.
    }
  }
}

module.exports = {
  WorkspaceRootCoordinator,
  defaultNormalizeRootPath,
};
