'use strict';

// The membership audit log at host start: a log refused for its content is set
// aside and a fresh log says so; a busy log is waited for, bounded, and then the
// start goes on without it; a missing members file beside a refused log stops.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const durableJson = require('../../services/host/durable-json');

function failureOf(result) {
  assert.equal(result.ok, false, 'expected a failure');
  return result.error;
}

async function teamAtRevFive(t) {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const mel = await fx.joinMember(store, owner.member_id);
  assert.equal(store.rev(), 5);
  return { fx, owner, mel };
}

const keptLogs = (fx) => fs.readdirSync(fx.dir).filter((name) => name.startsWith('team-audit.json.unreadable-')).sort();
const causeLogged = (fx, cause) => fx.logs.some((entry) => entry.event === 'team_store.broken' && entry.fields.cause === cause);
const brokenLogged = (fx) => fx.logs.some((entry) => entry.event === 'team_store.broken');
const fail = (code) => Object.assign(new Error(code), { code });

// A start through the store's own bounded wait, with the waits recorded.
async function startOpen(store) {
  const waits = [];
  const opened = await store.openAtStart({ wait: async (ms) => { waits.push(ms); } });
  return { opened, waits };
}

// The audit file's reads throw `code` for the first `times` calls.
function busyReads(fx, code, times = Infinity) {
  let left = times;
  return (filePath, options) => {
    if (filePath === fx.auditFile && left > 0) { left -= 1; throw fail(code); }
    return durableJson.readJson(filePath, options);
  };
}

const resetEntries = (store) => store.audit.read({}).entries.filter((entry) => entry.kind === 'audit_log_reset');

// ---------------------------------------------------------------- set aside

test('an audit log refused for its content is set aside at start and a fresh log says so', async (t) => {
  for (const [name, bytes] of [['not_json', '{not json'], ['over_cap', 'x'.repeat(2 * 1024 * 1024 + 1)],
    ['sequence', JSON.stringify({ schema_version: 2, floor_seq: 3, next_seq: 2, entries: [] })]]) {
    const { fx, owner, mel } = await teamAtRevFive(t);
    fs.writeFileSync(fx.auditFile, bytes);
    const store = fx.openStore();
    const kept = keptLogs(fx);
    assert.equal(kept.length, 1, name);
    assert.match(kept[0], /^team-audit\.json\.unreadable-\d{17}$/u);
    assert.equal(fs.readFileSync(path.join(fx.dir, kept[0]), 'utf8'), bytes, `${name}: kept byte for byte`);
    const [reset] = store.audit.read({}).entries;
    assert.deepEqual([reset.kind, reset.store_rev, reset.applied, reset.actor_member_id, reset.detail],
      ['audit_log_reset', 5, true, null, `kept=${kept[0]}`], name);
    assert.ok(fs.existsSync(path.join(fx.dir, reset.detail.slice('kept='.length))), `${name}: the named file is there`);
    assert.equal((await store.revokeMember({ actorMemberId: owner.member_id, memberId: mel.member_id })).ok, true);
    assert.deepEqual(store.audit.read({}).entries.map((entry) => entry.kind), ['audit_log_reset', 'member_revoked']);
    const lines = fx.logs.filter((entry) => entry.event.startsWith('team_audit.'));
    assert.deepEqual(lines.map((entry) => entry.event).slice(0, 2), ['team_audit.rejected', 'team_audit.set_aside']);
    assert.deepEqual(lines[1].fields, { kept: 1 }, 'a count, never a path');
  }
});

test('a healthy team is never reset', async (t) => {
  const fx = createFixture(t);
  fx.openStore();
  fx.openStore();
  assert.equal(fs.existsSync(fx.auditFile), false, 'a new store opened twice writes nothing');
  const { fx: team } = await teamAtRevFive(t);
  const again = team.openStore();
  assert.deepEqual(resetEntries(again), []);
  assert.deepEqual(keptLogs(team), []);
});

// ------------------------------------------------- a missing members file

test('with the members file missing, a refused audit log stops the start and nothing moves', async (t) => {
  const plants = {
    not_json: (fx) => fs.writeFileSync(fx.auditFile, '{not json'),
    newer: (fx) => fs.writeFileSync(fx.auditFile, JSON.stringify({ schema_version: 9, floor_seq: 1, next_seq: 1, entries: [] })),
    guard: () => {},
    os_hard_link: (fx) => fs.linkSync(fx.auditFile, path.join(fx.dir, 'elsewhere.bin')),
  };
  for (const [name, plant] of Object.entries(plants)) {
    const { fx } = await teamAtRevFive(t);
    fs.rmSync(fx.memberFile);
    plant(fx);
    const before = fs.readFileSync(fx.auditFile);
    const guard = name !== 'guard' ? null : (filePath) => {
      if (filePath.startsWith(fx.auditFile)) throw Object.assign(new Error('refused'), { reason: 'unsafe_path' });
    };
    const store = fx.newStore({ assertSafePath: guard });
    assert.equal(failureOf(store.open()).reason, 'team_unavailable', name);
    assert.ok(causeLogged(fx, 'store_missing_audit_unreadable'), name);
    assert.equal(failureOf(store.open()).reason, 'team_unavailable', `${name}: the store stays broken`);
    assert.deepEqual(keptLogs(fx), [], name);
    assert.equal(fs.existsSync(fx.memberFile), false, name);
    assert.deepEqual(fs.readFileSync(fx.auditFile), before, `${name}: the audit bytes are unchanged`);
  }
});

// ------------------------------------------------------------ refused for good

test('a newer audit schema and a path the guard refuses set nothing aside', async (t) => {
  const { fx, owner, mel } = await teamAtRevFive(t);
  fs.writeFileSync(fx.auditFile, JSON.stringify({ schema_version: 99, floor_seq: 1, next_seq: 1, entries: [] }));
  const newer = fx.openStore();
  assert.equal(failureOf(await newer.revokeMember({ actorMemberId: owner.member_id, memberId: mel.member_id })).reason,
    'team_unavailable');
  assert.ok(fx.logs.some((entry) => entry.event === 'team_audit.rejected' && entry.fields.cause === 'newer_schema'));

  fs.writeFileSync(fx.auditFile, '{not json');
  const guard = (filePath) => {
    if (filePath.startsWith(fx.auditFile)) throw Object.assign(new Error('refused'), { reason: 'unsafe_path' });
  };
  assert.equal(fx.newStore({ assertSafePath: guard }).open().ok, true, 'answers as before');
  assert.equal(fs.readFileSync(fx.auditFile, 'utf8'), '{not json', 'the audit bytes are unchanged');
  assert.deepEqual(keptLogs(fx), []);
});

// ----------------------------------------------------- a busy log at start

test('a log busy for a moment is waited for and then read; nothing is set aside', async (t) => {
  const { fx } = await teamAtRevFive(t);
  const store = fx.newStore({ auditOptions: { readJson: busyReads(fx, 'EBUSY', 2) } });
  const { opened, waits } = await startOpen(store);
  assert.equal(opened.ok, true);
  assert.deepEqual(waits, [250, 250], 'opened on the third try');
  assert.deepEqual(keptLogs(fx), []);
  assert.deepEqual(resetEntries(store), []);
  assert.equal(brokenLogged(fx), false);
});

test('a log that stays busy: the start goes on without it after the bounded tries', async (t) => {
  const { fx, owner, mel } = await teamAtRevFive(t);
  const before = fs.readFileSync(fx.auditFile);
  const store = fx.newStore({ auditOptions: { readJson: busyReads(fx, 'EACCES') } });
  const { opened, waits } = await startOpen(store);
  assert.equal(opened.ok, true);
  assert.equal(waits.length, 7, 'eight tries');
  assert.equal(fx.logs.filter((entry) => entry.event === 'team_store.started_without_audit').length, 1);
  assert.equal(fx.logs.find((entry) => entry.event === 'team_store.started_without_audit').level, 'WARN');
  assert.equal((await store.revokeMember({ actorMemberId: owner.member_id, memberId: mel.member_id })).ok, false,
    'an audited change is refused');
  fx.advance(10 * 60 * 1000);
  const membersBefore = fs.readFileSync(fx.memberFile);
  const touched = await store.touchDevice(owner.device_id);
  assert.equal(failureOf(touched).reason, 'team_store_failed', 'a display-only touch is skipped, as for a failed touch');
  assert.deepEqual(fs.readFileSync(fx.memberFile), membersBefore, 'without a write');
  assert.equal(store.rev(), 5, 'and the store still answers');
  assert.deepEqual(fs.readFileSync(fx.auditFile), before, 'the audit bytes are unchanged');
  assert.equal(brokenLogged(fx), false);
});

test('a busy log beside a missing members file fails the start without breaking the store', async (t) => {
  const { fx } = await teamAtRevFive(t);
  fs.rmSync(fx.memberFile);
  const store = fx.newStore({ auditOptions: { readJson: busyReads(fx, 'EACCES') } });
  const { opened, waits } = await startOpen(store);
  assert.equal(failureOf(opened).reason, 'team_unavailable');
  assert.equal(waits.length, 7);
  assert.equal(brokenLogged(fx), false, 'the store is not broken');
  assert.equal(fs.existsSync(fx.memberFile), false);
});

test('a members file that is refused says so at once, also beside a busy log', async (t) => {
  const { fx } = await teamAtRevFive(t);
  const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  fs.writeFileSync(fx.memberFile, JSON.stringify({ ...doc, schema_version: 99 }));
  const store = fx.newStore({ auditOptions: { readJson: busyReads(fx, 'EBUSY') } });
  const { opened, waits } = await startOpen(store);
  assert.equal(failureOf(opened).reason, 'team_store_schema_unsupported');
  assert.deepEqual(waits, [], 'on the first try');
});

// ------------------------------------------------------- the rename itself

test('a rename refused for a moment is tried again inside the wait', async (t) => {
  const { fx } = await teamAtRevFive(t);
  fs.writeFileSync(fx.auditFile, '{not json');
  let refusals = 2;
  const renameFile = (from, to) => {
    if (refusals > 0) { refusals -= 1; throw fail('EPERM'); }
    durableJson.renameDurable(from, to);
  };
  const store = fx.newStore({ auditOptions: { renameFile } });
  const { opened, waits } = await startOpen(store);
  assert.equal(opened.ok, true);
  assert.equal(waits.length, 2);
  assert.equal(keptLogs(fx).length, 1);
  assert.equal(resetEntries(store).length, 1);
  assert.equal(brokenLogged(fx), false);
});

test('a rename that throws for good answers as before; a reset write that fails is written by the next start', async (t) => {
  const { fx } = await teamAtRevFive(t);
  fs.writeFileSync(fx.auditFile, '{not json');
  const renameFile = () => { throw Object.assign(new Error('refused'), { code: 'EXDEV' }); };
  assert.equal(fx.newStore({ auditOptions: { renameFile } }).open().ok, true);
  assert.deepEqual(keptLogs(fx), []);
  assert.equal(fs.readFileSync(fx.auditFile, 'utf8'), '{not json');

  const busyRename = () => { throw fail('EPERM'); };
  assert.equal(fx.newStore({ auditOptions: { renameFile: busyRename } }).open().ok, true,
    'without the start option a refusal for a moment is final');
  assert.deepEqual(keptLogs(fx), []);

  const writeJson = () => { throw fail('ENOSPC'); };
  assert.equal(failureOf(fx.newStore({ auditOptions: { writeJson } }).open()).reason, 'team_unavailable');
  assert.equal(keptLogs(fx).length, 1);
  assert.equal(fs.existsSync(fx.auditFile), false);
  const next = fx.openStore();
  const [reset] = next.audit.read({}).entries;
  assert.deepEqual([reset.kind, reset.store_rev, reset.applied, reset.detail], ['audit_log_reset', 5, true, 'log=missing'],
    'not a healthy empty log');
});

test('a rename that moved the file and then threw counts as moved', async (t) => {
  const { fx } = await teamAtRevFive(t);
  fs.writeFileSync(fx.auditFile, '{not json');
  const renameFile = (from, to) => { fs.renameSync(from, to); throw fail('EIO'); };
  const store = fx.openStore({ auditOptions: { renameFile } });
  const kept = keptLogs(fx);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(fx.dir, kept[0]), 'utf8'), '{not json');
  const [reset] = store.audit.read({}).entries;
  assert.deepEqual([reset.kind, reset.detail], ['audit_log_reset', `kept=${kept[0]}`]);
});

test('a clock with no date is a failed set-aside, not a throw', async (t) => {
  const { fx } = await teamAtRevFive(t);
  fs.writeFileSync(fx.auditFile, '{not json');
  const store = fx.newStore({ auditOptions: { clock: () => Number.NaN } });
  assert.equal(store.open().ok, true);
  assert.equal(store.open().ok, true);
  assert.equal(fs.readFileSync(fx.auditFile, 'utf8'), '{not json');
  assert.deepEqual(keptLogs(fx), []);
  assert.ok(fx.logs.some((entry) => entry.event === 'team_audit.set_aside_failed'));
});

test('a log that breaks after a good start is not set aside; a later lost members file is refused', async (t) => {
  const { fx, owner, mel } = await teamAtRevFive(t);
  let failing = false;
  const writeJson = (filePath, value) => {
    if (failing) throw fail('EIO');
    durableJson.writeJson(filePath, value);
  };
  const store = fx.openStore({ auditOptions: { writeJson } });
  failing = true;
  const invite = { kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey() };
  assert.equal((await store.createInvite(invite)).ok, false, 'the failed write drops the held log');
  failing = false;
  fs.writeFileSync(fx.auditFile, '{not json');
  assert.equal(failureOf(await store.revokeMember({ actorMemberId: owner.member_id, memberId: mel.member_id })).reason,
    'team_unavailable');
  assert.deepEqual(keptLogs(fx), [], 'not in this process');

  fx.openStore();
  assert.equal(keptLogs(fx).length, 1, 'the next start sets it aside');
  fs.rmSync(fx.memberFile);
  assert.equal(failureOf(fx.newStore().open()).reason, 'team_unavailable');
  assert.ok(causeLogged(fx, 'store_missing'));
});
