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
//
// Slice 5-3 (TEAM_INTERNET_SPEC): a version 2 invite's DNS name is looked up
// before every connect of the join (host-name.js) and kept in the client file
// (schema 3) with the relay URL; its relay token goes to the secure store beside
// the device key before anything is redeemed, and a token that cannot be kept
// stops the join (`team_relay_token_unavailable`). An invite from a newer Jenny
// answers `team_invite_too_new`.
//
// Slice 5-5c: every dial of a join or recovery (the redeem over the invite key, the check with the device key)
// carries the relay the invite names, `{ url, token }` with the token or null. A version 1 recovery, which keeps the
// saved route, carries the saved URL with the saved token; a token store that cannot answer stops it
// (`team_relay_token_unavailable`) before any dial. A relay reason is answered as itself (slice 5-6).
//
// Review round two (R10-F01): the host bridge refuses a key its host refused once more, without asking, for its
// cooldown (bridge-link.js). A redeem lost before it reached the host makes the device key's first check refused, so
// the check after the second redeem may meet that cooldown: once the host has answered a redeem, a refusal inside the
// window is waited out once (abort() and cancel() cut the wait) and the device key checked again. A recovery whose
// wait the app's quit cuts keeps the answered redeem, so the owner is never left without the key the host now holds.
// Team review fixes (row 201, H11): the bridge's own `host_cooldown` on that check is waited out the same way (once,
// after an answered redeem), not read as an unreachable host; a cooldown still there after the wait is unreachable,
// so the answered redeem is kept (R11-F01).

const crypto = require('node:crypto');

const { PUBLIC_KEY_BYTES, keyPairFromSeed } = require('../../server/team/ids');
const { parseInvite } = require('../../server/team/invites');
const { BRIDGE_OWN_REFUSALS, cleanAddresses, createRefusalWindow, createWaits, openLink } = require('./bridge-link');
const { resolveHostName, withHostName } = require('./host-name');
const { loadClientFile, removeMembership, teamDirExists, withRoute } = require('./client-file');
const { TeamError, VERSION_REASONS, failureAnswer, failureOf, invalidRequest, teamFailure } = require('./team-errors');

// `host_cooldown` on the invite's own key is the bridge repeating the host's refusal of that invite.
const LINK_REASONS = Object.freeze({ host_refused: 'invite_not_valid', host_cooldown: 'invite_not_valid', host_unreachable: 'team_unreachable',
  closed: 'team_unreachable', relay_denied: 'relay_denied', relay_unreachable: 'relay_unreachable',
  team_bridge_unavailable: 'team_bridge_unavailable' });
// The same, once the invite's name did not resolve: an unreachable host then says so.
const UNRESOLVED_REASONS = Object.freeze({ ...LINK_REASONS, host_unreachable: 'host_name_unresolved' });
// The device-key check's reading of a bridge reason: only the host's own refusal is `refused`; the bridge's own
// admit timeout is `unreachable`, so an answered redeem is kept (review round two, R11-F01); its own cooldown is
// `cooling`, which an answered redeem waits out once (H11).
const VERIFY_REASONS = Object.freeze({ host_refused: 'refused', host_unreachable: 'unreachable', closed: 'unreachable',
  team_bridge_unavailable: 'unreachable',
  ...Object.fromEntries(BRIDGE_OWN_REFUSALS.map((reason) => [reason, 'unreachable'])), host_cooldown: 'cooling' });

// The refusal for an invite that does not parse: a newer Jenny's invite says so, anything else is malformed.
function inviteRefusal(parsed) {
  return teamFailure('INVITE_MALFORMED', parsed.error?.reason === 'team_invite_too_new'
    ? 'team_invite_too_new' : 'team_invite_malformed');
}

class JoinStop extends Error {
  constructor(answer) {
    super('join_stopped');
    this.answer = answer;
  }
}

// A dial the caller no longer allows (`halt`, Force local E64): thrown before the dial or once the link opened.
class Halted extends JoinStop {}

const stoppedAnswer = () => teamFailure('HOST_STOPPED', 'team_connection_stopped');

// The reason a failed join or recovery logs: the one bounded word its IPC answer carries (failureAnswer), never a
// host's refusal text as sent (review sweeps, second run, X1b-F01).
const loggedReason = (answer) => failureAnswer(answer).error.reason;

function createJoin(deps) {
  const {
    deviceKeys, userDataPath, spawnChild, appVersion, protocolVersion, requestTimeoutMs, createBridge,
    now = Date.now, log = () => {}, resolveName = resolveHostName, refusedCooldownMs,
  } = deps;
  const linkBase = { spawnChild, appVersion, protocolVersion, requestTimeoutMs, createBridge };
  const bridges = new Set();
  const waits = createWaits();
  let aborted = false;

  // Opens one link whose bridge `abort()` or `cancel()` can stop while it is still dialling. `halt()` answers null
  // to go ahead or the refusal to give; it is read before the dial and again once the link opened.
  async function open(options, halt) {
    if (aborted) throw new JoinStop(stoppedAnswer());
    const before = halt?.();
    if (before) throw new Halted(before);
    let bridge = null;
    const opened = await openLink({ ...options, onBridge: (started) => {
      bridge = started;
      bridges.add(started);
      if (aborted || halt?.()) void started.stop();
    } });
    if (!opened.ok && bridge) bridges.delete(bridge);
    const halted = aborted ? null : halt?.();
    if (aborted || halted) {
      if (opened.ok) await closeLink(opened.link);
      throw aborted ? new JoinStop(stoppedAnswer()) : new Halted(halted);
    }
    return opened;
  }

  async function closeLink(link) {
    await link.close();
    bridges.delete(link.bridge);
  }

  // Opens a link, says hello and checks the team; throws JoinStop with the answer to give on failure.
  // `resetReasons`: the bridge reasons a dial that opened and was then closed is read as (by default only the host's
  // refusal); the device-key check reads its own cooldown and admit timeout too (VERIFY_REASONS).
  async function greet(teamId, linkOptions, linkReasons, halt, resetReasons = { host_refused: linkReasons.host_refused, host_cooldown: linkReasons.host_refused }) {
    const opened = await open(linkOptions, halt);
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
      // A key turned away may finish the dial and be closed right after: the bridge's reason decides.
      const lost = error instanceof TeamError && error.reset ? await link.offlineReason() : null;
      await closeLink(link);
      if (lost !== null && Object.hasOwn(resetReasons, lost)) throw new JoinStop(teamFailure('CONNECTION_FAILED', resetReasons[lost]));
      if (error instanceof JoinStop) throw error;
      throw new JoinStop(failureOf(error));
    }
  }

  // One lookup of the invite's name per join or recovery (each parses its own invite), shared by its connects.
  const lookups = new WeakMap();
  function lookupOf(parsed) {
    if (!lookups.has(parsed)) lookups.set(parsed, Promise.resolve().then(() => resolveName(parsed.host_name)));
    return lookups.get(parsed);
  }

  // The addresses of one connect: `base`, plus the answers of this join's lookup of the invite's name.
  async function dialAddresses(parsed, base) {
    const cleaned = cleanAddresses(base);
    const plan = await withHostName(cleaned.length > 0 ? [cleaned] : [], parsed.host_name, () => lookupOf(parsed));
    return { addresses: plan.sets[0] || [], reasons: plan.unresolved ? UNRESOLVED_REASONS : LINK_REASONS };
  }

  // One redeem over the invite key. Resolves { answer } or { lost: true }; throws JoinStop.
  async function redeemOnce(parsed, devicePublicKey, displayName, label, extraAddresses, relay, halt) {
    const dial = await dialAddresses(parsed, [...parsed.hints, ...extraAddresses]);
    const inviteKey = Buffer.from(parsed.invite_secret_key, 'base64url');
    let greeted;
    try {
      greeted = await greet(parsed.team_id, { ...linkBase, secretKey: inviteKey, relay,
        hostPublicKey: Buffer.from(parsed.host_public_key, 'base64url'), addresses: dial.addresses }, dial.reasons, halt);
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

  // Connects with the device key and reads team.status. Resolves { status, working } or { refused | unreachable |
  // cooling }.
  async function verifyDevice(parsed, seed, addresses, relay, halt) {
    let greeted;
    try {
      greeted = await greet(parsed.team_id, { ...linkBase, secretKey: seed, relay,
        hostPublicKey: Buffer.from(parsed.host_public_key, 'base64url'), addresses },
      VERIFY_REASONS, halt, VERIFY_REASONS);
    } catch (error) {
      if (error instanceof Halted) return { halted: error.answer };
      const reason = error.answer?.error?.reason;
      if (reason === 'refused' || reason === 'unreachable' || reason === 'cooling') return { [reason]: true };
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

  // A dial `halt` refuses before or during the check is not made: an answered redeem is kept (the host accepted),
  // a lost one stops with the halt's answer.
  async function redeemAndVerify(parsed, seed, displayName, label, extraAddresses, relay, halt) {
    const devicePublicKey = keyPairFromSeed(seed).publicKey;
    let redeemed = await redeemOnce(parsed, devicePublicKey, displayName, label, extraAddresses, relay, halt);
    const dial = () => cleanAddresses([...parsed.hints, ...extraAddresses, ...redeemed.reported]);
    const check = async () => verifyDevice(parsed, seed, (await dialAddresses(parsed, dial())).addresses, relay, halt);
    const refusals = createRefusalWindow({ now, cooldownMs: refusedCooldownMs });
    // After an answered redeem, a refusal inside the bridge's cooldown of the key's first one, or the bridge's own
    // cooldown of it (H11; at most the whole window when the first refusal was not seen here), is waited out once.
    // A cooldown not waited out, or met again, is read as unreachable (R11-F01).
    const settled = (verified) => (verified.cooling ? { unreachable: true } : verified);
    const verify = async () => {
      const verified = await check();
      let wait = null;
      if (verified.refused) wait = refusals.note();
      else if (verified.cooling) wait = refusals.note() ?? refusals.windowMs;
      if (!wait || !redeemed.answer) return settled(verified);
      await waits.wait(wait);
      return aborted ? { unreachable: true } : settled(await check());
    };
    let verified = await verify();
    if (redeemed.lost && verified.refused) {
      // The redeem never reached the host: the invite is still live, so redeem once more.
      redeemed = await redeemOnce(parsed, devicePublicKey, displayName, label, extraAddresses, relay, halt);
      verified = await verify();
    }
    if (verified.status) {
      const { status } = verified;
      return { member_id: status.member_id, device_id: status.device_id, state: status.state, working: verified.working,
        team_name: typeof status.team_name === 'string' ? status.team_name : null };
    }
    if (redeemed.answer && (verified.unreachable || verified.halted)) {
      const { answer } = redeemed;
      return { member_id: answer.member_id, device_id: answer.device_id, state: answer.state, working: dial(), team_name: null };
    }
    if (verified.halted) throw new Halted(verified.halted);
    throw new JoinStop(teamFailure('CONNECTION_FAILED', verified.refused ? 'team_join_refused' : 'team_join_unconfirmed'));
  }

  // A LAN record is stamped 1 (saved as schema 2, as before); one with a name or a relay is schema 3.
  function recordOf(parsed, joined, displayName, label, route) {
    return withRoute({
      schema_version: 1, team_id: parsed.team_id, host_public_key: parsed.host_public_key,
      address_hints: [...parsed.hints], last_addresses: cleanAddresses(joined.working),
      member_id: joined.member_id, device_id: joined.device_id, display_name: displayName,
      joined_at: new Date(now()).toISOString(), state_seen: joined.state, ...(label === undefined ? {} : { label }),
    }, route, 1);
  }

  // The route an invite carries; a version 1 invite carries none.
  const routeOf = (parsed) => ({ host_name: parsed.host_name, relay_url: parsed.relay_url });

  // A recovery's route: a version 2 invite's own; a version 1 invite (the host still mints those for
  // recovery) keeps the saved record's name and relay, and so its token.
  function recoveryRoute(parsed) {
    if (parsed.version === 2) return routeOf(parsed);
    const saved = loadClientFile(userDataPath, parsed.team_id);
    return saved.ok ? { host_name: saved.record.host_name ?? null, relay_url: saved.record.relay_url ?? null } : {};
  }

  // The relay an invite names, or null (a version 1 invite parses with none).
  const inviteRelay = (parsed) => (parsed.relay_url ? { url: parsed.relay_url, token: parsed.relay_token } : null);

  // A recovery's relay: a version 2 invite's own; a version 1 invite keeps the saved route, so the saved URL with the
  // saved token. A token store that cannot answer stops the recovery before it dials.
  function recoveryRelay(parsed) {
    if (parsed.version === 2) return inviteRelay(parsed);
    const { relay_url: url } = recoveryRoute(parsed);
    if (!url) return null;
    try {
      return { url, token: deviceKeys.loadRelayToken(parsed.team_id) };
    } catch {
      throw new JoinStop(teamFailure('DEVICE_KEY_UNAVAILABLE', 'team_relay_token_unavailable'));
    }
  }

  // Keeps a version 2 invite's relay token beside the device key; throws JoinStop when it cannot be kept.
  function keepRelayToken(parsed, stop) {
    if (parsed.version !== 2) return;
    try {
      if (parsed.relay_token !== null) deviceKeys.saveRelayToken(parsed.team_id, parsed.relay_token);
      else deviceKeys.removeRelayToken(parsed.team_id);
    } catch {
      throw new JoinStop(stop());
    }
  }

  // True when this Jenny already holds anything of that team: a stored key or its directory.
  function alreadyHeld(teamId) {
    return deviceKeys.has(teamId) || teamDirExists(userDataPath, teamId);
  }

  /**
   * Resolves { ok: true, record } (the client file record, already written) or a failure.
   * `admit(teamId)` returns null to go ahead or a failure to refuse before any key is made.
   * `writeRecord(record)` saves the client file and returns { ok }. `halt()` (optional) answers null to go ahead or a
   * refusal, read before the key is made and before each dial. A success also carries the `team_name` the host's
   * status gave (null when the check was not made).
   */
  async function join({ invite, displayName, label, extraAddresses = [] }, { admit, writeRecord, halt = null }) {
    if (aborted) return stoppedAnswer();
    const parsed = parseInvite(invite);
    if (!parsed.ok) return inviteRefusal(parsed);
    const teamId = parsed.team_id;
    const refused = admit(teamId) || halt?.();
    if (refused) return refused;
    if (!deviceKeys.available()) {
      return teamFailure('DEVICE_KEY_UNAVAILABLE', parsed.relay_token !== null
        ? 'team_relay_token_unavailable' : 'team_device_key_unavailable');
    }
    try {
      if (teamDirExists(userDataPath, teamId)) return invalidRequest('team_already_joined');
      // A stored key with no directory (and no manager: admit checked) is left from an earlier join. The key
      // store cannot be listed, so it is found here: it is removed and this is a first join (E47).
      if (deviceKeys.has(teamId)) {
        deviceKeys.remove(teamId);
        log('INFO', 'team.orphan_key.removed', { team_id: teamId });
      }
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
      // Before anything is redeemed: a token this Jenny cannot keep stops the join with nothing redeemed.
      if (parsed.relay_token !== null) {
        keepRelayToken(parsed, () => teamFailure('DEVICE_KEY_UNAVAILABLE', 'team_relay_token_unavailable'));
      }
      const joined = await redeemAndVerify(parsed, seed, displayName, label, extraAddresses, inviteRelay(parsed), halt);
      if (joined.state !== 'pending' && joined.state !== 'active') throw new JoinStop(teamFailure('CONNECTION_FAILED', 'team_join_refused'));
      const record = recordOf(parsed, joined, displayName, label, routeOf(parsed));
      if (aborted) throw new JoinStop(stoppedAnswer());
      created.file = !teamDirExists(userDataPath, teamId);
      const written = writeRecord(record);
      if (!written || written.ok !== true) throw new JoinStop(teamFailure('CONNECTION_FAILED', 'team_client_write_failed'));
      log('INFO', 'team.join.finished', { team_id: teamId, ok: true });
      return { ok: true, record, team_name: joined.team_name };
    } catch (error) {
      let answer = error instanceof JoinStop ? error.answer : failureOf(error);
      if (aborted) answer = stoppedAnswer();
      removeMembership({ userDataPath, deviceKeys, teamId, key: created.key, file: created.file, log });
      log('INFO', 'team.join.finished', { team_id: teamId, ok: false, reason: loggedReason(answer) });
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
   * failure. The caller stops any manager of the team first. `checkFile(teamId)` answers null when the
   * team's file is missing or loads, else its reason, which refuses the recovery before the redeem; once
   * the host accepted, the key and the file are written even when the join flow was aborted meanwhile. `halt` as
   * for `join`, read after `checkFile` and before each dial.
   */
  async function recover({ invite, displayName, label, extraAddresses = [] }, { writeRecord, checkFile, halt = null }) {
    if (aborted) return stoppedAnswer();
    const parsed = parseInvite(invite);
    if (!parsed.ok) return inviteRefusal(parsed);
    const teamId = parsed.team_id;
    if (!deviceKeys.available()) return teamFailure('DEVICE_KEY_UNAVAILABLE', 'team_device_key_unavailable');
    const problem = checkFile(teamId);
    if (problem) return invalidRequest(problem);
    const halted = halt?.();
    if (halted) return halted;
    const seed = crypto.randomBytes(PUBLIC_KEY_BYTES);
    log('INFO', 'team.recover.started', { team_id: teamId });
    try {
      const joined = await redeemAndVerify(parsed, seed, displayName, label, extraAddresses, recoveryRelay(parsed), halt);
      if (joined.state !== 'active') throw new JoinStop(teamFailure('CONNECTION_FAILED', 'team_join_refused'));
      const record = recordOf(parsed, joined, displayName, label, recoveryRoute(parsed));
      const localSaveFailed = () => new JoinStop(teamFailure('CONNECTION_FAILED', 'team_recover_local_save_failed'));
      try { deviceKeys.save(teamId, seed); } catch { throw localSaveFailed(); }
      keepRelayToken(parsed, () => localSaveFailed().answer);
      const written = writeRecord(record);
      if (!written || written.ok !== true) throw localSaveFailed();
      log('INFO', 'team.recover.finished', { team_id: teamId, ok: true });
      return { ok: true, record, team_name: joined.team_name };
    } catch (error) {
      let answer = error instanceof JoinStop ? error.answer : failureOf(error);
      if (aborted) answer = stoppedAnswer();
      log('INFO', 'team.recover.finished', { team_id: teamId, ok: false, reason: loggedReason(answer) });
      return answer;
    } finally {
      seed.fill(0);
    }
  }

  // Stops every bridge of a join in progress; every later join is refused. Used once, when the app quits.
  function abort() {
    aborted = true;
    waits.wakeAll();
    for (const bridge of bridges) void bridge.stop().catch(() => {});
  }

  // Force local (E64): stops every bridge of the join or recovery dialling now. Unlike `abort()` the flow stays usable;
  // the caller's `halt` decides what the cut dial answers.
  function cancel() {
    waits.wakeAll();
    for (const bridge of bridges) void bridge.stop().catch(() => {});
  }

  return { join, recover, abort, cancel, alreadyHeld };
}

module.exports = { createJoin };
