'use strict';

// Model sharing over the real team HTTP server (slice 6-3 tests): the host with the sharing built on the relay's
// small test limits, the seeded members plus a non-party member and a second device of member a, a part request
// with the client's headers, and the model frames a member's event stream received.

const { createTeamModelSharing } = require('../../../server/team/model-sharing');
const { SMALL } = require('./model-relay-fixture');
const { createTeamHttpFixture } = require('./team-http-fixture');

// `requests` collects each part route's real request with `consumed`: the body bytes a 'data' event handed on
// before the answer was sent (counted without reading anything itself; Node drains what is left after the answer).
async function modelHttpEnv(t, sharingOptions = {}) {
  const requests = [];
  const spy = (sharing) => ({ ...sharing, routes: (ctx) => {
    const { request } = ctx;
    request.consumed = 0;
    const emit = request.emit;
    request.emit = function emitCounted(event, ...args) {
      if (event === 'data' && !ctx.response.writableEnded) request.consumed += args[0].length;
      return emit.call(this, event, ...args);
    };
    requests.push(request);
    return sharing.routes(ctx);
  } });
  const env = await createTeamHttpFixture(t, {
    models: (inputs) => spy(createTeamModelSharing({ ...inputs, limits: SMALL, ...sharingOptions })),
  });
  env.partRequests = requests;
  const seeded = await env.seed();
  const other = await env.redeemDirect({ actor: seeded.owner.member_id, role: 'member', name: 'Noa Nonparty' });
  await env.store.admit({ actorMemberId: seeded.owner.member_id, memberId: other.member_id });
  const phone = await env.redeemDirect({ kind: 'add_device', actor: seeded.member.member_id, name: 'x', label: 'Phone' });
  return { env, seeded, other, phone };
}

function partRequest(peer, method, path, body, extraHeaders = {}) {
  return peer.client.request(method, path, { rawBody: body, headers: { 'X-Client-Id': peer.auth.client_id,
    'X-Client-Token': peer.auth.client_token, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
    ...extraHeaders } });
}

const modelFrames = (stream) => stream.frames.join('').split('\n').filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6))).filter((frame) => String(frame.event_type).startsWith('team_model_'));

module.exports = { modelFrames, modelHttpEnv, partRequest };
