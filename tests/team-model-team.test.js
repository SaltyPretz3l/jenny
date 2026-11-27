'use strict';

// new-test-file: row 123 slice 6-5 per-team model module (services/team/model-team.js, team-models.js) over a stub
// host with an injected clock and timers: forged host answers never leave rebuilt, a flapping link stays inside the
// host's 30 commands a minute, the state push is throttled, repeated calls share one host command, an older host reads
// as sharing off, and a stop or a revoke leaves nothing behind.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createModelIncoming } = require('../services/team/model-incoming');
const journals = require('../services/team/model-receive-journal');
const { createOffersFile } = require('../services/team/model-offers-file');
const { createModelTeam } = require('../services/team/model-team');
const { busyRetrying, createTeamModels } = require('../services/team/team-models');

const TEAM = 'team_abcdefghijklmnop';
const ME = 'member_abcdefghijklmnop';
const OLIVE = 'member_bcdefghijklmnopq';
const MAIN = 'Qwen3-8B-Q4_K_M.gguf';
const offerIdOf = (n) => `offer_${String(n).padStart(22, 'o')}`;
const TRANSFER = `mxfer_${'t'.repeat(22)}`;
// Lets promises and real file I/O (the sender's lstat) settle between fake timers.
const flush = async () => {
  for (let n = 0; n < 3; n += 1) await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setTimeout(resolve, 2); });
};

// Timers and a clock the test moves: `advance(ms)` runs every timer due, in order, letting promises settle between.
function fakeTime() {
  let now = 1_800_000_000_000;
  let seq = 0;
  const queue = new Map();
  const timers = {
    setTimeout: (fn, ms) => { seq += 1; const handle = { id: seq, at: now + Math.max(0, ms), fn, unref() {} }; queue.set(handle.id, handle); return handle; },
    clearTimeout: (handle) => { if (handle) queue.delete(handle.id); },
    setInterval: () => { seq += 1; return { id: seq, unref() {} }; },
    clearInterval: () => {},
  };
  return {
    timers, clock: () => now, pending: () => queue.size,
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const due = [...queue.values()].filter((handle) => handle.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        queue.delete(due.id);
        now = due.at;
        due.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

// A stub host: `answers[operation](params)` answers each command; every command is recorded with the clock.
function stubManager(time, answers) {
  let state = 'online';
  const listeners = new Set();
  const sent = [];
  const roster = [{ member_id: ME, display_name: 'Mika Member', role: 'member', state: 'active' },
    { member_id: OLIVE, display_name: 'Olive Owner', role: 'owner', state: 'active' }];
  const manager = {
    snapshot: () => ({ state, member_state: 'active', member_id: ME, display_name: 'Mika Member', role: 'member' }),
    command: async (operation, params) => {
      sent.push({ operation, params, at: time.clock() });
      if (state !== 'online') return { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };
      if (answers[operation]) return answers[operation](params);
      if (operation === 'team.members.list') return { ok: true, members: roster };
      if (operation === 'team.model.offers') return { ok: true, offers: [], transfers: [] };
      return { ok: false, error: { code: 'CMP-HOST-0001', reason: 'team_not_found' } };
    },
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    borrow: () => ({ online: false, link: null }),
  };
  return { manager, sent, listeners, roster, setState: (next) => { state = next; }, emit: (event) => { for (const listener of [...listeners]) listener(event); } };
}

function setup(t, { answers = {}, entries = [] } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-team-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'models', 'Qwen3-8B-Q4_K_M');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MAIN), Buffer.alloc(4096, 7));
  const userDataPath = path.join(base, 'profile');
  fs.mkdirSync(userDataPath);
  if (entries.length) createOffersFile({ userDataPath, teamId: TEAM }).save(entries);
  const time = fakeTime();
  const host = stubManager(time, answers);
  const pushes = [];
  const logs = [];
  const hasher = { hash: async (file) => ({ size: fs.statSync(file).size, sha256: 'a'.repeat(64), segments: ['a'.repeat(64)] }) };
  const deps = { teamId: TEAM, manager: host.manager, userDataPath, roots: () => [], hasher, clock: time.clock, timers: time.timers,
    discovery: async () => [{ tag: 'qwen3:8b', dir, mainGguf: MAIN, sizeBytes: 4096, source: 'library' }],
    push: (payload) => pushes.push(JSON.parse(JSON.stringify(payload))), log: (level, event, fields) => logs.push({ level, event, fields }) };
  return { base, time, host, pushes, logs, deps };
}

const entryOf = (requestId, offerId = null) => ({ request_id: requestId, offer_id: offerId, audience: { kind: 'team' }, tag: 'qwen3:8b',
  files: [MAIN], manifest: { request_id: requestId, audience: { kind: 'team' }, display_name: 'Qwen three',
    files: [{ name: MAIN, size: 4096, sha256: 'a'.repeat(64), segments: ['a'.repeat(64)] }],
    provenance: { licence: 'Apache-2.0', source_url: null, note: '' } } });
const summaryOf = (offerId) => ({ offer_id: offerId, sender_member_id: ME, audience: 'team', display_name: 'Qwen three', files: 1,
  total_bytes: 4096, state: 'open' });
const lastState = (pushes) => pushes.filter((push) => push.kind === 'state').at(-1) || null;
const call = (team, method, payload = {}) => team.call(method, { team_id: TEAM, ...payload });

test('forged host answers to withdraw, pause and offer never reach an answer, a push or a log as they came', async (t) => {
  const forged = { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'MARKER_REASON C:\\secret', detail: 'MARKER_DETAIL' },
    offer_id: `offer_${'x'.repeat(3000)}`, extra: 'MARKER_EXTRA' };
  let offers = 0;
  const { time, host, pushes, logs, deps } = setup(t, { answers: {
    'team.model.offer': () => {
      offers += 1;
      return offers === 1 ? { ok: true, offer: { offer_id: offerIdOf(1), state: 'open' } }
        : { ok: true, offer: { offer_id: `offer_${'x'.repeat(3000)}`, state: 'open', note: 'MARKER_NOTE' } };
    },
    'team.model.withdraw': () => forged, 'team.model.pause': () => forged,
    'team.members.list': () => ({ ok: true, members: [...host.roster, { member_id: 'member_cdefghijklmnopqr', display_name: 'Odd', role: 'MARKER_ROLE', state: 'active' }] }),
  } });
  const team = createModelTeam(deps);
  team.start();
  t.after(() => team.stop());
  await time.advance(10);
  const first = await call(team, 'modelOffer', { tag: 'qwen3:8b', files: [], display_name: 'Qwen three' });
  await time.advance(300);
  assert.equal(lastState(pushes).outgoing.find((row) => row.request_id === first.request_id).state, 'open');
  host.emit({ event_type: 'team_model_transfer', cursor: 9, transfer_id: TRANSFER, offer_id: offerIdOf(1), sender_member_id: ME,
    receiver_member_id: OLIVE, state: 'paused', queued: false, reason: 'paused_by_receiver', display_name: 'Qwen three',
    bytes_done: 0, bytes_total: 4096, next: { index: 0, part: 0 } });
  const answers = [await call(team, 'modelSendPause', { transfer_id: TRANSFER }), await call(team, 'modelWithdraw', { request_id: first.request_id })];
  for (const answer of answers) assert.deepEqual(answer, { ok: false, error: { code: 'CMP-TEAM-0011', reason: 'team_unavailable' } });
  // An offer id past the relay's pattern is not kept: the offer fails as team_answer_invalid.
  const second = await call(team, 'modelOffer', { tag: 'qwen3:8b', files: [], display_name: 'Qwen three' });
  await time.advance(300);
  const row = lastState(pushes).outgoing.find((entry) => entry.request_id === second.request_id);
  assert.deepEqual([row.state, row.reason, row.offer_id], ['failed', 'team_answer_invalid', null]);
  // A roster row with a role outside the closed list is not kept.
  const receivers = await call(team, 'modelReceivers');
  assert.deepEqual(receivers.members.map((member) => [member.display_name, member.role]), [['Olive Owner', 'owner']]);
  await time.advance(300);
  const seen = JSON.stringify({ answers, receivers, pushes, logs });
  for (const marker of ['MARKER', 'x'.repeat(100), 'secret']) assert.equal(seen.includes(marker), false, `${marker} left main`);
});

test('16 kept offers and a flapping link stay inside 30 commands a minute, and every offer ends up open', async (t) => {
  const held = new Map(); // request id -> offer id
  const entries = Array.from({ length: 16 }, (_unused, index) => entryOf(`req_${index}`));
  const { time, host, pushes, deps } = setup(t, { entries, answers: {
    'team.model.offer': (manifest) => {
      if (!held.has(manifest.request_id)) held.set(manifest.request_id, offerIdOf(held.size + 1));
      return { ok: true, offer: { offer_id: held.get(manifest.request_id), state: 'open' } };
    },
    'team.model.offers': () => ({ ok: true, offers: [...held.values()].map(summaryOf), transfers: [] }),
  } });
  const team = createModelTeam(deps);
  team.start();
  t.after(() => team.stop());
  await time.advance(1000);
  for (let flap = 0; flap < 5; flap += 1) {
    host.setState('offline');
    team.connectionChanged();
    await time.advance(2000);
    host.setState('online');
    team.connectionChanged();
    team.connectionChanged();
    await time.advance(2000);
  }
  await time.advance(1000);
  const perMinute = Math.max(...host.sent.map((entry) => host.sent.filter((other) => other.at >= entry.at && other.at < entry.at + 60_000).length));
  assert.ok(perMinute <= 30, `${perMinute} commands in one minute: ${host.sent.map((entry) => entry.operation).join(',')}`);
  const states = lastState(pushes).outgoing.map((row) => row.state);
  assert.deepEqual(states, Array(16).fill('open'));
  assert.equal(host.sent.filter((entry) => entry.operation === 'team.model.offer').length, 16, 'each kept offer sent once');
});

test('a rate-limited offer is sent again after a delay on one timer, and the stop clears it', async (t) => {
  let refuse = true;
  const { time, pushes, deps } = setup(t, { answers: {
    'team.model.offer': () => (refuse ? { ok: false, error: { code: 'CMP-HOST-0009', reason: 'team_rate_limit' } }
      : { ok: true, offer: { offer_id: offerIdOf(1), state: 'open' } }),
  } });
  const team = createModelTeam(deps);
  team.start();
  await time.advance(10);
  const made = await call(team, 'modelOffer', { tag: 'qwen3:8b', files: [], display_name: 'Qwen three' });
  await time.advance(1000);
  assert.equal(lastState(pushes).outgoing[0].state, 'offering');
  refuse = false;
  await time.advance(20_000);
  assert.equal(lastState(pushes).outgoing.find((row) => row.request_id === made.request_id).state, 'open');
  refuse = true;
  await team.stop();
  assert.equal(team.resources().timers, 0);
});

test('an older host (unsupported_operation on the list) reads as sharing off and an offer is refused here', async (t) => {
  const { time, host, deps } = setup(t, { answers: {
    'team.model.offers': () => ({ ok: false, error: { code: 'CMP-HOST-0002', reason: 'unsupported_operation' } }),
  } });
  const team = createModelTeam(deps);
  team.start();
  t.after(() => team.stop());
  await time.advance(10);
  const state = await call(team, 'modelState');
  assert.deepEqual([state.sharing, state.sharing_reason], ['off', 'team_model_host_too_old']);
  const sent = host.sent.length;
  assert.equal((await call(team, 'modelOffer', { tag: 'qwen3:8b', files: [], display_name: 'Qwen three' })).error.reason, 'team_model_host_too_old');
  assert.equal(host.sent.length, sent, 'nothing sent');
});

test('the state push: the first change at once, then at most one per 250 ms with the last change sent', async (t) => {
  const { time, host, pushes, deps } = setup(t, { answers: {
    'team.model.offers': () => ({ ok: true, offers: [], transfers: [] }) } });
  const team = createModelTeam(deps);
  team.start();
  t.after(() => team.stop());
  await time.advance(1000);
  const before = pushes.length;
  for (let n = 1; n <= 20; n += 1) {
    host.emit({ event_type: 'team_model_offer', ...summaryOf(offerIdOf(n)), sender_member_id: OLIVE });
    await time.advance(10);
  }
  const during = pushes.slice(before).filter((push) => push.kind === 'state');
  assert.ok(during.length <= 2, `${during.length} state pushes in 200 ms`);
  await time.advance(300);
  assert.equal(lastState(pushes).incoming.length, 20, 'the last change was sent');
});

test('repeated calls share one host command and reuse an answer younger than 2 s', async (t) => {
  const { time, host, deps } = setup(t, { answers: {
    'team.model.offers': () => ({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'host_unavailable' } }),
    'team.model.offer.read': () => ({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_not_found' } }) } });
  const team = createModelTeam(deps);
  team.start();
  t.after(() => team.stop());
  await time.advance(10);
  const count = (operation) => host.sent.filter((entry) => entry.operation === operation).length;
  const before = { roster: count('team.members.list'), list: count('team.model.offers') };
  await Promise.all(Array.from({ length: 5 }, () => call(team, 'modelReceivers')));
  await Promise.all(Array.from({ length: 5 }, () => call(team, 'modelState')));
  await Promise.all(Array.from({ length: 5 }, () => call(team, 'modelOfferRead', { offer_id: offerIdOf(3) })));
  assert.deepEqual([count('team.members.list') - before.roster, count('team.model.offers') - before.list, count('team.model.offer.read')], [1, 1, 1]);
  await time.advance(1000);
  await call(team, 'modelReceivers');
  assert.equal(count('team.members.list') - before.roster, 1, 'reused within 2 s');
  await time.advance(1500);
  await call(team, 'modelReceivers');
  assert.equal(count('team.members.list') - before.roster, 2, 'asked again after 2 s');
});

test('a stop leaves nothing; a revoke through team-models ends the entry with nothing left', async (t) => {
  const { time, host, deps } = setup(t, { answers: {
    'team.model.offer': () => ({ ok: true, offer: { offer_id: offerIdOf(1), state: 'open' } }) } });
  const team = createModelTeam(deps);
  team.start();
  await time.advance(10);
  await call(team, 'modelOffer', { tag: 'qwen3:8b', files: [], display_name: 'Qwen three' });
  host.emit({ event_type: 'team_model_transfer', transfer_id: TRANSFER, offer_id: offerIdOf(1), sender_member_id: ME,
    receiver_member_id: OLIVE, state: 'paused', queued: false, reason: 'paused_by_receiver', display_name: 'Qwen three',
    bytes_done: 0, bytes_total: 4096, next: { index: 0, part: 0 } });
  await time.advance(100);
  assert.ok(team.resources().pushes === 1 && host.listeners.size === 1);
  await team.stop();
  assert.deepEqual(team.resources(), { pushes: 0, reads: 0, handles: 0, receiving: 0, timers: 0, waits: 0, listeners: 0, connecting: 0 });
  assert.equal(host.listeners.size, 0, 'the feed listener is gone');
  assert.equal(time.pending(), 0, 'no timer of the entry is left');

  const models = createTeamModels({ userDataPath: deps.userDataPath, managerOf: () => host.manager, timers: time.timers, clock: time.clock,
    sources: { list: deps.discovery, roots: () => [] } });
  t.after(() => models.stopAll());
  await models.call('modelState', { team_id: TEAM });
  assert.equal(host.listeners.size, 1);
  host.setState('revoked');
  models.connectionChanged(TEAM, host.manager);
  for (let n = 0; n < 20 && (models.resources().teams + models.resources().stopping) > 0; n += 1) await time.advance(10);
  const left = models.resources();
  assert.deepEqual({ teams: left.teams, stopping: left.stopping, timers: left.timers, waits: left.waits, listeners: left.listeners,
    pushes: left.pushes, reads: left.reads }, { teams: 0, stopping: 0, timers: 0, waits: 0, listeners: 0, pushes: 0, reads: 0 });
  assert.equal(host.listeners.size, 0);
});

test('a busy hasher is waited out with a back-off until it is taken; an abort during the wait ends it', async () => {
  let calls = 0;
  const sleeps = [];
  const retrying = busyRetrying(() => ({ hash: async () => { calls += 1; if (calls < 4) throw Object.assign(new Error('busy'), { code: 'model_hash_busy' }); return { size: 1 }; } }),
    { sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await retrying.hash('f', {}), { size: 1 });
  assert.deepEqual(sleeps, [250, 500, 1000]);
  const controller = new AbortController();
  const stuck = busyRetrying(() => ({ hash: async () => { throw Object.assign(new Error('busy'), { code: 'model_hash_busy' }); } }),
    { sleep: (_ms, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  const waiting = stuck.hash('f', { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, (error) => error.code === 'model_hash_aborted');
  await assert.rejects(busyRetrying(() => ({ hash: async () => { throw Object.assign(new Error('x'), { code: 'model_hash_failed' }); } }),
    { sleep: async () => {} }).hash('f', {}), (error) => error.code === 'model_hash_failed');
});

test('an accept is bound to its accept screen: a root path changed at the index, or a changed manifest, is refused', async (t) => {
  let note = 'first';
  const offer = { offer_id: offerIdOf(7), sender_member_id: OLIVE, audience: 'member', display_name: 'Qwen three', files: 1,
    total_bytes: 4096, state: 'open' };
  const { base, time, host, deps } = setup(t, { answers: {
    'team.model.offer.read': () => ({ ok: true, offer, manifest: { request_id: 'req_seven', audience: { kind: 'member', member_id: ME },
      display_name: 'Qwen three', files: [{ name: MAIN, size: 4096, sha256: 'a'.repeat(64), segments: ['a'.repeat(64)] }],
      provenance: { licence: '', source_url: null, note } } }) } });
  const rootA = path.join(base, 'root-a');
  const rootB = path.join(base, 'root-b');
  let rootList = [{ path: rootA, display: rootA }];
  const team = createModelTeam({ ...deps, roots: () => rootList });
  team.start();
  t.after(() => team.stop());
  await time.advance(10);
  const read = await call(team, 'modelOfferRead', { offer_id: offerIdOf(7) });
  assert.deepEqual(read.roots.map((root) => root.display_path), [rootA]);
  rootList = [{ path: rootB, display: rootB }];
  assert.equal((await call(team, 'modelAccept', { offer_id: offerIdOf(7), root_index: 0 })).error.reason, 'model_root_invalid');
  rootList = [{ path: rootA, display: rootA }];
  note = 'changed';
  assert.equal((await call(team, 'modelAccept', { offer_id: offerIdOf(7), root_index: 0 })).error.reason, 'model_manifest_invalid');
  assert.equal(host.sent.some((entry) => entry.operation === 'team.model.accept'), false, 'nothing reached the host');
  assert.equal(fs.existsSync(rootB), false, 'the changed root was never made');
});

// ---- Review round two (R14) ------------------------------------------------------------------------------------

const MANIFEST = Object.freeze({ request_id: 'req_seven', audience: { kind: 'member', member_id: ME }, display_name: 'Qwen three',
  files: [{ name: MAIN, size: 5000, sha256: 'a'.repeat(64), segments: ['a'.repeat(64)] }], provenance: { licence: '', source_url: null, note: '' } });
const SUMMARY = Object.freeze({ offer_id: offerIdOf(7), sender_member_id: OLIVE, audience: 'member', display_name: 'Qwen three', files: 1,
  total_bytes: 5000, state: 'open' });

// Staging for SUMMARY under `root` as a restart finds it: a journal (last written `at`) and one part.
function stageRestart(root, at = Date.now()) {
  const id = journals.transferIdFor({ teamId: TEAM, senderId: OLIVE, manifest: MANIFEST });
  const staging = path.join(root, journals.INCOMING_DIR, id);
  fs.mkdirSync(staging, { recursive: true });
  const offer = { offerId: SUMMARY.offer_id, teamId: TEAM, sender: { memberId: OLIVE, displayName: 'Olive Owner' }, manifest: MANIFEST };
  journals.writeJournal(staging, journals.newJournal({ id, offer, folder: 'Qwen3-8B', segmentBytes: 1024 ** 3, now: at }), { maxBytes: 80 * 1024 });
  fs.writeFileSync(path.join(staging, '0.part'), Buffer.alloc(4096, 7));
  return staging;
}

function incomingFor(t, rootList, { answers = {}, defaultRoot = null } = {}) {
  const sent = [];
  const incoming = createModelIncoming({
    teamId: TEAM, hasher: { hash: async () => { throw new Error('unused'); } },
    transport: { accept: async () => {}, resume: async () => {}, takePart: async () => {}, pause: async () => {}, cancel: async () => {}, complete: async () => {} },
    roots: () => rootList(), discovery: async () => [], self: () => ({ memberId: ME, displayName: 'Mika Member' }), nameOf: () => 'Olive Owner',
    ...(defaultRoot ? { defaultRoot } : {}),
    command: async (operation, params) => {
      sent.push(operation);
      if (answers[operation]) return answers[operation](params);
      return operation === 'team.model.offer.read' ? { ok: true, offer: SUMMARY, manifest: MANIFEST } : { ok: true };
    },
  });
  t.after(() => incoming.dispose());
  return { incoming, sent };
}

test('R14-F02: Cancel and Decline on a take found after a restart remove its staging and journal, or answer an error', async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-r14-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const how of ['modelReceiveCancel', 'modelDecline', 'root gone', 'root gone, decline']) {
    const root = path.join(base, how.replace(/\W+/gu, '-'));
    fs.mkdirSync(root);
    const staging = stageRestart(root);
    let rootList = [{ path: root, display: root }];
    const { incoming, sent } = incomingFor(t, () => rootList);
    await incoming.probe([SUMMARY]);
    assert.equal(incoming.takeOf(SUMMARY.offer_id)?.state, 'interrupted', how);
    if (how.startsWith('root gone')) {
      rootList = [];
      // X6b-F07: Decline too stops at the refusal (model-incoming.js decline): nothing is sent and the row stays.
      const refused = how === 'root gone' ? await incoming.cancel(SUMMARY.offer_id) : await incoming.decline(SUMMARY.offer_id);
      assert.equal(refused.error?.reason, 'model_root_invalid', `${how}: an error, never a quiet ok`);
      assert.deepEqual([fs.existsSync(staging), incoming.takeOf(SUMMARY.offer_id)?.state], [true, 'interrupted'], `${how}: kept, still listed`);
      assert.equal(sent.includes('team.model.decline'), false, `${how}: nothing sent to the host`);
      continue;
    }
    const answer = how === 'modelDecline' ? await incoming.decline(SUMMARY.offer_id) : await incoming.cancel(SUMMARY.offer_id);
    assert.deepEqual(answer, { ok: true }, how);
    assert.equal(fs.existsSync(staging), false, `${how} removes the staging folder and its journal`);
    assert.equal(incoming.takeOf(SUMMARY.offer_id), null, how);
    assert.equal(sent.includes('team.model.decline'), how === 'modelDecline', how);
  }
});

// X6b-F07: the discard's own link check (model-receive-sweep.js discard): a staging folder replaced by a junction after
// the restart is refused, never read, rolled back or removed through the link.
test('R14-F02: Cancel and Decline of a take whose staging folder became a junction are refused and touch nothing', async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-r14-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const how of ['cancel', 'decline']) {
    const root = path.join(base, how);
    fs.mkdirSync(root);
    const staging = stageRestart(root);
    const { incoming, sent } = incomingFor(t, () => [{ path: root, display: root }]);
    await incoming.probe([SUMMARY]);
    assert.equal(incoming.takeOf(SUMMARY.offer_id)?.state, 'interrupted', how);
    const elsewhere = path.join(base, `elsewhere-${how}`);
    fs.renameSync(staging, elsewhere);
    fs.symlinkSync(elsewhere, staging, 'junction');
    const before = fs.readdirSync(elsewhere).sort();
    const answer = await incoming[how](SUMMARY.offer_id);
    assert.equal(answer.error?.reason, 'model_destination_invalid', `${how}: ${JSON.stringify(answer)}`);
    assert.deepEqual([fs.lstatSync(staging).isSymbolicLink(), fs.readdirSync(elsewhere).sort()], [true, before], `${how}: nothing touched`);
    assert.equal(incoming.takeOf(SUMMARY.offer_id)?.state, 'interrupted', `${how}: the row stays`);
    assert.equal(sent.includes('team.model.decline'), false, `${how}: nothing sent to the host`);
  }
});

test('R14-F06: an accept with no remembered accept screen is refused and nothing reaches the host', async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-r14-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { incoming, sent } = incomingFor(t, () => [{ path: base, display: base }]);
  assert.equal((await incoming.accept(SUMMARY.offer_id, 0)).error.reason, 'model_manifest_invalid');
  assert.deepEqual([sent.includes('team.model.accept'), fs.readdirSync(base)], [false, []]);
});

test('R14-F08: accept makes only the default root; another missing root is model_root_invalid and is not made', async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-r14-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const library = path.join(base, 'library');
  const defaultRoot = path.join(base, 'models');
  const { incoming, sent } = incomingFor(t, () => [{ path: defaultRoot, display: defaultRoot }, { path: library, display: library }], { defaultRoot });
  await incoming.offerRead(SUMMARY.offer_id, null);
  assert.equal((await incoming.accept(SUMMARY.offer_id, 1)).error.reason, 'model_root_invalid');
  assert.deepEqual([fs.existsSync(library), sent.includes('team.model.accept')], [false, false], 'the missing library root was not made');
  await incoming.offerRead(SUMMARY.offer_id, null);
  await incoming.accept(SUMMARY.offer_id, 0);
  assert.equal(fs.statSync(defaultRoot).isDirectory(), true, 'the default root is made');
});

test('R14-F04: staging is swept at the first model call even when no team entry is built (sharing off, no team)', async (t) => {
  for (const shape of [{ enabled: () => false }, { managerOf: () => null }]) {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-r14-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const time = fakeTime();
    const staging = stageRestart(base, time.clock() - 8 * 24 * 60 * 60 * 1000);
    const models = createTeamModels({ userDataPath: base, managerOf: () => null, timers: time.timers, clock: time.clock,
      sources: { list: async () => [], roots: () => [{ path: base, display: base }] }, ...shape });
    const answer = await models.call('modelState', { team_id: TEAM });
    assert.equal(answer.ok, false);
    await models.stopAll();
    assert.equal(fs.existsSync(staging), false, 'the 8-day-old staging is gone');
    assert.equal(models.resources().teams, 0, 'no entry was built');
  }
});

test('an accept the host refused is answered only once its fresh staging is cancelled: the slot is free the moment the call returns', async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-claim-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'models');
  fs.mkdirSync(root);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const incoming = createModelIncoming({
    teamId: TEAM, hasher: { hash: async () => { throw new Error('unused'); } },
    transport: { accept: async () => { calls.push('accept'); throw Object.assign(new Error('offline'), { code: 'team_model_sender_offline' }); },
      resume: async () => {}, takePart: async () => {}, pause: async () => {}, complete: async () => {},
      cancel: async () => { calls.push('cancel'); await gate; } },
    roots: () => [{ path: root, display: root }], discovery: async () => [], self: () => ({ memberId: ME, displayName: 'Mika Member' }),
    nameOf: () => 'Olive Owner',
    command: async (operation) => (operation === 'team.model.offer.read' ? { ok: true, offer: SUMMARY, manifest: MANIFEST } : { ok: true }),
  });
  t.after(() => { release(); return incoming.dispose(); });
  await incoming.offerRead(SUMMARY.offer_id, null);
  let answered = null;
  const first = incoming.accept(SUMMARY.offer_id, 0).then((answer) => { answered = answer; return answer; });
  await flush();
  assert.deepEqual(calls, ['accept', 'cancel'], 'the receiver is cancelling the fresh staging');
  assert.equal(answered, null, 'the call does not answer, or give its claim back, while the cancel is still running');
  release();
  assert.equal((await first).error?.reason, 'team_model_sender_offline');
  // The receiver is free at once: a second accept reaches the host instead of answering busy.
  await incoming.offerRead(SUMMARY.offer_id, null);
  assert.notEqual((await incoming.accept(SUMMARY.offer_id, 0)).error?.reason, 'model_receiver_busy');
});

// ---- Team fixes M: a receive whose offer ended, a restart's byte count, quiet row changes ------------------------

function incomingHeld(t, root, { onChange = () => {}, onProgress = () => {}, receiveLimits = {}, takePart = () => new Promise(() => {}) } = {}) {
  const incoming = createModelIncoming({
    teamId: TEAM, hasher: { hash: async () => { throw new Error('unused'); } }, receiveLimits, onChange, onProgress,
    transport: { accept: async () => {}, resume: async () => {}, takePart, pause: async () => {}, cancel: async () => {}, complete: async () => {} },
    roots: () => [{ path: root, display: root }], discovery: async () => [], self: () => ({ memberId: ME, displayName: 'Mika Member' }),
    nameOf: () => 'Olive Owner', command: async (operation, params) => (operation === 'team.model.offer.read'
      ? { ok: true, offer: { ...SUMMARY, offer_id: params.offer_id }, manifest: MANIFEST } : { ok: true }),
  });
  t.after(() => incoming.dispose());
  return incoming;
}

test('M1: a paused receive whose offer ended stays as a withdrawn row and holds the receiver until Dismiss', async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-m1-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const incoming = incomingHeld(t, base);
  const second = offerIdOf(8);
  await incoming.offerRead(SUMMARY.offer_id, null);
  assert.deepEqual(await incoming.accept(SUMMARY.offer_id, 0), { ok: true });
  assert.deepEqual(await incoming.pause(SUMMARY.offer_id), { ok: true });
  assert.equal(incoming.takeOf(SUMMARY.offer_id).state, 'paused');
  incoming.offerEnded(SUMMARY.offer_id);
  incoming.offerEnded(SUMMARY.offer_id); // a second word of the same end changes nothing
  const take = incoming.takeOf(SUMMARY.offer_id);
  assert.deepEqual([take?.state, take?.reason], ['failed', 'withdrawn'], 'the take stays, failed as withdrawn');
  for (const [word, kept] of [['expired', 'expired'], ['member_gone', 'member_gone'], ['fulfilled', 'withdrawn']]) {
    const other = incomingHeld(t, fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'end-'))));
    await other.offerRead(SUMMARY.offer_id, null);
    await other.accept(SUMMARY.offer_id, 0);
    await other.pause(SUMMARY.offer_id);
    other.offerEnded(SUMMARY.offer_id, word);
    assert.equal(other.takeOf(SUMMARY.offer_id).reason, kept, 'the row says what ended the offer: ' + word);
  }
  await incoming.offerRead(second, null);
  assert.equal((await incoming.accept(second, 0)).error?.reason, 'model_receiver_busy', 'held until the member dismisses it');
  assert.deepEqual(await incoming.cancel(SUMMARY.offer_id), { ok: true }, 'Dismiss runs the cancel path');
  assert.equal(incoming.takeOf(SUMMARY.offer_id), null);
  await incoming.offerRead(second, null);
  assert.notEqual((await incoming.accept(second, 0)).error?.reason, 'model_receiver_busy', 'the receiver is free after Dismiss');
});

test('M1: a restart-found take whose offer ends is withdrawn, not dropped, and the team keeps the offer listed until Dismiss', async (t) => {
  let listed = true;
  const { base, time, host, pushes, deps } = setup(t, { answers: {
    'team.model.offers': () => ({ ok: true, offers: listed ? [SUMMARY] : [], transfers: [] }),
    'team.model.offer.read': () => ({ ok: true, offer: SUMMARY, manifest: MANIFEST }) } });
  const root = path.join(base, 'incoming-root');
  fs.mkdirSync(root);
  const staging = stageRestart(root);
  const team = createModelTeam({ ...deps, roots: () => [{ path: root, display: root }] });
  t.after(() => team.stop());
  team.start();
  await time.advance(400);
  const row = () => lastState(pushes).incoming.find((entry) => entry.offer_id === SUMMARY.offer_id);
  assert.equal(row().transfer.state, 'interrupted', 'found at the restart');
  listed = false;
  host.emit({ event_type: 'resync_required' });
  await time.advance(300);
  assert.deepEqual([row()?.state, row()?.transfer?.state, row()?.transfer?.reason], ['ended', 'failed', 'withdrawn'], 'still listed, withdrawn');
  assert.equal(fs.existsSync(staging), true, 'what had arrived is kept until Dismiss');
  host.emit({ event_type: 'resync_required' });
  await time.advance(300);
  assert.equal(row()?.transfer?.state, 'failed', 'a second list without the offer keeps the row too');
  assert.deepEqual(await call(team, 'modelReceiveCancel', { offer_id: SUMMARY.offer_id }), { ok: true });
  assert.equal(fs.existsSync(staging), false, 'Dismiss removed the staging');
  host.emit({ event_type: 'resync_required' });
  await time.advance(300);
  assert.equal(row(), undefined, 'the offer goes once its take is gone');
});

test('M2: a take found after a restart carries the verified bytes of its journal', async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-m2-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const staging = stageRestart(base);
  const id = path.basename(staging);
  const journal = journals.readJournal(staging, { id, segmentBytes: 1024 ** 3, maxBytes: 80 * 1024 }).journal;
  journal.files[0].verified_segments = 1;
  journals.writeJournal(staging, journal, { maxBytes: 80 * 1024 });
  const { incoming } = incomingFor(t, () => [{ path: base, display: base }]);
  await incoming.probe([SUMMARY]);
  assert.deepEqual([incoming.takeOf(SUMMARY.offer_id)?.state, incoming.takeOf(SUMMARY.offer_id)?.bytes_done], ['interrupted', 5000]);
  // A journal that does not read leaves the count at 0, never throws.
  fs.writeFileSync(path.join(staging, journals.JOURNAL_NAME), '{');
  const { incoming: broken } = incomingFor(t, () => [{ path: base, display: base }]);
  await broken.probe([SUMMARY]);
  assert.equal(broken.takeOf(SUMMARY.offer_id)?.bytes_done, 0);
});

test('M7: a receive tells the row list only when its state or reason changes; its bytes travel as progress', async (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-m7-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  let changes = 0;
  let progress = 0;
  let parts = 0;
  const takePart = ({ offset }) => (++parts <= 4 ? Promise.resolve(Buffer.alloc(1000, offset)) : new Promise(() => {}));
  const incoming = incomingHeld(t, base, { takePart, onChange: () => { changes += 1; }, onProgress: () => { progress += 1; },
    receiveLimits: { partBytes: 1000, segmentBytes: 5000, progressIntervalMs: 0 } });
  await incoming.offerRead(SUMMARY.offer_id, null);
  assert.deepEqual(await incoming.accept(SUMMARY.offer_id, 0), { ok: true });
  for (let i = 0; i < 200 && parts <= 4; i += 1) await new Promise((done) => setTimeout(done, 10)); // the fifth part is asked for: four arrived
  await flush();
  assert.ok(progress >= 3, `${progress} progress events for 4 parts`);
  const before = changes;
  assert.ok(before <= 3, `${before} list changes while 4 parts arrived`);
  assert.equal(incoming.takeOf(SUMMARY.offer_id).state, 'pulling');
});
