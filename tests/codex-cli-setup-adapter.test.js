const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCodexDiagnosticSetup, resolveCodexCommandPath } = require('../services/backend/codex-cli-setup-adapter');

for (const launcher of ['codex.cmd', 'codex.bat', 'codex']) {
  test(`Windows ${launcher} alone is rejected before direct spawn`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-codex-launcher-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, launcher), 'echo shim');
    const env = { PATH: root, USERPROFILE: root, HOME: root };
    let spawned = false;
    const result = await checkCodexDiagnosticSetup({ env, platform: 'win32', spawn() {
      spawned = true;
      throw new Error('unusable launcher spawned');
    } });
    assert.equal(spawned, false);
    assert.equal(result.ok, false);
    assert.match(result.message, /executable/i);
  });
}

test('Windows extensionless shim does not beat an extension executable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-codex-exe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, '.vscode', 'extensions', 'openai.chatgpt-1', 'bin', 'windows-x86_64', 'codex.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'fixture');
  fs.writeFileSync(path.join(root, 'codex'), 'shim');
  assert.equal(resolveCodexCommandPath('codex', { PATH: root, USERPROFILE: root }, 'win32'), exe);
});


for (const separatePackage of [false, true]) {
  test(`Windows npm launcher resolves its native executable (platform package: ${separatePackage})`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-codex-native-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
    const nativeRoot = separatePackage ? path.join(packageRoot, 'node_modules', '@openai', `codex-win32-${process.arch}`) : packageRoot;
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const exe = path.join(nativeRoot, 'vendor', triple, 'bin', 'codex.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'fixture');
    fs.writeFileSync(path.join(nativeRoot, 'package.json'), '{}');
    const launcher = path.join(root, 'codex.cmd');
    fs.writeFileSync(launcher, 'shim');
    const env = { PATH: root, USERPROFILE: root };
    assert.equal(resolveCodexCommandPath('codex', env, 'win32'), exe);
    assert.equal(resolveCodexCommandPath(launcher, env, 'win32'), exe);
    const { EventEmitter } = require('node:events');
    const result = await checkCodexDiagnosticSetup({ platform: 'win32', env, spawn(command, args, options) {
      assert.equal(command, exe);
      assert.deepEqual(args, ['login', 'status']);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', 'Logged in using ChatGPT');
        child.emit('close', 0);
      });
      return child;
    } });
    assert.equal(result.ok, true);
    assert.equal(result.commandPath, exe);
  });
}
