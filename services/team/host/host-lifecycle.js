'use strict';

// The owner's whole-team operations behind the `team.host*` IPC methods of slice 5-6: what deleting would remove
// (`hostInventory`), Delete this team (`hostDelete`, E61), Start a new team after a lost key (`hostStartNew`, E48),
// the old teams that left (`hostOldDelete`, `hostOldShow`), Export (`hostExport`) and Restore (`hostRestorePick`,
// `hostRestore`), E63. Main process; the file work is in host-delete.js, host-export.js, host-restore.js and
// host-sweep.js (no Electron), the pickers and the file manager are injected.
//
// Owner only, checked here and never only on the page (fork 8): this Jenny's saved membership of the hosted team
// names the member the saved member store says is the owner, or the team's key is lost. Review round two adds two
// ways out: a store with no active owner at all (an owner invite never redeemed, R09-F03) lets the PC whose stored
// key is that team's act, and a committed delete that stopped (R09-F01) may be deleted again, while export and
// restore refuse it (`team_delete_unfinished`). Review sweeps, second run (X4b-F04): a store that is there and does
// not read lets the PC holding a host key delete the team, see its inventory and try an export (the typed name
// still guards the delete); Restore and Start a new team then answer MEMBERS_UNREADABLE, so the way out is Delete,
// then Restore. Delete and an old team's delete compare the typed name with the
// team's current name here as well: the saved member store's, which `team.rename` writes, else the config's
// (R09-F04); an old team whose name could not be read takes the word OLD_CONFIRM_WORD instead. Start a new team
// needs the key to be lost; Restore needs a PC that hosts no team, or (from the lost-key page) the keyless team's
// typed name. A `team-host` that is a link or resolves
// outside the profile refuses every one of them. Files are touched only once the server is known to have stopped
// (`team_host_busy` otherwise), and the leftover sweep runs first.
//
// One lifecycle call at a time (the controller's lock), but the folder and file pickers open outside it, so Start,
// Stop and the internet setting answer while a picker is open; the picked backup is kept per window and dropped
// when that window goes.
//
// Secrets: the password is held for the call only and goes nowhere but the backup's key derivation; the seed is
// zeroed once used; no answer, log line or failure carries a key, token, invite, password or path, except the
// export folder the owner picked and the backup's file name, which the page shows.

const fs = require('node:fs');
const path = require('node:path');

const { teamFailure, invalidRequest, failureOf } = require('../team-errors');
const { loadClientFile } = require('../client-file');
const { peekBackup, isBackupPassword } = require('./host-backup');
const { memberCounts, projectFacts, readInventory, savedMembers } = require('./host-inventory');
const { writeAutostart } = require('./host-autostart');
const {
  checkDeletable, listOldTeams, oldFolder, oldProjectsFolder, removeOldTeam, removeTeamFiles, setAsideTeam,
} = require('./host-delete');
const { exportTeam } = require('./host-export');
const { restoreTeam } = require('./host-restore');
const { deleteMarked, finishDelete, sweepLeftovers, teamHostRoot, teamIdOfKey } = require('./host-sweep');
const { realInside, walkTreeAsync } = require('./host-files');
const { notDeployedReason, readSavedHostConfig, savedDirectPort, savedInternet, savedTeamName } = require('./host-layout');

// The most entries the server page's size walks; a larger folder shows no size rather than holding the main process.
const SUMMARY_WALK_LIMIT = 200_000;
// The time the running server gets to carry "deleted by its owner" to connected members before it stops.
const NOTICE_MS = 1500;
// What the owner types to delete an old team whose name could not be read.
const OLD_CONFIRM_WORD = 'delete';
const fail = (reason) => teamFailure('HOST_UNAVAILABLE', reason);
const keyIsLost = (key) => key === 'missing' || key === 'set_aside';
const MEMBERS_UNREADABLE = 'team_members_unreadable';
// The supervisor's stop answer says the child is gone: stopped, or failed for any reason but an exit it could not confirm.
const hostStopped = (answer) => answer?.ok === true && ['stopped', 'failed'].includes(answer.host?.state)
  && answer.host?.reason !== 'team_host_exit_unconfirmed';

/**
 * `host`: the controller's parts — { keys, tokens, keyState(), running(), notifyDeleting(), stop(), deploy(payload),
 * start({ display_name, label }), forgetMembership(teamId), state() }. `pick`: { folder(), file(), open(path) }
 * (Electron's dialogs and shell, or test doubles).
 */
function createHostLifecycle({ userDataPath, host, pick = {}, lockPython = () => null, bounds = {}, now = Date.now, say = () => {} }) {
  const root = path.join(userDataPath, 'team-host');
  const noticeMs = Number.isSafeInteger(bounds.noticeMs) ? bounds.noticeMs : NOTICE_MS;
  // The backup file each window picked for Restore, by sender id; paths in main only, never answered.
  const picked = new Map();
  // The windows already watched for their close: one listener a window, however often it picks (X3d-F01).
  const watched = new WeakSet();
  // The old teams, listed once and again after a call that changes them (not on every status push).
  let oldTeamsCache = null;
  const oldTeams = () => { oldTeamsCache ||= listOldTeams(userDataPath); return oldTeamsCache; };
  let sweeping = null;
  // The leftover sweep (host-sweep.js); one at a time, and every caller waits for the one running.
  const sweep = () => {
    sweeping ||= sweepLeftovers(userDataPath, { keys: host.keys, tokens: host.tokens, forgetMembership: host.forgetMembership })
      .then((swept) => { if (swept.left) say('WARN', 'team.host.leftovers', { left: swept.left }); return swept; })
      .catch(() => ({ left: 1 }))
      .finally(() => { sweeping = null; });
    return sweeping;
  };

  const realRoot = () => realInside(userDataPath, root);
  const stopHost = async () => hostStopped(await host.stop());

  // Fork 8: the saved membership says owner, or the key is lost; or a committed delete stopped (`deleting`), or
  // the store has no active owner and the stored key is its team's (R09-F01, R09-F03), or the store is there and
  // does not read and a host key is stored (`unreadable`, X4b-F04). The store is read once.
  function ownerOrKeyLost() {
    if (keyIsLost(host.keyState())) return { ok: true, keyLost: true };
    const real = realRoot();
    if (real && deleteMarked(real)) return { ok: true, keyLost: false, deleting: true, ownerId: null, teamId: null };
    const { read, unreadable, ownerId, teamId } = real ? savedMembers(real) : { read: false, ownerId: null, teamId: null };
    const own = teamId ? loadClientFile(userDataPath, teamId) : null;
    if (ownerId && own?.ok && own.record.member_id === ownerId) return { ok: true, keyLost: false, ownerId, teamId };
    if (read && !ownerId && teamId && teamIdOfKey(host.keys) === teamId) return { ok: true, keyLost: false, ownerId: null, teamId };
    if (unreadable && teamIdOfKey(host.keys)) return { ok: true, keyLost: false, ownerId: null, teamId: null, unreadable: true };
    return { ok: false };
  }

  // The team's name now: the saved member store's (`team.rename` writes only the store), else the saved config's;
  // null with no saved config (R09-F04).
  function teamName(saved = readSavedHostConfig(userDataPath)) {
    const configName = savedTeamName(saved);
    const real = configName ? realRoot() : null;
    return (real && savedMembers(real).teamName) || configName;
  }

  // `set_aside_id`: an old team's counts, for its own delete confirmation (its key is lost by definition).
  async function inventory({ set_aside_id: id } = {}) {
    if (id !== undefined) {
      const folder = oldFolder(userDataPath, id);
      return folder ? { ok: true, inventory: await readInventory(folder, { running: false, now: now() }) } : invalidRequest('team_old_not_found');
    }
    if (teamHostRoot(userDataPath) === 'link') return fail('team_host_link');
    const real = realRoot();
    if (!real || !savedTeamName(readSavedHostConfig(userDataPath))) return fail(notDeployedReason(userDataPath));
    if (!ownerOrKeyLost().ok) return invalidRequest('team_owner_only');
    return { ok: true, inventory: await readInventory(real, { running: host.running(), now: now() }) };
  }

  // Everything that can refuse comes before the members are told: the root, the owner, the name, a link anywhere.
  async function remove({ name }) {
    if (teamHostRoot(userDataPath) === 'link') return fail('team_delete_link');
    await sweep();
    const savedName = teamName();
    if (!realRoot() || !savedName) return fail(notDeployedReason(userDataPath));
    if (!ownerOrKeyLost().ok) return invalidRequest('team_owner_only');
    if (name !== savedName) return invalidRequest('team_delete_name_mismatch');
    const checked = await checkDeletable(userDataPath);
    if (!checked.ok) return { ...fail(checked.reason), ...(checked.project_id ? { project_id: checked.project_id } : {}) };
    const teamId = savedMembers(realRoot()).teamId || teamIdOfKey(host.keys);
    if (host.running()) {
      host.notifyDeleting();
      await new Promise((resolve) => { setTimeout(resolve, noticeMs); });
    }
    if (!(await stopHost())) return invalidRequest('team_host_busy');
    const files = await removeTeamFiles(userDataPath);
    say('INFO', 'team.host.delete', { ok: files.ok, ...(files.ok ? {} : { reason: files.reason }) });
    if (!files.ok) return { ...fail(files.reason), ...(files.project_id ? { project_id: files.project_id } : {}) };
    // Committed: every step below runs, and what could not be removed is reported (and swept later: the mark stays
    // until the key and the token are gone, R09-F01).
    const left = files.leftover ? ['files'] : [];
    const rest = await finishDelete(userDataPath, { keys: host.keys, tokens: host.tokens, forgetMembership: host.forgetMembership, teamId });
    for (const part of rest) if (!left.includes(part)) left.push(part);
    if (left.length) say('WARN', 'team.host.delete_left', { parts: left });
    return { ok: true, team_name: savedName, host: host.state(), ...(left.length ? { left } : {}) };
  }

  async function startNew({ name, display_name: displayName, label }) {
    if (teamHostRoot(userDataPath) === 'link') return fail('team_host_link');
    if (!keyIsLost(host.keyState())) {
      const real = realRoot();
      return real && savedMembers(real).unreadable ? fail(MEMBERS_UNREADABLE) : invalidRequest('team_host_key_present');
    }
    await sweep();
    const real = realRoot();
    if (!real) return fail('team_host_not_deployed');
    if (!(await stopHost())) return invalidRequest('team_host_busy');
    const facts = { ...(await projectFacts(real)), team_name: teamName() };
    const aside = setAsideTeam(userDataPath, facts, { now: now() });
    oldTeamsCache = null;
    say('INFO', 'team.host.set_aside', { ok: aside.ok });
    if (!aside.ok) return fail(aside.reason);
    if (facts.team_id) await host.forgetMembership(facts.team_id);
    return host.deploy({ name, display_name: displayName, label });
  }

  async function oldDelete({ set_aside_id: id, name }) {
    const team = oldTeams().find((row) => row.id === id);
    if (!team) return invalidRequest('team_old_not_found');
    // An old team was set aside because its key was lost, so fork 8's "or the key is lost" always holds for it.
    if (name !== (team.team_name ?? OLD_CONFIRM_WORD)) return invalidRequest('team_delete_name_mismatch');
    const removed = await removeOldTeam(userDataPath, id);
    oldTeamsCache = null;
    return removed.ok ? { ok: true, host: host.state() } : fail(removed.reason);
  }

  async function oldShow({ set_aside_id: id }) {
    const folder = oldProjectsFolder(userDataPath, id);
    if (!folder || typeof pick.open !== 'function') return invalidRequest('team_old_not_found');
    const opened = await pick.open(folder);
    return opened === false ? fail('team_open_failed') : { ok: true };
  }

  // Start with Jenny: the saved setting, then every window is told. No lock: one small file, written whole.
  function autostart({ enabled }) {
    if (teamHostRoot(userDataPath) === 'link') return fail('team_host_link');
    const real = realRoot();
    if (!real || !savedTeamName(readSavedHostConfig(userDataPath))) return fail(notDeployedReason(userDataPath));
    try { writeAutostart(real, enabled); } catch { return fail('team_autostart_write_failed'); }
    host.push();
    return { ok: true, host: host.state() };
  }

  // The stopped (or running) server's facts for the Team server page: counts only, a part that cannot be read is null.
  // The size is one walk of the folder, bounded, and shared by the calls that arrive while it runs (the tab and Settings).
  let sizing = null;
  async function summary() {
    if (teamHostRoot(userDataPath) === 'link') return fail('team_host_link');
    const real = realRoot();
    if (!real || !savedTeamName(readSavedHostConfig(userDataPath))) return fail(notDeployedReason(userDataPath));
    let bytes = null;
    try {
      sizing = sizing || walkTreeAsync(real, { limit: SUMMARY_WALK_LIMIT }).finally(() => { sizing = null; });
      const walked = await sizing;
      if (!walked.truncated && walked.links === 0) bytes = walked.bytes;
    } catch { /* a folder that does not walk: unknown */ }
    let lastRan = null;
    try {
      const log = fs.lstatSync(path.join(real, 'logs', 'host.log'));
      if (log.isFile() && Number.isFinite(log.mtimeMs)) lastRan = Math.max(0, Math.floor(log.mtimeMs));
    } catch { /* no log yet */ }
    return { ok: true, summary: { ...memberCounts(real, now()), bytes, last_ran: lastRan } };
  }

  async function openFolder() {
    if (teamHostRoot(userDataPath) === 'link') return fail('team_host_link');
    const real = realRoot();
    if (!real) return fail('team_host_not_deployed');
    if (typeof pick.open !== 'function') return fail('team_open_failed');
    return (await pick.open(real)) === false ? fail('team_open_failed') : { ok: true };
  }

  // The checks an export makes before its picker opens, and again under the lock: an answer, or null to go on.
  function exportRefusal() {
    if (teamHostRoot(userDataPath) === 'link') return fail('team_host_link');
    if (!realRoot() || !savedTeamName(readSavedHostConfig(userDataPath))) return fail(notDeployedReason(userDataPath));
    const who = ownerOrKeyLost();
    if (!who.ok) return invalidRequest('team_owner_only');
    if (who.deleting) return fail('team_delete_unfinished');
    return who.keyLost ? fail('team_host_key_missing') : null;
  }

  async function exportCall({ password }, folder) {
    const refused = exportRefusal();
    if (refused) return refused;
    const saved = readSavedHostConfig(userDataPath);
    const who = ownerOrKeyLost();
    let seed = null;
    try {
      seed = host.keys.load();
      if (!seed) return fail('team_host_key_missing');
      const relayToken = savedInternet(saved)?.relay_url ? host.tokens.load() : null;
      const answer = await exportTeam({ root: realRoot(), picked: folder, userDataPath, ownerId: who.ownerId, password, now: now(),
        setting: { name: teamName(saved), direct_port: savedDirectPort(saved), internet: savedInternet(saved) },
        secrets: { seed, relayToken } });
      say('INFO', 'team.host.export', { ok: answer.ok, ...(answer.ok ? { backup_left_out: answer.backup_left_out === true } : { reason: answer.reason }) });
      // E73: over a member store that does not read only the readable copy was written, and the answer says so.
      if (answer.ok) return { ok: true, folder: answer.folder, bytes: answer.bytes, ...(answer.backup_left_out ? { backup_left_out: true } : {}) };
      const failed = fail(answer.reason);
      if (Number.isSafeInteger(answer.count)) failed.error.count = answer.count; // the page names the count
      return failed;
    } catch (error) {
      return failureOf(error);
    } finally {
      seed?.fill(0);
    }
  }

  // Outside the lock: the picker and the header check only; the file is kept for this window.
  async function restorePick(sender) {
    const id = sender?.id ?? 0;
    picked.delete(id);
    const file = typeof pick.file === 'function' ? await pick.file() : null;
    if (!file) return invalidRequest('team_restore_cancelled');
    try {
      const { size } = await peekBackup(file);
      if (typeof sender?.once === 'function' && !watched.has(sender)) {
        watched.add(sender);
        sender.once('destroyed', () => picked.delete(id));
      }
      picked.set(id, file);
      return { ok: true, file_name: path.basename(file), size };
    } catch (error) {
      return fail(error?.reason || 'team_backup_unreadable');
    }
  }

  async function restore({ password, display_name: displayName, label, name }, sender) {
    const id = sender?.id ?? 0;
    const file = picked.get(id);
    if (!file) return invalidRequest('team_restore_no_file');
    if (teamHostRoot(userDataPath) === 'link') return fail('team_host_link');
    await sweep();
    const savedName = teamName();
    let setAside = null;
    let oldTeamId = null;
    if (realRoot() || savedName) {
      // Only the lost-key page restores over a team, and only with that team's name typed.
      const who = ownerOrKeyLost();
      if (!who.ok) return invalidRequest('team_owner_only');
      if (who.deleting) return fail('team_delete_unfinished');
      if (who.unreadable) return fail(MEMBERS_UNREADABLE);
      if (!keyIsLost(host.keyState())) return invalidRequest('team_host_exists');
      if (name !== savedName) return invalidRequest('team_delete_name_mismatch');
      if (!(await stopHost())) return invalidRequest('team_host_busy');
      setAside = { ...(await projectFacts(realRoot())), team_name: savedName };
      oldTeamId = setAside.team_id;
    } else if (name !== undefined) {
      return invalidRequest();
    }
    const answer = await restoreTeam({ userDataPath, file, password, keys: host.keys, setAside, lockPython: lockPython(), now: now() });
    oldTeamsCache = null;
    say('INFO', 'team.host.restore', { ok: answer.ok, ...(answer.ok ? {} : { reason: answer.reason }) });
    if (!answer.ok) return { ...fail(answer.reason), ...(answer.leftover ? { left: ['files'] } : {}) };
    picked.delete(id);
    if (oldTeamId) await host.forgetMembership(oldTeamId);
    const started = await host.start({ display_name: displayName, label });
    return { ok: true, team_name: answer.team_name, exported_at: answer.exported_at, host: host.state(),
      ...(started && started.ok === false ? { start_error: started.error } : {}) };
  }

  const LOCKED = Object.freeze({ hostInventory: inventory, hostDelete: remove, hostStartNew: startNew,
    hostOldDelete: oldDelete, hostRestore: restore });

  /**
   * One lifecycle IPC call. `exclusive(run)`: the controller's lock; `sender`: the asking window ({ id, once }),
   * for the picked backup. A picker never opens under the lock.
   */
  async function handle(method, value, { exclusive, sender = null }) {
    if (method === 'hostRestorePick') return restorePick(sender);
    if (method === 'hostOldShow') return oldShow(value);
    if (method === 'hostAutostart') return autostart(value);
    if (method === 'hostSummary') return summary();
    if (method === 'hostOpenFolder') return openFolder();
    if (method === 'hostExport') {
      if (!isBackupPassword(value.password)) return invalidRequest('team_backup_password_short');
      const refused = exportRefusal();
      if (refused) return refused;
      const folder = typeof pick.folder === 'function' ? await pick.folder() : null;
      if (!folder) return invalidRequest('team_export_cancelled');
      return exclusive(() => exportCall(value, folder));
    }
    return Object.hasOwn(LOCKED, method) ? exclusive(() => LOCKED[method](value, sender)) : invalidRequest();
  }

  // Fork 8 for the page while the server is stopped (its saved files do not change then): read once per `since`.
  let ownerSeen = { since: null, ok: null };
  function ownerHere(since) {
    if (ownerSeen.since !== since) ownerSeen = { since, ok: ownerOrKeyLost().ok === true };
    return ownerSeen.ok;
  }

  return { handle, sweep, oldTeams, ownerHere, teamName, OLD_CONFIRM_WORD };
}

module.exports = { OLD_CONFIRM_WORD, createHostLifecycle };
