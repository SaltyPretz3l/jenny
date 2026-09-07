'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');

const { AttachmentAssetStore } = require('../services/attachment-asset-store');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { cleanupJennyData } = require('../services/data-lifecycle/cleanup-service');
const { DataLifecycleService } = require('../services/data-lifecycle/data-lifecycle-service');
const { UNINSTALL_EXIT_CODES } = require('../services/data-lifecycle/uninstall-contract');
const { ShellConfigService } = require('../services/shell-config-service');

const GENERATED_ROOT_NAMES = Object.freeze(['node_modules', 'dist', 'release', 'out']);
// Current shortcut name first, then the pre-1.0 "Jenny Shell" name so an
// uninstall after the rename still clears the shortcut an older build wrote.
const WINDOWS_SHORTCUT_NAMES = Object.freeze(['Jenny.lnk', 'Jenny Shell.lnk']);
const JENNY_REPOSITORY_PATTERN = /(?:^|[:/])SaltyPretz3l\/jenny(?:-src)?(?:\.git)?$/i;

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).toLocaleLowerCase('en-US');
  return normalize(left) === normalize(right);
}

function resolveSafeDirectoryRoot(rootPath) {
  const root = path.resolve(rootPath);
  if (root === path.parse(root).root) return '';
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(root), root)) return '';
  } catch (_error) {
    return '';
  }
  return root;
}

// Joins for the platform this is ASKED about, not the one it runs on. On a real
// host the two agree (path === path.win32 on Windows, path.posix elsewhere), so
// production behaviour is unchanged; it is the cross-platform cases that were
// producing host-native separators for a foreign platform.
function resolveProfilePath(platform = process.platform, env = process.env, homeDir = os.homedir()) {
  if (platform === 'win32') {
    return path.win32.join(String(env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming')), 'jenny');
  }
  if (platform === 'darwin') return path.posix.join(homeDir, 'Library', 'Application Support', 'jenny');
  return path.posix.join(String(env.XDG_CONFIG_HOME || path.posix.join(homeDir, '.config')), 'jenny');
}

function resolveDocumentsPath(platform = process.platform, homeDir = os.homedir()) {
  return path.join(homeDir, 'Documents');
}

function inspectCloneRoot(rootPath, { execFileSync = childProcess.execFileSync } = {}) {
  const root = resolveSafeDirectoryRoot(rootPath);
  if (!root) return { ok: false, reason: 'unsafe_clone_root' };
  const packagePath = path.join(root, 'package.json');
  const gitPath = path.join(root, '.git');
  if (!fs.existsSync(packagePath) || !fs.existsSync(gitPath)) return { ok: false, reason: 'not_jenny_clone' };
  if (fs.lstatSync(packagePath).isSymbolicLink() || fs.lstatSync(gitPath).isSymbolicLink()) {
    return { ok: false, reason: 'unsafe_clone_root' };
  }
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (_error) {
    return { ok: false, reason: 'package_unreadable' };
  }
  const repositoryUrl = String(packageJson.repository?.url || '');
  if (
    packageJson.name !== 'jenny'
    || packageJson.main !== 'main.js'
    || !JENNY_REPOSITORY_PATTERN.test(repositoryUrl)
    || !fs.existsSync(path.join(root, 'services', 'data-lifecycle', 'uninstall-contract.js'))
  ) {
    return { ok: false, reason: 'package_identity_mismatch' };
  }
  try {
    const topLevel = String(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    })).trim();
    if (path.resolve(topLevel).toLocaleLowerCase('en-US') !== root.toLocaleLowerCase('en-US')) {
      return { ok: false, reason: 'git_root_mismatch' };
    }
    const originUrl = String(execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    })).trim();
    if (!JENNY_REPOSITORY_PATTERN.test(originUrl)) {
      return { ok: false, reason: 'git_identity_mismatch' };
    }
    const status = String(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    }));
    return { ok: true, clean: status.trim() === '', root, directoryName: path.basename(root) };
  } catch (_error) {
    return { ok: false, reason: 'git_identity_unavailable' };
  }
}

function removeGeneratedDependencies(rootPath) {
  const root = resolveSafeDirectoryRoot(rootPath);
  if (!root) return [];
  const removed = [];
  for (const name of GENERATED_ROOT_NAMES) {
    const target = path.resolve(root, name);
    if (path.dirname(target) !== root || !fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function inspectWindowsDesktopShortcut(shortcutName = WINDOWS_SHORTCUT_NAMES[0], { execFileSync = childProcess.execFileSync } = {}) {
  if (process.platform !== 'win32') return null;
  const script = [
    "$desktop=[Environment]::GetFolderPath('Desktop')",
    `$link=Join-Path $desktop '${shortcutName}'`,
    'if (!(Test-Path -LiteralPath $link -PathType Leaf)) { exit 2 }',
    '$shell=New-Object -ComObject WScript.Shell',
    '$shortcut=$shell.CreateShortcut($link)',
    '[Console]::Out.Write((@{shortcutPath=$link;target=$shortcut.TargetPath;workingDirectory=$shortcut.WorkingDirectory}|ConvertTo-Json -Compress))',
  ].join('; ');
  try {
    const output = String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024,
    }));
    const parsed = JSON.parse(output);
    return {
      shortcutPath: path.resolve(String(parsed.shortcutPath || '')),
      target: path.resolve(String(parsed.target || '')),
      workingDirectory: path.resolve(String(parsed.workingDirectory || '')),
    };
  } catch (_error) {
    return null;
  }
}

function removeVerifiedCloneShortcut(rootPath, {
  platform = process.platform,
  inspectShortcut = inspectWindowsDesktopShortcut,
} = {}) {
  if (platform !== 'win32') return { removed: false, reason: 'unsupported_platform' };
  const root = resolveSafeDirectoryRoot(rootPath);
  if (!root) return { removed: false, reason: 'unsafe_clone_root' };
  const expectedTarget = path.join(root, 'launch-jenny.cmd');
  let reason = 'shortcut_absent';
  let removed = false;
  for (const shortcutName of WINDOWS_SHORTCUT_NAMES) {
    const details = inspectShortcut(shortcutName);
    if (!details) continue;
    if (
      path.basename(details.shortcutPath).toLocaleLowerCase('en-US') !== shortcutName.toLocaleLowerCase('en-US')
      || !samePath(details.target, expectedTarget)
      || !samePath(details.workingDirectory, root)
    ) {
      reason = 'shortcut_not_owned';
      continue;
    }
    if (!fs.existsSync(details.shortcutPath)) continue;
    const stat = fs.lstatSync(details.shortcutPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      reason = 'shortcut_unsafe';
      continue;
    }
    fs.unlinkSync(details.shortcutPath);
    removed = true;
  }
  return removed ? { removed: true } : { removed: false, reason };
}

function deleteVerifiedClone(rootPath, typedDirectoryName, inspection = inspectCloneRoot(rootPath)) {
  if (!inspection.ok) return { ok: false, reason: inspection.reason };
  if (!inspection.clean) return { ok: false, reason: 'git_worktree_dirty' };
  if (typedDirectoryName !== inspection.directoryName) return { ok: false, reason: 'directory_confirmation_mismatch' };
  const requestedRoot = resolveSafeDirectoryRoot(rootPath);
  if (!requestedRoot || !samePath(requestedRoot, inspection.root) || path.basename(requestedRoot) !== inspection.directoryName) {
    return { ok: false, reason: 'unsafe_clone_root' };
  }
  const parent = path.dirname(requestedRoot);
  if (parent === requestedRoot) {
    return { ok: false, reason: 'unsafe_clone_root' };
  }
  process.chdir(parent);
  fs.rmSync(requestedRoot, { recursive: true, force: true });
  return { ok: true, removed: requestedRoot };
}

function createPrompter(input = process.stdin, output = process.stdout) {
  let muted = false;
  const mutable = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({
    input,
    output: mutable,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  return {
    ask(question) {
      return new Promise((resolve) => rl.question(question, (answer) => resolve(String(answer || '').trim())));
    },
    askHidden(question) {
      if (!input.isTTY || !output.isTTY) {
        return new Promise((resolve) => rl.question(question, (answer) => resolve(String(answer || ''))));
      }
      output.write(question);
      muted = true;
      return new Promise((resolve) => rl.question('', (answer) => {
        muted = false;
        output.write('\n');
        resolve(String(answer || ''));
      }));
    },
    close() { rl.close(); },
  };
}

function createTerminalService({ profilePath, documentsPath, homeDir = os.homedir() }) {
  const sessionStore = new ElectronSessionStore(path.join(profilePath, 'sessions.json'));
  const runtimePath = path.join(homeDir, '.companion');
  return new DataLifecycleService({
    userDataPath: profilePath,
    documentsPath,
    runtimePath,
    appVersion: require('../package.json').version,
    sessionStore,
    attachmentStore: new AttachmentAssetStore({ rootDir: path.join(profilePath, 'attachments'), nativeImage: null }),
    shellConfigService: new ShellConfigService({ userDataPath: profilePath, resourcesPath: process.resourcesPath }),
    prepareForRemoval: async ({ choice, removeWorkspaceData, workspaceRoot }) => {
      await sessionStore.flushAsync();
      if (choice === 'app_only') return { ok: true, status: 'data_preserved' };
      return cleanupJennyData({
        userDataPath: profilePath,
        runtimePath,
        workspaceRoot,
        removeWorkspaceData,
        includeUserData: false,
      });
    },
  });
}

async function collectTerminalArchiveOptions({ prompter, service, destinationRoot }) {
  const destination = await prompter.ask(`Archive folder [${destinationRoot}]: `);
  const plain = /^y(es)?$/i.test(await prompter.ask('Create a readable plain archive instead of encrypted? [y/N]: '));
  let passphrase = '';
  let passphraseConfirmation = '';
  if (!plain) {
    passphrase = await prompter.askHidden('Passphrase (12-1024 characters): ');
    passphraseConfirmation = await prompter.askHidden('Confirm passphrase: ');
  }
  const overview = await service.getOverview();
  const includeWorkspace = overview.workspace?.available === true
    && !/^n(o)?$/i.test(await prompter.ask('Include current workspace .jenny data? [Y/n]: '));
  const removeWorkspaceData = includeWorkspace
    && /^y(es)?$/i.test(await prompter.ask('Also remove archived workspace .jenny data after verification? [y/N]: '));
  return {
    archive: {
      encrypted: !plain,
      passphrase,
      passphraseConfirmation,
      destinationRoot: destination || destinationRoot,
      includeWorkspace,
    },
    removeWorkspaceData,
  };
}

async function runTerminalArchiveFlow({ prompter, service, output }) {
  const defaultRoot = service.documentsPath && path.join(service.documentsPath, 'Jenny Archives');
  let options = await collectTerminalArchiveOptions({ prompter, service, destinationRoot: defaultRoot });
  while (true) {
    const result = await service.prepareRemoval({ choice: 'archive_and_remove', ...options });
    if (result.ok) return { exitCode: UNINSTALL_EXIT_CODES.ARCHIVE_AND_REMOVE, result };
    output.write(`Archive failed safely: ${String(result.error?.reason || 'operation_failed').slice(0, 80)}\n`);
    output.write('1) Retry archive setup\n2) Change destination\n3) Remove app only; keep data\n4) Cancel\n');
    const recovery = await prompter.ask('Choose 1-4: ');
    if (recovery === '1') {
      options = await collectTerminalArchiveOptions({
        prompter,
        service,
        destinationRoot: options.archive.destinationRoot,
      });
    } else if (recovery === '2') {
      const destination = await prompter.ask(`Archive folder [${options.archive.destinationRoot}]: `);
      if (destination) options.archive.destinationRoot = destination;
    } else if (recovery === '3') {
      const preserved = await service.prepareRemoval({ choice: 'app_only' });
      return {
        exitCode: preserved.ok ? UNINSTALL_EXIT_CODES.APP_ONLY : UNINSTALL_EXIT_CODES.HELPER_FAILURE,
        result: preserved,
      };
    } else {
      return { exitCode: UNINSTALL_EXIT_CODES.CANCEL, result };
    }
  }
}

async function runTerminalFlow({ prompter, service, output = process.stdout }) {
  output.write('\nJenny removal\n\n1) Keep a recoverable archive (recommended)\n2) Remove app only; keep data\n3) Permanently remove everything\n4) Cancel\n\n');
  const choice = await prompter.ask('Choose 1-4: ');
  if (choice === '4' || !['1', '2', '3'].includes(choice)) return { exitCode: UNINSTALL_EXIT_CODES.CANCEL };
  if (choice === '2') {
    const result = await service.prepareRemoval({ choice: 'app_only' });
    return { exitCode: result.ok ? UNINSTALL_EXIT_CODES.APP_ONLY : UNINSTALL_EXIT_CODES.HELPER_FAILURE, result };
  }
  if (choice === '3') {
    const confirmation = await prompter.ask('Type REMOVE JENNY to permanently remove known Jenny data: ');
    const overview = await service.getOverview();
    const removeWorkspaceData = overview.workspace?.available === true
      && /^y(es)?$/i.test(await prompter.ask('Also remove current workspace .jenny data? [y/N]: '));
    const result = await service.prepareRemoval({ choice: 'permanent', confirmation, removeWorkspaceData });
    return { exitCode: result.ok ? UNINSTALL_EXIT_CODES.PERMANENT : UNINSTALL_EXIT_CODES.HELPER_FAILURE, result };
  }
  return runTerminalArchiveFlow({ prompter, service, output });
}

function launchGraphicalAssistant(rootPath) {
  try {
    const electronPath = require('electron');
    const result = childProcess.spawnSync(electronPath, [rootPath, '--uninstall-assistant', '--parent=clone'], {
      cwd: rootPath,
      stdio: 'inherit',
      windowsHide: true,
    });
    return Number.isInteger(result.status) ? result.status : UNINSTALL_EXIT_CODES.HELPER_FAILURE;
  } catch (_error) {
    return null;
  }
}

async function runCli({
  argv = process.argv.slice(2),
  rootPath = path.resolve(__dirname, '..'),
  launchAssistant = launchGraphicalAssistant,
  createService = createTerminalService,
  cleanupData = cleanupJennyData,
  prompter = createPrompter(),
  output = process.stdout,
} = {}) {
  const profilePath = resolveProfilePath();
  const terminalRequested = argv.includes('--terminal');
  let exitCode = terminalRequested ? null : launchAssistant(rootPath);
  try {
    if (terminalRequested || exitCode === null) {
      const service = createService({
        profilePath,
        documentsPath: resolveDocumentsPath(),
      });
      ({ exitCode } = await runTerminalFlow({ prompter, service, output }));
    }
    if ([UNINSTALL_EXIT_CODES.ARCHIVE_AND_REMOVE, UNINSTALL_EXIT_CODES.PERMANENT].includes(exitCode)) {
      const cleanup = await cleanupData({
        userDataPath: profilePath,
        runtimePath: path.join(os.homedir(), '.companion'),
      });
      if (!cleanup.ok) exitCode = UNINSTALL_EXIT_CODES.HELPER_FAILURE;
      for (const warning of cleanup.warnings || []) output.write(`Warning: ${String(warning)}\n`);
    }
    if ([UNINSTALL_EXIT_CODES.APP_ONLY, UNINSTALL_EXIT_CODES.ARCHIVE_AND_REMOVE, UNINSTALL_EXIT_CODES.PERMANENT].includes(exitCode)) {
      removeVerifiedCloneShortcut(rootPath);
      const removeDependencies = /^y(es)?$/i.test(await prompter.ask('Remove clone dependencies and generated build output? [y/N]: '));
      if (removeDependencies) removeGeneratedDependencies(rootPath);
      const deleteClone = /^y(es)?$/i.test(await prompter.ask('Delete this clone directory too? [y/N]: '));
      if (deleteClone) {
        const inspection = inspectCloneRoot(rootPath);
        if (!inspection.ok || !inspection.clean) {
          process.stderr.write(`Clone retained: ${inspection.reason || 'git_worktree_dirty'}.\n`);
        } else {
          const typed = await prompter.ask(`Type ${inspection.directoryName} to confirm clone deletion: `);
          const deleted = deleteVerifiedClone(rootPath, typed, inspectCloneRoot(rootPath));
          if (!deleted.ok) process.stderr.write(`Clone retained: ${deleted.reason}.\n`);
        }
      }
    }
  } finally {
    prompter.close();
  }
  return exitCode;
}

if (require.main === module) {
  runCli().then((exitCode) => { process.exitCode = exitCode === UNINSTALL_EXIT_CODES.CANCEL ? 0 : exitCode === UNINSTALL_EXIT_CODES.HELPER_FAILURE ? 1 : 0; })
    .catch((error) => {
      process.stderr.write(`Jenny uninstall failed safely: ${String(error?.reason || error?.code || 'operation_failed').slice(0, 80)}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  GENERATED_ROOT_NAMES,
  createTerminalService,
  collectTerminalArchiveOptions,
  deleteVerifiedClone,
  inspectCloneRoot,
  inspectWindowsDesktopShortcut,
  launchGraphicalAssistant,
  removeGeneratedDependencies,
  removeVerifiedCloneShortcut,
  resolveDocumentsPath,
  resolveProfilePath,
  resolveSafeDirectoryRoot,
  runCli,
  runTerminalArchiveFlow,
  runTerminalFlow,
};
