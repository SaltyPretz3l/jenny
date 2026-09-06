'use strict';
const crypto = require('node:crypto');
const semver = require('semver');
const { validate } = require('../contracts/generated-plugin-contracts');
const { readActivePointer } = require('../store/active-pointer');
const { mintNextEpoch } = require('../store/commit-epoch');
const { createPendingReceipt, settleReceipt } = require('../store/operation-receipts');
const { putContent, getContent } = require('../store/content-store');
const { writePackageRecord } = require('../store/package-record-store');
const { putDataSnapshot } = require('../store/data-snapshot-store');
const { readDataState, writeDataState } = require('../store/data-state-store');
const { readDistributionState, writeDistributionState, createEmptyDistributionState } = require('../store/distribution-state-store');
const { putEvidence } = require('../store/distribution-evidence-store');
const { putSource, getSource } = require('../store/source-registry-store');
const { createOperationRecord, advanceOperationPhase, findOperationByFingerprint } = require('../store/distribution-operation-store');
const { getPartialCacheEntry, putPartialCacheEntry, discardPartialCacheEntry, putVerifiedCacheEntry } = require('../store/package-cache');
const { writeArtifactLease, releaseArtifactLease, readActiveArtifactDigests } = require('../store/artifact-lease-store');
const { runCommitSequence } = require('../lifecycle/commit-sequence');
const { readGeneration } = require('../store/generation-store');
const { appendJournalEntry } = require('../store/journal');
const { stableStringify } = require('../package/canonical-metadata');
const { verifyDistributionPackage } = require('../package/distribution-package-intake');
const { parseMigrations, findMigrationPath, applyMigrationPath } = require('../data/data-transition');
const { normalizeReusableUrl, normalizeOfflineRoot, digest, publicSourceIdentity } = require('./source-intake');
const { sourceTrustIsValid } = require('./production-context');
const { fingerprintOperation, redactedOperationRecord } = require('./distribution-operation');
const { buildVerificationCacheKey } = require('./verification-cache');
const { admitCandidate } = require('./advisory-policy');
const { solveDependencies } = require('./dependency-solver');
const { acquireGitPackage } = require('./git-source');
const { recordDigest, validateV3Generation, recoverDistribution } = require('./distribution-recovery');
const { enforceGenerationRetention } = require('./distribution-retention');
const { LIMITS } = require('./distribution-limits');
const ZERO_DIGEST = '0'.repeat(64);
const DISTRIBUTION_GENERATION_SCHEMA_VERSIONS = new Set([3, 4, 5, 6]);
function currentPolicyReference(context, generationSchemaVersion, fallback) {
  if (typeof context.currentPolicyReference === 'function') {
    return context.currentPolicyReference(generationSchemaVersion, fallback);
  }
  if (generationSchemaVersion === 6) return context.policyGrantRefV6 || fallback;
  if (generationSchemaVersion === 5) return context.policyGrantRefV5 || fallback;
  if (generationSchemaVersion === 4) return context.policyGrantRefV4 || fallback;
  return context.policyGrantRef || fallback;
}
const OPERATION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function hash(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : stableStringify(value), Buffer.isBuffer(value) ? undefined : 'utf8').digest('hex'); }
function fail(operationId, reason, detail = null) { return { ok: false, operation_id: operationId, reason, detail }; }
function isV3PluginEntry(plugin) {
  return ['package_record_digest', 'source_trust_digest', 'advisory_snapshot_digest', 'data_snapshot_digest']
    .every((field) => /^[0-9a-f]{64}$/.test(plugin?.[field] || ''))
    && Array.isArray(plugin?.remote_binding_digests);
}

function isV4PluginEntry(plugin) {
  return isV3PluginEntry(plugin) && Array.isArray(plugin?.restricted_module_digests);
}

function isV5PluginEntry(plugin) {
  return isV4PluginEntry(plugin) && Array.isArray(plugin?.view_content_digests)
    && Array.isArray(plugin?.provider_descriptor_digests);
}

const V6_DIGEST_FIELDS = Object.freeze([
  'executable_object_digests', 'full_host_binding_digests', 'native_mcp_binding_digests',
  'session_provider_digests', 'engine_adapter_digests', 'hook_descriptor_digests',
  'containment_profile_digests', 'build_provenance_digests',
]);
function isV6PluginEntry(plugin) {
  return isV5PluginEntry(plugin) && V6_DIGEST_FIELDS.every((field) => Array.isArray(plugin?.[field]));
}

function promotionPreservesAuthority(current, promoted, generationSchemaVersion = 3) {
  return ['publisher_id', 'plugin_id', 'display_name', 'resolved_version', 'publisher_key_id',
    'artifact_digest', 'desired_state', 'effective_state']
    .every((field) => promoted?.[field] === current?.[field])
    && (generationSchemaVersion === 6 ? isV6PluginEntry(promoted)
      : (generationSchemaVersion === 5 ? isV5PluginEntry(promoted)
      : (generationSchemaVersion === 4 ? isV4PluginEntry(promoted) : isV3PluginEntry(promoted))));
}
class DistributionController {
  constructor({ facade, baseDir, networkBroker, mintOperationId, now = () => new Date().toISOString(),
    realpath, runCommit = runCommitSequence, recoverStore = recoverDistribution,
    gitAcquire = acquireGitPackage, onCommitted = null } = {}) {
    if (!facade || typeof baseDir !== 'string' || typeof mintOperationId !== 'function') throw new TypeError('distribution controller dependencies invalid');
    this.facade = facade; this.baseDir = baseDir; this.networkBroker = networkBroker;
    this.mintOperationId = mintOperationId; this.now = now; this.realpath = realpath;
    this.runCommit = runCommit; this.recoverStore = recoverStore; this.gitAcquire = gitAcquire;
    this.onCommitted = onCommitted;
    this.abortControllers = new Map(); this.inFlight = new Map();
  }

  async getDistributionState() {
    const current = await readDistributionState(this.facade, this.baseDir);
    if (current.ok) return { ok: true, state: current.state };
    if (current.reason === 'distribution_state_not_found') return { ok: true, state: createEmptyDistributionState(this.now()), persisted: false };
    return current;
  }

  async selectOfflineMirror({ sourceId, rootPath }) {
    const normalized = await normalizeOfflineRoot(rootPath, { realpath: this.realpath }); if (!normalized.ok) return normalized;
    return putSource(this.facade, this.baseDir, { source_id: sourceId, kind: 'offline_mirror', real_root: normalized.real_root, updated_at: this.now() });
  }

  async cancelOperation(operationId) {
    if (!OPERATION_ID.test(operationId || '')) return { ok: false, reason: 'operation_id_invalid' };
    const controller = this.abortControllers.get(operationId); if (controller) controller.abort();
    return { ok: true, operation_id: operationId, cancellation_requested: Boolean(controller) };
  }

  async waitForOperation(operationId) {
    if (!OPERATION_ID.test(operationId || '')) return { ok: false, reason: 'operation_id_invalid' };
    const pending = this.inFlight.get(operationId);
    return pending || { ok: false, reason: 'operation_not_in_flight' };
  }

  async dispose() {
    const pending = [...this.inFlight.values()];
    for (const controller of this.abortControllers.values()) controller.abort();
    await Promise.allSettled(pending);
  }

  _joinOperation(record) { return this.inFlight.get(record.operation_id) || { ok: true, operation_id: record.operation_id, status: record.phase }; }
  async startDistributionOperation(request, context = {}) {
    const fingerprinted = fingerprintOperation(request); if (!fingerprinted.ok) return fingerprinted;
    if (fingerprinted.value.operation.kind === 'cancel') return this.cancelOperation(fingerprinted.value.operation.target_operation_id);
    const prior = await findOperationByFingerprint(this.facade, this.baseDir, fingerprinted.fingerprint);
    if (prior.ok) return this._joinOperation(prior.record);
    if (prior.reason !== 'operation_record_not_found') return prior;
    const operationId = this.mintOperationId();
    if (!OPERATION_ID.test(operationId || '')) return { ok: false, reason: 'minted_operation_id_invalid' };
    const generationId = `g_${operationId}`.slice(0, 64); const now = this.now();
    const pointer = await readActivePointer(this.facade, this.baseDir);
    if (pointer.status === 'corrupted') return fail(operationId, 'active_pointer_corrupted');
    const current = pointer.status === 'ok' ? pointer.pointer : null;
    const requestedExpected = fingerprinted.value.operation.expected_generation_id;
    if (requestedExpected !== undefined && requestedExpected !== current?.generation_id) {
      return fail(operationId, 'expected_generation_conflict');
    }
    const nextEpoch = mintNextEpoch(current?.commit_epoch ?? null);
    const pending = await createPendingReceipt(this.facade, this.baseDir, {
      operationId, requestFingerprint: fingerprinted.fingerprint, generationId,
      lifecycleEpoch: nextEpoch, commitEpoch: nextEpoch, now,
    });
    if (!pending.ok) return fail(operationId, pending.reason, pending.detail);
    const operationRecord = await createOperationRecord(this.facade, this.baseDir, redactedOperationRecord({
      operationId, fingerprint: fingerprinted.fingerprint, request: fingerprinted.value, now, candidateGenerationId: generationId,
    }));
    if (!operationRecord.ok) return fail(operationId, operationRecord.reason);
    // An identical request can win fingerprint admission between the lookup above and record creation: join it instead of running twice.
    if (operationRecord.outcome === 'joined' && operationRecord.record.operation_id !== operationId) return this._joinOperation(operationRecord.record);
    const abortController = new AbortController(); this.abortControllers.set(operationId, abortController);
    const promise = this._execute({ operationId, generationId, request: fingerprinted.value, fingerprint: fingerprinted.fingerprint,
      expectedGenerationId: current?.generation_id || null, lifecycleEpoch: nextEpoch, context, signal: abortController.signal })
      .then((result) => {
        if (result?.ok === true && result.status === 'committed'
          && typeof this.onCommitted === 'function') {
          try { this.onCommitted(result); } catch (_error) { /* commit remains authoritative */ }
        }
        return result;
      })
      .finally(() => { this.abortControllers.delete(operationId); this.inFlight.delete(operationId); });
    this.inFlight.set(operationId, promise);
    return context.detached === true
      ? { ok: true, operation_id: operationId, status: 'pending' }
      : promise;
  }

  async _phase(operationId, phase, fields = {}) {
    const now = this.now(); const result = await advanceOperationPhase(this.facade, this.baseDir, operationId, phase, now, fields);
    if (result.ok) {
      try { await appendJournalEntry(this.facade, this.baseDir, { kind: 'distribution_phase', recorded_at: now, operation_id: operationId, phase, sequence: result.record.sequence }); }
      catch (_error) { /* operation record remains the durable recovery evidence */ }
    }
    return result;
  }
  async _terminal(operationId, result) {
    await this._phase(operationId, 'terminal', { terminal_reason: result.reason || null });
    await settleReceipt(this.facade, this.baseDir, { operationId,
      status: result.ok ? 'committed' : (result.reason === 'outcome_indeterminate' ? 'indeterminate' : 'failed'),
      terminalResultDigest: result.ok ? hash(result) : null, now: this.now() });
    await releaseArtifactLease(this.facade, this.baseDir, operationId);
    return result;
  }
  _cancelled(signal, operationId) { return signal.aborted ? fail(operationId, 'operation_canceled') : null; }

  async _acquire(operationId, request, context, signal) {
    const operation = request.operation;
    const sourceKind = operation.source_kind || context.updateSourceKind;
    if (sourceKind === 'local_package') {
      if (typeof context.readLocalPackage !== 'function') return fail(operationId, 'local_package_reselection_required');
      const selected = await context.readLocalPackage(operation.source_locator, signal);
      if (selected?.canceled === true) return fail(operationId, 'local_package_selection_canceled');
      if (Buffer.isBuffer(selected)) {
        return { ok: true, bytes: selected,
          sourceIdentity: { kind: 'local_package', package_path_digest: digest(operation.source_locator) } };
      }
      return selected?.ok === true && Buffer.isBuffer(selected.bytes)
        && /^[0-9a-f]{64}$/.test(selected.sourcePathDigest || '')
        ? { ok: true, bytes: selected.bytes,
          sourceIdentity: { kind: 'local_package', package_path_digest: selected.sourcePathDigest } }
        : fail(operationId, selected?.reason || 'local_package_unavailable');
    }
    if (operation.source_kind === 'https_url') {
      let rawLocator = operation.source_locator;
      if (!rawLocator.includes('://')) {
        const stored = await getSource(this.facade, this.baseDir, rawLocator);
        if (!stored.ok || stored.source.kind !== 'https_url') return fail(operationId, 'source_not_found');
        rawLocator = stored.source.locator;
      }
      const source = normalizeReusableUrl(rawLocator, { allowLoopbackHttp: context.allowLoopbackHttp === true }); if (!source.ok) return source;
      if (!this.networkBroker) return fail(operationId, 'network_broker_unavailable');
      if (context.retainSource === true) {
        const retained = await putSource(this.facade, this.baseDir, { source_id: context.sourceId, kind: 'https_url', locator: source.locator, updated_at: this.now() });
        if (!retained.ok) return fail(operationId, retained.reason);
      }
      const result = await this.networkBroker.download({ purpose: 'package_url', request_id: `download_${operationId}`.slice(0, 64), operation_id: operationId,
        redaction_policy: 'strict', deadline_epoch_ms: Date.now() + 120000, url: source.locator,
        consent: context.networkConsent, allow_loopback_http: context.allowLoopbackHttp === true, signal,
        source_identity_digest: source.locator_digest, max_bytes: LIMITS.packageBytes,
        read_partial: async () => {
          const partial = await getPartialCacheEntry(this.facade, this.baseDir, operationId);
          if (partial.ok) return partial.partial;
          await discardPartialCacheEntry(this.facade, this.baseDir, operationId); return null;
        },
        write_partial: (partial) => putPartialCacheEntry(this.facade, this.baseDir, { operationId, ...partial, createdAt: this.now(), sourceIdentityDigest: partial.source_identity_digest }),
        discard_partial: () => discardPartialCacheEntry(this.facade, this.baseDir, operationId) });
      return result.ok ? { ok: true, bytes: result.bytes, sourceIdentity: { kind: 'https_url', url_digest: source.locator_digest } } : result;
    }
    if (operation.source_kind === 'git') {
      let rawLocator = operation.source_locator;
      if (!rawLocator.includes('://')) {
        const stored = await getSource(this.facade, this.baseDir, rawLocator);
        if (!stored.ok || stored.source.kind !== 'git') return fail(operationId, 'source_not_found');
        rawLocator = stored.source.locator;
      }
      const normalized = normalizeReusableUrl(rawLocator); if (!normalized.ok) return normalized;
      if (context.retainSource === true) {
        const retained = await putSource(this.facade, this.baseDir, { source_id: context.sourceId, kind: 'git', locator: normalized.locator, updated_at: this.now() });
        if (!retained.ok) return fail(operationId, retained.reason);
      }
      const result = await this.gitAcquire({ locator: normalized.locator, ref: context.gitRef || 'HEAD', consent: context.networkConsent, resolve: context.resolve, signal });
      return result.ok ? { ok: true, bytes: result.bytes, sourceIdentity: { kind: 'git', repository_url_digest: result.repository_url_digest, pinned_commit: result.pinned_commit } } : result;
    }
    if (typeof context.acquireCatalogTarget !== 'function') return fail(operationId, 'catalog_acquirer_unavailable');
    if (!['signed_catalog', 'offline_mirror'].includes(sourceKind)) return fail(operationId, 'catalog_source_required');
    const sourceId = operation.source_locator || context.sourceId;
    if (sourceKind === 'offline_mirror') {
      const stored = await getSource(this.facade, this.baseDir, sourceId); if (!stored.ok || stored.source.kind !== 'offline_mirror') return fail(operationId, 'offline_mirror_not_selected');
    }
    const target = await context.acquireCatalogTarget({ kind: sourceKind, sourceId, target: operation.target,
      targetVersion: operation.target_version, signal });
    if (!target?.ok) return target || fail(operationId, 'catalog_target_failed');
    return { ok: true, bytes: target.bytes, sourceIdentity: publicSourceIdentity({ kind: sourceKind, source_id: sourceId }, {
      targetPathDigest: target.target_path_digest, tufRootDigest: target.tuf_root_digest,
    }) };
  }

  async _execute(args) {
    const { operationId, request, context, signal } = args;
    try {
      if (request.operation.kind === 'catalog_refresh') return this._executeCatalogRefresh(args);
      if (request.operation.kind === 'rollback') return this._executeRollback(args);
      if (!['install', 'update', 'downgrade', 'check'].includes(request.operation.kind)) return this._terminal(operationId, fail(operationId, 'operation_not_supported'));
      let currentVersion = null; let currentPlugins = []; let currentGenerationSchemaVersion = 3;
      if (args.expectedGenerationId) {
        const currentGeneration = await readGeneration(this.facade, this.baseDir, args.expectedGenerationId);
        if (!currentGeneration.ok) return this._terminal(operationId, fail(operationId, 'current_generation_invalid'));
        currentPlugins = currentGeneration.record.plugins;
        currentGenerationSchemaVersion = currentGeneration.record.generation_schema_version;
        const currentPlugin = currentPlugins.find((plugin) => plugin.publisher_id === request.operation.target?.publisher_id
          && plugin.plugin_id === request.operation.target.plugin_id);
        if (request.operation.kind === 'install' && currentPlugin) return this._terminal(operationId, fail(operationId, 'plugin_already_installed'));
        if (['update', 'downgrade'].includes(request.operation.kind)) {
          if (!currentPlugin) return this._terminal(operationId, fail(operationId, 'installed_plugin_not_found'));
          currentVersion = currentPlugin.resolved_version;
        }
      }
      currentPlugins = currentPlugins.filter((plugin) => !(context.excludedPluginKeys || []).includes(`${plugin.publisher_id}/${plugin.plugin_id}`));
      if (request.operation.kind === 'downgrade' && (typeof context.confirmHighConsequence !== 'function'
        || await context.confirmHighConsequence({ kind: 'downgrade', target_version: request.operation.target_version }) !== true)) {
        return this._terminal(operationId, fail(operationId, 'downgrade_not_confirmed'));
      }
      if (request.operation.kind === 'check') {
        if (typeof context.check !== 'function') return this._terminal(operationId, fail(operationId, 'distribution_check_unavailable'));
        const checked = await context.check({ target: request.operation.target, signal });
        return this._terminal(operationId, checked?.ok
          ? { ok: true, operation_id: operationId, status: 'checked', update_available: checked.update_available === true }
          : fail(operationId, checked?.reason || 'distribution_check_failed'));
      }
      await this._phase(operationId, 'acquisition'); const acquired = await this._acquire(operationId, request, context, signal);
      if (!acquired.ok) return this._terminal(operationId, fail(operationId, acquired.reason));
      const lease = await writeArtifactLease(this.facade, this.baseDir, { operationId, digests: [hash(acquired.bytes)],
        expiresAt: new Date(Date.parse(this.now()) + 120000).toISOString() });
      if (!lease.ok) return this._terminal(operationId, fail(operationId, lease.reason));
      if (this._cancelled(signal, operationId)) return this._terminal(operationId, this._cancelled(signal, operationId));
      await this._phase(operationId, 'verification');
      const cacheKey = buildVerificationCacheKey({ artifact_digest: hash(acquired.bytes), publisher_trust_digest: context.publisherTrustDigest,
        tuf_root_digest: context.tufRootDigest || ZERO_DIGEST, advisory_digest: context.advisoryDigest,
        source_policy_digest: context.sourcePolicyDigest, contract_lock_digest: context.contractLockDigest });
      if (!cacheKey.ok) return this._terminal(operationId, fail(operationId, cacheKey.reason));
      const verified = await verifyDistributionPackage({ bytes: acquired.bytes, sourceIdentity: acquired.sourceIdentity,
        trustRoots: context.trustRoots, verificationCacheKey: cacheKey.key, now: this.now(), developerProfile: context.developerProfile === true });
      if (!verified.ok) return this._terminal(operationId, fail(operationId, verified.reason));
      if (typeof context.validateManagedCandidate === 'function') {
        const managed = await context.validateManagedCandidate({ sourceIdentity: acquired.sourceIdentity,
          verified });
        if (!managed?.ok) return this._terminal(operationId,
          fail(operationId, managed?.reason || 'managed_policy_candidate_denied'));
      }
      const activeLeases = await readActiveArtifactDigests(this.facade, this.baseDir, this.now());
      const cached = await putVerifiedCacheEntry(this.facade, this.baseDir, { bytes: acquired.bytes,
        sourceIdentityDigest: hash(acquired.sourceIdentity), verifiedAt: this.now() }, {
        maxBytes: LIMITS.cacheBytes, protectedDigests: activeLeases.digests,
      });
      if (!cached.ok) return this._terminal(operationId, fail(operationId, cached.reason));
      if (request.operation.target && (verified.publisher_id !== request.operation.target.publisher_id || verified.plugin_id !== request.operation.target.plugin_id)) {
        return this._terminal(operationId, fail(operationId, 'package_target_mismatch'));
      }
      const candidate = { publisher_id: verified.publisher_id, plugin_id: verified.plugin_id, version: verified.version,
        artifact_digest: verified.archive_digest, publisher_key_id: verified.publisher_key_id,
        source_identity: acquired.sourceIdentity, dependencies: verified.manifest.dependencies || [], provides: context.provides || [] };
      const advisory = await admitCandidate(context.advisorySnapshot, candidate, { confirmWarning: context.confirmWarning });
      if (!advisory.ok) return this._terminal(operationId, fail(operationId, advisory.reason));
      if (request.operation.kind === 'downgrade' && (verified.version !== request.operation.target_version
        || semver.gte(verified.version, currentVersion))) return this._terminal(operationId, fail(operationId, 'downgrade_exact_version_required'));
      if (request.operation.kind === 'update' && semver.lte(verified.version, currentVersion)) return this._terminal(operationId, fail(operationId, 'update_not_higher'));
      await this._phase(operationId, 'solving');
      const replacingTarget = ['update', 'downgrade'].includes(request.operation.kind);
      const preservedPlugins = currentPlugins.filter((plugin) => !replacingTarget
        || plugin.publisher_id !== candidate.publisher_id || plugin.plugin_id !== candidate.plugin_id);
      const preservedRoots = [];
      for (const plugin of preservedPlugins) {
        const preserved = (context.candidates || []).find((item) => item.publisher_id === plugin.publisher_id
          && item.plugin_id === plugin.plugin_id && item.version === plugin.resolved_version
          && item.artifact_digest === plugin.artifact_digest && item.publisher_key_id === plugin.publisher_key_id);
        if (!preserved) return this._terminal(operationId, fail(operationId, 'current_graph_candidate_missing'));
        preservedRoots.push({ publisher_id: plugin.publisher_id, plugin_id: plugin.plugin_id, version_range: `=${plugin.resolved_version}` });
      }
      const solved = solveDependencies({ candidates: [candidate, ...(context.candidates || [])],
        roots: [{ publisher_id: candidate.publisher_id, plugin_id: candidate.plugin_id, version_range: `=${candidate.version}` }, ...preservedRoots],
        selectedOptional: context.selectedOptional || [], capabilityProviders: context.capabilityProviders || [] });
      if (!solved.ok) return this._terminal(operationId, fail(operationId, solved.reason));
      return this._commitVerified({ ...args, acquired, verified, candidate, solved, preservedPlugins,
        currentGenerationSchemaVersion });
    } catch (_error) { return this._terminal(operationId, fail(operationId, 'distribution_operation_failed')); }
  }

  async _commitVerified({ operationId, generationId, fingerprint, expectedGenerationId, lifecycleEpoch, request,
    context, signal, acquired, verified, solved, preservedPlugins = [], currentGenerationSchemaVersion = 3 }) {
    const content = await putContent(this.facade, this.baseDir, acquired.bytes); if (!content.ok) return this._terminal(operationId, fail(operationId, content.reason));
    for (const executable of verified.executable_object_bytes || []) {
      const stored = await putContent(this.facade, this.baseDir, executable.bytes);
      if (!stored.ok || stored.digest !== executable.executable_digest) {
        return this._terminal(operationId, fail(operationId, 'executable_object_write_failed'));
      }
    }
    const packageRecord = await writePackageRecord(this.facade, this.baseDir, { digest: content.digest, record: verified.package_record });
    if (!packageRecord.ok) return this._terminal(operationId, fail(operationId, packageRecord.reason));
    const sourceTrustCandidate = typeof context.buildSourceTrust === 'function'
      ? await context.buildSourceTrust({ acquired, verified }) : context.sourceTrust;
    const checkedTrust = validate('PluginSourceTrustV1', sourceTrustCandidate);
    if (!checkedTrust.ok || checkedTrust.value.publisher_id !== verified.publisher_id
      || !sourceTrustIsValid(acquired.sourceIdentity, checkedTrust.value, verified.publisher_key_id, verified.archive_digest)) {
      return this._terminal(operationId, fail(operationId, 'source_trust_invalid'));
    }
    const sourceTrust = await putEvidence(this.facade, this.baseDir, 'source_trust', checkedTrust.value);
    const advisory = await putEvidence(this.facade, this.baseDir, 'advisory', context.advisorySnapshot);
    const lock = await putEvidence(this.facade, this.baseDir, 'lock', solved.lock);
    const stateResult = await this.getDistributionState(); if (!stateResult.ok) return this._terminal(operationId, fail(operationId, stateResult.reason));
    const distribution = await putEvidence(this.facade, this.baseDir, 'catalog', stateResult.state);
    if (![sourceTrust, advisory, lock, distribution].every((item) => item.ok)) return this._terminal(operationId, fail(operationId, 'distribution_evidence_write_failed'));
    await this._phase(operationId, 'snapshot');
    let data = context.currentData === undefined ? {} : context.currentData; let compatible = true;
    const fromVersion = context.currentDataSchemaVersion || verified.data_schema_version;
    if (fromVersion !== verified.data_schema_version) {
      const beforeSnapshot = await putDataSnapshot(this.facade, this.baseDir, { publisherId: verified.publisher_id,
        pluginId: verified.plugin_id, generationId: `pre_${operationId}`.slice(0, 64),
        bytes: Buffer.from(stableStringify(data)), createdAt: this.now(), evidentiary: false });
      if (!beforeSnapshot.ok) return this._terminal(operationId, fail(operationId, beforeSnapshot.reason));
      const parsed = parseMigrations(verified.migration_descriptor_bytes); const pathResult = parsed.ok && findMigrationPath(parsed.migrations, fromVersion, verified.data_schema_version);
      if (!pathResult?.ok) compatible = false;
      else { const migrated = applyMigrationPath(data, pathResult.steps); compatible = migrated.ok; if (migrated.ok) data = migrated.value; }
    }
    const snapshot = await putDataSnapshot(this.facade, this.baseDir, { publisherId: verified.publisher_id, pluginId: verified.plugin_id,
      generationId, bytes: Buffer.from(stableStringify(data)), createdAt: this.now(), evidentiary: false });
    if (!snapshot.ok) return this._terminal(operationId, fail(operationId, snapshot.reason));
    const generationSchemaVersion = verified.manifest.manifest_schema_version === 6
      || currentGenerationSchemaVersion === 6 ? 6
      : (verified.manifest.manifest_schema_version === 5
      || currentGenerationSchemaVersion === 5 ? 5
      : (verified.manifest.manifest_schema_version === 4
        || currentGenerationSchemaVersion === 4 ? 4 : 3));
    const plugin = { publisher_id: verified.publisher_id, plugin_id: verified.plugin_id, display_name: verified.display_name,
      resolved_version: verified.version, publisher_key_id: verified.publisher_key_id, artifact_digest: verified.archive_digest,
      package_record_digest: recordDigest(packageRecord.record), source_trust_digest: sourceTrust.digest,
      advisory_snapshot_digest: advisory.digest, data_snapshot_digest: snapshot.digest,
      desired_state: 'installed_disabled', effective_state: 'installed_disabled', remote_binding_digests: [],
      ...(generationSchemaVersion === 4 ? {
        restricted_module_digests: (verified.manifest.contributions || [])
          .filter((item) => item.component_sha256)
          .map((item) => item.component_sha256).sort(),
      } : {}),
      ...(generationSchemaVersion === 5 ? {
        restricted_module_digests: [],
        view_content_digests: (verified.manifest.contributions || [])
          .filter((item) => ['setup_scene', 'panel', 'artifact_renderer'].includes(item.kind))
          .map((item) => item.content_sha256).sort(),
        provider_descriptor_digests: (verified.manifest.contributions || [])
          .filter((item) => item.kind === 'provider_descriptor')
          .map((item) => item.content_sha256).sort(),
      } : {}),
      ...(generationSchemaVersion === 6 ? {
        restricted_module_digests: [], view_content_digests: [], provider_descriptor_digests: [],
        executable_object_digests: (verified.manifest.contributions || [])
          .map((item) => item.executable_sha256).filter(Boolean).sort(),
        full_host_binding_digests: (verified.manifest.contributions || [])
          .map((item) => item.content_sha256).filter(Boolean).sort(),
        native_mcp_binding_digests: (verified.manifest.contributions || [])
          .filter((item) => item.kind === 'native_mcp').map((item) => item.content_sha256).sort(),
        session_provider_digests: (verified.manifest.contributions || [])
          .filter((item) => item.kind === 'session_provider').map((item) => item.content_sha256).sort(),
        engine_adapter_digests: (verified.manifest.contributions || [])
          .filter((item) => item.kind === 'engine_adapter').map((item) => item.content_sha256).sort(),
        hook_descriptor_digests: (verified.manifest.contributions || [])
          .filter((item) => item.kind === 'hook').map((item) => item.content_sha256).sort(),
        containment_profile_digests: [...new Set((verified.full_host_contents || [])
          .map((item) => item.containment_profile_digest))].sort(),
        build_provenance_digests: [...new Set((verified.full_host_contents || [])
          .map((item) => item.build_provenance_digest))].sort(),
      } : {}) };
    const resolvedPlugins = [];
    let installedBytes = 0;
    for (const node of solved.lock.nodes) {
      let resolved = node.publisher_id === plugin.publisher_id && node.plugin_id === plugin.plugin_id
        && node.resolved_version === plugin.resolved_version && node.artifact_digest === plugin.artifact_digest
        ? plugin : [...preservedPlugins, ...(context.resolvedPlugins || [])].find((item) => item.publisher_id === node.publisher_id
          && item.plugin_id === node.plugin_id && item.resolved_version === node.resolved_version
          && item.artifact_digest === node.artifact_digest);
      if (!resolved) return this._terminal(operationId, fail(operationId, 'resolved_graph_incomplete'));
      if (!(generationSchemaVersion === 6 ? isV6PluginEntry(resolved)
        : (generationSchemaVersion === 5 ? isV5PluginEntry(resolved)
        : (generationSchemaVersion === 4 ? isV4PluginEntry(resolved) : isV3PluginEntry(resolved))))) {
        if (typeof context.promotePreservedPlugin !== 'function') {
          return this._terminal(operationId, fail(operationId, 'preserved_plugin_promotion_unavailable'));
        }
        const promoted = await context.promotePreservedPlugin({
          plugin: resolved,
          generationId,
          advisoryDigest: advisory.digest,
          generationSchemaVersion,
        });
        if (!promoted?.ok || !promotionPreservesAuthority(resolved, promoted.plugin, generationSchemaVersion)) {
          return this._terminal(operationId, fail(operationId,
            promoted?.reason || 'preserved_plugin_promotion_invalid'));
        }
        resolved = promoted.plugin;
      }
      const artifact = await getContent(this.facade, this.baseDir, node.artifact_digest);
      if (!artifact.ok || artifact.bytes.length > LIMITS.installedPluginBytes) {
        return this._terminal(operationId, fail(operationId, 'installed_plugin_size_invalid'));
      }
      installedBytes += artifact.bytes.length;
      if (installedBytes > LIMITS.installedBytes) return this._terminal(operationId, fail(operationId, 'installed_graph_capacity_exceeded'));
      resolvedPlugins.push(resolved);
    }
    resolvedPlugins.sort((a, b) => `${a.publisher_id}/${a.plugin_id}`.localeCompare(`${b.publisher_id}/${b.plugin_id}`));
    await this._phase(operationId, 'prepare');
    if (this._cancelled(signal, operationId)) return this._terminal(operationId, this._cancelled(signal, operationId));
    if (typeof context.assertManagedPolicyCurrent === 'function') {
      const managed = await context.assertManagedPolicyCurrent();
      if (!managed?.ok) return this._terminal(operationId,
        fail(operationId, managed?.reason || 'managed_policy_authority_stale'));
    }
    const committed = await this.runCommit(this.facade, this.baseDir, { operationId, requestFingerprint: fingerprint,
      lifecycleEpoch, generationId, createdAt: this.now(), plugins: resolvedPlugins,
      policyGrantRef: currentPolicyReference(context, generationSchemaVersion,
        generationSchemaVersion === 6 ? context.policyGrantRefV6
          : (generationSchemaVersion === 5 ? context.policyGrantRefV5
          : (generationSchemaVersion === 4 ? context.policyGrantRefV4 : context.policyGrantRef))),
      dataSchemaRefs: [], now: this.now(), auditAction: request.operation.kind,
      isCanceled: () => signal.aborted,
      generationSchemaVersion, lockDigest: lock.digest, distributionStateDigest: distribution.digest,
      adoptPendingReceipt: true, expectedGenerationId,
      commitAuthority: context.commitAuthority,
      ...(typeof context.participantPrepare === 'function'
        ? { participantPrepare: context.participantPrepare } : {}) });
    if (!committed.ok) return this._terminal(operationId, fail(operationId, committed.reason, { committed: committed.committed === true }));
    await this._phase(operationId, 'pointer');
    await this._phase(operationId, 'publication', {
      runtime_publication: typeof context.participantPrepare === 'function' ? 'attested' : 'skipped',
    });
    const currentDataState = await readDataState(this.facade, this.baseDir, { publisherId: verified.publisher_id, pluginId: verified.plugin_id });
    const watermark = currentDataState.ok ? currentDataState.state.mutation_watermark.sequence + 1 : 0;
    const dataState = await writeDataState(this.facade, this.baseDir, { publisher_id: verified.publisher_id,
      plugin_id: verified.plugin_id, data_domain_id: context.dataDomainId || `${verified.plugin_id}_data`,
      data_schema_version: compatible ? verified.data_schema_version : fromVersion, data_generation_id: generationId,
      migration_executor_tier: 'declarative', mutation_watermark: { sequence: watermark, recorded_at: this.now() },
      rollback_barrier: { kind: 'none' }, snapshot_references: [{ operation_id: operationId, generation_id: generationId, created_at: this.now() }],
    }, currentDataState.ok ? { expectedWatermark: currentDataState.state.mutation_watermark.sequence } : {});
    await enforceGenerationRetention(this.facade, this.baseDir); await this._phase(operationId, 'cleanup');
    return this._terminal(operationId, { ok: true, operation_id: operationId, status: 'committed', generation_id: generationId,
      installed_but_incompatible: !compatible, degraded: !dataState.ok,
      ...(dataState.ok ? {} : { recovery_required: true }) });
  }

  async _executeCatalogRefresh({ operationId, generationId, fingerprint, expectedGenerationId, lifecycleEpoch, request, context, signal }) {
    if (typeof context.refreshCatalog !== 'function') return this._terminal(operationId, fail(operationId, 'catalog_refresh_unavailable'));
    await this._phase(operationId, 'acquisition');
    const refreshed = await context.refreshCatalog({ catalogId: request.operation.catalog_id, signal });
    if (!refreshed?.ok) return this._terminal(operationId, fail(operationId, refreshed?.reason || 'catalog_refresh_failed'));
    if (refreshed.distributionState) {
      const current = await readDistributionState(this.facade, this.baseDir);
      const written = await writeDistributionState(this.facade, this.baseDir, refreshed.distributionState,
        { expectedRevision: current.ok ? current.state.revision : -1 });
      if (!written.ok) return this._terminal(operationId, fail(operationId, written.reason));
    }
    if (typeof context.commitTrustedTime === 'function' && await context.commitTrustedTime(refreshed) !== true) {
      return this._terminal(operationId, fail(operationId, 'trusted_time_commit_failed'));
    }
    const quarantineIds = new Set(refreshed.quarantined_plugins || []);
    if (!quarantineIds.size) return this._terminal(operationId, { ok: true, operation_id: operationId, status: 'refreshed' });
    const pointer = await readActivePointer(this.facade, this.baseDir);
    if (pointer.status !== 'ok') return this._terminal(operationId, fail(operationId, 'active_generation_unavailable'));
    const currentGeneration = await readGeneration(this.facade, this.baseDir, pointer.pointer.generation_id);
    const generationSchemaVersion = currentGeneration.record?.generation_schema_version;
    if (!currentGeneration.ok || !DISTRIBUTION_GENERATION_SCHEMA_VERSIONS.has(generationSchemaVersion)) {
      return this._terminal(operationId, fail(operationId, 'advisory_quarantine_requires_distribution_generation'));
    }
    const advisory = await putEvidence(this.facade, this.baseDir, 'advisory', refreshed.advisorySnapshot);
    const distributionState = await this.getDistributionState();
    const distribution = distributionState.ok && await putEvidence(this.facade, this.baseDir, 'catalog', distributionState.state);
    if (!advisory.ok || !distribution?.ok) return this._terminal(operationId, fail(operationId, 'distribution_evidence_write_failed'));
    const plugins = currentGeneration.record.plugins.map((plugin) => ({ ...plugin,
      advisory_snapshot_digest: advisory.digest,
      ...(quarantineIds.has(`${plugin.publisher_id}/${plugin.plugin_id}`)
        ? { desired_state: 'quarantined', effective_state: 'quarantined' } : {}),
    }));
    const committed = await this.runCommit(this.facade, this.baseDir, { operationId, requestFingerprint: fingerprint,
      lifecycleEpoch, generationId, createdAt: this.now(), plugins,
      policyGrantRef: currentPolicyReference(context, generationSchemaVersion,
        currentGeneration.record.policy_grant_ref),
      dataSchemaRefs: [], now: this.now(), auditAction: 'quarantine', isCanceled: () => signal.aborted,
      generationSchemaVersion, lockDigest: currentGeneration.record.lock_digest,
      distributionStateDigest: distribution.digest, adoptPendingReceipt: true, expectedGenerationId,
      commitAuthority: context.commitAuthority,
      ...(typeof context.participantPrepare === 'function'
        ? { participantPrepare: context.participantPrepare } : {}) });
    return committed.ok ? this._terminal(operationId, { ok: true, operation_id: operationId, status: 'committed', generation_id: generationId, quarantined: [...quarantineIds].sort() })
      : this._terminal(operationId, fail(operationId, committed.reason));
  }

  async _executeRollback({ operationId, generationId, fingerprint, expectedGenerationId, lifecycleEpoch, request, context, signal }) {
    if (![context.validateTrust, context.validatePolicy, context.validateAdvisories, context.validateRollbackData]
      .every((item) => typeof item === 'function')) {
      return this._terminal(operationId, fail(operationId, 'rollback_revalidation_unavailable'));
    }
    const target = await readGeneration(this.facade, this.baseDir, request.operation.target_generation_id);
    const generationSchemaVersion = target.record?.generation_schema_version;
    if (!target.ok || !DISTRIBUTION_GENERATION_SCHEMA_VERSIONS.has(generationSchemaVersion)) {
      return this._terminal(operationId, fail(operationId, 'rollback_generation_invalid'));
    }
    const revalidated = await validateV3Generation(this.facade, this.baseDir, target.record, { validateTrust: context.validateTrust,
      validatePolicy: context.validatePolicy, validateAdvisories: context.validateAdvisories });
    if (!revalidated.ok || await context.validateRollbackData(target.record) !== true) {
      return this._terminal(operationId, fail(operationId, revalidated.reason || 'rollback_data_barrier'));
    }
    for (const plugin of target.record.plugins) {
      const state = await readDataState(this.facade, this.baseDir, { publisherId: plugin.publisher_id, pluginId: plugin.plugin_id });
      if (!state.ok || state.state.rollback_barrier.kind !== 'none') {
        return this._terminal(operationId, fail(operationId, 'rollback_data_barrier'));
      }
    }
    const committed = await this.runCommit(this.facade, this.baseDir, { operationId, requestFingerprint: fingerprint,
      lifecycleEpoch, generationId, createdAt: this.now(), plugins: target.record.plugins,
      policyGrantRef: currentPolicyReference(context, generationSchemaVersion,
        target.record.policy_grant_ref), dataSchemaRefs: [], now: this.now(), auditAction: 'rollback',
      isCanceled: () => signal.aborted, generationSchemaVersion, lockDigest: target.record.lock_digest,
      distributionStateDigest: target.record.distribution_state_digest, adoptPendingReceipt: true, expectedGenerationId,
      commitAuthority: context.commitAuthority,
      ...(typeof context.participantPrepare === 'function'
        ? { participantPrepare: context.participantPrepare } : {}) });
    if (!committed.ok) return this._terminal(operationId, fail(operationId, committed.reason));
    let degraded = false;
    for (const plugin of target.record.plugins) {
      const current = await readDataState(this.facade, this.baseDir, { publisherId: plugin.publisher_id, pluginId: plugin.plugin_id });
      if (!current.ok) { degraded = true; continue; }
      const references = [...current.state.snapshot_references, { operation_id: operationId, generation_id: generationId, created_at: this.now() }].slice(-8);
      const written = await writeDataState(this.facade, this.baseDir, { ...current.state, data_generation_id: generationId,
        mutation_watermark: { sequence: current.state.mutation_watermark.sequence + 1, recorded_at: this.now() }, snapshot_references: references },
      { expectedWatermark: current.state.mutation_watermark.sequence });
      if (!written.ok) degraded = true;
    }
    return this._terminal(operationId, { ok: true, operation_id: operationId, status: 'committed', generation_id: generationId, degraded });
  }

  async recover(options = {}) { return this.recoverStore(this.facade, this.baseDir, { now: this.now(), ...options }); }
}

module.exports = { ZERO_DIGEST, DISTRIBUTION_GENERATION_SCHEMA_VERSIONS, isV3PluginEntry,
  promotionPreservesAuthority, currentPolicyReference, DistributionController };
