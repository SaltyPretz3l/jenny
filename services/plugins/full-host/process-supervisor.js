'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { selectContainmentProfile } = require('./containment-profile');
const {
  nativeWorkloadProfile,
  selectWorkloadProfile,
} = require('./workload-profile');

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

class FullHostProcessSupervisor {
  constructor({ nativeClient, diagnostics, platform = process.platform,
    architecture = process.arch, now = () => new Date().toISOString(),
    selectWorkload = selectWorkloadProfile } = {}) {
    this._native = nativeClient;
    this._diagnostics = diagnostics;
    this._platform = platform;
    this._architecture = architecture;
    this._now = now;
    this._selectWorkload = selectWorkload;
    this._disposed = false;
  }

  async start({ authority, executable, identity, sessionId, sessionEpoch, signal } = {}) {
    const unavailable = () => this._disposed || signal?.aborted;
    if (unavailable()) return { ok: false, reason: 'supervisor_unavailable' };
    const capabilities = await this._native?.capabilities?.();
    if (unavailable()) return { ok: false, reason: 'supervisor_unavailable' };
    const containment = selectContainmentProfile({
      platform: this._platform, supervisorCapabilities: capabilities?.capabilities,
    });
    if (!containment.ok) return containment;
    const workload = await this._selectWorkload({
      identity,
      platform: this._platform,
      architecture: this._architecture,
    });
    if (unavailable()) return { ok: false, reason: 'supervisor_unavailable' };
    if (!workload?.ok) return workload || { ok: false, reason: 'workload_profile_unavailable' };
    const capabilityList = [...(capabilities?.capabilities || [])].sort();
    const launchContext = {
      publisher_id: identity?.publisher_id,
      plugin_id: identity?.plugin_id,
      contribution_id: identity?.contribution_id,
      artifact_digest: identity?.artifact_digest,
      registry_revision: authority?.registry_revision,
      dependency_graph_hash: authority?.dependency_graph_hash,
      commit_epoch: authority?.commit_epoch,
      active_generation_id: authority?.active_generation_id,
      launch_nonce_digest: digest(crypto.randomBytes(32)),
      containment_profile: containment.profile,
      containment_capabilities_digest: digest(JSON.stringify(capabilityList)),
      created_at: this._now(),
    };
    const request = {
      authority, executable_digest: executable?.digest, executable_path: executable?.path,
      session_id: sessionId, session_epoch: sessionEpoch,
      launch_context_json: JSON.stringify(launchContext),
      workload_profile_json: JSON.stringify(nativeWorkloadProfile(workload, identity)),
    };
    if (unavailable()) return { ok: false, reason: 'supervisor_unavailable' };
    const result = await this._native?.start?.(request, { signal });
    if (unavailable()) {
      if (result?.ok) {
        await this._native?.terminate?.({ session_id: sessionId, session_epoch: sessionEpoch,
          reason: 'startup_cancelled' });
      }
      return { ok: false, reason: 'supervisor_unavailable' };
    }
    const checked = validate('PluginFullHostAttestationV6', result?.receipt);
    const receipt = checked.ok ? checked.value : null;
    const contextMatches = receipt && Object.entries(launchContext).every(
      ([field, value]) => receipt[field] === value
    );
    if (!result?.ok || !receipt || !contextMatches
      || receipt.executable_digest !== executable?.digest
      || receipt.observed_executable_digest !== executable?.digest
      || receipt.session_id !== sessionId || receipt.session_epoch !== sessionEpoch) {
      await this._native?.terminate?.({ session_id: sessionId, session_epoch: sessionEpoch,
        reason: 'launch_attestation_rejected' });
      if (unavailable()) return { ok: false, reason: 'supervisor_unavailable' };
      this._diagnostics?.record('ERROR', 'launch_attestation_rejected', authority);
      return { ok: false, reason: 'launch_attestation_rejected' };
    }
    return { ok: true, receipt: Object.freeze(receipt), channel: result.channel,
      workload_profile: workload.profile, workload_profile_digest: workload.profile_digest };
  }

  async terminate(request) {
    if (!this._native?.terminate) return { ok: false, reason: 'supervisor_unavailable' };
    const result = await this._native.terminate(request);
    return result?.ok ? { ...result, terminated: result.reaped === true,
      tree_empty: result.tree_empty === true } : result;
  }
  reconcile(receipt) { return this._native?.reconcile?.(receipt) || Promise.resolve({ ok: false, reason: 'supervisor_unavailable' }); }
  async dispose() { this._disposed = true; await this._native?.dispose?.(); }
}

module.exports = { digest, FullHostProcessSupervisor };
