'use strict';

// Joining a team from an invite string (TEAM_MEMBERSHIP_SPEC "Invites and
// joining"): parse it before any network; refuse when this Jenny already holds
// a device key or a directory for that team (whatever the caller's in-memory
// view says, so a join can never overwrite a membership); make the device seed
// and save it to the secure store before redeeming (a failed save stops the join
// with nothing redeemed); connect with the invite key as the transport identity,
// hello, redeem with the device public key, then reconnect with the device key
// and read `team.status`. When the redeem answer is lost the device key is tried
// first: a recognised device means the redeem happened; a refused one means it
// did not, and the redeem is tried once more. A failed join removes only what it
// created: its own key and its own client file. `abort()` (the app is quitting)
// stops every bridge of the join in progress; that join then fails with
// CMP-TEAM-0005 and cleans up the same way. The invite string and both secret
// keys are never logged, written or returned; logs carry the team id and a
// reason only.
//
// Two callers inside the main process add to that (slice 1f-2): the owner's join
// of its own host may dial extra addresses (the loopback fallback for a
// self-dial), and `recover` redeems an owner recovery invite for a team this
// Jenny may already hold. Recovery keeps the new seed in memory until the host
// has confirmed the redeem; only then are the stored key and the client file
// replaced, so a failed recovery leaves both exactly as they were. Ordinary
// joins keep refusing a team this Jenny already holds.

const crypto = require('node:crypto');

const { PUBLIC_KEY_BYTES, keyPairFromSeed } = require('../../server/team/ids');
const { parseInvite } = require('../../server/team/invites');
const { cleanAddresses, openLink } = require('./bridge-link');
const { removeMembership, teamDirExists } = require('./client-file');
const { TeamError, VERSION_REASONS, failureOf, invalidRequest, teamFailure } = require('./team-errors');

const LINK_REASONS = Object.freeze({ host_refused: 'invite_not_valid', host_unreachable: 'team_unreachable',
  closed: 'team_unreachable' });

class JoinStop extends Error {
  constructor(answer) {
    super('join_stopped');
    this.answer = answer;
  }
}

const stoppedAnswer = () => teamFailure('HOST_STOPPED', 'team_connection_stopped');

function createJoin(deps) {
  const {
    deviceKeys, userDataPath, spawnChild, appVersion, protocolVersion, requestTimeoutMs, createBridge,
    now = Date.now, log = () => {},
  } = deps;
  const linkBase = { spawnChild, appVersion, protocolVersion, requestTimeoutMs, createBridge };
  const bridges = new Set();
  let aborted = false;

  // Opens one link whose bridge `abort()` can stop while it is still dialling.
  async function open(options) {
    if (aborted) throw new JoinStop(stoppedAnswer());
    let bridge = null;
    const opened = await openLink({ ...options, onBridge: (started) => {
      bridge = started;
      bridges.add(started);
      if (aborted) void started.stop();
    } });
    if (!opened.ok && bridge) bridges.delete(bridge);
    if (aborted) {
      if (opened.ok) await closeLink(opened.link);
      throw new JoinStop(stoppedAnswer());
    }
    return opened;
  }

  async function closeLink(link) {
    await link.close();
    bridges.delete(link.bridge);
  }

  // Opens a link, says hello and checks the team; throws JoinStop with the answer to give on failure.
  async function greet(teamId, linkOptions, linkReasons = LINK_REASONS) {
    const opened = await open(linkOptions);
    if (!opened.ok) throw new JoinStop(teamFailure('CONNECTION_FAILED', linkReasons[opened.reason] || 'team_unreachable'));
    const { link } = opened;
    try {
      const hello = await link.session.hello();
      if (!hello.ok) {
        throw new JoinStop(VERSION_REASONS.has(hello.error.reason)
          ? teamFailure('VERSION_MISMATCH', hello.error.reason) : hello);
      }
      if (hello.team_id !== teamId) throw new JoinStop(teamFailure('CONNECTION_FAILED', 'team_identity_mismatch'));
      return { link, reported: Array.isArray(hello.addresses) ? hello.addresses : [] };
    } catch (error) {
      // A refused key may finish the dial and be closed right after: the bridge's reason decides.
      const refused = error instanceof TeamError && error.reset && (await link.offlineReason()) === 'host_refused';
      await closeLink(link);
      if (refused) throw new JoinStop(teamFailure('CONNECTION_FAILED', linkReasons.host_refused));
      if (error instanceof JoinStop) throw error;
      throw new JoinStop(failureOf(error));
    }
  }

  // One redeem over the invite key. Resolves { answer } or { lost: true }; throws JoinStop.
  async function redeemOnce(parsed, devicePublicKey, displayName, label, extraAddresses) {
    const inviteKey = Buffer.from(parsed.invite_secret_key, 'base64url');
    let greeted;
    try {
      greeted = await greet(parsed.team_id, { ...linkBase, secretKey: inviteKey,
        hostPublicKey: Buffer.from(parsed.host_public_key, 'base64url'),
        addresses: cleanAddresses([...parsed.hints, ...extraAddresses]) });
    } finally {
      inviteKey.fill(0);
    }
    try {
      const answer = await greeted.link.session.redeem({ devicePublicKey, displayName, label });
      if (!answer.ok) throw new JoinStop(answer);
      return { answer, reported: greeted.reported };
    } catch (error) {
      if (error instanceof TeamError && error.reset) return { lost: true, reported: greeted.reported };
      if (error instanceof JoinStop) throw error;
      throw new JoinStop(failureOf(error));
    } finally {
      await closeLink(greeted.link);
    }
  }

  // Connects with the device key and reads team.status. Resolves { status, working } or { refused | unreachable }.
  async function verifyDevice(parsed, seed, addresses) {
    let greeted;
    try {
      greeted = await greet(parsed.team_id, { ...linkBase, secretKey: seed,
        hostPublicKey: Buffer.from(parsed.host_public_key, 'base64url'), addresses },
      { host_refused: 'refused', host_unreachable: 'unreachable', closed: 'unreachable' });
    } catch (error) {
      const reason = error.answer?.error?.reason;
      if (reason === 'refused' || reason === 'unreachable') return { [reason]: true };
      throw error;
    }
    try {
      const status = await greeted.link.session.status();
      if (!status.ok) return { refused: true };
      return { status, working: [...greeted.link.workingAddresses(), ...greeted.reported] };
    } catch {
      return (await greeted.link.offlineReason()) === 'host_refused' ? { refused: true } : { unreachable: true };
    } finally {
      await closeLink(greeted.link);
    }
  }

  async function redeemAndVerify(parsed, seed, displayName, label, extraAddresses = []) {
    const devicePublicKey = keyPairFromSeed(seed).publicKey;
    let redeemed = await redeemOnce(parsed, devicePublicKey, displayName, label, extraAddresses);
    const dial = () => cleanAddresses([...parsed.hints, ...extraAddresses, ...redeemed.reported]);
    let verified = await verifyDevice(parsed, seed, dial());
    if (redeemed.lost && verified.refused) {
      // The redeem never reached the host: the invite is still live, so redeem once more.
      redeemed = await redeemOnce(parsed, devicePublicKey, displayName, label, extraAddresses);
      verified = await verifyDevice(parsed, seed, dial());
    }
    if (verified.status) {
      const { status } = verified;
      return { member_id: status.member_id, device_id: status.device_id, state: status.state, working: verified.working };
    }
    if (redeemed.answer && verified.unreachable) {
      const { answer } = redeemed;
      return { member_id: answer.member_id, device_id: answer.device_id, state: answer.state, working: dial() };
    }
    throw new JoinStop(teamFailure('CONNECTION_FAILED', verified.refused ? 'team_join_refused' : 'team_join_unconfirmed'));
  }

  function recordOf(parsed, joined, displayName) {
    return {
      schema_version: 1, team_id: parsed.team_id, host_public_key: parsed.host_public_key,
      address_hints: [...parsed.hints], last_addresses: cleanAddresses(joined.working),
      member_id: joined.member_id, device_id: joined.device_id, display_name: displayName,
      joined_at: new Date(now()).toISOString(), state_seen: joined.state,
    };
  }

  // True when this Jenny already holds anything of that team: a stored key or its directory.
  function alreadyHeld(teamId) {
    return deviceKeys.has(teamId) || teamDirExists(userDataPath, teamId);
  }

  /**
   * Resolves { ok: true, record } (the client file record, already written) or a failure.
   * `admit(teamId)` returns null to go ahead or a failure to refuse before any key is made.
   * `writeRecord(record)` saves the client file and returns { ok }.
   */
  async function join({ invite, displayName, label, extraAddresses = [] }, { admit, writeRecord }) {
    if (aborted) return stoppedAnswer();
    const parsed = parseInvite(invite);
    if (!parsed.ok) return teamFailure('INVITE_MALFORMED', 'team_invite_malformed');
    const teamId = parsed.team_id;
    const refused = admit(teamId);
    if (refused) return refused;
    if (!deviceKeys.available()) return teamFailure('DEVICE_KEY_UNAVAILABLE', 'team_device_key_unavailable');
    try {
      if (alreadyHeld(teamId)) return invalidRequest('team_already_joined');
    } catch (error) {
      return failureOf(error);
    }
    const seed = crypto.randomBytes(PUBLIC_KEY_BYTES);
    try {
      deviceKeys.save(teamId, seed);
    } catch (error) {
      seed.fill(0);
      return failureOf(error);
    }
    const created = { key: true, file: false };
    log('INFO', 'team.join.started', { team_id: teamId });
    try {
      const joined = await redeemAndVerify(parsed, seed, displayName, label, extraAddresses);
      if (joined.state !== 'pending' && joined.state !== 'active') throw new JoinStop(teamFailure('CONNECTION_FAILED', 'team_join_refused'));
      const record = recordOf(parsed, joined, displayName);
      if (aborted) throw new JoinStop(stoppedAnswer());
      created.file = !teamDirExists(userDataPath, teamId);
      const written = writeRecord(record);
      if (!written || written.ok !== true) throw new JoinStop(teamFailure('CONNECTION_FAILED', 'team_client_write_failed'));
      log('INFO', 'team.join.finished', { team_id: teamId, ok: true });
      return { ok: true, record };
    } catch (error) {
      let answer = error instanceof JoinStop ? error.answer : failureOf(error);
      if (aborted) answer = stoppedAnswer();
      removeMembership({ userDataPath, deviceKeys, teamId, key: created.key, file: created.file, log });
      log('INFO', 'team.join.finished', { team_id: teamId, ok: false, reason: answer.error.reason });
      return answer;
    } finally {
      seed.fill(0);
    }
  }

  /**
   * Owner recovery (slice 1f-2): redeems a recovery invite with a fresh device seed held only in
   * memory. Until the host confirms (an active member) nothing local changes. Once it has, the host
   * has revoked every other device of the owner, so the new seed is the only key it accepts: it is
   * saved and kept whatever happens next, then the client file is written. A save or a file write
   * that fails after the redeem answers `team_recover_local_save_failed` (the host accepted the
   * recovery, this device did not keep it: run Recover again). Resolves { ok: true, record } or a
   * failure. The caller stops any manager of the team first.
   */
  async function recover({ invite, displayName, label, extraAddresses = [] }, { writeRecord }) {
    if (aborted) return stoppedAnswer();
    const parsed = parseInvite(invite);
    if (!parsed.ok) return teamFailure('INVITE_MALFORMED', 'team_invite_malformed');
    const teamId = parsed.team_id;
    if (!deviceKeys.available()) return teamFailure('DEVICE_KEY_UNAVAILABLE', 'team_device_key_unavailable');
    const seed = crypto.randomBytes(PUBLIC_KEY_BYTES);
    log('INFO', 'team.recover.started', { team_id: teamId });
    try {
      const joined = await redeemAndVerify(parsed, seed, displayName, label, extraAddresses);
      if (joined.state !== 'active') throw new JoinStop(teamFailure('CONNECTION_FAILED', 'team_join_refused'));
      if (aborted) throw new JoinStop(stoppedAnswer());
      const record = recordOf(parsed, joined, displayName);
      const localSaveFailed = () => new JoinStop(teamFailure('CONNECTION_FAILED', 'team_recover_local_save_failed'));
      try { deviceKeys.save(teamId, seed); } catch { throw localSaveFailed(); }
      const written = writeRecord(record);
      if (!written || written.ok !== true) throw localSaveFailed();
      log('INFO', 'team.recover.finished', { team_id: teamId, ok: true });
      return { ok: true, record };
    } catch (error) {
      let answer = error instanceof JoinStop ? error.answer : failureOf(error);
      if (aborted) answer = stoppedAnswer();
      log('INFO', 'team.recover.finished', { team_id: teamId, ok: false, reason: answer.error.reason });
      return answer;
    } finally {
      seed.fill(0);
    }
  }

  // Stops every bridge of a join in progress; every later join is refused. Used once, when the app quits.
  function abort() {
    aborted = true;
    for (const bridge of bridges) void bridge.stop().catch(() => {});
  }

  return { join, recover, abort, alreadyHeld };
}

module.exports = { createJoin };
