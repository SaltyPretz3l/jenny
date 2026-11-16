'use strict';

// `team-init` and `team-recover`: the headless owner invites (M16, M10). Both
// run with the team server stopped and share one path: the config (a team block
// with `key_source: 'secret_file'`; the desktop uses the start flags instead),
// the profile lock, the host key from the mounted secret file, the member store
// opened as the team host opens it, one mint through the invite service, and
// the string printed once on the terminal. The lock is released on every path.
//
// Fail closed: a missing terminal, config, lock, key or store is a refusal with
// a reason and nothing minted; so is a delete or restore marker, or a cut
// restore's staging (checked under the lock, before the key is read). The
// terminal check comes first, so the string can never be redirected into a
// file or a captured log. The invite string and
// its secret reach only that terminal: never a log line, the result, an error
// or a file (the store keeps only the invite's public key).
//
// With internet joining on the invite is version 2 with IPv6 hints, ordered as
// an internet invite's; it carries no mapping and no relay token (none here).

const crypto = require('node:crypto');
const os = require('node:os');

const { FileSecretStore, TEAM_HOST_SECRET_FILES } = require('../file-secret-store');
const { acquireConfiguredProfile } = require('../host-core');
const { HOST_ERROR_CODES } = require('../../services/backend/error-codes');
const { assertSafeFile } = require('../../services/host/path-guard');
const { PUBLIC_KEY_BYTES, decodeBase64url, keyPairFromSeed } = require('./ids');
const { createInviteService, inviteContent, pickAddressHints } = require('./invites');
const { loadSecretFileTeamConfig } = require('./keygen');
const { LOCAL_COMMAND } = require('./member-schema');
const { MemberStore } = require('./member-store');
const { mintOwnerInvite, mintRecoveryInvite } = require('./owner-bootstrap');
const { safeLogger } = require('./safe-logger');
const { unfinishedWork } = require('./team-maintenance');

const KINDS = Object.freeze({ owner_first: 'first owner', recovery: 'owner recovery' });

function refusal(reason) {
  return { ok: false, reason };
}

// Operational log lines go to standard error, apart from the terminal text.
function stderrLog(level, event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}

const isFamily = (entry, name, number) => entry.family === name || entry.family === number;

// The host is stopped, so the bridge cannot report its addresses: with a direct
// port, the hints are this machine's non-internal IPv4 addresses on that port,
// and with internet joining on its IPv6 addresses too, for the invite to order.
function localAddressHints(networkInterfaces, directPort, { ipv6 = false } = {}) {
  if (!Number.isInteger(directPort)) return [];
  let table;
  try { table = networkInterfaces(); } catch { return []; }
  const addresses = [];
  for (const entries of Object.values(table ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.internal) continue;
      if (isFamily(entry, 'IPv4', 4)) addresses.push(`${entry.address}:${directPort}`);
      else if (ipv6 && isFamily(entry, 'IPv6', 6)) addresses.push(`[${String(entry.address).split('%')[0]}]:${directPort}`);
    }
  }
  return ipv6 ? addresses : pickAddressHints(addresses);
}

// The headless invite's internet setting as invites.js `inviteContent` takes it: null while off.
function headlessInternet(team) {
  const internet = team.internet ?? null;
  if (!internet) return null;
  return { direct_port: team.directPort, mapped: null, public_address: internet.publicAddress,
    relay_url: internet.relayUrl, relay_token: null };
}

// Only a busy lock (the server or another command holds the profile) reads as
// locked; an ownership refusal or any other failure is unavailable.
function lockReason(error) {
  return error?.code === HOST_ERROR_CODES.CONFLICT && error.reason === 'profile_locked'
    ? 'team_profile_locked' : 'team_unavailable';
}

function render({ kind, teamId, invite, expiresAt, hints, directPort }) {
  let where;
  if (hints > 0) where = `Address hints: ${hints} (direct port ${directPort}).`;
  else if (directPort === null) where = 'No address hints: team.direct_port is not set, so give the joiner the host address another way.';
  else where = `No address hints: no network address was found for direct port ${directPort}.`;
  const effect = kind === 'recovery'
    ? 'Redeeming it signs out every other device of the owner.\n' : '';
  return `Team ${teamId}: ${KINDS[kind]} invite. It is shown once and stored nowhere.\n\n  ${invite}\n\n`
    + `Expires at ${new Date(expiresAt).toISOString()} (within 15 minutes).\n${where}\n${effect}`;
}

async function mintLocalOwnerInvite({
  kind, configPath, output = process.stdout, acquireProfileImpl, networkInterfaces = os.networkInterfaces,
  clock = Date.now, randomBytes = crypto.randomBytes, logger = null,
} = {}) {
  if (!Object.hasOwn(KINDS, kind)) return refusal('team_invite_malformed');
  if (output?.isTTY !== true || typeof output.write !== 'function') return refusal('team_tty_required');
  const preflight = loadSecretFileTeamConfig(configPath);
  if (!preflight.ok) return preflight;
  const say = safeLogger(logger);

  let lock = null;
  let seed = null;
  try {
    let acquired;
    try {
      acquired = await acquireConfiguredProfile(configPath, { acquireProfileImpl });
    } catch (error) {
      return refusal(lockReason(error));
    }
    lock = acquired.lock;
    const { config } = acquired;
    if (!config.team) return refusal('team_config_required');
    if (config.team.keySource !== 'secret_file') return refusal('team_key_source_invalid');
    // A half-done delete or restore is finished by its own command (review sweep X4c-F05, F03): nothing is read,
    // written or minted over it, with the start's word (or `team_restore_unfinished` beside a cut restore's staging).
    const unfinished = unfinishedWork(config);
    if (unfinished) return refusal(unfinished);

    let value = null;
    try {
      value = new FileSecretStore({ directory: config.secretsDir, files: TEAM_HOST_SECRET_FILES }).get('team_host_key');
    } catch { value = null; }
    seed = decodeBase64url(value, PUBLIC_KEY_BYTES);
    if (!seed) return refusal('team_host_key_invalid');
    const { publicKey } = keyPairFromSeed(seed);
    seed.fill(0);

    const store = new MemberStore({ userDataPath: config.userDataPath, hostPublicKey: publicKey,
      teamName: config.team.name, clock, randomBytes, logger, assertSafePath: assertSafeFile });
    const opened = store.open();
    if (!opened.ok) return refusal(opened.error.reason);
    const invites = createInviteService({ store, clock, randomBytes, logger });
    const internet = headlessInternet(config.team);
    const addresses = localAddressHints(networkInterfaces, config.team.directPort, { ipv6: internet !== null });
    const minted = kind === 'owner_first'
      ? await mintOwnerInvite({ store, invites, addresses, internet })
      : await mintRecoveryInvite({ invites, addresses, internet });
    if (!minted.ok) return refusal(minted.error.reason);
    if (!minted.minted) return refusal('team_member_state_invalid');
    // The count the invite carries: as listed while off, the ordered hints while on.
    const hints = internet === null ? addresses.length : inviteContent(internet, addresses).hints.length;

    try {
      output.write(render({ kind, teamId: store.teamId(), invite: minted.invite, expiresAt: minted.expires_at,
        hints, directPort: config.team.directPort }));
    } catch {
      // Nobody holds the string: revoke the invite rather than leave it live for 15 minutes.
      const revoked = await invites.revoke({ actorMemberId: LOCAL_COMMAND, inviteId: minted.invite_id });
      say('ERROR', 'team.local_invite.print_failed', { kind, revoked: revoked.ok === true });
      return refusal('team_unavailable');
    }
    say('INFO', 'team.local_invite.printed', { kind, hints });
    return { ok: true, invite_id: minted.invite_id, expires_at: minted.expires_at, team_id: store.teamId(),
      hints };
  } catch {
    say('ERROR', 'team.local_invite.failed', { kind });
    return refusal('team_unavailable');
  } finally {
    seed?.fill(0);
    if (lock) {
      try { await lock.release(); } catch { say('ERROR', 'team.local_invite.lock_release_failed', { kind }); }
    }
  }
}

module.exports = { mintLocalOwnerInvite, stderrLog };
