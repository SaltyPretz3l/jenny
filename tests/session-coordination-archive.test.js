'use strict';

// Trusted-archive coordination entry: capture, validation, trusted import and the restore phase
// (row 59 cp5b-3, slice H1). Ordinary session export/import stays inert.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../services/backend/chat-proposal-records');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { exportSession, importSession } = require('../services/backend/session-export-import');
const { normalizeCoordinationFields } = require('../services/backend/session-coordination-records');
const { createArchive } = require('../services/data-lifecycle/archive-service');
const { collectDataInventory } = require('../services/data-lifecycle/data-inventory');
const { promotePendingRestore, stageRestore } = require('../services/data-lifecycle/restore-service');
const A = require('../services/data-lifecycle/session-coordination-archive');
const F = require('./helpers/session-mail-fixtures');
const P = require('./helpers/chat-proposal-records-fixture');
const {
  acceptedGit, launchGrant, pendingOp, sessionProposal,
} = require('./helpers/coordination-archive-fixtures');

const PARENT = { session_id: 'sess_parent', session_incarnation: 'inc_parent', project_id: null };
const CHILD = { session_id: 'sess_child', session_incarnation: 'inc_child', project_id: null };

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-coordination-archive-'));
}

function openStore(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  return new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
}

function seedSession(store, id, { incarnation = '', coordination = null, text = 'Keep me' } = {}) {
  assert.ok(store.createSessionWithId(id, { title: `Chat ${id}` }));
  store.appendMessage(id, { id: `${id}_m1`, role: 'user', content: text });
  // New chats mint an incarnation; a chat that never had one (an imported one) is seeded with ''.
  assert.ok(store._updateSessionRecord(id, { session_incarnation: incarnation, ...coordination }, { bumpUpdatedAt: false }));
}

// parent <-> child with an in-flight send, accepted work, live grants and an unreleased reservation;
// a plain chat with no coordination; an orphan whose counterpart is not in the archive; a frozen chat.
function seedProfile(store) {
  const reserved = F.makeSnapshot(1, { state: 'reserved' });
  const published = F.makeSnapshot(2, { state: 'published' });
  seedSession(store, 'sess_parent', {
    incarnation: 'inc_parent',
    coordination: {
      coordination_revision: 7,
      coordination_receipts: [{ note: 'kept verbatim' }],
      workspace_view: { schema_version: 1, rail_visible: true, disclosures: { outputs: true }, children_expanded: false },
      chat_proposals: {
        schema_version: 1,
        records: [
          sessionProposal(1, { sessionId: 'sess_parent', sessionIncarnation: 'inc_parent' }),
          P.makeCommand(2),
          acceptedGit(3, 'queued'),
          acceptedGit(4, 'succeeded'),
        ],
        launch_grants: [launchGrant(1)],
      },
      session_mail: {
        schema_version: 1,
        next_receive_sequence: 3,
        inbox: [F.makeInbox(1, { context: { state: 'reserved', turn_id: 'turn_1', snapshot_id: reserved.snapshot_id } },
          { source: CHILD, destination: PARENT })],
        discarded: [],
        outbox: [pendingOp(1, { source: PARENT, destination: CHILD }), pendingOp(2, { source: PARENT, destination: { session_id: 'sess_gone', session_incarnation: 'inc_gone', project_id: null } })],
        authorizations: [F.makeAuthorization(1, {
          source_session_id: 'sess_parent', source_session_incarnation: 'inc_parent',
          destination_session_id: 'sess_child', destination_session_incarnation: 'inc_child',
        })],
        report_reservations: [F.makeReservation(1)],
        admission_snapshots: [reserved, published],
        reporting_enabled: true,
      },
    },
  });
  seedSession(store, 'sess_child', {
    incarnation: 'inc_child',
    coordination: { spawned_from: F.makeSpawnedFrom({ parent_session_id: 'sess_parent', parent_session_incarnation: 'inc_parent' }) },
  });
  seedSession(store, 'sess_plain');
  seedSession(store, 'sess_frozen', {
    incarnation: 'inc_frozen',
    coordination: { session_mail: { schema_version: 2, future: { opaque: [1, 2, 3] } } },
  });
  store.flush();
}

function archiveEntries(userDataPath, store) {
  const { entries } = collectDataInventory({ userDataPath, sessionStore: store });
  return entries;
}

async function buildArchive(root, entries) {
  const result = await createArchive({
    destinationRoot: path.join(root, 'Jenny Archives'),
    encrypted: false,
    entries,
    stagingRoot: path.join(root, 'staging'),
    createdAt: new Date('2026-10-16T00:00:00.000Z'),
  });
  return result.archivePath;
}

async function restoreInto(root, archivePath) {
  const userDataPath = path.join(root, 'restored-profile');
  fs.mkdirSync(userDataPath, { recursive: true });
  const staged = await stageRestore({ archivePath, userDataPath });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  const promoted = await promotePendingRestore({ userDataPath });
  return { userDataPath, promoted };
}

// A source profile archived the way the data lifecycle service does, then restored into a fresh one.
async function archiveAndRestore(root, { mutateEntries = (entries) => entries } = {}) {
  const sourcePath = path.join(root, 'source-profile');
  const store = openStore(sourcePath);
  seedProfile(store);
  const entries = mutateEntries(archiveEntries(sourcePath, store));
  store.dispose();
  const archivePath = await buildArchive(root, entries);
  return restoreInto(root, archivePath);
}

function replaceCoordination(entries, bytes) {
  return entries.map((entry) => (entry.logicalPath === A.COORDINATION_LOGICAL_PATH ? { ...entry, data: Buffer.from(bytes) } : entry));
}

function readCoordinationEntry(entries) {
  return JSON.parse(entries.find((entry) => entry.logicalPath === A.COORDINATION_LOGICAL_PATH).data.toString('utf8'));
}

describe('capture', () => {
  it('writes one entry with incarnations and coordination, after the session entries', () => {
    const root = tempRoot();
    try {
      const store = openStore(path.join(root, 'profile'));
      seedProfile(store);
      const entries = archiveEntries(path.join(root, 'profile'), store);
      const paths = entries.map((entry) => entry.logicalPath);
      const index = paths.indexOf(A.COORDINATION_LOGICAL_PATH);
      assert.ok(index > 0, 'the coordination entry exists');
      assert.equal(paths.slice(0, index).every((value) => value.startsWith('sessions/')), true);
      assert.equal(entries[index].category, A.COORDINATION_CATEGORY);
      const payload = readCoordinationEntry(entries);
      assert.deepEqual(Object.keys(payload).sort(), ['captured_at', 'schema_version', 'sessions']);
      assert.equal(payload.schema_version, 1);
      assert.deepEqual(Object.keys(payload.sessions).sort(), ['sess_child', 'sess_frozen', 'sess_parent'], 'a chat with nothing to carry has no record');
      const parent = payload.sessions.sess_parent;
      assert.deepEqual(Object.keys(parent).sort(), [
        'chat_proposals', 'coordination_receipts', 'coordination_revision', 'session_incarnation', 'session_mail', 'spawned_from', 'workspace_view',
      ]);
      assert.equal(parent.session_incarnation, 'inc_parent');
      assert.equal(parent.coordination_revision, 7);
      assert.equal(parent.session_mail.outbox.length, 2);
      assert.deepEqual(payload.sessions.sess_frozen.session_mail, { schema_version: 2, future: { opaque: [1, 2, 3] } }, 'frozen containers are captured verbatim');
      store.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes no entry when no session carries an incarnation or coordination', () => {
    const root = tempRoot();
    try {
      const store = openStore(path.join(root, 'profile'));
      seedSession(store, 'sess_plain');
      assert.equal(A.captureSessionCoordination(store), null);
      assert.equal(archiveEntries(path.join(root, 'profile'), store).some((entry) => entry.logicalPath === A.COORDINATION_LOGICAL_PATH), false);
      assert.equal(A.captureSessionCoordination(null), null);
      assert.equal(A.captureSessionCoordination({ listSessions: () => [{ id: 'sess_x' }], getSession: () => ({ id: 'sess_x', messages: [] }) }), null);
      store.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps ordinary session export and import inert', () => {
    const root = tempRoot();
    try {
      const store = openStore(path.join(root, 'profile'));
      seedProfile(store);
      const exported = exportSession(store, 'sess_parent', null, {});
      for (const key of ['session_mail', 'chat_proposals', 'session_incarnation', 'spawned_from', 'coordination_receipts', 'workspace_view']) {
        assert.equal(exported.includes(`"${key}"`), false, `${key} is not exported`);
      }
      // Even a trusted-looking option set cannot carry coordination or an incarnation through a normal import.
      const summary = importSession(store, exported, null, { restoredIncarnation: 'inc_parent' });
      const imported = store.getSession(summary.id);
      assert.equal(imported.session_incarnation, '');
      assert.deepEqual(
        Object.fromEntries(Object.keys(normalizeCoordinationFields({})).map((key) => [key, imported[key]])),
        normalizeCoordinationFields({}),
      );
      store.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('payload validation', () => {
  const valid = (sessions = {}) => Buffer.from(JSON.stringify({ schema_version: 1, captured_at: '2026-10-16T00:00:00.000Z', sessions }));

  it('accepts the closed wrapper and rejects everything else', () => {
    assert.equal(A.parseCoordinationArchive(valid({ sess_a: {} })).has('sess_a'), true);
    const corrupt = [
      Buffer.from('not json'),
      Buffer.from('[]'),
      Buffer.from(JSON.stringify({ schema_version: 1, sessions: {} })),
      Buffer.from(JSON.stringify({ schema_version: 1, captured_at: 'yesterday', sessions: {} })),
      Buffer.from(JSON.stringify({ schema_version: 1, captured_at: '2026-10-16T00:00:00.000Z', sessions: [] })),
      Buffer.from(JSON.stringify({ schema_version: 1, captured_at: '2026-10-16T00:00:00.000Z', sessions: {}, extra: 1 })),
      valid({ '../escape': {} }),
      valid({ __proto__x: {} }),
      'not a buffer',
    ];
    for (const bytes of corrupt) {
      assert.throws(() => A.parseCoordinationArchive(bytes), { code: 'CMP-DATA-0007', reason: 'coordination_payload_invalid' });
    }
    assert.throws(() => A.parseCoordinationArchive(Buffer.from(JSON.stringify({
      schema_version: 2, captured_at: '2026-10-16T00:00:00.000Z', sessions: {},
    }))), { code: 'CMP-DATA-0008', reason: 'unsupported_coordination_version' });
  });

  it('applies nothing without an entry, and ignores records of chats that were not restored', () => {
    const calls = [];
    const store = { getSessionIds: () => ['sess_here'], restoreSessionCoordination: (id) => { calls.push(id); return true; } };
    assert.deepEqual(A.applyCoordination(store, { sessions: new Map() }), { applied: 0, quarantined: [], ignored: [], unavailable_links: [] });
    const report = A.applyCoordination(store, { sessions: new Map([['sess_gone', {}], ['sess_here', { session_incarnation: '' }]]) });
    assert.deepEqual(calls, ['sess_here']);
    assert.deepEqual(report.ignored, [{ session_id: 'sess_gone', reason: 'session_not_restored' }]);
    assert.equal(report.applied, 1);
  });

  it('a failed store write aborts the restore', () => {
    const store = { getSessionIds: () => ['sess_here'], restoreSessionCoordination: () => false };
    assert.throws(() => A.applyCoordination(store, { sessions: new Map([['sess_here', { session_incarnation: '' }]]) }),
      { code: 'CMP-DATA-0007', reason: 'restore_state_invalid' });
  });

  it('restoredIncarnationFor only returns a usable incarnation', () => {
    const loaded = { sessions: new Map([['sess_a', { session_incarnation: 'inc_a' }], ['sess_b', { session_incarnation: 5 }], ['sess_c', {}]]) };
    assert.equal(A.restoredIncarnationFor(loaded, 'sess_a'), 'inc_a');
    assert.equal(A.restoredIncarnationFor(loaded, 'sess_b'), '');
    assert.equal(A.restoredIncarnationFor(loaded, 'sess_c'), '');
    assert.equal(A.restoredIncarnationFor(loaded, 'sess_missing'), '');
    assert.equal(A.restoredIncarnationFor(null, 'sess_a'), '');
  });
});

describe('store write and trusted import', () => {
  it('restoreSessionCoordination writes the six fields once, refuses a chat that already has coordination, and is not a generic patch', () => {
    const root = tempRoot();
    try {
      const store = openStore(path.join(root, 'profile'));
      seedSession(store, 'sess_a');
      const record = { ...normalizeCoordinationFields({}), coordination_revision: 4, workspace_view: { schema_version: 1, rail_visible: false, disclosures: {}, children_expanded: null } };
      assert.equal(store.restoreSessionCoordination('sess_a', record), true);
      const written = store.getSession('sess_a');
      assert.equal(written.coordination_revision, 4);
      assert.equal(written.workspace_view.rail_visible, false);
      assert.equal(written.messages[0].content, 'Keep me', 'the transcript is untouched');
      assert.equal(store.restoreSessionCoordination('sess_a', record), false, 'a second write is refused');
      assert.equal(store.restoreSessionCoordination('sess_missing', record), false);
      assert.equal(store.restoreSessionCoordination('sess_a', null), false);
      assert.equal(store.restoreSessionCoordination('sess_a', [record]), false);
      // The generic patch writer still strips coordination fields.
      store.updateSession('sess_a', { coordination_revision: 99 });
      assert.equal(store.getSession('sess_a').coordination_revision, 4);
      store.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('only a trusted archive import keeps the incarnation', () => {
    const root = tempRoot();
    try {
      const source = openStore(path.join(root, 'source'));
      seedSession(source, 'sess_a', { incarnation: 'inc_a' });
      const payload = exportSession(source, 'sess_a', null, { includeTurnEvents: true });
      const target = openStore(path.join(root, 'target'));
      importSession(target, payload, null, { trustedArchive: true, restoredSessionId: 'sess_a', restoredIncarnation: 'inc_a' });
      assert.equal(target.getSession('sess_a').session_incarnation, 'inc_a');
      importSession(target, payload, null, { trustedArchive: true, restoredSessionId: 'sess_b' });
      assert.equal(target.getSession('sess_b').session_incarnation, '');
      importSession(target, payload, null, { trustedArchive: true, restoredSessionId: 'sess_c', restoredIncarnation: 'x'.repeat(513) });
      assert.equal(target.getSession('sess_c').session_incarnation, '');
      const ordinary = importSession(target, payload, null, { restoredSessionId: 'sess_d', restoredIncarnation: 'inc_d' });
      assert.notEqual(ordinary.id, 'sess_d', 'identity is only kept by the trusted archive');
      assert.equal(target.getSession(ordinary.id).session_incarnation, '');
      source.dispose();
      target.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('archive -> fresh-profile restore', () => {
  it('restores transcripts with incarnations and transformed coordination', async () => {
    const root = tempRoot();
    try {
      const { userDataPath, promoted } = await archiveAndRestore(root);
      assert.equal(promoted.status, 'promoted', JSON.stringify(promoted));
      assert.equal(promoted.coordination.applied, 3);
      assert.deepEqual(promoted.coordination.quarantined, []);
      assert.deepEqual(promoted.coordination.ignored, []);
      assert.deepEqual(promoted.coordination.unavailable_links, [
        { session_id: 'sess_parent', missing_session_ids: ['sess_gone'] },
      ]);

      const store = openStore(userDataPath);
      const parent = store.getSession('sess_parent');
      assert.equal(parent.messages[0].content, 'Keep me');
      assert.equal(parent.session_incarnation, 'inc_parent', 'the trusted path keeps the incarnation');
      assert.equal(parent.coordination_revision, 8);
      assert.deepEqual(parent.coordination_receipts, [{ note: 'kept verbatim' }]);
      assert.equal(parent.workspace_view.rail_visible, true);

      const mail = parent.session_mail;
      assert.deepEqual(mail.outbox.map((op) => [op.state, op.restore_requires_confirmation, op.last_error.reason]), [
        ['failed', true, 'restored_confirmation_required'],
        ['failed', true, 'restored_confirmation_required'],
      ]);
      assert.equal(mail.outbox[1].envelope.destination_session_id, 'sess_gone', 'a missing counterpart stays an unavailable link');
      assert.equal(mail.authorizations.length, 1, 'the per-operation authorization is untouched');
      assert.equal(mail.authorizations[0].revoked_at, null);
      assert.deepEqual(mail.report_reservations, []);
      assert.equal(mail.reporting_enabled, false);
      assert.deepEqual(mail.admission_snapshots.map((snapshot) => snapshot.state), ['published']);
      assert.deepEqual(mail.inbox[0].context, { state: 'queued' });

      const records = parent.chat_proposals.records;
      assert.deepEqual(records.map((record) => [record.kind, record.decision_state, record.action_state, record.restore_requires_confirmation]), [
        ['session', 'pending', 'none', true],
        ['command', 'pending', 'none', true],
        ['git', 'accepted', 'needs_attention', true],
        ['git', 'accepted', 'succeeded', false],
      ]);
      assert.equal(records[2].last_error.reason, 'restored_confirmation_required');
      for (const record of records) assert.deepEqual(R.normalizeProposalRecord(record), record);
      assert.notEqual(parent.chat_proposals.launch_grants[0].revoked_at, null);
      assert.equal(parent.chat_proposals.launch_grants[0].remaining, 0);

      const child = store.getSession('sess_child');
      assert.equal(child.session_incarnation, 'inc_child');
      assert.equal(child.spawned_from.parent_session_id, 'sess_parent', 'matched relationships are preserved');

      const plain = store.getSession('sess_plain');
      assert.equal(plain.session_incarnation, '');
      assert.equal(plain.messages[0].content, 'Keep me');

      const frozen = store.getSession('sess_frozen');
      assert.deepEqual(frozen.session_mail, { schema_version: 2, future: { opaque: [1, 2, 3] } }, 'a frozen container is restored frozen');
      assert.equal(frozen.session_incarnation, 'inc_frozen');
      store.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines one malformed record without touching its transcript or its neighbours', async () => {
    const root = tempRoot();
    try {
      const { userDataPath, promoted } = await archiveAndRestore(root, {
        mutateEntries: (entries) => {
          const payload = readCoordinationEntry(entries);
          payload.sessions.sess_parent.session_mail = 'oops';
          payload.sessions.sess_orphan_record = { session_incarnation: 'inc_x' };
          return replaceCoordination(entries, JSON.stringify(payload));
        },
      });
      assert.equal(promoted.status, 'promoted', JSON.stringify(promoted));
      assert.deepEqual(promoted.coordination.quarantined, [{ session_id: 'sess_parent', reason: 'session_mail_invalid' }]);
      assert.deepEqual(promoted.coordination.ignored, [{ session_id: 'sess_orphan_record', reason: 'session_not_restored' }]);
      const store = openStore(userDataPath);
      const parent = store.getSession('sess_parent');
      assert.equal(parent.messages[0].content, 'Keep me');
      assert.deepEqual(parent.session_mail, normalizeCoordinationFields({}).session_mail);
      assert.deepEqual(parent.chat_proposals, normalizeCoordinationFields({}).chat_proposals);
      assert.equal(store.getSession('sess_child').spawned_from.parent_session_id, 'sess_parent');
      store.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores an archive written before the coordination entry existed', async () => {
    const root = tempRoot();
    try {
      const { userDataPath, promoted } = await archiveAndRestore(root, {
        mutateEntries: (entries) => entries.filter((entry) => entry.logicalPath !== A.COORDINATION_LOGICAL_PATH),
      });
      assert.equal(promoted.status, 'promoted', JSON.stringify(promoted));
      assert.equal(promoted.coordination.applied, 0);
      const store = openStore(userDataPath);
      assert.equal(store.getSession('sess_parent').messages[0].content, 'Keep me');
      assert.equal(store.getSession('sess_parent').session_incarnation, '');
      assert.deepEqual(store.getSession('sess_parent').session_mail, normalizeCoordinationFields({}).session_mail);
      store.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a corrupt or future wrapper and leaves the profile untouched', async () => {
    for (const [bytes, expected] of [
      ['{"schema_version":1}', { code: 'CMP-DATA-0007', reason: 'coordination_payload_invalid' }],
      [JSON.stringify({ schema_version: 2, captured_at: '2026-10-16T00:00:00.000Z', sessions: {} }), { code: 'CMP-DATA-0008', reason: 'unsupported_coordination_version' }],
    ]) {
      const root = tempRoot();
      try {
        const sourcePath = path.join(root, 'source-profile');
        const store = openStore(sourcePath);
        seedProfile(store);
        const entries = replaceCoordination(archiveEntries(sourcePath, store), bytes);
        store.dispose();
        const archivePath = await buildArchive(root, entries);
        const userDataPath = path.join(root, 'restored-profile');
        fs.mkdirSync(userDataPath, { recursive: true });
        await stageRestore({ archivePath, userDataPath });
        await assert.rejects(promotePendingRestore({ userDataPath }), expected);
        const reopened = openStore(userDataPath);
        assert.deepEqual(reopened.listSessions(), [], 'a refused restore promotes no chats');
        reopened.dispose();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
