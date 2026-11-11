'use strict';

// Row 107: "Add GGUF model…" ▸ Move and add. Real temp folders; a cross-volume
// copy is forced by a linkSync that answers EXDEV, as Windows does across
// drives.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  companionFiles,
  createArchSupport,
  createGgufImportService,
  safeFolderName,
} = require('../services/llama-server-gguf-import');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-gguf-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(dir, name, bytes = 16) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 7));
  return filePath;
}

function fsWith(overrides) {
  return Object.assign(Object.create(fs), overrides);
}

const exdev = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };

function service(root, options = {}) {
  return createGgufImportService({
    userDataPath: path.join(root, 'userData'),
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => options.roots || [],
    readArchitecture: () => options.architecture || '',
    resolveBundledRuntime: () => options.runtime || '',
    fsImpl: options.fsImpl || fs,
    platform: process.platform,
  });
}

test('only a file main picked can be planned, and never a network path', (t) => {
  const root = tempRoot(t);
  const file = write(path.join(root, 'Downloads'), 'Model-Q4_K_M.gguf');
  const imports = service(root);
  assert.deepEqual(imports.plan(file), { ok: false, reason: 'not_picked' });
  if (process.platform === 'win32') {
    assert.deepEqual(imports.plan('\\\\server\\share\\m.gguf'), { ok: false, reason: 'network_path' });
  }
  imports.recordModelPick(file);
  assert.equal(imports.plan(file).ok, true);
});

test('a file already inside a GGUF folder or Jenny\'s models folder is inside', (t) => {
  const root = tempRoot(t);
  const library = path.join(root, 'gguf');
  const inLibrary = write(path.join(library, 'Model'), 'Model-Q4_K_M.gguf');
  const inHome = write(path.join(root, 'userData', 'models', 'Other'), 'Other.gguf');
  const imports = service(root, { roots: [library] });
  for (const file of [inLibrary, inHome]) {
    imports.recordModelPick(file);
    const planned = imports.plan(file);
    assert.equal(planned.inside, true, file);
    assert.equal(planned.companions, undefined);
  }
});

test('a picked Downloads model plans its companions, size and its own folder in the first GGUF folder', (t) => {
  const root = tempRoot(t);
  const downloads = path.join(root, 'Downloads');
  const library = path.join(root, 'gguf');
  fs.mkdirSync(library);
  const file = write(downloads, 'LFM3-Omni-2B-F16.gguf', 100);
  write(downloads, 'mmproj-LFM3-Omni-2B-F16.gguf', 10);
  write(downloads, 'mtp-LFM3-Omni-2B-Q8_0.gguf', 5);
  write(downloads, 'Unrelated-7B-Q4_K_M.gguf', 50);
  const imports = service(root, { roots: [library] });
  imports.recordModelPick(file);
  const planned = imports.plan(file);
  assert.equal(planned.inside, false);
  assert.equal(planned.sourceDirName, 'Downloads');
  assert.deepEqual(planned.companions, ['mmproj-LFM3-Omni-2B-F16.gguf', 'mtp-LFM3-Omni-2B-Q8_0.gguf']);
  assert.equal(planned.sizeBytes, 115);
  assert.equal(planned.destRoot, library);
  assert.equal(planned.destDir, path.join(library, 'LFM3-Omni-2B'));
});

test('a same-volume move links every file into place and removes the originals', async (t) => {
  const root = tempRoot(t);
  const downloads = path.join(root, 'Downloads');
  const library = path.join(root, 'gguf');
  fs.mkdirSync(library);
  const file = write(downloads, 'LFM3-Omni-2B-F16.gguf');
  write(downloads, 'mmproj-LFM3-Omni-2B-F16.gguf');
  write(downloads, 'Unrelated-7B-Q4_K_M.gguf');
  const imports = service(root, { roots: [library] });
  imports.recordModelPick(file);
  const result = await imports.start({ path: file });
  const destDir = path.join(fs.realpathSync(library), 'LFM3-Omni-2B');
  assert.deepEqual(result, {
    ok: true,
    modelPath: path.join(destDir, 'LFM3-Omni-2B-F16.gguf'),
    dir: destDir,
    moved: ['LFM3-Omni-2B-F16.gguf', 'mmproj-LFM3-Omni-2B-F16.gguf'],
  });
  assert.deepEqual(fs.readdirSync(destDir).sort(), ['LFM3-Omni-2B-F16.gguf', 'mmproj-LFM3-Omni-2B-F16.gguf']);
  assert.deepEqual(fs.readdirSync(downloads), ['Unrelated-7B-Q4_K_M.gguf']);
  assert.deepEqual(imports.status(), { ok: true, active: false });
});

test('a cross-volume move copies, checks, places, then deletes the sources and leaves no .partial', async (t) => {
  const root = tempRoot(t);
  const downloads = path.join(root, 'Downloads');
  const file = write(downloads, 'Model-Q4_K_M-00001-of-00002.gguf', 4096);
  write(downloads, 'Model-Q4_K_M-00002-of-00002.gguf', 2048);
  let placeCalls = 0;
  // EXDEV for the source files, real links for the .partial copies.
  const fsImpl = fsWith({
    linkSync(from, to) {
      placeCalls += 1;
      if (!from.includes('.jenny-partial')) exdev();
      return fs.linkSync(from, to);
    },
  });
  const imports = service(root, { fsImpl });
  imports.recordModelPick(file);
  const result = await imports.start({ path: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  const destDir = path.join(root, 'userData', 'models', 'Model');
  assert.equal(fs.realpathSync(result.dir), fs.realpathSync(destDir));
  assert.deepEqual(fs.readdirSync(destDir).sort(), [
    'Model-Q4_K_M-00001-of-00002.gguf', 'Model-Q4_K_M-00002-of-00002.gguf',
  ]);
  assert.equal(fs.statSync(path.join(destDir, 'Model-Q4_K_M-00001-of-00002.gguf')).size, 4096);
  assert.deepEqual(fs.readdirSync(downloads), []);
  assert.ok(placeCalls >= 3);
});

test('Cancel during a copy keeps the sources and removes the partial copies and the new folder', async (t) => {
  const root = tempRoot(t);
  const downloads = path.join(root, 'Downloads');
  const file = write(downloads, 'Big-Q8_0.gguf', 4 * 1024 * 1024);
  const imports = service(root, { fsImpl: fsWith({ linkSync: exdev }) });
  imports.recordModelPick(file);
  const running = imports.start({ path: file });
  assert.equal(imports.status().active, true);
  assert.deepEqual(imports.cancel(), { ok: true, cancelled: true });
  assert.deepEqual(await running, { ok: false, reason: 'cancelled' });
  assert.equal(fs.statSync(file).size, 4 * 1024 * 1024);
  assert.equal(fs.existsSync(path.join(root, 'userData', 'models', 'Big')), false);
});

test('Cancel mid-copy waits for the partial file to close, then removes it', async (t) => {
  const root = tempRoot(t);
  const file = write(path.join(root, 'Downloads'), 'Slow-Q8_0.gguf', 64);
  const { Readable } = require('stream');
  let pushed = 0;
  const fsImpl = fsWith({
    linkSync: (from, to) => (from.includes('.jenny-partial') ? fs.linkSync(from, to) : exdev()),
    // One chunk, then silence: the copy is mid-file when Cancel lands.
    createReadStream: () => new Readable({
      read() {
        if (pushed === 0) { pushed += 1; this.push(Buffer.alloc(32, 1)); }
      },
    }),
  });
  const imports = service(root, { fsImpl });
  imports.recordModelPick(file);
  const running = imports.start({ path: file });
  for (let tries = 0; tries < 50 && imports.status().doneBytes !== 32; tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(imports.status().doneBytes, 32);
  imports.cancel();
  assert.deepEqual(await running, { ok: false, reason: 'cancelled' });
  assert.equal(fs.existsSync(path.join(root, 'userData', 'models', 'Slow')), false, 'partial and folder are gone');
  assert.equal(fs.statSync(file).size, 64);
});

test('a source another program holds open stays, and no second copy is left behind', async (t) => {
  const root = tempRoot(t);
  const downloads = path.join(root, 'Downloads');
  const file = write(downloads, 'Model-Q4_K_M.gguf');
  // Windows refuses to rename a file held open without delete sharing.
  const fsImpl = fsWith({
    renameSync(from, to) {
      if (path.resolve(String(from)) === path.resolve(file)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    },
  });
  const imports = service(root, { fsImpl });
  imports.recordModelPick(file);
  assert.deepEqual(await imports.start({ path: file }), { ok: false, reason: 'in_use' });
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(path.join(root, 'userData', 'models', 'Model')), false);
});

test('a leftover .jenny-partial from an interrupted copy is replaced, not reported as a clash', async (t) => {
  const root = tempRoot(t);
  const file = write(path.join(root, 'Downloads'), 'Model-Q4_K_M.gguf', 32);
  write(path.join(root, 'userData', 'models', 'Model'), 'Model-Q4_K_M.gguf.jenny-partial', 5);
  const imports = service(root, { fsImpl: fsWith({ linkSync: (from, to) => (from.includes('.jenny-partial') ? fs.linkSync(from, to) : exdev()) }) });
  imports.recordModelPick(file);
  const result = await imports.start({ path: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fs.readdirSync(path.join(root, 'userData', 'models', 'Model')), ['Model-Q4_K_M.gguf']);
});

test('an existing file of the same name is never replaced', async (t) => {
  const root = tempRoot(t);
  const file = write(path.join(root, 'Downloads'), 'Model-Q4_K_M.gguf', 8);
  write(path.join(root, 'userData', 'models', 'Model'), 'Model-Q4_K_M.gguf', 99);
  const imports = service(root);
  imports.recordModelPick(file);
  // The copy in Jenny's folder makes the pick "inside" only if it IS the pick.
  assert.deepEqual(await imports.start({ path: file }), { ok: false, reason: 'exists' });
  assert.equal(fs.statSync(file).size, 8);
  assert.equal(fs.statSync(path.join(root, 'userData', 'models', 'Model', 'Model-Q4_K_M.gguf')).size, 99);
});

test('not enough space on another volume moves nothing', async (t) => {
  const root = tempRoot(t);
  const downloads = path.join(root, 'Downloads');
  const file = write(downloads, 'Model-Q4_K_M.gguf', 1024);
  const library = path.join(root, 'gguf');
  fs.mkdirSync(library);
  const fsImpl = fsWith({
    statSync(target, ...rest) {
      const stat = fs.statSync(target, ...rest);
      return path.resolve(String(target)).startsWith(path.resolve(library)) ? Object.assign(Object.create(stat), { dev: -1 }) : stat;
    },
    statfsSync: () => ({ bavail: 1, bsize: 1024 }),
  });
  const imports = service(root, { roots: [library], fsImpl });
  imports.recordModelPick(file);
  const planned = imports.plan(file);
  assert.equal(planned.crossVolume, true);
  assert.equal(planned.freeBytes, 1024);
  assert.deepEqual(await imports.start({ path: file }), { ok: false, reason: 'no_space', freeBytes: 1024, sizeBytes: 1024 });
  assert.equal(fs.existsSync(file), true);
});

test('only GGUF folders, Jenny\'s folder or a folder main picked can receive a model', async (t) => {
  const root = tempRoot(t);
  const file = write(path.join(root, 'Downloads'), 'Model-Q4_K_M.gguf');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const imports = service(root);
  imports.recordModelPick(file);
  assert.deepEqual(await imports.start({ path: file, destRoot: elsewhere }), { ok: false, reason: 'destination_not_allowed' });
  imports.recordFolderPick(elsewhere);
  const result = await imports.start({ path: file, destRoot: elsewhere });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(elsewhere, 'Model', 'Model-Q4_K_M.gguf')), true);
});

test('a link to a model is never moved', (t) => {
  const root = tempRoot(t);
  const target = write(path.join(root, 'real'), 'Model-Q4_K_M.gguf');
  const link = path.join(root, 'Downloads', 'Model-Q4_K_M.gguf');
  fs.mkdirSync(path.dirname(link));
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (_error) {
    t.skip('symlinks need Developer Mode on Windows');
    return;
  }
  const imports = service(root);
  imports.recordModelPick(link);
  assert.deepEqual(imports.plan(link), { ok: false, reason: 'not_a_file' });
});

test('companions: a generic projector beside several models stays, beside one model it moves', () => {
  assert.deepEqual(companionFiles('D:\\dl', 'A-7B-Q4_K_M.gguf', ['A-7B-Q4_K_M.gguf', 'B-3B-F16.gguf', 'mmproj-F16.gguf']), []);
  assert.deepEqual(companionFiles('D:\\dl', 'A-7B-Q4_K_M.gguf', ['A-7B-Q4_K_M.gguf', 'mmproj-F16.gguf']), ['mmproj-F16.gguf']);
  assert.deepEqual(
    companionFiles('D:\\dl', 'A-7B-Q4_K_M.gguf', ['A-7B-Q4_K_M.gguf', 'B-3B-F16.gguf', 'mtp-B-3B-Q8_0.gguf']),
    []
  );
});

test('companions: a sibling left behind keeps what it pairs with, and a lone-model drafter needs a lone model', () => {
  // Alpha's own projector moves; Beta's drafter stays with Beta.
  assert.deepEqual(
    companionFiles('D:\\dl', 'Alpha-7B-Q4_K_M.gguf', ['Alpha-7B-Q4_K_M.gguf', 'Beta-3B-Q4_K_M.gguf', 'mmproj-Alpha-7B-F16.gguf', 'mtp-Beta-3B-Q8_0.gguf']),
    ['mmproj-Alpha-7B-F16.gguf']
  );
  // Two quants of one model: moving Q4 leaves the shared projector and drafter for Q8.
  assert.deepEqual(
    companionFiles('D:\\dl', 'Gemma-4B-Q4_K_M.gguf', ['Gemma-4B-Q4_K_M.gguf', 'Gemma-4B-Q8_0.gguf', 'mmproj-F16.gguf', 'mtp-Gemma-4B.gguf']),
    []
  );
});

test('a picked projector or drafter is never planned', (t) => {
  const root = tempRoot(t);
  const file = write(path.join(root, 'Downloads'), 'mmproj-Alpha-7B-F16.gguf');
  const imports = service(root);
  imports.recordModelPick(file);
  assert.deepEqual(imports.plan(file), { ok: false, reason: 'not_main_model' });
});

test('a moved pick is consumed', async (t) => {
  const root = tempRoot(t);
  const file = write(path.join(root, 'Downloads'), 'Model-Q4_K_M.gguf');
  const imports = service(root);
  imports.recordModelPick(file);
  assert.equal((await imports.start({ path: file })).ok, true);
  write(path.join(root, 'Downloads'), 'Model-Q4_K_M.gguf');
  assert.deepEqual(imports.plan(file), { ok: false, reason: 'not_picked' });
});

test('folder names keep the family as written and stay one safe path segment', () => {
  assert.equal(safeFolderName('LFM3-Omni-2B-F16.gguf'), 'LFM3-Omni-2B');
  assert.equal(safeFolderName('Qwen3.8-27B-UD-Q6_K-00001-of-00003.gguf'), 'Qwen3.8-27B');
  assert.equal(safeFolderName('...gguf'), 'model');
  assert.equal(safeFolderName('a<b.gguf'), 'a_b');
});

test('architecture support reads the NUL-delimited name from the build\'s llama library', (t) => {
  const root = tempRoot(t);
  const library = process.platform === 'win32' ? 'llama.dll' : (process.platform === 'darwin' ? 'libllama.dylib' : 'libllama.so');
  fs.writeFileSync(path.join(root, library), Buffer.from('\0llama\0lfm2\0lfm2moe\0', 'latin1'));
  const binary = path.join(root, 'llama-server.exe');
  const archSupport = createArchSupport({ fsImpl: fs, platform: process.platform });
  assert.equal(archSupport(binary, 'lfm2'), 'yes');
  assert.equal(archSupport(binary, 'lfm3'), process.platform === 'win32' ? 'no' : 'unknown');
  assert.equal(archSupport(binary, ''), 'unknown');
  assert.equal(archSupport(path.join(root, 'missing', 'llama-server.exe'), 'lfm2'), 'unknown');
});

test('the plan carries the bundled build\'s verdict for the file\'s architecture', (t) => {
  const root = tempRoot(t);
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(runtimeDir, process.platform === 'win32' ? 'llama.dll' : 'libllama.so'), Buffer.from('\0lfm2\0', 'latin1'));
  const file = write(path.join(root, 'Downloads'), 'LFM3-Omni-2B-F16.gguf');
  const imports = service(root, { architecture: 'lfm3', runtime: path.join(runtimeDir, 'llama-server.exe') });
  imports.recordModelPick(file);
  const planned = imports.plan(file);
  assert.equal(planned.architecture, 'lfm3');
  if (process.platform === 'win32') assert.equal(planned.archSupport, 'no');
});
