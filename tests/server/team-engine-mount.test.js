'use strict';

// Slice 4b host mount (row 123, TEAM_NODE_PROTOCOL_SPEC "4b host mount as
// built"): the two team engine routes answer on a real team host and nowhere
// else. The host is real (preamble listener, team HTTP layer, hello gate,
// member store, authorizer, pool composition, engine routes, usage log); the
// bridge and backend are the team host fixture's fakes and a scheduler-level
// fake node answers jobs. No sidecar, no model, no bridge binary, no window.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const nodeTest = require('node:test');

const { AuthService } = require('../../server/auth-service');
const { ClientRegistry } = require('../../server/client-registry');
const { loadHostConfig } = require('../../server/config');
const { ControlLeases } = require('../../server/control-leases');
const { createHostCore } = require('../../server/host-core');
const { createHttpServer } = require('../../server/http-server');
const { USAGE_LOG_FILE } = require('../../server/team/usage-log');
const { SUPPORTED_TAGS } = require('../../renderer/shared/i18n-utils');
const { createFakeBridgeSpawner } = require('./helpers/fake-bridge');
const { CHAT_PATH, DONE, MODELS_PATH, chatBody, delta, engineError, usageChunk } = require('./helpers/team-engine-fixture');
const { openEngineStream, startMountedHost } = require('./helpers/team-engine-mount-fixture');
const { createTeamHostFixture, randomKey, writeSingleOwnerConfig } = require('./helpers/team-host-fixture');

const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);
const PATHS = Object.freeze([['GET', MODELS_PATH], ['POST', CHAT_PATH]]);
const ZERO = Object.freeze({ requests: 0, timers: 0, leases: 0, body_bytes: 0 });

function ask(client, method, urlPath, headers, body = chatBody()) {
  return client.request(method, urlPath, { headers, ...(method === 'POST' ? { body } : {}) });
}

function reasonOf(answer) {
  return answer.json?.error?.reason ?? answer.json?.error?.code ?? null;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('before hello both engine paths are refused by the hello gate and reach no route code', async (t) => {
  const m = await startMountedHost(t);
  const { owner } = await m.seed();
  const client = m.client(owner.key);
  for (const [method, urlPath] of PATHS) {
    const answer = await ask(client, method, urlPath, {});
    assert.equal(answer.status, 403, urlPath);
    assert.equal(reasonOf(answer), 'team_hello_required', urlPath);
  }
  assert.deepEqual(m.seen.routeCalls, []);
  assert.deepEqual(m.liveLeases(), []);
});

test('models answers the owner and an active member; everyone else is refused with a reason and no lease', async (t) => {
  const m = await startMountedHost(t);
  const seeded = await m.seed();
  m.node();
  for (const who of ['owner', 'member']) {
    const { auth, client } = await m.ready(seeded[who]);
    const answer = await ask(client, 'GET', MODELS_PATH, auth);
    assert.equal(answer.status, 200, who);
    assert.deepEqual(answer.json.data.map((entry) => entry.id), ['alpha'], who);
  }
  const refusals = {};
  const { auth: readAuth, client: reader } = await m.ready(seeded.readOnly);
  // A pending member says hello but may not register a client, so it never reaches the role check.
  const pending = await m.ready(seeded.pending);
  assert.deepEqual([pending.hello.status, pending.auth], [200, {}]);
  const { client: bare } = await m.ready(seeded.second);
  const wrong = await m.ready(seeded.third);
  const wrongAuth = { ...wrong.auth, 'X-Client-Token': 'x'.repeat(43) };
  for (const [method, urlPath] of PATHS) {
    for (const [who, client, headers] of [['read_only', reader, readAuth], ['pending', pending.client, pending.auth],
      ['no_token', bare, {}], ['wrong_token', wrong.client, wrongAuth]]) {
      const answer = await ask(client, method, urlPath, headers);
      assert.equal(answer.status, 403, `${who} ${urlPath}`);
      refusals[`${who} ${method}`] = reasonOf(answer);
    }
  }
  assert.deepEqual(refusals, {
    'read_only GET': 'role_forbidden', 'read_only POST': 'role_forbidden',
    'pending GET': 'client_required', 'pending POST': 'client_required',
    'no_token GET': 'client_required', 'no_token POST': 'client_required',
    'wrong_token GET': 'client_required', 'wrong_token POST': 'client_required',
  });
  // A revoked member and an unknown device are not on the list: the socket closes without a byte.
  const revoked = await m.ready(seeded.member);
  assert.equal((await m.store.revokeMember({ actorMemberId: seeded.owner.member_id,
    memberId: seeded.member.member_id })).ok, true);
  const stranger = m.client(randomKey());
  for (const [method, urlPath] of PATHS) {
    await assert.rejects(ask(revoked.client, method, urlPath, revoked.auth), `revoked ${urlPath}`);
    await assert.rejects(ask(stranger, method, urlPath, {}), `unknown ${urlPath}`);
  }
  assert.deepEqual(m.liveLeases(), []);
  assert.deepEqual(m.seen.routes.resources(), ZERO);
  assert.deepEqual(m.usageRows(), []);
});

test('one streamed chat is relayed in order and writes one usage row with no prompt or reply text', async (t) => {
  const m = await startMountedHost(t);
  const { member } = await m.seed();
  const node = m.node();
  const { auth, client } = await m.ready(member);
  const stream = openEngineStream(client, auth, chatBody({ messages: [{ role: 'user', content: 'PROMPT-SECRET-41' }] }));
  const job = await node.claimNext();
  assert.equal(job.request.messages[0].content, 'PROMPT-SECRET-41');
  const parts = [delta('REPLY-SECRET-one'), delta(' two'), delta(' three'), usageChunk(5, 7), DONE];
  for (const [index, part] of parts.entries()) assert.equal(job.send(part, index === parts.length - 1).ok, true);
  await stream.until((s) => s.ended, 'the stream ends');
  assert.equal(stream.state.status, 200);
  assert.equal(stream.state.headers['content-type'], 'text/event-stream');
  assert.equal(stream.state.text.replace(/^: keepalive\n\n/gmu, ''), parts.join(''));
  const rows = m.usageRows();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], at: 0, duration_ms: 0 }, { seq: 1, at: 0, member_id: member.member_id, model: 'alpha',
    node_id: node.nodeId, prompt_tokens: 5, completion_tokens: 7, duration_ms: 0, outcome: 'completed', reason: null });
  const stored = fs.readFileSync(m.usageFile, 'utf8');
  for (const secret of ['PROMPT-SECRET', 'REPLY-SECRET', 'hello']) {
    assert.equal(stored.includes(secret), false, secret);
    assert.equal(m.fx.logText().includes(secret), false, secret);
  }
  assert.deepEqual(m.liveLeases(), []);
});

// A demotion or a revoke reaches the pool through the revoke fan-out, which cancels the
// member's lease at once; a lost client is caught by the re-check.
test('the mid-stream re-check: a stream past 1 s is kept; a lost client is cut at the next check, a demotion or a revoke at once',
  async (t) => {
    const m = await startMountedHost(t);
    const seeded = await m.seed();
    const node = m.node({ slots: 3 });
    // The legitimate stream: three seconds on the injected clock, every check passes.
    const kept = await m.ready(seeded.owner);
    const keptStream = openEngineStream(kept.client, kept.auth, chatBody());
    const keptJob = await node.claimNext();
    for (const word of ['a', 'b', 'c']) {
      keptJob.send(delta(word));
      m.clock.advance(1500);
    }
    keptJob.send(DONE, true);
    await keptStream.until((s) => s.ended, 'the kept stream ends');
    assert.equal(keptStream.state.text, [delta('a'), delta('b'), delta('c'), DONE].join(''));

    const owner = seeded.owner.member_id;
    const variants = [
      ['client_gone', seeded.member, 'client_required', (who) => m.context.clients.revokeDevice(who.device_id), false],
      ['demoted', seeded.second, 'cancelled', (who) => m.store.setRole({ actorMemberId: owner,
        memberId: who.member_id, role: 'read_only' }), true],
      ['revoked', seeded.third, 'cancelled', (who) => m.store.revokeMember({ actorMemberId: owner,
        memberId: who.member_id }), true],
    ];
    for (const [label, who, reason, change, atOnce] of variants) {
      const { auth, client } = await m.ready(who);
      const stream = openEngineStream(client, auth, chatBody());
      const job = await node.claimNext();
      job.send(delta('before'));
      await stream.until((s) => s.text.includes('before'), `${label}: first bytes`);
      await change(who);
      if (!atOnce) {
        // Inside the second since the last check, bytes still flow; the next check cuts.
        job.send(delta('within'));
        await stream.until((s) => s.text.includes('within'), `${label}: bytes inside the second`);
        m.clock.advance(1000);
        job.send(delta('after'));
      }
      await stream.until((s) => s.closed, `${label}: cut`);
      assert.equal(stream.state.text.includes('after'), false, label);
      assert.equal(stream.state.ended, false, `${label}: cut, not ended`);
      const row = m.usageRows().at(-1);
      assert.deepEqual([row.member_id, row.outcome, row.reason], [who.member_id, 'cancelled', reason], label);
    }
    assert.deepEqual(m.liveLeases(), []);
    assert.deepEqual(m.liveJobs(), []);
    assert.deepEqual(m.seen.routes.resources(), ZERO);
  });

test('without a team.pool block both routes answer team_pool_unavailable', async (t) => {
  const m = await startMountedHost(t, { pool: null });
  const { owner } = await m.seed();
  const { auth, client } = await m.ready(owner);
  assert.equal(m.seen.routesInput.pool, null);
  for (const [method, urlPath] of PATHS) {
    const answer = await ask(client, method, urlPath, auth);
    assert.equal(answer.status, 503, urlPath);
    assert.equal(engineError(answer.text), 'team_pool_unavailable', urlPath);
  }
});

test('the single-owner hosted host answers route_not_found on both paths', async (t) => {
  const fx = createTeamHostFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-single-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = loadHostConfig(writeSingleOwnerConfig(root));
  const clients = new ClientRegistry();
  const core = createHostCore({ config, clients, leases: new ControlLeases(), createBackend: fx.createBackend,
    logger: () => {} });
  const auth = new AuthService({ filePath: path.join(config.userDataPath, 'auth.json') });
  assert.equal((await auth.initializePassword('test-password-strong')).ok, true);
  const staticRoot = path.join(root, 'browser');
  fs.mkdirSync(path.join(staticRoot, 'locales'), { recursive: true });
  for (const file of ['index.html', 'app.js', 'styles.css']) fs.writeFileSync(path.join(staticRoot, file), 'test build');
  for (const tag of [...SUPPORTED_TAGS, 'qps-ploc']) fs.writeFileSync(path.join(staticRoot, 'locales', `${tag}.json`), '{}');
  const transport = createHttpServer({ canonicalOrigin: 'https://jenny.test', staticRoot, auth, clients,
    events: core.events, router: core.router, bootEpoch: core.bootEpoch, assetRoutes: core.assetRoutes });
  await new Promise((resolve) => { transport.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await transport.close(); await core.dispose(); });
  const port = transport.server.address().port;
  const request = (method, urlPath, headers = {}, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: 'jenny.test',
      Origin: 'https://jenny.test', ...(payload === null ? {} : { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload) }), ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  const login = await request('POST', '/api/v1/auth/login', {}, { password: 'test-password-strong' });
  const session = { Cookie: login.headers['set-cookie'][0].split(';', 1)[0], 'X-CSRF-Token': login.json.csrf_token };
  const registered = await request('POST', '/api/v1/clients', session);
  assert.equal(registered.status, 200);
  const owner = { ...session, 'X-Client-Id': registered.json.client_id, 'X-Client-Token': registered.json.client_token };
  for (const [method, urlPath] of PATHS) {
    const answer = await request(method, urlPath, owner, method === 'POST' ? chatBody() : undefined);
    assert.equal(answer.status, 404, urlPath);
    assert.equal(answer.json.error.reason, 'route_not_found', urlPath);
  }
});

test('stop runs the engine routes before the pool and leaves no request, lease or job', async (t) => {
  const m = await startMountedHost(t);
  const { member } = await m.seed();
  const node = m.node();
  const { auth, client } = await m.ready(member);
  const stream = openEngineStream(client, auth, chatBody());
  const job = await node.claimNext();
  job.send(delta('partial'));
  await stream.until((s) => s.text.includes('partial'), 'first bytes');
  await m.host.stop();
  assert.deepEqual(m.seen.order, ['engine.stop', 'pool.stop']);
  assert.deepEqual(m.seen.afterStop, { resources: ZERO, leases: 0, jobs: 0 });
  await stream.until((s) => s.closed, 'the stream is cut');
  const rows = m.usageRows();
  assert.deepEqual(rows.map((row) => [row.outcome, row.reason]), [['cancelled', 'cancelled']]);
});

test('a startup that fails after the routes were built stops them before the pool', async (t) => {
  const fx = createTeamHostFixture(t);
  const { createSeams, mountConfig } = require('./helpers/team-engine-mount-fixture');
  mountConfig(fx, { context_length: 32768 });
  const seams = createSeams();
  await assert.rejects(fx.start(null, { createPool: seams.createPool, createEngineRoutes: seams.createEngineRoutes,
    createListener: seams.createListener, spawnBridge: createFakeBridgeSpawner(fx.fake, { startFails: 'bind_failed' }) }),
  (error) => error.reason === 'team_transport_down');
  assert.deepEqual(seams.seen.order, ['engine.stop', 'pool.stop']);
  assert.deepEqual(seams.seen.afterStop, { resources: ZERO, leases: 0, jobs: 0 });
  assert.equal(fx.lock.released, 1);
});

// A file refused for its content is set aside at start since slice 3-4b (team-startup.test.js); a newer
// schema is never set aside, so it still refuses chat.
test('an unsupported usage file does not stop the host: chat refuses with the reason, models answers',
  async (t) => {
    for (const [text, reason] of [
      [JSON.stringify({ schema_version: 99, floor_seq: 0, entries: [] }), 'pool_schema_unsupported']]) {
      const m = await startMountedHost(t, { before: (fx) => fs.writeFileSync(path.join(fx.profile, USAGE_LOG_FILE), text) });
      const { owner } = await m.seed();
      m.node();
      const { auth, client } = await m.ready(owner);
      assert.equal((await ask(client, 'GET', MODELS_PATH, auth)).status, 200, reason);
      const chat = await ask(client, 'POST', CHAT_PATH, auth);
      assert.equal(chat.status, 503, reason);
      assert.equal(engineError(chat.text), reason);
      assert.equal(fs.readFileSync(m.usageFile, 'utf8'), text, 'a broken file is never rewritten');
      assert.deepEqual(m.liveLeases(), []);
      await m.host.stop();
    }
  });

test('an asset route and an artifact route still answer as before', async (t) => {
  const m = await startMountedHost(t);
  const { owner } = await m.seed();
  const { auth, client } = await m.ready(owner);
  const attachment = await ask(client, 'GET', '/api/v1/sessions/session_a1/attachments/attachment_b2', auth);
  const artifact = await ask(client, 'GET', '/api/v1/sessions/session_a1/artifacts/artifact_c3', auth);
  const noClient = await ask(client, 'GET', '/api/v1/sessions/session_a1/attachments/attachment_b2', {});
  assert.deepEqual([attachment.status, reasonOf(attachment)], [403, 'attachment_reference_not_found']);
  // The fake backend has no artifact store: the artifact route's own answer, unchanged by the mount.
  assert.deepEqual([artifact.status, reasonOf(artifact)], [503, 'artifact_unavailable']);
  assert.deepEqual([noClient.status, reasonOf(noClient)], [403, 'client_required']);
  assert.deepEqual(m.seen.routeCalls, [], 'the asset routes answered first');
});

test('a queued stream and a queued plain answer outlive the write-idle deadline (contract 6)', async (t) => {
  const m = await startMountedHost(t, { writeTimeoutMs: 150 });
  const { member, second } = await m.seed();
  const node = m.node();
  const hold = () => m.scheduler.requestLease({ conversationKey: 'conv:-:filler', memberId: 'member_filler',
    model: 'alpha', wantsVision: false });
  // A stream that queues gets its head at once and then waits, silent, for four deadlines.
  let filler = hold();
  assert.equal(filler.lease.state, 'active');
  const { auth, client } = await m.ready(member);
  const stream = openEngineStream(client, auth, chatBody());
  await stream.until((s) => s.status === 200, 'the head of the queued stream');
  await sleep(600);
  assert.equal(stream.state.closed, false, 'the queued stream is still open');
  assert.equal(m.scheduler.releaseLease(filler.lease.lease_id).ok, true);
  const job = await node.claimNext();
  job.send(delta('late'));
  job.send(DONE, true);
  await stream.until((s) => s.ended, 'the queued stream ends');
  assert.equal(stream.state.text.replace(/^: keepalive\n\n/gmu, ''), delta('late') + DONE);
  // A plain answer that queues: the deadline starts only once the handler returns.
  filler = hold();
  const plain = await m.ready(second);
  const answer = ask(plain.client, 'POST', CHAT_PATH, plain.auth, chatBody({ stream: false }));
  await sleep(600);
  assert.equal(m.scheduler.releaseLease(filler.lease.lease_id).ok, true);
  const plainJob = await node.claimNext();
  plainJob.send(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'late' } }] }), true);
  const done = await answer;
  assert.equal(done.status, 200);
  assert.equal(done.json.choices[0].message.content, 'late');
});
