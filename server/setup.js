'use strict';

const path = require('node:path');
const { loadHostConfig, normalizeHostConfig } = require('./config');
const { createPrompts } = require('./setup-prompts');
const { initializeOwner } = require('./cli');
const { AuthStore } = require('./auth-store');
const { FileSecretStore } = require('./file-secret-store');
const { acquireProfile } = require('../services/host/profile-ownership');
const { assertImportComplete } = require('../services/host/maintenance-commands');
const { readSetup, saveSetup, revokeBrowserSessionsForAccessChange } = require('../services/host/setup-config');
const { probeModels, probePrivateHttps, probeLocalHost } = require('../services/host/setup-model-probe');

const CONFIG_PATH = '/etc/jenny/host.json';
const COMPOSE = 'docker compose -p jenny-host -f compose.host.easy.yml';
const HELP = 'Usage: node server/setup.js [init | configure | doctor | status]';
const REASONS = Object.freeze({
  canonical_origin_invalid: 'Use the fixed localhost address or an HTTPS origin without a path, query or credentials.',
  browser_access_mode_invalid: 'Choose 1 for this computer or 2 for private HTTPS.',
  model_api_url_invalid: 'Enter the model server HTTP/HTTPS URL without credentials, a query or a fragment.',
  model_credentials_unavailable: 'not checked because the model credentials are unavailable or invalid',
  model_server_invalid: 'Choose 1 for Ollama or 2 for an OpenAI-compatible server.',
  endpoint_invalid: 'Enter a valid HTTP/HTTPS model URL without embedded credentials.',
  answer_yes_or_no: 'Answer yes or no, then rerun setup.',
  invalid_input: 'The input is too long or contains unsupported control characters.',
  invalid_model_key: 'The API key must be a single nonempty value of at most 1024 bytes.',
  unsupported_setup_marker: 'Setup metadata is unsupported. Preserve the volumes and use the Jenny version that created them.',
  config_json_invalid: 'The hosted configuration is invalid JSON. Preserve it and restore a known-good configuration before retrying.',
  config_unreadable: 'No readable hosted configuration was found. Run the setup launcher from an interactive terminal first.',
  interactive_terminal_required: 'Run setup from an interactive terminal. Passwords are never accepted in arguments or environment variables.',
  endpoint_unreachable: 'Cannot reach the model server from Docker. Use host.docker.internal for a server on this machine; check its private listener/firewall.',
  endpoint_timeout: 'The model server timed out. Check its address and whether it is running.',
  endpoint_auth_required: 'The model server requires a valid API key.',
  endpoint_http_error: 'The model listing endpoint returned an error. OpenAI-compatible URLs normally end in /v1.',
  endpoint_invalid_response: 'The endpoint did not return a supported model list.',
  endpoint_no_models: 'No installed models were found. Install a model through your model server, then rerun setup.',
  model_missing: 'Select one of the installed model numbers or enter its exact identifier.',
  setup_incomplete: 'Setup was interrupted. Stop Jenny and rerun the setup launcher to revalidate the settings and key.',
  config_schema_future: 'This configuration was created by a newer Jenny version. Use that version; do not overwrite it.',
  guided_volume_mismatch: 'This configuration uses custom paths. Keep using the manual Compose workflow.',
  AUTH_PASSWORD_INVALID: 'Use an owner password of at least 12 bytes and no more than 1024 bytes.',
  AUTH_PASSWORD_MISMATCH: 'The owner passwords did not match. Rerun setup; the model settings have been saved.',
  setup_cancelled: 'Setup cancelled. Existing conversations and login remain unchanged.',
});

function defaultSource() {
  return { schema_version: 2, host_mode: 'server', host_execution_policy_version: 1,
    browser_access_mode: 'localhost_http', execution: null,
    canonical_origin: 'http://127.0.0.1:8080', listen_host: '0.0.0.0', port: 8080,
    user_data_path: '/data', workspace_root: '/workspaces/default', secrets_dir: '/run/jenny-secrets',
    runtime_home: '/tmp/jenny-host-runtime', python_executable: '/opt/jenny-venv/bin/python',
    model_endpoint: { engine: 'ollama', model: 'pending-selection', api_url: 'http://host.docker.internal:11434' } };
}

function printAccess(config, say) {
  say('Jenny address: ' + config.canonicalOrigin);
  if (config.browserAccessMode === 'localhost_http') {
    say('Open this address on the Docker host computer and sign in. No Tailscale or HTTPS proxy is needed.');
  } else {
    say('Private HTTPS must forward to http://127.0.0.1:8080 and preserve the Host header.');
    if (new URL(config.canonicalOrigin).hostname.endsWith('.ts.net')) {
      say('Optional Tailscale Serve command on the Docker host:');
      say('  tailscale serve --bg http://127.0.0.1:8080');
    }
    say('Other devices need access to the private HTTPS address.');
  }
  if (config.execution) {
    say('Approved commands run offline in a disposable workspace copy (512 MiB).');
    say('Command output stays in the conversation. Command file changes are discarded; use file tools to save changes.');
  } else say('Command sandbox: disabled.');
  say('Diagnostics: ' + COMPOSE + ' run --rm --no-deps -T setup doctor');
  say('Logs: ' + COMPOSE + ' logs --tail 80 jenny');
  say('Stop (keep data): ' + COMPOSE + ' stop');
}

async function chooseSettings(previous, prompts, { probeModelsImpl = probeModels, template = defaultSource() } = {}) {
  const source = previous.source ? structuredClone(previous.source) : structuredClone(template);
  const priorMode = previous.source?.browser_access_mode || (previous.source ? 'private_https' : 'localhost_http');
  const access = await prompts.ask('Browser access: 1 = this computer, 2 = private HTTPS', priorMode === 'localhost_http' ? '1' : '2');
  if (!['1', '2'].includes(access)) throw new Error('browser_access_mode_invalid');
  source.schema_version = 2;
  source.browser_access_mode = access === '1' ? 'localhost_http' : 'private_https';
  source.canonical_origin = access === '1' ? 'http://127.0.0.1:8080'
    : await prompts.ask('Private HTTPS address', priorMode === 'private_https' ? previous.source?.canonical_origin || '' : '');
  if (previous.source && (priorMode !== source.browser_access_mode
    || previous.source.canonical_origin !== source.canonical_origin)) {
    if (!await prompts.yes('Changing browser access signs out all browsers. Continue', false)) throw new Error('setup_cancelled');
  }
  const engine = await prompts.ask('Model server: 1 = Ollama, 2 = OpenAI-compatible', source.model_endpoint.engine === 'ollama' ? '1' : '2');
  if (!['1', '2'].includes(engine)) throw new Error('model_server_invalid');
  const nextEngine = engine === '1' ? 'ollama' : 'openai-compatible';
  const urlDefault = nextEngine === source.model_endpoint.engine ? source.model_endpoint.api_url
    : nextEngine === 'ollama' ? 'http://host.docker.internal:11434' : 'http://host.docker.internal:1234/v1';
  const apiUrl = await prompts.ask('Model server URL as reached from Docker', urlDefault);
  const sameEndpoint = nextEngine === previous.source?.model_endpoint.engine && apiUrl === previous.source?.model_endpoint.api_url;
  source.model_endpoint = { engine: nextEngine, api_url: apiUrl, model: source.model_endpoint.model };
  // Validate before making a request or soliciting a key.
  const candidate = normalizeHostConfig(source);
  let apiKey = null;
  if (nextEngine === 'openai-compatible') {
    const reuse = sameEndpoint && previous.apiKey && !previous.pending
      && await prompts.yes('Keep the existing model API key', true);
    if (reuse) apiKey = previous.apiKey;
    else if (await prompts.yes('Does this model server require an API key')) apiKey = await prompts.secret('Model API key (hidden): ');
  }
  const result = await probeModelsImpl(candidate.modelEndpoint, { apiKey: apiKey || '' });
  if (!result.ok) throw new Error(result.reason);
  prompts.say('Installed models:');
  result.models.forEach((model, index) => prompts.say('  ' + (index + 1) + '. ' + model));
  const oldModel = result.models.includes(source.model_endpoint.model) ? source.model_endpoint.model : '1';
  const selected = await prompts.ask('Model number or exact identifier', oldModel);
  const numeric = /^[1-9][0-9]*$/u.test(selected) ? Number(selected) - 1 : -1;
  const model = result.models.includes(selected) ? selected : result.models[numeric];
  if (!model) throw new Error('model_missing');
  source.model_endpoint.model = model;
  source.workspace_root = await prompts.yes('Enable typed file tools in Jennyâ€™s private workspace', source.workspace_root !== null)
    ? template.workspace_root : null;
  const sandbox = source.workspace_root !== null && await prompts.yes(
    'Enable approved commands in the offline disposable sandbox', previous.source ? Boolean(previous.source.execution) : true);
  source.execution = sandbox ? { mode: 'offline-copy' } : null;
  source.host_execution_policy_version = sandbox ? 2 : 1;
  normalizeHostConfig(source);
  prompts.say('Settings are ready. Your conversations and existing owner password will be preserved.');
  return { source, apiKey };
}

async function configure(command, {
  configPath = CONFIG_PATH, prompts = createPrompts(), template = defaultSource(),
  acquireProfileImpl = acquireProfile, initializeOwnerImpl = initializeOwner,
  probeModelsImpl = probeModels, saveSetupImpl = saveSetup,
} = {}) {
  const lock = acquireProfileImpl({ userDataPath: template.user_data_path,
    pythonExecutable: template.python_executable });
  try {
    assertImportComplete(template.user_data_path);
    const previous = readSetup(configPath);
    if (previous.source && (previous.source.user_data_path !== template.user_data_path
      || previous.source.secrets_dir !== template.secrets_dir)) {
      throw new Error('guided_volume_mismatch');
    }
    if (previous.pending) prompts.say(REASONS.setup_incomplete);
    if (previous.source && !previous.pending && command === 'init') prompts.say('Keeping the existing configuration.');
    else {
      const { source, apiKey } = await chooseSettings(previous, prompts, { template, probeModelsImpl });
      if (source.user_data_path !== template.user_data_path || source.secrets_dir !== template.secrets_dir) {
        throw new Error('This guided setup only manages its dedicated profile and secret volumes.');
      }
      await revokeBrowserSessionsForAccessChange(previous.source, source);
      saveSetupImpl(configPath, source, apiKey);
    }
    const config = loadHostConfig(configPath);
    prompts.say('Create the Jenny owner password if this is your first setup (at least 12 bytes).');
    const result = await initializeOwnerImpl({ config, acquireProfileImpl: () => ({ release() {} }),
      readPasswordImpl: (options) => prompts.secret(options.prompt),
      output: { write: (text) => prompts.say(text.trimEnd()) },
      confirmOutput: { write: (text) => prompts.say(text.trimEnd()) } });
    if (!result.ok && result.code !== 'AUTH_ALREADY_INITIALIZED') throw new Error(result.code || 'owner_initialization_failed');
    printAccess(config, prompts.say);
    return { ok: true };
  } finally { lock.release(); }
}

async function doctor({ configPath = CONFIG_PATH, say = console.log,
  probeModelsImpl = probeModels, probePrivateHttpsImpl = probePrivateHttps,
  probeLocalHostImpl = probeLocalHost, probeWorkerImpl = null } = {}) {
  const config = loadHostConfig(configPath);
  say('Configuration: valid');
  let owner = false;
  try {
    owner = new AuthStore({ filePath: path.join(config.userDataPath, 'auth.json') }).isConfigured();
    say('Owner login: ' + (owner ? 'initialized' : 'missing; rerun setup'));
  } catch (_error) { say('Owner login: unavailable or invalid; preserve the profile and restore valid owner state'); }
  let key = null;
  let keyReady = true;
  try {
    if (config.modelEndpoint.engine === 'openai-compatible') {
      key = new FileSecretStore({ directory: config.secretsDir }).get('openai_compatible_api_key');
    }
  } catch (_error) {
    keyReady = false;
    say('Model credentials: unavailable or invalid; stop Jenny and reconfigure the key');
  }
  const models = keyReady ? await probeModelsImpl(config.modelEndpoint, { apiKey: key || '' })
    : { ok: false, reason: 'model_credentials_unavailable' };
  const modelReady = models.ok && models.models.includes(config.modelEndpoint.model);
  say('Model: ' + (modelReady ? 'listed by the endpoint (generation has not been tested)'
    : REASONS[models.reason || 'model_missing'] || 'unavailable'));
  const local = config.browserAccessMode === 'localhost_http';
  const accessReady = local ? await probeLocalHostImpl(config) : await probePrivateHttpsImpl(config.canonicalOrigin);
  say((local ? 'Localhost service: ' : 'Private HTTPS: ') + (accessReady ? 'Jenny health response received'
    : local ? 'not reachable from the setup container; check Jenny logs' : 'not reachable from this container; check DNS and the HTTPS proxy'));
  let workerReady = true;
  if (config.execution) {
    try {
      const probe = probeWorkerImpl || require('../services/host/worker-transport').requestWorker;
      const status = await probe('status');
      workerReady = ['ready', 'running'].includes(status.phase);
      say('Command sandbox: ' + (workerReady ? status.phase : 'recycling; retry in a few seconds'));
    } catch (_error) { workerReady = false; say('Command sandbox: unavailable; inspect sandbox container logs'); }
  }
  printAccess(config, say);
  return { ok: owner && keyReady && modelReady && accessReady && workerReady };
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
  const command = argv[0] || 'init';
  if (argv.length > 1 || !['init', 'configure', 'doctor', 'status', '--help', '-h'].includes(command)) throw new Error(HELP);
  if (['--help', '-h'].includes(command)) { (dependencies.say || console.log)(HELP); return { ok: true }; }
  if (command === 'status') {
    printAccess(loadHostConfig(dependencies.configPath || CONFIG_PATH), dependencies.say || console.log);
    return { ok: true };
  }
  if (command === 'doctor') return doctor(dependencies);
  return configure(command, dependencies);
}

if (require.main === module) {
  run().then((result) => { process.exitCode = result.ok ? 0 : 1; }).catch((error) => {
    // Never print arbitrary provider responses, paths or exception causes.
    const reason = error.reason || error.message;
    console.error(REASONS[reason] || 'Setup could not finish. Check Docker, stop Jenny before configuring, and run doctor. Existing data was retained.');
    process.exitCode = 1;
  });
}

module.exports = { configure, chooseSettings, doctor, run, defaultSource, printAccess };
