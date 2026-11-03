'use strict';

// Row 94 P2: which folders the Jenny chat may bind to a new project (services/agent-folder-policy.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { agentFolderRefusal } = require('../services/agent-folder-policy');

const WIN = {
  platform: 'win32',
  homedir: 'C:\\Users\\pat',
  env: {
    SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\pat\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\pat\\AppData\\Local',
  },
  protectedPaths: ['C:\\Users\\pat\\AppData\\Roaming\\jenny'],
};
const LINUX = { platform: 'linux', homedir: '/home/pat', env: {}, protectedPaths: ['/home/pat/.config/jenny'] };
const MAC = { platform: 'darwin', homedir: '/Users/pat', env: {}, protectedPaths: [] };

test('review fixes: `..x` folders, other accounts\' homes and a home reached through a link', () => {
  assert.equal(agentFolderRefusal('C:\\Windows\\..x', WIN), 'protected_folder');
  assert.equal(agentFolderRefusal('C:\\Users\\pat\\AppData\\Local\\..cache', WIN), 'protected_folder');
  assert.equal(agentFolderRefusal('/etc/..x', LINUX), 'protected_folder');
  assert.equal(agentFolderRefusal('G:\\..x\\app', WIN), null);
  assert.equal(agentFolderRefusal('C:\\Users\\sam', WIN), 'home_folder');
  assert.equal(agentFolderRefusal('C:\\Users', WIN), 'protected_folder');
  assert.equal(agentFolderRefusal('/home/sam', LINUX), 'home_folder');
  assert.equal(agentFolderRefusal('C:\\Users\\sam\\code', WIN), null, 'a project inside another account stays the OS\'s call');
  // The home is a junction to D:\\home\\pat; the realpath'd target must still read as the home (only on this platform).
  if (process.platform === 'win32') {
    const linked = { ...WIN, realpath: (value) => (value === 'C:\\Users\\pat' ? 'D:\\home\\pat' : value) };
    assert.equal(agentFolderRefusal('D:\\home\\pat', linked), 'home_folder');
  }
});

test('ordinary project folders may be bound', () => {
  assert.equal(agentFolderRefusal('G:\\Work\\app', WIN), null);
  assert.equal(agentFolderRefusal('C:\\Users\\pat\\code\\site', WIN), null);
  assert.equal(agentFolderRefusal('/home/pat/code/site', LINUX), null);
  assert.equal(agentFolderRefusal('/Users/pat/dev/tool', MAC), null);
});

test('drive, volume and share roots are refused', () => {
  assert.equal(agentFolderRefusal('G:\\', WIN), 'root_folder');
  assert.equal(agentFolderRefusal('\\\\server\\share\\', WIN), 'root_folder');
  assert.equal(agentFolderRefusal('/', LINUX), 'root_folder');
});

test('the home folder itself is refused, its project subfolders are not', () => {
  assert.equal(agentFolderRefusal('C:\\Users\\pat', WIN), 'home_folder');
  assert.equal(agentFolderRefusal('c:\\users\\PAT', WIN), 'home_folder');
  assert.equal(agentFolderRefusal('/home/pat', LINUX), 'home_folder');
  assert.equal(agentFolderRefusal('/Users/pat', MAC), 'home_folder');
});

test('OS, program and app-data folders are refused, inside and above', () => {
  for (const folder of ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files\\Git', 'C:\\ProgramData\\x',
    'C:\\Users\\pat\\AppData\\Roaming\\Code', 'C:\\Users\\pat\\AppData', 'C:\\Users']) {
    assert.equal(agentFolderRefusal(folder, WIN), 'protected_folder', folder);
  }
  for (const folder of ['/etc', '/usr/local/src', '/var/lib', '/home/pat/.config/jenny', '/home/pat/.local/share/app', '/home']) {
    assert.equal(agentFolderRefusal(folder, LINUX), 'protected_folder', folder);
  }
  assert.equal(agentFolderRefusal('/Users/pat/Library/Application Support', MAC), 'protected_folder');
});

test("Jenny's own data folder, passed by the caller, is refused", () => {
  assert.equal(agentFolderRefusal('C:\\Users\\pat\\AppData\\Roaming\\jenny\\personality', WIN), 'protected_folder');
  assert.equal(agentFolderRefusal('G:\\Apps\\Jenny', { ...WIN, protectedPaths: ['G:\\Apps\\Jenny\\resources'] }), 'protected_folder');
});

test('credential and tool-config folders are refused anywhere in the path', () => {
  assert.equal(agentFolderRefusal('G:\\keys\\.ssh', WIN), 'credential_folder');
  assert.equal(agentFolderRefusal('G:\\keys\\.SSH.', WIN), 'credential_folder');
  assert.equal(agentFolderRefusal('G:\\work\\.codex\\sessions', WIN), 'credential_folder');
  assert.equal(agentFolderRefusal('/srv/app/.aws', LINUX), 'credential_folder');
  assert.equal(agentFolderRefusal('/srv/app/.config/gh', LINUX), 'credential_folder');
  assert.equal(agentFolderRefusal('/srv/app/.claude', LINUX), 'credential_folder');
});

test('a relative or non-string folder is refused', () => {
  assert.equal(agentFolderRefusal('code\\app', WIN), 'protected_folder');
  assert.equal(agentFolderRefusal(null, LINUX), 'protected_folder');
});
