'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { DockerLauncher } = require('./docker-launcher');
const { DockerWorkerTransport } = require('./docker-worker-transport');
const { ExecutionBroker, validateCommand } = require('./execution-broker');
const { ExecutionReceipts } = require('./execution-receipts');
const { createWorkspaceSnapshot, verifyWorkspaceSnapshot, removeSnapshot } = require('./desktop-workspace-snapshot');
const { digest, sandboxError } = require('./sandbox-errors');
const { captureSandboxAuthority } = require('./sandbox-project-authority');
const { capacityResource } = require('../session-runtime/resource-broker');
class DesktopSandboxService extends EventEmitter {
  constructor({ userDataPath, sourceRoot, configService, getBackend = () => null,
    launcherFactory = (options) => new DockerLauncher(options), buildContext = null,
    snapshot = createWorkspaceSnapshot, platform = process.platform, logger = () => {} }) {
    super();
    Object.assign(this, { userDataPath, sourceRoot, configService, getBackend, launcherFactory, buildContext, snapshot, platform, logger });
    this.directory = path.join(userDataPath, 'command-sandbox');
    this.stagingRoot = path.join(this.directory, 'snapshots');
    this.enabled = configService?.getState?.()?.commandSandbox?.enabled === true;
    this.state = this.enabled ? 'preparing' : 'disabled';
    this.reason = '';
    this.generation = 0;
    this.active = null;
    this.pendingRuntimeCleanup = null;
    this.maintenanceResources = null;
    this.transition = null;
    this.closing = false;
    this.imageId = null;
    this.receipts = null;
    this.launcher = null;
  }
  _publish(state, reason = '') {
    this.state = state;
    this.reason = /^[a-z_]{1,100}$/u.test(reason) ? reason : '';
    this.emit('changed', this.getState());
  }
  getState() {
    return { enabled: this.enabled, state: this.state, reason: this.reason,
      message: '', platform: this.platform, qualified: this.platform === 'win32' && process.arch === 'x64',
      workspace: 'disposable_copy', network: 'none' };
  }
  async start() {
    // A disabled fresh profile needs no Docker resources or daemon access.
    const exists = await fs.stat(this.directory).then(() => true, () => false);
    if (!this.enabled && !exists) return this.getState();
    // A disabled profile left over from an earlier enable only needs Docker
    // when a crash left staged snapshots or unsettled receipts to reconcile.
    if (!this.enabled && !(await this._disabledRecoveryPending())) return this.getState();
    return this.retry();
  }
  async _disabledRecoveryPending() {
    const staged = await fs.readdir(this.stagingRoot).then((entries) => entries.length > 0,
      (error) => error.code !== 'ENOENT');
    if (staged) return true;
    const journal = await fs.stat(path.join(this.directory, 'execution.jsonl')).then(() => true,
      (error) => error.code !== 'ENOENT');
    if (!journal) return false;
    const receipts = new ExecutionReceipts(this.directory);
    return receipts.invalid || receipts.pending().length > 0;
  }
  async setEnabled(patch) {
    if (!patch || Object.keys(patch).length !== 1 || typeof patch.enabled !== 'boolean') throw sandboxError('sandbox_settings_invalid');
    const backend = this.getBackend();
    let runtimeBusy;
    try {
      // A present runtime must positively confirm quiescence, including queued work.
      runtimeBusy = backend?.sessionRuntime != null
        && backend.sessionRuntime.hasPendingOrAdmittedWork?.() !== false;
    } catch { runtimeBusy = true; }
    if (this.active || this.transition || backend?.activeStreams?.size || runtimeBusy) throw sandboxError('sandbox_wait_for_active_chats');
    if (this.enabled === patch.enabled) return this.getState();
    const operation = async () => {
      this.generation += 1;
      // Docker never answered and nothing is on record: there is nothing to reconcile (F22).
      if (!patch.enabled) await this._reconcile().catch((error) => { if (!this._launchedNothing()) throw error; });
      this.configService.updateCommandSandbox({ enabled: patch.enabled });
      this.enabled = patch.enabled;
      this._publish(this.enabled ? 'preparing' : 'disabled');
      await this.getBackend()?.refreshManagedConfig?.('command_sandbox_updated');
      if (this.enabled) { await this._reconcile(); await this._prepare(); }
      return this.getState();
    };
    // Install the barrier before configuration/events can synchronously reenter admission.
    this.transition = Promise.resolve().then(operation).catch((error) => {
      const uncertain = error.reason === 'sandbox_cleanup_unconfirmed' || this.receipts?.invalid || this.receipts?.pending().length;
      this._publish(this.enabled ? (uncertain ? 'recovery-required' : 'unavailable') : 'disabled', error.reason || 'sandbox_configuration_failed');
      throw error;
    }).finally(() => { this._settleMaintenanceResources(); this.transition = null; });
    return this.transition;
  }
  async retry() {
    if (this.active || this.transition) throw sandboxError('sandbox_busy');
    this.transition = Promise.resolve().then(async () => {
      try {
        this._publish(this.enabled ? 'preparing' : 'disabled');
        await this._resources();
        await this._reconcile();
        if (this.enabled) await this._prepare();
        else this._publish('disabled');
      } catch (error) {
        this._publish(this.receipts?.pending().length || this.receipts?.invalid || error.reason === 'sandbox_cleanup_unconfirmed' ? 'recovery-required' : 'unavailable',
          error.reason || 'sandbox_preparation_failed');
      }
      return this.getState();
    }).finally(() => { this._settleMaintenanceResources(); this.transition = null; });
    return this.transition;
  }
  async _resources() {
    this._claimMaintenanceResources();
    if (!this.receipts) this.receipts = new ExecutionReceipts(this.directory);
    if (!this.launcher) this.launcher = this.launcherFactory({ ownerId: this.receipts.ownerId, platform: this.platform });
    await this.launcher.detect();
    this.dockerReached = true; // cleared only by a reconcile that confirms cleanup
  }
  _claimMaintenanceResources() {
    // A backend restart reclaims a quarantined maintenance lease; drop the
    // stale handle so the next maintenance pass charges a live lease again.
    const held = this.maintenanceResources;
    if (held && held.broker.isHeld?.(held.lease) === false) this.maintenanceResources = null;
    if (this.maintenanceResources || this.pendingRuntimeCleanup?.preparation?.holdsWorkerResources()) return;
    const runtime = this.getBackend()?.sessionRuntime;
    if (runtime == null) return;
    const broker = runtime.resourceBroker;
    if (!broker?.tryAcquire || !broker?.release) throw sandboxError('sandbox_resource_unavailable');
    const result = broker.tryAcquire({ ownerId: 'desktop-sandbox-maintenance', resources: [
      capacityResource('native_processes'), capacityResource('sandbox_commands'),
    ] });
    if (result.status !== 'granted') throw sandboxError('sandbox_resource_busy');
    this.maintenanceResources = { broker, lease: result.lease };
  }
  _settleMaintenanceResources() {
    const held = this.maintenanceResources;
    if (!held) return;
    const confirmed = !this.launcher?.hasPendingCommands?.() && !this.pendingRuntimeCleanup
      && !this.receipts?.invalid && !this.receipts?.pending().length
      && (['ready', 'disabled'].includes(this.state) || (this.state === 'unavailable' && this._launchedNothing()));
    if (held.broker.release(held.lease, { producerSettled: confirmed })) this.maintenanceResources = null;
  }
  // Docker was never reached since the last confirmed reconcile, and no receipt, cleanup
  // or command is outstanding: nothing this service launched could still be running.
  _launchedNothing() {
    return !this.dockerReached && !this.pendingRuntimeCleanup && !this.launcher?.hasPendingCommands?.()
      && !this.receipts?.invalid && !this.receipts?.pending().length;
  }
  async _reconcile() {
    if (this.launcher?.hasPendingCommands?.()) throw sandboxError('sandbox_cleanup_unconfirmed');
    await this._resources();
    const owned = await this.launcher.listOwned();
    for (const id of owned) {
      try { await this.launcher.stopAndRemove(id); }
      catch { throw sandboxError('sandbox_cleanup_unconfirmed'); }
    }
    // A live-process claim is correlated to the exact container we launched,
    // even if resource discovery no longer lists it after a partial removal.
    const runtimeCleanup = this.pendingRuntimeCleanup;
    if (runtimeCleanup?.containerId) {
      try { await this.launcher.stopAndRemove(runtimeCleanup.containerId); }
      catch { throw sandboxError('sandbox_cleanup_unconfirmed'); }
    }
    if (this.receipts.invalid) this.receipts.recoverCorrupt({ cleanupConfirmed: true });
    for (const item of this.receipts.pending()) {
      // No replay and no invented command result after a process crash.
      this.receipts.append('reconciled', item.binding, { status: 'interrupted', cleanup_confirmed: true });
    }
    const stages = await fs.readdir(this.stagingRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (stages.length > 32) throw sandboxError('snapshot_recovery_limit');
    for (const entry of stages) await removeSnapshot({ directory: path.join(this.stagingRoot, entry.name), stagingRoot: this.stagingRoot });
    this.receipts.compact();
    if (this.launcher?.hasPendingCommands?.()) throw sandboxError('sandbox_cleanup_unconfirmed');
    if (runtimeCleanup && this.pendingRuntimeCleanup === runtimeCleanup) {
      await runtimeCleanup.claim.settle({ status: runtimeCleanup.status, cleanup: 'confirmed' });
      if (runtimeCleanup.preparation?.settle({ cleanup: 'confirmed' }) === false) {
        throw sandboxError('sandbox_cleanup_unconfirmed');
      }
      if (this.pendingRuntimeCleanup === runtimeCleanup) this.pendingRuntimeCleanup = null;
    }
    this.dockerReached = false;
  }
  async _prepare() {
    await this._resources();
    if (this.receipts.invalid || this.receipts.pending().length) throw sandboxError('receipt_recovery_required');
    const build = this.buildContext || require('../../scripts/packaging/build-command-worker-context').buildWorkerContext;
    const context = await build({ sourceRoot: this.sourceRoot, outputDirectory: path.join(this.directory, 'image-context') });
    this.imageId = await this.launcher.build(context.directory, context.digest);
    await this.launcher.ensureVolume();
    // A real worker startup validates its own seccomp/cgroup/mount contract before Ready.
    await fs.mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const empty = { id: randomUUID() };
    empty.directory = path.join(this.stagingRoot, empty.id);
    await fs.mkdir(empty.directory, { mode: 0o755 });
    let worker;
    let failure;
    try { worker = await this._worker(empty); }
    catch (error) { failure = error; }
    if (worker) {
      try { await this.launcher.stopAndRemove(worker.containerId); }
      catch { failure = sandboxError('sandbox_cleanup_unconfirmed'); }
      worker.transport.dispose();
    }
    if (failure?.reason === 'sandbox_cleanup_unconfirmed') this._publish('recovery-required', failure.reason);
    if (this.state !== 'recovery-required') await removeSnapshot({ directory: empty.directory, stagingRoot: this.stagingRoot });
    if (failure) throw failure;
    this._publish('ready');
  }
  async _worker(snapshot, binding = null) {
    const containerId = await this.launcher.create({ imageId: this.imageId, snapshotDirectory: snapshot.directory });
    if (binding) Object.assign(binding, { container_id: containerId, image_id: this.imageId });
    const transport = new DockerWorkerTransport({ launcher: this.launcher, containerId, imageId: this.imageId, snapshotDirectory: snapshot.directory });
    const broker = new ExecutionBroker({
      userDataPath: this.directory, request: transport.request.bind(transport),
      readReceiptImpl: () => ({ schema_version: 1, pending: null }),
      writeReceiptImpl: (_file, receipt) => {
        if (receipt.pending && binding) {
          Object.assign(binding, receipt.pending);
          this.receipts.append('admitted', { ...binding });
        }
      },
      logger: this.logger,
    });
    try { await broker.prepare(); }
    catch (error) {
      transport.dispose();
      try { await this.launcher.stopAndRemove(containerId); }
      catch { this._publish('recovery-required', 'sandbox_cleanup_unconfirmed'); throw sandboxError('sandbox_cleanup_unconfirmed'); }
      throw error;
    }
    return { containerId, transport, broker };
  }
  async execute(input, context, authorize) {
    if (!this.enabled || this.state !== 'ready' || this.active || this.transition || this.closing
      || this.pendingRuntimeCleanup) throw sandboxError('sandbox_unavailable');
    if (!context.sessionId || !context.streamId || !context.callId || context.readOnly || context.planMode) throw sandboxError('sandbox_authority_invalid');
    const scope = captureSandboxAuthority(this.getBackend(), context.sessionId, context.projectAuthority);
    const args = validateCommand(input);
    const requestId = digest([context.sessionId, context.streamId, context.callId]);
    this.receipts.compact();
    if (this.receipts.seen(requestId)) throw sandboxError('sandbox_duplicate_request');
    const controller = new AbortController();
    const operation = { controller, streamId: context.streamId, promise: null };
    this.active = operation;
    this._publish('busy');
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    operation.promise = this._execute(args, { ...context, scope, signal: controller.signal }, authorize, requestId)
      .finally(() => {
        context.signal?.removeEventListener('abort', abort);
        if (this.active === operation) this.active = null;
        if (this.state === 'busy') this._publish('ready');
      });
    return operation.promise;
  }
  async _execute(args, context, authorize, requestId) {
    const { authority, assertCurrent } = context.scope;
    const root = authority.root_path;
    const generation = this.generation;
    const binding = { request_id: requestId, session_id: context.sessionId, stream_id: context.streamId,
      tool_call_id: context.callId, command_digest: digest(args), policy_generation: generation,
      workspace_id: digest(path.resolve(root)), workspace_generation: authority.root_revision,
      project_id: authority.project_id, root_revision: authority.root_revision };
    let snapshot;
    let worker;
    let result;
    let failure;
    let containerRemoved = false;
    let snapshotRemoved = false;
    let workerPreparationStarted = false;
    let commandMayStart = false;
    let preparation;
    const live = () => {
      if (context.signal.aborted || this.closing || !this.enabled || generation !== this.generation
        || context.isLive?.() === false) throw sandboxError('sandbox_stale_authority');
      assertCurrent();
    };
    try {
      live();
      preparation = context.resourceClaim?.createSandboxPreparation?.({ signal: context.signal, assertLive: live });
      const stage = onSettled => this.snapshot({ root, stagingRoot: this.stagingRoot,
        forbiddenRoots: [this.userDataPath], signal: context.signal, onSettled });
      snapshot = await (preparation ? preparation.withSnapshot(stage) : stage());
      Object.assign(binding, { snapshot_id: snapshot.id, snapshot_digest: snapshot.digest });
      if (snapshot.rootIdentity) binding.workspace_id = snapshot.rootIdentity;
      live();
      preparation?.acquireWorker();
      workerPreparationStarted = true;
      worker = await this._worker(snapshot, binding);
      const ready = await worker.transport.request('status');
      Object.assign(binding, { job_id: randomUUID(), incarnation: ready.incarnation });
      preparation?.bindWorker(binding);
      const authorization = await authorize(Object.freeze({ ...binding }), live, context.signal);
      live();
      if (!authorization?.approved) throw sandboxError('sandbox_approval_denied');
      binding.authorization_digest = authorization.digest;
      worker.transport.admissionCheck = async () => {
        live(); authorization.validate?.();
        await verifyWorkspaceSnapshot(snapshot);
        live(); authorization.validate?.();
      };
      result = await worker.broker.execute(args, { signal: context.signal, sessionId: context.sessionId,
        streamId: context.streamId, jobId: binding.job_id, expectedIncarnation: binding.incarnation,
        beforeAdmission: async () => {
          await worker.transport.admissionCheck();
          await context.resourceClaim?.admit({ preparation, workerBinding: binding });
          await context.beforeProducer?.();
          live(); authorization.validate?.();
          commandMayStart = true;
        } });
      this.receipts.append('terminal', { ...binding }, { ...result, stdout: String(result.stdout || '').slice(0, 8192), stderr: String(result.stderr || '').slice(0, 8192) });
    } catch (error) {
      if (this.receipts.pending().length || error.reason === 'sandbox_cleanup_unconfirmed') this._publish('recovery-required', error.reason || 'sandbox_execution_uncertain');
      else if (!context.resourceClaim?.isWaiting?.(error)
        && !['sandbox_approval_denied', 'sandbox_stale_authority', 'runtime_electron_start_cancelled'].includes(error.reason)) {
        this._publish('unavailable', error.reason || 'sandbox_execution_failed');
      }
      failure = error;
    } finally {
      if (snapshot) {
        try {
          if (worker) {
            await this.launcher.stopAndRemove(worker.containerId);
            containerRemoved = true;
            worker.transport.dispose();
          }
          if (worker || failure?.reason !== 'sandbox_cleanup_unconfirmed') {
            await removeSnapshot({ directory: snapshot.directory, stagingRoot: this.stagingRoot });
            snapshotRemoved = true;
          }
        } catch (error) {
          this._publish('recovery-required', error.reason || 'sandbox_cleanup_unconfirmed');
          failure = error;
        }
      }
      if (context.resourceClaim) {
        const status = result?.status === 'cancelled' ? 'cancelled'
          : result?.success === true && !failure ? 'succeeded' : 'failed';
        const preparedCleanup = (!snapshot || snapshotRemoved)
          && (!workerPreparationStarted || containerRemoved)
          && !this.launcher?.hasPendingCommands?.()
          && failure?.reason !== 'sandbox_cleanup_unconfirmed' ? 'confirmed' : 'uncertain';
        const cleanup = (!commandMayStart && preparedCleanup === 'confirmed' && !this.receipts.pending().length)
          || (!failure && containerRemoved && result?.cleanup_confirmed === true) ? 'confirmed' : 'uncertain';
        const preparationSettled = preparation?.settle({ cleanup: preparedCleanup }) !== false;
        const retained = { claim: context.resourceClaim, status, preparation,
          containerId: worker?.containerId || binding.container_id || null };
        if (cleanup === 'uncertain') this.pendingRuntimeCleanup = retained;
        const settled = await context.resourceClaim.settle({ status, cleanup });
        // A refusal before admission created no resource lease to recover.
        if (!preparationSettled) {
          this.pendingRuntimeCleanup = retained;
          this._publish('recovery-required', 'sandbox_cleanup_unconfirmed');
        } else if (settled === false && this.pendingRuntimeCleanup === retained) this.pendingRuntimeCleanup = null;
        if (context.resourceClaim.isWaiting?.(failure)) {
          if (!(preparedCleanup === 'confirmed' && preparationSettled && !this.receipts.pending().length
            && context.resourceClaim.confirmWait(failure))) {
            this._publish('recovery-required', 'sandbox_cleanup_unconfirmed');
            failure = sandboxError('sandbox_cleanup_unconfirmed');
          }
        }
      }
    }
    if (failure) throw failure;
    return result;
  }
  async drainStream(streamId) {
    if (this.active?.streamId === streamId) await this.active.promise.catch(() => {});
    if (this.state === 'recovery-required') throw sandboxError('sandbox_cleanup_unconfirmed');
  }
  async close() {
    this.closing = true;
    this.active?.controller.abort();
    if (this.active?.promise) await this.active.promise.catch(() => {});
    if (this.transition) await this.transition.catch(() => {});
    try {
      if (this.launcher) await this._reconcile();
      // Successful shutdown reconciliation leaves no producer to reserve.
      if (this.maintenanceResources && !this.launcher?.hasPendingCommands?.()) {
        const held = this.maintenanceResources;
        if (held.broker.release(held.lease, { producerSettled: true })) this.maintenanceResources = null;
      }
    } catch (error) { this._settleMaintenanceResources(); throw error; }
  }
}
module.exports = { DesktopSandboxService };
