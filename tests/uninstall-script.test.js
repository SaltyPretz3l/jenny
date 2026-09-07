'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deleteVerifiedClone,
  inspectCloneRoot,
  removeGeneratedDependencies,
  removeVerifiedCloneShortcut,
  resolveProfilePath,
  runCli,
  runTerminalFlow,
} = require('../scripts/uninstall');
const { UNINSTALL_EXIT_CODES } = require('../services/data-lifecycle/uninstall-contract');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-uninstall-script-'));
}

describe('clone uninstall helpers', () => {
  it('resolves only platform-specific Jenny profile roots', () => {
    assert.equal(resolveProfilePath('win32', { APPDATA: 'C:\\Users\\A\\AppData\\Roaming' }, 'C:\\Users\\A'), 'C:\\Users\\A\\AppData\\Roaming\\jenny');
    // Literals, not path.join(...) of the same inputs: computing the expectation
    // the way production computes it asserted nothing, and made these two cases
    // answer differently depending on the host's separator.
    assert.equal(resolveProfilePath('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/jenny');
    assert.equal(resolveProfilePath('linux', { XDG_CONFIG_HOME: '/tmp/config' }, '/home/a'), '/tmp/config/jenny');
  });

  it('removes only known generated clone children and retains symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-uninstall-script-'));
    try {
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.mkdirSync(path.join(root, 'source'));
      const removed = removeGeneratedDependencies(root);
      assert.deepEqual(removed, ['node_modules']);
      assert.equal(fs.existsSync(path.join(root, 'source')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails clone deletion closed for dirty state or wrong typed directory', () => {
    const root = path.join(os.tmpdir(), 'jenny-clone-fixture');
    assert.deepEqual(deleteVerifiedClone(root, 'jenny-clone-fixture', {
      ok: true, clean: false, root, directoryName: 'jenny-clone-fixture',
    }), { ok: false, reason: 'git_worktree_dirty' });
    assert.deepEqual(deleteVerifiedClone(root, 'wrong', {
      ok: true, clean: true, root, directoryName: 'jenny-clone-fixture',
    }), { ok: false, reason: 'directory_confirmation_mismatch' });
  });

  it('requires a canonical Git root and origin before clone deletion is offered', () => {
    const root = makeTempRoot();
    try {
      fs.mkdirSync(path.join(root, '.git'));
      fs.mkdirSync(path.join(root, 'services', 'data-lifecycle'), { recursive: true });
      fs.writeFileSync(path.join(root, 'services', 'data-lifecycle', 'uninstall-contract.js'), 'module.exports = {};');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'jenny',
        main: 'main.js',
        repository: { url: 'https://github.com/SaltyPretz3l/jenny.git' },
      }));
      const inspectWithOrigin = (origin) => inspectCloneRoot(root, {
        execFileSync: (_file, args) => {
          if (args[0] === 'rev-parse') return root;
          if (args[0] === 'remote') return origin;
          if (args[0] === 'status') return '';
          throw new Error('unexpected git command');
        },
      });
      assert.equal(inspectWithOrigin('https://example.com/not-jenny.git').reason, 'git_identity_mismatch');
      assert.equal(inspectWithOrigin('git@github.com:SaltyPretz3l/jenny.git').ok, true);
      // The private dev clone's origin is SaltyPretz3l/jenny-src after the 2026-08 repo
      // rename (the public distribution repo took the bare `jenny` name).
      assert.equal(inspectWithOrigin('https://github.com/SaltyPretz3l/jenny-src.git').ok, true);
      assert.equal(inspectWithOrigin('https://github.com/SaltyPretz3l/jenny-site.git').reason, 'git_identity_mismatch');
      assert.equal(inspectWithOrigin('https://github.com/SaltyPretz3l/jenny-dist.git').reason, 'git_identity_mismatch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a forged inspection that names a different clone root', () => {
    const parent = makeTempRoot();
    try {
      const requestedRoot = path.join(parent, 'requested');
      const otherRoot = path.join(parent, 'other');
      fs.mkdirSync(requestedRoot);
      fs.mkdirSync(otherRoot);
      const result = deleteVerifiedClone(requestedRoot, 'other', {
        ok: true,
        clean: true,
        root: otherRoot,
        directoryName: 'other',
      });
      assert.deepEqual(result, { ok: false, reason: 'unsafe_clone_root' });
      assert.equal(fs.existsSync(requestedRoot), true);
      assert.equal(fs.existsSync(otherRoot), true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('removes only a Windows desktop shortcut proven to target this clone', () => {
    const root = makeTempRoot();
    try {
      const shortcutPath = path.join(root, 'Jenny.lnk');
      const legacyShortcutPath = path.join(root, 'Jenny Shell.lnk');
      const cloneRoot = path.join(root, 'clone');
      fs.mkdirSync(cloneRoot);
      fs.writeFileSync(shortcutPath, 'fixture');
      fs.writeFileSync(legacyShortcutPath, 'fixture');
      const ownedDetails = (name) => ({
        shortcutPath: path.join(root, name),
        target: path.join(cloneRoot, 'launch-jenny.cmd'),
        workingDirectory: cloneRoot,
      });
      const owned = removeVerifiedCloneShortcut(cloneRoot, {
        platform: 'win32',
        inspectShortcut: ownedDetails,
      });
      assert.equal(owned.removed, true);
      assert.equal(fs.existsSync(shortcutPath), false);
      // The pre-rename "Jenny Shell" shortcut is cleared in the same pass.
      assert.equal(fs.existsSync(legacyShortcutPath), false);

      fs.writeFileSync(shortcutPath, 'fixture');
      const foreign = removeVerifiedCloneShortcut(cloneRoot, {
        platform: 'win32',
        inspectShortcut: () => ({ shortcutPath, target: 'C:\\Other\\app.exe', workingDirectory: 'C:\\Other' }),
      });
      assert.equal(foreign.reason, 'shortcut_not_owned');
      assert.equal(fs.existsSync(shortcutPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not fall back to terminal or offer clone cleanup after helper failure', async () => {
    let serviceCreated = false;
    let promptCount = 0;
    const result = await runCli({
      launchAssistant: () => UNINSTALL_EXIT_CODES.HELPER_FAILURE,
      createService: () => { serviceCreated = true; return {}; },
      prompter: {
        ask: async () => { promptCount += 1; return 'yes'; },
        close() {},
      },
    });
    assert.equal(result, UNINSTALL_EXIT_CODES.HELPER_FAILURE);
    assert.equal(serviceCreated, false);
    assert.equal(promptCount, 0);
  });

  it('stops before clone cleanup prompts when external data cleanup is incomplete', async () => {
    let promptCount = 0;
    const result = await runCli({
      launchAssistant: () => UNINSTALL_EXIT_CODES.PERMANENT,
      cleanupData: async () => ({ ok: false, status: 'incomplete' }),
      prompter: {
        ask: async () => { promptCount += 1; return 'yes'; },
        close() {},
      },
    });
    assert.equal(result, UNINSTALL_EXIT_CODES.HELPER_FAILURE);
    assert.equal(promptCount, 0);
  });

  it('keeps permanent workspace cleanup as a separate default-off terminal choice', async () => {
    const answers = ['3', 'REMOVE JENNY', 'yes'];
    let removalOptions = null;
    const result = await runTerminalFlow({
      prompter: { ask: async () => answers.shift() },
      service: {
        getOverview: async () => ({ workspace: { available: true } }),
        prepareRemoval: async (options) => {
          removalOptions = options;
          return { ok: true };
        },
      },
      output: { write() {} },
    });
    assert.equal(result.exitCode, UNINSTALL_EXIT_CODES.PERMANENT);
    assert.deepEqual(removalOptions, {
      choice: 'permanent',
      confirmation: 'REMOVE JENNY',
      removeWorkspaceData: true,
    });
  });

  it('offers app-only preservation after a terminal archive failure', async () => {
    const answers = ['1', '', 'yes', '3'];
    const calls = [];
    const output = [];
    const result = await runTerminalFlow({
      prompter: {
        ask: async () => answers.shift(),
        askHidden: async () => { throw new Error('plain archive should not ask for a passphrase'); },
      },
      service: {
        documentsPath: 'Documents',
        getOverview: async () => ({ workspace: { available: false } }),
        prepareRemoval: async (options) => {
          calls.push(options);
          return options.choice === 'app_only'
            ? { ok: true, status: 'data_preserved' }
            : { ok: false, error: { reason: 'insufficient_space' } };
        },
      },
      output: { write: (value) => output.push(value) },
    });
    assert.equal(result.exitCode, UNINSTALL_EXIT_CODES.APP_ONLY);
    assert.deepEqual(calls.map((item) => item.choice), ['archive_and_remove', 'app_only']);
    assert.match(output.join(''), /Archive failed safely: insufficient_space/);
  });
});
