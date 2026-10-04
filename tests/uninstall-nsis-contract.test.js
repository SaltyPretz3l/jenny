'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { KNOWN_USER_DATA_CHILDREN } = require('../services/data-lifecycle/cleanup-service');

test('NSIS uninstall hook skips updates and silent purges while mapping only fixed helper exits', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  assert.match(source, /!macro customUnInit/);
  assert.match(source, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(source, /IfSilent done/);
  for (const code of [20, 21, 22, 23]) assert.match(source, new RegExp(`StrCmp \\$0 ${code}`));
  assert.doesNotMatch(source, /RMDir \/r "\$PROFILE\\\.companion"/);
  assert.match(source, /StrCmp \$JennyRemovalMode "cleanup"/);
  assert.doesNotMatch(source, /RMDir \/r "\$APPDATA\\jenny"/);
  const children = [...source.matchAll(/^\s*!insertmacro RemoveJennyProfileChild "([^"]+)"/gm)].map((match) => match[1]);
  assert.deepEqual(children.sort(), [...KNOWN_USER_DATA_CHILDREN].sort());
  assert.match(source, /IfFileExists "\$APPDATA\\jenny\\\*\.\*"/);
  assert.match(source, /JennyCleanupIncomplete/);
  assert.match(source, /SetErrorLevel 24/);
  assert.match(source, /GetFileAttributesW/);
  assert.match(source, /0x400/);
});

test('NSIS profile cleanup rejects a linked or unreadable profile root before any child removal', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  const hook = source.slice(source.indexOf('!macro customUnInstall'));
  const rootCheck = hook.indexOf('GetFileAttributesW(t "$APPDATA\\jenny")');
  const firstChild = hook.indexOf('!insertmacro RemoveJennyProfileChild');
  assert.ok(rootCheck > 0, 'the profile root attributes are read');
  assert.ok(rootCheck < firstChild, 'the root check precedes the first child removal');
  const block = hook.slice(0, firstChild);
  assert.match(block, /IfFileExists "\$APPDATA\\jenny" 0 jenny_root_clear/, 'a missing root skips the check');
  assert.match(block, /IntOp \$1 \$0 & 0x400/);
  assert.match(block, /StrCmp \$1 "0" jenny_root_clear/, 'only a zero reparse bit continues');
  const linked = block.slice(block.indexOf('MessageBox'), block.indexOf('jenny_root_clear:'));
  assert.match(linked, /link/i);
  assert.match(linked, /SetErrorLevel 24/);
  assert.match(linked, /Goto done/);
  assert.doesNotMatch(linked, /RemoveJennyProfileChild|RMDir|Delete /);
  assert.match(block, /jenny_root_clear:/);
});

test('electron-builder wires the NSIS include and DMG helper', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(config, /include: build\/installer\.nsh/);
  assert.match(config, /path: uninstall\.command/);
  assert.match(config, /!uninstall-preload\.js/);
});

test('macOS helper uses the same fixed profile-child allowlist', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'uninstall.command'), 'utf8');
  assert.doesNotMatch(source, /rm -rf -- "\$PROFILE_ROOT"/);
  assert.match(source, /\[ -L "\$TARGET" \]/);
  const children = [...source.matchAll(/^\s+remove_profile_child "([^"]+)"/gm)].map((match) => match[1]);
  assert.deepEqual(children.sort(), [...KNOWN_USER_DATA_CHILDREN].sort());
});
