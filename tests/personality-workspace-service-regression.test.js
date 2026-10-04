'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PersonalityWorkspaceService } = require('../services/personality-workspace-service');
const { CONTEXT_FILE_MAX_BYTES } = require('../services/personality-workspace-service');

async function createWorkspace(t) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-personality-regression-'));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const workspacePath = path.join(userDataPath, 'personality', 'default-workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  return { userDataPath, workspacePath };
}

test('v3 archives a non-stock comment-only identity byte-identically', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const source = Buffer.from('<!-- user-authored identity comment -->\n');
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), source);

  const state = await new PersonalityWorkspaceService({ userDataPath }).getState({ agentName: 'Jenny' });

  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'legacy', 'IDENTITY.md')), source);
  assert.ok(state.migration.archivedFiles.includes('IDENTITY.md'));
  assert.deepEqual(state.migration.mergedFrom, []);
});

test('v3 archives a non-stock heading-only soul byte-identically', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const source = Buffer.from('# User-authored soul heading\n');
  await fs.writeFile(path.join(workspacePath, 'SOUL.md'), source);

  const state = await new PersonalityWorkspaceService({ userDataPath }).getState({ agentName: 'Jenny' });

  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'legacy', 'SOUL.md')), source);
  assert.ok(state.migration.archivedFiles.includes('SOUL.md'));
  assert.deepEqual(state.migration.mergedFrom, []);
});

test('overflow collision uses the suffixed archive name everywhere', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const identityBody = `IDENTITY LINE ${'i'.repeat(60)}\n`.repeat(600);
  const soulBody = `SOUL LINE ${'s'.repeat(60)}\n`.repeat(600);
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), `# Identity\n\n${identityBody}`, 'utf8');
  await fs.writeFile(path.join(workspacePath, 'SOUL.md'), `# Soul\n\n${soulBody}`, 'utf8');
  await fs.mkdir(path.join(workspacePath, 'legacy'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'legacy', 'PERSONALITY.overflow.md'), 'existing archive\n', 'utf8');
  const events = [];
  const service = new PersonalityWorkspaceService({
    userDataPath,
    logger: (level, event, details) => events.push({ level, event, details }),
  });

  const state = await service.getState({ agentName: 'Jenny' });
  const archivedAs = 'PERSONALITY.overflow.md.1';
  const note = await fs.readFile(path.join(workspacePath, 'PERSONALITY.md'), 'utf8');
  const overflow = await fs.readFile(path.join(workspacePath, 'legacy', archivedAs), 'utf8');
  const logged = events.find((entry) => entry.details.step === 'note_overflow');

  assert.match(note, new RegExp(`legacy/${archivedAs.replaceAll('.', '\\.')}`));
  assert.match(overflow, /SOUL LINE/);
  assert.ok(state.migration.archivedFiles.includes(archivedAs));
  assert.equal(logged.details.file, archivedAs);
  assert.equal(
    await fs.readFile(path.join(workspacePath, 'legacy', 'PERSONALITY.overflow.md'), 'utf8'),
    'existing archive\n'
  );
});

test('blank USER save preserves app-owned frontmatter without restoring the placeholder', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const userPath = path.join(workspacePath, 'USER.md');
  await fs.writeFile(userPath, '---\ntimezone: America/Chicago\n---\n\nAbout me.\n', 'utf8');
  const service = new PersonalityWorkspaceService({ userDataPath });

  const result = await service.save({ user: '   ' });

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(userPath, 'utf8'), '---\ntimezone: America/Chicago\n---\n\n');
  assert.equal(await service.getResolvedTimeZone(), 'America/Chicago');
});

for (const filename of ['PERSONALITY.md', 'USER.md', 'MEMORY.md']) {
  test(`unreadable ${filename} fails editor load and blocks blank saves after recovery`, async (t) => {
    const { userDataPath, workspacePath } = await createWorkspace(t);
    const service = new PersonalityWorkspaceService({ userDataPath });
    await service.ensureSeeded();
    const target = path.join(workspacePath, filename);
    await fs.writeFile(target, 'precious bytes\n');
    const realStat = fs.stat;
    const mocked = t.mock.method(fs, 'stat', async (file, ...args) => {
      if (file === target) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return realStat(file, ...args);
    });
    const readEditor = () => filename === 'MEMORY.md' ? service.getNotesState() : service.getState();
    await assert.rejects(readEditor(), { code: 'CMP-PERS-0001' });
    mocked.mock.restore();
    const save = () => filename === 'MEMORY.md'
      ? service.writeNotes({ body: '', force: true }) : service.save({ personality: '', user: '', force: true });
    assert.equal((await save()).ok, false);
    assert.equal(await fs.readFile(target, 'utf8'), 'precious bytes\n');
    if (filename === 'MEMORY.md') {
      await service.getState();
      assert.equal((await save()).ok, false);
    }
    await readEditor();
    assert.equal((await save()).ok, true);
  });
}

test('personality read caps bytes even when the path stat is stale', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const service = new PersonalityWorkspaceService({ userDataPath });
  await service.ensureSeeded();
  const target = path.join(workspacePath, 'PERSONALITY.md');
  await fs.writeFile(target, 'x'.repeat(CONTEXT_FILE_MAX_BYTES + 1));
  const realStat = fs.stat;
  t.mock.method(fs, 'stat', async (file, ...args) => {
    const stat = await realStat(file, ...args);
    if (file === target) stat.size = 1;
    return stat;
  });
  const state = await service.getState();
  assert.equal(state.files.personality.oversized, true);
  assert.equal(state.files.personality.body, '');
  assert.equal((await service.save({ personality: '' })).ok, false);
});

test('migration rolls back oversized archives without loading their bytes', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const target = path.join(workspacePath, 'IDENTITY.md');
  const bytes = Buffer.alloc(CONTEXT_FILE_MAX_BYTES * 2, 120);
  await fs.writeFile(target, bytes);
  const service = new PersonalityWorkspaceService({ userDataPath });
  const realRead = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === target) throw new Error('unbounded legacy read');
    return realRead(file, ...args);
  });
  service._writePersonalityState = async () => { throw new Error('disk full'); };
  await assert.rejects(service.ensureSeeded(), /disk full/);
  assert.deepEqual(await realRead(target), bytes);
  await assert.rejects(fs.access(path.join(workspacePath, 'legacy')));
});

test('a linked legacy file is archived unmerged instead of blocking migration', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const target = path.join(workspacePath, 'IDENTITY.md');
  await fs.writeFile(target, 'kept elsewhere');
  const service = new PersonalityWorkspaceService({ userDataPath });
  const realRead = service._readBoundedFile.bind(service);
  // Windows test hosts cannot create symlinks unprivileged; the unsafe-path
  // refusal is what a linked file produces.
  service._readBoundedFile = async (file, ...args) => {
    if (file === target) throw Object.assign(new Error('linked'), { code: 'CONTEXT_FILE_PATH_UNSAFE' });
    return realRead(file, ...args);
  };
  await service.ensureSeeded();
  await assert.rejects(fs.access(target));
  const archived = await fs.readdir(path.join(workspacePath, 'legacy'));
  assert.ok(archived.some((name) => name.startsWith('IDENTITY')), archived.join(','));
});

test('an unreadable existence check never seeds over a personality file', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  await new PersonalityWorkspaceService({ userDataPath }).ensureSeeded();
  const target = path.join(workspacePath, 'PERSONALITY.md');
  await fs.writeFile(target, 'precious bytes\n');
  const realAccess = fs.access;
  t.mock.method(fs, 'access', async (file, ...args) => {
    if (file === target) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realAccess(file, ...args);
  });
  await assert.rejects(new PersonalityWorkspaceService({ userDataPath }).ensureSeeded(), { code: 'EACCES' });
  assert.equal(await fs.readFile(target, 'utf8'), 'precious bytes\n');
});

test('migration rollback restores archives across devices and cleans snapshot backups', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace(t);
  const target = path.join(workspacePath, 'IDENTITY.md');
  await fs.writeFile(target, 'user legacy voice\n');
  await fs.writeFile(path.join(workspacePath, '.personality-state.json'), '{"version":2}\n');
  const service = new PersonalityWorkspaceService({ userDataPath });
  const realRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from.includes(`${path.sep}legacy${path.sep}`) || to.includes(`${path.sep}legacy${path.sep}`)) {
      throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
    }
    return realRename(from, to);
  });
  service._writePersonalityState = async () => { throw new Error('disk full'); };
  await assert.rejects(service.ensureSeeded(), /disk full/);
  assert.equal(await fs.readFile(target, 'utf8'), 'user legacy voice\n');
  assert.equal(await fs.readFile(path.join(workspacePath, '.personality-state.json'), 'utf8'), '{"version":2}\n');
  assert.equal((await fs.readdir(workspacePath)).some((name) => name.includes('.rollback-')), false);
  await assert.rejects(fs.access(path.join(workspacePath, 'legacy')));
});
