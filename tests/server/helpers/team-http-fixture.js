'use strict';

// Shared setup for the team HTTP layer tests: the real preamble listener and
// team HTTP server over a real member store in a temporary profile, the shared
// host composition around the fake backend, and a raw client that writes the
// 72-byte preamble itself and then speaks HTTP. No native library, no sidecar.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');

const { command } = require('../../helpers/command-router-fixture');
const { loadHostConfig } = require('../../../server/config');
const { ClientRegistry } = require('../../../server/client-registry');
const { ControlLeases } = require('../../../server/control-leases');
const { createHostCore } = require('../../../server/host-core');
const { createAuthorizer } = require('../../../server/team/authorize');
const { createInviteService } = require('../../../server/team/invites');
const { MemberStore } = require('../../../server/team/member-store');
const { createTeamCommands } = require('../../../server/team/team-commands');
const { createTeamListener, TEAM_HOST } = require('../../../server/team/team-http-server');
const { chatRoster, createTeamChatHost } = require('../../../services/host/team-chat-host');
const { encodeHostPreamble } = require('../../../server/team/transport/preamble');
const { LOCAL_COMMAND } = require('../../../server/team/member-schema');
const { createTeamHostFixture, randomKey } = require('./team-host-fixture');

function randomPublicKey() {
  return randomKey();
}

// A controllable clock shared by the store and the directory.
function createClock(start = 1_800_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  return clock;
}

async function createTeamHttpFixture(t, {
  clock = createClock(), beforeRedeem = null, resourceLimits = null, withChat = false, chatTimers = null,
  dropKeyFails = false, chatStoreLimits = null, chatStoreYield = null, beforeChat = null, models: buildModels = null,
} = {}) {
  const fx = createTeamHostFixture(t);
  const config = loadHostConfig(fx.configPath);
  const logs = fx.logs;
  const store = new MemberStore({ userDataPath: fx.profile, hostPublicKey: fx.hostPublicKey, teamName: fx.teamName,
    clock, logger: fx.logger });
  const opened = store.open();
  if (!opened.ok) throw new Error(`store open failed: ${opened.error.reason}`);
  const clients = new ClientRegistry({ capacity: 64, perDeviceCapacity: 4 });
  const leases = new ControlLeases();
  // As team-main.js wires it: a conversation's project from the host's own session index.
  let core = null;
  let chat = null;
  const { authorize, sessionScope } = createAuthorizer({ directory: store.directory,
    sessionProject: (id) => core?.composition?.backend?.sessionStore?.peekSessionSummary?.(id)?.project_id ?? null,
    dmParticipants: (channelId) => chat?.store?.participantsOf(channelId) });
  const realInvites = createInviteService({ store, logger: fx.logger });
  const redeemCalls = [];
  const invites = { ...realInvites, redeem: async (input) => {
    redeemCalls.push({ inviteId: input.inviteId });
    if (beforeRedeem) beforeRedeem();
    return realInvites.redeem(input);
  } };
  // Slice 2a-3a: the chat host and the team commands, composed as team-main.js does. `beforeChat`
  // may write chat files on the profile first (a channel this host has not loaded yet).
  if (withChat && beforeChat) await beforeChat(fx.profile);
  chat = withChat ? createTeamChatHost({ profileDir: fx.profile, directory: store.directory, clock,
    logger: fx.logger, publish: (type, payload, options) => core.events.publish(type, payload, options),
    roster: chatRoster(store), ...(chatTimers ? { timers: chatTimers } : {}),
    ...(chatStoreLimits ? { storeLimits: chatStoreLimits } : {}), ...(chatStoreYield ? { storeYield: chatStoreYield } : {}) }) : null;
  // Slice 6-3: model sharing, composed as team-main.js does (commands, part routes, stream presence, hooks).
  const models = buildModels ? buildModels({ store, authorize, logger: fx.logger, clock,
    publish: (type, payload, options) => core.events.publish(type, payload, options) }) : null;
  const teamCommands = withChat || models ? createTeamCommands({ store, invites: realInvites, directory: store.directory,
    clock, logger: fx.logger, chat: chat?.commands ?? null, models: models?.commands ?? null }) : undefined;
  core = createHostCore({ config, clients, leases, authorize, guardRequired: true, maxEventClients: 64,
    logger: fx.logger, createBackend: fx.createBackend, teamCommands, sessionScope });
  if (chat) await chat.start();
  const modelUnsubscribes = models ? models.attach() : [];
  const bootSecret = crypto.randomBytes(32);
  const dropped = [];
  const notified = [];
  let ready = true;
  const memberStreamCalls = [];
  const context = Object.freeze({
    config, bootEpoch: core.bootEpoch, bootSecret, store, directory: store.directory, invites, authorize, clients,
    leases, events: core.events, router: core.router,
    assetRoutes: models ? async (ctx) => await core.assetRoutes(ctx) || await models.routes(ctx) : core.assetRoutes,
    resourceLimits: { ...config.resourceLimits, ...(resourceLimits || {}) }, isReady: () => ready,
    addresses: () => ['192.0.2.7:4242'],
    dropKey: (key) => { dropped.push(key); if (dropKeyFails) throw new Error('bridge_down'); return 0; },
    notifyMembership: (kind, memberId) => { notified.push({ kind, member_id: memberId }); },
    logger: fx.logger, sessionScope,
    // Slice 2a-3b: presence hears each member stream, as team-main wires it.
    // Every call is recorded, so a test can show a refused stream reports nothing.
    // Chat and model sharing (slice 6-3) each hear every call when both are set.
    ...(chat || models ? { onMemberStream: (...args) => {
      memberStreamCalls.push(args);
      for (const hook of [chat, models]) hook?.onMemberStream(...args);
    } } : {}),
  });
  const listener = await createTeamListener(context);
  const openClients = [];

  const env = {
    fx, store, clients, core, context, listener, port: listener.port, bootSecret, dropped, notified, logs, clock, chat, models,
    memberStreamCalls,
    redeemCalls, setReady(value) { ready = value; },
    // The log text, for the redaction check.
    logText: () => JSON.stringify(logs),
    client(key, options) { const client = openClient(env, key, options); openClients.push(client); return client; },
    async newInvite({ kind = 'new_member', actor = LOCAL_COMMAND, role = 'member', ttlMs } = {}) {
      const key = randomPublicKey();
      const created = await store.createInvite({ kind, actorMemberId: actor, ...(kind === 'new_member' ? { role } : {}),
        ...(ttlMs ? { ttlMs } : {}), invitePublicKey: key });
      if (!created.ok) throw new Error(`invite failed: ${created.error.reason}`);
      return { key, inviteId: created.invite_id };
    },
    async redeemDirect({ kind = 'new_member', actor = LOCAL_COMMAND, role = 'member', name, label = 'Laptop' }) {
      const invite = await env.newInvite({ kind, actor, role });
      const deviceKey = randomPublicKey();
      const redeemed = await store.redeem({ inviteId: invite.inviteId, devicePublicKey: deviceKey,
        displayName: name, label });
      if (!redeemed.ok) throw new Error(`redeem failed: ${redeemed.error.reason}`);
      return { ...redeemed, key: deviceKey };
    },
    // One owner, an active member, an active read-only member, a pending member and a live invite principal.
    async seed() {
      const owner = await env.redeemDirect({ kind: 'owner_first', name: 'Olive Owner' });
      const make = async (role, name, admit) => {
        const made = await env.redeemDirect({ actor: owner.member_id, role, name });
        if (admit) {
          const admitted = await store.admit({ actorMemberId: owner.member_id, memberId: made.member_id });
          if (!admitted.ok) throw new Error(`admit failed: ${admitted.error.reason}`);
        }
        return made;
      };
      const member = await make('member', 'Mika Member', true);
      const readOnly = await make('read_only', 'Rui Reader', true);
      const pending = await make('member', 'Pia Pending', false);
      const invite = await env.newInvite({ actor: owner.member_id });
      return { owner, member, readOnly, pending, invite };
    },
    async cleanup() {
      for (const client of openClients) client.close();
      await chat?.dispose();
      for (const unsubscribe of modelUnsubscribes.splice(0).reverse()) unsubscribe();
      await listener.close();
      await core.dispose();
    },
  };
  t.after(() => env.cleanup());
  return env;
}

// A raw client for one key: it writes the preamble when the connection opens,
// then sends ordinary HTTP over the same socket.
function openClient(env, key, { host = TEAM_HOST, preamble } = {}) {
  const keyBytes = Buffer.from(key, 'base64url');
  const sockets = [];
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  agent.createConnection = () => {
    const socket = net.connect({ host: '127.0.0.1', port: env.port });
    socket.on('error', () => {});
    socket.write(preamble || encodeHostPreamble(env.bootSecret, keyBytes));
    sockets.push(socket);
    return socket;
  };
  const client = {
    agent, sockets, key,
    get socket() { return sockets[sockets.length - 1]; },
    // Resolves { status, headers, json, text }; rejects when the socket closes with no answer.
    request(method, path, { body, headers = {}, rawBody } = {}) {
      return new Promise((resolve, reject) => {
        const payload = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
        const req = http.request({ agent, host: '127.0.0.1', port: env.port, method, path,
          headers: { Host: host, ...(payload === null ? {} : { 'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload) }), ...headers } }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const parse = () => { try { return JSON.parse(text); } catch { return null; } };
            resolve({ status: response.statusCode, headers: response.headers, json: parse(), text, body: Buffer.concat(chunks) });
          });
        });
        req.on('error', reject);
        req.end(payload);
      });
    },
    hello(version = 1) { return client.request('POST', '/api/v1/team/hello', { body: { protocol_version: version, app_version: '1.6.1' } }); },
    async registerClient() {
      const response = await client.request('POST', '/api/v1/clients');
      return { client_id: response.json.client_id, client_token: response.json.client_token, response };
    },
    // An open event stream; `frames` collects every data frame.
    openStream(auth) {
      return new Promise((resolve, reject) => {
        const frames = [];
        // A stream of its own: a second connection, a second preamble.
        const streamAgent = new http.Agent({ keepAlive: false });
        streamAgent.createConnection = agent.createConnection;
        const req = http.request({ agent: streamAgent, host: '127.0.0.1', port: env.port, method: 'GET',
          path: '/api/v1/events',
          headers: { Host: host, 'X-Client-Id': auth.client_id, 'X-Client-Token': auth.client_token } }, (response) => {
          const stream = { response, frames, status: response.statusCode, closed: false };
          response.setEncoding('utf8');
          response.on('data', (chunk) => { frames.push(chunk); });
          response.on('close', () => { stream.closed = true; });
          resolve(stream);
        });
        req.on('error', reject);
        req.end();
      });
    },
    close() { agent.destroy(); for (const socket of sockets) socket.destroy(); },
  };
  return client;
}

function pause(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitUntil(predicate, { attempts = 100, interval = 20 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true;
    await pause(interval);
  }
  return predicate();
}

// Hello, a client, and an open stream for one device key; `send` posts a command as that client.
async function connectMember(env, key) {
  const client = env.client(key);
  assert.equal((await client.hello()).status, 200);
  const auth = await client.registerClient();
  assert.equal(auth.response.status, 200);
  const stream = await client.openStream(auth);
  assert.equal(stream.status, 200);
  const send = async (operation, params = {}) => {
    const body = { ...command(auth, operation, params), boot_epoch: env.context.bootEpoch };
    const answer = await client.request('POST', '/api/v1/commands',
      { body, headers: { 'X-Client-Token': auth.client_token } });
    return answer.json;
  };
  return { client, auth, stream, send };
}

// The team chat events a stream has received so far.
const chatFrames = (stream) => stream.frames.join('').split('\n')
  .filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  .filter((frame) => typeof frame.event_type === 'string' && frame.event_type.startsWith('team_chat_'));

module.exports = {
  chatFrames, connectMember, createClock, createTeamHttpFixture, openClient, pause, randomPublicKey, waitUntil,
};
