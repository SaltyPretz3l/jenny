'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  createArchive,
  readManifest,
  verifyArchive,
} = require('../../services/data-lifecycle/archive-service');
const { createGeneralProject } = require('../../services/projects/project-schema');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');

const LEGACY_RESTORE_ROOTS = new Set([
  'sessions', 'preferences', 'personality', 'calendar', 'memory', 'workspace',
]);

test.afterEach(async () => cleanupTrackedResources());

function legacyValidateBeforeApply(entries, apply) {
  for (const entry of entries) {
    if (!LEGACY_RESTORE_ROOTS.has(entry.logical_path.split('/')[0])) {
      const error = new Error('Archive contains data unsupported by the legacy reader.');
      error.reason = 'restore_entry_disallowed';
      throw error;
    }
  }
  for (const entry of entries) apply(entry);
}

test('archive v1 plain fixture remains readable and immutable', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'jenny-archive-v1-plain');
  const result = await verifyArchive(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.format_version, 1);
  assert.equal(result.manifest.entries[0].logical_path, 'preferences/fixture.txt');
  assert.equal(result.manifest.entries[0].sha256, 'e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f');
});

test('runtime payload categories keep envelope v1 and old readers reject before partial apply', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-archive-compat-'));
  trackDirectory(root);
  const now = '2026-09-09T12:00:00.000Z';
  const projects = {
    schema_version: 1,
    projects: { project_general: createGeneralProject(now) },
  };
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Runtime-v1.jenny-archive',
    encrypted: false,
    entries: [{
      logicalPath: 'runtime/projects.json',
      category: 'project_state',
      data: JSON.stringify({
        payload_schema_version: 1,
        payload_kind: 'project_state',
        payload: projects,
      }),
    }, {
      logicalPath: 'runtime/runtime-coordination.json',
      category: 'runtime_coordination',
      data: JSON.stringify({ payload_schema_version: 1, payload_kind: 'runtime_coordination',
        payload: { schema_version: 1,
          checkpoints: { schema_version: 1, records: [] },
          root_run_budgets: { schema_version: 1, records: [] },
          canonical_sessions: { schema_version: 1, sessions: [] } } }),
    }],
  });

  const envelope = JSON.parse(fs.readFileSync(path.join(result.archivePath, 'archive.json'), 'utf8'));
  const { manifest } = await readManifest(result.archivePath);
  assert.equal(envelope.format_version, 1);
  assert.equal(manifest.format_version, 1);
  assert.deepEqual(manifest.entries.map(entry => entry.category).sort(),
    ['project_state', 'runtime_coordination']);
  const applied = [];
  assert.throws(
    () => legacyValidateBeforeApply(manifest.entries, (entry) => applied.push(entry.logical_path)),
    { reason: 'restore_entry_disallowed' }
  );
  assert.deepEqual(applied, []);
});
