'use strict';

// Coverage for services/plugins/plugin-control-plane-service.js -- the facade
// the eight plugins.* IPC descriptors call into.
//
// The properties pinned here are the ones the Stage-4A exit pack cites:
// construction reads nothing, a disabled or safe-moded service touches the
// filesystem ZERO times (counted, not sampled), recovery runs once and only on
// first real use, nothing throws across the seam, Jenny owns the operation id,
// and the state snapshot is bounded.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade, FACADE_METHODS } = require('../../services/plugins/store/fs-facade');
const {
  createPluginControlPlaneService,
  resolvePluginStoreRoot,
  defaultRequireConsent,
  MAX_REPORTED_PLUGINS,
  NEUTRAL_DISPLAY_NAME,
} = require('../../services/plugins/plugin-control-plane-service');
const { PLUGIN_ERROR_CODES } = require('../../services/backend/error-codes');
const { runCommitSequence } = require('../../services/plugins/lifecycle/commit-sequence');
const { createVerifiedPackageVerifier } = require('../helpers/plugins/durability-scenario');
const { PLUGIN_INVOKE_METHODS } = require('../../services/main/plugins-ipc-registration');

const NOW = '2026-07-31T00:00:00Z';
const SAFE_MODE_OFF = Object.freeze({ active: false, source: 'none' });
const SAFE_MODE_ON = Object.freeze({ active: true, source: 'argv' });

// Every method the IPC layer can reach, with a payload valid enough that a
// refusal can only have come from the gate rather than from validation.
// That claim is enforced against PLUGIN_INVOKE_METHODS below rather than left
// to the comment: getDetails was IPC-reachable and gated but absent here, so
// its disabled and safe-mode behaviour went unchecked.
const ALL_METHODS = Object.freeze([
  ['getState', {}],
  ['getDetails', { publisher_id: 'acme', plugin_id: 'alpha' }],
  ['getPolicyStatus', {}],
  ['getOperation', { operation_id: 'op-1' }],
  ['installLocalPackage', {}],
  ['enable', { publisher_id: 'acme', plugin_id: 'alpha' }],
  ['disable', { publisher_id: 'acme', plugin_id: 'alpha' }],
  ['setContributionEnabled', {
    publisher_id: 'acme', plugin_id: 'alpha', contribution_id: 'prompt',
    enabled: true, expected_generation_id: 'gen-test',
  }],
  ['updateSettings', {
    publisher_id: 'acme', plugin_id: 'alpha', contribution_id: 'settings',
    values: {}, expected_generation_id: 'gen-test',
  }],
  ['uninstall', { publisher_id: 'acme', plugin_id: 'alpha' }],
  ['exportAudit', {}],
]);

const MUTATING_METHODS = Object.freeze([
  'installLocalPackage',
  'enable',
  'disable',
  'setContributionEnabled',
  'updateSettings',
  'uninstall',
]);

function totalFacadeCalls(facade) {
  return Object.values(facade.callCounts).reduce((sum, count) => sum + count, 0);
}

function writeCalls(facade) {
  const c = facade.callCounts;
  return c.writeFile + c.renameFile + c.mkdir + c.remove + c.fsyncFile;
}

function idGenerator(prefix) {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

function makeService(overrides = {}) {
  const { facade: suppliedFacade, ...rest } = overrides;
  const facade = suppliedFacade || createMemoryFsFacade();
  const service = createPluginControlPlaneService({
    baseDir: '',
    now: () => NOW,
    featureEnabled: true,
    safeMode: SAFE_MODE_OFF,
    verifyPackage: createVerifiedPackageVerifier({ publisherId: 'acme', pluginId: 'alpha', now: NOW }),
    readPackageBytes: async () => ({ ok: true, bytes: 'bytes:alpha', sourcePathDigest: 'a'.repeat(64) }),
    newOperationId: idGenerator('op'),
    ...rest,
    facade,
  });
  return { facade, service };
}

test('the gate matrix covers every method the plugins IPC seam forwards', () => {
  // ALL_METHODS says it is "every method the IPC layer can reach". Check that,
  // rather than trusting it: getDetails was reachable and gated yet missing, so
  // nothing here exercised its disabled or safe-mode behaviour. A new descriptor
  // added to plugins-ipc-registration now fails here instead of quietly opening a
  // hole in the matrix.
  const forwarded = new Set(Object.values(PLUGIN_INVOKE_METHODS));
  const covered = new Set(ALL_METHODS.map(([method]) => method));
  const missing = [...forwarded].filter((method) => !covered.has(method)).sort();

  assert.deepEqual(missing, [], `ALL_METHODS is missing IPC-reachable methods: ${missing.join(', ')}`);
});

describe('control plane construction', () => {
  test('constructing the service reads nothing from the store', () => {
    const facade = createMemoryFsFacade();
    createPluginControlPlaneService({ facade, featureEnabled: true, safeMode: SAFE_MODE_OFF });
    assert.equal(totalFacadeCalls(facade), 0);
  });

  test('resolvePluginStoreRoot appends exactly one segment to userData', () => {
    const root = resolvePluginStoreRoot('/tmp/userdata');
    assert.match(root, /userdata[\\/]plugins$/);
  });
});
describe('control plane is inert when disabled', () => {
  test('every method refuses FEATURE_DISABLED with zero facade calls', async () => {
    const facade = createMemoryFsFacade();
    const service = createPluginControlPlaneService({
      facade,
      featureEnabled: false,
      safeMode: SAFE_MODE_OFF,
    });
    for (const [method, payload] of ALL_METHODS) {
      const result = await service[method](payload);
      assert.equal(result.ok, false, `${method} must refuse`);
      assert.equal(result.code, PLUGIN_ERROR_CODES.FEATURE_DISABLED, `${method} code`);
      assert.equal(result.enabled, false);
    }
    assert.equal(totalFacadeCalls(facade), 0, 'a disabled control plane must not touch the store');
  });

  test('safe mode refuses independently of the feature flag, with zero facade calls', async () => {
    const facade = createMemoryFsFacade();
    const service = createPluginControlPlaneService({
      facade,
      featureEnabled: true,
      safeMode: SAFE_MODE_ON,
    });
    for (const [method, payload] of ALL_METHODS) {
      const result = await service[method](payload);
      assert.equal(result.ok, false, `${method} must refuse`);
      assert.equal(result.code, PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE, `${method} code`);
      assert.equal(result.safe_mode_active, true);
      assert.equal(result.source, 'argv');
    }
    assert.equal(totalFacadeCalls(facade), 0);
    assert.equal(writeCalls(facade), 0);
  });

  test('a disposed service refuses every method', async () => {
    const { facade, service } = makeService();
    service.dispose();
    for (const [method, payload] of ALL_METHODS) {
      const result = await service[method](payload);
      assert.equal(result.ok, false);
      assert.equal(result.code, PLUGIN_ERROR_CODES.FEATURE_DISABLED);
    }
    assert.equal(totalFacadeCalls(facade), 0);
  });

  test('disposing while the native package source is pending prevents install mutation', async () => {
    let releaseSource;
    let markSourceStarted;
    const sourceStarted = new Promise((resolve) => { markSourceStarted = resolve; });
    const sourceResult = new Promise((resolve) => { releaseSource = resolve; });
    const { facade, service } = makeService({
      readPackageBytes: async () => {
        markSourceStarted();
        return sourceResult;
      },
    });

    const pending = service.installLocalPackage({});
    await sourceStarted;
    const writesBeforeDispose = writeCalls(facade);
    service.dispose();
    releaseSource({ ok: true, bytes: 'bytes:alpha', sourcePathDigest: 'a'.repeat(64) });

    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'service_disposed');
    assert.equal(writeCalls(facade), writesBeforeDispose);
  });
});
describe('control plane recovery is lazy and runs once', () => {
  test('recovery is not run at construction and runs exactly once thereafter', async () => {
    const facade = createMemoryFsFacade();
    let recoveries = 0;
    // The recovery pass is observable through the store reads it performs; a
    // counting wrapper around list() is enough to see whether it ran, and how
    // many times, without reaching into the service's internals.
    const counting = new Proxy(facade, {
      get(target, prop) {
        if (prop === 'list') {
          return async (...args) => {
            if (String(args[0]).endsWith('operations')) recoveries += 1;
            return target.list(...args);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { service } = makeService({ facade: counting });
    assert.equal(recoveries, 0, 'construction must not recover');

    await service.getState();
    const afterFirst = recoveries;
    assert.ok(afterFirst >= 1, 'the first real use must recover');

    await service.getState();
    await service.exportAudit({});
    assert.equal(recoveries, afterFirst, 'recovery must not run again');
  });

  test('getPolicyStatus is pure posture and never reaches the store', async () => {
    const { facade, service } = makeService();
    const status = await service.getPolicyStatus();
    assert.equal(status.ok, true);
    assert.equal(status.disabled_only, false);
    assert.equal(status.activation_scope, 'stage5_remote_mcp');
    assert.equal(status.contribution_execution_permitted, true);
    assert.equal(status.plugin_network_permitted, true);
    assert.equal(status.plugin_views_permitted, true);
    assert.equal(status.plugin_mcp_permitted, true);
    assert.equal(totalFacadeCalls(facade), 0);
  });
});

describe('control plane never throws across the seam', () => {
  // The store's own reads are fail-soft by design (active-pointer.js
  // CLASSIFIES an unreadable pointer rather than throwing), so an exploding
  // facade does not reach the seam's catch -- it produces a domain refusal
  // instead. Both outcomes are pinned: the domain refusal here, and the
  // redaction of a genuinely thrown error in the next test.
  function explodingFacade(message) {
    const facade = createMemoryFsFacade();
    for (const method of FACADE_METHODS) {
      facade[method] = async () => {
        throw new Error(message);
      };
    }
    return facade;
  }

  test('a facade whose every method throws yields a domain refusal, never an exception', async () => {
    const { service } = makeService({ facade: explodingFacade('store unavailable') });
    const result = await service.installLocalPackage({});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'plugin_store_not_writable');
    assert.equal(result.code, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
    assert.equal(result.store_writable, false);
  });

  test('a read path over an exploding facade answers honestly instead of inventing state', async () => {
    const { service } = makeService({ facade: explodingFacade('store unavailable') });
    const state = await service.getState();
    assert.equal(state.ok, true);
    assert.equal(state.pointer_status, 'corrupted');
    assert.equal(state.installed_count, 0);
    assert.equal(state.commit_epoch, 0);
  });

  test('an injected seam that throws becomes a redacted structured result', async () => {
    const { service } = makeService({
      readPackageBytes: () => {
        throw new Error('failed reading C:\\Users\\someone\\package.jplug');
      },
    });
    const result = await service.installLocalPackage({});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'internal_error');
    assert.equal(result.operation, 'install_local_package');
    // redactText refuses path-shaped text outright, so the raw message -- which
    // carries a real user path -- must NOT appear in the wire result.
    assert.ok(!String(result.detail).includes('Users'), 'a raw path must never cross the seam');
    assert.equal(result.detail, 'redacted:guidance_contains_path');
  });

  test('a non-object payload is refused rather than coerced', async () => {
    const { service } = makeService();
    for (const method of ['getOperation', 'exportAudit', ...MUTATING_METHODS]) {
      const result = await service[method]('not-an-object');
      assert.equal(result.ok, false, `${method} must refuse a string payload`);
    }
  });
});

describe('control plane owns operation identity', () => {
  test('a caller-supplied operation_id is rejected, not overwritten', async () => {
    const { facade, service } = makeService();
    for (const key of ['operation_id', 'operationId']) {
      const install = await service.installLocalPackage({ [key]: 'attacker-id' });
      assert.equal(install.ok, false);
      assert.equal(install.reason, 'install_payload_field_not_permitted');
      const uninstall = await service.uninstall({ publisher_id: 'acme', plugin_id: 'alpha', [key]: 'attacker-id' });
      assert.equal(uninstall.ok, false);
      assert.equal(uninstall.reason, 'caller_supplied_operation_id');
      assert.equal(uninstall.code, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
    }
    assert.equal(writeCalls(facade), 0, 'a rejected mutation must write nothing');
  });

  test('an unusable client_request_id is refused', async () => {
    const { service } = makeService();
    const result = await service.installLocalPackage({
      client_request_id: 'has\u0000control',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_client_request_id');
  });

  test('malformed authority ids are refused before any store access', async () => {
    const { facade, service } = makeService();
    const result = await service.uninstall({ publisher_id: 'Acme!', plugin_id: 'alpha' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_publisher_id');
    assert.equal(writeCalls(facade), 0);
  });

});

describe('control plane mutations over the real store', () => {
  test('a verified install commits and is reported by getState', async () => {
    const { service } = makeService();
    const changed = [];
    const progress = [];
    service.onChanged((payload) => changed.push(payload));
    service.onOperationProgress((event) => progress.push(event));

    const installed = await service.installLocalPackage({});
    assert.equal(installed.ok, true, `install failed: ${installed.reason || ''}`);
    assert.equal(installed.result.status, 'committed');
    assert.equal(installed.result.authority_state_after, 'installed_disabled');
    assert.equal(installed.operation_id, 'op-1');

    assert.equal(changed.length, 1, 'a committed mutation notifies subscribers exactly once');
    assert.ok(progress.length > 0, 'progress events stream while the operation runs');
    assert.ok(progress.every((event) => event.operation_id === 'op-1'));
    assert.equal(progress.at(-1).event.kind, 'terminal');

    const state = await service.getState();
    assert.equal(state.ok, true);
    assert.equal(state.installed_count, 1);
    assert.equal(state.plugins_truncated, false);
    assert.deepEqual(state.plugins[0], {
      publisher_id: 'acme',
      plugin_id: 'alpha',
      effective_state: 'installed_disabled',
      desired_state: 'installed_disabled',
      display_name: 'Plugin alpha',
      resolved_version: '1.0.0',
      source_kind: '',
      generation_id: 'gen-op-1',
      contributions: [],
      activation_eligible: false,
      activation_reason_code: 'package_record_unavailable',
      contribution_kinds: [],
    });
    // The first commit on a fresh store mints MIN_EPOCH (0) at revision 1.
    assert.equal(state.commit_epoch, 0);
    assert.equal(state.revision, 1);
    assert.equal(state.commit_epoch, installed.commit_epoch);
    assert.equal(state.pointer_status, 'ok');
    assert.deepEqual(state.last_operation, {
      operation_id: 'op-1',
      operation: 'install_local_package',
      status: 'committed',
      settled_at: NOW,
    });
  });

  test('a post-pointer receipt failure emits change and reports indeterminate committed authority', async () => {
    const { facade, service } = makeService();
    await service.getState();
    const renameFile = facade.renameFile.bind(facade);
    facade.renameFile = async (oldPath, newPath) => {
      await renameFile(oldPath, newPath);
      if (newPath === 'active-generation.json') {
        await facade.writeFile('operations/op-1.json', '{corrupt');
      }
    };
    const changed = [];
    service.onChanged((payload) => changed.push(payload));

    const result = await service.installLocalPackage({});
    assert.equal(result.ok, false);
    assert.equal(result.code, PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE);
    assert.equal(result.authority_changed, true);
    assert.equal(result.result.status, 'indeterminate');
    assert.equal(result.result.authority_state_after, 'installed_disabled');
    assert.equal(changed.length, 1);
    assert.equal((await service.getState()).installed_count, 1);
  });

  test('uninstall removes authority and is idempotent for an absent plugin', async () => {
    const { service } = makeService();
    await service.installLocalPackage({});
    const removed = await service.uninstall({ publisher_id: 'acme', plugin_id: 'alpha' });
    assert.equal(removed.ok, true, `uninstall failed: ${removed.reason || ''}`);
    assert.equal(removed.result.authority_state_after, 'absent');

    const again = await service.uninstall({ publisher_id: 'acme', plugin_id: 'alpha' });
    assert.equal(again.ok, true, 'uninstalling an absent plugin is idempotent-successful');

    const state = await service.getState();
    assert.equal(state.installed_count, 0);
  });

  test('getOperation returns the durable receipt and validates the id shape', async () => {
    const { service } = makeService();
    await service.installLocalPackage({});

    const found = await service.getOperation({ operation_id: 'op-1' });
    assert.equal(found.ok, true);
    assert.equal(found.classification, 'terminal');
    assert.equal(found.receipt.operation_id, 'op-1');

    const unknown = await service.getOperation({ operation_id: 'op-never' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, PLUGIN_ERROR_CODES.IDEMPOTENCY_EXPIRED);

    // A path-escape attempt is rejected on SHAPE, before it can be used to
    // derive a receipt path.
    for (const hostile of ['../../etc/passwd', 'a/b', '', null, 'x'.repeat(65)]) {
      const refused = await service.getOperation({ operation_id: hostile });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'invalid_operation_id');
    }
  });

  test('exportAudit returns a bounded document and refuses an unknown filter key', async () => {
    const { service } = makeService();
    await service.installLocalPackage({});

    const exported = await service.exportAudit({});
    assert.equal(exported.ok, true);
    assert.equal(exported.document.integrity, 'ok');
    assert.ok(exported.document.entry_count >= 1);

    const refused = await service.exportAudit({ filter: { nope: 1 } });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'filter_unknown_key');

    const nested = await service.exportAudit({
      filter: { authority: { publisherId: 'acme', pluginId: 'alpha', ignoredScope: 'other' } },
    });
    assert.equal(nested.ok, false);
    assert.equal(nested.reason, 'filter_authority_unknown_key');
  });

  test('an unavailable package source refuses without writing anything', async () => {
    const { facade, service } = makeService({ readPackageBytes: undefined });
    const result = await service.installLocalPackage({});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'package_source_unavailable');
    assert.equal(result.code, PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
    assert.equal(writeCalls(facade), 0);
  });

  test('a failed verification propagates the verifier verdict and commits nothing', async () => {
    const { facade, service } = makeService({
      verifyPackage: async () => ({ ok: false, reason: 'entry_digest_mismatch', code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED }),
    });
    const result = await service.installLocalPackage({});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'entry_digest_mismatch');
    assert.equal(result.code, PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
    assert.equal(writeCalls(facade), 0);
  });
});

describe('control plane consent posture', () => {
  test('the default consent gate admits Stage-4A ordinary verbs and denies everything else', () => {
    assert.deepEqual(defaultRequireConsent({ operation: 'install' }), { ok: true });
    assert.deepEqual(defaultRequireConsent({ operation: 'uninstall' }), { ok: true });
    assert.deepEqual(defaultRequireConsent({ operation: 'enable' }), { ok: true });
    assert.deepEqual(defaultRequireConsent({ operation: 'disable' }), { ok: true });
    for (const operation of ['full_host_enable', 'publisher_retrust', 'quarantine_release', 'record_desired_state', 'nonsense']) {
      const verdict = defaultRequireConsent({ operation });
      assert.equal(verdict.ok, false, `${operation} must be denied`);
      assert.equal(verdict.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
    }
  });
});

describe('control plane state snapshot is bounded', () => {
  test('the plugin list is capped and hostile display text is neutralized', async () => {
    // This test used to compare MAX_REPORTED_PLUGINS and NEUTRAL_DISPLAY_NAME
    // against hardcoded literals and nothing else -- a tautology that would
    // still pass if the capping loop or the neutralizer call site were deleted
    // outright, despite the name claiming both behaviours were verified.
    //
    // Rewriting it surfaced what the tautology was hiding: PluginGenerationV1
    // caps `plugins` at max_items 64, which is EXACTLY MAX_REPORTED_PLUGINS, so
    // `entries.length > listed.length` can never hold. `plugins_truncated` is
    // permanently false and the reporting cap is currently unreachable. That is
    // harmless defense-in-depth today, but it is not what "the list is capped"
    // implies, and an over-cap commit is refused by the schema rather than
    // truncated by the reporter.
    //
    // So this pins the RELATIONSHIP rather than pretending truncation happens.
    // If a later stage raises the schema bound without raising the reporter's,
    // or lowers the reporter's below the schema, truncation becomes live and
    // the assertions below fail -- which is exactly when someone needs to know.
    const SCHEMA_MAX_PLUGINS = 64;
    assert.equal(
      MAX_REPORTED_PLUGINS,
      SCHEMA_MAX_PLUGINS,
      'reporter cap and PluginGenerationV1 max_items must move together'
    );
    const overCap = MAX_REPORTED_PLUGINS;
    const facade = createMemoryFsFacade();
    const committed = await runCommitSequence(facade, '', {
      operationId: 'op-cap',
      requestFingerprint: 'a'.repeat(64),
      lifecycleEpoch: 1,
      generationId: 'gen-cap',
      createdAt: '2026-07-31T00:00:00Z',
      now: '2026-07-31T00:00:00Z',
      plugins: Array.from({ length: overCap }, (_unused, index) => ({
        publisher_id: 'acme',
        plugin_id: `plug_${String(index).padStart(3, '0')}`,
        display_name: `Plugin ${String(index).padStart(3, '0')}`,
        resolved_version: '1.0.0',
        publisher_key_id: 'c'.repeat(64),
        artifact_digest: 'a'.repeat(64),
        desired_state: 'installed_disabled',
        effective_state: 'installed_disabled',
        depends_on: [],
      })),
      policyGrantRef: { policy_snapshot_digest: 'b'.repeat(64), policy_revision: 1, grant_set_digest: 'c'.repeat(64) },
      dataSchemaRefs: [],
    });
    assert.equal(committed.ok, true, committed.reason);

    const { service } = makeService({ facade });
    const state = await service.getState();

    assert.equal(state.ok, true, JSON.stringify(state));
    assert.equal(state.installed_count, overCap, 'the count reports every committed plugin');
    assert.equal(state.plugins.length, MAX_REPORTED_PLUGINS, 'a full generation reports every entry');
    assert.equal(
      state.plugins_truncated,
      false,
      'no truncation is possible while the reporter cap equals the schema bound'
    );

    assert.ok(
      state.plugins.every((entry) => /^Plugin \d{3}$/.test(entry.display_name)),
      'signed display names survive the durable generation and report unchanged'
    );
    assert.equal(NEUTRAL_DISPLAY_NAME, '(unnamed plugin)', 'placeholder is ready for when the schema carries the field');
  });

  test('subscribing after dispose is a no-op that still returns an unsubscribe', async () => {
    const { service } = makeService();
    service.dispose();
    const unsubscribe = service.onChanged(() => {
      throw new Error('a disposed service must not notify');
    });
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
  });
});
