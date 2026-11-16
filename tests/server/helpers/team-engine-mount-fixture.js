'use strict';

// Slice 4b host mount: a real team host (`startTeamHost` with the real preamble
// listener and team HTTP layer, the team host fixture's fake bridge and fake
// backend) with the real pool composition and the real engine routes, each
// built through a seam that records it. Members are seeded through the host's
// own store; requests go through the raw preamble client; a scheduler-level
// fake node answers jobs. No sidecar, no model, no bridge binary, no window.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createEngineRoutes } = require('../../../server/team/engine-routes');
const { createPoolComposition } = require('../../../server/team/pool-composition');
const { TEAM_HOST, createTeamListener } = require('../../../server/team/team-http-server');
const { USAGE_LOG_FILE } = require('../../../server/team/usage-log');
const { createClock } = require('./clock');
const { CHAT_PATH, createNode, model, waitFor } = require('./team-engine-fixture');
const { openClient } = require('./team-http-fixture');
const { createTeamHostFixture, randomKey, TEAM_NAME } = require('./team-host-fixture');
const { LOCAL_COMMAND } = require('../../../server/team/member-schema');

const CONTEXT = 32768;
const POOL = Object.freeze({ context_length: CONTEXT });

function mountConfig(fx, pool) {
  fx.writeConfig({ extra: { model_endpoint: undefined,
    team: { name: TEAM_NAME, key_source: 'secret_file', direct_port: null, ...(pool ? { pool } : {}) } } });
}

// The seams: the pool and the engine routes the host builds, the order their stops ran in, the
// context the listener got, and every call the engine routes saw. `poolClock` (gate tests) is
// the pool scheduler's clock in place of its monotonic default; the host itself passes none.
function createSeams({ writeTimeoutMs = null, poolClock = null } = {}) {
  const seen = { pool: null, routes: null, routesInput: null, context: null, order: [], routeCalls: [], afterStop: null };
  const createPool = (input) => {
    const real = createPoolComposition(poolClock ? { ...input, clock: poolClock } : input);
    seen.pool = real;
    return Object.freeze({ ...real, stop: async () => { seen.order.push('pool.stop'); await real.stop(); } });
  };
  const buildRoutes = (input) => {
    const real = createEngineRoutes(input);
    seen.routesInput = input;
    const handle = Object.assign((ctx) => { seen.routeCalls.push(ctx.pathname); return real(ctx); }, {
      resources: real.resources, counters: real.counters,
      stop: async () => {
        seen.order.push('engine.stop');
        await real.stop();
        // What the routes left, before the pool's own stop cancels anything.
        const live = (list, states) => list.filter((entry) => states.includes(entry.state)).length;
        seen.afterStop = { resources: real.resources(),
          leases: seen.pool ? live(seen.pool.scheduler.listLeases(), ['queued', 'active']) : 0,
          jobs: seen.pool ? live(seen.pool.scheduler.listJobs(), ['queued', 'claimed', 'streaming']) : 0 };
      },
    });
    seen.routes = handle;
    return handle;
  };
  const createListener = (context) => {
    seen.context = context;
    // A lowered write-idle deadline (contract 6) reaches only the listener, as the config would.
    return createTeamListener(writeTimeoutMs ? { ...context,
      resourceLimits: { ...context.resourceLimits, responseWriteTimeoutMs: writeTimeoutMs } } : context);
  };
  return { seen, createPool, createEngineRoutes: buildRoutes, createListener };
}

// `withParent` starts the host with a fake parent channel (`mounted.parent`).
async function startMountedHost(t, { pool = POOL, clock = createClock(), writeTimeoutMs = null, before = null,
  extra = {}, withParent = false, poolClock = null } = {}) {
  const fx = createTeamHostFixture(t);
  mountConfig(fx, pool);
  if (before) before(fx);
  const seams = createSeams({ writeTimeoutMs, poolClock });
  const parent = withParent ? fx.newParent() : null;
  const host = await fx.start(parent, { createPool: seams.createPool, createEngineRoutes: seams.createEngineRoutes,
    createListener: seams.createListener, clock, ...extra });
  const { seen } = seams;
  const store = seen.context.store;
  const env = { port: host.port, bootSecret: seen.context.bootSecret };
  const clients = [];
  const usageFile = path.join(fx.profile, USAGE_LOG_FILE);

  // The member whose devices the nodes `node()` registers run on (seeded): a node must be a live device
  // allowed to share, or the host's membership recheck takes it out of the pool.
  const nodeHost = { member_id: null, devices: [] };

  async function redeem({ kind = 'new_member', actor = LOCAL_COMMAND, role = 'member', name, admit = true }) {
    const created = await store.createInvite({ kind, actorMemberId: actor, ...(kind === 'new_member' ? { role } : {}),
      invitePublicKey: randomKey() });
    if (!created.ok) throw new Error(`invite failed: ${created.error.reason}`);
    const key = randomKey();
    const redeemed = await store.redeem({ inviteId: created.invite_id, devicePublicKey: key, displayName: name,
      label: 'Laptop' });
    if (!redeemed.ok) throw new Error(`redeem failed: ${redeemed.error.reason}`);
    if (kind === 'new_member' && admit) {
      const admitted = await store.admit({ actorMemberId: actor, memberId: redeemed.member_id });
      if (!admitted.ok) throw new Error(`admit failed: ${admitted.error.reason}`);
    }
    return { ...redeemed, key };
  }

  const mounted = {
    fx, host, seen, store, clock, usageFile, parent, context: seen.context,
    get pool() { return seen.pool; },
    get scheduler() { return seen.pool?.scheduler ?? null; },
    usageRows: () => (fs.existsSync(usageFile) ? JSON.parse(fs.readFileSync(usageFile, 'utf8')).entries : []),
    liveLeases: () => (seen.pool ? seen.pool.scheduler.listLeases()
      .filter((lease) => lease.state === 'queued' || lease.state === 'active') : []),
    liveJobs: () => (seen.pool ? seen.pool.scheduler.listJobs()
      .filter((job) => ['queued', 'claimed', 'streaming'].includes(job.state)) : []),
    // The owner, two active members, an active read-only member and a pending member; also the node
    // host, an active member with three devices that `node()` uses and the tests never see.
    async seed() {
      const owner = await redeem({ kind: 'owner_first', name: 'Olive Owner' });
      const make = (role, name, admit = true) => redeem({ actor: owner.member_id, role, name, admit });
      const host = await make('member', 'Nell Node');
      nodeHost.member_id = host.member_id;
      nodeHost.devices = [host.device_id];
      for (let i = 0; i < 2; i += 1) {
        const added = await redeem({ kind: 'add_device', actor: host.member_id, name: 'ignored' });
        nodeHost.devices.push(added.device_id);
      }
      return { owner, member: await make('member', 'Mika Member'), second: await make('member', 'Sana Second'),
        third: await make('member', 'Theo Third'), readOnly: await make('read_only', 'Rui Reader'),
        pending: await make('member', 'Pia Pending', false) };
    },
    client(key) { const client = openClient(env, key); clients.push(client); return client; },
    // A client that said hello and holds a registration: the headers a raw route needs.
    async ready(principal) {
      const client = mounted.client(principal.key);
      const hello = await client.hello();
      const registered = hello.status === 200 ? await client.registerClient() : null;
      const auth = registered?.client_id ? { 'X-Client-Id': registered.client_id,
        'X-Client-Token': registered.client_token } : {};
      return { client, hello, auth };
    },
    // One registered node with one slot and the given models, on the node host's next free device (seed first).
    node({ models = [model('alpha')], slots = 1 } = {}) {
      const device = nodeHost.devices.find((id) => !seen.pool.scheduler.nodeIdForDevice(id));
      if (!device) throw new Error('node(): seed() first, at most three nodes');
      const registered = seen.pool.scheduler.registerNode({ deviceId: device, memberId: nodeHost.member_id, slots, models });
      if (!registered.ok) throw new Error(`node failed: ${JSON.stringify(registered)}`);
      return { nodeId: registered.node_id, ...createNode(seen.pool.scheduler, registered.node_id) };
    },
  };
  t.after(() => { for (const client of clients) client.close(); });
  return mounted;
}

// A chat request on a connection of its own, readable as it arrives (a second preamble, as a stream needs).
function openEngineStream(client, headers, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = client.agent.createConnection;
  const state = { status: 0, text: '', ended: false, aborted: false, closed: false };
  const request = http.request({ agent, host: '127.0.0.1', port: 1, method: 'POST', path: CHAT_PATH,
    headers: { Host: TEAM_HOST, 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
  }, (response) => {
    state.status = response.statusCode;
    state.headers = response.headers;
    response.on('data', (chunk) => { state.text += chunk.toString(); });
    response.on('end', () => { state.ended = true; });
    response.on('aborted', () => { state.aborted = true; });
    response.on('error', () => { state.aborted = true; });
    response.on('close', () => { state.closed = true; });
  });
  request.on('error', () => { state.aborted = true; state.closed = true; });
  request.end(payload);
  return { state, until: (predicate, label) => waitFor(() => predicate(state), `${label}: ${JSON.stringify(state)}`) };
}

module.exports = { CONTEXT, POOL, createSeams, mountConfig, openEngineStream, startMountedHost };
