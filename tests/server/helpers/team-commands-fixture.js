'use strict';

// Shared setup for the team command tests: a real command router over a real
// member store in a temporary directory, the real authorizer over its directory,
// the real invite service, the team commands, and the fake backend of the router
// fixture. Four seats send commands as registered clients: the owner, a member
// (Alice), a read-only member (Rae) and a pending member (Pat). Every answer the
// suite receives passes through `dispatch`, which checks that no key the fixture
// ever created appears in it.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { BOOT, BackendHarness, command } = require('../../helpers/command-router-fixture');
const { ClientRegistry } = require('../../../server/client-registry');
const { CommandReceipts } = require('../../../server/command-receipts');
const { ControlLeases } = require('../../../server/control-leases');
const { createCommandRouter } = require('../../../server/command-router');
const { createAuthorizer } = require('../../../server/team/authorize');
const { createInviteService } = require('../../../server/team/invites');
const { createFixture } = require('./team-store-fixture');

async function createTeamCommandsFixture(t, {
  addresses = [], limiter = null, withTeamCommands = true, storeOverrides = {},
} = {}) {
  const fx = createFixture(null);
  const store = fx.openStore(storeOverrides);
  const owner = await fx.bootstrapOwner(store, 'Olive Owner');
  const alice = await fx.joinMember(store, owner.member_id, { displayName: 'Alice' });
  const rae = await fx.joinMember(store, owner.member_id, { displayName: 'Rae', role: 'read_only' });
  const pat = await fx.joinMember(store, owner.member_id, { displayName: 'Pat', admit: false });
  const invites = createInviteService({ store, clock: fx.clock, randomBytes: fx.randomBytes, logger: fx.logger });
  const { authorize } = createAuthorizer({ directory: store.directory });

  fs.mkdirSync(path.join(fx.dir, 'backend'));
  const backend = new BackendHarness(path.join(fx.dir, 'backend'));
  const clients = new ClientRegistry();
  const receiptsPath = path.join(fx.dir, 'command-receipts.json');
  const published = [];
  const eventStream = { publish: (type, payload) => published.push({ type, payload }) };
  let teamCommands = null;
  if (withTeamCommands) {
    const { createTeamCommands } = require('../../../server/team/team-commands');
    teamCommands = createTeamCommands({
      store, invites, directory: store.directory, addresses: () => addresses, limiter, clock: fx.clock,
      logger: fx.logger,
    });
  }
  const router = createCommandRouter({
    backend, clients, leases: new ControlLeases(), receipts: new CommandReceipts({ filePath: receiptsPath }),
    bootEpoch: BOOT, eventStream, authorize, ...(teamCommands ? { teamCommands } : {}),
  });
  t.after(() => {
    router.dispose();
    backend.dispose();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  const seatOf = (member) => ({ ...member, auth: clients.register(member.device_id) });
  const seats = {
    owner: seatOf(owner), alice: seatOf(alice), rae: seatOf(rae), pat: seatOf(pat),
  };

  // Every key text the suite can know: device keys and invite public keys.
  const keys = new Set([owner.key, alice.key, rae.key, pat.key]);
  const trackKeys = () => {
    const doc = store.snapshot();
    if (!doc) return;
    for (const device of doc.devices) keys.add(device.public_key);
    for (const invite of doc.invites) keys.add(invite.invite_public_key);
  };

  function assertNoKeys(answer) {
    // The invite string carries the host key and the invite secret by design.
    const { invite, ...rest } = answer;
    const text = JSON.stringify(rest);
    for (const key of [...keys, fx.hostKey]) assert.equal(text.includes(key), false, 'an answer carried a key');
    assert.equal(text.includes('jteam1_'), false, 'an answer carried an invite string outside `invite`');
    if (invite !== undefined) assert.match(invite, /^jteam1_[A-Za-z0-9_-]+$/u);
  }

  async function dispatch(seat, cmd) {
    trackKeys();
    const answer = await router.dispatch(cmd, {
      deviceId: seat.device_id, clientToken: seat.auth.client_token, isAuthenticated: () => true,
      actor: { device_id: seat.device_id },
    });
    trackKeys();
    assertNoKeys(answer);
    return answer;
  }

  const send = (seat, operation, params = {}) => dispatch(seat, command(seat.auth, operation, params));
  const reasonOf = (answer) => (answer.ok ? 'ok' : answer.error.reason);

  return {
    fx, store, invites, router, backend, seats, send, dispatch, reasonOf, receiptsPath, published,
    seatOf,
    // First five bytes of SHA-256 over the raw key, as ten lowercase hex characters.
    fingerprintOf: (key) => crypto.createHash('sha256').update(Buffer.from(key, 'base64url')).digest('hex').slice(0, 10),
    receiptsText: () => (fs.existsSync(receiptsPath) ? fs.readFileSync(receiptsPath, 'utf8') : ''),
    // A member added after the fixture was built (admitted unless told otherwise).
    async join(displayName, options = {}) {
      return seatOf(await fx.joinMember(store, owner.member_id, { displayName, ...options }));
    },
    async spareDevice(seat, label = 'Phone') {
      const added = await fx.addDevice(store, seat.member_id, label);
      assert.equal(added.ok, true);
      return { device_id: added.device_id, key: added.key };
    },
  };
}

module.exports = { createTeamCommandsFixture, BOOT };
