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
    selectWorkload = selectWorkloadProfile, hostResources = null } = {}) {
    this._native = nativeClient;
    this._diagnostics = diagnostics;
    this._platform = platform;
    this._architecture = architecture;
    this._now = now;
    this._selectWorkload = selectWorkload;
    this._hostResources = hostResources;
    this._disposed = false;
  }

  async _cleanupStartAttempt({ sessionId, sessionEpoch, reason, handle }) {
    try {
      return await this.terminate({ session_id: sessionId, session_epoch: sessionEpoch, reason });
    } catch (_error) {
      return { ok: false, reason: 'supervisor_terminate_failed',
        resource_cleanup: this._hostResources?.quarantine(handle, reason) };
    }
  }

  async start({ authority, executable, identity, sessionId, sessionEpoch, signal,
    validateResourceAuthority = null } = {}) {
    const unavailable = () => this._disposed || signal?.aborted;
    const noStart = (result) => ({ ...(result || { ok: false }), no_start: true });
    if (unavailable()) return noStart({ ok: false, reason: 'supervisor_unavailable' });
    let capabilities;
    try {
      capabilities = await this._native?.capabilities?.({ validateResourceAuthority });
    } catch (error) {
      return noStart({ ok: false, reason: String(error?.message || 'supervisor_unavailable') });
    }
    if (unavailable()) return noStart({ ok: false, reason: 'supervisor_unavailable' });
    const containment = selectContainmentProfile({
      platform: this._platform, supervisorCapabilities: capabilities?.capabilities,
    });
    if (!containment.ok) return noStart(containment);
    const workload = await this._selectWorkload({
      identity,
      platform: this._platform,
      architecture: this._architecture,
    });
    if (unavailable()) return noStart({ ok: false, reason: 'supervisor_unavailable' });
    if (!workload?.ok) return noStart(workload
      || { ok: false, reason: 'workload_profile_unavailable' });
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
    if (unavailable()) return noStart({ ok: false, reason: 'supervisor_unavailable' });
    if (typeof this._native?.start !== 'function') {
      return noStart({ ok: false, reason: 'supervisor_unavailable' });
    }
    const admission = this._hostResources?.tryStart?.({ sessionId, sessionEpoch, identity,
      signal, validate: validateResourceAuthority });
    if (admission && !admission.ok) {
      return { ...admission, session_id: sessionId, session_epoch: sessionEpoch };
    }
    const handle = admission?.handle || null;
    if (unavailable()) {
      const resourceCleanup = handle
        ? this._hostResources.settleNoStart(handle, 'supervisor_unavailable') : null;
      return { ok: false, reason: 'supervisor_unavailable', session_id: sessionId,
        session_epoch: sessionEpoch, no_start: true, ...(resourceCleanup
          ? { resource_cleanup: resourceCleanup } : {}) };
    }
    if (handle && this._hostResources.markAttempted(handle) !== true) {
      const resourceCleanup = this._hostResources.settleNoStart(
        handle, 'native_host_resource_binding_invalid'
      );
      return { ok: false, reason: 'native_host_resource_binding_invalid', no_start: true,
        session_id: sessionId, session_epoch: sessionEpoch,
        resource_cleanup: resourceCleanup };
    }
    let result;
    try {
      result = await this._native?.start?.(request, { signal, validateResourceAuthority });
    } catch (error) {
      if (!handle) throw error;
      const termination = await this._cleanupStartAttempt({ sessionId, sessionEpoch,
        reason: 'supervisor_start_failed', handle });
      return { ok: false, reason: String(error?.message || 'supervisor_start_failed'),
        session_id: sessionId, session_epoch: sessionEpoch, termination,
        resource_cleanup: termination.resource_cleanup };
    }
    if (handle && !result?.ok) {
      const termination = await this._cleanupStartAttempt({ sessionId, sessionEpoch,
        reason: 'supervisor_start_failed', handle });
      return { ...(result || { ok: false, reason: 'supervisor_start_failed' }),
        session_id: sessionId, session_epoch: sessionEpoch, termination,
        resource_cleanup: termination.resource_cleanup };
    }
    if (unavailable()) {
      let termination = null;
      if (result?.ok) {
        termination = await this._cleanupStartAttempt({ sessionId, sessionEpoch,
          reason: 'startup_cancelled', handle });
      }
      return { ok: false, reason: 'supervisor_unavailable', session_id: sessionId,
        session_epoch: sessionEpoch, ...(termination ? { termination,
          resource_cleanup: termination.resource_cleanup } : {}) };
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
      const termination = await this._cleanupStartAttempt({ sessionId, sessionEpoch,
        reason: 'launch_attestation_rejected', handle });
      if (unavailable()) return { ok: false, reason: 'supervisor_unavailable',
        session_id: sessionId, session_epoch: sessionEpoch, termination,
        ...(termination?.resource_cleanup
          ? { resource_cleanup: termination.resource_cleanup } : {}) };
      this._diagnostics?.record('ERROR', 'launch_attestation_rejected', authority);
      return { ok: false, reason: 'launch_attestation_rejected', session_id: sessionId,
        session_epoch: sessionEpoch, termination,
        ...(termination?.resource_cleanup
          ? { resource_cleanup: termination.resource_cleanup } : {}) };
    }
    return { ok: true, receipt: Object.freeze(receipt), channel: result.channel,
      workload_profile: workload.profile, workload_profile_digest: workload.profile_digest,
      ...(handle ? { resource_cleanup: Object.freeze({ required: true, cleanup: 'active' }) }
        : {}) };
  }

  async terminate(request) {
    let result;
    if (!this._native?.terminate) result = { ok: false, reason: 'supervisor_unavailable' };
    else {
      try { result = await this._native.terminate(request); }
      catch (error) {
        if (!this._hostResources?.required) throw error;
        result = { ok: false, reason: String(error?.message || 'supervisor_terminate_failed') };
      }
    }
    const normalized = result?.ok ? { ...result, terminated: result.reaped === true,
      tree_empty: result.tree_empty === true,
      output_readers_terminated: result.output_readers_terminated === true } : result;
    const resourceCleanup = this._hostResources?.settleTermination?.({
      sessionId: request?.session_id,
      sessionEpoch: request?.session_epoch,
      proof: normalized,
      reason: normalized?.reason,
    });
    return resourceCleanup ? { ...(normalized || { ok: false }),
      resource_cleanup: resourceCleanup } : normalized;
  }
  async reconcile(receipt) {
    const result = this._native?.reconcile
      ? await this._native.reconcile(receipt)
      : { ok: false, reason: 'supervisor_unavailable' };
    const normalized = result?.ok ? { ...result, terminated: result.reaped === true,
      tree_empty: result.tree_empty === true,
      output_readers_terminated: result.output_readers_terminated === true } : result;
    const resourceCleanup = this._hostResources?.settleTermination?.({
      sessionId: receipt?.session_id,
      sessionEpoch: receipt?.session_epoch,
      proof: normalized,
      reason: normalized?.reason,
    });
    return resourceCleanup ? { ...(normalized || { ok: false }),
      resource_cleanup: resourceCleanup } : normalized;
  }
  async acknowledgeTermination(request) {
    if (!this._native?.acknowledgeTermination) {
      return { ok: false, reason: 'supervisor_unavailable' };
    }
    return this._native.acknowledgeTermination(request);
  }
  quiesce() {
    if (this._disposed) return Promise.resolve({ ok: false, reason: 'supervisor_unavailable' });
    return this._native?.quiesce?.() || Promise.resolve({ ok: true, already_absent: true });
  }
  reopenAfterQuiesce() {
    if (this._disposed) return { ok: false, reason: 'supervisor_unavailable' };
    return this._native?.reopenAfterQuiesce?.() || { ok: true };
  }
  async dispose() { this._disposed = true; return this._native?.dispose?.(); }
}

module.exports = { digest, FullHostProcessSupervisor };
