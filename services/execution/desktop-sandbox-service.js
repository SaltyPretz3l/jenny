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
    this.workspaceGeneration = 0;
    this.workspaceRoot = this._root();
    this.active = null;
    this.transition = null;
    this.closing = false;
    this.imageId = null;
    this.receipts = null;
    this.launcher = null;
    this.onConfigChanged = () => {
      const root = this._root();
      if (root !== this.workspaceRoot) {
        this.workspaceRoot = root;
        this.workspaceGeneration += 1;
        this.active?.controller.abort();
      }
    };
    configService?.on?.('changed', this.onConfigChanged);
  }
  _root() { return String(this.configService?.getState?.()?.toolsWorkspaceRoot || '').trim(); }
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
    return this.retry();
  }
  async setEnabled(patch) {
    if (!patch || Object.keys(patch).length !== 1 || typeof patch.enabled !== 'boolean') throw sandboxError('sandbox_settings_invalid');
    if (this.active || this.transition || this.getBackend()?.activeStreams?.size) throw sandboxError('sandbox_wait_for_active_chats');
    if (this.enabled === patch.enabled) return this.getState();
    const operation = async () => {
      this.generation += 1;
      if (!patch.enabled) await this._reconcile();
      this.configService.updateCommandSandbox({ enabled: patch.enabled });
      this.enabled = patch.enabled;
      this._publish(this.enabled ? 'preparing' : 'disabled');
      await this.getBackend()?.refreshManagedConfig?.('command_sandbox_updated');
      if (this.enabled) { await this._reconcile(); await this._prepare(); }
      return this.getState();
    };
    this.transition = operation().catch((error) => {
      const uncertain = error.reason === 'sandbox_cleanup_unconfirmed' || this.receipts?.invalid || this.receipts?.pending().length;
      this._publish(this.enabled ? (uncertain ? 'recovery-required' : 'unavailable') : 'disabled', error.reason || 'sandbox_configuration_failed');
      throw error;
    }).finally(() => { this.transition = null; });
    return this.transition;
  }
  async retry() {
    if (this.active || this.transition) throw sandboxError('sandbox_busy');
    this.transition = (async () => {
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
    })().finally(() => { this.transition = null; });
    return this.transition;
  }
  async _resources() {
    if (!this.receipts) this.receipts = new ExecutionReceipts(this.directory);
    if (!this.launcher) this.launcher = this.launcherFactory({ ownerId: this.receipts.ownerId, platform: this.platform });
    await this.launcher.detect();
  }
  async _reconcile() {
    await this._resources();
    const owned = await this.launcher.listOwned();
    for (const id of owned) {
      try { await this.launcher.stopAndRemove(id); }
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
    if (!this.enabled || this.state !== 'ready' || this.active || this.transition || this.closing) throw sandboxError('sandbox_unavailable');
    if (!context.sessionId || !context.streamId || !context.callId || context.readOnly || context.planMode) throw sandboxError('sandbox_authority_invalid');
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
    operation.promise = this._execute(args, { ...context, signal: controller.signal }, authorize, requestId)
      .finally(() => {
        context.signal?.removeEventListener('abort', abort);
        if (this.active === operation) this.active = null;
        if (this.state === 'busy') this._publish('ready');
      });
    return operation.promise;
  }
  async _execute(args, context, authorize, requestId) {
    const root = this._root();
    if (!root) throw sandboxError('sandbox_workspace_required');
    const generation = this.generation;
    const workspaceGeneration = this.workspaceGeneration;
    const binding = { request_id: requestId, session_id: context.sessionId, stream_id: context.streamId,
      tool_call_id: context.callId, command_digest: digest(args), policy_generation: generation,
      workspace_id: digest(path.resolve(root)), workspace_generation: workspaceGeneration };
    let snapshot;
    let worker;
    let result;
    let failure;
    const live = () => {
      if (context.signal.aborted || this.closing || !this.enabled || generation !== this.generation
        || workspaceGeneration !== this.workspaceGeneration || root !== this._root()
        || context.isLive?.() === false) throw sandboxError('sandbox_stale_authority');
    };
    try {
      live();
      snapshot = await this.snapshot({ root, stagingRoot: this.stagingRoot, forbiddenRoots: [this.userDataPath], signal: context.signal });
      Object.assign(binding, { snapshot_id: snapshot.id, snapshot_digest: snapshot.digest });
      if (snapshot.rootIdentity) binding.workspace_id = snapshot.rootIdentity;
      live();
      worker = await this._worker(snapshot, binding);
      const ready = await worker.transport.request('status');
      Object.assign(binding, { job_id: randomUUID(), incarnation: ready.incarnation });
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
        streamId: context.streamId, jobId: binding.job_id, expectedIncarnation: binding.incarnation });
      this.receipts.append('terminal', { ...binding }, { ...result, stdout: String(result.stdout || '').slice(0, 8192), stderr: String(result.stderr || '').slice(0, 8192) });
    } catch (error) {
      if (this.receipts.pending().length || error.reason === 'sandbox_cleanup_unconfirmed') this._publish('recovery-required', error.reason || 'sandbox_execution_uncertain');
      else if (!['sandbox_approval_denied', 'sandbox_stale_authority'].includes(error.reason)) {
        this._publish('unavailable', error.reason || 'sandbox_execution_failed');
      }
      failure = error;
    } finally {
      if (snapshot) {
        try {
          if (worker) { await this.launcher.stopAndRemove(worker.containerId); worker.transport.dispose(); }
          if (worker || failure?.reason !== 'sandbox_cleanup_unconfirmed') await removeSnapshot({ directory: snapshot.directory, stagingRoot: this.stagingRoot });
        } catch (error) {
          this._publish('recovery-required', error.reason || 'sandbox_cleanup_unconfirmed');
          failure = error;
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
    if (this.launcher) await this._reconcile();
    this.configService?.removeListener?.('changed', this.onConfigChanged);
  }
}
module.exports = { DesktopSandboxService };