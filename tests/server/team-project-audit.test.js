'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const {
  PROJECT_AUDIT_FILE, PROJECT_AUDIT_KIND_RULES, PROJECT_AUDIT_ENTRY_KINDS, PROJECT_AUDIT_LIMITS, ProjectAudit,
} = require('../../server/team/project-audit');

const P1 = 'project_p1';
const P2 = 'project_p2';
const SESSION = 'sess_1800000000000_aaaaaaaaaaaa';
const ACTOR = 'member_actorXXXXXXXXXXXXXX';
const PROMPTER = 'member_prompterXXXXXXXXXXX';

const VALID = Object.freeze({
  approval_decided: {
    kind: 'approval_decided', project_id: P1, session_id: SESSION, actor_member_id: ACTOR,
    prompter_member_id: PROMPTER, tool_name: 'write_file', decision: 'approved', detail: null,
  },
  approval_not_applied: {
    kind: 'approval_not_applied', project_id: P1, session_id: SESSION, actor_member_id: ACTOR,
    prompter_member_id: PROMPTER, tool_name: 'write_file', decision: 'denied', detail: { ref_seq: 1 },
  },
  approval_expired: {
    kind: 'approval_expired', project_id: P1, session_id: SESSION, actor_member_id: null,
    prompter_member_id: PROMPTER, tool_name: 'edit_file', decision: null, detail: null,
  },
  files_uploaded: {
    kind: 'files_uploaded', project_id: P1, session_id: null, actor_member_id: ACTOR,
    prompter_member_id: null, tool_name: null, decision: null, detail: { files: 3, bytes: 4096, skipped: 0 },
  },
  files_downloaded: {
    kind: 'files_downloaded', project_id: P1, session_id: null, actor_member_id: ACTOR,
    prompter_member_id: null, tool_name: null, decision: null, detail: { files: 2, bytes: 10, skipped: 1 },
  },
  // Slice 3-12: the rule kinds (tool, actor and numbers; only a request names its conversation).
  ...Object.fromEntries([['rule_added', { rule_seq: 1 }], ['rule_requested', { request_seq: 1 }, SESSION],
    ['rule_request_allowed', { request_seq: 1, rule_seq: 2 }], ['rule_request_changed', { request_seq: 2, rule_seq: 3 }],
    ['rule_request_declined', { request_seq: 3 }], ['rule_removed', { rule_seq: 1 }]].map(([kind, detail, session = null]) => [kind,
    { kind, project_id: P1, session_id: session, actor_member_id: ACTOR, prompter_member_id: null, tool_name: 'edit_file',
      decision: null, detail }])),
  files_copied_in: {
    kind: 'files_copied_in', project_id: P1, session_id: null, actor_member_id: null,
    prompter_member_id: null, tool_name: null, decision: null, detail: { files: 2, bytes: 10 },
  },
});

// The six board kinds (schema 3) have their own file: team-project-audit-boards.test.js.
const BOARD_KINDS = ['board_proposal_accepted', 'board_proposal_rejected', 'board_deleted', 'board_restored',
  'board_batch_reverted', 'board_bulk_removed'];
const KINDS = Object.keys(VALID);

function valid(kind, overrides = {}) {
  const base = VALID[kind];
  return { ...base, detail: base.detail && { ...base.detail }, ...overrides };
}

function auditFile(fx) {
  return path.join(fx.dir, PROJECT_AUDIT_FILE);
}

function openAudit(fx, options = {}) {
  return new ProjectAudit({ filePath: auditFile(fx), clock: fx.clock, logger: fx.logger, ...options });
}

function allEntries(audit, options = {}) {
  const out = [];
  let afterSeq = 0;
  for (;;) {
    const page = audit.read({ afterSeq, limit: 100, ...options });
    assert.equal(page.ok, true);
    out.push(...page.entries);
    if (page.next === null) return out;
    afterSeq = page.next;
  }
}

const dead = () => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); };

// ------------------------------------------------------------- kinds and keys

test('the kind list is closed and every kind has a key rule', () => {
  assert.deepEqual([...PROJECT_AUDIT_ENTRY_KINDS].sort(), [...KINDS, ...BOARD_KINDS].sort());
  assert.deepEqual(Object.keys(PROJECT_AUDIT_KIND_RULES).sort(), [...KINDS, ...BOARD_KINDS].sort());
  assert.equal(PROJECT_AUDIT_FILE, 'team-project-audit.json');
  assert.equal(PROJECT_AUDIT_LIMITS.MAX_ENTRIES, 10_000);
  assert.equal(PROJECT_AUDIT_LIMITS.MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(PROJECT_AUDIT_LIMITS.MAX_PAGE, 100);
});

test('each kind accepts its valid entry, durable with exactly the documented keys', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  let seq = 0;
  for (const kind of KINDS) {
    const result = audit.append(valid(kind));
    seq += 1;
    assert.deepEqual(result, { ok: true, seq }, kind);
  }
  const disk = JSON.parse(fs.readFileSync(auditFile(fx), 'utf8'));
  assert.deepEqual(Object.keys(disk), ['schema_version', 'floor_seq', 'next_seq', 'entries', 'project_floors']);
  assert.equal(disk.schema_version, 3);
  const saved = openAudit(fx).read({ projectId: P1 }).entries;
  assert.equal(saved.length, KINDS.length);
  for (const entry of saved) {
    assert.deepEqual(Object.keys(entry), ['seq', 'at', 'kind', 'project_id', 'session_id', 'board_id', 'actor_member_id',
      'prompter_member_id', 'tool_name', 'decision', 'detail']);
    assert.equal(entry.at, fx.clock());
    const { seq: _seq, at: _at, ...rest } = entry;
    assert.deepEqual(rest, { ...valid(entry.kind), board_id: null }); // no kind of this file names a board
  }
});

test('omitted optional keys are null, so a kind whose rule allows null needs no key', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  const result = audit.append({
    kind: 'approval_expired', project_id: P1, session_id: SESSION, prompter_member_id: PROMPTER, tool_name: 'edit_file',
  });
  assert.equal(result.ok, true);
  const [entry] = audit.read({ projectId: P1 }).entries;
  assert.equal(entry.actor_member_id, null);
  assert.equal(entry.decision, null);
  assert.equal(entry.detail, null);
});

test('each kind refuses an entry that breaks its key rule, and nothing is written', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  const broken = {
    approval_decided: [
      { project_id: null }, { session_id: null }, { actor_member_id: null }, { prompter_member_id: null },
      { tool_name: null }, { decision: null }, { decision: 'maybe' }, { detail: { ref_seq: 1 } },
      { detail: { files: 1, bytes: 1, skipped: 0 } },
    ],
    approval_not_applied: [
      { detail: null }, { detail: { ref_seq: 0 } }, { detail: { ref_seq: 1.5 } }, { detail: { ref_seq: '1' } },
      { detail: { ref_seq: 1, files: 1 } }, { detail: {} }, { actor_member_id: null }, { decision: null },
      { prompter_member_id: null }, { session_id: null },
    ],
    approval_expired: [
      { actor_member_id: ACTOR }, { prompter_member_id: null }, { decision: 'denied' }, { session_id: null },
      { tool_name: null }, { detail: { ref_seq: 1 } },
    ],
    files_uploaded: [
      { session_id: SESSION }, { tool_name: 'write_file' }, { decision: 'approved' }, { prompter_member_id: PROMPTER },
      { actor_member_id: null }, { detail: null }, { detail: { files: 1, bytes: 1 } },
      { detail: { files: -1, bytes: 1, skipped: 0 } }, { detail: { files: 1, bytes: 1, skipped: 0, ref_seq: 1 } },
      { project_id: null },
    ],
    files_downloaded: [
      { session_id: SESSION }, { tool_name: 'read_file' }, { decision: 'denied' }, { prompter_member_id: PROMPTER },
      { actor_member_id: null }, { detail: null }, { detail: { files: 1, bytes: Number.MAX_SAFE_INTEGER + 1, skipped: 0 } },
    ],
    // Slice 3-12: an extra detail key, a missing one, a path-shaped value, and the closed keys of each rule kind.
    ...Object.fromEntries([['rule_added', 'rule_seq'], ['rule_removed', 'rule_seq'], ['rule_requested', 'request_seq'],
      ['rule_request_declined', 'request_seq'], ['rule_request_allowed', 'request_seq'], ['rule_request_changed', 'rule_seq']]
      .map(([kind, key]) => [kind, [{ detail: { ...valid(kind).detail, path: 'posts/a.md' } }, { detail: Object.fromEntries(Object.entries(valid(kind).detail).filter(([name]) => name !== key)) },
        { detail: { ...valid(kind).detail, [key]: 'posts/a.md' } }, { detail: null }, { actor_member_id: null }, { tool_name: null },
        { decision: 'approved' }, { prompter_member_id: PROMPTER }, { session_id: kind === 'rule_requested' ? null : SESSION }]])),
    files_copied_in: [
      { actor_member_id: ACTOR }, { session_id: SESSION }, { detail: null }, { detail: { files: 1, bytes: 1, skipped: 0 } },
    ],
  };
  for (const [kind, cases] of Object.entries(broken)) {
    for (const overrides of cases) {
      assert.throws(() => audit.append(valid(kind, overrides)), TypeError, `${kind} ${JSON.stringify(overrides)}`);
    }
  }
  for (const bad of [{ ...valid('approval_decided'), kind: 'made_up' }, { ...valid('approval_decided'), seq: 7 },
    { ...valid('approval_decided'), at: 7 }, { ...valid('approval_decided'), extra: true }, null, 'entry', []]) {
    assert.throws(() => audit.append(bad), TypeError);
  }
  assert.equal(fs.existsSync(auditFile(fx)), false, 'refused entries write nothing');
  assert.deepEqual(audit.append(valid('approval_decided')), { ok: true, seq: 1 }, 'refusals did not consume a seq');
});

test('approval_not_applied must name an earlier entry', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  assert.throws(() => audit.append(valid('approval_not_applied', { detail: { ref_seq: 1 } })), TypeError,
    'seq 1 cannot name itself');
  audit.append(valid('approval_decided'));
  assert.throws(() => audit.append(valid('approval_not_applied', { detail: { ref_seq: 3 } })), TypeError);
  assert.deepEqual(audit.append(valid('approval_not_applied', { detail: { ref_seq: 1 } })), { ok: true, seq: 2 });
});

// ------------------------------------------------------------------ redaction

test('no path, prompt, file name or display name can be stored in any field', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  const smuggled = [
    'C:\\Users\\mina\\secret.txt', '/home/mina/secret.txt', 'src/login.js', '..',
    'Please fix the login bug in src/login.js', 'secret.txt', 'Mina Quixote',
  ];
  const prefixed = (prefix) => smuggled.map((value) => `${prefix}${value}`);
  const textFields = {
    kind: smuggled,
    project_id: [...smuggled, ...prefixed('project_')],
    session_id: [...smuggled, ...prefixed('sess_')],
    actor_member_id: [...smuggled, ...prefixed('member_')],
    prompter_member_id: [...smuggled, ...prefixed('member_')],
    tool_name: smuggled,
    decision: smuggled,
  };
  for (const [field, values] of Object.entries(textFields)) {
    for (const value of values) {
      assert.throws(() => audit.append(valid('approval_decided', { [field]: value })), TypeError, `${field}=${value}`);
    }
  }
  for (const value of smuggled) {
    for (const key of ['ref_seq']) {
      assert.throws(() => audit.append(valid('approval_not_applied', { detail: { [key]: value } })), TypeError);
    }
    for (const key of ['files', 'bytes', 'skipped']) {
      const detail = { files: 1, bytes: 1, skipped: 0, [key]: value };
      assert.throws(() => audit.append(valid('files_uploaded', { detail })), TypeError, `detail.${key}`);
    }
    assert.throws(() => audit.append(valid('files_uploaded', { detail: value })), TypeError, 'detail as text');
    for (const extra of ['path', 'prompt', 'file_name', 'name', 'display_name', 'note']) {
      assert.throws(() => audit.append(valid('files_uploaded', {
        detail: { files: 1, bytes: 1, skipped: 0, [extra]: value },
      })), TypeError, `detail.${extra}`);
      assert.throws(() => audit.append({ ...valid('approval_decided'), [extra]: value }), TypeError, extra);
    }
  }
  assert.equal(fs.existsSync(auditFile(fx)), false);
  audit.append(valid('approval_decided'));
  const disk = fs.readFileSync(auditFile(fx), 'utf8');
  for (const value of ['secret', 'Mina', 'login', '/', '\\\\']) assert.equal(disk.includes(value), false, value);
  assert.equal(JSON.stringify(fx.logs).includes('secret'), false, 'nothing smuggled reached the log');
});

// ------------------------------------------------------------ write failures

test('a failed write answers team_audit_unavailable and the state does not advance', (t) => {
  const fx = createFixture(t);
  let failing = false;
  const audit = openAudit(fx, {
    writeJson(filePath, value) {
      if (failing) dead();
      return require('../../services/host/durable-json').writeJson(filePath, value);
    },
  });
  assert.deepEqual(audit.append(valid('approval_decided')), { ok: true, seq: 1 });
  const before = fs.readFileSync(auditFile(fx));
  failing = true;
  const refused = audit.append(valid('approval_decided', { decision: 'denied' }));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.reason, 'team_audit_unavailable');
  assert.equal(refused.error.code, 'CMP-HOST-0005');
  const page = audit.read({ projectId: P1 });
  assert.deepEqual(page.entries.map((entry) => [entry.seq, entry.decision]), [[1, 'approved']]);
  assert.deepEqual(fs.readFileSync(auditFile(fx)), before);
  assert.ok(fx.logs.some((log) => log.event === 'team_project_audit.write_failed' && log.fields.code === 'EIO'));
  failing = false;
  assert.deepEqual(audit.append(valid('approval_decided', { decision: 'denied' })), { ok: true, seq: 2 },
    'the failed entry did not consume its seq and the store is not broken');
});

test('a write that landed before it threw never leads to a reused seq', (t) => {
  const fx = createFixture(t);
  let throwAfterWrite = false;
  const audit = openAudit(fx, {
    writeJson(filePath, value) {
      require('../../services/host/durable-json').writeJson(filePath, value);
      if (throwAfterWrite) { throwAfterWrite = false; dead(); }
    },
  });
  assert.deepEqual(audit.append(valid('approval_decided')), { ok: true, seq: 1 });
  throwAfterWrite = true;
  assert.equal(audit.append(valid('approval_expired')).error.reason, 'team_audit_unavailable');
  assert.deepEqual(audit.append(valid('files_uploaded')), { ok: true, seq: 3 }, 'the landed seq 2 is not reused');
  assert.deepEqual(openAudit(fx).read({ projectId: P1 }).entries.map((entry) => [entry.seq, entry.kind]),
    [[1, 'approval_decided'], [2, 'approval_expired'], [3, 'files_uploaded']]);
});

test('a read refused once by a busy file answers unavailable, and the next append lands', (t) => {
  const fx = createFixture(t);
  openAudit(fx).append(valid('approval_decided'));
  let busy = true;
  const audit = openAudit(fx, {
    readJson(filePath, options) {
      if (busy) { busy = false; throw Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'open' }); }
      return require('../../services/host/durable-json').readJson(filePath, options);
    },
  });
  assert.equal(audit.append(valid('approval_expired')).error.reason, 'team_audit_unavailable');
  assert.deepEqual(audit.append(valid('approval_expired')), { ok: true, seq: 2 });
  assert.equal(fx.logs.some((log) => log.event === 'team_project_audit.rejected'), false, 'never latched');
});

test('the first write failing leaves no file and no entry', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx, { writeJson: dead });
  assert.equal(audit.append(valid('approval_expired')).error.reason, 'team_audit_unavailable');
  assert.deepEqual(audit.read({ projectId: P1 }).entries, []);
  assert.equal(fs.existsSync(auditFile(fx)), false);
});

// --------------------------------------------------------------------- bounds

test('the entry bound drops the oldest entries and moves floor_seq forward only', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx, { maxEntries: 5 });
  for (let index = 0; index < 8; index += 1) audit.append(valid('approval_decided'));
  const page = audit.read({ projectId: P1 });
  assert.deepEqual(page.entries.map((entry) => entry.seq), [4, 5, 6, 7, 8]);
  assert.equal(page.floor_seq, 4);
  assert.equal(audit.floorSeq(), 4);
  assert.deepEqual(audit.append(valid('approval_decided')), { ok: true, seq: 9 });
  const reopened = openAudit(fx, { maxEntries: 5 });
  assert.equal(reopened.floorSeq(), 5, 'the floor is recorded on disk');
  assert.deepEqual(reopened.append(valid('approval_decided')), { ok: true, seq: 10 });
});

test('floor_seq starts at 1', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  assert.equal(audit.floorSeq(), 1);
  assert.equal(audit.read({ projectId: P1 }).floor_seq, 1);
  audit.append(valid('approval_decided'));
  assert.equal(JSON.parse(fs.readFileSync(auditFile(fx), 'utf8')).floor_seq, 1);
});

test('the byte bound drops the oldest entries and the file stays inside it', (t) => {
  const fx = createFixture(t);
  const maxBytes = 3000;
  const audit = openAudit(fx, { maxBytes });
  for (let index = 0; index < 40; index += 1) audit.append(valid('files_uploaded'));
  const size = fs.statSync(auditFile(fx)).size;
  assert.ok(size <= maxBytes, `file is ${size} bytes`);
  const page = audit.read({ projectId: P1 });
  assert.ok(page.entries.length > 3 && page.entries.length < 40);
  assert.equal(page.entries.at(-1).seq, 40);
  assert.equal(page.floor_seq, page.entries[0].seq);
  assert.ok(page.floor_seq > 1);
});

function storedEntry(seq, overrides = {}) {
  return {
    seq, at: 1, kind: 'approval_decided', project_id: P1, session_id: SESSION, actor_member_id: ACTOR,
    prompter_member_id: PROMPTER, tool_name: 'write_file', decision: 'approved', detail: null, ...overrides,
  };
}

test('at the real limit of 10,000 entries one more append drops exactly the oldest', (t) => {
  const fx = createFixture(t);
  const max = PROJECT_AUDIT_LIMITS.MAX_ENTRIES;
  const entries = Array.from({ length: max }, (_unused, index) => storedEntry(index + 1));
  fs.writeFileSync(auditFile(fx), JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: max + 1, entries }));
  assert.ok(fs.statSync(auditFile(fx)).size <= PROJECT_AUDIT_LIMITS.MAX_BYTES);
  const audit = openAudit(fx);
  assert.deepEqual(audit.append(valid('approval_decided')), { ok: true, seq: max + 1 });
  const doc = JSON.parse(fs.readFileSync(auditFile(fx), 'utf8'));
  assert.equal(doc.entries.length, max);
  assert.equal(doc.floor_seq, 2);
  assert.equal(doc.entries.at(-1).seq, max + 1);
});

test('at the real 4 MiB byte limit an append drops the oldest and stays readable', (t) => {
  const fx = createFixture(t);
  const long = (prefix, seq, chars) => `${prefix}${String(seq).padStart(chars, 'A')}`;
  const big = (seq) => storedEntry(seq, {
    project_id: long('project_', seq, 128), session_id: long('sess_', seq, 123),
    actor_member_id: long('member_', seq, 64), prompter_member_id: long('member_', seq + 1, 64),
    tool_name: 'a'.repeat(PROJECT_AUDIT_LIMITS.MAX_TOOL_NAME_CHARS),
  });
  const header = Buffer.byteLength(JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 100000, entries: [] }));
  const perEntry = Buffer.byteLength(JSON.stringify(big(10000))) + 1;
  const count = Math.floor((PROJECT_AUDIT_LIMITS.MAX_BYTES - header - 16) / perEntry);
  assert.ok(count < PROJECT_AUDIT_LIMITS.MAX_ENTRIES, 'the byte bound bites before the entry bound');
  const entries = Array.from({ length: count }, (_unused, index) => big(10000 + index));
  fs.writeFileSync(auditFile(fx), JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 10000 + count, entries }));
  const audit = openAudit(fx);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(audit.append(valid('approval_decided', { project_id: big(1).project_id })).ok, true);
  }
  assert.ok(fs.statSync(auditFile(fx)).size <= PROJECT_AUDIT_LIMITS.MAX_BYTES);
  const reopened = openAudit(fx);
  assert.ok(reopened.floorSeq() > 10000, 'the oldest entries were dropped to fit');
  const newest = { afterSeq: 10000 + count - 2 };
  assert.equal(reopened.read({ ...newest, projectId: big(10000 + count - 1).project_id }).entries.length, 1,
    'the newest stored entry stays');
  // Once that project holds the most, it pays for itself (the share, review round two): its newest entry stays.
  const own = reopened.read({ projectId: big(1).project_id });
  assert.ok(own.entries.at(-1).seq === 10000 + count + 2 && own.floor_seq <= own.entries[0].seq);
  assert.ok(own.entries.length >= 1 && own.entries.length <= 3, 'it keeps its newest, never more than it wrote');
  assert.equal(reopened.read({ ...newest, projectId: big(10000 + count - 1).project_id }).entries.length, 1,
    'another project keeps its entry');
});

// ----------------------------------------------------------------- strict load

test('corrupt, unknown-key, unknown-kind and newer-schema files leave the file byte-identical and the store unavailable', (t) => {
  const doc = (entries, extra = {}) => JSON.stringify({
    schema_version: 1, floor_seq: 1, next_seq: entries.length + 1, entries, ...extra,
  });
  const cases = {
    corrupt: Buffer.from([0x00, 0xff, 0x80]),
    truncated: '{"schema_version":1,"floor_seq":1,',
    array: '[]',
    newer_schema: JSON.stringify({ schema_version: 4, floor_seq: 1, next_seq: 1, entries: [], project_floors: {} }),
    older_schema: JSON.stringify({ schema_version: 0, floor_seq: 1, next_seq: 1, entries: [] }),
    unknown_document_key: doc([], { extra: true }),
    unknown_entry_key: doc([{ ...storedEntry(1), path: 'src/login.js' }]),
    missing_entry_key: doc([(() => { const { detail: _detail, ...rest } = storedEntry(1); return rest; })()]),
    unknown_kind: doc([storedEntry(1, { kind: 'approval_overridden' })]),
    kind_rule_broken: doc([storedEntry(1, { kind: 'approval_expired' })]),
    unknown_detail_key: doc([storedEntry(1, {
      kind: 'files_uploaded', session_id: null, prompter_member_id: null, tool_name: null, decision: null,
      detail: { files: 1, bytes: 1, skipped: 0, name: 'x' },
    })]),
    seq_out_of_order: JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 3, entries: [storedEntry(2), storedEntry(1)] }),
    floor_above_next: JSON.stringify({ schema_version: 1, floor_seq: 3, next_seq: 2, entries: [] }),
    entry_below_floor: JSON.stringify({ schema_version: 1, floor_seq: 2, next_seq: 3, entries: [storedEntry(1)] }),
    floor_zero: JSON.stringify({ schema_version: 1, floor_seq: 0, next_seq: 1, entries: [] }),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const fx = createFixture(t);
    fs.writeFileSync(auditFile(fx), bytes);
    const audit = openAudit(fx);
    const refused = audit.append(valid('approval_decided'));
    assert.equal(refused.ok, false, name);
    assert.equal(refused.error.reason, 'team_audit_unavailable', name);
    assert.equal(audit.read({ projectId: P1 }).error.reason, 'team_audit_unavailable', name);
    assert.equal(audit.floorSeq(), null, name);
    assert.deepEqual(fs.readFileSync(auditFile(fx)), Buffer.from(bytes), `${name}: never rewritten`);
    assert.ok(fx.logs.some((log) => log.event === 'team_project_audit.rejected'), name);
  }
});

test('a file over the read cap is refused and left alone', (t) => {
  const fx = createFixture(t);
  const bytes = Buffer.alloc(PROJECT_AUDIT_LIMITS.MAX_BYTES + 1, 0x20);
  fs.writeFileSync(auditFile(fx), bytes);
  const audit = openAudit(fx);
  assert.equal(audit.append(valid('approval_decided')).error.reason, 'team_audit_unavailable');
  assert.equal(fs.statSync(auditFile(fx)).size, bytes.length);
});

test('a file from a newer schema is refused and the rejected line says so', (t) => {
  const fx = createFixture(t);
  fs.writeFileSync(auditFile(fx), JSON.stringify({ schema_version: 4, floor_seq: 1, next_seq: 1, entries: [] }));
  assert.equal(openAudit(fx).floorSeq(), null);
  assert.ok(fx.logs.some((log) => log.event === 'team_project_audit.rejected' && log.fields.cause === 'newer_schema'));
});

test('assertSafePath guards reads and writes', (t) => {
  const fx = createFixture(t);
  const seen = [];
  const audit = openAudit(fx, { assertSafePath(filePath) { seen.push(path.basename(filePath)); } });
  audit.append(valid('approval_decided'));
  assert.deepEqual([...new Set(seen)], [PROJECT_AUDIT_FILE]);
  assert.ok(seen.length >= 2);
  const blocked = openAudit(fx, { assertSafePath() { throw new Error('junction'); } });
  assert.equal(blocked.append(valid('approval_decided')).error.reason, 'team_audit_unavailable');
});

// ---------------------------------------------------------------------- paging

test('read pages at most 100 entries oldest first with floor_seq and next', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  for (let index = 0; index < 120; index += 1) audit.append(valid('approval_decided'));
  const first = audit.read({ afterSeq: 0, limit: 1000, projectId: P1 });
  assert.equal(first.entries.length, 100);
  assert.deepEqual([first.entries[0].seq, first.entries.at(-1).seq, first.next, first.floor_seq], [1, 100, 100, 1]);
  const second = audit.read({ afterSeq: first.next, limit: 100, projectId: P1 });
  assert.deepEqual([second.entries.length, second.entries[0].seq, second.next], [20, 101, null]);
  assert.equal(audit.read({ limit: 3, projectId: P1 }).entries.length, 3);
  assert.equal(audit.read({ limit: 3, projectId: P1 }).next, 3);
  assert.deepEqual(audit.read({ afterSeq: 120, projectId: P1 }).entries, []);
  assert.equal(audit.read({ afterSeq: 120, projectId: P1 }).next, null);
  for (const bad of [{ afterSeq: -1 }, { afterSeq: 1.5 }, { afterSeq: 'x' }, { limit: 0 }, { limit: 'many' },
    { projectId: 'not a project' }, { projectId: 'project_general' }, { projectId: 5 }]) {
    const result = audit.read({ projectId: P1, ...bad });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.error.reason, 'team_cursor_invalid');
  }
  first.entries[0].kind = 'tampered';
  assert.equal(audit.read({ limit: 1, projectId: P1 }).entries[0].kind, 'approval_decided', 'pages are copies');
});

test('the project filter returns only that project, paged by seq', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  for (let index = 0; index < 150; index += 1) {
    audit.append(valid('files_downloaded', { project_id: index % 3 === 0 ? P2 : P1 }));
  }
  const p2 = allEntries(audit, { projectId: P2 });
  assert.equal(p2.length, 50);
  assert.ok(p2.every((entry) => entry.project_id === P2));
  assert.deepEqual(p2.slice(0, 3).map((entry) => entry.seq), [1, 4, 7]);
  const p1 = audit.read({ projectId: P1, limit: 60 });
  assert.equal(p1.entries.length, 60);
  assert.ok(p1.entries.every((entry) => entry.project_id === P1));
  assert.equal(p1.next, p1.entries.at(-1).seq);
  const exact = audit.read({ projectId: P1, limit: 100 });
  assert.equal(exact.entries.length, 100);
  assert.equal(exact.next, null, 'a page that ends the project has no next');
  assert.equal(allEntries(audit, { projectId: P1 }).length, 100);
  assert.deepEqual(audit.read({ projectId: 'project_unknown' }).entries, []);
  // No reader is entitled to every project's entries (E30, E31): a read names its project.
  for (const bad of [undefined, {}, { projectId: null }, { afterSeq: 0, limit: 100 }]) {
    const result = audit.read(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.error.reason, 'team_cursor_invalid');
  }
  const detail = audit.read({ projectId: P2, limit: 1 }).entries[0].detail;
  detail.files = 999;
  assert.equal(audit.read({ projectId: P2, limit: 1 }).entries[0].detail.files, 2, 'detail is copied too');
});

// ---------------------------------------------------------------- serialization

test('two appends in one tick get consecutive seq values and both land', async (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => audit.append(valid('approval_decided'))),
    Promise.resolve().then(() => audit.append(valid('approval_not_applied', { detail: { ref_seq: 1 } }))),
  ]);
  assert.deepEqual([first, second], [{ ok: true, seq: 1 }, { ok: true, seq: 2 }]);
  const a = audit.append(valid('approval_expired'));
  const b = audit.append(valid('files_uploaded'));
  assert.deepEqual([a.seq, b.seq], [3, 4]);
  assert.deepEqual(openAudit(fx).read({ projectId: P1 }).entries.map((entry) => [entry.seq, entry.kind]), [
    [1, 'approval_decided'], [2, 'approval_not_applied'], [3, 'approval_expired'], [4, 'files_uploaded'],
  ]);
});

test('reopening the store continues the sequence', (t) => {
  const fx = createFixture(t);
  const audit = openAudit(fx);
  audit.append(valid('approval_decided'));
  audit.append(valid('approval_decided'));
  fx.advance(1000);
  const reopened = openAudit(fx);
  assert.deepEqual(reopened.append(valid('approval_expired')), { ok: true, seq: 3 });
  const entries = openAudit(fx).read({ projectId: P1 }).entries;
  assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3]);
  assert.equal(entries[2].at, fx.clock());
});

test('the constructor needs a file path and clamps bounds to the limits', (t) => {
  assert.throws(() => new ProjectAudit({}), TypeError);
  const fx = createFixture(t);
  const audit = openAudit(fx, { maxEntries: 1e9, maxBytes: 1e12 });
  assert.equal(audit.filePath, auditFile(fx));
  assert.deepEqual(audit.limits(), { maxEntries: 10_000, maxBytes: 4 * 1024 * 1024 });
  for (const bad of [Number.NaN, null, 0, -1, 1.5, '5', Infinity]) {
    assert.throws(() => openAudit(fx, { maxEntries: bad }), TypeError, `maxEntries ${bad}`);
    assert.throws(() => openAudit(fx, { maxBytes: bad }), TypeError, `maxBytes ${bad}`);
  }
});

test('a clock that does not give a time answers team_audit_unavailable and writes nothing', (t) => {
  for (const reading of [1.5, Number.NaN, -1, '1800000000000', undefined]) {
    const fx = createFixture(t);
    const audit = openAudit(fx, { clock: () => reading });
    const refused = audit.append(valid('approval_decided'));
    assert.equal(refused.ok, false, String(reading));
    assert.equal(refused.error.reason, 'team_audit_unavailable');
    assert.deepEqual(audit.read({ projectId: P1 }).entries, []);
    assert.equal(fs.existsSync(auditFile(fx)), false);
  }
});

test('3-4b: openAtStart sets a file refused for its content aside and the log starts fresh', (t) => {
  const { utcStamp } = require('../../server/team/bounded-log');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jenny-project-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, PROJECT_AUDIT_FILE);
  fs.writeFileSync(filePath, JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 2, entries: [{ kind: 'nope' }] }));
  const clock = () => Date.UTC(2026, 10, 12, 9, 30);
  const audit = new ProjectAudit({ filePath, clock });
  assert.deepEqual(audit.openAtStart(), { setAside: true, keptName: `${PROJECT_AUDIT_FILE}.unreadable-${utcStamp(clock())}` });
  assert.equal(audit.append({ ...VALID.approval_decided }).ok, true);
  assert.deepEqual(new ProjectAudit({ filePath, clock }).openAtStart(), { setAside: false, keptName: null }, 'readable now');
});
