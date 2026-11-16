'use strict';

// new-test-file: the 6-3 fix list's wire checks over the real team HTTP server (server/team/model-routes.js,
// model-commands.js through the router): the whole role matrix with exact status and reason in every cell, the
// closed schemas as one table, real-socket endings (a refused Content-Length, a client gone mid-body and
// mid-wait), and redaction through the refusal paths.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { command } = require('../helpers/command-router-fixture');
const { TEAM_HOST } = require('../../server/team/team-http-server');
const { connectMember, openClient, waitUntil } = require('./helpers/team-http-fixture');
const { modelHttpEnv, partRequest } = require('./helpers/team-model-http');
const { MARK, PATH, clean, manifest } = require('./helpers/team-model-fixture');

const UNKNOWN_OFFER = `offer_${'Z'.repeat(22)}`;
const UNKNOWN_TRANSFER = `mxfer_${'Z'.repeat(22)}`;
const IDLE = Object.freeze({ requests: 0, waits: 0, timers: 0, bodyBytes: 0, reading: 0 });

// A command as a connected peer, with its status: [status, reason or 'ok'] and the whole answer.
async function sendAs(env, peer, operation, params = {}, { token = true } = {}) {
  const body = { ...command(peer.auth, operation, params), boot_epoch: env.context.bootEpoch };
  const answer = await peer.client.request('POST', '/api/v1/commands',
    { body, headers: token ? { 'X-Client-Token': peer.auth.client_token } : {} });
  return answer;
}
const cell = (answer) => [answer.status, answer.json?.ok ? 'ok' : answer.json?.error?.reason];
// The whole answer without its request id (each request has its own).
const bare = (answer) => [answer.status, { ...answer.json, error: { ...answer.json.error, request_id: null } }];
const isClosed = (error) => ['ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(error.code) || /socket hang up/u.test(error.message);

async function world(t) {
  const { env, seeded, other, phone } = await modelHttpEnv(t);
  const owner = await connectMember(env, seeded.owner.key);
  const member = await connectMember(env, seeded.member.key);
  const outsider = await connectMember(env, other.key);
  const wrongDevice = await connectMember(env, phone.key);
  const readOnly = await connectMember(env, seeded.readOnly.key);
  const offer = async (from, to, requestId) => (await sendAs(env, from, 'team.model.offer',
    manifest({ to: { member_id: to }, requestId }))).json.offer.offer_id;
  const taken = await offer(owner, seeded.member.member_id, 'req_taken');
  const transferId = (await sendAs(env, member, 'team.model.accept', { offer_id: taken })).json.transfer.transfer_id;
  return { env, seeded, other, owner, member, outsider, wrongDevice, readOnly, offer, taken, transferId };
}

// The ten operations against the shared offer and transfer, and the two routes on part 0.
function operations(w, requestId) {
  return [['team.model.offer', manifest({ to: { member_id: w.seeded.owner.member_id }, requestId })],
    ['team.model.withdraw', { offer_id: w.taken }], ['team.model.offers', {}], ['team.model.offer.read', { offer_id: w.taken }],
    ['team.model.accept', { offer_id: w.taken }], ['team.model.decline', { offer_id: w.taken }],
    ['team.model.pause', { transfer_id: w.transferId }], ['team.model.resume', { transfer_id: w.transferId }],
    ['team.model.cancel', { transfer_id: w.transferId }], ['team.model.complete', { transfer_id: w.transferId, ok: true }]];
}
async function routeCells(peer, transferId, extraHeaders) {
  const out = [];
  for (const method of ['PUT', 'GET']) {
    out.push(cell(await partRequest(peer, method, PATH(transferId, 0, 0), method === 'PUT' ? Buffer.alloc(4) : undefined,
      extraHeaders)));
  }
  return out;
}

test('T1 role matrix: the identity answer for read-only, pending, unauthenticated and revoked, in every cell', async (t) => {
  const w = await world(t);
  const { env, seeded } = w;
  const run = async (peer, options) => {
    const out = [];
    for (const [operation, params] of operations(w, 'req_matrix')) out.push(cell(await sendAs(env, peer, operation, params, options)));
    return out;
  };
  assert.deepEqual([...await run(w.readOnly), ...await routeCells(w.readOnly, w.transferId)],
    Array(12).fill([403, 'role_forbidden']));
  // A connection with a client id but no client token: the router's client check, then the routes' binding.
  assert.deepEqual([...await run(w.member, { token: false }), ...await routeCells(w.member, w.transferId,
    { 'X-Client-Token': '' })], [...Array(10).fill([401, 'client_unauthorized']), ...Array(2).fill([403, 'client_required'])]);
  // A pending member holds no client: a command answers member_pending, a route client_required.
  const pending = openClient(env, seeded.pending.key);
  assert.equal((await pending.hello()).status, 200);
  const pendingPeer = { client: pending, auth: { client_id: 'client_none', client_token: 'none' } };
  assert.deepEqual([...await run(pendingPeer), ...await routeCells(pendingPeer, w.transferId)],
    [...Array(10).fill([403, 'member_pending']), ...Array(2).fill([403, 'client_required'])]);
  // A revoked member: the socket closes without a byte, for a command and both routes.
  await env.store.revokeMember({ actorMemberId: seeded.owner.member_id, memberId: w.other.member_id });
  for (const attempt of [() => sendAs(env, w.outsider, 'team.model.offers'),
    () => partRequest(w.outsider, 'PUT', PATH(w.transferId, 0, 0), Buffer.alloc(4)),
    () => partRequest(w.outsider, 'GET', PATH(w.transferId, 0, 0))]) await assert.rejects(attempt, isClosed);
});

test('T1 role matrix: a non-party, the wrong device and the receiver as sender answer exactly an unknown id', async (t) => {
  const w = await world(t);
  const { env } = w;
  const unknownOffer = bare(await sendAs(env, w.outsider, 'team.model.offer.read', { offer_id: UNKNOWN_OFFER }));
  const unknownTransfer = bare(await sendAs(env, w.outsider, 'team.model.pause', { transfer_id: UNKNOWN_TRANSFER }));
  assert.deepEqual(unknownOffer, unknownTransfer);
  assert.deepEqual(unknownOffer[0], 403);
  const unknownRoute = {};
  for (const method of ['PUT', 'GET']) {
    const answer = await partRequest(w.outsider, method, PATH(UNKNOWN_TRANSFER, 0, 0), method === 'PUT' ? Buffer.alloc(4) : undefined);
    unknownRoute[method] = bare(answer);
  }
  assert.deepEqual(unknownRoute.PUT, [403, { ok: false,
    error: { code: 'CMP-HOST-0003', reason: 'team_not_found', retryable: false, request_id: null } }]);
  assert.deepEqual(unknownRoute.PUT, unknownRoute.GET);
  const idOperations = operations(w, 'req_np').filter(([operation]) => !['team.model.offer', 'team.model.offers'].includes(operation));
  for (const [operation, params] of idOperations) {
    assert.deepEqual(bare(await sendAs(env, w.outsider, operation, params)), unknownOffer, `non-party ${operation}`);
  }
  for (const [operation, params] of idOperations.filter(([, params]) => params.transfer_id)) {
    assert.deepEqual(bare(await sendAs(env, w.wrongDevice, operation, params)), unknownOffer, `wrong device ${operation}`);
  }
  for (const [peer, method] of [[w.outsider, 'PUT'], [w.outsider, 'GET'], [w.wrongDevice, 'PUT'], [w.wrongDevice, 'GET'],
    [w.member, 'PUT']]) {
    const answer = await partRequest(peer, method, PATH(w.transferId, 0, 0), method === 'PUT' ? Buffer.alloc(4) : undefined);
    assert.deepEqual(bare(answer), unknownRoute[method], `${method} by a non-party, the wrong device or the receiver`);
  }
  // Without an id the non-party gets its own answers: an empty list, and an offer of its own.
  assert.deepEqual(cell(await sendAs(env, w.outsider, 'team.model.offers')), [200, 'ok']);
  assert.deepEqual((await sendAs(env, w.outsider, 'team.model.offers')).json.offers, []);
  assert.deepEqual(cell(await sendAs(env, w.outsider, 'team.model.offer',
    manifest({ to: { member_id: w.seeded.owner.member_id }, requestId: 'req_np_offer' }))), [200, 'ok']);
});

test('T1 role matrix: the owner (sender) and the member (receiver) each get the relay\'s exact answer', async (t) => {
  const w = await world(t);
  const { env, owner, member } = w;
  const own = await w.offer(owner, w.seeded.member.member_id, 'req_own');
  const expectations = [
    [owner, 'team.model.offer', manifest({ to: { member_id: w.seeded.member.member_id }, requestId: 'req_o2' }), [200, 'ok']],
    [owner, 'team.model.withdraw', { offer_id: own }, [200, 'ok']],
    [owner, 'team.model.offers', {}, [200, 'ok']],
    [owner, 'team.model.offer.read', { offer_id: w.taken }, [200, 'ok']],
    [owner, 'team.model.accept', { offer_id: w.taken }, [403, 'team_not_found']],
    [owner, 'team.model.decline', { offer_id: w.taken }, [403, 'team_not_found']],
    [owner, 'team.model.pause', { transfer_id: w.transferId }, [200, 'ok']],
    [owner, 'team.model.resume', { transfer_id: w.transferId }, [200, 'ok']],
    [owner, 'team.model.complete', { transfer_id: w.transferId, ok: true }, [409, 'team_model_transfer_stale']],
    [member, 'team.model.offer', manifest({ to: { member_id: w.seeded.owner.member_id }, requestId: 'req_m1' }), [200, 'ok']],
    [member, 'team.model.withdraw', { offer_id: w.taken }, [403, 'team_not_found']],
    [member, 'team.model.offers', {}, [200, 'ok']],
    [member, 'team.model.offer.read', { offer_id: w.taken }, [200, 'ok']],
    [member, 'team.model.accept', { offer_id: w.taken }, [200, 'ok']],
    [member, 'team.model.decline', { offer_id: w.taken }, [409, 'team_model_transfer_stale']],
    [member, 'team.model.pause', { transfer_id: w.transferId }, [200, 'ok']],
    [member, 'team.model.resume', { transfer_id: w.transferId }, [200, 'ok']],
  ];
  const actual = [];
  for (const [peer, operation, params] of expectations) actual.push(cell(await sendAs(env, peer, operation, params)));
  assert.deepEqual(actual, expectations.map((row) => row[3]));
  const put = await partRequest(owner, 'PUT', PATH(w.transferId, 0, 0), Buffer.alloc(4, 9));
  assert.deepEqual([put.status, put.json], [200, { ok: true, ready: true }]);
  const get = await partRequest(member, 'GET', PATH(w.transferId, 0, 0));
  assert.deepEqual([get.status, get.body], [200, Buffer.alloc(4, 9)]);
  assert.deepEqual(cell(await sendAs(env, member, 'team.model.cancel', { transfer_id: w.transferId })), [200, 'ok']);
  assert.deepEqual(cell(await sendAs(env, owner, 'team.model.cancel', { transfer_id: w.transferId })), [200, 'ok']);
});

test('T2 closed schemas through the router: one table of refusals', async (t) => {
  const w = await world(t);
  const { env, owner } = w;
  const noRequestId = manifest({ to: { member_id: w.seeded.member.member_id } });
  delete noRequestId.request_id;
  const nine = Array.from({ length: 9 }, (_, index) => ({ index: index % 8, offset: 0 }));
  // [operation, params, expected, peer]: the owner unless named (complete is the receiver's).
  const rows = [
    ['team.model.offers', { extra: 1 }, [400, 'invalid_command_parameters']],
    ['team.model.offer', { ...manifest({ to: { member_id: w.seeded.member.member_id }, requestId: 'req_x' }), extra: 1 },
      [400, 'invalid_command_parameters']],
    ['team.model.offer', noRequestId, [400, 'invalid_command_parameters']],
    ['team.model.withdraw', { offer_id: 'offer_short' }, [400, 'invalid_command_parameters']],
    ['team.model.pause', { transfer_id: w.taken }, [400, 'invalid_command_parameters']],
    ['team.model.accept', { offer_id: w.transferId }, [400, 'invalid_command_parameters']],
    ['team.model.accept', { offer_id: w.taken, resume: nine }, [400, 'invalid_command_parameters']],
    ['team.model.complete', { transfer_id: w.transferId, ok: false, reason: 'model_planted' }, [400, 'invalid_command_parameters']],
    // The schema cannot say "reason only with ok: false"; the relay refuses it.
    ['team.model.complete', { transfer_id: w.transferId, ok: true, reason: 'model_exists' }, [400, 'team_model_request_invalid'],
      w.member],
  ];
  const actual = [];
  for (const [operation, params, , peer = owner] of rows) actual.push(cell(await sendAs(env, peer, operation, params)));
  assert.deepEqual(actual, rows.map((row) => row[2]));
});

test('T6 real sockets: a refused Content-Length reads no body byte and the client reads the refusal', async (t) => {
  const w = await world(t);
  const { env, owner } = w;
  const before = env.partRequests.length;
  const answer = await partRequest(owner, 'PUT', PATH(w.transferId, 0, 0), Buffer.alloc(6));
  assert.deepEqual([answer.status, answer.json.error.reason], [429, 'team_model_size_limit']);
  assert.equal(answer.headers.connection, 'close');
  assert.equal(env.partRequests.length, before + 1);
  assert.equal(env.partRequests.at(-1).consumed, 0, 'no body byte reached a reader');
  assert.deepEqual(env.models.resources().routes, IDLE);
});

// A part request through its own connection that the test can cut: resolves the http.ClientRequest once sent.
function rawPart(env, peer, key, method, path, { length, chunk }) {
  const client = openClient(env, key);
  const req = http.request({ agent: client.agent, host: '127.0.0.1', port: env.port, method, path,
    headers: { Host: TEAM_HOST, 'X-Client-Id': peer.auth.client_id, 'X-Client-Token': peer.auth.client_token,
      ...(length === undefined ? {} : { 'Content-Length': length, 'Content-Type': 'application/octet-stream' }) } });
  req.on('error', () => {});
  if (chunk) req.write(chunk);
  else if (length === undefined) req.end();
  req.flushHeaders();
  return { req, client };
}

test('T6 real sockets: a client gone mid-body or mid-wait leaves nothing held', async (t) => {
  const w = await world(t);
  const { env, seeded, owner, member } = w;
  const mid = rawPart(env, owner, seeded.owner.key, 'PUT', PATH(w.transferId, 0, 0), { length: 4, chunk: Buffer.alloc(2) });
  assert.equal(await waitUntil(() => env.models.resources().routes.bodyBytes === 4), true, 'reading the body');
  mid.req.destroy();
  mid.client.close();
  assert.equal(await waitUntil(() => env.models.resources().routes.requests === 0), true);
  assert.deepEqual(env.models.resources().routes, IDLE);
  const waiting = rawPart(env, member, seeded.member.key, 'GET', PATH(w.transferId, 0, 0), {});
  assert.equal(await waitUntil(() => env.models.resources().routes.waits === 1), true, 'waiting for the part');
  waiting.req.destroy();
  waiting.client.close();
  assert.equal(await waitUntil(() => env.models.resources().routes.requests === 0), true);
  assert.deepEqual(env.models.resources().routes, IDLE);
  assert.equal(env.models.resources().relay.listeners, 0);
});

test('T7 redaction through refusals: a refused route, an ended part, a router refusal; no marker in any line', async (t) => {
  const w = await world(t);
  const { env, seeded, owner, readOnly } = w;
  const answers = [];
  answers.push((await partRequest(readOnly, 'PUT', PATH(w.transferId, 0, 0), Buffer.alloc(4))).json);
  answers.push((await sendAs(env, owner, 'team.model.offer', { ...manifest({ to: { member_id: seeded.member.member_id },
    requestId: 'req_red' }), extra: MARK.display })).json);
  answers.push((await sendAs(env, owner, 'team.model.offer', { ...manifest({ to: { member_id: seeded.member.member_id },
    requestId: 'req_red2' }), display_name: '' })).json);
  answers.push((await sendAs(env, readOnly, 'team.model.offer', manifest({ to: { member_id: seeded.owner.member_id } }))).json);
  const cut = rawPart(env, owner, seeded.owner.key, 'PUT', PATH(w.transferId, 0, 0), { length: 4, chunk: Buffer.alloc(1) });
  assert.equal(await waitUntil(() => env.models.resources().routes.bodyBytes === 4), true);
  cut.req.destroy();
  cut.client.close();
  assert.equal(await waitUntil(() => env.logs.some((line) => JSON.stringify(line).includes('team_model.part_ended'))), true);
  assert.ok(answers.every((answer) => answer.ok === false), 'each was refused');
  const events = JSON.stringify(env.logs);
  for (const event of ['team_model.route_refused', 'team_model.part_ended', 'team_command']) {
    assert.ok(events.includes(event), `${event} lines were captured`);
  }
  assert.equal(clean(env.logs), true, 'no marker in a host, command or access log line');
  assert.equal(clean(answers), true, 'no marker in a failure payload');
});
