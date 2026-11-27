'use strict';

// new-test-file: renderer/team/renderer-team-model-store.js (row 123 slice 6-7, decision 16) is a new renderer module:
// model sharing's per-window state. No existing renderer team test file is about it (the project store's tests are
// the projects page's), and every bridge call here is checked against main's real `validatePayload`.

const assert = require('node:assert/strict');
const test = require('node:test');

const { validatePayload } = require('../services/team/ipc-methods');

const TEAM = 'team_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'team_BBBBBBBBBBBBBBBBBBBBBB';
const STORE = require.resolve('../renderer/team/renderer-team-model-store');
const TEAM_STORE = require.resolve('../renderer/team/renderer-team-store');
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const team = (team_id, over = {}) => ({ team_id, team_name: team_id === TEAM ? 'Studio' : 'Dot lab', state: 'online', member_state: 'active', role: 'member', ...over });
const transfer = (n, over = {}) => ({ transfer_id: 'mtx_' + String(n).padStart(4, '0'), member_id: 'member_dot', member_name: 'Dot', state: 'flowing', reason: null,
  queued: false, bytes_done: 0, bytes_total: 1000, rate_bps: 0, ...over });
const outgoing = (n, over = {}) => ({ request_id: 'mreq_' + String(n).padStart(4, '0'), offer_id: 'moff_s' + n, tag: 'qwen.gguf', display_name: 'Qwen', audience: 'member',
  member_id: 'member_dot', member_name: 'Dot', state: 'open', reason: null, files: 1, total_bytes: 1000, read_done: 1000, transfers: [transfer(n)], ...over });
const incoming = (n, over = {}) => ({ offer_id: 'moff_' + String(n).padStart(4, '0'), sender_member_id: 'member_maya', sender_name: 'Maya', audience: 'member',
  display_name: 'Gemma', files: 2, total_bytes: 5000, state: 'open', reason: null, offered_at: 1, transfer: null, ...over });
const stateAnswer = (over = {}) => ({ ok: true, sharing: 'on', sharing_reason: null, online: true, rate_mb_per_second: 0, outgoing: [], incoming: [], ...over });

// A stubbed bridge: `answers[method]` is a value or a function of the payload; every call is checked against main.
function world({ teams = [team(TEAM)], answers = {}, forceLocal = false } = {}) {
  delete require.cache[STORE];
  delete require.cache[TEAM_STORE];
  const teamStore = require(TEAM_STORE).getTeamStore();
  teamStore.forceLocal = () => forceLocal;
  const calls = [];
  const refused = [];
  const subscribers = new Set();
  const bridge = new Proxy({}, {
    get(_target, name) {
      if (name === 'onModel') return (fn) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };
      return (payload) => {
        calls.push({ method: name, payload });
        if (!validatePayload(name, payload).ok) refused.push(name);
        const answer = Object.hasOwn(answers, name) ? answers[name] : (name === 'modelState' ? stateAnswer() : { ok: true });
        return Promise.resolve(typeof answer === 'function' ? answer(payload) : answer);
      };
    },
  });
  const windowRef = { jennyShell: { team: bridge } };
  const box = { teams };
  const store = require(STORE).createModelStore({ windowRef, teams: () => box.teams });
  const changes = [];
  store.subscribe((change) => changes.push(change));
  return {
    store, calls, changes, box,
    push: (payload) => { for (const fn of [...subscribers]) fn(payload); },
    subscribers: () => subscribers.size,
    sent: (method) => calls.filter((call) => call.method === method),
    setForceLocal: (value) => { forceLocal = value; },
    checkPayloads: () => assert.deepEqual(refused, [], 'main would refuse these payloads'),
  };
}

test('built: modelState once per online team, nothing for a locked, pending or offline team, one subscription', async () => {
  const w = world({ teams: [team(TEAM), team(OTHER, { state: 'connecting' }), team('team_CCCCCCCCCCCCCCCCCCCCCC', { state: 'revoked' }),
    team('team_DDDDDDDDDDDDDDDDDDDDDD', { state: 'pending', member_state: 'pending' })] });
  assert.equal(w.store.team(TEAM), null, 'nothing before a hold');
  const release = w.store.use();
  await flush();
  assert.deepEqual(w.sent('modelState').map((c) => c.payload), [{ team_id: TEAM }]);
  assert.equal(w.subscribers(), 1);
  assert.equal(w.store.team(TEAM).loaded, true);
  assert.equal(w.store.team(TEAM).sharing, 'on');
  w.store.sync();
  await flush();
  assert.equal(w.sent('modelState').length, 1, 'a team already read is not read again while it stays online');
  release();
  w.checkPayloads();
});

test('a reconnect reads the team again; going offline keeps its rows until then', async () => {
  const w = world({ answers: { modelState: stateAnswer({ incoming: [incoming(1)] }) } });
  w.store.use();
  await flush();
  w.box.teams = [team(TEAM, { state: 'connecting' })];
  w.store.sync();
  assert.equal(w.store.team(TEAM).incoming.length, 1);
  w.box.teams = [team(TEAM)];
  w.store.sync();
  await flush();
  assert.equal(w.sent('modelState').length, 2);
  w.checkPayloads();
});

test('the kill switch and the host\'s switch read apart', async () => {
  const w = world({ teams: [team(TEAM), team(OTHER)], answers: { modelState: (p) => (p.team_id === TEAM
    ? { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_model_sharing_off' } } : stateAnswer({ sharing: 'off', sharing_reason: 'sharing_off' })) } });
  w.store.use();
  await flush();
  assert.equal(w.store.team(TEAM).killed, true, 'refused team_model_sharing_off: this PC\'s switch');
  assert.equal(w.store.team(OTHER).killed, false);
  assert.equal(w.store.team(OTHER).sharing, 'off', 'answered sharing off: the host\'s');
  assert.equal(w.store.team(OTHER).sharingReason, 'sharing_off');
});

test('pushes: state replaces, progress patches one transfer and tells only that, received asks provenance again', async () => {
  const w = world({ answers: { modelState: stateAnswer({ outgoing: [outgoing(1), outgoing(2)], incoming: [incoming(1, { transfer: { transfer_id: 'mtx_in1', state: 'pulling',
    reason: null, queued: false, bytes_done: 0, bytes_total: 5000, rate_bps: 0, root_index: 0 } })] }), modelProvenance: { ok: true, provenance: { display_name: 'Gemma' } } } });
  w.store.use();
  await flush();
  w.changes.length = 0;
  w.push({ kind: 'progress', team_id: TEAM, direction: 'send', transfer_id: 'mtx_0002', offer_id: 'moff_s2', bytes_done: 400, bytes_total: 1000, rate_bps: 2_000_000 });
  assert.deepEqual(w.changes, [{ type: 'progress', team_id: TEAM, direction: 'send', transfer_id: 'mtx_0002', offer_id: 'moff_s2' }]);
  const rows = w.store.team(TEAM).outgoing;
  assert.equal(rows[1].transfers[0].bytes_done, 400);
  assert.equal(rows[0].transfers[0].bytes_done, 0, 'the other row untouched');
  w.push({ kind: 'progress', team_id: TEAM, direction: 'receive', transfer_id: 'mtx_in1', offer_id: 'moff_0001', bytes_done: 2500, bytes_total: 5000, rate_bps: 1 });
  assert.equal(w.store.team(TEAM).incoming[0].transfer.bytes_done, 2500);
  // Malformed and foreign pushes change nothing and tell nobody.
  w.changes.length = 0;
  for (const bad of [null, 'x', { kind: 'progress', team_id: TEAM, direction: 'up', transfer_id: 'mtx_0002' }, { kind: 'progress', team_id: TEAM, direction: 'send', transfer_id: 'mtx_none' },
    { kind: 'state', team_id: TEAM, sharing: 'maybe', outgoing: [], incoming: [] }, { kind: 'state', team_id: TEAM, sharing: 'on' },
    { kind: 'state', team_id: 'team_ZZZZZZZZZZZZZZZZZZZZZZ', sharing: 'on', outgoing: [], incoming: [] }, { kind: 'other', team_id: TEAM }]) w.push(bad);
  assert.deepEqual(w.changes, []);
  w.push({ kind: 'state', team_id: TEAM, sharing: 'on', sharing_reason: null, online: true, rate_mb_per_second: 5, outgoing: [outgoing(3)], incoming: [] });
  assert.deepEqual(w.store.team(TEAM).outgoing.map((r) => r.request_id), ['mreq_0003']);
  assert.equal(w.store.team(TEAM).rate, 5);
  assert.equal(w.changes.at(-1).type, 'state');
  w.push({ kind: 'received', team_id: TEAM, tag: 'gemma.gguf', root_index: 0 });
  await flush();
  assert.deepEqual(w.sent('modelProvenance').map((c) => c.payload), [{ team_id: TEAM, tag: 'gemma.gguf' }]);
  assert.equal(w.store.receivedOf('gemma.gguf').team_id, TEAM);
  assert.deepEqual(w.changes.slice(-2).map((c) => c.type), ['received', 'provenance']);
  // The ended entry's push (sharing unknown, offline, empty lists) empties the rows.
  w.push({ kind: 'state', team_id: TEAM, sharing: 'unknown', sharing_reason: null, online: false, rate_mb_per_second: 0, outgoing: [], incoming: [] });
  assert.equal(w.store.team(TEAM).outgoing.length, 0);
  assert.equal(w.store.team(TEAM).online, false);
  w.checkPayloads();
});

test('caps: the client\'s own bounds, at the edge and one past', async () => {
  const { LIMITS } = require(STORE);
  assert.deepEqual([LIMITS.MAX_OUTGOING, LIMITS.MAX_TRANSFERS, LIMITS.MAX_INCOMING, LIMITS.MAX_KEPT, LIMITS.ASK_AT_ONCE], [32, 8, 128, 128, 3]);
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1));
  for (const [out, inc, transfers, keptOut, keptInc, keptTransfers] of [[32, 128, 8, 32, 128, 8], [33, 129, 9, 32, 128, 8]]) {
    const w = world({ answers: { modelState: stateAnswer({ outgoing: many(out, (i) => outgoing(i, { transfers: many(transfers, (j) => transfer(i * 100 + j)) })),
      incoming: many(inc, (i) => incoming(i)) }) } });
    w.store.use();
    await flush();
    const state = w.store.team(TEAM);
    assert.equal(state.outgoing.length, keptOut);
    assert.equal(state.incoming.length, keptInc);
    assert.equal(state.outgoing[0].transfers.length, keptTransfers);
    w.store.dispose();
  }
  const w = world();
  for (let i = 1; i <= 129; i += 1) w.store.keepPath('moff_' + i, 'D:\\Models\\' + i);
  assert.equal(w.store.resources().paths, 128);
  assert.equal(w.store.pathOf('moff_1'), '', 'the oldest went first');
  assert.equal(w.store.pathOf('moff_129'), 'D:\\Models\\129');
  for (let i = 1; i <= 129; i += 1) w.store.setLater('moff_' + i);
  assert.equal(w.store.isLater('moff_1'), false);
  assert.equal(w.store.isLater('moff_2'), true);
  // Teams: at most the app's four.
  const five = ['A', 'B', 'C', 'D', 'E'].map((c) => team('team_' + c.repeat(22)));
  const w5 = world({ teams: five });
  w5.store.use();
  await flush();
  assert.equal(w5.store.resources().teams, 4);
});

test('the review id, kept paths, Later and dismissed rows', async () => {
  const w = world({ teams: [team(TEAM), team(OTHER)], answers: { modelState: (p) => stateAnswer({ incoming: p.team_id === TEAM
    ? [incoming(1), incoming(2, { transfer: { transfer_id: 'mtx_x', state: 'pulling', reason: null, queued: false, bytes_done: 0, bytes_total: 1, rate_bps: 0, root_index: 0 } }), incoming(3, { state: 'ended' })]
    : [incoming(4)] }) } });
  w.store.use();
  await flush();
  assert.equal(w.store.offerCount(), 2, 'open offers with no transfer, across teams');
  w.store.setReview(TEAM, 'moff_0001');
  assert.deepEqual(w.store.peekReview(), { team_id: TEAM, offer_id: 'moff_0001' });
  assert.deepEqual(w.store.takeReview(), { team_id: TEAM, offer_id: 'moff_0001' });
  assert.equal(w.store.takeReview(), null, 'taken once');
  w.store.setLater('moff_0004');
  assert.equal(w.store.offerCount(), 2, 'Later hides the card; the number keeps counting it');
  w.store.dismiss('moff_0003');
  assert.equal(w.store.isDismissed('moff_0003'), true);
  const told = [];
  w.store.subscribe((change) => told.push(change.type));
  w.store.dismiss('moff_0004');
  assert.deepEqual([w.store.offerCount(), told], [1, ['state']], 'a dismissed open offer leaves the number, and the change is told');
  w.store.setReview(OTHER, 'moff_0004');
  w.box.teams = [team(TEAM)];
  w.store.sync();
  assert.equal(w.store.peekReview(), null, 'a team that goes takes its review id with it');
});

test('provenance: at most three asked at once, answers kept, team_not_found kept as not received', async () => {
  const held = [];
  const w = world({ teams: [team(TEAM), team(OTHER)], answers: { modelProvenance: (p) => new Promise((resolve) => held.push({ p, resolve })) } });
  w.store.use();
  await flush();
  w.store.askProvenance(['a.gguf', 'b.gguf', 42, '', 'x'.repeat(257)]);
  assert.equal(held.length, 3, 'two tags times two teams, three at once');
  assert.equal(w.store.resources().asking, 3);
  held.shift().resolve({ ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_not_found' } });
  await flush();
  assert.equal(held.length, 3, 'the fourth starts when one ends');
  held.forEach((h) => h.resolve(h.p.tag === 'b.gguf' && h.p.team_id === OTHER ? { ok: true, provenance: { display_name: 'B', sender_name: 'Maya' } }
    : { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_not_found' } }));
  held.length = 0;
  await flush();
  assert.equal(w.store.receivedOf('a.gguf'), null);
  assert.deepEqual(w.store.receivedOf('b.gguf'), { team_id: OTHER, provenance: { display_name: 'B', sender_name: 'Maya' } });
  const before = w.sent('modelProvenance').length;
  w.store.askProvenance(['a.gguf', 'b.gguf']);
  await flush();
  assert.equal(w.sent('modelProvenance').length, before, 'answers kept for the session');
  assert.equal(w.store.resources().provenance, 4);
  w.checkPayloads();
});

test('resources: nothing held after dispose, a leave, a removal or Force local, with asks in flight and more waiting', async () => {
  for (const end of ['dispose', 'release', 'leave', 'revoked', 'force_local']) {
    const w = world({ teams: [team(TEAM), team(OTHER)], answers: { modelProvenance: () => new Promise(() => {}) } });
    const release = w.store.use();
    await flush();
    w.store.keepPath('moff_1', 'D:\\Models');
    w.store.askProvenance(['a.gguf', 'b.gguf', 'c.gguf']);
    assert.equal(w.store.resources().teams, 2);
    assert.deepEqual([w.store.resources().asking, w.store.resources().waiting], [3, 3], end + ': three asked, three waiting');
    if (end === 'dispose') w.store.dispose();
    else if (end === 'release') release();
    else if (end === 'leave') { w.box.teams = []; w.store.sync(); }
    else if (end === 'revoked') { w.box.teams = [team(TEAM, { state: 'revoked' }), team(OTHER, { state: 'revoked' })]; w.store.sync(); }
    else { w.setForceLocal(true); w.store.sync(); }
    const r = w.store.resources();
    assert.equal(r.teams, 0, end);
    assert.equal(r.asking + r.waiting, 0, end);
    if (end === 'dispose' || end === 'release') {
      assert.equal(r.subscribed, false, end);
      assert.equal(w.subscribers(), 0, end);
      assert.deepEqual([r.paths, r.provenance, r.timers, r.holds], [0, 0, 0, 0], end + ': kept paths, answers and call timers go');
    }
    if (end === 'dispose') assert.equal(r.listeners, 0);
    if (end !== 'dispose') release();
    if (end === 'force_local') { await flush(); assert.equal(w.sent('modelState').length, 2, 'Force local reads nothing more'); }
  }
});

test('an answer for a team that went away is dropped; a late read after release tells nobody', async () => {
  let answer = null;
  const w = world({ answers: { modelState: () => new Promise((resolve) => { answer = resolve; }) } });
  const release = w.store.use();
  release();
  answer(stateAnswer({ incoming: [incoming(1)] }));
  await flush();
  assert.deepEqual(w.changes, []);
  assert.equal(w.store.team(TEAM), null);
});

test('the shared accessor answers null until the store exists', () => {
  delete require.cache[STORE];
  const mod = require(STORE);
  assert.equal(mod.peekModelStore(), null);
  const store = mod.getModelStore();
  assert.equal(mod.peekModelStore(), store);
  store.dispose();
});

// Fix list M3: "not received" (team_not_found, and model_not_listed for a tag main's scan does not list) is kept and
// tells nobody; a tag is asked once per session; a received one tells once, with its tag.
test('provenance: not-received answers tell nobody and are not asked again; a received one tells once with its tag', async () => {
  const w = world({ answers: { modelProvenance: (p) => (p.tag === 'got.gguf' ? { ok: true, provenance: { display_name: 'Got' } }
    : { ok: false, error: { code: 'CMP-TEAM-0011', reason: p.tag.startsWith('n') ? 'model_not_listed' : 'team_not_found' } }) } });
  w.store.use();
  await flush();
  const tags = ['n1.gguf', 'n2.gguf', 'n3.gguf', 'f1.gguf', 'f2.gguf', 'got.gguf'];
  w.changes.length = 0;
  w.store.askProvenance(tags);
  await flush();
  assert.deepEqual(w.changes, [{ type: 'provenance', team_id: TEAM, tag: 'got.gguf' }]);
  assert.equal(w.store.resources().provenance, 6);
  w.store.askProvenance(tags);
  await flush();
  assert.equal(w.sent('modelProvenance').length, 6, 'each tag asked once');
  w.checkPayloads();
});

// Fix list S5: nothing another member wrote or a drawer showed outlives the last hold; a call still out ends.
test('the last release forgets answers, kept paths, Later, dismissed and the review id, and ends calls still out', async () => {
  const w = world({ answers: { modelProvenance: { ok: true, provenance: { display_name: 'G', note: 'only for you' } }, modelOfferRead: () => new Promise(() => {}) } });
  const release = w.store.use();
  await flush();
  w.store.askProvenance(['g.gguf']);
  await flush();
  w.store.keepPath('moff_1', 'D:\\M');
  w.store.setLater('moff_1');
  w.store.dismiss('moff_2');
  w.store.setReview(TEAM, 'moff_1');
  const out = w.store.call('modelOfferRead', { team_id: TEAM, offer_id: 'moff_1' });
  assert.equal(w.store.resources().timers, 1);
  release();
  const r = w.store.resources();
  assert.deepEqual([r.provenance, r.paths, r.later, r.dismissed, r.timers], [0, 0, 0, 0, 0]);
  assert.equal(w.store.peekReview(), null);
  assert.equal((await out).ok, false, 'the call still out answers failed at once');
});

test('a team dropped takes its kept entries; an answer for it that comes later is not kept', async () => {
  const held = [];
  const w = world({ teams: [team(TEAM), team(OTHER)], answers: { modelState: (p) => stateAnswer({ incoming: [incoming(p.team_id === TEAM ? 1 : 2)] }),
    modelProvenance: (p) => new Promise((resolve) => held.push({ p, resolve })) } });
  const release = w.store.use();
  await flush();
  w.store.keepPath('moff_0001', 'D:\\A');
  w.store.setLater('moff_0001');
  w.store.dismiss('moff_0001');
  w.store.keepPath('moff_0002', 'D:\\B');
  w.store.askProvenance(['a.gguf']);
  assert.equal(held.length, 2);
  w.box.teams = [team(OTHER)];
  w.store.sync();
  assert.deepEqual([w.store.pathOf('moff_0001'), w.store.isLater('moff_0001'), w.store.isDismissed('moff_0001')], ['', false, false]);
  assert.equal(w.store.pathOf('moff_0002'), 'D:\\B', 'the other team keeps its own');
  held.forEach((h) => h.resolve({ ok: true, provenance: { display_name: 'A' } }));
  await flush();
  assert.equal(w.store.resources().provenance, 1, 'only the team still here');
  assert.equal(w.store.receivedOf('a.gguf').team_id, OTHER);
  assert.equal(w.store.resources().asking, 0);
  release();
});

test('received pushes: the waiting asks stay bounded; a malformed one is ignored, a null tag still tells', async () => {
  const { LIMITS } = require(STORE);
  const w = world({ answers: { modelProvenance: () => new Promise(() => {}) } });
  const release = w.store.use();
  await flush();
  for (let i = 0; i < LIMITS.MAX_PROVENANCE + 100; i += 1) w.push({ kind: 'received', team_id: TEAM, tag: 't' + i + '.gguf' });
  assert.deepEqual([w.store.resources().asking, w.store.resources().waiting], [3, LIMITS.MAX_PROVENANCE]);
  w.changes.length = 0;
  for (const tag of [42, 'x'.repeat(257), '', {}, undefined]) w.push({ kind: 'received', team_id: TEAM, tag });
  assert.deepEqual(w.changes, [], 'malformed: nobody told');
  w.push({ kind: 'received', team_id: TEAM, tag: null });
  assert.deepEqual(w.changes, [{ type: 'received', team_id: TEAM, tag: null }], 'placed but not found in the scan: the Library reloads');
  release();
});

test('caps: 512 provenance answers and 128 dismissed rows, at the edge and one past', async () => {
  const { LIMITS } = require(STORE);
  const w = world({ answers: { modelProvenance: (p) => ({ ok: true, provenance: { display_name: p.tag } }) } });
  const release = w.store.use();
  await flush();
  const settled = async () => { for (let i = 0; i < 400 && (w.store.resources().asking || w.store.resources().waiting); i += 1) await flush(); };
  w.store.askProvenance(Array.from({ length: LIMITS.MAX_PROVENANCE }, (_v, i) => 'p' + i));
  await settled();
  assert.equal(w.store.resources().provenance, LIMITS.MAX_PROVENANCE);
  assert.ok(w.store.receivedOf('p0'), 'at the cap: all kept');
  w.store.askProvenance(['one-past']);
  await settled();
  assert.equal(w.store.resources().provenance, LIMITS.MAX_PROVENANCE);
  assert.equal(w.store.receivedOf('p0'), null, 'one past: the oldest went');
  assert.ok(w.store.receivedOf('one-past'));
  for (let i = 1; i <= LIMITS.MAX_KEPT; i += 1) w.store.dismiss('moff_d' + i);
  assert.equal(w.store.resources().dismissed, LIMITS.MAX_KEPT);
  assert.equal(w.store.isDismissed('moff_d1'), true, 'at the cap: all kept');
  w.store.dismiss('moff_d' + (LIMITS.MAX_KEPT + 1));
  assert.equal(w.store.resources().dismissed, LIMITS.MAX_KEPT);
  assert.equal(w.store.isDismissed('moff_d1'), false, 'one past: the oldest went');
  release();
});

test('resources count the call timers and the team store\'s subscription while held', async () => {
  delete require.cache[STORE];
  delete require.cache[TEAM_STORE];
  const answers = [];
  const store = require(STORE).createModelStore({ windowRef: { jennyShell: { team: { modelFiles: () => new Promise((resolve) => answers.push(resolve)) } } } });
  const release = store.use();
  assert.equal(store.resources().teamStore, true, 'no teams option: the team store is followed');
  void store.call('modelFiles', { team_id: TEAM, tag: 'a' });
  assert.equal(store.resources().timers, 1);
  answers[0]({ ok: true });
  await flush();
  assert.equal(store.resources().timers, 0, 'cleared when it settles');
  release();
  assert.deepEqual([store.resources().teamStore, store.resources().timers], [false, 0]);
});
