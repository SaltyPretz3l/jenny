'use strict';

// The owner-role invites, minted only by a local actor (M16, M10). A team host
// started with `--team-init` (or the headless `team-init` command) mints an
// `owner_first` invite while its store has no member; `--team-recover` (or
// `team-recover`) mints a `recovery` invite for the active owner. The owner's
// Jenny redeems either through the normal member path. The string is handed
// back to the caller and appears in no log line. The store holds the rules:
// an `owner_first` invite needs an empty store, a recovery invite an active
// owner, and both expire within 15 minutes.

const { hostFailure } = require('../api-contract');
const { pickAddressHints } = require('./invites');

async function mintAndReveal({ invites, kind, addresses }) {
  const created = await invites.create({ kind, hints: pickAddressHints(addresses) });
  if (!created.ok) return created;
  const revealed = invites.reveal(created.invite_id);
  if (!revealed.ok) return revealed;
  return { ok: true, minted: true, invite: revealed.invite, invite_id: created.invite_id, expires_at: created.expires_at };
}

async function mintOwnerInvite({ store, invites, addresses = [] }) {
  const snapshot = store.snapshot();
  if (!snapshot) return hostFailure('unavailable', 'team_unavailable');
  if (snapshot.members.length > 0) return { ok: true, minted: false };
  return mintAndReveal({ invites, kind: 'owner_first', addresses });
}

// With no active owner the store refuses (`team_member_state_invalid`).
async function mintRecoveryInvite({ invites, addresses = [] }) {
  return mintAndReveal({ invites, kind: 'recovery', addresses });
}

module.exports = { mintOwnerInvite, mintRecoveryInvite };
