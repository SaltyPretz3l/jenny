'use strict';

// What deleting a hosted team removes, counted from the files under `<userData>/team-host/` (slice 5-6, E61).
// It needs no running server and no key, and runs in main only when the delete confirmation or an old team's row
// asks. No Electron. A part that cannot be read is named in `uncounted` and blocks nothing.
//
// Read: `profile/team-members.json` (members, pending joiners, unused invites, the team's projects),
// `profile/team-chat/` (channels, live messages, attachments), `profile/projects.json` (project names),
// `profile/sessions/_index.json` (conversations per project), `projects/<project_id>/` (files and bytes, no link
// followed) and `trash/<project_id>-<17 digits>/` (E24's trash; the name is no longer recorded there). A reply
// running now is taken from `profile/sessions/_active_turns.state` and the session files it names, and only
// while the server runs (the caller says so). The answer holds names and numbers, never a key, token, invite,
// device id or file path, and nothing here logs.
//
// The walks are asynchronous and yield (host-files.js), and a channel is counted one segment at a time with a
// yield between segments, so main keeps answering while a large team is counted. The channel's own index counts
// the stored messages, deleted ones included, and no attachments, so the segments are read instead.

const fs = require('node:fs');
const path = require('node:path');

const { isCleanText } = require('../../../server/team/member-schema');
const { SEGMENT, isRecord, list, readJsonFile, tick, walkTreeAsync } = require('./host-files');

const MEMBERS = path.join('profile', 'team-members.json');
const CHAT_DIR = path.join('profile', 'team-chat');
const PROJECTS_FILE = path.join('profile', 'projects.json');
const SESSIONS_DIR = path.join('profile', 'sessions');
const TRASH_NAME = /^(project_[A-Za-z0-9_-]{1,64})-(\d{17})$/u;
const DAY_MS = 86_400_000;

// A 17-digit UTC stamp (YYYYMMDDHHmmssSSS) as epoch milliseconds, or null.
function stampMs(digits) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/u.exec(digits);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  return Number.isFinite(ms) ? ms : null;
}

function readMembers(root, uncounted) {
  try {
    const doc = readJsonFile(path.join(root, MEMBERS));
    return isRecord(doc) ? doc : null;
  } catch {
    uncounted.push('members');
    return null;
  }
}

function people(doc, now) {
  const members = list(doc?.members);
  const active = members.filter((m) => m && m.state === 'active');
  // The owner first, then the roster order.
  active.sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0));
  return {
    members: active.map((m) => ({ name: typeof m.display_name === 'string' ? m.display_name : '', owner: m.role === 'owner' })),
    pending: members.filter((m) => m && m.state === 'pending').length,
    // Unused invites for new people: not redeemed, not revoked, not expired.
    invites: list(doc?.invites).filter((i) => i && i.member_id === null && i.role !== 'owner' && i.used_at === null
      && i.revoked_at === null && Number(i.expires_at) > now).length,
    owner_id: (members.find((m) => m && m.role === 'owner' && m.state === 'active') || {}).member_id || null,
  };
}

// Live (not deleted) messages and attachments of one channel, read one segment file at a time.
async function countChannel(dir) {
  let messages = 0;
  let attachments = 0;
  for (const name of await fs.promises.readdir(dir)) {
    if (!SEGMENT.test(name)) continue;
    await tick();
    const segment = readJsonFile(path.join(dir, name));
    for (const message of list(segment?.messages)) {
      if (!message || message.deleted) continue;
      messages += 1;
      attachments += list(message.attachments).length;
    }
  }
  return { messages, attachments };
}

async function chat(root, uncounted) {
  const out = { team: false, project_channels: 0, messages: 0, attachments: 0, dms: 0, dm_messages: 0 };
  let index;
  try {
    index = readJsonFile(path.join(root, CHAT_DIR, 'index.json'));
  } catch (error) {
    if (error?.code !== 'ENOENT') uncounted.push('messages');
    return out;
  }
  for (const entry of list(index?.channels)) {
    const id = typeof entry?.channel_id === 'string' && /^chan_[A-Za-z0-9_-]{1,80}$/u.test(entry.channel_id) ? entry.channel_id : null;
    if (!id) continue;
    let counted;
    try {
      counted = await countChannel(path.join(root, CHAT_DIR, id));
    } catch {
      if (!uncounted.includes('messages')) uncounted.push('messages');
      continue;
    }
    if (entry.kind === 'dm') {
      out.dms += 1;
      out.dm_messages += counted.messages;
    } else {
      if (entry.kind === 'team') out.team = true;
      else if (entry.kind === 'project') out.project_channels += 1;
      out.messages += counted.messages;
    }
    out.attachments += counted.attachments;
  }
  return out;
}

// Conversations per project id from the session index (archived ones included: they are deleted too).
function conversations(root, uncounted) {
  const counts = new Map();
  try {
    const index = readJsonFile(path.join(root, SESSIONS_DIR, '_index.json'));
    for (const summary of Object.values(isRecord(index?.sessions) ? index.sessions : {})) {
      const id = summary?.project_id;
      if (typeof id === 'string') counts.set(id, (counts.get(id) || 0) + 1);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') uncounted.push('conversations');
  }
  return counts;
}

function projectNames(root, uncounted) {
  try {
    const doc = readJsonFile(path.join(root, PROJECTS_FILE));
    const names = new Map();
    for (const [id, record] of Object.entries(isRecord(doc?.projects) ? doc.projects : {})) {
      if (typeof record?.name === 'string') names.set(id, record.name);
    }
    return names;
  } catch (error) {
    if (error?.code !== 'ENOENT') uncounted.push('projects');
    return new Map();
  }
}

// A reply running now: the session ids the active-turn marker names whose file still holds a turn.
function runningReplies(root, names, sessionsByProject) {
  const busy = [];
  let marker;
  try { marker = readJsonFile(path.join(root, SESSIONS_DIR, '_active_turns.state')); } catch { return busy; }
  for (const id of list(marker?.session_ids).slice(0, 64)) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) continue;
    try {
      const session = readJsonFile(path.join(root, SESSIONS_DIR, `${id}.json`));
      if (!isRecord(session?.active_turn)) continue;
      const projectId = session.project_id;
      if (!sessionsByProject.has(projectId)) continue;
      busy.push({ project: names.get(projectId) || '', conversation: typeof session.title === 'string' ? session.title : '' });
    } catch { /* gone or unreadable: not counted as running */ }
  }
  return busy;
}

const projectIdOf = (row) => (typeof row?.project_id === 'string' && /^project_[A-Za-z0-9_-]{1,64}$/u.test(row.project_id)
  ? row.project_id : null);

// Each of the team's project folders, walked: [{ project_id, files, bytes }].
async function projectFolders(root, doc, uncounted) {
  const out = [];
  for (const row of list(doc?.projects)) {
    const id = projectIdOf(row);
    if (!id) continue;
    const folder = path.join(root, 'projects', id);
    let walked = { files: 0, bytes: 0, links: 0, unreadable: 0, truncated: false };
    try {
      await fs.promises.stat(folder);
      walked = await walkTreeAsync(folder);
    } catch { /* no folder: nothing in it */ }
    if (walked.links || walked.unreadable || walked.truncated) uncounted.push('project_files');
    out.push({ project_id: id, files: walked.files, bytes: walked.bytes });
  }
  return out;
}

/**
 * The delete confirmation's numbers for the team under `root` (the real `team-host` path). `running`: the
 * server runs now (a reply can only be running then). `now`: the clock, for invite expiry and trash age.
 */
async function readInventory(root, { running = false, now = Date.now() } = {}) {
  const uncounted = [];
  const doc = readMembers(root, uncounted);
  const who = people(doc, now);
  const names = projectNames(root, uncounted);
  const sessions = conversations(root, uncounted);
  const projects = (await projectFolders(root, doc, uncounted)).map((p) => ({ ...p, name: names.get(p.project_id) || '',
    conversations: sessions.get(p.project_id) || 0 }));
  const trash = [];
  try {
    for (const name of await fs.promises.readdir(path.join(root, 'trash'))) {
      const match = TRASH_NAME.exec(name);
      if (!match) continue;
      const at = stampMs(match[2]);
      const walked = await walkTreeAsync(path.join(root, 'trash', name));
      trash.push({ days_ago: at === null ? null : Math.max(0, Math.floor((now - at) / DAY_MS)), bytes: walked.bytes });
    }
  } catch (error) { if (error?.code !== 'ENOENT') uncounted.push('trash'); }
  const owned = new Set(projects.map((p) => p.project_id));
  const counted = await chat(root, uncounted);
  return {
    team_name: typeof doc?.team?.name === 'string' ? doc.team.name : null,
    members: who.members, pending: who.pending, invites: who.invites,
    chat: counted, projects, trash,
    busy: running ? runningReplies(root, names, owned) : [],
    uncounted: [...new Set(uncounted)],
  };
}

/**
 * The saved member store's owner and team ids and the team's name, read once: { read, unreadable, ownerId, teamId,
 * teamName } (each null when unknown; `read`: the store was read as a record; `unreadable`: a file is there and gives
 * no team id: torn, not JSON, over the cap, not a record or a read that failed, review sweeps second run X4b-F04).
 * The name is the store's because `team.rename` writes only the store (R09-F04); a name that is not clean text reads
 * as unknown.
 */
function savedMembers(root) {
  try {
    const doc = readJsonFile(path.join(root, MEMBERS));
    const id = doc?.team?.team_id;
    const name = doc?.team?.name;
    const teamId = typeof id === 'string' ? id : null;
    return { read: isRecord(doc), unreadable: teamId === null, ownerId: people(doc, Date.now()).owner_id, teamId,
      teamName: isCleanText(name) ? name : null };
  } catch (error) {
    return { read: false, unreadable: error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR', ownerId: null, teamId: null,
      teamName: null };
  }
}

/** The facts an old team's row shows, from its project folders only: { team_id, projects, bytes }. */
async function projectFacts(root) {
  const doc = readMembers(root, []);
  const folders = await projectFolders(root, doc, []);
  const id = doc?.team?.team_id;
  return { team_id: typeof id === 'string' ? id : null, projects: folders.length,
    bytes: folders.reduce((sum, p) => sum + p.bytes, 0) };
}

module.exports = { projectFacts, readInventory, savedMembers };
