'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  normalizeValues,
  readSettingsState,
  writeSettingsState,
} = require('../../../services/plugins/store/settings-state-store');

const fields = [
  { type: 'boolean', key: 'enabled', label: 'Enabled', default: true },
  { type: 'integer', key: 'limit', label: 'Limit', default: 2, minimum: 1, maximum: 5 },
  { type: 'string', key: 'label', label: 'Label', default: 'Jenny', max_length: 12 },
  { type: 'enum', key: 'mode', label: 'Mode', default: 'brief', values: ['brief', 'full'] },
];

test('settings values are typed, defaulted, bounded, and reject unknown keys', () => {
  assert.deepEqual(normalizeValues(fields, { limit: 4, label: 'Ada' }), {
    ok: true,
    values: [
      { type: 'boolean', key: 'enabled', value: true },
      { type: 'integer', key: 'limit', value: 4 },
      { type: 'string', key: 'label', value: 'Ada' },
      { type: 'string', key: 'mode', value: 'brief' },
    ],
  });
  assert.equal(normalizeValues(fields, { limit: 9 }).reason, 'settings_integer_out_of_range');
  assert.equal(normalizeValues(fields, { mode: 'unknown' }).reason, 'settings_enum_invalid');
  assert.equal(normalizeValues(fields, { secret: 'x' }).reason, 'settings_key_unknown');
});

test('settings state is atomically content-addressed and authority checked on read', async () => {
  const facade = createMemoryFsFacade();
  const written = await writeSettingsState(facade, 'plugins', {
    publisherId: 'jenny-official', pluginId: 'starter', contributionId: 'settings-main',
    schemaDigest: 'a'.repeat(64), revision: 1, fields,
    values: { enabled: false, limit: 3, label: 'Ada', mode: 'full' },
    now: '2026-08-04T12:00:00Z',
  });
  assert.equal(written.ok, true);
  assert.equal(facade.callCounts.renameFile, 1);

  const read = await readSettingsState(facade, 'plugins', {
    publisherId: 'jenny-official', pluginId: 'starter', contributionId: 'settings-main',
    digest: written.digest,
  });
  assert.equal(read.ok, true);
  assert.equal(read.state.revision, 1);

  const wrongContribution = await readSettingsState(facade, 'plugins', {
    publisherId: 'jenny-official', pluginId: 'starter', contributionId: 'settings-other',
    digest: written.digest,
  });
  assert.deepEqual(wrongContribution, { ok: false, reason: 'settings_state_authority_mismatch' });

  const repeated = await writeSettingsState(facade, 'plugins', {
    publisherId: 'jenny-official', pluginId: 'starter', contributionId: 'settings-main',
    schemaDigest: 'a'.repeat(64), revision: 1, fields,
    values: { enabled: false, limit: 3, label: 'Ada', mode: 'full' },
    now: '2026-08-04T12:00:00Z',
  });
  assert.equal(repeated.digest, written.digest);
  assert.equal(facade.callCounts.renameFile, 1, 'immutable existing records are not rewritten');
});
