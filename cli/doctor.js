'use strict';

// `jenny doctor`: the checks a failed run would otherwise leave the caller to
// guess at. Read-only except for the profile directory it may create and the
// lock it takes and releases to prove the profile is free.

const fs = require('node:fs');
const path = require('node:path');
const { acquireCliProfile, CLI_PROFILE_ERROR_CODES } = require('../services/cli-host/profile-lock');
const { lockOptions, resolveCliRuntime } = require('../services/cli-host/runtime-layout');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { CLI_CONTRACT, CLI_VERSION } = require('./exit-codes');

const ROOT = path.resolve(__dirname, '..');
const MIN_NODE_MAJOR = 20;

function check(name, ok, detail) {
  return { name, ok: ok === true, detail: String(detail || '') };
}

// The source route needs an interpreter and the sidecar package; the installed
// route needs a packaged binary the desktop's resolver accepts (manifest,
// platform, sha256 and the `--version` probe).
async function sidecarChecks(runtime) {
  if (runtime.mode === 'packaged') {
    let launch;
    try { launch = await runtime.resolvePackagedLaunch(); } catch (error) { launch = { ok: false, failureReason: error?.message }; }
    const ok = launch?.ok === true;
    return [check('sidecar_binary', ok, ok ? launch.launchCommand
      : (launch?.failureReason || launch?.packagedLaunchDetail || 'The packaged sidecar could not be resolved.'))];
  }
  const python = runtime.pythonExecutable;
  return [
    check('sidecar_python', Boolean(python) && fs.existsSync(python),
      python || 'not found: set JENNY_BACKEND_PYTHON or create the repository .venv'),
    check('sidecar_module', fs.existsSync(path.join(runtime.root, 'sidecar', '__main__.py')), path.join(runtime.root, 'sidecar')),
  ];
}

async function runDoctor({ settings, env = process.env, appVersion = '', runtime = resolveCliRuntime({ root: ROOT, env }) }) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check('node', nodeMajor >= MIN_NODE_MAJOR, `node ${process.versions.node} (needs ${MIN_NODE_MAJOR}+)`));
  checks.push(check('versions', true, `jenny-cli ${CLI_VERSION}, contract ${CLI_CONTRACT}, app ${appVersion || 'unknown'}, sidecar api ${API_VERSION}`));
  checks.push(check('runtime', true, runtime.mode === 'packaged' ? `packaged ${runtime.resourcesPath}` : `source ${runtime.root}`));
  checks.push(...await sidecarChecks(runtime));

  let workspaceOk;
  try { workspaceOk = fs.statSync(settings.workspaceRoot).isDirectory(); } catch (_error) { workspaceOk = false; }
  checks.push(check('workspace', workspaceOk, settings.workspaceRoot));

  let profileDetail;
  let profileOk = false;
  try {
    fs.mkdirSync(settings.profilePath, { recursive: true });
    const held = await acquireCliProfile({ userDataPath: settings.profilePath, ...lockOptions(runtime) });
    held.release();
    profileOk = true;
    profileDetail = `${held.directory} (free, ${held.kind} lock)`;
  } catch (error) {
    profileDetail = error?.code === CLI_PROFILE_ERROR_CODES.BUSY
      ? `${settings.profilePath} (busy: another Jenny CLI holds it)`
      : `${settings.profilePath} (${error?.reason || error?.message || 'unavailable'})`;
  }
  checks.push(check('profile', profileOk, profileDetail));

  checks.push(check('engine', true, `${settings.engine}${settings.model ? ` / ${settings.model}` : ' (model chosen by the engine)'}`));
  checks.push(check('permissions', true, `${settings.permissionMode}; allowed ${settings.allowedTools.join(', ') || '(none)'}; disallowed ${settings.disallowedTools.join(', ') || '(none)'}`));
  return { ok: checks.every((entry) => entry.ok), checks };
}

function formatDoctor(report, { json = false } = {}) {
  if (json) return JSON.stringify({ v: 1, kind: 'doctor', ok: report.ok, checks: report.checks });
  return report.checks.map((entry) => `${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name.padEnd(16)} ${entry.detail}`).join('\n');
}

module.exports = { formatDoctor, runDoctor };
