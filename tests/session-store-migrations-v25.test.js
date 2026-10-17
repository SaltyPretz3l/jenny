'use strict';

// Session schema 25 (row 59 checkpoint 2): the six chat-workspace coordination fields arrive with
// defaults and every existing field survives. Split from session-store-migrations.test.js, which
// keeps the version pin.

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrateStorePayload, repairSessionForV25 } = require('../services/backend/session-store-migrations');

const COORDINATION_DEFAULTS = {
  spawned_from: null,
  coordination_revision: 0,
  coordination_receipts: [],
  chat_proposals: { schema_version: 1, records: [], launch_grants: [] },
  session_mail: {
    schema_version: 1,
    next_receive_sequence: 1,
    inbox: [],
    discarded: [],
    outbox: [],
    authorizations: [],
    report_reservations: [],
    admission_snapshots: [],
    reporting_enabled: false,
  },
  workspace_view: { schema_version: 1, rail_visible: null, disclosures: {}, children_expanded: null },
};

test('repairSessionForV25 adds the six coordination defaults and keeps every existing field', () => {
  const source = {
    id: 's1',
    title: 'Keep me',
    messages: [{ id: 'm1', content: 'hello' }],
    suggested_changes: { schema_version: 1, seq: 3, entries: [], file_heads: {} },
    unknown_future_key: { nested: true },
  };
  const before = JSON.stringify(source);
  const repaired = repairSessionForV25(source);
  assert.equal(JSON.stringify(source), before, 'the input session is not mutated');
  for (const [key, value] of Object.entries(COORDINATION_DEFAULTS)) {
    assert.deepEqual(repaired[key], value, key);
  }
  const { ...rest } = repaired;
  for (const key of Object.keys(COORDINATION_DEFAULTS)) delete rest[key];
  assert.deepEqual(rest, source);
});

test('repairSessionForV25 is idempotent and repairs malformed pre-existing values', () => {
  const once = repairSessionForV25({ id: 's1', workspace_view: 'nope', coordination_revision: -3 });
  assert.deepEqual(once.workspace_view, COORDINATION_DEFAULTS.workspace_view);
  assert.equal(once.coordination_revision, 0);
  assert.deepEqual(repairSessionForV25(once), once);
  assert.deepEqual(repairSessionForV25(null), COORDINATION_DEFAULTS);
});

test('migrateStorePayload from v24 adds coordination defaults to every session and replays cleanly', () => {
  const payload = {
    schema_version: 24,
    sessions: {
      s1: { id: 's1', title: 'One', linked_session_ids: ['x'] },
      s2: { id: 's2', title: 'Two', workspace_view: { schema_version: 1, rail_visible: false } },
    },
  };
  const migrated = migrateStorePayload(payload);
  assert.equal(migrated.schema_version, 25);
  assert.deepEqual(migrated.sessions.s1.workspace_view, COORDINATION_DEFAULTS.workspace_view);
  assert.equal(migrated.sessions.s1.title, 'One');
  assert.deepEqual(migrated.sessions.s1.linked_session_ids, ['x']);
  assert.equal(migrated.sessions.s2.workspace_view.rail_visible, false);
  const replay = migrateStorePayload(migrated);
  assert.deepEqual(replay, migrated);
});
