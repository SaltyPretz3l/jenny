'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { REMOVAL_CHOICES } = require('../services/data-lifecycle/data-lifecycle-service');
const { UNINSTALL_EXIT_CODES } = require('../services/data-lifecycle/uninstall-contract');
const {
  exitCodeForRemovalMode,
  isUninstallAssistantMode,
  normalizeRemovalOptions,
} = require('../services/main/uninstall-assistant-main');

test('uninstall assistant mode and fixed exit-code contract are explicit', () => {
  assert.equal(isUninstallAssistantMode(['electron', '.', '--uninstall-assistant']), true);
  assert.equal(isUninstallAssistantMode(['electron', '.']), false);
  assert.equal(exitCodeForRemovalMode(REMOVAL_CHOICES.APP_ONLY), UNINSTALL_EXIT_CODES.APP_ONLY);
  assert.equal(exitCodeForRemovalMode(REMOVAL_CHOICES.ARCHIVE_AND_REMOVE), UNINSTALL_EXIT_CODES.ARCHIVE_AND_REMOVE);
  assert.equal(exitCodeForRemovalMode(REMOVAL_CHOICES.PERMANENT), UNINSTALL_EXIT_CODES.PERMANENT);
  assert.equal(exitCodeForRemovalMode('arbitrary'), UNINSTALL_EXIT_CODES.HELPER_FAILURE);
});

test('removal payload normalization rejects arbitrary choices and paths', () => {
  assert.equal(normalizeRemovalOptions({ choice: 'delete:C:\\' }), null);
  assert.deepEqual(normalizeRemovalOptions({
    choice: REMOVAL_CHOICES.PERMANENT,
    confirmation: 'REMOVE JENNY',
    removeWorkspaceData: true,
    path: 'C:\\unexpected',
  }), {
    choice: REMOVAL_CHOICES.PERMANENT,
    confirmation: 'REMOVE JENNY',
    archive: null,
    removeWorkspaceData: true,
  });
  assert.equal(normalizeRemovalOptions({
    choice: REMOVAL_CHOICES.ARCHIVE_AND_REMOVE,
    archive: { encrypted: true, passphrase: 'long enough pass', passphraseConfirmation: '' },
  }), null);
});
