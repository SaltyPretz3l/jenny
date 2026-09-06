'use strict';

const crypto = require('node:crypto');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { readCommittedState } = require('../lifecycle/commit-sequence');
const { buildCandidatePlugins } = require('../lifecycle/activation-operation');
const { stableStringify } = require('../package/canonical-metadata');
const { evaluateAdvisories } = require('../distribution/advisory-policy');
const { digestText, normalizeDestination } = require('../network/destination-policy');
const { reverifyInstalledPackage } = require('../runtime/declarative-compiler');
const { readNetworkConsent, brokerConsentFor } = require('../store/network-consent-store');
const { readRemoteMcpAuthorization } = require('../store/remote-mcp-authorization-store');
const { readRemoteMcpBinding } = require('../store/remote-mcp-binding-store');
const { getEvidence } = require('../store/distribution-evidence-store');

const ZERO_DIGEST = '0'.repeat(64);

function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function fail(reason, code = PLUGIN_ERROR_CODES.POLICY_BLOCKED) {
  return { ok: false, code, reason, retryable: false };
}

function authProfileRef({ publisherId, pluginId, contributionId, descriptorDigest,
  endpointOriginDigest }) {
  return hash(stableStringify({
    publisher_id: publisherId,
    plugin_id: pluginId,
    contribution_id: contributionId,
    descriptor_digest: descriptorDigest,
    endpoint_origin_digest: endpointOriginDigest,
  }));
}

function descriptorContent(verdict, contributionId) {
  return (verdict?.declarative_contents || []).find((item) => (
    item.contribution_id === contributionId && item.payload?.kind === 'mcp_descriptor'
  )) || null;
}

function bindingDraft({ entry, contribution, content, generationId, commitEpoch, consentDigest }) {
  const destination = normalizeDestination(content.payload.endpoint_url, { allowLoopbackHttp: true });
  if (!destination.ok) return fail(destination.reason);
  const observedOriginDigest = digestText(destination.url.origin);
  if (observedOriginDigest !== content.payload.endpoint_origin_digest) {
    return fail('remote_endpoint_origin_digest_mismatch');
  }
  const descriptorDigest = contribution.content_sha256;
  return {
    ok: true,
    destination,
    binding: {
      binding_schema_version: 1,
      publisher_id: entry.publisher_id,
      plugin_id: entry.plugin_id,
      contribution_id: contribution.contribution_id,
      artifact_digest: entry.artifact_digest,
      generation_id: generationId,
      commit_epoch: commitEpoch,
      descriptor_digest: descriptorDigest,
      schema_digest: ZERO_DIGEST,
      endpoint_url: destination.url.href,
      endpoint_origin_digest: observedOriginDigest,
      destination_scope: content.payload.destination_scope,
      protocol_versions: content.payload.protocol_versions,
      feature_classes: content.payload.feature_classes,
      consent_digest: consentDigest,
      auth_profile_ref: authProfileRef({
        publisherId: entry.publisher_id,
        pluginId: entry.plugin_id,
        contributionId: contribution.contribution_id,
        descriptorDigest,
        endpointOriginDigest: observedOriginDigest,
      }),
      binding_digest: ZERO_DIGEST,
    },
  };
}

async function readInvocationAdvisoryPolicy({ facade, baseDir, entry }) {
  const evidence = await getEvidence(
    facade, baseDir, 'advisory', entry?.advisory_snapshot_digest
  );
  if (!evidence.ok) return fail(evidence.reason);
  const advisory = evaluateAdvisories(evidence.value, {
    publisher_id: entry.publisher_id,
    plugin_id: entry.plugin_id,
    version: entry.resolved_version,
    artifact_digest: entry.artifact_digest,
    publisher_key_id: entry.publisher_key_id,
  });
  if (!advisory.ok) return fail(advisory.reason);
  return {
    ok: true,
    advisory_status: ['block', 'quarantine'].includes(advisory.action)
      ? advisory.action : 'clear',
    revoked_artifact_digests: advisory.revoked_artifacts,
    revoked_descriptor_digests: new Set(),
  };
}

class RemoteMcpRuntimeAuthority {
  constructor({ facade, baseDir = '', remoteMcpService, credentialBroker,
    verifyPackage, now = () => new Date().toISOString(), log = () => {} } = {}) {
    this._facade = facade;
    this._baseDir = baseDir;
    this._remoteMcpService = remoteMcpService;
    this._credentialBroker = credentialBroker;
    this._verifyPackage = verifyPackage;
    this._now = now;
    this._log = log;
    this._authPolicies = new Map();
  }

  async _credential(binding, authPolicy) {
    if (authPolicy !== 'oauth_2_1') return { ok: true, credential: null, authority: null };
    const authorization = await readRemoteMcpAuthorization(
      this._facade, this._baseDir, binding.auth_profile_ref
    );
    if (!authorization.ok || authorization.authorization.state !== 'authorized') {
      return fail('remote_authorization_required', PLUGIN_ERROR_CODES.REMOTE_AUTH_REQUIRED);
    }
    const record = authorization.authorization;
    const authority = {
      publisher_id: binding.publisher_id,
      plugin_id: binding.plugin_id,
      contribution_id: binding.contribution_id,
      descriptor_digest: binding.descriptor_digest,
      resource_digest: record.resource_digest,
      issuer_digest: record.issuer_digest,
      auth_profile_ref: binding.auth_profile_ref,
    };
    const loaded = await this._credentialBroker.get(authority);
    return loaded.ok
      ? { ok: true, credential: loaded.credential, authority }
      : loaded;
  }

  async _consent(entry, content) {
    const stored = await readNetworkConsent(this._facade, this._baseDir);
    if (!stored.ok) return stored;
    const destination = new URL(content.payload.endpoint_url).origin;
    const consent = brokerConsentFor(stored.document, {
      publisherId: entry.publisher_id,
      pluginId: entry.plugin_id,
      destination,
      scope: content.payload.destination_scope,
    });
    return consent.granted
      ? { ok: true, consent, digest: stored.digest }
      : fail('remote_consent_required', PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  }

  async discover({ entry, contribution, content, generationId, commitEpoch, signal = null }) {
    const consent = await this._consent(entry, content);
    if (!consent.ok) return consent;
    const draft = bindingDraft({
      entry, contribution, content, generationId, commitEpoch, consentDigest: consent.digest,
    });
    if (!draft.ok) return draft;
    const credential = await this._credential(draft.binding, content.payload.auth_policy);
    if (!credential.ok) return credential;
    const operationId = `mcp_${hash(`${generationId}\0${contribution.contribution_id}`).slice(0, 32)}`;
    const result = await this._remoteMcpService.discover({
      bindingDraft: draft.binding,
      consent: consent.consent,
      credential: credential.credential,
      context: {
        request_id: `discover_${operationId}`.slice(0, 64),
        operation_id: operationId,
        deadline_epoch_ms: Date.now() + 120000,
        signal,
      },
    });
    if (result.ok) {
      for (const item of result.contributions) {
        this._authPolicies.set(item.namespaced_name, content.payload.auth_policy);
      }
    }
    return result;
  }

  async prepareCandidatePlugins({ snapshot, operation, publisherId, pluginId,
    generationId, commitEpoch, dependencyMap = new Map(), stage = 5 }) {
    const plugins = snapshot.plugins.map((entry) => ({ ...entry }));
    const target = plugins.find((entry) => (
      entry.publisher_id === publisherId && entry.plugin_id === pluginId
    ));
    if (!target) {
      return { ok: true, plugins };
    }
    if (snapshot.generation.generation_schema_version !== 3) {
      return { ok: true, plugins: buildCandidatePlugins(snapshot.plugins, {
        publisherId, pluginId, operation, dependencyMap, stage,
      }) };
    }
    const reverified = await reverifyInstalledPackage({
      facade: this._facade,
      baseDir: this._baseDir,
      pluginEntry: target,
      verifyPackage: this._verifyPackage,
      now: this._now(),
    });
    if (!reverified.ok) return fail(reverified.reason || 'package_record_unavailable');
    if (reverified.verdict.manifest?.manifest_schema_version !== 3) {
      return { ok: true, plugins: buildCandidatePlugins(snapshot.plugins, {
        publisherId, pluginId, operation, dependencyMap, stage,
      }) };
    }
    const enabled = operation === 'enable';
    target.desired_state = enabled ? 'active'
      : operation === 'quarantine' ? 'quarantined' : 'installed_disabled';
    target.effective_state = target.desired_state;
    target.remote_binding_digests = [];
    if (!enabled) return { ok: true, plugins };
    for (const contribution of reverified.verdict.manifest.contributions) {
      if (contribution.kind !== 'mcp_descriptor') continue;
      const content = descriptorContent(reverified.verdict, contribution.contribution_id);
      if (!content) return fail('remote_descriptor_content_missing');
      const discovered = await this.discover({
        entry: target,
        contribution,
        content,
        generationId,
        commitEpoch,
      });
      if (!discovered.ok) return discovered;
      target.remote_binding_digests.push(discovered.binding.binding_digest);
    }
    target.remote_binding_digests.sort();
    return { ok: true, plugins };
  }

  async compileBindings({ entry, verdict, generation, pointer }) {
    const runtimeBindings = [];
    for (const bindingDigest of entry.remote_binding_digests || []) {
      const stored = await readRemoteMcpBinding(
        this._facade, this._baseDir, bindingDigest
      );
      if (!stored.ok) return fail(stored.reason);
      const binding = stored.binding;
      if (binding.publisher_id !== entry.publisher_id
        || binding.plugin_id !== entry.plugin_id
        || binding.artifact_digest !== entry.artifact_digest
        || binding.generation_id !== generation.generation_id
        || binding.commit_epoch !== pointer.commit_epoch) {
        return fail('remote_binding_generation_mismatch');
      }
      let cached = this._remoteMcpService.descriptorForBinding(bindingDigest);
      if (!cached) {
        const contribution = verdict.manifest.contributions.find((item) => (
          item.contribution_id === binding.contribution_id && item.kind === 'mcp_descriptor'
        ));
        const content = contribution
          ? descriptorContent(verdict, contribution.contribution_id) : null;
        if (!contribution || !content) return fail('remote_descriptor_content_missing');
        const discovered = await this.discover({
          entry, contribution, content,
          generationId: generation.generation_id,
          commitEpoch: pointer.commit_epoch,
        });
        if (!discovered.ok) return discovered;
        if (discovered.binding.binding_digest !== bindingDigest) {
          return fail('remote_descriptor_rediscovery_changed');
        }
        cached = this._remoteMcpService.descriptorForBinding(bindingDigest);
      }
      if (!cached) return fail('remote_descriptor_rediscovery_required');
      runtimeBindings.push(cached.runtime_binding);
    }
    runtimeBindings.sort((left, right) => left.binding_digest.localeCompare(right.binding_digest));
    return { ok: true, runtimeBindings };
  }

  async execute(namespacedName, args, { signal = null, sessionId = '' } = {}) {
    const committed = await readCommittedState(this._facade, this._baseDir);
    const generation = committed.generation;
    const pointer = committed.pointer;
    // Resolve the name only among bindings the COMMITTED generation still
    // references: an older cached descriptor for the same name must not shadow
    // the currently committed one.
    const committedBindingDigests = new Set((generation?.plugins || [])
      .filter((item) => item.effective_state === 'active')
      .flatMap((item) => item.remote_binding_digests || []));
    const descriptor = this._remoteMcpService.descriptorForName(
      namespacedName, committedBindingDigests
    );
    if (!descriptor) return fail('remote_descriptor_rediscovery_required');
    const binding = descriptor.binding;
    const entry = generation?.plugins?.find((item) => (
      item.publisher_id === binding.publisher_id && item.plugin_id === binding.plugin_id
    ));
    if (!entry || !pointer || entry.effective_state !== 'active'
      || !entry.remote_binding_digests?.includes(binding.binding_digest)) {
      return fail('remote_descriptor_inactive');
    }
    const consent = await readNetworkConsent(this._facade, this._baseDir);
    if (!consent.ok) return consent;
    const advisoryPolicy = await readInvocationAdvisoryPolicy({
      facade: this._facade, baseDir: this._baseDir, entry,
    });
    if (!advisoryPolicy.ok) return advisoryPolicy;
    const policy = {
      stage5_enabled: true,
      consent_granted: consent.digest === binding.consent_digest,
      consent_digest: consent.digest,
      advisory_status: advisoryPolicy.advisory_status,
      authorization: this._authPolicies.get(namespacedName) === 'oauth_2_1'
        ? 'required' : 'none',
      revoked_artifact_digests: advisoryPolicy.revoked_artifact_digests,
      revoked_descriptor_digests: advisoryPolicy.revoked_descriptor_digests,
    };
    let authAuthority = null;
    if (policy.authorization === 'required') {
      const credential = await this._credential(binding, 'oauth_2_1');
      if (!credential.ok) return credential;
      authAuthority = credential.authority;
    }
    return this._remoteMcpService.invoke({
      binding,
      invocation: {
        binding_digest: binding.binding_digest,
        descriptor_digest: binding.descriptor_digest,
        namespaced_name: namespacedName,
      },
      current: {
        publisher_id: entry.publisher_id,
        plugin_id: entry.plugin_id,
        generation_id: generation.generation_id,
        artifact_digest: entry.artifact_digest,
        commit_epoch: pointer.commit_epoch,
        lifecycle_state: entry.effective_state,
        activation_scope: 'stage5_remote_mcp',
      },
      policy,
      arguments: args,
      context: { signal, session_id: String(sessionId || '').trim() },
      signal,
      authAuthority,
    });
  }

  networkCounters() {
    return this._remoteMcpService?.networkCounters?.() || {};
  }

  dispose() {
    this._authPolicies.clear();
  }
}

module.exports = {
  ZERO_DIGEST,
  authProfileRef,
  descriptorContent,
  bindingDraft,
  readInvocationAdvisoryPolicy,
  RemoteMcpRuntimeAuthority,
};
