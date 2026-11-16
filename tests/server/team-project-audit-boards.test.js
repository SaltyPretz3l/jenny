'use strict';

// The project audit's board kinds and its schema 3 (row 151 slice T5, plan PROJECT_BOARD_2026-11-13 section 8.6).
// The other kinds, the bounds and the broken-file cases are in team-project-audit.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const { PROJECT_AUDIT_FILE, PROJECT_AUDIT_KIND_RULES, ProjectAudit } = require('../../server/team/project-audit');

const P = 'project_p1';
const SESSION = 'sess_1800000000000_aaaaaaaaaaaa';
const ACTOR = 'member_actorXXXXXXXXXXXXXX';
const PROMPTER = 'member_prompterXXXXXXXXXXX';
const BOARD = 'board_11111111-2222-4333-8444-555555555555';

const base = (kind, fields) => ({ kind, project_id: P, session_id: null, board_id: BOARD, actor_member_id: ACTOR,
  prompter_member_id: null, tool_name: null, decision: null, detail: null, ...fields });
const proposal = (kind) => base(kind, { session_id: SESSION, prompter_member_id: PROMPTER, detail: { change: 0, count: 3 } });
const VALID = Object.freeze({
  board_proposal_accepted: proposal('board_proposal_accepted'),
  board_proposal_rejected: proposal('board_proposal_rejected'),
  board_deleted: base('board_deleted'),
  board_restored: base('board_restored'),
  board_batch_reverted: base('board_batch_reverted', { detail: { rev: 7 } }),
  board_bulk_removed: base('board_bulk_removed', { detail: { items: 20 } }),
});
const valid = (kind, overrides = {}) => ({ ...VALID[kind], detail: VALID[kind].detail && { ...VALID[kind].detail }, ...overrides });

const fileOf = (fx) => path.join(fx.dir, PROJECT_AUDIT_FILE);
const openAudit = (fx) => new ProjectAudit({ filePath: fileOf(fx), clock: fx.clock, logger: fx.logger });
const disk = (fx) => JSON.parse(fs.readFileSync(fileOf(fx), 'utf8'));
// An entry as schema 2 stored it: no `board_id` key.
const old = (seq) => ({ seq, at: 5, kind: 'approval_decided', project_id: P, session_id: SESSION, actor_member_id: ACTOR,
  prompter_member_id: PROMPTER, tool_name: 'write_file', decision: 'approved', detail: null });

test('each board kind stores its entry with the board, and the board is the only new key', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  Object.keys(VALID).forEach((kind, index) => assert.deepEqual(audit.append(valid(kind)), { ok: true, seq: index + 1 }, kind));
  assert.equal(disk(fx).schema_version, 3);
  const saved = openAudit(fx).read({ projectId: P }).entries;
  assert.deepEqual(saved.map((entry) => entry.kind), Object.keys(VALID));
  for (const entry of saved) {
    const { seq: _seq, at: _at, ...rest } = entry;
    assert.deepEqual(rest, valid(entry.kind));
    assert.equal(PROJECT_AUDIT_KIND_RULES[entry.kind].tool_name, false, 'a board kind names no tool');
  }
});

test('a board kind refuses an entry that breaks its rule, and no other kind may name a board', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  const everyKind = [{ board_id: null }, { board_id: 'board_1' }, { board_id: `${BOARD}x` }, { board_id: '../x' },
    { actor_member_id: null }, { tool_name: 'write_file' }, { decision: 'approved' }, { project_id: null }];
  const broken = {
    board_proposal_accepted: [{ session_id: null }, { prompter_member_id: null }, { detail: null }, { detail: { change: 1 } },
      { detail: { change: 1, count: 1, text: 'note' } }, { detail: { change: -1, count: 1 } }, { detail: { change: 'n3', count: 1 } }],
    board_proposal_rejected: [{ session_id: null }, { prompter_member_id: null }, { detail: null }, { detail: { count: 1 } }],
    board_deleted: [{ session_id: SESSION }, { prompter_member_id: PROMPTER }, { detail: { rev: 1 } }],
    board_restored: [{ session_id: SESSION }, { prompter_member_id: PROMPTER }, { detail: { items: 1 } }],
    board_batch_reverted: [{ detail: null }, { detail: { rev: 1.5 } }, { detail: { rev: 1, items: 2 } }, { session_id: SESSION }],
    board_bulk_removed: [{ detail: null }, { detail: { items: 'all' } }, { detail: { rev: 1 } }, { prompter_member_id: PROMPTER }],
  };
  for (const [kind, cases] of Object.entries(broken)) {
    for (const overrides of [...everyKind, ...cases]) {
      assert.throws(() => audit.append(valid(kind, overrides)), TypeError, `${kind} ${JSON.stringify(overrides)}`);
    }
  }
  assert.throws(() => audit.append({ ...old(1), seq: undefined, at: undefined, board_id: BOARD }), TypeError);
  assert.throws(() => audit.append({ kind: 'files_uploaded', project_id: P, actor_member_id: ACTOR, board_id: BOARD,
    detail: { files: 1, bytes: 1, skipped: 0 } }), TypeError, 'an upload names no board');
  assert.equal(fs.existsSync(fileOf(fx)), false, 'refused entries write nothing');
});

test('a schema 2 file is read with a null board on every entry, and the next append writes schema 3', (t) => {
  const fx = createFixture(t);
  fs.writeFileSync(fileOf(fx), JSON.stringify({ schema_version: 2, floor_seq: 1, next_seq: 3, entries: [old(1), old(2)],
    project_floors: {} }));
  const audit = openAudit(fx);
  assert.deepEqual(audit.read({ projectId: P }).entries.map((entry) => [entry.seq, entry.board_id]), [[1, null], [2, null]]);
  assert.equal(disk(fx).schema_version, 2, 'a read writes nothing');
  assert.deepEqual(audit.append(valid('board_deleted')), { ok: true, seq: 3 });
  assert.equal(disk(fx).schema_version, 3);
  assert.deepEqual(disk(fx).entries.map((entry) => entry.board_id), [null, null, BOARD]);
  assert.deepEqual(openAudit(fx).read({ projectId: P }).entries.map((entry) => entry.kind),
    ['approval_decided', 'approval_decided', 'board_deleted']);
});

test('an entry whose keys do not match its file\'s schema is refused, unchanged, and the store unavailable', (t) => {
  const cases = {
    schema_2_entry_with_a_board: { schema_version: 2, floor_seq: 1, next_seq: 2, entries: [{ ...old(1), board_id: null }],
      project_floors: {} },
    schema_1_entry_with_a_board: { schema_version: 1, floor_seq: 1, next_seq: 2, entries: [{ ...old(1), board_id: BOARD }] },
    schema_3_entry_without_a_board: { schema_version: 3, floor_seq: 1, next_seq: 2, entries: [old(1)], project_floors: {} },
    schema_3_board_on_an_approval: { schema_version: 3, floor_seq: 1, next_seq: 2, entries: [{ ...old(1), board_id: BOARD }],
      project_floors: {} },
    schema_2_board_kind: { schema_version: 2, floor_seq: 1, next_seq: 2,
      entries: [(({ board_id: _board, ...rest }) => ({ seq: 1, at: 5, ...rest }))(valid('board_deleted'))], project_floors: {} },
  };
  for (const [name, doc] of Object.entries(cases)) {
    const fx = createFixture(t);
    const text = JSON.stringify(doc);
    fs.writeFileSync(fileOf(fx), text);
    const audit = openAudit(fx);
    assert.equal(audit.floorSeq(), null, name);
    assert.equal(audit.append(valid('board_deleted')).ok, false, name);
    assert.equal(fs.readFileSync(fileOf(fx), 'utf8'), text, `${name}: the file is not rewritten`);
  }
});
