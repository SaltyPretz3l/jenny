'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { solveDependencies } = require('../../../services/plugins/distribution/dependency-solver');
const d = (value) => value.repeat(64);
function candidate(publisher_id, plugin_id, version, dependencies = []) { return { publisher_id, plugin_id, version, dependencies,
  artifact_digest: d(plugin_id === 'root' ? 'a' : 'b'), publisher_key_id: d('f'), source_identity: { kind: 'https_url', url_digest: d('e') } }; }
test('solver is deterministic across candidate permutations and required dependencies', () => {
  const root = candidate('acme', 'root', '1.0.0', [{ kind: 'required', publisher_id: 'acme', plugin_id: 'dep', version_range: '^2.0.0' }]);
  const dep1 = candidate('acme', 'dep', '2.0.0'); const dep2 = candidate('acme', 'dep', '2.1.0');
  const input = { roots: [{ publisher_id: 'acme', plugin_id: 'root', version_range: '*' }] };
  const a = solveDependencies({ ...input, candidates: [root, dep1, dep2] });
  const b = solveDependencies({ ...input, candidates: [dep2, root, dep1] });
  assert.equal(a.ok, true); assert.deepEqual(a.lock, b.lock);
  assert.equal(a.lock.nodes.find((node) => node.plugin_id === 'dep').resolved_version, '2.1.0');
});
test('peer dependencies do not pull and ambiguous capability providers fail closed', () => {
  const root = candidate('acme', 'root', '1.0.0', [{ kind: 'peer', publisher_id: 'acme', plugin_id: 'peer', version_range: '*' }, { kind: 'capability', capability_id: 'render', version_range: '*' }]);
  const providers = [
    { publisher_id: 'acme', plugin_id: 'one', capability_id: 'render', version: '1.0.0', trusted_tuf_metadata: true },
    { publisher_id: 'acme', plugin_id: 'two', capability_id: 'render', version: '1.0.0', trusted_tuf_metadata: true }];
  assert.equal(solveDependencies({ candidates: [root], roots: [{ publisher_id: 'acme', plugin_id: 'root', version_range: '*' }], capabilityProviders: providers }).reason, 'capability_provider_ambiguous');
});

test('a unique capability edge is derived only from trusted TUF provider metadata', () => {
  const root = candidate('acme', 'root', '1.0.0', [{ kind: 'capability', capability_id: 'render', version_range: '^2.0.0' }]);
  const provider = candidate('acme', 'renderer', '2.1.0');
  const result = solveDependencies({ candidates: [root, provider], roots: [{ publisher_id: 'acme', plugin_id: 'root', version_range: '*' }],
    capabilityProviders: [{ publisher_id: 'acme', plugin_id: 'renderer', capability_id: 'render', version: '2.1.0', trusted_tuf_metadata: true }] });
  assert.equal(result.ok, true); assert.deepEqual(result.lock.nodes.find((node) => node.plugin_id === 'root').dependencies,
    [{ to_publisher_id: 'acme', to_plugin_id: 'renderer', edge_kind: 'capability' }]);
});

test('an untrusted TUF provider yields no capability edge at all', () => {
  // Every capabilityProviders fixture in this file set trusted_tuf_metadata:true,
  // so the trust filter could be deleted outright with nothing to notice. This is
  // the supply-chain gate: an untrusted provider must not resolve.
  const root = candidate('acme', 'root', '1.0.0', [
    { kind: 'capability', capability_id: 'render', version_range: '^2.0.0' },
  ]);
  const provider = candidate('acme', 'renderer', '2.1.0');
  const result = solveDependencies({ candidates: [root, provider],
    roots: [{ publisher_id: 'acme', plugin_id: 'root', version_range: '*' }],
    capabilityProviders: [{ publisher_id: 'acme', plugin_id: 'renderer', capability_id: 'render',
      version: '2.1.0', trusted_tuf_metadata: false }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'capability_provider_missing');
});

test('capability resolution selects the exact trusted provider version and artifact identity', () => {
  const root = candidate('acme', 'root', '1.0.0', [
    { kind: 'capability', capability_id: 'render', version_range: '^2.0.0' },
  ]);
  const trusted = { ...candidate('acme', 'renderer', '2.1.0'), artifact_digest: d('c') };
  const untrusted = { ...candidate('acme', 'renderer', '2.9.0'), artifact_digest: d('d') };
  // Same VERSION as the trusted provider, different artifact. The 2.9.0 decoy
  // above is filtered out by version before the digest binding is ever consulted,
  // so it could not detect that binding being dropped.
  const digestDecoy = { ...candidate('acme', 'renderer', '2.1.0'), artifact_digest: d('9') };
  const result = solveDependencies({ candidates: [root, digestDecoy, trusted, untrusted],
    roots: [{ publisher_id: 'acme', plugin_id: 'root', version_range: '*' }],
    capabilityProviders: [{ publisher_id: 'acme', plugin_id: 'renderer', capability_id: 'render',
      version: trusted.version, artifact_digest: trusted.artifact_digest,
      publisher_key_id: trusted.publisher_key_id, trusted_tuf_metadata: true }] });
  const selected = result.lock.nodes.find((node) => node.plugin_id === 'renderer');
  assert.equal(selected.resolved_version, '2.1.0');
  assert.equal(selected.artifact_digest, trusted.artifact_digest);
});

test('selected optional dependencies pull explicitly and solver limits fail closed', () => {
  const root = candidate('acme', 'root', '1.0.0', [{ kind: 'optional', publisher_id: 'acme', plugin_id: 'extra', version_range: '^1.0.0' }]);
  const extra = candidate('acme', 'extra', '1.0.0'); const roots = [{ publisher_id: 'acme', plugin_id: 'root', version_range: '*' }];
  assert.equal(solveDependencies({ candidates: [root, extra], roots }).lock.nodes.length, 1);
  assert.equal(solveDependencies({ candidates: [root, extra], roots, selectedOptional: ['acme/extra'] }).lock.nodes.length, 2);
  assert.equal(solveDependencies({ candidates: [root, extra], roots, selectedOptional: ['acme/extra'], limits: { nodes: 1 } }).reason, 'solver_node_limit');
  assert.equal(solveDependencies({ candidates: [root, candidate('acme', 'root', '1.1.0')], roots, limits: { candidates: 1 } }).reason, 'solver_candidate_limit');
});

test('exact semver prerelease ranges are delegated to semver 7.7.4', () => {
  const beta = candidate('acme', 'root', '1.0.0-beta.2');
  const result = solveDependencies({ candidates: [beta], roots: [{ publisher_id: 'acme', plugin_id: 'root', version_range: '>=1.0.0-beta.1 <1.0.0' }] });
  assert.equal(result.ok, true);
});
test('every solver resource budget fails closed with a stable reason', () => {
  const roots = [{ publisher_id: 'acme', plugin_id: 'root', version_range: '*' }];
  const root = candidate('acme', 'root', '1.0.0');
  assert.equal(solveDependencies({ candidates: [root], roots, limits: { decisions: 0 } }).reason, 'solver_decision_limit');
  assert.equal(solveDependencies({ candidates: [candidate('acme', 'root', '1.0.0', [
    { kind: 'required', publisher_id: 'acme', plugin_id: 'a', version_range: '*' },
    { kind: 'required', publisher_id: 'acme', plugin_id: 'b', version_range: '*' }])], roots, limits: { deps: 1 } }).reason,
  'solver_candidate_invalid');
  let tick = 0;
  assert.equal(solveDependencies({ candidates: [root], roots, now: () => { tick += 3; return tick; }, limits: { ms: 1 } }).reason,
    'solver_timeout');
  const conflicting = candidate('acme', 'root', '2.0.0', [{ kind: 'required', publisher_id: 'acme', plugin_id: 'missing', version_range: '*' }]);
  assert.equal(solveDependencies({ candidates: [conflicting, root], roots, limits: { incompatibilities: 0 } }).reason,
    'solver_incompatibility_limit');
});
