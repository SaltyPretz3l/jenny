'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeSupervisorClient } = require(
  '../../../services/plugins/full-host/native-supervisor-client'
);
const { FullHostProcessSupervisor } = require(
  '../../../services/plugins/full-host/process-supervisor'
);
const { HostSessionManager } = require(
  '../../../services/plugins/full-host/host-session-manager'
);
const { CrashQuarantineController } = require(
  '../../../services/plugins/full-host/crash-quarantine-controller'
);

const ENABLED = process.env.JENNY_STAGE8_NATIVE_INTEGRATION === '1';
const ROOT = path.resolve(__dirname, '../../..');

test('real Windows supervisor launches, invokes, delivers on the secret pipe, and reaps',
  { skip: !ENABLED || process.platform !== 'win32', timeout: 60_000 }, async () => {
    const target = path.join(ROOT, 'native', 'plugin-full-host-supervisor', 'target', 'debug');
    const supervisorPath = path.join(target, 'plugin-full-host-supervisor.exe');
    const hostPath = path.join(target, 'stage8_conformance_host.exe');
    const executableDigest = crypto.createHash('sha256').update(fs.readFileSync(hostPath)).digest('hex');
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-content-'));
    const storedHostPath = path.join(contentDir, 'blob');
    fs.copyFileSync(hostPath, storedHostPath);
    const client = new NativeSupervisorClient({ executablePath: supervisorPath, timeoutMs: 10_000 });
    const supervisor = new FullHostProcessSupervisor({ nativeClient: client, platform: 'win32',
      now: () => '2026-08-09T00:00:00Z' });
    const authority = { registry_revision: 4, dependency_graph_hash: 'a'.repeat(64),
      commit_epoch: 5, active_generation_id: 'generation-native-smoke' };
    const identity = { publisher_id: 'jenny-official', plugin_id: 'stage8-conformance',
      contribution_id: 'conformance_engine_adapter', artifact_digest: executableDigest };
    try {
      const launched = await supervisor.start({ authority, identity,
        executable: { path: storedHostPath, digest: executableDigest },
        sessionId: 'session-native-smoke', sessionEpoch: 1 });
      assert.equal(launched.ok, true, launched.reason);
      const described = await launched.channel.request('describe', {
        kind: 'engine_adapter', authority, identity,
      });
      assert.equal(described.ok, true);
      assert.equal(described.descriptor.executable_digest, executableDigest);
      const secretReceipt = await client.deliverSecret({ session_id: 'session-native-smoke',
        session_epoch: 1, grant_id: 'synthetic-grant', secret: 'synthetic-stage8-secret' });
      assert.equal(secretReceipt.ok, true);
      const terminated = await supervisor.terminate({ session_id: 'session-native-smoke', session_epoch: 1,
        reason: 'integration_complete' });
      assert.equal(terminated.ok, true); assert.equal(terminated.tree_empty, true);
    } finally {
      await supervisor.dispose();
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });

test('real Windows supervisor cancels an in-flight host call by reaping its process tree',
  { skip: !ENABLED || process.platform !== 'win32', timeout: 60_000 }, async () => {
    const target = path.join(ROOT, 'native', 'plugin-full-host-supervisor', 'target', 'debug');
    const supervisorPath = path.join(target, 'plugin-full-host-supervisor.exe');
    const hostPath = path.join(target, 'stage8_conformance_host.exe');
    const executableDigest = crypto.createHash('sha256').update(fs.readFileSync(hostPath)).digest('hex');
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-cancel-'));
    const storedHostPath = path.join(contentDir, 'blob');
    fs.copyFileSync(hostPath, storedHostPath);
    const client = new NativeSupervisorClient({ executablePath: supervisorPath, timeoutMs: 15_000 });
    const supervisor = new FullHostProcessSupervisor({ nativeClient: client, platform: 'win32',
      now: () => '2026-08-09T00:00:00Z' });
    const authority = { registry_revision: 4, dependency_graph_hash: 'a'.repeat(64),
      commit_epoch: 5, active_generation_id: 'generation-native-cancel' };
    const identity = { publisher_id: 'jenny-official', plugin_id: 'stage8-conformance',
      contribution_id: 'conformance_engine_adapter', artifact_digest: executableDigest };
    try {
      const launched = await supervisor.start({ authority, identity,
        executable: { path: storedHostPath, digest: executableDigest },
        sessionId: 'session-native-cancel', sessionEpoch: 1 });
      assert.equal(launched.ok, true, launched.reason);
      const pending = launched.channel.request('engine_stream', { operation: 'start',
        requestId: 'cancel-owner-drill', authority,
        input: { prompt: '__jenny_stage8_wait_for_cancel__' } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const cancelled = await launched.channel.request('engine_stream', { operation: 'cancel',
        requestId: 'cancel-owner-drill', authority });
      assert.deepEqual(cancelled, { ok: true, cancelled: true });
      await assert.rejects(pending, /host_pipe_failed|host_read_failed/);
    } finally {
      await supervisor.dispose();
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });

test('a restarted Windows supervisor proves the prior named Job is absent',
  { skip: !ENABLED || process.platform !== 'win32', timeout: 60_000 }, async () => {
    const target = path.join(ROOT, 'native', 'plugin-full-host-supervisor', 'target', 'debug');
    const supervisorPath = path.join(target, 'plugin-full-host-supervisor.exe');
    const hostPath = path.join(target, 'stage8_conformance_host.exe');
    const executableDigest = crypto.createHash('sha256').update(fs.readFileSync(hostPath)).digest('hex');
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-restart-'));
    const storedHostPath = path.join(contentDir, 'blob');
    fs.copyFileSync(hostPath, storedHostPath);
    const first = new NativeSupervisorClient({ executablePath: supervisorPath, timeoutMs: 10_000 });
    const firstSupervisor = new FullHostProcessSupervisor({ nativeClient: first, platform: 'win32' });
    const authority = { registry_revision: 4, dependency_graph_hash: 'a'.repeat(64),
      commit_epoch: 5, active_generation_id: 'generation-native-restart' };
    const identity = { publisher_id: 'jenny-official', plugin_id: 'stage8-conformance',
      contribution_id: 'conformance_engine_adapter', artifact_digest: executableDigest };
    let second;
    try {
      const launched = await firstSupervisor.start({ authority, identity,
        executable: { path: storedHostPath, digest: executableDigest },
        sessionId: 'session-native-restart', sessionEpoch: 9 });
      assert.equal(launched.ok, true, launched.reason);
      const exited = new Promise((resolve) => first._child.once('exit', resolve));
      first._child.kill();
      await exited;
      second = new NativeSupervisorClient({ executablePath: supervisorPath, timeoutMs: 10_000 });
      const proof = await second.terminate({ session_id: 'session-native-restart',
        session_epoch: 9, reason: 'startup_cleanup_reconciliation' });
      assert.equal(proof.ok, true);
      assert.equal(proof.known, true);
      assert.equal(proof.tree_empty, true);
      assert.equal(proof.surviving_process_count, 0);
    } finally {
      await firstSupervisor.dispose();
      await second?.dispose();
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });

test('real host crashes quarantine after three exits and explicit verified repair restores launch',
  { skip: !ENABLED || process.platform !== 'win32', timeout: 60_000 }, async () => {
    const target = path.join(ROOT, 'native', 'plugin-full-host-supervisor', 'target', 'debug');
    const supervisorPath = path.join(target, 'plugin-full-host-supervisor.exe');
    const hostPath = path.join(target, 'stage8_conformance_host.exe');
    const executableDigest = crypto.createHash('sha256').update(fs.readFileSync(hostPath)).digest('hex');
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-crash-'));
    const storedHostPath = path.join(contentDir, 'blob');
    fs.copyFileSync(hostPath, storedHostPath);
    const identity = { publisher_id: 'jenny-official', plugin_id: 'stage8-conformance',
      contribution_id: 'conformance_engine_adapter', artifact_digest: executableDigest,
      executable_digest: executableDigest };
    const authority = { registry_revision: 4, dependency_graph_hash: 'a'.repeat(64),
      commit_epoch: 5, active_generation_id: 'generation-native-crash' };
    const crash = new CrashQuarantineController({ limit: 3, persist: async () => {} });
    let manager;
    let epoch = 0;
    const client = new NativeSupervisorClient({ executablePath: supervisorPath, timeoutMs: 10_000,
      onHostExit: async ({ session_id: sessionId, reason }) => {
        await manager.handleUnexpectedExit(sessionId, reason, () => crash.recordCrash(identity));
      } });
    const supervisor = new FullHostProcessSupervisor({ nativeClient: client, platform: 'win32' });
    manager = new HostSessionManager({
      startSession: async () => {
        if (crash.isQuarantined(identity)) return { ok: false, reason: 'full_host_quarantined' };
        epoch += 1;
        const sessionId = `session-native-crash-${epoch}`;
        const launched = await supervisor.start({ authority, identity,
          executable: { path: storedHostPath, digest: executableDigest },
          sessionId, sessionEpoch: epoch });
        return launched.ok ? { ok: true, session: { session_id: sessionId,
          session_epoch: epoch, channel: launched.channel } } : launched;
      },
      terminateSession: (active, reason) => supervisor.terminate({
        session_id: active.session_id, session_epoch: active.session_epoch, reason,
      }),
    });
    try {
      for (let index = 1; index <= 3; index += 1) {
        const acquired = await manager.acquire({ authority,
          contributionId: identity.contribution_id, descriptor: identity });
        assert.equal(acquired.ok, true, acquired.reason);
        await assert.rejects(acquired.session.channel.request('engine_stream', {
          operation: 'start', requestId: `crash-owner-drill-${index}`, authority,
          input: { prompt: '__jenny_stage8_crash__' },
        }), /host_pipe_failed|host_read_failed/);
        assert.equal(manager.snapshot().active, 0);
      }
      assert.equal(crash.isQuarantined(identity), true);
      const blocked = await manager.acquire({ authority,
        contributionId: identity.contribution_id, descriptor: identity });
      assert.deepEqual(blocked, { ok: false, reason: 'full_host_quarantined' });

      await crash.clearAfterVerifiedUpgrade(identity);
      const recovered = await manager.acquire({ authority,
        contributionId: identity.contribution_id, descriptor: identity });
      assert.equal(recovered.ok, true, recovered.reason);
      const described = await recovered.session.channel.request('describe', {
        kind: 'engine_adapter', authority, identity,
      });
      assert.equal(described.ok, true);
      const terminated = await manager.terminate({ authority,
        contributionId: identity.contribution_id,
        publisherId: identity.publisher_id, pluginId: identity.plugin_id,
        reason: 'verified_repair_complete' });
      assert.equal(terminated.tree_empty, true);
    } finally {
      await manager.dispose();
      await supervisor.dispose();
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });
