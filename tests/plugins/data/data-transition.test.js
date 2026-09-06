'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { parseMigrations, findMigrationPath, applyMigrationPath } = require('../../../services/plugins/data/data-transition');
test('signed migration descriptors accept only exact declarative steps', () => {
  const parsed = parseMigrations(Buffer.from(JSON.stringify({ migrations_schema_version: 1, migrations: [{ from_version: 1, to_version: 2, executorTier: 'declarative', steps: [{ kind: 'set_default', field: 'added', value: true }] }] })));
  assert.equal(parsed.ok, true); const path = findMigrationPath(parsed.migrations, 1, 2); assert.equal(path.ok, true);
  assert.deepEqual(applyMigrationPath({}, path.steps).value, { added: true });
  assert.equal(parseMigrations(Buffer.from(JSON.stringify({ migrations_schema_version: 1, migrations: [{ from_version: 1, to_version: 2, executorTier: 'full_host', steps: [] }] }))).ok, false);
});
