'use strict';

const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');
const { readCommittedState } = require('./lifecycle/commit-sequence');
const { exportAuditLog } = require('./lifecycle/audit-export');
const { evaluateStatusQuery } = require('./store/operation-receipts');
const { evaluateActivationEligibility, reverifyInstalledPackage } = require('./runtime/declarative-compiler');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE } = require('./identity/authority-id');
const { isValidOperationId } = require('./paths/store-paths');
const { DISABLED_ONLY_STATE } = require('./lifecycle/stage-gate');
const { readSettingsState } = require('./store/settings-state-store');
const { getEvidence } = require('./store/distribution-evidence-store');
const { DEVELOPER_UNSIGNED_KEY_ID } = require('./package/distribution-package-intake');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function indexDeclarativeContents(verdict = {}) {
  const contents = Array.isArray(verdict.declarative_contents)
    ? verdict.declarative_contents : [];
  const metadata = Array.isArray(verdict.declarative_content_texts)
    ? verdict.declarative_content_texts : [];
  const indexed = new Map();
  for (let index = 0; index < contents.length; index += 1) {
    const content = contents[index];
    if (!isPlainObject(content)) continue;
    // V1-V4 embed contribution_id in the checked content. V5 deliberately
    // keeps package identity in the parallel verified metadata record so the
    // reusable view/provider contracts remain package-agnostic.
    const contributionId = typeof content.contribution_id === 'string'
      ? content.contribution_id : metadata[index]?.contribution_id;
    if (typeof contributionId === 'string' && contributionId && !indexed.has(contributionId)) {
      indexed.set(contributionId, content);
    }
  }
  return indexed;
}

function createControlPlaneQueries({
  facade,
  baseDir,
  clock,
  verifyPackage,
  safeMode,
  maxReportedPlugins,
  safeDisplayName,
  posture,
  refuse,
  run,
  runtime,
  getIncompatibility,
  isStoreWritable,
  getRecoverySummary,
  getReceiptEvictionCount,
  getLastOperation,
  managedPolicy = null,
}) {
  const privilegedKinds = new Set(['native_mcp', 'session_provider', 'engine_adapter', 'hook']);
  async function summarizePlugins(generation) {
    const entries = generation && Array.isArray(generation.plugins) ? generation.plugins : [];
    const listed = [];
    for (const entry of entries.slice(0, maxReportedPlugins)) {
      const reverified = await reverifyInstalledPackage({
        facade,
        baseDir,
        pluginEntry: entry,
        verifyPackage,
        now: clock(),
      });
      const activation = evaluateActivationEligibility({
        pluginEntry: entry,
        verdict: reverified.ok ? reverified.verdict : null,
        safeMode: safeMode?.active === true,
        storeReadOnly: Boolean(getIncompatibility()) || !isStoreWritable(),
      });
      const contentById = reverified.ok
        ? indexDeclarativeContents(reverified.verdict) : new Map();
      const contributionRows = entry.contributions || (reverified.ok
        ? reverified.verdict.manifest.contributions.map((item) => ({
          contribution_id: item.contribution_id,
          kind: item.kind,
          desired_enabled: entry.desired_state === 'active',
          effective_enabled: entry.effective_state === 'active'
            && (item.kind !== 'mcp_descriptor' || entry.remote_binding_digests?.length > 0),
          blocked_reason: entry.effective_state === 'active' ? 'none' : 'master_disabled',
          content_digest: item.content_sha256,
        })) : []);
      const contributions = [];
      for (const contribution of contributionRows.slice(0, 32)) {
        const content = contentById.get(contribution.contribution_id);
        const manifestContribution = reverified.ok
          ? reverified.verdict.manifest.contributions.find((item) => item.contribution_id === contribution.contribution_id)
          : null;
        const policyBlocked = privilegedKinds.has(contribution.kind)
          && managedPolicy?.guard?.().ok === false;
        const summary = {
          contribution_id: contribution.contribution_id,
          display_name: safeDisplayName(manifestContribution?.name),
          kind: contribution.kind,
          desired_enabled: contribution.desired_enabled === true,
          effective_enabled: contribution.effective_enabled === true && !policyBlocked,
          blocked_reason: policyBlocked ? 'managed_policy' : contribution.blocked_reason,
          content_digest: contribution.content_digest,
        };
        if (content?.payload?.kind === 'theme') summary.theme = { tokens: content.payload.tokens };
        if (content?.payload?.kind === 'command') {
          summary.command = {
            target_kind: content.payload.target_kind,
            inputs: content.payload.inputs,
          };
        }
        if (content?.payload?.kind === 'settings_schema') {
          summary.settings = { fields: content.payload.fields, revision: 0, values: null };
          if (contribution.settings_ref?.kind === 'state') {
            const stored = await readSettingsState(facade, baseDir, {
              publisherId: entry.publisher_id,
              pluginId: entry.plugin_id,
              contributionId: contribution.contribution_id,
              digest: contribution.settings_ref.digest,
            });
            if (stored.ok && stored.state.revision === contribution.settings_ref.revision) {
              summary.settings.revision = stored.state.revision;
              summary.settings.values = Object.fromEntries(
                stored.state.values.map((item) => [item.key, item.value])
              );
            }
          }
        }
        if (content?.payload?.kind === 'mcp_descriptor') {
          summary.mcp = {
            display_name: safeDisplayName(content.payload.display_name),
            transport_class: content.payload.transport_class,
            capabilities: content.payload.capabilities || content.payload.feature_classes,
            endpoint_origin_digest: content.payload.endpoint_origin_digest || null,
            destination_scope: content.payload.destination_scope || null,
            auth_policy: content.payload.auth_policy || 'none',
            active: contribution.effective_enabled === true,
          };
        }
        const stage7Content = content?.payload || content || null;
        if (stage7Content?.content_schema_version === 5) {
          summary.view = {
            view_kind: stage7Content.view_kind,
            artifact_kinds: stage7Content.artifact_kinds || [],
            provider_ref: stage7Content.provider_ref || null,
          };
        }
        if (stage7Content?.descriptor_schema_version === 5) {
          summary.provider = {
            provider_id: stage7Content.provider_id,
            auth_profile: stage7Content.auth_profile,
            models: Array.isArray(stage7Content.model_catalog)
              ? stage7Content.model_catalog.map((item) => ({ id: item.id, display_name: item.label }))
              : [],
          };
        }
        contributions.push(summary);
      }
      listed.push({
        publisher_id: PUBLISHER_ID_RE.test(String(entry.publisher_id)) ? entry.publisher_id : null,
        plugin_id: PLUGIN_ID_RE.test(String(entry.plugin_id)) ? entry.plugin_id : null,
        effective_state: entry.effective_state,
        desired_state: entry.desired_state,
        display_name: safeDisplayName(entry.display_name),
        resolved_version: entry.resolved_version,
        source_kind: entry.publisher_key_id === DEVELOPER_UNSIGNED_KEY_ID
          ? 'developer_link' : reverified.package_record?.source_identity?.kind || '',
        generation_id: generation?.generation_id || null,
        contributions,
        ...activation,
      });
    }
    return {
      installed_count: entries.length,
      plugins: listed,
      plugins_truncated: entries.length > listed.length,
    };
  }

  async function getState() {
    return run('get_state', async () => {
      const state = await readCommittedState(facade, baseDir);
      const pointer = state.pointer;
      return {
        ok: true,
        ...posture(),
        disabled_only_state: DISABLED_ONLY_STATE,
        read_only: Boolean(getIncompatibility()),
        store_writable: isStoreWritable(),
        incompatibility: getIncompatibility(),
        pointer_status: state.pointerStatus,
        commit_epoch: pointer ? pointer.commit_epoch : 0,
        revision: pointer ? pointer.revision : 0,
        ...await summarizePlugins(state.generation),
        ...runtime.state(),
        managed_policy: managedPolicy?.status?.() || null,
        recovery: getRecoverySummary(),
        receipt_eviction_count: getReceiptEvictionCount(),
        last_operation: getLastOperation(),
      };
    });
  }

  async function getPolicyStatus() {
    return run('policy_status', async () => ({
      ok: true,
      ...posture(),
      disabled_only: false,
      committed_state: DISABLED_ONLY_STATE,
      activation_scope: posture().activation_scope,
      contribution_execution_permitted: true,
      privileged_execution_permitted: managedPolicy?.guard?.().ok === true,
      plugin_network_permitted: posture().stage >= 5,
      plugin_views_permitted: posture().stage >= 7,
      plugin_mcp_permitted: posture().stage >= 5,
      managed_policy: managedPolicy?.status?.() || null,
    }), { needsStore: false });
  }

  async function getDetails(payload = {}) {
    return run('get_details', async () => {
      if (!isPlainObject(payload)
        || !PUBLISHER_ID_RE.test(String(payload.publisher_id || ''))
        || !PLUGIN_ID_RE.test(String(payload.plugin_id || ''))) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'plugin_identity_invalid');
      }
      const state = await readCommittedState(facade, baseDir);
      const summarized = await summarizePlugins(state.generation);
      const plugin = summarized.plugins.find((entry) => entry.publisher_id === payload.publisher_id
        && entry.plugin_id === payload.plugin_id);
      if (!plugin) return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'plugin_not_installed');
      const installed = state.generation?.plugins?.find((entry) => entry.publisher_id === payload.publisher_id
        && entry.plugin_id === payload.plugin_id);
      const sourceEvidence = installed?.source_trust_digest
        ? await getEvidence(facade, baseDir, 'source_trust', installed.source_trust_digest) : null;
      const authentication = plugin.contributions.filter((entry) => entry.mcp || entry.provider).map((entry) => ({
        contribution_id: entry.contribution_id,
        kind: entry.mcp ? 'mcp' : 'provider',
        policy: entry.mcp?.auth_policy || entry.provider?.auth_profile || 'none',
        active: entry.mcp?.active === true || entry.effective_enabled === true,
      }));
      return { ok: true, ...posture(), plugin: { ...plugin,
        source_evidence: { kind: String(sourceEvidence?.value?.source?.kind || 'verified_package'),
          evidence_digest: installed?.source_trust_digest || '' },
        signature_evidence: { publisher_key_id: installed?.publisher_key_id || '',
          artifact_digest: installed?.artifact_digest || '', current_publisher_trust: true },
        lifecycle: { generation_id: state.generation?.generation_id || '',
          desired_state: installed?.desired_state || plugin.desired_state,
          effective_state: installed?.effective_state || plugin.effective_state,
          cleanup_status: 'not_pending' },
        authentication,
        revocation: { status: 'current', advisory_snapshot_digest: installed?.advisory_snapshot_digest || '' },
      } };
    });
  }

  async function getOperation(payload = {}) {
    return run('operation_status', async () => {
      if (!isPlainObject(payload)) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'payload_not_an_object');
      }
      const operationId = payload.operation_id ?? payload.operationId;
      if (!isValidOperationId(operationId)) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'invalid_operation_id');
      }
      const query = await evaluateStatusQuery(facade, baseDir, { operationId, now: clock() });
      if (query.classification === 'terminal' || query.classification === 'pending') {
        return {
          ok: true,
          ...posture(),
          classification: query.classification,
          receipt: query.receipt,
        };
      }
      const code = query.classification === 'outcome_indeterminate'
        ? PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE
        : PLUGIN_ERROR_CODES.IDEMPOTENCY_EXPIRED;
      return refuse(code, query.reason || query.classification);
    });
  }

  async function exportAudit(payload = {}) {
    return run('export_audit', async () => {
      if (!isPlainObject(payload)) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'payload_not_an_object');
      }
      const exported = await exportAuditLog(facade, baseDir, {
        now: clock(),
        managedPolicy: managedPolicy?.status?.() || null,
        policyMaxEntries: managedPolicy?.status?.().audit_max_entries || 1000,
        ...(payload.filter === undefined ? {} : { filter: payload.filter }),
        ...(Number.isInteger(payload.max_entries) ? { maxEntries: payload.max_entries } : {}),
      });
      if (!exported.ok) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, exported.reason, {
          detail: exported.detail || null,
        });
      }
      return { ok: true, ...posture(), document: exported.document };
    });
  }

  return Object.freeze({ getState, getDetails, getPolicyStatus, getOperation, exportAudit });
}

module.exports = { createControlPlaneQueries, indexDeclarativeContents };
