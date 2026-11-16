'use strict';

// A hosted team seeded on disk for the slice 5-6 tests (delete, start a new team, export, restore): the saved
// config, the host key in a memory secure store, the member store, chat, projects, conversations and trash, laid
// out as the host writes them, and this Jenny's own membership as the owner. Every value is a made-up placeholder.

const fs = require('node:fs');
const path = require('node:path');

const { HOST_KEY_NAME } = require('../../services/team/host/host-key-store');
const { buildHostConfig, prepareHostLayout, writeHostConfig } = require('../../services/team/host/host-layout');
const { saveClientFile } = require('../../services/team/client-file');
const { deriveTeamId, encodeBase64url, keyPairFromSeed } = require('../../server/team/ids');
const { HOST_SEED } = require('../server/helpers/team-host-fixture');

const TEAM_NAME = 'Studio';
const HOST_PUBLIC_KEY = keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey;
const TEAM_ID = deriveTeamId(HOST_PUBLIC_KEY);
const OWNER = 'member_ownerAAAA1111';
const DOT = 'member_dotBBBB2222';
const MAYA = 'member_mayaCCCC3333';
const PAT = 'member_patDDDD4444';
const DM = `chan_dm_${'a'.repeat(64)}`;
const NOW = Date.parse('2026-11-12T12:00:00.000Z');

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
};

function message(seq, author, text, { deleted = false, reply = false } = {}) {
  return { id: `msg_${String(seq).padStart(26, '0')}`, seq, author: { kind: 'member', member_id: author },
    created_at: `2026-11-1${seq % 2}T10:0${seq % 10}:00.000Z`, text: deleted ? '' : text, thread_root_id: reply ? 'msg_root' : null,
    attachments: [], deleted: deleted ? { by: author, at: 'x' } : null };
}

/** The team files under `<userDataPath>/team-host`; answers the real layout. */
function seedTeamFiles(userDataPath, { internet = null } = {}) {
  const layout = prepareHostLayout(userDataPath);
  writeHostConfig(layout, buildHostConfig({ layout, name: TEAM_NAME, directPort: 51820, internet }));
  const p = (...parts) => path.join(layout.profile, ...parts);
  write(p('team-members.json'), {
    schema_version: 3, rev: 4, team: { team_id: TEAM_ID, host_public_key: HOST_PUBLIC_KEY, name: TEAM_NAME, created_at: NOW, model: null },
    members: [
      { member_id: DOT, display_name: 'Dot', role: 'member', state: 'active' },
      { member_id: OWNER, display_name: 'Olive', role: 'owner', state: 'active' },
      { member_id: MAYA, display_name: 'Maya', role: 'read_only', state: 'active' },
      { member_id: PAT, display_name: 'Pat', role: 'member', state: 'pending' },
      { member_id: 'member_goneEEEE5555', display_name: 'Gone', role: 'member', state: 'revoked' },
    ],
    devices: [],
    invites: [
      { invite_id: 'invite_live', member_id: null, role: 'member', used_at: null, revoked_at: null, expires_at: NOW + 3_600_000 },
      { invite_id: 'invite_used', member_id: null, role: 'member', used_at: NOW - 5, revoked_at: null, expires_at: NOW + 3_600_000 },
      { invite_id: 'invite_old', member_id: null, role: 'member', used_at: null, revoked_at: null, expires_at: NOW - 5 },
    ],
    projects: [
      { project_id: 'project_site', state: 'active', members: [{ member_id: OWNER, role: 'admin' }, { member_id: DOT, role: 'writer' }] },
      { project_id: 'project_tax', state: 'active', members: [{ member_id: DOT, role: 'admin' }] },
    ],
  });
  write(p('projects.json'), { schema_version: 1, projects: {
    project_general: { id: 'project_general', name: 'General' },
    project_site: { id: 'project_site', name: 'jenny-site', root_path: path.join(layout.projects, 'project_site') },
    project_tax: { id: 'project_tax', name: 'tax-2026', root_path: path.join(layout.projects, 'project_tax') },
  } });
  write(p('sessions', '_index.json'), { schema_version: 1, sessions: {
    s1: { id: 's1', project_id: 'project_site', title: 'Landing copy' },
    s2: { id: 's2', project_id: 'project_site', title: 'Fonts', archived_at: 'x' },
    s3: { id: 's3', project_id: 'project_tax', title: 'Receipts' },
    s4: { id: 's4', project_id: 'project_general', title: 'Mine' },
  } });
  write(p('sessions', '_active_turns.state'), { version: 1, session_ids: ['s1'] });
  write(p('sessions', 's1.json'), { id: 's1', project_id: 'project_site', title: 'Landing copy', active_turn: { status: 'streaming' } });
  write(p('team-chat', 'index.json'), { schema_version: 1, channels: [
    { channel_id: 'chan_team', kind: 'team' }, { channel_id: 'chan_project_site', kind: 'project' },
    { channel_id: 'chan_project_tax', kind: 'project' }, { channel_id: DM, kind: 'dm' },
  ] });
  write(p('team-chat', 'chan_team', 'channel.json'), { channel_id: 'chan_team', kind: 'team', archived: null, participants: null });
  write(p('team-chat', 'chan_team', 'seg-1.json'), { messages: [message(1, OWNER, 'Hello all'), message(2, DOT, 'Hi'),
    message(3, DOT, 'gone', { deleted: true })] });
  write(p('team-chat', 'chan_project_site', 'channel.json'), { channel_id: 'chan_project_site', kind: 'project', archived: null });
  write(p('team-chat', 'chan_project_site', 'seg-1.json'), { messages: [message(1, DOT, 'New hero image'), message(2, OWNER, 'Nice', { reply: true })] });
  write(p('team-chat', 'chan_project_tax', 'channel.json'), { channel_id: 'chan_project_tax', kind: 'project', archived: null });
  write(p('team-chat', 'chan_project_tax', 'seg-1.json'), { messages: [message(1, DOT, 'Secret tax talk')] });
  write(p('team-chat', DM, 'channel.json'), { channel_id: DM, kind: 'dm', archived: null, participants: [DOT, OWNER].sort() });
  write(p('team-chat', DM, 'seg-1.json'), { messages: [message(1, DOT, 'Private hello'), message(2, OWNER, 'Private reply')] });
  write(p('team-audit.json'), { schema_version: 1, floor_seq: 0, next_seq: 1, entries: [] });
  write(path.join(layout.projects, 'project_site', 'index.html'), '<h1>site</h1>');
  write(path.join(layout.projects, 'project_site', 'img', 'hero.bin'), Buffer.alloc(3000, 1));
  write(path.join(layout.projects, 'project_tax', 'receipts.csv'), 'a,b\n1,2\n');
  write(path.join(layout.trash, 'project_oldie-20261108120000000', 'old.bin'), Buffer.alloc(900, 2));
  return layout;
}

/** The host key in `secureStore` and this Jenny's own membership (as `memberId`, the owner by default). */
function seedOwnership(userDataPath, secureStore, { memberId = OWNER, key = true } = {}) {
  if (key) secureStore.values.set(HOST_KEY_NAME, encodeBase64url(Buffer.from(HOST_SEED)));
  const saved = saveClientFile(userDataPath, { schema_version: 1, team_id: TEAM_ID, host_public_key: HOST_PUBLIC_KEY,
    address_hints: ['127.0.0.1:51820'], last_addresses: ['127.0.0.1:51820'], member_id: memberId, device_id: 'device_ownerAAAA1111',
    display_name: 'Olive', joined_at: '2026-11-10T10:00:00.000Z', state_seen: 'active' });
  if (!saved.ok) throw new Error(`seed membership failed: ${saved.reason}`);
}

/** Every file under `root` as relative path -> bytes (hex), for byte-for-byte comparisons. */
function treeBytes(root, skip = () => false) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (skip(rel)) continue;
      if (entry.isDirectory()) walk(abs); else if (entry.isFile()) out[rel] = fs.readFileSync(abs).toString('hex');
    }
  };
  walk(root);
  return out;
}

module.exports = {
  DM, DOT, HOST_PUBLIC_KEY, MAYA, NOW, OWNER, PAT, TEAM_ID, TEAM_NAME, seedOwnership, seedTeamFiles, treeBytes,
};
