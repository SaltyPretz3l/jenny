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

test('NSIS uninstall drops the CLI bin directory from the user Path on every real uninstall without touching the profile', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  const start = source.indexOf('!macro RemoveJennyCliPathEntry');
  assert.ok(start >= 0, 'the PATH removal macro exists');
  const macro = source.slice(start, source.indexOf('!macroend', start));
  // Skipped on update (the next version reuses the directory), HKCU only.
  assert.match(macro, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(macro, /ReadRegStr \$R0 HKCU "Environment" "Path"/);
  assert.match(macro, /WriteRegExpandStr HKCU "Environment" "Path" \$R4/);
  assert.match(macro, /DeleteRegValue HKCU "Environment" "Path"/);
  assert.doesNotMatch(macro, /HKLM|SYSTEM\\CurrentControlSet/i);
  // Compares against the installed shim directory, tolerating %VAR% and trailing backslashes.
  assert.match(macro, /StrCmp \$R7 "\$INSTDIR\\resources\\bin"/);
  assert.match(macro, /ExpandEnvStrings \$R7 \$R3/);
  assert.match(macro, /StrCmp \$R1 "\\"/);
  // A value that may have been truncated by the NSIS buffer is never written back.
  assert.match(source, /!define \/math JennyCliPathReadLimit \$\{NSIS_MAX_STRLEN\} - 1/);
  assert.match(macro, /IntCmp \$R1 \$\{JennyCliPathReadLimit\} jenny_cli_path_restore 0 jenny_cli_path_restore/);
  assert.match(macro, /SendMessage 0xFFFF 0x1A 0 "STR:Environment"/);
  // It never reaches the profile and adds no profile child.
  assert.doesNotMatch(macro, /\$APPDATA|RemoveJennyProfileChild|RMDir|Delete "/);
  // Every register it uses is saved and restored in reverse order.
  const pushes = [...macro.matchAll(/^\s*Push (\$R\d)$/gm)].map((match) => match[1]);
  const pops = [...macro.matchAll(/^\s*Pop (\$R\d)$/gm)].map((match) => match[1]);
  assert.deepEqual(pops, [...pushes].reverse());
  // Every jump target is defined once.
  const labels = [...macro.matchAll(/^\s*(jenny_cli_path_[a-z_]+):$/gm)].map((match) => match[1]);
  assert.equal(new Set(labels).size, labels.length);
  for (const target of new Set([...macro.matchAll(/\b(jenny_cli_path_[a-z_]+)\b(?!:)/g)].map((match) => match[1]))) {
    assert.ok(labels.includes(target), `label ${target} is defined`);
  }
  // Inserted first in customUnInstall, before the cleanup-mode gate, so it runs in every mode.
  const hook = source.slice(source.indexOf('!macro customUnInstall'));
  const insert = hook.indexOf('!insertmacro RemoveJennyCliPathEntry');
  assert.ok(insert > 0, 'customUnInstall inserts the PATH removal');
  assert.ok(insert < hook.indexOf('StrCmp $JennyRemovalMode "cleanup"'), 'it runs before the cleanup-mode gate');
});
