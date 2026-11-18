'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createDocumentPageRenderer, MAX_DOCX_BYTES } = require('../services/document-page-render');

const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest of a zip')]).toString('base64');
const PDF = Buffer.from('%PDF-1.7\nfake pdf body');

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-docx-pages-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake spawn: `behaviours[command]` decides what each process does.
function fakeSpawn(behaviours, calls) {
  let nextPid = 4000;
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid += 1;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    calls.push({ command, args, env: options?.env || {}, pid: child.pid });
    const behaviour = behaviours[path.basename(command).toLowerCase()] || (() => ({ code: 1 }));
    setImmediate(() => {
      const outcome = behaviour({ command, args, env: options?.env || {}, child }) || {};
      if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout));
      if (outcome.hang) return;
      child.emit('close', outcome.code ?? 0);
    });
    return child;
  };
}

const regFound = () => ({ code: 0 });
const wordWrites = ({ env }) => { fs.writeFileSync(env.JENNY_DOCX_OUT, PDF); return { code: 0, stdout: 'JENNY_WORD_PID=777\n' }; };
const sofficeWrites = ({ args }) => {
  const outDir = args[args.indexOf('--outdir') + 1];
  const input = args[args.length - 1];
  fs.writeFileSync(path.join(outDir, `${path.basename(input, '.docx')}.pdf`), PDF);
  return { code: 0 };
};

function windowsRenderer(t, behaviours, extra = {}) {
  const calls = [];
  const killed = [];
  const root = tempRoot(t);
  const programFiles = path.join(root, 'pf');
  fs.mkdirSync(path.join(programFiles, 'LibreOffice', 'program'), { recursive: true });
  if (extra.libreOffice !== false) fs.writeFileSync(path.join(programFiles, 'LibreOffice', 'program', 'soffice.exe'), '');
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const renderer = createDocumentPageRenderer({
    platform: 'win32',
    env: { ProgramFiles: programFiles },
    spawnImpl: fakeSpawn(behaviours, calls),
    tmpRoot: work,
    killPid: (pid) => killed.push(pid),
    ...extra.options,
  });
  return { renderer, calls, killed, work };
}

test('engines: Word from the registry, LibreOffice from its install path, in that order', async (t) => {
  const { renderer } = windowsRenderer(t, { 'reg.exe': regFound });
  assert.deepEqual(await renderer.getEngines(), { enabled: true, engines: ['word', 'libreoffice'] });
});

test('engines: none installed, and the kill switch reports disabled', async (t) => {
  const { renderer } = windowsRenderer(t, { 'reg.exe': () => ({ code: 1 }) }, { libreOffice: false });
  assert.deepEqual(await renderer.getEngines(), { enabled: true, engines: [] });
  assert.deepEqual(await renderer.render({ base64: DOCX }), { ok: false, reason: 'no_engine' });
  const off = windowsRenderer(t, { 'reg.exe': regFound }, { options: { isEnabled: () => false } });
  assert.deepEqual(await off.renderer.getEngines(), { enabled: false, engines: [] });
  assert.deepEqual(await off.renderer.render({ base64: DOCX }), { ok: false, reason: 'disabled' });
});

test('render: Word converts, paths travel in the environment, and the temp directory is removed', async (t) => {
  const { renderer, calls, work } = windowsRenderer(t, { 'reg.exe': regFound, 'powershell.exe': wordWrites });
  const result = await renderer.render({ base64: DOCX });
  assert.equal(result.ok, true);
  assert.equal(result.engine, 'word');
  assert.equal(Buffer.from(result.base64, 'base64').toString(), PDF.toString());
  const word = calls.find((call) => call.command.endsWith('powershell.exe'));
  assert.ok(word.args.includes('-EncodedCommand'));
  assert.ok(!word.args.some((arg) => arg.includes(work)), 'no path is interpolated into the command line');
  assert.match(word.env.JENNY_DOCX_IN, /document\.docx$/);
  assert.deepEqual(fs.readdirSync(work), []);
});

test('render: a failed Word falls back to LibreOffice with a throwaway profile', async (t) => {
  const { renderer, calls, work } = windowsRenderer(t, { 'reg.exe': regFound, 'powershell.exe': () => ({ code: 1 }), 'soffice.exe': sofficeWrites });
  const result = await renderer.render({ base64: DOCX });
  assert.equal(result.engine, 'libreoffice');
  const soffice = calls.find((call) => call.command.endsWith('soffice.exe'));
  assert.ok(soffice.args.includes('--headless'));
  assert.ok(soffice.args.some((arg) => arg.startsWith('-env:UserInstallation=file:')));
  assert.deepEqual(fs.readdirSync(work), []);
});

test('render: a timeout stops the converter and the Word it started by PID, never by name', async (t) => {
  const { renderer, calls, killed } = windowsRenderer(t, {
    'reg.exe': regFound,
    'powershell.exe': () => ({ hang: true, stdout: 'JENNY_WORD_PID=9123\n' }),
  }, { libreOffice: false, options: { timeoutMs: 50 } });
  assert.deepEqual(await renderer.render({ base64: DOCX }), { ok: false, reason: 'timeout' });
  const word = calls.find((call) => call.command.endsWith('powershell.exe'));
  assert.deepEqual(killed, [word.pid, 9123]);
});

test('render: refuses bad input, oversize input, a non-PDF output, and a second conversion at once', async (t) => {
  const { renderer } = windowsRenderer(t, { 'reg.exe': regFound, 'powershell.exe': wordWrites }, { libreOffice: false });
  assert.deepEqual(await renderer.render({}), { ok: false, reason: 'invalid' });
  assert.deepEqual(await renderer.render({ base64: Buffer.from('%PDF-').toString('base64') }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await renderer.render({ base64: 'not base64!' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await renderer.render({ base64: 'A'.repeat(Math.ceil(MAX_DOCX_BYTES / 3) * 4 + 8) }), { ok: false, reason: 'too_large' });
  const first = renderer.render({ base64: DOCX });
  assert.deepEqual(await renderer.render({ base64: DOCX }), { ok: false, reason: 'busy' });
  assert.equal((await first).ok, true);

  const junk = windowsRenderer(t, {
    'reg.exe': regFound,
    'powershell.exe': ({ env }) => { fs.writeFileSync(env.JENNY_DOCX_OUT, 'not a pdf'); return { code: 0 }; },
  }, { libreOffice: false });
  assert.deepEqual(await junk.renderer.render({ base64: DOCX }), { ok: false, reason: 'failed' });
});

test('render: system tools run by absolute path, never by bare name', async (t) => {
  const { renderer, calls } = windowsRenderer(t, { 'reg.exe': regFound, 'powershell.exe': wordWrites }, { options: { env: { SystemRoot: String.raw`C:\Win` } } });
  await renderer.render({ base64: DOCX });
  assert.deepEqual(calls.map((call) => call.command), [
    String.raw`C:\Win\System32\reg.exe`,
    String.raw`C:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`,
  ]);
});

test('render: a partial PDF from a failed Word never passes as LibreOffice output', async (t) => {
  const { renderer } = windowsRenderer(t, {
    'reg.exe': regFound,
    'powershell.exe': ({ env }) => { fs.writeFileSync(env.JENNY_DOCX_OUT, PDF); return { code: 3 }; },
    'soffice.exe': () => ({ code: 1 }),
  });
  assert.deepEqual(await renderer.render({ base64: DOCX }), { ok: false, reason: 'failed' });
});

test('render: a work directory a crash left behind is swept once it is an hour old', async (t) => {
  const { renderer, work } = windowsRenderer(t, { 'reg.exe': regFound, 'powershell.exe': wordWrites }, { libreOffice: false });
  const stale = path.join(work, 'jenny-docx-pages-old');
  const recent = path.join(work, 'jenny-docx-pages-new');
  const other = path.join(work, 'someone-else');
  for (const dir of [stale, recent, other]) fs.mkdirSync(dir);
  const hourAgo = (Date.now() - 2 * 60 * 60_000) / 1000;
  fs.utimesSync(stale, hourAgo, hourAgo);
  fs.utimesSync(other, hourAgo, hourAgo);
  assert.equal((await renderer.render({ base64: DOCX })).ok, true);
  assert.deepEqual(fs.readdirSync(work).sort(), ['jenny-docx-pages-new', 'someone-else']);
});
