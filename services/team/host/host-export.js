'use strict';

// Exporting a hosted team (slice 5-6, decision E63) into a folder the owner picked. No Electron.
//
// Two things are written into a new folder `<picked>/<team name> <date>/`:
// - A readable copy: the files of every project the owner has joined, as they are, under `projects/<project name>/`,
//   and one Markdown file per conversation the owner can read on screen (#team, the channels of the owner's
//   projects, the owner's own direct conversations) under `messages/`, named for the channel or the people in it.
//   E23, E30 and E31 hold: nothing the owner cannot read on screen is written, and no key, token, invite, device id
//   or member id is in it.
// - The backup `<team name>.jennyteam` (host-backup.js), locked with the owner's password: the key, the relay
//   token, the saved setting and every store file under `profile/`, `projects/` and `trash/` (no lock, ready
//   marker or temporary file). The key leaves the secure store only into that file's ciphertext.
// Every path written is checked to be inside the new folder; the picked folder may not resolve inside
// `team-host`, nor hold it. The store files are walked first, before the password work: a link
// (`team_export_links`), a file that cannot be read (`team_export_unreadable_files`) or more entries than a walk
// takes (`team_export_too_many`) fails the export with its count, and so does too little free space on the
// picked drive (`team_disk_full`). A copy that would be partial fails the same way: nothing incomplete is left.
// The folder being written is recorded (host-sweep.js), so an export that never finishes is removed by the next
// sweep. The export reads a running team's files as they are, not one moment in time: a file that changes while
// it is read fails the export with `team_backup_source_changed` (stopping the server first avoids it).
//
// Owner decision E73 (2026-11-14): a member store that is there and does not read (it does not parse, or names no
// team id) writes the readable copy only and no backup file, and the ok answer says `backup_left_out`. With no member
// list nobody's projects or direct conversations are known, so that copy holds #team alone, every author "Someone". A
// member store that is not there still refuses (`team_export_unreadable`).
//
// The work is asynchronous: file copies, walks that yield, and each conversation written one segment at a time,
// never held whole. Nothing here logs a path or a name.

const fs = require('node:fs');
const path = require('node:path');

const { writeBackup } = require('./host-backup');
const {
  SEGMENT, copyTreeAsync, isRecord, isWithin, list, readJsonFile, realInside, removeTreeInsideAsync, tick, walkTreeAsync,
} = require('./host-files');
const { clearPendingExport, notePendingExport } = require('./host-sweep');

const SKIP_FILES = new Set(['.host.lock', 'team-ready.json']);
const TEMP_FILE = /(?:\.tmp|\.journal\.tmp)$/u;
const BACKUP_DIRS = ['profile', 'projects', 'trash'];
// Room left over on the picked drive beyond the copy and the backup.
const SPARE_BYTES = 256 * 1024 * 1024;

class ExportStop extends Error {
  constructor(reason, count) { super(reason); this.reason = reason; this.count = count; }
}

/** A name safe as one file or folder name on every platform (at most 80 characters), never empty. */
function safeName(text, fallback) {
  const cleaned = String(text || '').normalize('NFC').replace(/[<>:"/\\|?*\p{Cc}]/gu, ' ').replace(/\s+/gu, ' ')
    .trim().replace(/[. ]+$/u, '').slice(0, 80);
  if (!cleaned || /^(?:con|prn|aux|nul|com\d|lpt\d)$/iu.test(cleaned)) return fallback;
  return cleaned;
}

// A name not yet used in `taken` (case-folded): "x", "x (2)", "x (3)"…
function unique(name, taken) {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${name} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const timeOf = (iso) => (typeof iso === 'string' ? iso.slice(0, 16).replace('T', ' ') : '');

// The walk's counts as a stop, or null when the walk saw everything.
function stopOf({ links, unreadable, truncated }, limit) {
  if (links) return new ExportStop('team_export_links', links);
  if (unreadable) return new ExportStop('team_export_unreadable_files', unreadable);
  if (truncated) return new ExportStop('team_export_too_many', limit);
  return null;
}

// One conversation as Markdown, written one segment at a time in order.
async function writeConversation(file, dir, header, nameOf) {
  const segments = (await fs.promises.readdir(dir)).map((name) => SEGMENT.exec(name)).filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1])).map((match) => match[0]);
  const handle = await fs.promises.open(file, 'wx');
  try {
    await handle.write(header);
    for (const name of segments) {
      await tick();
      const messages = list(readJsonFile(path.join(dir, name))?.messages)
        .filter((m) => m && !m.deleted && typeof m.text === 'string').sort((a, b) => a.seq - b.seq);
      let text = '';
      for (const message of messages) {
        const who = message.author?.kind === 'member' ? nameOf(message.author.member_id) : 'Jenny';
        text += `**${who}** · ${timeOf(message.created_at)}${message.thread_root_id ? ' · reply' : ''}\n${message.text}\n\n`;
      }
      if (text) await handle.write(text);
    }
  } finally {
    await handle.close();
  }
}

// The title of a conversation the owner can read on screen, or null.
function titleOf(entry, channel, mine, ownerId, nameOf) {
  const projectId = entry.channel_id.slice('chan_'.length);
  if (entry.kind === 'team') return '#team';
  if (entry.kind === 'channel' && typeof channel.name === 'string') return `#${channel.name}`;
  if (entry.kind === 'project' && !channel.archived && mine.has(projectId)) return `#${mine.get(projectId)}`;
  if (entry.kind === 'dm' && list(channel.participants).includes(ownerId)) {
    return list(channel.participants).filter((m) => m !== ownerId).map(nameOf).join(' and ');
  }
  return null;
}

// The readable copy into `out`. Throws an ExportStop when any part of it could not be copied or read.
async function writeReadableCopy({ root, out, doc, ownerId, teamName, projectNames, exportedAt, limit }) {
  const names = new Map(list(doc.members).map((m) => [m.member_id, typeof m.display_name === 'string' ? m.display_name : '']));
  const nameOf = (id) => names.get(id) || 'Someone';
  const mine = new Map();
  for (const row of list(doc.projects)) {
    if (row?.state === 'active' && list(row.members).some((m) => m?.member_id === ownerId)) {
      mine.set(row.project_id, projectNames.get(row.project_id) || row.project_id);
    }
  }
  const projectsOut = path.join(out, 'projects');
  await fs.promises.mkdir(projectsOut);
  const takenProjects = new Set();
  for (const [id, name] of mine) {
    const from = realInside(path.join(root, 'projects'), path.join(root, 'projects', id));
    if (!from) continue; // a project with no folder yet has no files
    const copied = await copyTreeAsync(from, path.join(projectsOut, unique(safeName(name, 'project'), takenProjects)), { limit });
    const stop = stopOf(copied, limit);
    if (stop) throw stop;
  }
  const messagesOut = path.join(out, 'messages');
  await fs.promises.mkdir(messagesOut);
  const takenFiles = new Set();
  let unread = 0;
  let index;
  try { index = readJsonFile(path.join(root, 'profile', 'team-chat', 'index.json')); } catch { index = null; }
  for (const entry of list(index?.channels)) {
    if (typeof entry?.channel_id !== 'string' || !/^chan_[A-Za-z0-9_-]{1,80}$/u.test(entry.channel_id)) continue;
    const dir = path.join(root, 'profile', 'team-chat', entry.channel_id);
    try {
      const title = titleOf(entry, readJsonFile(path.join(dir, 'channel.json')), mine, ownerId, nameOf);
      if (!title) continue;
      const file = path.join(messagesOut, `${unique(safeName(title, 'conversation'), takenFiles)}.md`);
      await writeConversation(file, dir, `# ${title}\n\n${teamName}, exported ${dateOf(exportedAt)}.\n\n`, nameOf);
    } catch {
      unread += 1;
    }
  }
  if (unread) throw new ExportStop('team_export_unreadable_files', unread);
}

// The member store: { doc } when it reads, { absent: true } when it is not there, else { unreadable: true } (E73).
function readMemberStore(root) {
  try {
    const doc = readJsonFile(path.join(root, 'profile', 'team-members.json'));
    return typeof doc?.team?.team_id === 'string' ? { doc } : { unreadable: true };
  } catch (error) {
    // A read that failed with a system code (a lock, a permission, no handle left) is not a damaged list: it
    // refuses as an absent one does, so the owner is never sent to Delete over a passing fault (review pass).
    return typeof error?.code === 'string' ? { absent: true } : { unreadable: true };
  }
}

// Every store file of the team for the backup, `/`-separated, no link followed; with the walk's counts.
const backupEntries = (root, limit) => backupEntriesOf(BACKUP_DIRS.map((top) => ({ top, base: path.join(root, top) })), limit);

/** backupEntries over named folders ({ top, base }: `profile`, `projects`, `trash`), wherever each lives. */
async function backupEntriesOf(bases, limit) {
  const entries = [];
  const seen = { links: 0, unreadable: 0, truncated: false, bytes: 0 };
  for (const { top, base } of bases) {
    try { if (!(await fs.promises.lstat(base)).isDirectory()) continue; } catch { continue; }
    entries.push({ rel: top, dir: true });
    const walked = await walkTreeAsync(base, {
      limit,
      onDir: (rel) => { entries.push({ rel: `${top}/${rel.split(path.sep).join('/')}`, dir: true }); },
      onFile: (rel, abs, size) => {
        const name = path.basename(rel);
        if (SKIP_FILES.has(name) || TEMP_FILE.test(name)) return;
        seen.bytes += size;
        entries.push({ rel: `${top}/${rel.split(path.sep).join('/')}`, abs });
      },
    });
    seen.links += walked.links;
    seen.unreadable += walked.unreadable;
    seen.truncated = seen.truncated || walked.truncated;
  }
  return { entries, ...seen };
}

// The free bytes on the drive holding `dir`, or null when the system cannot say.
async function freeBytes(dir, statfs) {
  try {
    const stat = await statfs(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

/**
 * Exports the team under the real `root` into `picked`. `secrets`: { seed (Buffer), relayToken }; `setting`:
 * { name, direct_port, internet }; `userDataPath`: where the folder being written is recorded. Answers
 * { ok, folder, bytes, backup_left_out? } or { ok: false, reason, count? }.
 */
async function exportTeam({ root, picked, userDataPath, ownerId, setting, secrets, password, now = Date.now(),
  limit = 2_000_000, statfs = fs.promises.statfs }) {
  const realPicked = realInside(picked, picked);
  if (!realPicked || isWithin(root, realPicked) || isWithin(realPicked, root)) return { ok: false, reason: 'team_export_folder_invalid' };
  const members = readMemberStore(root);
  if (members.absent) return { ok: false, reason: 'team_export_unreadable' };
  const doc = members.doc ?? {};
  const projectNames = new Map();
  try {
    const projects = readJsonFile(path.join(root, 'profile', 'projects.json'));
    for (const [id, record] of Object.entries(isRecord(projects?.projects) ? projects.projects : {})) {
      if (typeof record?.name === 'string') projectNames.set(id, record.name);
    }
  } catch { /* names fall back to ids */ }
  const source = await backupEntries(root, limit);
  const early = stopOf(source, limit);
  if (early) return { ok: false, reason: early.reason, count: early.count };
  // The readable copy is at most the size of the stores, and the backup about the same again.
  const free = await freeBytes(realPicked, statfs);
  // (No backup is written over a member store that does not read: E73.)
  const copies = members.unreadable ? 1 : 2;
  if (free !== null && free < source.bytes * copies + SPARE_BYTES) return { ok: false, reason: 'team_disk_full' };
  const teamName = setting.name;
  const taken = new Set(fs.readdirSync(realPicked).map((n) => n.toLowerCase()));
  const out = path.join(realPicked, unique(`${safeName(teamName, 'Team')} ${dateOf(now)}`, taken));
  try {
    notePendingExport(userDataPath, { parent: realPicked, folder: out });
    fs.mkdirSync(out);
  } catch {
    clearPendingExport(userDataPath);
    return { ok: false, reason: 'team_export_write_failed' };
  }
  try {
    await writeReadableCopy({ root, out, doc, ownerId, teamName, projectNames, exportedAt: now, limit });
    if (members.unreadable) {
      const bytes = (await walkTreeAsync(out)).bytes;
      clearPendingExport(userDataPath);
      return { ok: true, folder: out, bytes, backup_left_out: true };
    }
    const manifest = { schema: 1, team_name: teamName, team_id: doc?.team?.team_id ?? null, exported_at: now,
      key: secrets.seed.toString('base64url'), relay_token: secrets.relayToken ?? null,
      setting: { name: teamName, direct_port: setting.direct_port ?? null, internet: setting.internet ?? null } };
    await writeBackup({ target: path.join(out, `${safeName(teamName, 'Team')}.jennyteam`), password, manifest, entries: source.entries });
    const bytes = (await walkTreeAsync(out)).bytes;
    clearPendingExport(userDataPath);
    return { ok: true, folder: out, bytes };
  } catch (error) {
    if ((await removeTreeInsideAsync(realPicked, out)).ok) clearPendingExport(userDataPath);
    return { ok: false, reason: error?.reason || 'team_export_write_failed',
      ...(Number.isSafeInteger(error?.count) ? { count: error.count } : {}) };
  }
}

// The headless export (server/team/team-export.js) shares the walk, its stops and the room estimate.
module.exports = { SPARE_BYTES, backupEntriesOf, exportTeam, freeBytes, stopOf };
