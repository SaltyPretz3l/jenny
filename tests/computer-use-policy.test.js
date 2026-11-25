'use strict';
// new-test-file: services/computer-use/ is a new surface (row 196): its program rules and grant gate.

const test = require('node:test');
const assert = require('node:assert/strict');

const { allowsInput, normalizeProgramPath, programKind } = require('../services/computer-use/program-rules');
const { createGrantGate } = require('../services/computer-use/grant-gate');
const { buildExpect } = require('../services/computer-use/expect');

const WIN = 'C:\\Windows';
const kind = (file, options = {}) => programKind(file, { windowsDir: WIN, ...options });

test('paths compare without case, slash direction or the long-path prefix', () => {
  assert.equal(normalizeProgramPath('\\\\?\\C:\\Windows\\Notepad.EXE'), 'c:\\windows\\notepad.exe');
  assert.equal(normalizeProgramPath('C:/Games/Game.exe'), 'c:\\games\\game.exe');
  assert.equal(normalizeProgramPath('\\\\?\\UNC\\Server\\Share\\a.exe'), '\\\\server\\share\\a.exe');
  assert.equal(normalizeProgramPath(null), '');
});

test('everything under the Windows folder is never granted, but for a short allowlist', () => {
  for (const file of [
    'C:\\Windows\\explorer.exe',
    'C:\\Windows\\System32\\Taskmgr.exe',
    'C:\\Windows\\regedit.exe',
    'C:\\Windows\\System32\\mmc.exe',
    'C:\\Windows\\System32\\wscript.exe',
    'C:\\Windows\\SysWOW64\\cscript.exe',
    'C:\\Windows\\System32\\mshta.exe',
    'C:\\Windows\\System32\\rundll32.exe',
    'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe',
    'C:\\Windows\\System32\\consent.exe',
    '\\\\?\\c:\\windows\\system32\\WSL.EXE',
  ]) {
    assert.equal(kind(file), 'never', file);
  }
  assert.equal(kind('C:\\Windows\\System32\\notepad.exe'), 'grantable');
  assert.equal(kind('C:\\Windows\\System32\\mspaint.exe'), 'grantable');
});

test('the classic consoles and the browsers and terminals elsewhere are view only', () => {
  for (const file of [
    'C:\\Windows\\System32\\conhost.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.21_x64__8wekyb3d8bbwe\\WindowsTerminal.exe',
  ]) {
    assert.equal(kind(file), 'view_only', file);
  }
  assert.equal(allowsInput('view_only'), false);
});

test('Jenny, script hosts and password managers are never granted wherever they are', () => {
  for (const file of [
    'C:\\Program Files\\Jenny\\Jenny.exe',
    'D:\\Portable\\jenny.exe',
    'C:\\Python313\\python.exe',
    'C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\pythonw.exe',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\KeePassXC\\KeePassXC.exe',
    'C:\\Users\\me\\AppData\\Local\\1Password\\app\\8\\1Password.exe',
  ]) {
    assert.equal(kind(file), 'never', file);
  }
  const dev = 'D:\\Work\\jenny\\node_modules\\electron\\dist\\electron.exe';
  assert.equal(kind(dev), 'grantable');
  assert.equal(kind(dev, { jennyPrograms: [dev.toUpperCase()] }), 'never');
});

test('an ordinary program is grantable and allows input', () => {
  assert.equal(kind('D:\\Work\\demo-game\\target\\release\\client.exe'), 'grantable');
  assert.equal(kind('C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2_x64__8wekyb3d8bbwe\\CalculatorApp.exe'), 'grantable');
  assert.equal(kind('\\\\server\\share\\tools\\viewer.exe'), 'grantable');
  assert.equal(allowsInput('grantable'), true);
  assert.equal(allowsInput('never'), false);
});

test('a path that cannot be judged fails closed', () => {
  for (const file of ['', 'notepad.exe', 'C:\\Games\\game.bat', 'C:\\Games\\..\\Windows\\regedit.exe', 'relative\\x.exe', 'C:\\Games\\game']) {
    assert.equal(kind(file), 'never', JSON.stringify(file));
  }
});

test('the Windows folder defaults to SystemRoot', () => {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = 'D:\\Win';
  try {
    assert.equal(programKind('D:\\Win\\explorer.exe'), 'never');
    assert.equal(programKind('C:\\Windows\\explorer.exe'), 'grantable');
  } finally {
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  }
});

const GAME = 'D:/Work/demo-game/target/release/client.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function gate(options = {}) {
  return createGrantGate({ windowsDir: WIN, jennyPrograms: () => ['C:/Program Files/Jenny/Jenny.exe'], ...options });
}

function approver(answers) {
  const asked = [];
  const authorize = async (request) => {
    asked.push(request);
    return answers.length ? answers.shift() : false;
  };
  return { asked, authorize };
}

test('a grant asks a person once per chat with a one-off computer card', async () => {
  const g = gate();
  const { asked, authorize } = approver([true]);
  const call = g.forCall({ authorize, callId: 'c1', toolInput: { action: 'focus' } });
  const first = await call.ensureGranted(GAME, { name: 'demo-game', input: true });
  assert.equal(first.allowed, true);
  assert.equal(first.grant.kind, 'grantable');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool_name, 'computer');
  assert.equal(asked[0].one_off_only, true);
  assert.deepEqual(asked[0].messageFields.computer_approval, {
    schema_version: 1, kind: 'grant', program_name: 'demo-game', program_path: GAME, view_only: false,
  });
  const again = await call.ensureGranted(GAME.toUpperCase(), { input: true });
  assert.equal(again.allowed, true);
  assert.equal(asked.length, 1);
  assert.deepEqual(g.list(), [{ program: GAME, name: 'demo-game', kind: 'grantable' }]);
  assert.ok(g.check(GAME, { input: true }));
});

test('never-granted programs are refused without a card, view-only ones never allow input', async () => {
  const g = gate();
  const { asked, authorize } = approver([true, true]);
  const call = g.forCall({ authorize, callId: 'c1' });
  assert.equal((await call.ensureGranted('C:/Windows/regedit.exe')).reason, 'never');
  assert.equal((await call.ensureGranted('C:/Program Files/Jenny/Jenny.exe')).reason, 'never');
  assert.equal((await call.allowOpen('C:/Windows/System32/wscript.exe')).reason, 'never');
  assert.equal((await call.ensureGranted(CHROME, { input: true })).reason, 'view_only');
  assert.equal(asked.length, 0);
  const look = await call.ensureGranted(CHROME, { name: 'Chrome' });
  assert.equal(look.allowed, true);
  assert.equal(asked[0].messageFields.computer_approval.view_only, true);
  assert.equal(g.check(CHROME), look.grant);
  assert.equal(g.check(CHROME, { input: true }), null);
});

test('a declined or unanswerable ask grants nothing', async () => {
  const g = gate();
  const declined = await g.forCall({ authorize: approver([false]).authorize }).ensureGranted(GAME);
  assert.deepEqual([declined.allowed, declined.reason], [false, 'declined']);
  const thrown = await g.forCall({ authorize: async () => { throw new Error('gone'); } }).ensureGranted(GAME);
  assert.equal(thrown.reason, 'declined');
  const nobody = await g.forCall({}).ensureGranted(GAME);
  assert.deepEqual([nobody.allowed, nobody.reason], [false, 'unanswerable']);
  assert.deepEqual(g.list(), []);
});

test('every open asks, even for a granted program, and a yes grants it', async () => {
  const g = gate();
  const { asked, authorize } = approver([true, true, false]);
  const call = g.forCall({ authorize });
  assert.equal((await call.allowOpen(GAME, { name: 'demo-game' })).allowed, true);
  assert.equal(asked[0].messageFields.computer_approval.kind, 'open');
  assert.ok(g.check(GAME, { input: true }));
  assert.equal((await call.allowOpen(GAME)).allowed, true);
  assert.equal((await call.allowOpen(GAME)).reason, 'declined');
  assert.equal(asked.length, 3);
  assert.ok(g.check(GAME), 'a declined open does not take the grant back');
});

test('the first file dialog of a granted program asks once; revoke and clear forget', async () => {
  const g = gate();
  const { asked, authorize } = approver([true, true, true, true]);
  const call = g.forCall({ authorize });
  assert.equal((await call.allowFileDialog(GAME)).reason, 'never', 'not granted yet');
  await call.ensureGranted(GAME);
  assert.equal((await call.allowFileDialog(GAME)).allowed, true);
  assert.equal((await call.allowFileDialog(GAME)).allowed, true);
  assert.deepEqual(asked.map((a) => a.messageFields.computer_approval.kind), ['grant', 'file_dialog']);
  assert.equal(g.revoke(GAME), true);
  assert.equal(g.check(GAME), null);
  await call.ensureGranted(GAME);
  assert.equal((await call.allowFileDialog(GAME)).allowed, true);
  assert.equal(asked.length, 4, 'a revoked program asks for its dialog again');
  g.clear();
  assert.deepEqual(g.list(), []);
});

test('a grant is judged again on every read and on the answer', async () => {
  let jenny = [];
  const g = gate({ jennyPrograms: () => jenny });
  const call = g.forCall({ authorize: approver([true]).authorize });
  await call.ensureGranted(GAME);
  assert.ok(g.check(GAME));
  jenny = [GAME];
  assert.equal(g.check(GAME), null, 'a program that became Jenny loses its grant');
  jenny = [];
  const slow = gate({ jennyPrograms: () => jenny });
  const pending = slow.forCall({ authorize: async () => { jenny = [GAME]; return true; } }).ensureGranted(GAME);
  assert.equal((await pending).reason, 'never');
  assert.deepEqual(slow.list(), []);
});

test('names and paths on the card carry no control characters and stay short', async () => {
  const g = gate();
  const { asked, authorize } = approver([true]);
  await g.forCall({ authorize }).ensureGranted(`C:/Games/${'x'.repeat(600)}.exe`, { name: 'evil\u0007\nname' });
  const card = asked[0].messageFields.computer_approval;
  assert.equal(card.program_name, 'evil name');
  assert.ok(card.program_path.length <= 512 && card.program_path.startsWith('...'));
});

test('the guard names the granted program and always denies Jenny', () => {
  const grant = { program: GAME, kind: 'grantable' };
  const jenny = { pids: [40, 41, 41, -1, 1.5, 2 ** 33], programs: ['C:/Program Files/Jenny/Jenny.exe', 'c:/program files/jenny/jenny.exe', '', 7] };
  assert.deepEqual(buildExpect({ hwnd: 591824, grant, jenny }), {
    hwnd: 591824, program: GAME, deny_pids: [40, 41], deny_programs: ['C:/Program Files/Jenny/Jenny.exe'],
  });
  const many = buildExpect({ hwnd: 1, grant, jenny: { pids: Array.from({ length: 400 }, (_, i) => i + 1), programs: ['C:/J.exe'] } });
  assert.equal(many.deny_pids.length, 256);
});

test('the guard is never built for a view-only grant, a missing window or without Jenny to deny', () => {
  const jenny = { pids: [1], programs: ['C:/J.exe'] };
  assert.throws(() => buildExpect({ hwnd: 1, grant: { program: CHROME, kind: 'view_only' }, jenny }), TypeError);
  assert.throws(() => buildExpect({ hwnd: 0, grant: { program: GAME, kind: 'grantable' }, jenny }), TypeError);
  assert.throws(() => buildExpect({ hwnd: 1, grant: null, jenny }), TypeError);
  assert.throws(() => buildExpect({ hwnd: 1, grant: { program: GAME, kind: 'grantable' }, jenny: { pids: [1] } }), TypeError);
});
