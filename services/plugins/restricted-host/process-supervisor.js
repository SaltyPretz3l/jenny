'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const { spawn: nodeSpawn } = require('node:child_process');
const { validate } = require('../contracts/generated-plugin-contracts');
const { AuthenticatedChannel, MAX_LOAD_FRAME_BYTES } = require('./authenticated-channel');
const {
  initialSettlementState,
  reduceFrame,
  acknowledgeFrames,
} = require('../protocol/frame-settlement');

const BOOTSTRAP_DEADLINE_MS = 2000;
const LOAD_ACCEPTANCE_DEADLINE_MS = 5000;
const LOAD_DEADLINE_MS = 30000;
const SHUTDOWN_GRACE_MS = 1000;
const FORCED_EXIT_MS = 3000;
const MAX_COMPONENT_BYTES = 64 * 1024 * 1024;

function id(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64); }
function pipeAddress(endpoint, platform = process.platform) {
  if (platform === 'win32') return `\\\\.\\pipe\\${endpoint}`;
  if (platform === 'linux') return `\0${endpoint}`;
  return `/tmp/${endpoint}`;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function restrictedHostSpawnOptions(platform = process.platform, env = process.env) {
  return {
    cwd: os.tmpdir(),
    env: platform === 'win32' && env.SystemRoot ? { SystemRoot: env.SystemRoot } : {},
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: false,
  };
}
function withDeadline(promise, ms, reason) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })])
    .finally(() => clearTimeout(timer));
}

async function connectWithRetry(endpoint, { connect = net.createConnection, platform = process.platform } = {}) {
  const deadline = Date.now() + BOOTSTRAP_DEADLINE_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = connect(pipeAddress(endpoint, platform));
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    } catch (error) { lastError = error; await delay(20); }
  }
  throw lastError || new Error('restricted_host_connect_timeout');
}

class RestrictedHostProcessSupervisor {
  constructor({ resolveRuntime, spawn = nodeSpawn, connect = net.createConnection,
    diagnostics, crashCircuit, capabilityBroker = null, onCircuitOpen = null,
    platform = process.platform } = {}) {
    this._resolveRuntime = resolveRuntime; this._spawn = spawn; this._connect = connect;
    this._diagnostics = diagnostics; this._crashCircuit = crashCircuit;
    this._capabilityBroker = capabilityBroker; this._onCircuitOpen = onCircuitOpen;
    this._platform = platform;
    this._hosts = new Set(); this._disposed = false;
  }

  async start(identity, componentBytes, { signal = null } = {}) {
    if (this._disposed || !Buffer.isBuffer(componentBytes)
      || componentBytes.length === 0 || componentBytes.length > MAX_COMPONENT_BYTES
      || signal?.aborted) {
      return { ok: false, reason: 'restricted_host_start_invalid' };
    }
    if (this._crashCircuit?.isOpen(identity)) return { ok: false, reason: 'restricted_host_circuit_open' };
    const runtime = await this._resolveRuntime();
    if (!runtime.ok) return runtime;
    const processInstanceId = id('proc'); const channelId = id('channel');
    const endpoint = `jenny-plugin-${crypto.randomUUID().replace(/-/g, '')}`; const key = crypto.randomBytes(32);
    const launchNonce = crypto.randomBytes(32).toString('hex');
    const child = this._spawn(runtime.binary_path, ['--endpoint', endpoint],
      restrictedHostSpawnOptions(this._platform));
    let expectedExit = false;
    const abortStartup = () => {
      expectedExit = true;
      if (!child.killed) child.kill();
    };
    signal?.addEventListener('abort', abortStartup, { once: true });
    child.stderr?.resume();
    const host = { child, identity, process_instance_id: processInstanceId, channel_id: channelId,
      alive: true, restart_delay_ms: null,
      expectedExit: () => expectedExit };
    this._hosts.add(host);
    child.once('exit', () => {
      host.alive = false;
      this._hosts.delete(host);
      const circuit = this._crashCircuit?.record(identity, { expected: expectedExit });
      host.restart_delay_ms = circuit?.restart_delay_ms ?? null;
      this._diagnostics?.record(expectedExit ? 'INFO' : 'WARN', 'process_exit', identity,
        { expected: expectedExit, circuit_open: circuit?.open === true, crash_count: circuit?.crash_count || 0 });
      if (circuit?.open === true && typeof this._onCircuitOpen === 'function') {
        Promise.resolve(this._onCircuitOpen(identity)).catch(() => {
          this._diagnostics?.record('WARN', 'quarantine_failed', identity,
            { reason_code: 'restricted_host_quarantine_failed' });
        });
      }
    });
    try {
      const socket = await withDeadline(connectWithRetry(endpoint, { connect: this._connect, platform: this._platform }),
        BOOTSTRAP_DEADLINE_MS, 'restricted_host_bootstrap_timeout');
      const channel = new AuthenticatedChannel(socket, { key, channelId });
      const bootstrap = {
        bootstrap_schema_version: 1, process_key: key.toString('hex'), process_instance_id: processInstanceId,
        launch_nonce: launchNonce, host_digest: runtime.binary_digest,
        protocol_digest: identity.protocol_digest, abi_digest: identity.abi_digest,
        publisher_id: identity.publisher_id, plugin_id: identity.plugin_id,
        contribution_id: identity.contribution_id, artifact_digest: identity.artifact_digest,
        component_digest: identity.component_digest, generation_id: identity.generation_id,
        commit_epoch: identity.commit_epoch, lifecycle_epoch: identity.lifecycle_epoch, channel_id: channelId,
      };
      channel.writeBootstrap(bootstrap);
      channel.send('load', { component_b64: componentBytes.toString('base64') }, MAX_LOAD_FRAME_BYTES);
      const loadAccepted = await withDeadline(channel.receive({ kind: 'load_accepted' }),
        LOAD_ACCEPTANCE_DEADLINE_MS, 'restricted_host_load_acceptance_timeout');
      if (loadAccepted.payload?.ok !== true) throw new Error('restricted_host_load_rejected');
      const attested = await withDeadline(channel.receive({ kind: 'attestation' }),
        LOAD_DEADLINE_MS, 'restricted_host_load_timeout');
      const checked = validate('PluginRestrictedHostAttestationV4', attested.payload);
      const expected = { ...bootstrap, attestation_schema_version: 4, backend_version: '47.0.3' };
      delete expected.bootstrap_schema_version; delete expected.process_key;
      if (!checked.ok || Object.keys(expected).some((keyName) => checked.value[keyName] !== expected[keyName])) {
        throw new Error('restricted_host_attestation_rejected');
      }
      if (signal?.aborted) throw new Error('restricted_host_start_aborted');
      signal?.removeEventListener('abort', abortStartup);
      host.channel = channel;
      host.invoke = async (inputJson, timeoutMs, invocation = {}) => {
        const invocationId = String(invocation.invocation_id || '');
        const deadlineEpochMs = Date.now() + timeoutMs + 1000;
        channel.send('invoke', {
          input_json: inputJson,
          timeout_ms: timeoutMs,
          invocation_id: invocationId,
          operation_id: String(invocation.operation_id || ''),
          cancellation_id: String(invocation.cancellation_id || ''),
          token_id: String(invocation.token_id || ''),
        });
        let settlement = initialSettlementState({
          invocationId,
          commitEpoch: identity.commit_epoch,
          lifecycleEpoch: identity.lifecycle_epoch,
          maxStreamFrames: 256,
          maxFrameUtf8Bytes: 8192,
          maxStreamTotalUtf8Bytes: 65536,
          maxUnackedFrames: 8,
          deadlineEpochMs,
        });
        while (true) {
          const remainingMs = deadlineEpochMs - Date.now();
          if (remainingMs <= 0) throw new Error('restricted_host_invocation_timeout');
          const received = await withDeadline(channel.receive(), remainingMs,
            'restricted_host_invocation_timeout');
          if (received.kind === 'terminal') {
            if (!settlement.terminal
              || settlement.terminal.status !== received.payload?.status) {
              throw new Error('restricted_host_terminal_mismatch');
            }
            if (received.payload?.status === 'succeeded') {
              const resultDigest = crypto.createHash('sha256')
                .update(String(received.payload.result_json || ''), 'utf8').digest('hex');
              if (settlement.terminal.result_digest !== resultDigest) {
                throw new Error('restricted_host_terminal_digest_mismatch');
              }
            }
            return { ...received.payload, stream_state: settlement };
          }
          if (received.kind === 'capability_call') {
            if (!this._capabilityBroker || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(
              String(received.payload?.call_id || '')
            )) {
              throw new Error('restricted_host_capability_call_rejected');
            }
            const brokered = await this._capabilityBroker.handle(
              received.payload,
              invocation,
              { signal: invocation.signal || null }
            );
            channel.send('capability_result', {
              call_id: received.payload.call_id,
              ok: brokered.ok === true,
              payload_json: JSON.stringify(brokered.ok ? brokered.payload || {} : {}),
              reason_code: brokered.ok ? null : String(
                brokered.reason || 'capability_call_failed'
              ).slice(0, 64),
            });
            continue;
          }
          if (received.kind !== 'stream') throw new Error('restricted_host_frame_kind_rejected');
          const reduced = reduceFrame(settlement, received.payload, Date.now());
          if (!reduced.ok) throw new Error(reduced.error.code);
          settlement = acknowledgeFrames(reduced.state, received.payload.sequence);
          channel.send('stream_ack', {
            invocation_id: invocationId,
            sequence: received.payload.sequence,
          });
        }
      };
      host.cancel = () => {
        if (expectedExit) return;
        expectedExit = true;
        channel.destroy();
        if (!child.killed) child.kill();
      };
      host.shutdown = async () => {
        if (expectedExit) return;
        expectedExit = true;
        try { channel.send('shutdown', {}); await withDeadline(channel.receive({ kind: 'shutdown_complete' }), SHUTDOWN_GRACE_MS, 'shutdown_timeout'); }
        catch (_error) { /* kill below if process remains */ }
        if (!child.killed) child.kill();
      };
      this._diagnostics?.record('INFO', 'attested', identity, { process_instance_id: processInstanceId, state: 'inactive_ready' });
      return { ok: true, host };
    } catch (_error) {
      signal?.removeEventListener('abort', abortStartup);
      expectedExit = true; if (!child.killed) child.kill(); this._hosts.delete(host);
      this._diagnostics?.record('WARN', 'startup_rejected', identity, { reason_code: 'restricted_host_startup_rejected' });
      return { ok: false, reason: 'restricted_host_startup_rejected' };
    }
  }

  async dispose() {
    this._disposed = true;
    await Promise.all([...this._hosts].map(async (host) => {
      await host.shutdown?.();
      if (!host.child.killed) { await delay(FORCED_EXIT_MS); host.child.kill(); }
    }));
  }
}

module.exports = {
  BOOTSTRAP_DEADLINE_MS, LOAD_ACCEPTANCE_DEADLINE_MS, LOAD_DEADLINE_MS,
  SHUTDOWN_GRACE_MS, FORCED_EXIT_MS,
  pipeAddress, connectWithRetry, RestrictedHostProcessSupervisor,
  MAX_COMPONENT_BYTES, restrictedHostSpawnOptions,
};
