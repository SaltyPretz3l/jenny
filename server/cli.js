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

function usage() {
  return 'Usage: node server/cli.js (owner-init | import-conversations --archive /backup/jenny.archive) --config /etc/jenny/host.json';
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
    if (value === 'owner-init' || value === 'import-conversations') {
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
  if (!command) throw new Error('The owner-init command is required.');
  if (!configPath) throw new Error('The --config path is required.');
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

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) return { ok: true, help: usage() };
  const config = (dependencies.loadHostConfigImpl || loadHostConfig)(path.resolve(parsed.configPath));
  if (parsed.command === 'import-conversations') {
    const pythonExecutable = parsed.pythonExecutable || config.pythonExecutable || '/opt/jenny-venv/bin/python';
    const lock = (dependencies.acquireProfileImpl || acquireProfile)({ userDataPath: config.userDataPath, pythonExecutable });
    let composition;
    try {
      assertImportComplete(config.userDataPath);
      const passphrase = await (dependencies.readPasswordImpl || readPassword)({ prompt: 'Archive passphrase (blank for unencrypted): ' });
      composition = createHostedBackend({ ...config, pythonExecutable, repoRoot: path.resolve(__dirname, '..'),
        credentialService: new FileSecretStore({ directory: config.secretsDir }) });
      const result = await importConversations({ backend: composition.backend, userDataPath: config.userDataPath,
        archivePath: path.resolve(parsed.archivePath), passphrase });
      (dependencies.confirmOutput || process.stdout).write(`${JSON.stringify(result)}\n`);
      return result;
    } finally { try { composition?.dispose(); } finally { lock.release(); } }
  }

  return initializeOwner({
    ...dependencies,
    config,
    pythonExecutable: parsed.pythonExecutable,
  });
}

async function main() {
  try {
    const result = await runCli();
    if (result.help) process.stdout.write(`${result.help}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error?.message || 'Hosted CLI failed.'}\n${usage()}\n`);
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
