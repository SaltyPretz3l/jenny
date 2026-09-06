'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PersonalityWorkspaceService } = require('../services/personality-workspace-service');

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
