'use strict';

// Team slice 3b-4b: the Windows root shapes the file-access library also refuses (a UNC path, a
// drive root, a `\\?\` or `\\.\` prefix) are refused in the host config first, for `workspace_root`
// and for the team block's `projects_root`. Everything else about the volume is the library's call.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadHostConfig, windowsRootRefusal } = require('../../server/config');

const WINDOWS = process.platform === 'win32';
const windowsOnly = WINDOWS ? false : 'Windows only: the root shapes are Windows paths';
const REASON = 'file_access_root_invalid';

test.beforeEach((t) => {
  t.mock.method(os, 'homedir', () => path.join(process.cwd(), 'tmp-host-windows-root-home'));
});

function withFixture(callback) {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-host-windows-root-'));
  const configPath = path.join(root, 'host.json');
  const base = {
    host_mode: 'server',
    host_execution_policy_version: 1,
    user_data_path: path.join(root, 'profile'),
    secrets_dir: path.join(root, 'secrets'),
    model_endpoint: { engine: 'ollama', model: 'qwen3.5:9b', api_url: 'http://ollama:11434' },
  };
  const hosted = (workspaceRoot) => ({
    ...base, schema_version: 1, canonical_origin: 'https://jenny.tailnet.ts.net',
    listen_host: '0.0.0.0', port: 8080, workspace_root: workspaceRoot,
  });
  const team = (projectsRoot) => ({
    ...base, schema_version: 3, listen_host: '127.0.0.1', port: 0, execution: null, workspace_root: null,
    team: { name: 'Core team', key_source: 'secret_file', direct_port: null, projects_root: projectsRoot },
  });
  const refusal = (document) => {
    fs.writeFileSync(configPath, JSON.stringify(document), { mode: 0o600 });
    try { loadHostConfig(configPath); } catch (error) {
      assert.equal(error.code, 'CMP-HOST-0001');
      return { reason: error.reason, detail: error.detail ?? null, message: error.message };
    }
    return null;
  };
  try { return callback({ root, hosted, team, refusal }); } finally {
    // Remove links first, by themselves (a junction here may point at a drive root).
    for (const name of fs.readdirSync(root)) {
      const entry = path.join(root, name);
      if (fs.lstatSync(entry).isSymbolicLink()) fs.rmdirSync(entry);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Every refused shape, as a plain function of the text: runs on every OS through the platform argument.
test('each Windows root shape is refused with its detail, and an ordinary folder passes', () => {
  const cases = [
    ['\\\\server\\share\\projects', 'unc_path'],
    ['//server/share/projects', 'unc_path'],
    ['\\\\localhost\\c$\\projects', 'unc_path'],
    ['\\\\?\\C:\\projects', 'device_prefix'],
    ['\\\\.\\C:\\projects', 'device_prefix'],
    ['//?/C:/projects', 'device_prefix'],
    ['\\\\?\\UNC\\server\\share', 'device_prefix'],
    ['C:\\', 'drive_root'],
    ['g:/', 'drive_root'],
    ['C:\\projects\\..', 'drive_root'],
  ];
  for (const [value, detail] of cases) {
    assert.equal(windowsRootRefusal(value, 'win32'), detail, value);
  }
  for (const value of ['C:\\projects', 'D:\\Work\\jenny', 'D:/work/a b', 'C:\\projects\\'] ) {
    assert.equal(windowsRootRefusal(value, 'win32'), null, value);
  }
});

// What the helper answers for the edge forms today; the rest is the absolute-path check's or the library's.
test('edge forms: drive-relative, mixed case, trailing dot or space, and the NT prefix', () => {
  const cases = [
    ['C:', null], // drive-relative: left to the absolute-path check, whatever the current directory
    ['C:x', null],
    ['c:\\', 'drive_root'],
    ['C:\\.', 'drive_root'],
    ['C:\\ ', 'drive_root'], // the value is trimmed
    ['C:\\x.', null], // a trailing dot or space below the root is the library's to refuse
    ['C:\\x ', null],
    ['\\??\\C:\\x', null], // not two leading separators: rooted without a drive, left to the library
  ];
  for (const [value, answer] of cases) {
    assert.equal(windowsRootRefusal(value, 'win32'), answer, JSON.stringify(value));
  }
});

test('off Windows the helper changes nothing', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const value of ['\\\\server\\share', '\\\\?\\C:\\x', 'C:\\', '/', '//server/share']) {
      assert.equal(windowsRootRefusal(value, platform), null, `${platform} ${value}`);
    }
  }
  assert.equal(windowsRootRefusal(null, 'win32'), null, 'a non-string is left to the existing checks');
});

test('workspace_root: each shape is refused by the loader with the reason from the failure table', { skip: windowsOnly }, () => withFixture(({ root, hosted, refusal }) => {
  const folder = path.join(root, 'workspace');
  fs.mkdirSync(folder);
  const driveRoot = path.parse(folder).root;
  const cases = [
    [`\\\\?\\${folder}`, 'device_prefix'],
    [`\\\\.\\${folder}`, 'device_prefix'],
    [`\\\\localhost\\${driveRoot[0].toLowerCase()}$${folder.slice(2)}`, 'unc_path'],
    ['\\\\jenny-no-such-host.invalid\\share\\projects', 'unc_path'],
    [driveRoot, 'drive_root'],
  ];
  for (const [value, detail] of cases) {
    const found = refusal(hosted(value));
    assert.deepEqual([found?.reason, found?.detail], [REASON, detail], value);
    assert.equal(found.message.includes(folder), false, 'the message carries no path');
  }
  assert.equal(refusal(hosted(folder)), null, 'an ordinary local folder loads');
}));

test('a link whose real path is a drive root is refused after resolution', { skip: windowsOnly }, () => withFixture(({ root, hosted, refusal }) => {
  const link = path.join(root, 'link-to-drive');
  fs.symlinkSync(path.parse(root).root, link, 'junction'); // a junction needs no elevation
  const found = refusal(hosted(link));
  assert.deepEqual([found?.reason, found?.detail], [REASON, 'drive_root']);
}));

test('team projects_root: each shape is refused by the loader with the reason from the failure table', { skip: windowsOnly }, () => withFixture(({ root, team, refusal }) => {
  const folder = path.join(root, 'projects');
  fs.mkdirSync(folder);
  const cases = [
    [`\\\\?\\${folder}`, 'device_prefix'],
    [`\\\\.\\${folder}`, 'device_prefix'],
    ['\\\\jenny-no-such-host.invalid\\share\\projects', 'unc_path'],
    [path.parse(folder).root, 'drive_root'],
  ];
  for (const [value, detail] of cases) {
    const found = refusal(team(value));
    assert.deepEqual([found?.reason, found?.detail], [REASON, detail], value);
  }
  assert.equal(refusal(team(folder)), null, 'an ordinary local folder loads');
}));
