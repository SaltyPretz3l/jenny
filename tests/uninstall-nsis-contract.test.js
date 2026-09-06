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
  for (const name of KNOWN_USER_DATA_CHILDREN) {
    assert.match(source, new RegExp(`RemoveJennyProfileChild "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  assert.match(source, /IfFileExists "\$APPDATA\\jenny\\\*\.\*"/);
  assert.match(source, /JennyCleanupIncomplete/);
  assert.match(source, /SetErrorLevel 24/);
  assert.match(source, /GetFileAttributesW/);
  assert.match(source, /0x400/);
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
  for (const name of KNOWN_USER_DATA_CHILDREN) {
    assert.match(source, new RegExp(`remove_profile_child "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
});
