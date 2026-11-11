'use strict';

// Shared setup for the team host start tests: a temporary profile with a schema
// 3 team config, a fake parent channel, the fake transport and fake bridge child, a fake backend
// composition around BackendHarness, a profile-lock stand-in and a listener
// recorder. Nothing here runs the bridge binary or starts a sidecar: the bridge is a fake child.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { BackendHarness } = require('../../helpers/command-router-fixture');
const { createFakeBridgeSpawner } = require('./fake-bridge');
const { createFakeTransport, publicKeyOf } = require('./fake-team-transport');
const { MemberStore } = require('../../../server/team/member-store');
const { startTeamHost } = require('../../../server/team/team-main');
const { keyPairFromSeed } = require('../../../server/team/ids');

const HOST_SEED = crypto.createHash('sha256').update('team-startup-host-seed').digest();
const TEAM_NAME = 'Quiet Harbor';

function randomKey() {
  return crypto.randomBytes(32).toString('base64url');
}

// Stands in for the parent process: records what the host sends and lets a test
// push the messages the real channel would have validated.
function createFakeParent() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    closed: false,
    send(message) { sent.push(JSON.parse(JSON.stringify(message))); return true; },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(message) { for (const listener of [...listeners]) listener(message); },
    sentTypes() { return sent.map((message) => message.type); },
    close() { this.closed = true; listeners.clear(); },
  };
}

// An output stream stand-in for the local team commands: records what is
// written and says whether it is a terminal. `failWrites` makes every write throw.
function createOutputStream({ isTTY = false, failWrites = false } = {}) {
  const chunks = [];
  return {
    chunks,
    isTTY,
    write(text) {
      if (failWrites) throw new Error('output closed');
      chunks.push(String(text));
      return true;
    },
    text: () => chunks.join(''),
  };
}

// A listener that accepts a connection and destroys it, never writing a byte.
function createClosedListener(context) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(context.config.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

function createTeamHostFixture(t, { keySource = 'secret_file', writeKey = true, directPort = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-host-'));
  const profile = path.join(root, 'profile');
  const secrets = path.join(root, 'secrets');
  fs.mkdirSync(profile);
  fs.mkdirSync(secrets);
  const configPath = path.join(root, 'host.json');
  const hostSeed = Buffer.from(HOST_SEED);
  const hostKey = hostSeed.toString('base64url');
  const hostPublicKey = keyPairFromSeed(hostSeed).publicKey;
  const fake = createFakeTransport();
  const spawner = createFakeBridgeSpawner(fake);
  const logs = [];
  const hosts = [];
  const contexts = [];
  const backends = [];
  const lock = { acquired: 0, released: 0, onLost: null };

  const fx = {
    root, profile, secrets, configPath, hostKey, hostPublicKey, fake, spawner, logs, lock, contexts, backends, teamName: TEAM_NAME,
    logger(level, event, fields) { logs.push({ level, event, fields: fields ?? {} }); },
    keyFile: path.join(secrets, 'team-host-key'),
    writeConfig({ source = keySource, port = 0, extra = {} } = {}) {
      fs.writeFileSync(configPath, JSON.stringify({
        schema_version: 3,
        host_mode: 'server',
        host_execution_policy_version: 1,
        execution: null,
        listen_host: '127.0.0.1',
        port,
        user_data_path: profile,
        workspace_root: null,
        secrets_dir: secrets,
        model_endpoint: { engine: 'ollama', model: 'qwen3.5:9b', api_url: 'http://ollama:11434' },
        team: { name: TEAM_NAME, key_source: source, direct_port: directPort },
        ...extra,
      }), { mode: 0o600 });
    },
    writeKeyFile(text = hostKey) { fs.writeFileSync(fx.keyFile, `${text}\n`, { mode: 0o600 }); },
    newParent: createFakeParent,
    acquireProfileImpl() {
      lock.acquired += 1;
      return { release() { lock.released += 1; } };
    },
    // A fake composition the router accepts; stop() reports a confirmed exit.
    createBackend() {
      const dir = path.join(root, `backend-${backends.length}`);
      fs.mkdirSync(dir, { recursive: true });
      const backend = new BackendHarness(dir);
      backend.sidecarManager = { process: null };
      const composition = { backend, calls: [], start: async () => { composition.calls.push('start'); },
        stop: async () => { composition.calls.push('stop'); return { exitConfirmed: true }; },
        dispose: async () => { composition.calls.push('dispose'); backend.dispose(); } };
      backends.push(composition);
      return composition;
    },
    options(extra = {}) {
      return {
        spawnBridge: spawner,
        createBackend: fx.createBackend,
        acquireProfileImpl: (input) => { lock.onLost = input.onLost; return fx.acquireProfileImpl(input); },
        keyTimeoutMs: 2000,
        logger: fx.logger,
        createListener: async (context) => {
          contexts.push(context);
          return createClosedListener(context);
        },
        ...extra,
      };
    },
    async start(parent = null, extra = {}) {
      const host = await startTeamHost(configPath, parent, fx.options(extra));
      hosts.push(host);
      return host;
    },
    context() { return contexts[contexts.length - 1]; },
    // The owner and one member with a device under `memberKey`, written before the host starts.
    async seedMembers(memberKey) {
      const store = new MemberStore({ userDataPath: profile, hostPublicKey, teamName: TEAM_NAME });
      const redeemFirst = async (input) => {
        const created = await store.createInvite({ kind: input.kind, actorMemberId: input.actor ?? null,
          ...(input.kind === 'new_member' ? { role: 'member' } : {}), invitePublicKey: randomKey() });
        if (!created.ok) throw new Error(`seed invite failed: ${created.error.reason}`);
        const redeemed = await store.redeem({ inviteId: created.invite_id, devicePublicKey: input.key,
          displayName: input.name, label: 'Laptop' });
        if (!redeemed.ok) throw new Error(`seed redeem failed: ${redeemed.error.reason}`);
        return redeemed;
      };
      const owner = await redeemFirst({ kind: 'owner_first', key: randomKey(), name: 'Olive Owner' });
      const member = await redeemFirst({ kind: 'new_member', actor: owner.member_id, key: memberKey, name: 'Mika Member' });
      const admitted = await store.admit({ actorMemberId: owner.member_id, memberId: member.member_id });
      if (!admitted.ok) throw new Error(`seed admit failed: ${admitted.error.reason}`);
      return { owner, member };
    },
    // A client the fake transport knows by its secret; its device key is the fake public key.
    client() {
      const secretKey = new Uint8Array(crypto.randomBytes(32));
      return { secretKey, deviceKey: Buffer.from(publicKeyOf(secretKey)).toString('base64url') };
    },
    hostTransportKey() { return publicKeyOf(Uint8Array.from(hostSeed)); },
    async connect(client) {
      return fake.transport.connect({ secretKey: client.secretKey, hostPublicKey: fx.hostTransportKey(),
        alpn: 'jenny-team/1', addresses: [] });
    },
    // One raw TCP exchange: the bytes received and whether the socket closed.
    probe(port, request) {
      return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const chunks = [];
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('probe_timeout')); }, 3000);
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('error', () => {});
        socket.on('close', () => { clearTimeout(timer); resolve({ bytes: Buffer.concat(chunks).length, closed: true }); });
        socket.write(request);
      });
    },
    // True when something accepts a TCP connection on the loopback port.
    isListening(port) {
      return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
      });
    },
    logText() { return JSON.stringify(logs); },
    async cleanup() {
      for (const host of hosts) await host.stop().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  fx.writeConfig();
  if (keySource === 'secret_file' && writeKey) fx.writeKeyFile();
  t.after(() => fx.cleanup());
  return fx;
}

// A schema 2 single-owner config, for the tests that reject team-only arguments.
function writeSingleOwnerConfig(root) {
  const configPath = path.join(root, 'single.json');
  fs.mkdirSync(path.join(root, 'single-profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'single-secrets'), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    schema_version: 2,
    host_mode: 'server',
    host_execution_policy_version: 1,
    browser_access_mode: 'localhost_http',
    execution: null,
    canonical_origin: 'http://127.0.0.1:8080',
    listen_host: '127.0.0.1',
    port: 8080,
    user_data_path: path.join(root, 'single-profile'),
    workspace_root: null,
    secrets_dir: path.join(root, 'single-secrets'),
    model_endpoint: { engine: 'ollama', model: 'qwen3.5:9b', api_url: 'http://ollama:11434' },
  }), { mode: 0o600 });
  return configPath;
}

module.exports = {
  HOST_SEED, TEAM_NAME, createClosedListener, createFakeParent, createOutputStream, createTeamHostFixture, randomKey,
  writeSingleOwnerConfig,
};
