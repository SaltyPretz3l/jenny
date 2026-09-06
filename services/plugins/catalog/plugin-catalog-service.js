'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const semver = require('semver');
const { readCommittedState } = require('../lifecycle/commit-sequence');
const { readActivePointer } = require('../store/active-pointer');
const { listGenerationIds, readGeneration } = require('../store/generation-store');
const { putCatalogSource, readCatalogSources } = require('../store/catalog-source-store');
const { catalogEntryFromTarget, publicCatalogEntry, validateCatalogSource } = require('./catalog-contracts');
const { BrokerFetcher, ConfinedFileFetcher, refreshTufRepository } = require('../distribution/tuf-repository');
const { LIMITS } = require('../distribution/distribution-limits');
const { evaluateAdvisories, normalizeAdvisories } = require('../distribution/advisory-policy');
const { stableStringify } = require('../package/canonical-metadata');

const EMPTY_ADVISORY = Object.freeze({ revision: 0, advisories: [], revoked_artifacts: [], revoked_keys: [] });
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function digest(value) { return sha256(Buffer.from(stableStringify(value), 'utf8')); }
function operationId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
}
function publicSource(source, status = {}) {
  return {
    source_id: source.source_id,
    kind: source.kind,
    display_name: source.display_name,
    root_fingerprint: source.root_fingerprint,
    status: status.status || 'configured',
    reason: status.reason || '',
  };
}
function trailingFileUrl(directory) {
  const href = pathToFileURL(`${directory}${path.sep}`).href;
  return href.endsWith('/') ? href : `${href}/`;
}

class PluginCatalogService {
  constructor({ facade, baseDir = '', cacheRoot, distributionController,
    createDistributionContext, networkBroker = null, configuredSources = [], realpath = fs.promises.realpath,
    confirmOfflineTrust = async () => false, now = () => new Date().toISOString(),
    log = () => {} } = {}) {
    if (!facade || !cacheRoot || !distributionController || typeof createDistributionContext !== 'function') {
      throw new TypeError('plugin catalog service dependencies invalid');
    }
    this.facade = facade;
    this.baseDir = baseDir;
    this.cacheRoot = cacheRoot;
    this.distributionController = distributionController;
    this.createDistributionContext = createDistributionContext;
    this.networkBroker = networkBroker;
    this.configuredSources = configuredSources;
    this.realpath = realpath;
    this.confirmOfflineTrust = confirmOfflineTrust;
    this.now = now;
    this.log = log;
    this.entries = new Map();
    this.runtimeTargets = new Map();
    this.advisorySnapshots = new Map();
    this.sourceStatus = new Map();
    this.invalidSources = new Map();
    this.revision = 0;
    this.refreshPromise = null;
  }

  async _sources() {
    const stored = await readCatalogSources(this.facade, this.baseDir);
    if (!stored.ok) return stored;
    const merged = new Map();
    const configuredIds = new Set();
    this.invalidSources.clear();
    for (const raw of this.configuredSources) {
      const configuredId = String(raw?.source_id || '');
      if (ID_RE.test(configuredId)) configuredIds.add(configuredId);
      const checked = validateCatalogSource(raw);
      if (checked.ok) merged.set(checked.value.source_id, checked.value);
      else {
        const sourceId = String(raw?.source_id || '');
        if (ID_RE.test(sourceId)) this.invalidSources.set(sourceId, {
          source_id: sourceId, kind: ['remote', 'offline_mirror'].includes(raw?.kind) ? raw.kind : 'invalid',
          display_name: String(raw?.display_name || sourceId).slice(0, 128), root_fingerprint: '',
        });
        this.sourceStatus.set(sourceId || 'invalid', { status: 'failed', reason: checked.reason });
      }
    }
    for (const source of stored.document.sources) {
      if (configuredIds.has(source.source_id)) {
        this.log('WARN', 'plugins.catalog.stored_source_shadowed', { source_id: source.source_id });
        continue;
      }
      merged.set(source.source_id, source);
    }
    return { ok: true, revision: stored.document.revision, sources: [...merged.values()] };
  }

  async getCatalogState() {
    const sources = await this._sources();
    if (!sources.ok) return { ok: false, reason: sources.reason, read_only: true, sources: [], entries: [] };
    const invalid = [...this.invalidSources.values()];
    return {
      ok: true,
      schema_version: 1,
      revision: Math.max(this.revision, sources.revision),
      configured: sources.sources.length + invalid.length > 0,
      empty_reason: sources.sources.length + invalid.length ? '' : 'no_catalog_sources_configured',
      sources: [...sources.sources, ...invalid]
        .map((source) => publicSource(source, this.sourceStatus.get(source.source_id))),
      entries: [...this.entries.values()].map(publicCatalogEntry)
        .sort((left, right) => left.display_name.localeCompare(right.display_name)
          || semver.rcompare(left.version, right.version)),
    };
  }

  async trustOfflineMirror({ source_id: sourceId, display_name: displayName, root_path: rootPath } = {}) {
    if (!ID_RE.test(String(sourceId || '')) || typeof rootPath !== 'string') {
      return { ok: false, reason: 'offline_mirror_selection_invalid' };
    }
    if (this.configuredSources.some((source) => String(source?.source_id || '') === sourceId)) {
      return { ok: false, reason: 'catalog_source_identity_conflict' };
    }
    let realRoot;
    let rootBytes;
    try {
      realRoot = await this.realpath(rootPath);
      const candidates = [path.join(realRoot, 'metadata', 'root.json'), path.join(realRoot, 'root.json')];
      let rootFile = null;
      for (const candidate of candidates) {
        let resolvedCandidate;
        try { resolvedCandidate = await this.realpath(candidate); } catch (_error) { continue; }
        // The metadata root must resolve INSIDE the real mirror root: a
        // symlinked metadata/ or root.json pointing outside the mirror is not
        // trusted as the mirror's root of trust.
        const relative = path.relative(realRoot, resolvedCandidate);
        if (relative && !path.isAbsolute(relative) && relative !== '..'
          && !relative.startsWith(`..${path.sep}`)) {
          rootFile = resolvedCandidate;
          break;
        }
      }
      if (!rootFile) return { ok: false, reason: 'offline_mirror_root_missing' };
      rootBytes = await fs.promises.readFile(rootFile);
      if (!rootBytes.length || rootBytes.length > LIMITS.metadataDocumentBytes) {
        return { ok: false, reason: 'offline_mirror_root_invalid' };
      }
      const root = JSON.parse(rootBytes.toString('utf8'));
      const type = String(root?.signed?._type || root?.signed?.type || '').toLowerCase();
      if (type !== 'root') return { ok: false, reason: 'offline_mirror_root_invalid' };
    } catch (_error) { return { ok: false, reason: 'offline_mirror_root_invalid' }; }
    const fingerprint = sha256(rootBytes);
    const identity = {
      source_id: sourceId,
      display_name: String(displayName || sourceId).trim().slice(0, 128),
      root_fingerprint: fingerprint,
    };
    if (await this.confirmOfflineTrust(identity) !== true) {
      return { ok: false, reason: 'offline_mirror_trust_denied' };
    }
    const source = {
      catalog_source_schema_version: 1,
      source_id: sourceId,
      kind: 'offline_mirror',
      display_name: identity.display_name || sourceId,
      root_fingerprint: fingerprint,
      real_root: realRoot,
      pinned_root_base64: rootBytes.toString('base64'),
    };
    const stored = await putCatalogSource(this.facade, this.baseDir, source);
    if (!stored.ok) return stored;
    const registered = await this.distributionController.selectOfflineMirror({
      sourceId, rootPath: realRoot,
    });
    if (!registered.ok) return registered;
    this.sourceStatus.set(sourceId, { status: 'configured', reason: '' });
    return { ok: true, source: publicSource(source), revision: stored.revision };
  }

  async refreshCatalogs() {
    if (this.refreshPromise) return this.refreshPromise;
    const promise = this._refreshCatalogs();
    this.refreshPromise = promise;
    try { return await promise; }
    finally {
      if (this.refreshPromise === promise) this.refreshPromise = null;
    }
  }

  async _refreshCatalogs() {
    const sourceState = await this._sources();
    if (!sourceState.ok) return sourceState;
    if (!sourceState.sources.length) return this.getCatalogState();
    const nextEntries = new Map();
    const nextRuntimeTargets = new Map();
    const nextAdvisorySnapshots = new Map();
    const results = [];
    for (const source of sourceState.sources) {
      try {
        const refreshed = await this._refreshSource(source);
        if (!refreshed.ok) {
          this.sourceStatus.set(source.source_id, { status: 'failed', reason: refreshed.reason });
          results.push({ source_id: source.source_id, ok: false, reason: refreshed.reason });
          continue;
        }
        if (refreshed.quarantined_plugins.length) {
          const quarantine = await this._applyAdvisories(source, refreshed);
          if (!quarantine?.ok) {
            this.sourceStatus.set(source.source_id, {
              status: 'failed', reason: 'catalog_quarantine_failed',
            });
            results.push({ source_id: source.source_id, ok: false,
              reason: 'catalog_quarantine_failed' });
            continue;
          }
        }
        for (const entry of refreshed.entries) {
          nextEntries.set(`${entry.source_id}/${entry.publisher_id}/${entry.plugin_id}/${entry.version}`, entry);
        }
        nextRuntimeTargets.set(source.source_id, refreshed.runtimeTargets);
        nextAdvisorySnapshots.set(source.source_id, refreshed.advisorySnapshot);
        this.sourceStatus.set(source.source_id, { status: 'ready', reason: '' });
        results.push({ source_id: source.source_id, ok: true, entry_count: refreshed.entries.length });
      } catch (error) {
        this.sourceStatus.set(source.source_id, { status: 'failed', reason: 'catalog_refresh_failed' });
        this.log('WARN', 'plugins.catalog.refresh_failed', {
          source_id: source.source_id, error_name: error?.name || 'Error',
        });
        results.push({ source_id: source.source_id, ok: false, reason: 'catalog_refresh_failed' });
      }
    }
    this.entries = nextEntries;
    this.runtimeTargets = nextRuntimeTargets;
    this.advisorySnapshots = nextAdvisorySnapshots;
    this.revision += 1;
    const state = await this.getCatalogState();
    return { ...state, refresh_results: results };
  }

  async _refreshSource(source) {
    let metadataBaseUrl;
    let targetBaseUrl;
    let fetcher;
    if (source.kind === 'offline_mirror') {
      metadataBaseUrl = trailingFileUrl(path.join(source.real_root, 'metadata'));
      targetBaseUrl = trailingFileUrl(path.join(source.real_root, 'targets'));
      fetcher = new ConfinedFileFetcher({ realRoot: source.real_root });
    } else {
      if (!this.networkBroker) return { ok: false, reason: 'catalog_network_unavailable' };
      const request = { operation_schema_version: 1, client_request_id: operationId('catalog_refresh'),
        operation: { kind: 'catalog_refresh', catalog_id: source.source_id } };
      const context = await this.createDistributionContext(request);
      if (!context.ok) return context;
      metadataBaseUrl = source.metadata_base_url;
      targetBaseUrl = source.target_base_url;
      fetcher = new BrokerFetcher({ broker: this.networkBroker,
        operationId: request.client_request_id, consent: context.value.networkConsent,
        deadlineEpochMs: Date.now() + LIMITS.refreshMs, signal: new AbortController().signal });
    }
    const cache = path.join(this.cacheRoot, source.source_id);
    const metadataDir = path.join(cache, 'metadata');
    const targetDir = path.join(cache, 'targets');
    const updaterResult = await refreshTufRepository({
      metadataDir, targetDir, metadataBaseUrl, targetBaseUrl,
      initialRootBytes: Buffer.from(source.pinned_root_base64, 'base64'),
      fetcher,
      trustedHighWater: this.now(),
    });
    if (!updaterResult.ok) return updaterResult;
    let targetDocument;
    try { targetDocument = JSON.parse(await fs.promises.readFile(path.join(metadataDir, 'targets.json'), 'utf8')); }
    catch (_error) { return { ok: false, reason: 'catalog_targets_unavailable' }; }
    const targets = targetDocument?.signed?.targets;
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
      return { ok: false, reason: 'catalog_targets_invalid' };
    }
    const entries = [];
    const runtimeTargets = new Map();
    let advisorySnapshot = EMPTY_ADVISORY;
    let advisoryTargetCount = 0;
    for (const [targetPath, target] of Object.entries(targets)) {
      if (target?.custom?.jenny_kind === 'advisories') {
        advisoryTargetCount += 1;
        if (advisoryTargetCount > 1) return { ok: false, reason: 'catalog_advisory_ambiguous' };
        const advisory = await this._downloadJsonTarget(updaterResult.updater, targetPath);
        if (!advisory.ok) return { ok: false, reason: 'catalog_advisory_unavailable' };
        const validated = this._validatedAdvisories(advisory.value);
        if (!validated.ok) return validated;
        advisorySnapshot = validated.value;
        continue;
      }
      const entry = catalogEntryFromTarget(source.source_id, targetPath, target);
      if (!entry.ok) continue;
      entries.push(entry.value);
      runtimeTargets.set(`${entry.value.publisher_id}/${entry.value.plugin_id}/${entry.value.version}`, {
        updater: updaterResult.updater, entry: entry.value,
      });
    }
    const committed = await this._committedState();
    const quarantined = this._quarantinedPlugins(advisorySnapshot, committed);
    if (!quarantined.ok) return quarantined;
    return { ok: true, entries, runtimeTargets, advisorySnapshot,
      quarantined_plugins: quarantined.value };
  }

  _quarantinedPlugins(advisorySnapshot, committed) {
    const quarantined = [];
    for (const plugin of committed.generation?.plugins || []) {
      const evaluated = evaluateAdvisories(advisorySnapshot, {
        publisher_id: plugin.publisher_id,
        plugin_id: plugin.plugin_id,
        version: plugin.resolved_version,
        artifact_digest: plugin.artifact_digest,
        publisher_key_id: plugin.publisher_key_id,
      });
      if (!evaluated.ok) return evaluated;
      if (evaluated.action === 'quarantine') {
        quarantined.push(`${plugin.publisher_id}/${plugin.plugin_id}`);
      }
    }
    return { ok: true, value: [...new Set(quarantined)].sort() };
  }

  async _downloadJsonTarget(updater, targetPath) {
    try {
      const info = await updater.getTargetInfo(targetPath);
      if (!info) return { ok: false, reason: 'target_not_found' };
      const filePath = await updater.downloadTarget(info);
      const bytes = await fs.promises.readFile(filePath);
      if (bytes.length > LIMITS.metadataDocumentBytes) return { ok: false, reason: 'target_too_large' };
      return { ok: true, value: JSON.parse(bytes.toString('utf8')) };
    } catch (_error) { return { ok: false, reason: 'target_download_failed' }; }
  }

  _validatedAdvisories(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.advisories)
      || value.advisories.length > 1024 || !Array.isArray(value.revoked_artifacts)
      || value.revoked_artifacts.length > 1024 || !Array.isArray(value.revoked_keys)
      || value.revoked_keys.length > 1024) {
      return { ok: false, reason: 'advisory_snapshot_invalid' };
    }
    const advisories = [];
    for (const row of value.advisories) {
      if (!row || !ID_RE.test(row.publisher_id || '') || !ID_RE.test(row.plugin_id || '')
        || typeof row.action !== 'string' || typeof row.version_range !== 'string'
        || row.version_range.length > 128 || (row.advisory_id !== undefined
          && (typeof row.advisory_id !== 'string' || row.advisory_id.length > 128))) {
        return { ok: false, reason: 'advisory_snapshot_invalid' };
      }
      advisories.push({
        advisory_id: row.advisory_id || 'advisory',
        publisher_id: row.publisher_id,
        plugin_id: row.plugin_id,
        version_range: row.version_range,
        action: row.action,
        severity: typeof row.severity === 'string' ? row.severity.slice(0, 32) : 'unknown',
      });
    }
    const snapshot = { revision: value.revision, advisories,
      revoked_artifacts: [...value.revoked_artifacts], revoked_keys: [...value.revoked_keys] };
    const checked = normalizeAdvisories(snapshot);
    return checked.ok ? { ok: true, value: checked.snapshot } : checked;
  }

  _committedState() { return readCommittedState(this.facade, this.baseDir); }

  async _applyAdvisories(source, refreshed) {
    const request = { operation_schema_version: 1, client_request_id: operationId('catalog_refresh'),
      operation: { kind: 'catalog_refresh', catalog_id: source.source_id } };
    const context = await this.createDistributionContext(request);
    if (!context.ok) return context;
    return this.distributionController.startDistributionOperation(request, { ...context.value,
      detached: false,
      refreshCatalog: async () => ({ ok: true, advisorySnapshot: refreshed.advisorySnapshot,
        quarantined_plugins: refreshed.quarantined_plugins }),
    });
  }

  _entry(payload) {
    const sourceId = String(payload.source_id || '');
    const publisherId = String(payload.publisher_id || '');
    const pluginId = String(payload.plugin_id || '');
    const version = String(payload.version || '');
    return this.entries.get(`${sourceId}/${publisherId}/${pluginId}/${version}`) || null;
  }

  async installFromCatalog(payload = {}) { return this._installOrUpdate(payload, false); }
  async updateFromCatalog(payload = {}) { return this._installOrUpdate(payload, true); }

  async _installOrUpdate(payload, update) {
    const entry = this._entry(payload);
    if (!entry || payload.package_sha256 !== entry.package_sha256) {
      return { ok: false, reason: 'catalog_target_stale' };
    }
    const committed = await this._committedState();
    const expectedGenerationId = committed.pointer?.generation_id;
    if (update && !expectedGenerationId) return { ok: false, reason: 'installed_plugin_not_found' };
    const sources = await this._sources();
    if (!sources.ok) return sources;
    const source = sources.sources.find((row) => row.source_id === entry.source_id);
    if (!source) return { ok: false, reason: 'catalog_source_unavailable' };
    const sourceKind = source.kind === 'remote' ? 'signed_catalog' : 'offline_mirror';
    if (sourceKind === 'offline_mirror') {
      const registered = await this.distributionController.selectOfflineMirror({
        sourceId: source.source_id, rootPath: source.real_root,
      });
      if (!registered.ok) return registered;
    }
    const request = { operation_schema_version: 1, client_request_id: operationId(update ? 'update' : 'install'),
      operation: update
        ? { kind: 'update', target: { publisher_id: entry.publisher_id, plugin_id: entry.plugin_id },
          expected_generation_id: expectedGenerationId }
        : { kind: 'install', source_kind: sourceKind,
          source_locator: entry.source_id,
          target: { publisher_id: entry.publisher_id, plugin_id: entry.plugin_id } },
    };
    const context = await this.createDistributionContext(request);
    if (!context.ok) return context;
    const advisorySnapshot = this.advisorySnapshots.get(entry.source_id);
    if (!advisorySnapshot) return { ok: false, reason: 'catalog_refresh_required' };
    return this.distributionController.startDistributionOperation(request, { ...context.value,
      sourceId: entry.source_id,
      updateSourceKind: sourceKind,
      advisorySnapshot,
      advisoryDigest: digest(advisorySnapshot),
      tufRootDigest: source.root_fingerprint,
      acquireCatalogTarget: (target) => this._acquireTarget(entry, target),
    });
  }

  async _acquireTarget(entry) {
    const runtime = this.runtimeTargets.get(entry.source_id)
      ?.get(`${entry.publisher_id}/${entry.plugin_id}/${entry.version}`);
    if (!runtime) return { ok: false, reason: 'catalog_refresh_required' };
    try {
      const info = await runtime.updater.getTargetInfo(entry.target_path);
      const filePath = info && await runtime.updater.downloadTarget(info);
      if (!filePath) return { ok: false, reason: 'catalog_target_unavailable' };
      const bytes = await fs.promises.readFile(filePath);
      if (bytes.length !== entry.package_size_bytes || sha256(bytes) !== entry.package_sha256) {
        return { ok: false, reason: 'catalog_target_digest_mismatch' };
      }
      return { ok: true, bytes, target_path_digest: sha256(Buffer.from(entry.target_path)),
        tuf_root_digest: (await this._sources()).sources.find((row) => row.source_id === entry.source_id)?.root_fingerprint };
    } catch (_error) { return { ok: false, reason: 'catalog_target_unavailable' }; }
  }

  async listRollbackCandidates() {
    const pointer = await readActivePointer(this.facade, this.baseDir);
    const activeId = pointer.status === 'ok' ? pointer.pointer.generation_id : '';
    const candidates = [];
    for (const id of await listGenerationIds(this.facade, this.baseDir)) {
      if (id === activeId) continue;
      const generation = await readGeneration(this.facade, this.baseDir, id);
      if (!generation.ok) continue;
      candidates.push({ generation_id: id, created_at: generation.record.created_at,
        plugins: generation.record.plugins.map((plugin) => ({ publisher_id: plugin.publisher_id,
          plugin_id: plugin.plugin_id, version: plugin.resolved_version })) });
    }
    candidates.sort((left, right) => right.created_at.localeCompare(left.created_at));
    return { ok: true, active_generation_id: activeId || null, candidates: candidates.slice(0, 8) };
  }

  async rollback(payload = {}) {
    const target = String(payload.target_generation_id || '');
    const pointer = await readActivePointer(this.facade, this.baseDir);
    if (pointer.status !== 'ok' || !ID_RE.test(target)) return { ok: false, reason: 'rollback_target_invalid' };
    const request = { operation_schema_version: 1, client_request_id: operationId('rollback'),
      operation: { kind: 'rollback', target_generation_id: target,
        expected_generation_id: pointer.pointer.generation_id } };
    const context = await this.createDistributionContext(request);
    if (!context.ok) return context;
    return this.distributionController.startDistributionOperation(request, context.value);
  }

  retryRecovery() { return this.distributionController.recover(); }
}

module.exports = { PluginCatalogService };
