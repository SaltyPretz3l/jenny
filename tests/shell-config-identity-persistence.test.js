const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { ShellConfigService } = require('../services/shell-config-service');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

test('assistant identity persistence failure does not project an uncommitted name', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-identity-fail-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  const before = service.getAssistantIdentity();
  service._persistState = () => false;

  assert.throws(() => service.updateAssistantIdentity({ agentName: 'Uncommitted' }), {
    code: 'assistant_identity_write_failed',
  });
  assert.deepEqual(service.getAssistantIdentity(), before);
});

test('a v46 identity loses profile and custom text on load but keeps the name', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-identity-v47-'));
  trackDirectory(userDataPath);
  fs.writeFileSync(
    path.join(userDataPath, 'shell-config.json'),
    JSON.stringify({
      version: 46,
      assistantIdentity: {
        agentName: 'Juniper',
        profile: 'mentor',
        customText: 'Patient and direct.',
        updatedAt: '2026-05-07T12:00:00.000Z',
      },
    }),
    'utf8'
  );

  const service = new ShellConfigService({ userDataPath, env: {} });
  assert.deepEqual(service.getAssistantIdentity(), {
    agentName: 'Juniper',
    updatedAt: '2026-05-07T12:00:00.000Z',
  });

  // The bump must also stop the retired keys from being re-serialized: a write
  // that survives a reload is the only proof the migration actually landed.
  service.updateAssistantIdentity({ agentName: 'Juniper II' });
  const persisted = JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));
  // The chain always stamps the CURRENT version; this test's subject is the
  // identity keys, so pin "past the v47 identity bump" (an exact pin went
  // stale at the v50 bump).
  assert.ok(persisted.version >= 47, `expected version >= 47, got ${persisted.version}`);
  assert.deepEqual(Object.keys(persisted.assistantIdentity).sort(), ['agentName', 'updatedAt']);
  assert.equal(
    new ShellConfigService({ userDataPath, env: {} }).getAssistantIdentity().agentName,
    'Juniper II'
  );
});

test('a retired profile patch is tolerated and dropped rather than rejected', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-identity-legacy-patch-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });

  const updated = service.updateAssistantIdentity({
    agentName: 'Echo',
    profile: 'creative',
    customText: 'flowery',
  });
  assert.equal(updated.agentName, 'Echo');
  assert.equal(Object.prototype.hasOwnProperty.call(updated, 'profile'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updated, 'customText'), false);
});
