'use strict';

const path = require('node:path');
const { importConversations, assertImportComplete } = require('../services/host/maintenance-commands');
const { createHostedBackend } = require('../services/host/service-composition');
const { FileSecretStore } = require('./file-secret-store');
const { acquireProfile } = require('../services/host/profile-ownership');
const { HOST_ERROR_CODES } = require('../services/backend/error-codes');
const { AuthService } = require('./auth-service');
const { AuthStore } = require('./auth-store');
const { loadHostConfig } = require('./config');
const { assertProfileMode } = require('./host-core');
const { normalizeProjectId } = require('../services/projects/project-schema');
const { validateSegment } = require('./team/path-segments');
const { readPassword } = require('./team/tty-input');

// Team commands (TEAM_MEMBERSHIP_SPEC slice 1h): run with the team server stopped. Each takes --config and only
// its own closed flags (TEAM_FLAGS): the maintenance commands of slices 3-13 and 3-14 add a project id and one file
// or folder name, never a path or a secret; the others take nothing else, so no argument can carry a key or an
// invite. team-doctor (slice 3-11) only reads, so it may also run beside a running server.
const TEAM_COMMANDS = new Set(['team-keygen', 'team-init', 'team-recover', 'team-doctor', 'team-copy-in', 'team-export',
  'team-restore', 'team-delete']);
const OWNER_COMMANDS = new Set(['owner-init', 'import-conversations', ...TEAM_COMMANDS]);
const TEAM_FLAGS = Object.freeze({ 'team-copy-in': ['--folder', '--project'], 'team-restore': ['--file'] });
const VALUE_FLAGS = new Set(['--project', '--folder', '--file']);

function usage() {
  return [
    'Usage: node server/cli.js (owner-init | import-conversations --archive /backup/jenny.archive) --config /etc/jenny/host.json',
    '       node server/cli.js (team-keygen | team-init | team-recover | team-doctor | team-export | team-delete) --config <absolute path to the team host config>',
    '       node server/cli.js team-copy-in --project <project id> --folder <name> --config <path>',
    '       node server/cli.js team-restore --file <name> --config <path>',
    '  team-keygen   writes the team host key file once (key_source secret_file); prints the team id',
    '  team-init     prints the first owner invite on this terminal (empty team, server stopped)',
    '  team-recover  prints an owner recovery invite on this terminal (server stopped)',
    '  team-doctor   checks a team host: key file, projects root, bridge, readiness (reads only)',
    '  team-copy-in  copies a folder of the import folder into a project as a new folder (server stopped)',
    '  team-export   writes the team to one password-locked file in the exchange folder (server stopped, terminal)',
    '  team-restore  restores a team from such a file onto a host with no team (server stopped, terminal)',
    '  team-delete   deletes the team after its name is typed (server stopped, terminal)',
  ].join('\n');
}

// A team command's arguments: exactly its closed flags, each once; a name is one path segment (the upload's
// segment rules), checked here so a refusal never echoes it.
function teamArgs(command, configPath, named, ownerFlags) {
  const allowed = TEAM_FLAGS[command] ?? [];
  if (ownerFlags || Object.keys(named).sort().join() !== allowed.join()) {
    throw new Error(allowed.length ? `${command} takes only --config and ${allowed.join(' and ')}.` : 'Team commands take only --config.');
  }
  if (named['--project'] !== undefined && normalizeProjectId(named['--project']) !== named['--project']) {
    throw new Error('--project must be a project id.');
  }
  for (const flag of ['--folder', '--file']) {
    if (named[flag] !== undefined && !validateSegment(named[flag]).ok) throw new Error(`${flag} must be one plain name.`);
  }
  return { command, configPath, ...(named['--project'] ? { project: named['--project'] } : {}),
    ...(named['--folder'] ? { folder: named['--folder'] } : {}), ...(named['--file'] ? { file: named['--file'] } : {}) };
}

function parseCliArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) throw new TypeError('CLI arguments must be an array.');
  let command = '';
  let configPath = '';
  let pythonExecutable = '';
  let archivePath = '';
  const named = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') return { help: true };
    if (OWNER_COMMANDS.has(value)) {
      if (command) throw new Error('Only one owner command may be supplied.');
      command = value;
    } else if (value === '--config' || value === '-c') {
      if (configPath || !argv[index + 1]) throw new Error('A single --config path is required.');
      configPath = argv[++index];
    } else if (value === '--archive') {
      if (archivePath || !argv[index + 1]) throw new Error('A single --archive path is required.');
      archivePath = argv[++index];
    } else if (value === '--python') {
      if (pythonExecutable || !argv[index + 1]) throw new Error('A single --python path is allowed.');
      pythonExecutable = argv[++index];
    } else if (VALUE_FLAGS.has(value)) {
      if (Object.hasOwn(named, value) || !argv[index + 1]) throw new Error(`A single ${value} value is required.`);
      named[value] = argv[++index];
    } else {
      throw new Error('Unknown CLI argument.');
    }
  }
  if (!command) throw new Error(`A command is required (${[...OWNER_COMMANDS].join(', ')}).`);
  if (!configPath) throw new Error('The --config path is required.');
  if (TEAM_COMMANDS.has(command)) return teamArgs(command, configPath, named, archivePath || pythonExecutable);
  if (Object.keys(named).length) throw new Error('Unknown CLI argument.');
  if ((command === 'import-conversations') !== Boolean(archivePath)) throw new Error('Import requires --archive.');
  return { command, configPath, ...(archivePath ? { archivePath } : {}), ...(pythonExecutable ? { pythonExecutable } : {}) };
}

const PROFILE_REFUSAL = Object.freeze({ ok: false, code: HOST_ERROR_CODES.CONFLICT, reason: 'invalid_host_profile' });

// Under the lock, before anything is written: a single-owner command refuses a profile a
// team host holds. null when the profile is this mode's.
function profileRefusal(config) {
  try { assertProfileMode(config); } catch (error) {
    if (error?.reason === 'invalid_host_profile') return { ...PROFILE_REFUSAL };
    throw error;
  }
  return null;
}

async function initializeOwner({
  config,
  readPasswordImpl = readPassword,
  acquireProfileImpl = acquireProfile,
  AuthStoreImpl = AuthStore,
  AuthServiceImpl = AuthService,
  input = process.stdin,
  output = process.stderr,
  confirmOutput = process.stdout,
  pythonExecutable = '',
} = {}) {
  if (!config?.userDataPath) throw new Error('Hosted configuration is required.');
  // A team profile has no password (TEAM_MEMBERSHIP_SPEC M1): refused before the lock, nothing written.
  if (config.team) return { ...PROFILE_REFUSAL };
  const lock = acquireProfileImpl({
    userDataPath: config.userDataPath,
    pythonExecutable: pythonExecutable || config.pythonExecutable || '/usr/bin/python3',
  });
  try {
    const refused = profileRefusal(config);
    if (refused) return refused;
    const authPath = path.join(config.userDataPath, 'auth.json');
    const store = new AuthStoreImpl({ filePath: authPath });
    const auth = new AuthServiceImpl({ store });
    if (auth.isConfigured()) {
      confirmOutput.write('Owner password is already initialized.\n');
      return { ok: false, code: 'AUTH_ALREADY_INITIALIZED' };
    }
    const first = await readPasswordImpl({ input, output, prompt: 'Owner password: ' });
    const second = await readPasswordImpl({ input, output, prompt: 'Repeat owner password: ' });
    if (first !== second) {
      confirmOutput.write('Owner passwords did not match.\n');
      return { ok: false, code: 'AUTH_PASSWORD_MISMATCH' };
    }
    const result = await auth.initializePassword(first);
    if (result.ok) confirmOutput.write('Owner password initialized.\n');
    else confirmOutput.write('Owner password initialization failed.\n');
    return result;
  } finally {
    lock.release();
  }
}

// The team commands print to the terminal stream (`confirmOutput`) and a refusal
// as one plain line with its reason on `errorOutput`. Their logs go to stderr.
async function runTeamCommand(parsed, dependencies) {
  // Required lazily: owner-init and import-conversations load no team module.
  const { stderrLog } = require('./team/recovery');
  const configPath = path.resolve(parsed.configPath);
  const output = dependencies.confirmOutput || process.stdout;
  const errorOutput = dependencies.errorOutput || process.stderr;
  const logger = dependencies.logger || stderrLog;
  const { acquireProfileImpl } = dependencies;
  // The maintenance prompts read the terminal (stdin) and write to standard error.
  const terminal = { input: dependencies.input || process.stdin, promptOutput: dependencies.promptOutput || process.stderr };
  const common = { configPath, output, logger, acquireProfileImpl };
  const run = {
    'team-doctor': () => require('./team/team-doctor').runTeamDoctor({ configPath, output }),
    // Beside a cut restore's staging (decrypted team data) no new key is made (review sweep X4c-F03).
    'team-keygen': async () => require('./team/team-maintenance').keygenRefusal(configPath)
      ?? require('./team/keygen').createTeamHostKey({ configPath, output, logger }),
    'team-copy-in': () => require('./team/team-copy-in').copyFolderIn({ ...common, projectId: parsed.project,
      folderName: parsed.folder }),
    'team-export': () => require('./team/team-export').exportHostedTeam({ ...common, ...terminal }),
    'team-restore': () => require('./team/team-restore').restoreHostedTeam({ ...common, ...terminal, fileName: parsed.file }),
    'team-delete': () => require('./team/team-delete').deleteHostedTeam({ ...common, ...terminal }),
  }[parsed.command] ?? (() => require('./team/recovery').mintLocalOwnerInvite({
    kind: parsed.command === 'team-init' ? 'owner_first' : 'recovery', ...common,
    networkInterfaces: dependencies.networkInterfaces,
  }));
  const result = await run();
  if (!result.ok) errorOutput.write(`${parsed.command} refused: ${result.reason}\n`);
  return result;
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) return { ok: true, help: usage() };
  if (TEAM_COMMANDS.has(parsed.command)) return runTeamCommand(parsed, dependencies);
  const config = (dependencies.loadHostConfigImpl || loadHostConfig)(path.resolve(parsed.configPath));
  const result = parsed.command === 'import-conversations'
    ? await importArchive(parsed, config, dependencies)
    : await initializeOwner({ ...dependencies, config, pythonExecutable: parsed.pythonExecutable });
  if (!result.ok && result.reason === 'invalid_host_profile') {
    (dependencies.errorOutput || process.stderr).write(`${parsed.command} refused: ${result.reason}\n`);
  }
  return result;
}

// A team profile holds no single-owner conversations: a team config is refused before
// the lock, as owner-init refuses it, and a team profile under it.
async function importArchive(parsed, config, dependencies) {
  if (config.team) return { ...PROFILE_REFUSAL };
  const pythonExecutable = parsed.pythonExecutable || config.pythonExecutable || '/opt/jenny-venv/bin/python';
  const lock = (dependencies.acquireProfileImpl || acquireProfile)({ userDataPath: config.userDataPath, pythonExecutable });
  let composition;
  try {
    const refused = profileRefusal(config);
    if (refused) return refused;
    assertImportComplete(config.userDataPath);
    const passphrase = await (dependencies.readPasswordImpl || readPassword)({ prompt: 'Archive passphrase (blank for unencrypted): ' });
    // Offline import never starts the runtime; compose with command execution disabled.
    composition = createHostedBackend({ ...config, hostExecutionPolicyVersion: 1,
      pythonExecutable, repoRoot: path.resolve(__dirname, '..'),
      credentialService: new FileSecretStore({ directory: config.secretsDir }) });
    const result = await importConversations({ backend: composition.backend, userDataPath: config.userDataPath,
      archivePath: path.resolve(parsed.archivePath), passphrase });
    (dependencies.confirmOutput || process.stdout).write(`${JSON.stringify(result)}\n`);
    return result;
  } finally { try { await composition?.dispose(); } finally { lock.release(); } }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const result = await runCli(argv, dependencies);
    if (result.help) (dependencies.confirmOutput || process.stdout).write(`${result.help}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    (dependencies.errorOutput || process.stderr).write(`${error?.message || 'Hosted CLI failed.'}\n${usage()}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  initializeOwner,
  main,
  parseCliArgs,
  readPassword,
  runCli,
  usage,
};
