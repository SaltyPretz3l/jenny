'use strict';

const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { importConversations, assertImportComplete } = require('../services/host/maintenance-commands');
const { createHostedBackend } = require('../services/host/service-composition');
const { FileSecretStore } = require('./file-secret-store');
const { acquireProfile } = require('../services/host/profile-ownership');
const { AuthService } = require('./auth-service');
const { AuthStore } = require('./auth-store');
const { loadHostConfig } = require('./config');

// Team commands (TEAM_MEMBERSHIP_SPEC slice 1h): run with the team server
// stopped; they take only --config, so no argument can carry a key or an invite.
const TEAM_COMMANDS = new Set(['team-keygen', 'team-init', 'team-recover']);
const OWNER_COMMANDS = new Set(['owner-init', 'import-conversations', ...TEAM_COMMANDS]);

function usage() {
  return [
    'Usage: node server/cli.js (owner-init | import-conversations --archive /backup/jenny.archive) --config /etc/jenny/host.json',
    '       node server/cli.js (team-keygen | team-init | team-recover) --config <absolute path to the team host config>',
    '  team-keygen   writes the team host key file once (key_source secret_file); prints the team id',
    '  team-init     prints the first owner invite on this terminal (empty team, server stopped)',
    '  team-recover  prints an owner recovery invite on this terminal (server stopped)',
  ].join('\n');
}

function parseCliArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) throw new TypeError('CLI arguments must be an array.');
  let command = '';
  let configPath = '';
  let pythonExecutable = '';
  let archivePath = '';
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
    } else {
      throw new Error('Unknown CLI argument.');
    }
  }
  if (!command) throw new Error('A command is required (owner-init, import-conversations, team-keygen, team-init, team-recover).');
  if (!configPath) throw new Error('The --config path is required.');
  if (TEAM_COMMANDS.has(command)) {
    if (archivePath || pythonExecutable) throw new Error('Team commands take only --config.');
    return { command, configPath };
  }
  if ((command === 'import-conversations') !== Boolean(archivePath)) throw new Error('Import requires --archive.');
  return { command, configPath, ...(archivePath ? { archivePath } : {}), ...(pythonExecutable ? { pythonExecutable } : {}) };
}

function readPassword({
  input = process.stdin,
  output = process.stderr,
  prompt = 'Owner password: ',
} = {}) {
  if (!input?.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('An interactive TTY is required for owner initialization.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let value = '';
    const decoder = new StringDecoder('utf8');
    const wasRaw = Boolean(input.isRaw);
    const finish = (error, result = '') => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(result);
    };
    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') return finish(new Error('Owner initialization cancelled.'));
        if (character === '\n' || character === '\r') return finish(null, value);
        if (character === '\b' || character === '\u007f') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          if (value.length >= 1024) return finish(new Error('Secret input limit exceeded.'));
          value += character;
        }
      }
    };
    try {
      output.write(prompt);
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
    } catch (error) {
      finish(error);
    }
  });
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
  const lock = acquireProfileImpl({
    userDataPath: config.userDataPath,
    pythonExecutable: pythonExecutable || config.pythonExecutable || '/usr/bin/python3',
  });
  try {
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
  const { createTeamHostKey } = require('./team/keygen');
  const { mintLocalOwnerInvite, stderrLog } = require('./team/recovery');
  const configPath = path.resolve(parsed.configPath);
  const output = dependencies.confirmOutput || process.stdout;
  const errorOutput = dependencies.errorOutput || process.stderr;
  const logger = dependencies.logger || stderrLog;
  const result = parsed.command === 'team-keygen'
    ? await createTeamHostKey({ configPath, output, logger })
    : await mintLocalOwnerInvite({
      kind: parsed.command === 'team-init' ? 'owner_first' : 'recovery',
      configPath, output, logger,
      acquireProfileImpl: dependencies.acquireProfileImpl, networkInterfaces: dependencies.networkInterfaces,
    });
  if (!result.ok) errorOutput.write(`${parsed.command} refused: ${result.reason}\n`);
  return result;
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) return { ok: true, help: usage() };
  if (TEAM_COMMANDS.has(parsed.command)) return runTeamCommand(parsed, dependencies);
  const config = (dependencies.loadHostConfigImpl || loadHostConfig)(path.resolve(parsed.configPath));
  if (parsed.command === 'import-conversations') {
    const pythonExecutable = parsed.pythonExecutable || config.pythonExecutable || '/opt/jenny-venv/bin/python';
    const lock = (dependencies.acquireProfileImpl || acquireProfile)({ userDataPath: config.userDataPath, pythonExecutable });
    let composition;
    try {
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

  return initializeOwner({
    ...dependencies,
    config,
    pythonExecutable: parsed.pythonExecutable,
  });
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
