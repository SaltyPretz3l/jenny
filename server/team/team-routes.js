'use strict';

// The team host's own routes (TEAM_MEMBERSHIP_SPEC "Invites and joining" and
// "Version handshake"): hello, status, join, leave and the team bootstrap.
// Each handler calls the per-request guard with the action the registry names
// for its route and answers the guard's failure unchanged; none checks a role
// itself. Logs carry event names and reasons only.

const { hostFailure } = require('../api-contract');
const {
  json, readJson, requireBodyless, sendHostFailure,
} = require('../http-server');
const { createRateLimiter } = require('./rate-limit');
const { safeLogger } = require('./safe-logger');

const API_VERSION = 1;
const PROTOCOL_RANGE = Object.freeze({ min: 1, max: 1 });
const JOIN_PER_INVITE = Object.freeze({ limit: 5, windowMs: 60_000, maxKeys: 64 });
const JOIN_OVERALL = Object.freeze({ limit: 20, windowMs: 60_000, maxKeys: 1 });
const JOIN_OVERALL_KEY = 'all_invites';
const TEAM_RESOURCE = Object.freeze({ kind: 'team', id: '' });
const HELLO_VERSION_MAX = 65535;
const HELLO_APP_VERSION_MAX = 32;
const SMALL_BODY_BYTES = 4096;

function hostAppVersion() {
  try {
    const { version } = require('../../package.json');
    return typeof version === 'string' && version ? version.slice(0, HELLO_APP_VERSION_MAX) : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** True when the guard allows the route's action; otherwise answers its failure and returns false. */
function permit(ctx, resource = TEAM_RESOURCE) {
  let verdict;
  try { verdict = ctx.guard(ctx.action, resource); } catch { verdict = null; }
  if (verdict && verdict.ok === true) return true;
  const denial = verdict && verdict.ok === false && verdict.error
    ? verdict : hostFailure('forbidden', 'role_forbidden', ctx.requestId);
  sendHostFailure(ctx.response, denial, ctx.requestId);
  return false;
}

// The shape `readJson` wants: a size ceiling and a parser that accepts one JSON object.
function jsonReader(maxBodyBytes) {
  return { maxBodyBytes, parseJsonBody: (body) => {
    try {
      const value = JSON.parse(Buffer.from(body).toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false };
    } catch { return { ok: false }; }
  } };
}

function invalidBody(ctx) {
  sendHostFailure(ctx.response, hostFailure('invalid', 'request_failed', ctx.requestId), ctx.requestId);
}

function unavailable(ctx) {
  sendHostFailure(ctx.response, hostFailure('unavailable', 'team_unavailable', ctx.requestId, true), ctx.requestId);
}

function hasExactStrings(value, keys) {
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((key) => typeof value[key] === 'string');
}

// Answers once the response has finished, then ends the connection and drops the key.
function endConnectionAfterResponse(ctx, context) {
  const { request, response } = ctx;
  const teamKey = request.socket.teamKey;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    request.socket.destroy();
    try { context.dropKey(teamKey); } catch { /* the socket is already gone */ }
  };
  if (response.writableFinished) finish();
  else { response.once('finish', finish); response.once('close', finish); }
}

function createTeamRoutes(context) {
  const log = safeLogger(context.logger);
  const perInvite = createRateLimiter(JOIN_PER_INVITE);
  const overall = createRateLimiter(JOIN_OVERALL);
  const appVersion = hostAppVersion();

  async function hello(ctx) {
    if (!permit(ctx)) return;
    const { value } = await readJson(ctx.request, jsonReader(SMALL_BODY_BYTES), SMALL_BODY_BYTES);
    const names = Object.keys(value);
    // Version 0 is a well-formed version that is below the supported range.
    if (names.length !== 2 || !Number.isSafeInteger(value.protocol_version) || value.protocol_version < 0
      || value.protocol_version > HELLO_VERSION_MAX || typeof value.app_version !== 'string'
      || value.app_version.length < 1 || value.app_version.length > HELLO_APP_VERSION_MAX) {
      invalidBody(ctx); return;
    }
    if (!permit(ctx)) return;
    const tooOld = value.protocol_version < PROTOCOL_RANGE.min;
    if (tooOld || value.protocol_version > PROTOCOL_RANGE.max) {
      log('INFO', 'team.hello_version_refused', { reason: tooOld ? 'team_client_too_old' : 'team_server_too_old' });
      sendHostFailure(ctx.response, hostFailure('conflict', tooOld ? 'team_client_too_old' : 'team_server_too_old',
        ctx.requestId), ctx.requestId);
      endConnectionAfterResponse(ctx, context);
      return;
    }
    ctx.markHello();
    json(ctx.response, 200, { ok: true, api_version: API_VERSION, protocol: { ...PROTOCOL_RANGE },
      team_id: context.store.teamId(), app_version: appVersion, addresses: context.addresses() });
  }

  function status(ctx) {
    requireBodyless(ctx.request);
    if (!permit(ctx)) return;
    const live = context.directory.liveActor(ctx.deviceId);
    const teamName = context.store.teamName();
    if (!live || teamName === null) { unavailable(ctx); return; }
    json(ctx.response, 200, { ok: true, team_id: context.store.teamId(), team_name: teamName,
      member_id: live.member_id, device_id: live.device_id, role: live.role, state: live.state });
  }

  async function join(ctx) {
    if (!permit(ctx, { kind: 'invite', id: ctx.actor.device_id })) return;
    // Both limits count the attempt before the body or the store is touched.
    const allowedForInvite = perInvite.take(ctx.actor.device_id);
    const allowedOverall = overall.take(JOIN_OVERALL_KEY);
    if (!allowedForInvite || !allowedOverall) {
      log('WARN', 'team.join_rate_limited', { scope: allowedForInvite ? 'overall' : 'invite' });
      sendHostFailure(ctx.response, hostFailure('limit', 'team_rate_limit', ctx.requestId), ctx.requestId);
      return;
    }
    const { value } = await readJson(ctx.request, jsonReader(SMALL_BODY_BYTES), SMALL_BODY_BYTES);
    if (!hasExactStrings(value, ['device_public_key', 'display_name', 'label'])) { invalidBody(ctx); return; }
    if (!permit(ctx, { kind: 'invite', id: ctx.actor.device_id })) return;
    const redeemed = await context.invites.redeem({ inviteId: ctx.actor.device_id,
      devicePublicKey: value.device_public_key, displayName: value.display_name, label: value.label });
    // The invite is spent by this very call, so the actor is no longer live: answer the store's result as is.
    if (!redeemed.ok) { sendHostFailure(ctx.response, redeemed, ctx.requestId); return; }
    // A spent invite never speaks again: its hello entry must not push a live device's out.
    ctx.forgetHello();
    endConnectionAfterResponse(ctx, context);
    json(ctx.response, 200, { ok: true, member_id: redeemed.member_id, device_id: redeemed.device_id,
      state: redeemed.state });
    try { context.notifyMembership('member_joined', redeemed.member_id); } catch { log('WARN', 'team.notify_failed'); }
    log('INFO', 'team.member_joined', { member_id: redeemed.member_id });
  }

  async function leave(ctx) {
    requireBodyless(ctx.request);
    if (!permit(ctx)) return;
    // The member's own revocation ends this actor: answer the store's result as is.
    const left = await context.store.leave({ memberId: ctx.actor.member_id });
    if (!left.ok) { sendHostFailure(ctx.response, left, ctx.requestId); return; }
    json(ctx.response, 200, { ok: true });
  }

  function bootstrap(ctx) {
    if (!permit(ctx)) return;
    const live = context.directory.liveActor(ctx.deviceId);
    const teamName = context.store.teamName();
    if (!live || teamName === null) { unavailable(ctx); return; }
    json(ctx.response, 200, { ok: true, api_version: API_VERSION, boot_epoch: context.bootEpoch,
      ready: context.isReady(), team: { team_id: context.store.teamId(), name: teamName },
      member: { member_id: live.member_id, role: live.role, state: live.state }, tools: { execution: false } });
  }

  return { hello, status, join, leave, bootstrap };
}

module.exports = { PROTOCOL_RANGE, createTeamRoutes, jsonReader, permit };
