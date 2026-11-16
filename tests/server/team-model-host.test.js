'use strict';

// new-test-file: model sharing inside a real team host (startTeamHost, slice 6-3 fix list T3). Each check fails if
// team-main.js drops one wiring: the part routes in the raw-route chain, the command family in the router, the
// attach list in the teardown, the models entry in the member-stream fan-out, or the setting. Then the switches
// through the real teardown: setting 0, host stop and the parent's stop message (the path Force local takes, E64).

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRouteGuard } = require('../../server/team/route-guard');
const { createTeamHostFixture } = require('./helpers/team-host-fixture');
const { PATH, fakeRequest, fakeResponse } = require('./helpers/team-model-fixture');

const BOUNDED = Object.freeze({ timeout: 20_000 });
const UNKNOWN = `mxfer_${'Q'.repeat(22)}`;

async function startHost(t, team = {}) {
  const fx = createTeamHostFixture(t);
  fx.writeConfig({ team });
  const seeded = await fx.seedMembers(fx.client().deviceKey);
  const parent = fx.newParent();
  const host = await fx.start(parent);
  return { fx, host, parent, context: fx.context(), seeded };
}

// A command through the host's router, as the owner's registered client.
function sendAsOwner(context, seeded, operation, params = {}) {
  const deviceId = seeded.owner.device_id;
  const auth = context.clients.register(deviceId);
  return context.router.dispatch({ api_version: 1, operation, request_id: `req_${operation.replaceAll('.', '_')}`,
    client_id: auth.client_id, boot_epoch: context.bootEpoch, params },
  { deviceId, clientToken: auth.client_token, isAuthenticated: () => true,
    actor: { member_id: seeded.owner.member_id, device_id: deviceId } });
}

// A part GET through the raw-route chain the listener calls, as the owner.
async function partAsOwner(routes, context, seeded) {
  const actor = { member_id: seeded.owner.member_id, device_id: seeded.owner.device_id };
  const auth = context.clients.register(actor.device_id);
  const request = fakeRequest('GET');
  request.headers = { 'x-client-id': auth.client_id, 'x-client-token': auth.client_token };
  const response = fakeResponse();
  const ctx = { request, response, pathname: PATH(UNKNOWN, 0, 0), deviceId: actor.device_id, requestId: 'req_host',
    actor, clientId: auth.client_id, authorized: () => true,
    guard: createRouteGuard({ authorize: context.authorize, actor }) };
  const handled = await routes(ctx);
  return { handled, status: response.status, reason: response.json()?.error?.reason };
}

const reasonOf = (answer) => (answer?.ok ? 'ok' : answer?.error?.reason);

test('team-main wires the routes, the family, the attach list, the stream fan-out and the setting', BOUNDED, async (t) => {
  const { host, context, seeded } = await startHost(t, { model_relay_flowing: 3 });
  const { models } = context;
  // The setting reaches the relay.
  assert.deepEqual([models.resources().on, models.resources().relay.flowingLimit, models.resources().sweepTimers], [true, 3, 1]);
  // The family answers through the router (the relay's own empty list).
  const listed = await sendAsOwner(context, seeded, 'team.model.offers');
  assert.deepEqual([listed.ok, listed.offers, listed.transfers], [true, [], []]);
  // The routes answer through the listener's raw-route chain (the relay's one not-found for an unknown id).
  assert.deepEqual(await partAsOwner(context.assetRoutes, context, seeded), { handled: true, status: 403, reason: 'team_not_found' });
  // The stream fan-out reaches model sharing.
  const devices = models.resources().devices;
  context.onMemberStream(seeded.owner.member_id, seeded.owner.device_id, 'open');
  assert.equal(models.resources().devices, devices + 1);
  context.onMemberStream(seeded.owner.member_id, seeded.owner.device_id, 'close');
  // The attach list is in the teardown: host stop disposes model sharing.
  await host.stop();
  assert.deepEqual([models.resources().disposed, models.resources().relay, models.resources().sweepTimers], [true, null, 0]);
  assert.equal(reasonOf(models.commands.dispatch({ operation: 'team.model.offers', params: {} },
    { params: {}, actor: { member_id: seeded.owner.member_id, device_id: seeded.owner.device_id } })), 'host_unavailable');
  assert.deepEqual(await partAsOwner(models.routes, context, seeded), { handled: true, status: 503, reason: 'host_unavailable' });
});

test('setting 0 in the config: the router and the routes answer only team_model_sharing_off, no relay, no timer', BOUNDED, async (t) => {
  const { context, seeded, fx } = await startHost(t, { model_relay_flowing: 0 });
  assert.equal(reasonOf(await sendAsOwner(context, seeded, 'team.model.offers')), 'team_model_sharing_off');
  assert.deepEqual(await partAsOwner(context.assetRoutes, context, seeded),
    { handled: true, status: 503, reason: 'team_model_sharing_off' });
  assert.deepEqual([context.models.resources().relay, context.models.resources().sweepTimers], [null, 0]);
  assert.equal(fx.logs.some((entry) => entry.event === 'team_model.sharing_on'), false);
});

test('the parent\'s stop message (Force local stops the host this way) disposes model sharing like host stop', BOUNDED, async (t) => {
  const { host, parent, context, seeded, fx } = await startHost(t);
  assert.equal(context.models.resources().on, true, 'absent setting: the default, on');
  parent.emit({ type: 'stop' });
  await host.stopped;
  assert.equal(parent.sent.at(-1).type, 'stopped');
  assert.equal(context.models.resources().disposed, true);
  assert.deepEqual([context.models.resources().relay, context.models.resources().sweepTimers], [null, 0]);
  assert.deepEqual(await partAsOwner(context.models.routes, context, seeded), { handled: true, status: 503, reason: 'host_unavailable' });
  const stoppedLog = fx.logs.find((entry) => entry.event === 'team_model.sharing_stopped');
  assert.deepEqual(stoppedLog?.fields, { reason: 'host_stopping' });
});
