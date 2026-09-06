'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const { CrashCircuit } = require('../../../services/plugins/restricted-host/crash-circuit');
const { RestrictedHostDiagnostics } = require('../../../services/plugins/restricted-host/diagnostics');
const {
  RestrictedHostProcessSupervisor,
} = require('../../../services/plugins/restricted-host/process-supervisor');
const {
  RESTRICTED_ABI_DIGEST,
  RESTRICTED_PROTOCOL_DIGEST,
} = require('../../../services/plugins/runtime/declarative-compiler');

const binaryPath = String(process.env.JENNY_RESTRICTED_HOST_BINARY || '');
const packagerPath = path.resolve(__dirname, '../../../scripts/plugins/jenny-plugin-v4-packager.mjs');

function supervisorFor(binary, diagnostics = new RestrictedHostDiagnostics()) {
  return new RestrictedHostProcessSupervisor({
    resolveRuntime: async () => ({
      ok: true,
      binary_path: binaryPath,
      binary_digest: crypto.createHash('sha256').update(binary).digest('hex'),
    }),
    diagnostics,
    crashCircuit: new CrashCircuit(),
  });
}

test('real restricted host authenticates load then rejects an invalid component fail-closed', {
  skip: binaryPath ? false : 'set JENNY_RESTRICTED_HOST_BINARY to the release helper',
}, async () => {
  const binary = fs.readFileSync(binaryPath);
  const component = Buffer.from([0, 97, 115, 109, 10, 0, 1, 0]);
  const diagnostics = new RestrictedHostDiagnostics();
  const supervisor = supervisorFor(binary, diagnostics);
  const identity = {
    publisher_id: 'acme-labs', plugin_id: 'widgets', contribution_id: 'compute',
    artifact_digest: '1'.repeat(64),
    component_digest: crypto.createHash('sha256').update(component).digest('hex'),
    generation_id: 'gen-real-host', commit_epoch: 1, lifecycle_epoch: 1,
    abi_digest: RESTRICTED_ABI_DIGEST, protocol_digest: RESTRICTED_PROTOCOL_DIGEST,
  };
  const startedAt = Date.now();
  const result = await supervisor.start(identity, component);
  assert.deepEqual(result, { ok: false, reason: 'restricted_host_startup_rejected' });
  assert.ok(Date.now() - startedAt < 35000, 'invalid component must settle within load deadline');
  assert.equal(diagnostics.snapshot().events.some((event) => (
    event.event === 'startup_rejected'
      && event.reason_code === 'restricted_host_startup_rejected'
  )), true);
  await supervisor.dispose();
});

test('real restricted host executes the fixed Stage 6 owner-smoke component', {
  skip: binaryPath ? false : 'set JENNY_RESTRICTED_HOST_BINARY to the release helper',
}, async () => {
  const binary = fs.readFileSync(binaryPath);
  const packager = await import(pathToFileURL(packagerPath).href);
  const component = packager.createOwnerSmokeFixture().componentBytes;
  const supervisor = supervisorFor(binary);
  const identity = {
    publisher_id: packager.PUBLISHER_ID,
    plugin_id: packager.PLUGIN_ID,
    contribution_id: 'compute',
    artifact_digest: '2'.repeat(64),
    component_digest: crypto.createHash('sha256').update(component).digest('hex'),
    generation_id: 'gen-owner-smoke',
    commit_epoch: 1,
    lifecycle_epoch: 1,
    abi_digest: RESTRICTED_ABI_DIGEST,
    protocol_digest: RESTRICTED_PROTOCOL_DIGEST,
  };
  const started = await supervisor.start(identity, component);
  assert.equal(started.ok, true, JSON.stringify(started));
  try {
    const inputJson = '{"stage":6,"sensitive_data":"redacted"}';
    const result = await started.host.invoke(inputJson, 1000, {
      invocation_id: 'invoke-owner-smoke',
      operation_id: 'operation-owner-smoke',
      cancellation_id: 'cancel-owner-smoke',
      token_id: 'token-owner-smoke',
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.result_json, inputJson);
  } finally {
    await started.host.shutdown();
    await supervisor.dispose();
  }
});
