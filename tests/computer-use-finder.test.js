'use strict';
// new-test-file: the computer-use program finder (row 196 C1a)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createOwnerPrograms, MAX_OWNER_PROGRAMS } = require('../services/computer-use/owner-programs');
const { createStartApps, AUMID_PATTERN } = require('../services/computer-use/start-apps');
const { createProgramFinder } = require('../services/computer-use/program-finder');
const { writeJsonAtomicAsync } = require('../services/backend/session-storage-fs-utils');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-finder-'));
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let tmpCounter = 0;
function tmpFile() {
  tmpCounter += 1;
  return path.join(TMP, `case-${tmpCounter}`, 'computer-use-programs.json');
}

function makeOwner(filePath = tmpFile()) {
  return { filePath, store: createOwnerPrograms({ filePath, writeJsonAtomic: writeJsonAtomicAsync }) };
}

test('owner programs: add, update, list and remove', async () => {
  const { filePath, store } = makeOwner();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.add({ name: ' demo-game ', program: 'C:\\Games\\New\\client.exe' }), { ok: true });
  assert.deepEqual(await store.add({ name: 'Notes', program: 'D:\\Apps\\notes.exe' }), { ok: true });
  assert.deepEqual(await store.list(), [
    { name: 'demo-game', program: 'C:\\Games\\New\\client.exe' },
    { name: 'Notes', program: 'D:\\Apps\\notes.exe' },
  ]);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.programs.length, 2);

  // The same file under another spelling is updated, not duplicated.
  assert.deepEqual(await store.add({ name: 'Renamed', program: 'c:/games/new/CLIENT.EXE' }), { ok: true });
  const after = await store.list();
  assert.equal(after.length, 2);
  assert.equal(after[0].name, 'Renamed');

  assert.equal(await store.remove('C:\\GAMES\\NEW\\client.exe'), true);
  assert.equal(await store.remove('C:\\Games\\New\\client.exe'), false);
  assert.deepEqual(await store.list(), [{ name: 'Notes', program: 'D:\\Apps\\notes.exe' }]);
});

test('owner programs: refuses bad paths and names and writes nothing', async () => {
  const { filePath, store } = makeOwner();
  const bad = [
    { name: 'a', program: 'client.exe' },
    { name: 'a', program: '.\\client.exe' },
    { name: 'a', program: 'C:\\Games\\readme.txt' },
    { name: 'a', program: 'C:\\Games\\..\\Windows\\x.exe' },
    { name: 'a', program: 'C:\\Games\\x\u0001.exe' },
    { name: 'a', program: 'C:\\Games\\x\n.exe' },
    { name: 'a', program: '\\\\?\\C:\\Games\\x.exe' },
    { name: 'a', program: 'C:\\Games\\x?.exe' },
    { name: 'a', program: '' },
    { name: 'a', program: 42 },
    { name: '', program: 'C:\\Games\\x.exe' },
    { name: '   ', program: 'C:\\Games\\x.exe' },
    { name: '\u0001\u0002', program: 'C:\\Games\\x.exe' },
    { name: 'n'.repeat(121), program: 'C:\\Games\\x.exe' },
    { name: undefined, program: 'C:\\Games\\x.exe' },
  ];
  for (const entry of bad) {
    assert.deepEqual(await store.add(entry), { ok: false, reason: 'invalid' }, JSON.stringify(entry));
  }
  assert.deepEqual(await store.add(null), { ok: false, reason: 'invalid' });
  assert.equal(fs.existsSync(filePath), false);
  // Control characters in a name are removed, and 120 characters are fine.
  assert.deepEqual(await store.add({ name: `${'n'.repeat(119)}\u0007x`, program: 'C:\\Games\\x.exe' }), { ok: true });
  assert.equal((await store.list())[0].name.length, 120);
});

test('owner programs: the 100 entry cap', async () => {
  const { store } = makeOwner();
  assert.equal(MAX_OWNER_PROGRAMS, 100);
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(await store.add({ name: `p${i}`, program: `C:\\Apps\\p${i}.exe` }), { ok: true });
  }
  assert.deepEqual(await store.add({ name: 'one more', program: 'C:\\Apps\\more.exe' }), { ok: false, reason: 'too_many' });
  // Updating a listed program still works at the cap.
  assert.deepEqual(await store.add({ name: 'p5 renamed', program: 'C:\\Apps\\p5.exe' }), { ok: true });
  const list = await store.list();
  assert.equal(list.length, 100);
  assert.equal(list[5].name, 'p5 renamed');
});

test('owner programs: a malformed or unknown-schema file reads as empty and is never rewritten', async () => {
  const cases = [
    '{ not json',
    JSON.stringify({ schema_version: 2, programs: [{ name: 'a', program: 'C:\\a.exe' }] }),
    JSON.stringify({ programs: [{ name: 'a', program: 'C:\\a.exe' }] }),
    JSON.stringify({ schema_version: 1, programs: 'nope' }),
    JSON.stringify([1, 2, 3]),
    'null',
  ];
  for (const text of cases) {
    const filePath = tmpFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text, 'utf8');
    const store = createOwnerPrograms({ filePath, writeJsonAtomic: writeJsonAtomicAsync });
    assert.deepEqual(await store.list(), [], text);
    assert.deepEqual(await store.add({ name: 'x', program: 'C:\\x.exe' }), { ok: false, reason: 'unreadable' });
    assert.equal(await store.remove('C:\\a.exe'), false);
    assert.equal(fs.readFileSync(filePath, 'utf8'), text, 'the file is left as the owner had it');
  }
});

test('owner programs: list re-validates entries and skips bad ones', async () => {
  const filePath = tmpFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    schema_version: 1,
    programs: [
      { name: 'good', program: 'C:\\Apps\\good.exe' },
      { name: 'relative', program: 'good.exe' },
      { name: 'traversal', program: 'C:\\Apps\\..\\x.exe' },
      { name: '', program: 'C:\\Apps\\noname.exe' },
      { name: 'not an exe', program: 'C:\\Apps\\a.bat' },
      'string',
      null,
      { name: 'dup', program: 'c:\\apps\\GOOD.exe' },
      { name: 'ctrl\u0001name', program: 'D:\\Apps\\other.exe' },
    ],
  }), 'utf8');
  const store = createOwnerPrograms({ filePath, writeJsonAtomic: writeJsonAtomicAsync });
  assert.deepEqual(await store.list(), [
    { name: 'good', program: 'C:\\Apps\\good.exe' },
    { name: 'ctrlname', program: 'D:\\Apps\\other.exe' },
  ]);
});

test('owner programs: concurrent adds are serialized and none is lost', async () => {
  const { store } = makeOwner();
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.add({ name: `c${i}`, program: `C:\\Apps\\c${i}.exe` })));
  assert.equal((await store.list()).length, 10);
});

const CALC = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';

function psJson(items) { return JSON.stringify(items); }

test('start apps: parses an array, filters AUMIDs and resolves program files', async () => {
  const calls = [];
  const startApps = createStartApps({
    runPowerShell: async (script, options) => {
      calls.push({ script, options });
      return `\uFEFF${psJson([
        { n: 'Calculator', a: CALC, p: 'C:\\Program Files\\WindowsApps\\calc\\CalculatorApp.exe' },
        { n: 'Settings', a: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel', p: null },
        { n: 'Paint', a: 'C:\\Windows\\System32\\mspaint.exe', p: null },
        { n: 'A GUID app', a: '{6D809377-6AF0-444B-8957-A3773F02200E}\\App\\app.exe', p: null },
        { n: 'No id', a: '', p: null },
        { n: 'Relative program', a: 'Vendor.App_abc123!App', p: 'calc.exe' },
        { n: 'Not exe', a: 'Vendor.Other_abc123!App', p: 'C:\\x\\y.dll' },
        { n: '  Spaced\u0001 Name ', a: 'Vendor.Spaced_abc123!App', p: null },
        { n: 'Calculator again', a: CALC, p: null },
        { n: 7, a: 'Vendor.Num_abc123!App', p: null },
      ])}`;
    },
  });
  const apps = await startApps.list();
  assert.deepEqual(apps, [
    { name: 'Calculator', aumid: CALC, program: 'C:\\Program Files\\WindowsApps\\calc\\CalculatorApp.exe' },
    { name: 'Settings', aumid: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel', program: null },
    { name: 'Relative program', aumid: 'Vendor.App_abc123!App', program: null },
    { name: 'Not exe', aumid: 'Vendor.Other_abc123!App', program: null },
    { name: 'Spaced Name', aumid: 'Vendor.Spaced_abc123!App', program: null },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].script, 'string');
  assert.equal(calls[0].options.timeoutMs, 10000);
  assert.ok(AUMID_PATTERN.test(CALC));
  assert.ok(!AUMID_PATTERN.test('a!b!c'));
});

test('start apps: parses the single-object output of a one-app machine', async () => {
  const startApps = createStartApps({ runPowerShell: async () => psJson({ n: 'Calculator', a: CALC, p: null }) });
  assert.deepEqual(await startApps.list(), [{ name: 'Calculator', aumid: CALC, program: null }]);
});

test('start apps: the result is cached for the ttl and concurrent callers share one run', async () => {
  let clock = 1000;
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const startApps = createStartApps({
    now: () => clock,
    ttlMs: 60000,
    runPowerShell: async () => { runs += 1; await gate; return psJson([{ n: 'Calculator', a: CALC, p: null }]); },
  });
  const first = startApps.list();
  const second = startApps.list();
  assert.equal(runs, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
  clock += 59000;
  await startApps.list();
  assert.equal(runs, 1, 'still cached inside the ttl');
  clock += 2000;
  await startApps.list();
  assert.equal(runs, 2, 'listed again after the ttl');
});

test('start apps: a failed or unusable run resolves [] and is retried within 30 seconds', async () => {
  const outcomes = [
    () => { throw new Error('powershell missing'); },
    () => 'this is not json',
    () => 'x'.repeat(2 * 1024 * 1024 + 1),
    () => 'null',
    () => psJson([{ n: 'Calculator', a: CALC, p: null }]),
  ];
  let clock = 0;
  let runs = 0;
  const startApps = createStartApps({ now: () => clock, ttlMs: 300000, runPowerShell: async () => outcomes[runs++]() });
  assert.deepEqual(await startApps.list(), []);
  assert.deepEqual(await startApps.list(), [], 'cached failure');
  assert.equal(runs, 1);
  for (let expected = 2; expected <= 4; expected += 1) {
    clock += 31000;
    assert.deepEqual(await startApps.list(), []);
    assert.equal(runs, expected);
  }
  clock += 31000;
  assert.equal((await startApps.list()).length, 1);
  clock += 120000;
  await startApps.list();
  assert.equal(runs, 5, 'a good run is kept for the full ttl');
});

test('start apps: a run that never answers is cut off and clear() drops the cache', async () => {
  let runs = 0;
  const startApps = createStartApps({
    runPowerShell: () => { runs += 1; return new Promise(() => {}); },
    timeoutMs: 20,
  });
  assert.deepEqual(await startApps.list(), []);
  assert.equal(runs, 1);
  startApps.clear();
  assert.deepEqual(await startApps.list(), []);
  assert.equal(runs, 2);
});

const PD = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs';
const AD = 'C:\\Users\\owner\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';
const ENV = { ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\owner\\AppData\\Roaming', SystemRoot: 'C:\\Windows' };
const EXPLORER = 'C:\\Windows\\explorer.exe';

// An in-memory file system with the few calls the finder makes.
function fakeFs() {
  const key = (p) => p.toLowerCase().replace(/[\\/]+$/, '');
  const entries = new Map(); // folder key -> Map(lower name -> { name, kind })
  const kinds = new Map(); // path key -> 'file' | 'dir' | 'link'
  const stats = { readdir: 0 };
  function ensureDir(dir) {
    const k = key(dir);
    if (entries.has(k)) return;
    entries.set(k, new Map());
    if (!kinds.has(k)) kinds.set(k, 'dir');
    const parent = path.win32.dirname(dir);
    if (parent !== dir) { ensureDir(parent); link(parent, path.win32.basename(dir), kinds.get(k)); }
  }
  function link(parent, name, kind) { entries.get(key(parent)).set(name.toLowerCase(), { name, kind }); }
  const api = {
    stats,
    addFile(full) {
      const parent = path.win32.dirname(full);
      ensureDir(parent);
      kinds.set(key(full), 'file');
      link(parent, path.win32.basename(full), 'file');
    },
    addDir(full) { ensureDir(full); },
    addSymlinkDir(full) {
      kinds.set(key(full), 'link');
      ensureDir(full);
      const parent = path.win32.dirname(full);
      link(parent, path.win32.basename(full), 'link');
    },
    remove(full) {
      kinds.delete(key(full));
      entries.get(key(path.win32.dirname(full)))?.delete(path.win32.basename(full).toLowerCase());
    },
  };
  function missing(p) { const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; return e; }
  const statOf = (kind) => ({
    isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link',
  });
  api.promises = {
    async readdir(dir) {
      stats.readdir += 1;
      const list = entries.get(key(dir));
      if (!list) throw missing(dir);
      return [...list.values()].map(({ name, kind }) => ({ name, ...statOf(kind) }));
    },
    async lstat(p) { const kind = kinds.get(key(p)); if (!kind) throw missing(p); return statOf(kind); },
    async stat(p) { const kind = kinds.get(key(p)); if (!kind) throw missing(p); return statOf(kind === 'link' ? 'dir' : kind); },
  };
  return api;
}

function makeFinder(overrides = {}) {
  const memfs = overrides.fs || fakeFs();
  const links = overrides.links || new Map(); // lnk path (lower) -> target
  const calls = { readLink: [], openPath: [], spawn: [] };
  const state = { clock: 0 };
  const finder = createProgramFinder({
    ownerPrograms: overrides.ownerPrograms || { list: async () => [] },
    startApps: overrides.startApps || { list: async () => [] },
    readShortcutLink: overrides.readShortcutLink || ((lnk) => {
      calls.readLink.push(lnk);
      const target = links.get(lnk.toLowerCase());
      if (target === undefined) throw new Error('unreadable shortcut');
      return { target };
    }),
    fs: memfs,
    env: ENV,
    openPath: overrides.openPath || (async (p) => { calls.openPath.push(p); return ''; }),
    spawnDetached: overrides.spawnDetached || ((file, args) => { calls.spawn.push([file, args]); }),
    now: () => state.clock,
    ...(overrides.options || {}),
  });
  function shortcut(folder, name, target, { exists = true } = {}) {
    const lnk = path.win32.join(folder, `${name}.lnk`);
    memfs.addFile(lnk);
    links.set(lnk.toLowerCase(), target);
    if (exists && target.toLowerCase().endsWith('.exe')) memfs.addFile(target);
    return lnk;
  }
  return { finder, memfs, links, calls, state, shortcut };
}

test('finder: shortcut scan reads the Start menu and keeps only existing .exe targets', async () => {
  const h = makeFinder();
  h.shortcut(PD, 'Alpha Tool', 'C:\\Apps\\alpha.exe');
  h.shortcut(AD, 'Alpha Helper', 'C:\\Apps\\helper.EXE');
  h.shortcut(PD, 'Alpha Docs', 'C:\\Apps\\docs.pdf');
  h.shortcut(PD, 'Alpha Gone', 'C:\\Apps\\gone.exe', { exists: false });
  h.shortcut(PD, 'Alpha Relative', 'alpha.exe', { exists: false });
  h.shortcut(PD, 'Alpha Broken', 'C:\\Apps\\broken.exe');
  h.links.delete(path.win32.join(PD, 'Alpha Broken.lnk').toLowerCase()); // readShortcutLink throws
  h.memfs.addFile(path.win32.join(PD, 'readme.txt'));
  const found = await h.finder.find('alpha');
  assert.deepEqual(found.map((m) => [m.name, m.program, m.source]).sort(), [
    ['Alpha Helper', 'C:\\Apps\\helper.EXE', 'start_menu'],
    ['Alpha Tool', 'C:\\Apps\\alpha.exe', 'start_menu'],
  ]);
  assert.ok(found.every((m) => typeof m.id === 'string' && m.id.length > 0));
  assert.equal(new Set(found.map((m) => m.id)).size, found.length);
  assert.ok(!h.calls.readLink.some((p) => /readme/i.test(p)), 'only .lnk files are read');
});

test('finder: shortcut scan stops at 4 folders deep', async () => {
  const h = makeFinder();
  h.shortcut(PD, 'Deep0', 'C:\\Apps\\d0.exe');
  h.shortcut(`${PD}\\a\\b\\c\\d`, 'Deep4', 'C:\\Apps\\d4.exe');
  h.shortcut(`${PD}\\a\\b\\c\\d\\e`, 'Deep5', 'C:\\Apps\\d5.exe');
  const found = await h.finder.find('deep');
  assert.deepEqual(found.map((m) => m.name).sort(), ['Deep0', 'Deep4']);
});

test('finder: shortcut scan stops at 2,000 files over both folders and skips symlinked folders', async () => {
  const reads = [];
  const h = makeFinder({ readShortcutLink: (lnk) => { reads.push(lnk); return { target: 'C:\\Apps\\one.exe' }; } });
  for (let i = 0; i < 1500; i += 1) h.memfs.addFile(path.win32.join(PD, `p${i}.lnk`));
  for (let i = 0; i < 1500; i += 1) h.memfs.addFile(path.win32.join(AD, `a${i}.lnk`));
  h.memfs.addFile('C:\\Apps\\one.exe');
  await h.finder.find('p');
  assert.equal(reads.length, 2000);

  const linked = makeFinder();
  linked.memfs.addSymlinkDir(`${PD}\\Linked`);
  linked.shortcut(`${PD}\\Linked`, 'Behind Link', 'C:\\Apps\\behind.exe');
  linked.shortcut(`${PD}\\Real`, 'Behind Real', 'C:\\Apps\\real.exe');
  assert.deepEqual((await linked.finder.find('behind')).map((m) => m.name), ['Behind Real']);
});

test('finder: missing Start menu folders and a missing environment give an empty scan', async () => {
  assert.deepEqual(await makeFinder({ options: { env: {} } }).finder.find('anything'), []);
  assert.deepEqual(await makeFinder().finder.find('anything'), []);
});

test('finder: the shortcut scan is cached for its ttl and refresh() drops it', async () => {
  let cleared = 0;
  const h = makeFinder({ options: { shortcutTtlMs: 1000 }, startApps: { list: async () => [], clear: () => { cleared += 1; } } });
  h.shortcut(PD, 'Cached App', 'C:\\Apps\\cached.exe');
  await h.finder.find('cached');
  const scans = h.memfs.stats.readdir;
  await h.finder.find('cached');
  assert.equal(h.memfs.stats.readdir, scans, 'no second scan inside the ttl');
  h.state.clock += 1001;
  await h.finder.find('cached');
  assert.ok(h.memfs.stats.readdir > scans, 'scanned again after the ttl');
  const again = h.memfs.stats.readdir;
  h.finder.refresh();
  await h.finder.find('cached');
  assert.ok(h.memfs.stats.readdir > again, 'refresh forces a new scan');
  assert.equal(cleared, 1, 'refresh also clears the Start-apps cache');
});

test('finder: scoring puts exact before prefix before word matches', async () => {
  const h = makeFinder({
    ownerPrograms: { list: async () => [{ name: 'Scientific Calc', program: 'C:\\Owner\\sci.exe' }] },
    startApps: { list: async () => [
      { name: 'calc', aumid: 'Vendor.Calc_abc123!App', program: null },
      { name: 'Excalibur', aumid: 'Vendor.Excalibur_abc123!App', program: null },
    ] },
  });
  h.shortcut(PD, 'Calculator', 'C:\\Apps\\calculator.exe');
  const found = await h.finder.find('  CALC ');
  assert.deepEqual(found.map((m) => m.name), ['calc', 'Calculator', 'Scientific Calc']);
  assert.deepEqual(found.map((m) => m.source), ['store', 'start_menu', 'owner']);
});

test('finder: equal scores order by trust, then shorter name', async () => {
  const h = makeFinder({
    ownerPrograms: { list: async () => [{ name: 'Paint', program: 'C:\\Owner\\paint.exe' }] },
    startApps: { list: async () => [{ name: 'Paint', aumid: 'Vendor.Paint_abc123!App', program: null }] },
  });
  h.shortcut(PD, 'Paint', 'C:\\Apps\\paint2.exe');
  h.shortcut(PD, 'Paint Deluxe Edition', 'C:\\Apps\\deluxe.exe');
  h.shortcut(PD, 'Paint Pro', 'C:\\Apps\\pro.exe');
  const found = await h.finder.find('paint');
  assert.deepEqual(found.map((m) => [m.name, m.source]), [
    ['Paint', 'owner'],
    ['Paint', 'start_menu'],
    ['Paint', 'store'],
    ['Paint Pro', 'start_menu'],
    ['Paint Deluxe Edition', 'start_menu'],
  ]);
});

test('finder: a multi-word query matches at a word start', async () => {
  const h = makeFinder();
  h.shortcut(PD, 'Visual Studio Code', 'C:\\Apps\\code.exe');
  h.shortcut(PD, 'Microsoft Visual Studio', 'C:\\Apps\\vs.exe');
  h.shortcut(PD, 'Visualstudiox', 'C:\\Apps\\x.exe');
  const found = await h.finder.find('visual studio');
  assert.deepEqual(found.map((m) => m.name), ['Visual Studio Code', 'Microsoft Visual Studio']);
});

test('finder: programs sharing one file collapse to the most trusted source', async () => {
  const h = makeFinder({
    ownerPrograms: { list: async () => [{ name: 'My Notes', program: 'C:\\Apps\\Notes.exe' }] },
    startApps: { list: async () => [{ name: 'Notes', aumid: 'Vendor.Notes_abc123!App', program: 'c:\\apps\\notes.exe' }] },
  });
  h.shortcut(PD, 'Notes', 'c:\\APPS\\notes.exe');
  const found = await h.finder.find('notes');
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].name, found[0].source], ['My Notes', 'owner']);
});

test('finder: at most 5 matches, the more trusted sources filling them first', async () => {
  const h = makeFinder({
    startApps: { list: async () => Array.from({ length: 4 }, (_, i) => (
      { name: `Tool store ${i}`, aumid: `Vendor.Tool${i}_abc123!App`, program: null })) },
  });
  for (let i = 0; i < 6; i += 1) h.shortcut(PD, `Tool ${i}`, `C:\\Apps\\tool${i}.exe`);
  const found = await h.finder.find('tool');
  assert.equal(found.length, 5);
  assert.equal(found.filter((m) => m.source === 'start_menu').length, 5, 'more trusted sources fill the five first');
});

test('finder: a bad query returns []', async () => {
  const h = makeFinder({ ownerPrograms: { list: async () => [{ name: 'x', program: 'C:\\x.exe' }] } });
  for (const query of ['', '   ', '\u0001\u0002', 'q'.repeat(121), undefined, null, 42, {}]) {
    assert.deepEqual(await h.finder.find(query), [], String(query));
  }
  assert.equal((await h.finder.find('x')).length, 1);
});

test('finder: Store apps with a bad AUMID are dropped, and a failing source degrades to the others', async () => {
  const h = makeFinder({
    ownerPrograms: { list: async () => { throw new Error('disk'); } },
    startApps: { list: async () => [
      { name: 'Good', aumid: 'Vendor.Good_abc123!App', program: null },
      { name: 'Good path', aumid: 'C:\\Windows\\good.exe', program: null },
      { name: 'Good shell', aumid: 'Vendor.Good_abc123!App" & calc', program: null },
    ] },
  });
  const found = await h.finder.find('good');
  assert.deepEqual(found.map((m) => m.name), ['Good']);
});

test('finder: launch starts an owner program and a shortcut program with openPath', async () => {
  const h = makeFinder({ ownerPrograms: { list: async () => [{ name: 'demo-game', program: 'C:\\Games\\client.exe' }] } });
  h.memfs.addFile('C:\\Games\\client.exe');
  h.shortcut(PD, 'Alpha Tool', 'C:\\Apps\\alpha.exe');
  for (const query of ['demo-game', 'alpha']) assert.deepEqual(await h.finder.launch((await h.finder.find(query))[0]), { ok: true });
  assert.deepEqual(h.calls.openPath, ['C:\\Games\\client.exe', 'C:\\Apps\\alpha.exe']);
  assert.deepEqual(h.calls.spawn, []);
});

test('finder: launch starts a Store app through explorer.exe with one argument', async () => {
  const h = makeFinder({ startApps: { list: async () => [{ name: 'Calculator', aumid: CALC, program: null }] } });
  const [match] = await h.finder.find('calculator');
  assert.equal(match.source, 'store');
  assert.equal(match.program, null);
  assert.deepEqual(await h.finder.launch(match), { ok: true });
  assert.deepEqual(h.calls.spawn, [[EXPLORER, [`shell:AppsFolder\\${CALC}`]]]);
  assert.deepEqual(h.calls.openPath, []);
});

test('finder: launch refuses an id find did not return, whatever else the match says', async () => {
  const h = makeFinder();
  h.memfs.addFile('C:\\Evil\\evil.exe');
  assert.deepEqual(await h.finder.launch({ id: 'nope', name: 'x', program: 'C:\\Evil\\evil.exe', source: 'owner' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await h.finder.launch({ name: 'x', program: 'C:\\Evil\\evil.exe', source: 'owner' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await h.finder.launch(null), { ok: false, reason: 'invalid' });
  assert.deepEqual(await h.finder.launch('pf1'), { ok: false, reason: 'invalid' });
  assert.deepEqual(h.calls.openPath, []);
  assert.deepEqual(h.calls.spawn, []);

  // A real id with a tampered program still starts the program find returned.
  h.shortcut(PD, 'Real App', 'C:\\Apps\\real.exe');
  const [match] = await h.finder.find('real app');
  await h.finder.launch({ ...match, program: 'C:\\Evil\\evil.exe' });
  assert.deepEqual(h.calls.openPath, ['C:\\Apps\\real.exe']);
});

test('finder: launch of a program whose file has vanished is not_found', async () => {
  const h = makeFinder({ ownerPrograms: { list: async () => [{ name: 'demo-game', program: 'C:\\Games\\client.exe' }] } });
  h.memfs.addFile('C:\\Games\\client.exe');
  const [match] = await h.finder.find('demo-game');
  h.memfs.remove('C:\\Games\\client.exe');
  assert.deepEqual(await h.finder.launch(match), { ok: false, reason: 'not_found' });
  assert.deepEqual(h.calls.openPath, []);
});

test('finder: an openPath error or throw is failed, and a throwing spawn is failed', async () => {
  const owner = { list: async () => [{ name: 'demo-game', program: 'C:\\Games\\client.exe' }] };
  const h = makeFinder({ ownerPrograms: owner, openPath: async () => 'The system cannot find the file' });
  h.memfs.addFile('C:\\Games\\client.exe');
  const [match] = await h.finder.find('demo-game');
  assert.deepEqual(await h.finder.launch(match), { ok: false, reason: 'failed' });

  const h2 = makeFinder({ ownerPrograms: owner, openPath: async () => { throw new Error('boom'); } });
  h2.memfs.addFile('C:\\Games\\client.exe');
  const [match2] = await h2.finder.find('demo-game');
  assert.deepEqual(await h2.finder.launch(match2), { ok: false, reason: 'failed' });

  const h3 = makeFinder({
    startApps: { list: async () => [{ name: 'Calculator', aumid: CALC, program: null }] },
    spawnDetached: () => { throw new Error('spawn failed'); },
  });
  const [match3] = await h3.finder.find('calculator');
  assert.deepEqual(await h3.finder.launch(match3), { ok: false, reason: 'failed' });
});

test('finder: the returned-match map is bounded at 200', async () => {
  const h = makeFinder({ ownerPrograms: { list: async () => [{ name: 'game', program: 'C:\\Games\\client.exe' }] } });
  h.memfs.addFile('C:\\Games\\client.exe');
  const [first] = await h.finder.find('game');
  for (let i = 0; i < 200; i += 1) await h.finder.find('game');
  assert.deepEqual(await h.finder.launch(first), { ok: false, reason: 'invalid' });
  const [latest] = await h.finder.find('game');
  assert.deepEqual(await h.finder.launch(latest), { ok: true });
});

test('finder: programs the rules call never are still returned, for the grant gate to decide', async () => {
  const h = makeFinder();
  h.shortcut(PD, 'Python', 'C:\\Python\\python.exe');
  const found = await h.finder.find('python');
  assert.deepEqual(found.map((m) => m.program), ['C:\\Python\\python.exe']);
});

test('finder: no PowerShell script carries the query, a path or a name', async () => {
  const scripts = [];
  const startApps = createStartApps({
    runPowerShell: async (script) => { scripts.push(script); return psJson([{ n: 'Calculator', a: CALC, p: null }]); },
    ttlMs: 0,
  });
  const h = makeFinder({ startApps });
  const hostile = 'zzqueryzz"; Remove-Item C:\\ -Recurse #';
  await h.finder.find(hostile);
  await h.finder.find('zzqueryzz');
  h.finder.refresh();
  const [match] = await h.finder.find('calculator');
  await h.finder.launch(match);
  assert.ok(scripts.length >= 2);
  for (const script of scripts) {
    assert.ok(!script.includes('zzqueryzz'));
    assert.ok(!script.includes('Calculator'));
    assert.ok(!script.includes(CALC));
    assert.equal(script, scripts[0], 'the script is one fixed string');
  }
});
