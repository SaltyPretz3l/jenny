'use strict';

// `team-export` (slice 3-14): the whole team in one password-locked file in the setup service's exchange folder,
// on a stopped headless host. The file is the desktop backup format unchanged (services/team/host/host-backup.js:
// same header, scrypt and AES-256-GCM chunks, same manifest and `profile/`, `projects/`, `trash/` records), so a
// file from either kind of host restores on either. The walk, its stops and the room estimate are the desktop
// export's (host-export.js); there is no readable copy (the desktop page's Markdown and project copies).
//
// Order: the terminal first (no TTY: refused before anything is read), the config and the profile lock, the
// exchange folder (a real directory at its own real path), the profile, data volume and projects root (each a real
// directory at its own real path: a missing one refuses `team_projects_root_missing`, a link `team_export_links`),
// no delete or restore marker, a whole team (the key file and the member store, the key matching the store), the
// walk (a link, an unreadable file or too many entries refuse with a count; every entry is held in memory, up to
// 2,000,000), the room on the exchange folder (`team_disk_full`: twice the team's bytes and 256 MiB), then the
// password twice with no echo (10 to 1,024 characters; a short one or two entries that differ refuse with nothing
// written). The key comes from the mounted key file through the existing reader and goes only into the file's
// ciphertext; the relay token is null (a headless host holds none); the team name is the member store's (the
// config's when the store has none) and the setting is that name, the config's direct port and internet record.
//
// The file is `jenny-team-<UTC yyyymmdd-hhmmss>.jennyteam`, 0600. A file already at that name refuses before the
// walk (`team_export_exists`). It is written as a hidden partial name (the backup writer's own temporary file,
// renamed to the partial, all 0600), the final name is checked absent again (the server is stopped and the lock
// held, so nothing else writes there) and the partial is renamed to it, then the exchange folder is synced; no
// hard link, so a bind mount without them works. The partial goes on every failure. A run killed part way leaves a
// hidden partial or temporary file of this command's own two name shapes: the next export removes those (regular
// files only, no link followed) before it measures the room. The command prints counts only: never the file's
// name or path, the key or the password.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { isBackupPassword, writeBackup } = require('../../services/team/host/host-backup');
const { SPARE_BYTES, backupEntriesOf, freeBytes, stopOf } = require('../../services/team/host/host-export');
const { readJsonFile } = require('../../services/team/host/host-files');
const { keyPairFromSeed } = require('./ids');
const { syncDirectory } = require('./keygen');
const { MEMBERS_FILE } = require('./member-store');
const { isTerminalPair, readPassword } = require('./tty-input');
const {
  STAGING_PREFIX, mountRoot, namesIn, readHostSeed, refusal, rootsReason, teamRoots, teamState, withTeamProfile,
} = require('./team-maintenance');

const WALK_LIMIT = 2_000_000;
const EXTENSION = '.jennyteam';
// This command's own leftovers after a kill: the partial (`.<name>.partial`) and the backup writer's temporary
// file beside it (`.<partial name>.<12 hex>.tmp`).
const STAMPED = String.raw`jenny-team-\d{8}-\d{6}\.jennyteam\.partial`;
const LEFTOVER = new RegExp(String.raw`^(?:\.${STAMPED}|\.\.${STAMPED}\.[a-f0-9]{12}\.tmp)$`, 'u');

const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15);

// The config's internet record in the saved desktop setting's shape, or null while off.
function settingInternet(internet) {
  return internet ? { map_port: internet.mapPort, public_address: internet.publicAddress, relay_url: internet.relayUrl } : null;
}

// The password twice on the terminal; a refusal word when it is short, differs or the input ended.
async function askPassword(readPasswordImpl, input, output) {
  try {
    const first = await readPasswordImpl({ input, output, prompt: 'Backup password (10 characters or more): ' });
    if (!isBackupPassword(first)) return { reason: 'team_backup_password_short' };
    const second = await readPasswordImpl({ input, output, prompt: 'Repeat the backup password: ' });
    return first === second ? { password: first } : { reason: 'team_export_password_mismatch' };
  } catch {
    return { reason: 'team_input_cancelled' };
  }
}

const unlinkQuietly = (file) => { try { fs.unlinkSync(file); } catch { /* not there */ } };
const taken = (file) => {
  try { fs.lstatSync(file); return true; } catch (error) { return error?.code !== 'ENOENT'; }
};

// Removes this command's leftovers from an earlier killed run: regular files of the two exact name shapes only.
function sweepLeftovers(exchange) {
  for (const name of namesIn(exchange) ?? []) {
    if (!LEFTOVER.test(name)) continue;
    const file = path.join(exchange, name);
    try { if (fs.lstatSync(file).isFile()) fs.unlinkSync(file); } catch { /* left for the next run */ }
  }
}

// Writes the backup to a hidden partial name, then renames it to `final` once that name is still free, and syncs
// the folder. Answers null or a refusal word; nothing of this export is left on a failure.
async function writeExclusive({ exchange, name, password, manifest, entries, randomBytes, writeBackupImpl }) {
  const final = path.join(exchange, name);
  const partial = path.join(exchange, `.${name}.partial`);
  try {
    await writeBackupImpl({ target: partial, password, manifest, entries, randomBytes });
  } catch (error) {
    unlinkQuietly(partial);
    return typeof error?.reason === 'string' ? error.reason : 'team_export_write_failed';
  }
  if (taken(final)) {
    unlinkQuietly(partial);
    return 'team_export_exists';
  }
  try {
    fs.renameSync(partial, final);
  } catch {
    unlinkQuietly(partial);
    return 'team_export_write_failed';
  }
  syncDirectory(fs, exchange);
  return null;
}

/**
 * Exports the team into the exchange folder. Answers { ok, files, bytes, size } or { ok: false, reason, count? }.
 * `walkLimit` and `writeBackupImpl`: test seams (a lower entry cap; the backup writer).
 */
async function exportHostedTeam({
  configPath, output = process.stdout, input = process.stdin, promptOutput = process.stderr, logger = null,
  acquireProfileImpl, readPasswordImpl = readPassword, clock = Date.now, statfs = fs.promises.statfs,
  randomBytes = crypto.randomBytes, walkLimit = WALK_LIMIT, writeBackupImpl = writeBackup,
} = {}) {
  if (!isTerminalPair(input, promptOutput)) return refusal('team_tty_required');
  return withTeamProfile({ configPath, acquireProfileImpl, logger, event: 'team.export' }, async (config, say) => {
    const exchange = mountRoot(config, 'exchange');
    if (!exchange) return refusal('team_exchange_unavailable');
    const roots = teamRoots(config);
    if (!roots.projects) return refusal('team_projects_root_missing');
    const badRoot = rootsReason(roots, 'team_export_links');
    if (badRoot) return refusal(badRoot);
    const state = teamState(roots);
    if (state.deleting) return refusal('team_delete_unfinished');
    if (state.restoring) return refusal('team_restore_unfinished');
    const seed = readHostSeed(config);
    try {
      if (!seed || !state.store) return refusal('team_not_deployed');
      let doc;
      try { doc = readJsonFile(path.join(roots.profile, MEMBERS_FILE)); } catch { return refusal('team_export_unreadable'); }
      if (doc?.team?.host_public_key !== keyPairFromSeed(seed).publicKey) return refusal('team_host_key_mismatch');
      const now = clock();
      const name = `jenny-team-${stampOf(now)}${EXTENSION}`;
      if (taken(path.join(exchange, name))) return refusal('team_export_exists');
      sweepLeftovers(exchange);
      const bases = [{ top: 'profile', base: roots.profile }, { top: 'projects', base: roots.projects },
        { top: 'trash', base: roots.trash }];
      const source = await backupEntriesOf(bases, walkLimit);
      const stop = stopOf(source, walkLimit);
      if (stop) return { ok: false, reason: stop.reason, count: stop.count };
      // A restore cut before its marker leaves staging folders; they are not the team.
      const entries = source.entries.filter((entry) => !entry.rel.startsWith(`profile/${STAGING_PREFIX}`));
      const free = await freeBytes(exchange, statfs);
      if (free !== null && free < source.bytes * 2 + SPARE_BYTES) return refusal('team_disk_full');
      const asked = await askPassword(readPasswordImpl, input, promptOutput);
      if (!asked.password) return refusal(asked.reason);
      // After a rename the member store holds the team's name; the config's is only where the store has none.
      const teamName = typeof doc.team.name === 'string' && doc.team.name ? doc.team.name : config.team.name;
      const manifest = { schema: 1, team_name: teamName, team_id: doc.team.team_id ?? null, exported_at: now,
        key: seed.toString('base64url'), relay_token: null,
        setting: { name: teamName, direct_port: config.team.directPort ?? null,
          internet: settingInternet(config.team.internet ?? null) } };
      const failed = await writeExclusive({ exchange, name, password: asked.password, manifest, entries, randomBytes,
        writeBackupImpl });
      if (failed) {
        say('ERROR', 'team.export.refused', { reason: failed });
        return refusal(failed);
      }
      const files = entries.filter((entry) => !entry.dir).length;
      const size = fs.statSync(path.join(exchange, name)).size;
      say('INFO', 'team.export.written', { files, bytes: source.bytes });
      output.write(`Exported the team: ${files} files (${source.bytes} bytes) into one file of ${size} bytes in the exchange folder.\n`
        + 'The file holds the team\'s key, locked by the password. Keep both safe.\n');
      return { ok: true, files, bytes: source.bytes, size };
    } finally {
      seed?.fill(0);
    }
  });
}

module.exports = { exportHostedTeam };
