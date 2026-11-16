'use strict';

// End-to-end model sharing in one process (row 123 slice 6-5): the REAL team host HTTP listener with the REAL relay,
// part routes and member-stream presence (tests/server/helpers/team-http-fixture.js `models`), and members whose
// REAL team-models.js runs over the REAL member HTTP client, session and event feed. Only the two bridges are stood
// in for: a loopback proxy per member device reads the member preamble and opens the host side with that device's
// host preamble, as the real pair does; `cut()` drops every connection it carries (a link loss on that side). Files
// are real, in temp model roots, listed by the REAL discovery scan. The part size is small (16 KiB) on both sides;
// the segment size stays 1 GiB (6-1's validator pins it), so each test file is one segment.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { MODEL_TRANSFER_LIMITS } = require('../../server/team/model-manifest');
const { createTeamModelSharing } = require('../../server/team/model-sharing');
const { encodeHostPreamble } = require('../../server/team/transport/preamble');
const { createEventFeed } = require('../../services/team/event-feed');
const { createTeamHttp } = require('../../services/team/http-client');
const { createTeamSession } = require('../../services/team/team-session');
const { createTeamModels } = require('../../services/team/team-models');
const { registerLlamaServerIpcHandlers } = require('../../services/main/llama-server-ipc-handlers');
const { createTeamHttpFixture, waitUntil } = require('../server/helpers/team-http-fixture');
const { makeBytes } = require('./team-model-receive-fixture');

const PART = 16 * 1024;
const MEMBER_PREAMBLE_BYTES = 40;
const MODEL_SET = Object.freeze([
  { name: 'Qwen3-8B-Q4_K_M.gguf', size: 9 * PART + 1234 },
  { name: 'mmproj-Qwen3-8B-F16.gguf', size: 2 * PART + 77 },
  { name: 'mtp-Qwen3-8B-Q8_0.gguf', size: 3 * PART },
]);

// A loopback stand-in for one device's member bridge and the host bridge behind it.
async function deviceProxy(env, deviceKey) {
  const keyBytes = Buffer.from(deviceKey, 'base64url');
  const pairs = new Set();
  // `cutAfter(n)`: the next answer bytes from the host are cut after n bytes (a cut in the middle of a part's body).
  let cutAt = null;
  const server = net.createServer((inbound) => {
    inbound.on('error', () => {});
    let head = Buffer.alloc(0);
    const pair = { inbound, outbound: null };
    pairs.add(pair);
    // A call aborted at once may close before its preamble is through: it leaves the count then too.
    inbound.once('close', () => { pair.outbound?.destroy(); pairs.delete(pair); });
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      if (head.length < MEMBER_PREAMBLE_BYTES) return;
      inbound.off('data', onData);
      const outbound = net.connect({ host: '127.0.0.1', port: env.port });
      pair.outbound = outbound;
      outbound.on('error', () => {});
      outbound.write(encodeHostPreamble(env.bootSecret, keyBytes));
      outbound.write(head.subarray(MEMBER_PREAMBLE_BYTES));
      inbound.pipe(outbound);
      outbound.on('data', (chunk) => {
        if (cutAt !== null) {
          cutAt -= chunk.length;
          if (cutAt <= 0) { cutAt = null; inbound.destroy(); outbound.destroy(); pairs.delete(pair); return; }
        }
        if (!inbound.destroyed) inbound.write(chunk);
      });
      const end = () => { inbound.destroy(); outbound.destroy(); pairs.delete(pair); };
      inbound.once('close', end);
      outbound.once('close', end);
    };
    inbound.on('data', onData);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    cut() { for (const pair of [...pairs]) { pair.inbound.destroy(); pair.outbound?.destroy(); pairs.delete(pair); } },
    cutAfter(bytes) { cutAt = bytes; },
    sockets: () => pairs.size,
    close: () => new Promise((resolve) => { for (const pair of pairs) { pair.inbound.destroy(); pair.outbound?.destroy(); } server.close(resolve); }),
  };
}

// A connection manager over the real session and event feed: online once the event stream is open.
async function memberManager(env, seat, { role }) {
  const proxy = await deviceProxy(env, seat.key);
  const feed = createEventFeed();
  let http = null;
  let link = null;
  let online = false;
  let stream = null;
  const changes = new Set();
  let listeners = 0;
  const hooks = { getModelPart: null, putModelPart: null };
  const notify = () => { for (const listener of [...changes]) listener(); };

  function newLink() {
    http = createTeamHttp({ port: proxy.port, launchSecret: crypto.randomBytes(32) });
    const session = createTeamSession({ http, appVersion: '1.7.0' });
    const hooked = Object.create(session, {
      getModelPart: { value: (client, args) => (hooks.getModelPart ? hooks.getModelPart(session, client, args) : session.getModelPart(client, args)) },
      putModelPart: { value: (client, args) => (hooks.putModelPart ? hooks.putModelPart(session, client, args) : session.putModelPart(client, args)) },
    });
    link = { session: hooked, client: null, registering: null };
  }
  async function ensureClient(target) {
    if (target.client) return null;
    target.registering ??= (async () => {
      const boot = await target.session.bootstrap();
      if (!boot.ok) return boot;
      const registered = await target.session.registerClient();
      if (!registered.ok) return registered;
      target.client = { client_id: registered.client_id, client_token: registered.client_token, bootEpoch: boot.boot_epoch };
      return null;
    })().finally(() => { target.registering = null; });
    return target.registering;
  }
  async function connect() {
    newLink();
    const target = link;
    const blocked = await ensureClient(target);
    if (blocked) throw new Error(`register failed: ${blocked.error.reason}`);
    stream = await target.session.openEvents(target.client, { lastEventId: feed.lastEventId(), onFrame: (frame) => feed.accept(frame),
      onProtocolError: () => {} });
    if (stream.status !== 200) throw new Error('events refused');
    online = true;
    notify();
  }
  const manager = {
    snapshot: () => ({ state: online ? 'online' : 'offline', member_state: 'active', member_id: seat.member_id,
      display_name: seat.display_name, role, team_name: 'Team' }),
    borrow: () => ({ link, ensureClient, online }),
    async command(operation, params) {
      if (!online || !link) return { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };
      const blocked = await ensureClient(link);
      if (blocked) return blocked;
      return link.session.command(operation, params, { client: link.client, bootEpoch: link.client.bootEpoch });
    },
    onEvent: (listener) => { listeners += 1; const off = feed.onEvent(listener); return () => { listeners -= 1; off(); }; },
    resources: () => ({ bridges: 0, timers: 0, sockets: proxy.sockets(), streams: stream ? 1 : 0 }),
  };
  const member = {
    manager, proxy, hooks, seat, listeners: () => listeners,
    onChange(listener) { changes.add(listener); return () => changes.delete(listener); },
    connect,
    // The link drops on this side: every connection cut, offline until `connect()`.
    drop() { online = false; stream?.close(); stream = null; proxy.cut(); http?.dispose(); notify(); },
    async stop() { online = false; stream?.close(); http?.dispose(); feed.close(); await proxy.close(); },
  };
  return member;
}

function makeModelDir(root, set = MODEL_SET, { folder = 'Qwen3-8B-Q4_K_M', seed = 'qwen', gguf = true } = {}) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = set.map((spec, index) => makeBytes(spec.size, `${seed}:${spec.name}:${index}`, { gguf }));
  set.forEach((spec, index) => fs.writeFileSync(path.join(dir, spec.name), bytes[index]));
  return { dir, bytes };
}

// The real discovery scan with `root` as a library root: the listing Settings > Models shows.
function realDiscovery(root, base) {
  const registered = registerLlamaServerIpcHandlers({ handle: () => {}, on() {} }, {
    getManager: () => null, userDataPath: path.join(base, 'user-data'), repoRoot: path.join(base, 'repo'), getLibraryRoots: () => [root],
  });
  return () => registered.listLocalGgufs();
}

// One member's Jenny: a profile, a model root, its discovery scan and its team-models over the real link.
async function memberJenny(t, env, seat, { role, label, sharing = {} }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-model-e2e-${label}-`));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'models');
  fs.mkdirSync(root);
  const realRoot = fs.realpathSync.native(root);
  const member = await memberManager(env, seat, { role });
  t.after(() => member.stop());
  const pushes = [];
  const logs = [];
  const answers = [];
  const list = realDiscovery(realRoot, base);
  const jenny = {
    base, root: realRoot, member, pushes, logs, answers, list, models: null, profile: path.join(base, 'profile'),
    ready: null,
    // A Jenny start (or restart over the same disk): a new team-models over the same profile and roots.
    build({ clock, isHeld, timers, ...options } = {}) {
      jenny.models = createTeamModels({
        userDataPath: jenny.profile, managerOf: () => member.manager, enabled: () => true,
        ...(clock ? { clock } : {}), ...(isHeld ? { isHeld } : {}), ...(timers ? { timers } : {}),
        sources: { list, roots: () => [{ path: realRoot, display: realRoot }] },
        push: (payload) => pushes.push({ ...JSON.parse(JSON.stringify(payload)), ...(clock ? { at: clock() } : {}) }),
        log: (level, event, fields) => logs.push({ level, event, fields: fields ?? {} }),
        options: { partBytes: PART, ...sharing, ...options },
      });
      const off = member.onChange(() => jenny.models?.connectionChanged(env.teamId, member.manager));
      const models = jenny.models;
      t.after(async () => { off(); await models.stopAll(); });
      // The renderer's first call for the team builds its entry (nothing is built before a model call).
      jenny.ready = jenny.call('modelState');
      return models;
    },
    call: async (method, payload = {}) => {
      const answer = await jenny.models.call(method, { team_id: env.teamId, ...payload });
      answers.push({ method, answer: JSON.parse(JSON.stringify(answer)) });
      return answer;
    },
    state: async () => jenny.call('modelState'),
  };
  fs.mkdirSync(jenny.profile, { recursive: true });
  return jenny;
}

// The host with model sharing on, the seeded members (owner, member, read-only) and a second full member.
async function modelE2eEnv(t, { relayLimits = {} } = {}) {
  const env = await createTeamHttpFixture(t, {
    models: (inputs) => createTeamModelSharing({ ...inputs, limits: { ...MODEL_TRANSFER_LIMITS, partBytes: PART, ...relayLimits } }),
  });
  const seeded = await env.seed();
  const bea = await env.redeemDirect({ actor: seeded.owner.member_id, role: 'member', name: 'Bea Member' });
  await env.store.admit({ actorMemberId: seeded.owner.member_id, memberId: bea.member_id });
  env.teamId = env.store.teamId();
  const seat = (made, name) => ({ ...made, display_name: name });
  return {
    env, seats: { owner: seat(seeded.owner, 'Olive Owner'), member: seat(seeded.member, 'Mika Member'),
      reader: seat(seeded.readOnly, 'Rui Reader'), bea: seat(bea, 'Bea Member') },
  };
}

// Waits for `check()` to hold; a timeout fails the test.
async function until(check, { ms = 30_000 } = {}) {
  if (!await waitUntil(check, { attempts: Math.ceil(ms / 20), interval: 20 })) throw new Error('timed out waiting');
  return true;
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const states = (jenny) => jenny.pushes.filter((push) => push.kind === 'state');
const lastState = (jenny) => states(jenny).at(-1) || null;
const received = (jenny) => jenny.pushes.filter((push) => push.kind === 'received');

// Records every host operation a member's manager sends.
function recordCommands(jenny) {
  const sent = [];
  const command = jenny.member.manager.command;
  jenny.member.manager.command = (operation, params) => { sent.push(operation); return command(operation, params); };
  return sent;
}

// A sender (Mika, member) and a receiver (Olive, owner by default), both online with their entries built.
async function pair(t, { receiverSeat = 'owner', receiverRole = 'owner', options = {} } = {}) {
  const { env, seats } = await modelE2eEnv(t);
  const sender = await memberJenny(t, env, seats.member, { role: 'member', label: 'sender' });
  const receiver = await memberJenny(t, env, seats[receiverSeat], { role: receiverRole, label: 'receiver' });
  const source = makeModelDir(sender.root);
  await sender.member.connect();
  await receiver.member.connect();
  sender.build(options.sender);
  receiver.build(options.receiver);
  await Promise.all([sender.ready, receiver.ready]);
  return { env, seats, sender, receiver, source };
}

async function offer(sender, { memberId = null, files = null } = {}) {
  const [model] = (await sender.call('modelSendable')).models;
  const listed = await sender.call('modelFiles', { tag: model.tag });
  const answer = await sender.call('modelOffer', { tag: model.tag, files: files ?? listed.files.map((file) => file.name),
    ...(memberId ? { member_id: memberId } : {}), display_name: 'Qwen three', licence: 'Apache-2.0',
    source_url: 'https://example.test/qwen', note: 'From my library' });
  if (answer.ok !== true) throw new Error(`offer refused: ${JSON.stringify(answer)}`);
  await until(() => lastState(sender)?.outgoing.find((row) => row.request_id === answer.request_id)?.state === 'open');
  return answer.request_id;
}

async function incomingOffer(receiver) {
  await until(() => lastState(receiver)?.incoming.some((row) => row.state === 'open'));
  return lastState(receiver).incoming.find((row) => row.state === 'open').offer_id;
}

// The answers that may name files, hashes and licence text (the accept screen, the files list, a provenance).
const DETAIL_METHODS = new Set(['modelOfferRead', 'modelFiles', 'modelProvenance']);

// Nothing in a push, an answer (but the three detail answers) or a log carries a path (the profile, the base and
// model folders, the family folder), a file name, a hash, licence text, a URL or a note; a log carries no display
// name either (decisions 10, 12). Run from every end-to-end test, on both sides. The family folder's name is also the
// model's discovery tag, which the design carries in a row's `tag` (and a sendable row's `name`): those two fields are
// left out of the scan, nothing else is.
function assertRedacted(jenny, source) {
  const paths = [jenny.base, jenny.profile, jenny.root, ...(source ? [source.dir] : [])];
  const words = [...MODEL_SET.map((spec) => spec.name), 'Qwen3-8B-Q4_K_M', ...(source ? source.bytes.map(sha) : []),
    'Apache-2.0', 'example.test', 'From my library'];
  const markers = [...new Set([...paths, ...paths.map((dir) => dir.replaceAll('\\', '\\\\')), ...words])];
  const withoutTags = (value) => JSON.stringify(value, (key, field) => (key === 'tag' || key === 'name' ? undefined : field));
  const pushes = withoutTags(jenny.pushes);
  const answers = withoutTags(jenny.answers.filter((entry) => !DETAIL_METHODS.has(entry.method)));
  const logs = JSON.stringify(jenny.logs);
  for (const marker of markers) {
    if (pushes.includes(marker)) throw new Error(`a push carries ${marker}`);
    if (answers.includes(marker)) throw new Error(`an answer carries ${marker}`);
    if (logs.includes(marker)) throw new Error(`a log carries ${marker}`);
  }
  for (const name of ['Mika Member', 'Olive Owner', 'Bea Member', 'Rui Reader', 'Qwen three']) {
    if (logs.includes(name)) throw new Error(`a log carries ${name}`);
  }
}

module.exports = {
  MODEL_SET, PART, assertRedacted, incomingOffer, lastState, makeModelDir, memberJenny, modelE2eEnv, offer, pair,
  received, recordCommands, sha, states, until,
};
