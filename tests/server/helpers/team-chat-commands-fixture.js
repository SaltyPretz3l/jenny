'use strict';

// Shared setup for the team chat command tests (slice 2a-3a): a real command
// router over a real member store and a real chat store in one temporary
// profile, the real authorizer and operation registry, the team commands with
// the chat dispatcher handed in by the real chat host composition, and the fake
// backend of the router fixture. Seats send commands as registered clients:
// the owner, two members (Alice, Bob), a read-only member (Rae), a pending
// member (Pat), an invite principal and a revoked device. Every publish call
// is recorded with its options, so a test can assert the audience.

const fs = require('node:fs');
const path = require('node:path');

const { BOOT, BackendHarness, command } = require('../../helpers/command-router-fixture');
const { ClientRegistry } = require('../../../server/client-registry');
const { CommandReceipts } = require('../../../server/command-receipts');
const { ControlLeases } = require('../../../server/control-leases');
const { createCommandRouter } = require('../../../server/command-router');
const { createAuthorizer } = require('../../../server/team/authorize');
const { createInviteService } = require('../../../server/team/invites');
const { createRateLimiter } = require('../../../server/team/rate-limit');
const { createTeamCommands } = require('../../../server/team/team-commands');
const { chatRoster, createTeamChatHost } = require('../../../services/host/team-chat-host');
const { createFixture } = require('./team-store-fixture');

async function createTeamChatCommandsFixture(t, {
  beforeStart = null, maxResponseBytes, adminLimit = null, storeLimits, searchOptions, storeYield,
} = {}) {
  const fx = createFixture(null);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store, 'Olive Owner');
  const alice = await fx.joinMember(store, owner.member_id, { displayName: 'Alice' });
  const bob = await fx.joinMember(store, owner.member_id, { displayName: 'Bob' });
  const rae = await fx.joinMember(store, owner.member_id, { displayName: 'Rae', role: 'read_only' });
  const pat = await fx.joinMember(store, owner.member_id, { displayName: 'Pat', admit: false });
  const gone = await fx.joinMember(store, owner.member_id, { displayName: 'Gone' });
  const invitePublicKey = fx.nextKey('chat-invite');
  const invite = await store.createInvite({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member',
    invitePublicKey });
  const invites = createInviteService({ store, clock: fx.clock, randomBytes: fx.randomBytes, logger: fx.logger });
  const { authorize } = createAuthorizer({ directory: store.directory });

  if (beforeStart) beforeStart(fx);
  const published = [];
  const eventStream = { publish: (type, payload, options) => published.push({ type, payload, options }) };
  const chat = createTeamChatHost({
    profileDir: fx.dir, directory: store.directory, logger: fx.logger, clock: fx.clock,
    randomBytes: fx.randomBytes, publish: (type, payload, options) => eventStream.publish(type, payload, options),
    ...(maxResponseBytes ? { maxResponseBytes } : {}), ...(storeLimits ? { storeLimits } : {}),
    // Slice 2a-3b: the overview roster as team-main composes it, search and load hooks.
    roster: chatRoster(store), ...(searchOptions ? { searchOptions } : {}), ...(storeYield ? { storeYield } : {}),
  });
  const teamCommands = createTeamCommands({
    store, invites, directory: store.directory, clock: fx.clock, logger: fx.logger, chat: chat.commands,
    limiter: adminLimit ? createRateLimiter({ limit: adminLimit, windowMs: 60_000, maxKeys: 64, clock: fx.clock }) : null,
  });
  fs.mkdirSync(path.join(fx.dir, 'backend'));
  const backend = new BackendHarness(path.join(fx.dir, 'backend'));
  const clients = new ClientRegistry();
  let admit = true;
  const router = createCommandRouter({
    backend, clients, leases: new ControlLeases(),
    receipts: new CommandReceipts({ filePath: path.join(fx.dir, 'command-receipts.json') }),
    bootEpoch: BOOT, eventStream, authorize, teamCommands, canAdmit: () => admit,
  });
  await chat.start();

  // The revoked seat: Gone's device, revoked after it registered a client.
  const seatOf = (member) => ({ ...member, auth: clients.register(member.device_id) });
  const seats = {
    owner: seatOf(owner), alice: seatOf(alice), bob: seatOf(bob), rae: seatOf(rae), pat: seatOf(pat),
    invite: { member_id: null, device_id: invite.invite_id, auth: clients.register(invite.invite_id) },
    revoked: seatOf(gone),
  };
  const revoked = await store.revokeDevice({ actorMemberId: owner.member_id, deviceId: gone.device_id });
  if (!revoked.ok) throw new Error(`revoke failed: ${revoked.error.reason}`);

  t.after(async () => {
    await chat.dispose();
    router.dispose();
    backend.dispose();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  async function dispatch(seat, cmd, contextOverrides = {}) {
    return router.dispatch(cmd, {
      deviceId: seat.device_id, clientToken: seat.auth.client_token, isAuthenticated: () => true,
      actor: { device_id: seat.device_id }, ...contextOverrides,
    });
  }
  const send = (seat, operation, params = {}) => dispatch(seat, command(seat.auth, operation, params));
  const reasonOf = (answer) => (answer.ok ? 'ok' : answer.error.reason);
  const chatEvents = () => published.filter((entry) => entry.type.startsWith('team_chat_'));

  return {
    fx, store, chat, router, seats, send, dispatch, command, reasonOf, published, chatEvents,
    setAdmit(value) { admit = value; },
    receiptsPath: path.join(fx.dir, 'command-receipts.json'),
    async post(seat, text, extra = {}) {
      const answer = await send(seat, 'team.chat.post', { channel_id: 'chan_team', text, ...extra });
      if (!answer.ok) throw new Error(`post failed: ${answer.error.reason}`);
      return answer;
    },
  };
}

module.exports = { createTeamChatCommandsFixture, BOOT };
