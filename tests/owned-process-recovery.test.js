const test = require('node:test');
const assert = require('node:assert/strict');
const cases = require('./fixtures/owned-process-recovery.json');
const { decide, recover } = require('../services/backend/owned-process-recovery');
for (const item of cases) {
  test(item.name, () => assert.equal(decide(item.entry, item.owner, item.process, item.uid), item.expected));
}
test('identity change during TERM grace prevents escalation and does not claim cleanup', () => {
  const item = cases.find(x => x.name === 'dead-owner');
  const calls = [];
  const mutations = [];
  const entry = item.entry;
  const result = recover({ snapshot: () => ({ [entry.id]: entry }),
    mutate: (...args) => mutations.push(args), uid: 1000,
    read: pid => pid === 101 ? { state: 'missing' } : calls.length ? { state: 'missing' } : item.process,
    send: (pid, sig) => calls.push([pid, sig]), wait: () => {} });
  assert.deepEqual(calls, [[202, 'SIGTERM']]);
  assert.equal(mutations[0][0], 'retain');
  assert.equal(result.reap, 1);
});


test('whole-sweep budget bounds uncertain helper mutations and preserves unvisited entries', () => {
  const item = cases.find(x => x.name === 'dead-owner');
  const entries = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(i), { ...item.entry, id: String(i) }]));
  let clock = 0;
  const budgets = [];
  recover({ snapshot: () => entries, read: () => ({ state: 'unknown' }), now: () => clock,
    mutate: (op, key, entry, remainingMs) => { budgets.push(remainingMs); clock += Math.min(3500, remainingMs ?? 3500); } });
  assert.deepEqual(budgets, [8000, 4500, 1000]);
  assert.equal(clock, 8000);
  assert.equal(Object.keys(entries).length, 50);
});

test('an already unconfirmed retained receipt costs no helper mutation', () => {
  const item = cases.find(x => x.name === 'dead-owner');
  const mutations = [];
  const result = recover({ snapshot: () => ({ a: { ...item.entry, id: 'a', state: 'unconfirmed' } }),
    read: () => ({ state: 'unknown' }), mutate: (...args) => mutations.push(args) });
  assert.equal(result.retain, 1);
  assert.deepEqual(mutations, []);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { frozenInterpreter } = require('../services/backend/owned-process-recovery');
const UNRESOLVED = { state: 'unresolved' };

function fakeProc(t, parents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fake-proc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [pid, ppid] of Object.entries(parents)) {
    fs.mkdirSync(path.join(root, pid));
    fs.writeFileSync(path.join(root, pid, 'stat'), `${pid} (jenny sidecar) S ${ppid} ${pid} ${pid} 0`);
  }
  return root;
}
const ident = (pid, exe = '/opt/Jenny/resources/sidecar/jenny-sidecar', uid = 1000) => ({
  pid, pgid: pid, uid, start: `boot:${pid}`, exe, command_hash: 'a'.repeat(64) });

test('frozenInterpreter resolves the single same-binary same-user child of a onefile bootloader', (t) => {
  const procRoot = fakeProc(t, { 300: 1, 301: 300, 302: 300, 303: 301 });
  const identities = { 300: ident(300), 301: ident(301), 302: ident(302, '/usr/bin/sh'), 303: ident(303) };
  const read = pid => identities[pid] ? { state: 'alive', identity: identities[pid] } : { state: 'missing' };
  assert.deepEqual(frozenInterpreter(300, { platform: 'linux', procRoot, read }), identities[301]);
  identities[302] = ident(302);
  assert.deepEqual(frozenInterpreter(300, { platform: 'linux', procRoot, read }), UNRESOLVED, 'ambiguous children');
  identities[302] = ident(302, undefined, 0);
  assert.deepEqual(frozenInterpreter(300, { platform: 'linux', procRoot, read }), identities[301]);
  assert.equal(frozenInterpreter(300, { platform: 'win32', procRoot, read }), null);
  assert.deepEqual(frozenInterpreter(300, { platform: 'linux', procRoot, read: () => ({ state: 'unknown' }) }), UNRESOLVED);
});

test('frozenInterpreter is null only for a verified childless bootloader; inconclusive discovery is unresolved', (t) => {
  const procRoot = fakeProc(t, { 300: 1, 301: 300 });
  const identities = { 300: ident(300), 301: ident(301) };
  const read = pid => identities[pid] ? { state: 'alive', identity: identities[pid] } : { state: 'unknown' };
  const find = (options = {}) => frozenInterpreter(300, { platform: 'linux', procRoot, read, ...options });
  assert.deepEqual(find(), identities[301]);
  delete identities[301];
  assert.deepEqual(find(), UNRESOLVED, 'a live child whose identity is unreadable');
  assert.deepEqual(find({ read: pid => (pid === 300 ? read(300) : { state: 'missing' }) }), null, 'the child exited');
  assert.deepEqual(find({ procRoot: path.join(procRoot, 'absent') }), UNRESOLVED, 'unreadable /proc');
  fs.writeFileSync(path.join(procRoot, '301', 'stat'), `301 (other) S 1 301 301 0`);
  assert.equal(find(), null, 'no child of the bootloader');
});
