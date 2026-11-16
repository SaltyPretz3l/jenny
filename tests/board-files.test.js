'use strict';

// new-test-file: a new surface (row 150 slice B7): file cards on a project board, resolved, opened and checked for
// missing files against the board's own project folder (services/boards/board-files.js), on a real folder tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBoardFiles, isModelPath } = require('../services/boards/board-files');
const { createBoardStore } = require('../services/boards/board-store');
const { createBoardService } = require('../services/boards/board-service');

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const refused = (reason) => ({ ok: false, reason });

// <tmp>/project            the board's project folder
//   src/app.js, docs/      a file and a folder
//   into-outside           a junction to <tmp>/outside
//   ~home.md               a name the board model does not take as a path
// <tmp>/outside/secret.txt a file outside the folder
async function setup(t, { roots } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-board-files-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'app.js'), '1\n');
  fs.writeFileSync(path.join(root, '~home.md'), '1\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  fs.symlinkSync(outside, path.join(root, 'into-outside'), 'junction');
  const userDataPath = path.join(base, 'profile');
  fs.mkdirSync(userDataPath);
  let seq = 100;
  const service = createBoardService({ store: createBoardStore({ userDataPath }), makeId: () => uid(++seq), projectExists: () => true });
  const folders = roots || { project_alpha: root, project_general: null };
  const captured = [];
  const files = createBoardFiles({
    getBoard: (boardId) => service.get({ boardId }),
    captureProject: (projectId) => {
      captured.push(projectId);
      if (!Object.prototype.hasOwnProperty.call(folders, projectId)) throw new Error('project not found');
      return { project_id: projectId, root_path: folders[projectId] };
    },
  });
  const board = async (projectId, ops = []) => {
    const made = (await service.create({ projectId, name: 'Files' })).board;
    if (ops.length) assert.equal((await service.apply({ boardId: made.id, batch: { batch_id: `seed-${made.id}`, board_id: made.id, ops } })).ok, true);
    return made;
  };
  return { base, root, outside, service, files, board, captured };
}
const fileCard = (n, filePath) => ({ op: 'card.add', card: { id: uid(n), kind: 'file', data: { path: filePath, title: '' }, x: n * 10, y: 0 } });
const noAbsolute = (answer, base) => assert.equal(JSON.stringify(answer).toLowerCase().includes(base.toLowerCase().replace(/\\/g, '\\\\')), false);

test('a file inside the folder resolves to a forward-slash relative path and its base name, typed or dropped', async (t) => {
  const env = await setup(t);
  const board = await env.board('project_alpha');
  assert.deepEqual(await env.files.resolveFile({ boardId: board.id, path: 'src/app.js' }), { ok: true, path: 'src/app.js', title: 'app.js' });
  const dropped = await env.files.resolveFile({ boardId: board.id, path: path.join(env.root, 'src', 'app.js') });
  assert.deepEqual(dropped, { ok: true, path: 'src/app.js', title: 'app.js' });
  noAbsolute(dropped, env.base);
  assert.deepEqual(env.captured, ['project_alpha', 'project_alpha'], 'the folder comes from the board\'s own project');
  assert.equal(isModelPath('src/app.js'), true);
});

test('outside, through a junction, no folder, missing, a directory and a path the model refuses each say why', async (t) => {
  const env = await setup(t);
  const board = await env.board('project_alpha');
  const resolve = (p) => env.files.resolveFile({ boardId: board.id, path: p });
  assert.deepEqual(await resolve(path.join(env.outside, 'secret.txt')), refused('outside'));
  assert.deepEqual(await resolve('../outside/secret.txt'), refused('outside'));
  assert.deepEqual(await resolve('into-outside/secret.txt'), refused('link'));
  assert.deepEqual(await resolve('src/gone.js'), refused('not_found'));
  assert.deepEqual(await resolve('docs'), refused('not_file'));
  assert.deepEqual(await resolve('~home.md'), refused('invalid'), 'checked again against the model\'s path rule');
  const general = await env.board('project_general');
  assert.deepEqual(await env.files.resolveFile({ boardId: general.id, path: 'src/app.js' }), refused('no_root'));
  const unknown = await env.board('project_unknown');
  assert.deepEqual(await env.files.resolveFile({ boardId: unknown.id, path: 'src/app.js' }), refused('no_root'));
  for (const bad of [null, {}, { boardId: board.id }, { boardId: board.id, path: '' }, { boardId: 'board_x', path: 'a' },
    { boardId: board.id, path: 'a', root: env.root }, { boardId: board.id, path: 'x'.repeat(1025) }]) {
    assert.deepEqual(await env.files.resolveFile(bad), refused('invalid'));
  }
  assert.deepEqual(await env.files.resolveFile({ boardId: `board_${uid(9)}`, path: 'src/app.js' }), refused('not_found'));
});

test('openFile reads the path from the stored card and ignores any path in the request', async (t) => {
  const env = await setup(t);
  const board = await env.board('project_alpha', [fileCard(1, 'src/app.js'), fileCard(2, 'src/gone.js'),
    { op: 'card.add', card: { id: uid(3), kind: 'note', data: { text: 'n' } } }]);
  const opened = await env.files.openFile({ boardId: board.id, cardId: uid(1), path: '../outside/secret.txt' });
  assert.deepEqual(opened, { ok: true, relativePath: 'src/app.js', projectId: 'project_alpha' });
  noAbsolute(opened, env.base);
  assert.deepEqual(await env.files.openFile({ boardId: board.id, cardId: uid(2) }), refused('not_found'));
  assert.deepEqual(await env.files.openFile({ boardId: board.id, cardId: uid(3) }), refused('invalid'), 'not a file card');
  assert.deepEqual(await env.files.openFile({ boardId: board.id, cardId: uid(99) }), refused('not_found'));
  assert.deepEqual(await env.files.openFile({ boardId: board.id, cardId: 'x' }), refused('invalid'));
  // The stored path is checked again on every open: a folder swapped for a junction since the card was made refuses.
  fs.rmSync(path.join(env.root, 'src'), { recursive: true });
  fs.symlinkSync(env.outside, path.join(env.root, 'src'), 'junction');
  assert.deepEqual(await env.files.openFile({ boardId: board.id, cardId: uid(1) }), refused('link'));
});

test('fileStatus names the file cards whose file is not there; a deleted or read-only board is refused', async (t) => {
  const env = await setup(t);
  const board = await env.board('project_alpha', [fileCard(1, 'src/app.js'), fileCard(2, 'src/gone.js'), fileCard(3, 'docs'), fileCard(4, 'into-outside/secret.txt')]);
  assert.deepEqual(await env.files.fileStatus({ boardId: board.id }), { ok: true, missing: [uid(2), uid(3), uid(4)] });
  fs.rmSync(path.join(env.root, 'src', 'app.js'));
  assert.deepEqual((await env.files.fileStatus({ boardId: board.id })).missing, [uid(1), uid(2), uid(3), uid(4)]);
  assert.deepEqual(await env.files.fileStatus({ boardId: 'nope' }), refused('invalid'));
  const general = await env.board('project_general', [fileCard(1, 'a.md')]);
  assert.deepEqual(await env.files.fileStatus({ boardId: general.id }), refused('no_root'));
  await env.service.delete({ boardId: board.id });
  assert.deepEqual(await env.files.fileStatus({ boardId: board.id }), refused('not_found'));

  const readOnly = createBoardFiles({ getBoard: async () => ({ ok: true, board: null, readOnly: true, reason: 'corrupt' }), captureProject: () => ({ root_path: env.root }) });
  assert.deepEqual(await readOnly.fileStatus({ boardId: board.id }), refused('read_only'));
  const broken = createBoardFiles({ getBoard: async () => { throw new Error('boom'); }, captureProject: () => ({ root_path: env.root }) });
  assert.deepEqual(await broken.openFile({ boardId: board.id, cardId: uid(1) }), refused('io'));
  const off = createBoardFiles({ getBoard: async () => ({ ok: false, reason: 'disabled' }) });
  assert.deepEqual(await off.resolveFile({ boardId: board.id, path: 'a' }), refused('disabled'));
});
