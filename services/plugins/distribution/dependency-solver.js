'use strict';

const crypto = require('node:crypto');
const semver = require('semver');
const { validate } = require('../contracts/generated-plugin-contracts');
const { stableStringify } = require('../package/canonical-metadata');
const { LIMITS } = require('./distribution-limits');

function identityOf(value) { return `${value.publisher_id}/${value.plugin_id}`; }
function fail(reason, stats = {}) { return { ok: false, reason, stats }; }
function matchesProviderBinding(candidate, binding) {
  return identityOf(candidate) === identityOf(binding) && candidate.version === binding.version
    && candidate.artifact_digest === binding.artifact_digest
    && candidate.publisher_key_id === binding.publisher_key_id;
}
function solveDependencies({ candidates, roots, selectedOptional = [], capabilityProviders = [], now = () => Date.now(), limits = {} }) {
  const cap = { nodes: LIMITS.solverNodes, deps: LIMITS.dependenciesPerNode, candidates: LIMITS.candidatesPerPlugin,
    decisions: LIMITS.solverDecisions, incompatibilities: LIMITS.solverIncompatibilities, ms: LIMITS.solverMs, ...limits };
  const started = now(); const stats = { decisions: 0, incompatibilities: 0 };
  if (!Array.isArray(candidates) || !Array.isArray(roots) || candidates.length > cap.nodes * cap.candidates) return fail('solver_input_limit', stats);
  const byIdentity = new Map();
  for (const candidate of candidates) {
    const id = identityOf(candidate); const list = byIdentity.get(id) || [];
    if (!semver.valid(candidate.version) || !Array.isArray(candidate.dependencies) || candidate.dependencies.length > cap.deps) return fail('solver_candidate_invalid', stats);
    list.push(candidate); byIdentity.set(id, list);
  }
  for (const list of byIdentity.values()) {
    list.sort((a, b) => semver.rcompare(a.version, b.version) || a.artifact_digest.localeCompare(b.artifact_digest));
    if (list.length > cap.candidates) return fail('solver_candidate_limit', stats);
  }
  const selectedOptionalSet = new Set(selectedOptional);
  const providers = new Map();
  for (const item of capabilityProviders) {
    if (item.trusted_tuf_metadata !== true) continue;
    const list = providers.get(item.capability_id) || []; list.push(item); providers.set(item.capability_id, list);
  }
  const initial = roots.map((root) => ({ ...root, kind: 'required' })).sort((a, b) => identityOf(a).localeCompare(identityOf(b)));
  function expired() { return now() - started > cap.ms; }
  function recurse(selected, pending, edges) {
    if (expired()) return fail('solver_timeout', stats);
    if (stats.decisions > cap.decisions) return fail('solver_decision_limit', stats);
    if (stats.incompatibilities > cap.incompatibilities) return fail('solver_incompatibility_limit', stats);
    if (selected.size > cap.nodes) return fail('solver_node_limit', stats);
    if (!pending.length) {
      for (const candidate of selected.values()) {
        for (const dep of candidate.dependencies.filter((row) => row.kind === 'peer')) {
          const peer = selected.get(identityOf(dep));
          if (peer && !semver.satisfies(peer.version, dep.version_range, { includePrerelease: true })) return fail('peer_constraint_unsatisfied', stats);
        }
      }
      return { ok: true, selected, edges };
    }
    const requirement = pending[0]; const rest = pending.slice(1); let target = requirement;
    if (requirement.kind === 'capability') {
      const matches = (providers.get(requirement.capability_id) || []).filter((item) => semver.satisfies(item.version, requirement.version_range, { includePrerelease: true }));
      const ids = [...new Set(matches.map(identityOf))].sort();
      if (ids.length !== 1) return fail(ids.length ? 'capability_provider_ambiguous' : 'capability_provider_missing', stats);
      const trusted = matches.find((item) => identityOf(item) === ids[0]);
      const boundOptions = (byIdentity.get(ids[0]) || []).filter((candidate) => (
        candidate.version === trusted.version
        && (!trusted.artifact_digest || candidate.artifact_digest === trusted.artifact_digest)
        && (!trusted.publisher_key_id || candidate.publisher_key_id === trusted.publisher_key_id)
      ));
      if (boundOptions.length !== 1) {
        return fail(boundOptions.length ? 'capability_provider_ambiguous' : 'capability_provider_missing', stats);
      }
      const binding = boundOptions[0];
      target = { ...trusted, version_range: requirement.version_range, kind: 'capability',
        provider_binding: { publisher_id: binding.publisher_id, plugin_id: binding.plugin_id,
          version: binding.version, artifact_digest: binding.artifact_digest,
          publisher_key_id: binding.publisher_key_id } };
    }
    if (target.kind === 'optional' && !selectedOptionalSet.has(identityOf(target))) return recurse(selected, rest, edges);
    if (target.kind === 'peer' && !selected.has(identityOf(target))) return recurse(selected, rest, edges);
    const id = identityOf(target); const existing = selected.get(id);
    if (existing) return semver.satisfies(existing.version, target.version_range, { includePrerelease: true })
      && (!target.provider_binding || matchesProviderBinding(existing, target.provider_binding))
      ? recurse(selected, rest, edges) : fail('dependency_conflict', stats);
    const options = (byIdentity.get(id) || []).filter((item) => semver.satisfies(item.version, target.version_range, { includePrerelease: true })
      && (!target.provider_binding || matchesProviderBinding(item, target.provider_binding)));
    for (const candidate of options) {
      stats.decisions += 1; const nextSelected = new Map(selected).set(id, candidate);
      const deps = candidate.dependencies.map((dep) => ({ ...dep })).sort((a, b) => (a.kind + identityOf(a) + (a.capability_id || '')).localeCompare(b.kind + identityOf(b) + (b.capability_id || '')));
      const result = recurse(nextSelected, [...deps, ...rest], [...edges, ...deps.map((dep) => ({ from: id, to: dep.kind === 'capability' ? dep.capability_id : identityOf(dep), kind: dep.kind }))]);
      if (result.ok) return result; stats.incompatibilities += 1;
      if (['solver_timeout', 'solver_decision_limit', 'solver_incompatibility_limit', 'solver_node_limit',
        'capability_provider_ambiguous', 'capability_provider_missing'].includes(result.reason)) return result;
    }
    return fail('dependency_unsatisfied', stats);
  }
  const solved = recurse(new Map(), initial, []); if (!solved.ok) return solved;
  const nodes = [...solved.selected.values()].sort((a, b) => identityOf(a).localeCompare(identityOf(b))).map((item) => ({
    publisher_id: item.publisher_id, plugin_id: item.plugin_id, resolved_version: item.version,
    artifact_digest: item.artifact_digest, publisher_key_id: item.publisher_key_id,
    source_identity: item.source_identity,
    dependencies: item.dependencies.filter((dep) => dep.kind !== 'peer' || solved.selected.has(identityOf(dep))).map((dep) => {
      if (dep.kind === 'capability') {
        const trustedProviders = (providers.get(dep.capability_id) || [])
          .filter((item) => semver.satisfies(item.version, dep.version_range, { includePrerelease: true }));
        const provider = [...solved.selected.values()].find((candidate) => trustedProviders.some((item) => (
          identityOf(item) === identityOf(candidate) && item.version === candidate.version
          && (!item.artifact_digest || item.artifact_digest === candidate.artifact_digest)
          && (!item.publisher_key_id || item.publisher_key_id === candidate.publisher_key_id)
        )));
        return { to_publisher_id: provider.publisher_id, to_plugin_id: provider.plugin_id, edge_kind: 'capability' };
      }
      return { to_publisher_id: dep.publisher_id, to_plugin_id: dep.plugin_id, edge_kind: dep.kind };
    }).sort((a, b) => (a.to_publisher_id + a.to_plugin_id + a.edge_kind).localeCompare(b.to_publisher_id + b.to_plugin_id + b.edge_kind)),
  }));
  const graphHash = crypto.createHash('sha256').update(stableStringify(nodes), 'utf8').digest('hex');
  const lock = { lock_schema_version: 1, graph_hash: graphHash, nodes };
  const checked = validate('PluginLockV1', lock); if (!checked.ok) return fail('solver_lock_invalid', stats);
  return { ok: true, lock: checked.value, graph_hash: graphHash, stats };
}
module.exports = { solveDependencies };
