'use strict';

// Shared setup for the headless maintenance commands (slices 3-13, 3-14): the team host fixture with a data
// volume (`data/projects`, `data/trash`), the two setup-only mounts (`import`, `exchange`) in the config, a seeded
// team (owner, member, one project with a folder, a project audit entry, a trash entry), terminal stand-ins and
// a tree snapshot for comparisons. Nothing here reads a real key file or a user profile.

const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { createTeamBoards } = require('../../../server/team/boards/team-boards');
const { MemberStore } = require('../../../server/team/member-store');
const { createOutputStream, createTeamHostFixture, randomKey } = require('./team-host-fixture');

const PASSWORD = 'correct horse battery staple';

// A terminal input: `isTTY`, raw mode, and the bytes a test pushes.
function ttyInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; return input; };
  return input;
}

// Every file under `root` by `/`-separated relative path, as bytes (folders listed with a trailing slash).
function snapshot(root, { skip = () => false } = {}) {
  const files = {};
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(childRel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { files[`${childRel}/`] = true; walk(full, childRel); } else files[childRel] = fs.readFileSync(full);
    }
  };
  walk(root, '');
  return files;
}

function createMaintenanceFixture(t, { writeKey = true, mounts = true } = {}) {
  const fx = createTeamHostFixture(t, { writeKey });
  const data = path.join(fx.root, 'data');
  const projects = path.join(data, 'projects');
  const importDir = path.join(fx.root, 'import');
  const exchangeDir = path.join(fx.root, 'exchange');
  fs.mkdirSync(projects, { recursive: true });
  if (mounts) {
    fs.mkdirSync(importDir);
    fs.mkdirSync(exchangeDir);
  }
  fx.writeConfig({ team: { projects_root: projects, import_dir: importDir, exchange_dir: exchangeDir } });
  const terminal = () => createOutputStream({ isTTY: true });
  Object.assign(fx, {
    data, projects, trash: path.join(data, 'trash'), importDir, exchangeDir, terminal,
    store() {
      const store = new MemberStore({ userDataPath: fx.profile, hostPublicKey: fx.hostPublicKey, teamName: fx.teamName });
      const opened = store.open();
      if (!opened.ok) throw new Error(`store open failed: ${opened.error.reason}`);
      return store;
    },
    // Owner, member, one project row with its folder and a file in it, and one trash entry.
    async seedTeam() {
      const seeded = await fx.seedMembers(randomKey());
      const store = fx.store();
      const made = await store.createProject({ actorMemberId: seeded.owner.member_id });
      if (!made.ok) throw new Error(`seed project failed: ${made.error.reason}`);
      const projectId = made.project_id;
      fs.mkdirSync(path.join(projects, projectId, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(projects, projectId, 'notes', 'a.txt'), 'shared notes\n');
      fs.mkdirSync(path.join(data, 'trash', 'project_gone-20261101000000000'), { recursive: true });
      fs.writeFileSync(path.join(data, 'trash', 'project_gone-20261101000000000', 'old.txt'), 'old');
      fs.writeFileSync(path.join(fx.profile, 'profile-owner.json'), JSON.stringify({ schema_version: 1, host_mode: 'server' }));
      fs.writeFileSync(path.join(fx.profile, '.host.lock'), '');
      return { ...seeded, projectId, store };
    },
    // Row 151 T1: a board in `projectId` through the real host board store on the profile (a document, a journal and a
    // proposals file under team-boards/<project_id>/), plus a file in the reserved assets folder. Answers the board id.
    async seedBoard(projectId) {
      const boards = createTeamBoards({ userDataPath: fs.realpathSync.native(fx.profile) });
      const made = await boards.create({ projectId, actor: 'member_seed', name: 'Seeded board' });
      if (!made.ok) throw new Error(`seed board failed: ${made.error.reason}`);
      const batch = { batch_id: 'seed-1', ops: [{ op: 'card.add', card: { id: '00000000-0000-4000-8000-000000000001', kind: 'note',
        x: 0, y: 0, data: { text: 'seeded' } } }] };
      for (const answer of [await boards.apply({ projectId, boardId: made.board.id, actor: 'member_seed', batch }),
        await boards.writeProposals({ projectId, boardId: made.board.id, actor: 'member_seed', proposals: [{ id: 'p1' }] })]) {
        if (!answer.ok) throw new Error(`seed board failed: ${answer.error.reason}`);
      }
      fs.mkdirSync(path.join(fx.profile, 'team-boards', projectId, 'assets'));
      fs.writeFileSync(path.join(fx.profile, 'team-boards', projectId, 'assets', 'seed.png'), 'png');
      return made.board.id;
    },
    // The common arguments of a maintenance command.
    args(extra = {}) {
      return { configPath: fx.configPath, acquireProfileImpl: fx.acquireProfileImpl, logger: fx.logger,
        output: terminal(), input: ttyInput(), promptOutput: terminal(), ...extra };
    },
    // A password reader that answers `answers` in turn.
    passwords(...answers) {
      const asked = [];
      return { asked, read: async ({ prompt }) => { asked.push(prompt); if (!answers.length) throw new Error('ended'); return answers.shift(); } };
    },
    // The team's three volumes, without the profile's lock and owner files.
    volumes() {
      const keep = (rel) => rel === '.host.lock' || rel === 'profile-owner.json';
      return { profile: snapshot(fx.profile, { skip: keep }), projects: snapshot(projects), trash: snapshot(path.join(data, 'trash')),
        secrets: snapshot(fx.secrets) };
    },
  });
  return fx;
}

module.exports = { PASSWORD, createMaintenanceFixture, snapshot, ttyInput };
