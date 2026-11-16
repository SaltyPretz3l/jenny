'use strict';

// new-test-file: slice 3-12's rules store (server/team/project-rules-store.js, team-project-rules.json), a new surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PROJECT_RULES_FILE, PROJECT_RULES_LIMITS: LIMITS, ProjectRulesStore, upgradeDocument, validDocument,
} = require('../../server/team/project-rules-store');
const { writeJson: durableWrite } = require('../../services/host/durable-json');

const P = 'project_aaaaaaaa';
const ALICE = 'member_alice';
const CARL = 'member_carl';

function profile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function open(t, { dir = profile(t), now = { at: 1_000 }, ...extra } = {}) {
  const store = new ProjectRulesStore({ filePath: path.join(dir, PROJECT_RULES_FILE), clock: () => now.at, ...extra });
  store.openAtStart();
  return { store, dir, now, file: path.join(dir, PROJECT_RULES_FILE) };
}
const rule = (seq, overrides = {}) => ({ rule_seq: seq, tool_name: 'edit_file', folder: null, set_by: ALICE, set_at: 1,
  from_request_seq: null, use_count: 0, last_used_at: null, last_used_by: null, ...overrides });
const request = (seq, overrides = {}) => ({ request_seq: seq, tool_name: 'write_file', asker_member_id: CARL,
  session_id: 'sess_1', asked_at: 1, state: 'open', answered_by: null, answered_at: null, outcome_tool: null,
  outcome_folder: null, reason: null, rule_seq: null, ...overrides });
const doc = (project = {}) => ({ schema_version: 1, projects: [{ project_id: P, revision: 1, next_rule_seq: 100,
  next_request_seq: 100, rules: [], requests: [], ...project }] });
const addRule = (store, seq, overrides = {}) => store.commit(P, (entry) => {
  entry.rules.push(rule(seq, overrides));
  entry.next_rule_seq = Math.max(entry.next_rule_seq, seq + 1);
  return {};
});

test('every bound at the edge passes and one past it is refused', () => {
  const rules = Array.from({ length: LIMITS.MAX_RULES }, (_, i) => rule(i + 1, { folder: `f${i}` }));
  assert.equal(validDocument(doc({ rules })), true);
  assert.equal(validDocument(doc({ rules: [...rules, rule(50, { folder: 'g' })] })), false);
  const open16 = Array.from({ length: LIMITS.MAX_OPEN_REQUESTS }, (_, i) => request(i + 1, { asker_member_id: `member_m${i}` }));
  assert.equal(validDocument(doc({ requests: open16 })), true);
  assert.equal(validDocument(doc({ requests: [...open16, request(60, { asker_member_id: 'member_x' })] })), false);
  const answered = (i) => request(i, { state: 'declined', answered_by: ALICE, answered_at: 2, reason: 'No' });
  const kept = Array.from({ length: LIMITS.MAX_ANSWERED_REQUESTS }, (_, i) => answered(i + 1));
  assert.equal(validDocument(doc({ requests: kept })), true);
  assert.equal(validDocument(doc({ requests: [...kept, answered(70)] })), false);
  // One open request per (asker, tool); one rule per (tool, folder).
  assert.equal(validDocument(doc({ requests: [request(1), request(2)] })), false);
  assert.equal(validDocument(doc({ requests: [request(1), request(2, { tool_name: 'edit_file' })] })), true);
  assert.equal(validDocument(doc({ rules: [rule(1), rule(2)] })), false);
  // The reason: 200 characters of clean text.
  assert.equal(validDocument(doc({ requests: [answered(1)].map((r) => ({ ...r, reason: 'x'.repeat(200) })) })), true);
  for (const reason of ['x'.repeat(201), 'line\nbreak', ' padded', 'bidi\u202e', '']) {
    assert.equal(validDocument(doc({ requests: [{ ...answered(1), reason }] })), false, JSON.stringify(reason));
  }
  // Folders through the matcher's rule: 8 segments and 255 characters.
  assert.equal(validDocument(doc({ rules: [rule(1, { folder: 'a/b/c/d/e/f/g/h' })] })), true);
  for (const folder of ['a/b/c/d/e/f/g/h/i', 'a'.repeat(256), '../x', '/x', 'C:/x', 'con', 'x.']) {
    assert.equal(validDocument(doc({ rules: [rule(1, { folder })] })), false, folder);
  }
  // A seq at or past its next counter, and a document over 64 projects.
  assert.equal(validDocument(doc({ rules: [rule(100)] })), false);
  const many = Array.from({ length: LIMITS.MAX_PROJECTS + 1 }, (_, i) => ({ ...doc().projects[0], project_id: `project_p${i}` }));
  assert.equal(validDocument({ schema_version: 1, projects: many }), false);
  assert.equal(validDocument({ schema_version: 1, projects: many.slice(1) }), true);
});

test('exact keys at every level: a missing or extra key is refused', () => {
  const base = doc({ rules: [rule(1)], requests: [request(1)] });
  const variants = [
    { ...base, extra: 1 },
    { ...base, projects: [{ ...base.projects[0], extra: 1 }] },
    { ...base, projects: [{ ...base.projects[0], rules: [{ ...rule(1), extra: 1 }] }] },
    { ...base, projects: [{ ...base.projects[0], requests: [{ ...request(1), path: 'x' }] }] },
  ];
  for (const variant of variants) assert.equal(validDocument(variant), false);
  const { rule_seq: _seq, ...missing } = rule(1);
  assert.equal(validDocument({ ...base, projects: [{ ...base.projects[0], rules: [missing] }] }), false);
  assert.equal(validDocument(base), true);
  assert.equal(upgradeDocument(base), base);
  assert.equal(upgradeDocument({ ...base, schema_version: 2 }), null);
});

test('a newer version fails closed and is kept as it is; nothing answers, nothing is written', (t) => {
  const dir = profile(t);
  const file = path.join(dir, PROJECT_RULES_FILE);
  const newer = JSON.stringify({ ...doc(), schema_version: 2 });
  fs.writeFileSync(file, newer);
  const { store } = open(t, { dir });
  assert.equal(store.available(), false);
  assert.equal(store.project(P), null);
  assert.equal(addRule(store, 1).reason, 'team_rules_unavailable');
  assert.equal(fs.readFileSync(file, 'utf8'), newer);
  assert.deepEqual(fs.readdirSync(dir), [PROJECT_RULES_FILE]);
});

test('a broken file is set aside at start, a fresh store serves, and team-members.json is never written', (t) => {
  for (const broken of ['{not json', JSON.stringify({ ...doc(), extra: true }), JSON.stringify(doc({ rules: [rule(1), rule(1)] }))]) {
    const dir = profile(t);
    fs.writeFileSync(path.join(dir, PROJECT_RULES_FILE), broken);
    const { store } = open(t, { dir });
    assert.equal(store.available(), true);
    const names = fs.readdirSync(dir).sort();
    assert.equal(names.length, 1);
    assert.match(names[0], /^team-project-rules\.json\.unreadable-\d{17}$/u);
    assert.equal(addRule(store, 1).ok, true);
    assert.equal(fs.readFileSync(path.join(dir, names[0]), 'utf8'), broken);
    // The fresh store wrote its own file and nothing else (no member file, no stray temp file).
    assert.deepEqual(fs.readdirSync(dir).sort(), [PROJECT_RULES_FILE, names[0]].sort());
    assert.equal(fs.statSync(path.join(dir, PROJECT_RULES_FILE)).isFile(), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, PROJECT_RULES_FILE)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, PROJECT_RULES_FILE), 'utf8')).projects[0].rules[0].rule_seq, 1);
  }
});

test('a write over 512 KiB is refused and nothing changes', (t) => {
  const { store, file } = open(t);
  assert.equal(addRule(store, 1).ok, true);
  const before = fs.readFileSync(file, 'utf8');
  // Fill 64 projects with 32 rules of 255-character folders: well past 512 KiB.
  let refused = null;
  for (let p = 0; p < LIMITS.MAX_PROJECTS && !refused; p += 1) {
    for (let r = 1; r <= LIMITS.MAX_RULES && !refused; r += 1) {
      const answer = store.commit(`project_fill${p}`, (entry) => {
        entry.rules.push(rule(r, { folder: `${r}`.padEnd(255, 'x') }));
        entry.next_rule_seq = r + 1;
        return {};
      });
      if (!answer.ok) refused = answer;
    }
  }
  assert.equal(refused?.reason, 'team_rules_full');
  assert.ok(fs.statSync(file).size <= LIMITS.MAX_BYTES);
  assert.ok(fs.readFileSync(file, 'utf8').length > before.length);
});

test('use counts: held in memory, written with the next change, at most once a minute on a use, and at flush', (t) => {
  const { store, file, now } = open(t);
  assert.equal(addRule(store, 1).ok, true);
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].rules[0];
  store.noteUse(P, 1, CARL);
  now.at += 30_000;
  store.noteUse(P, 1, CARL);
  assert.equal(stored().use_count, 0, 'not written inside the minute');
  assert.equal(store.project(P).rules[0].use_count, 2, 'the read folds in what is held');
  now.at += 30_000;
  store.noteUse(P, 1, ALICE);
  assert.deepEqual([stored().use_count, stored().last_used_by, stored().last_used_at], [3, ALICE, now.at]);
  now.at += 1_000;
  store.noteUse(P, 1, CARL);
  assert.equal(stored().use_count, 3);
  // The next rule change writes the held count.
  assert.equal(addRule(store, 2, { tool_name: 'write_file' }).ok, true);
  assert.equal(stored().use_count, 4);
  store.noteUse(P, 2, CARL);
  assert.equal(store.flush().ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].rules[1].use_count, 1);
  // A crash before any of those points loses the held counts only.
  store.noteUse(P, 1, CARL);
  const reopened = open(t, { dir: path.dirname(file) }).store;
  assert.equal(reopened.project(P).rules[0].use_count, 4);
});

test('commit: a refusal writes nothing, a dry run writes nothing, a drop is idempotent', (t) => {
  const { store, file } = open(t);
  assert.equal(store.commit(P, () => ({ ok: false, kind: 'limit', reason: 'team_rule_limit' })).reason, 'team_rule_limit');
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.commit(P, (entry) => { entry.rules.push(rule(1)); entry.next_rule_seq = 2; return {}; }, { dryRun: true }).ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(addRule(store, 1).ok, true);
  assert.equal(store.commit(P, () => ({ drop: true })).ok, true);
  assert.equal(store.commit(P, () => ({ drop: true })).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects, []);
  assert.equal(addRule(store, 1).ok, true);
  assert.equal(store.prune((projectId) => projectId !== P), 1);
  assert.deepEqual(store.projectIds(), []);
});

test('an "anywhere" rule and a rule for a folder named null coexist (the uniqueness key cannot collide)', (t) => {
  assert.equal(validDocument(doc({ rules: [rule(1, { folder: null }), rule(2, { folder: 'null' })] })), true);
  assert.equal(validDocument(doc({ rules: [rule(1, { folder: 'null' }), rule(2, { folder: 'null' })] })), false);
  const { store } = open(t);
  assert.equal(addRule(store, 1, { folder: null }).ok, true);
  assert.equal(addRule(store, 2, { folder: 'null' }).ok, true);
  assert.deepEqual(store.project(P).rules.map((entry) => entry.folder), [null, 'null']);
});

test('a 65th project with rules is a limit (team_rules_full), not a broken document', (t) => {
  const { store } = open(t);
  for (let p = 0; p < LIMITS.MAX_PROJECTS; p += 1) {
    assert.equal(store.commit(`project_p${p}`, (entry) => { entry.rules.push(rule(1)); entry.next_rule_seq = 2; return {}; }).ok, true);
  }
  const answer = store.commit('project_p64', (entry) => { entry.rules.push(rule(1)); entry.next_rule_seq = 2; return {}; });
  assert.deepEqual([answer.ok, answer.kind, answer.reason], [false, 'limit', 'team_rules_full']);
  assert.equal(store.projectIds().length, LIMITS.MAX_PROJECTS);
});

test('a failing disk costs one write attempt a minute on uses; the counts stay held and land once it heals', (t) => {
  const attempts = [];
  const errors = [];
  const fault = { on: false };
  const { store, file, now } = open(t, {
    writeJson: (target, value) => { attempts.push(now.at); if (fault.on) throw new Error('disk gone'); return durableWrite(target, value); },
    logger: (level, event) => { if (level === 'ERROR') errors.push(event); },
  });
  assert.equal(addRule(store, 1).ok, true);
  attempts.length = 0;
  fault.on = true;
  for (let i = 0; i < 100; i += 1) { now.at += 1_000; store.noteUse(P, 1, CARL); }
  assert.equal(attempts.length, 1, 'one attempt in 100 seconds of uses');
  assert.equal(errors.length, 1, 'one error line per failed attempt');
  for (let i = 0; i < 100; i += 1) { now.at += 1_000; store.noteUse(P, 1, CARL); }
  assert.equal(attempts.length, 3, 'two minutes later, two more attempts');
  fault.on = false;
  assert.equal(store.flush().ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].rules[0].use_count, 200);
});

test('rulesFor answers frozen { rule_seq, folder } pairs for one tool, no copy of the entry; null while unavailable', (t) => {
  const { store } = open(t);
  assert.equal(addRule(store, 1, { folder: 'posts' }).ok, true);
  assert.equal(addRule(store, 2, { tool_name: 'write_file' }).ok, true);
  const held = store.rulesFor(P, 'edit_file');
  assert.deepEqual(held, [{ rule_seq: 1, folder: 'posts' }]);
  assert.equal(Object.isFrozen(held) && Object.isFrozen(held[0]), true);
  assert.deepEqual(store.rulesFor('project_none', 'edit_file'), []);
  const dir = profile(t);
  fs.writeFileSync(path.join(dir, PROJECT_RULES_FILE), JSON.stringify({ ...doc(), schema_version: 2 }));
  assert.equal(open(t, { dir }).store.rulesFor(P, 'edit_file'), null);
});
