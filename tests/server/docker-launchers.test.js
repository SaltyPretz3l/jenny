'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const SH_LAUNCHER = path.join(ROOT, 'docker-setup.sh');
const PS_LAUNCHER = path.join(ROOT, 'docker-setup.ps1');
const COMPOSE = path.join(ROOT, 'compose.host.easy.yml');

test('manual and guided Compose retain the policy 2 health gate before launcher overrides', () => {
  const easy = yaml.load(fs.readFileSync(COMPOSE, 'utf8'));
  const manual = yaml.load(fs.readFileSync(path.join(ROOT, 'compose.host.yml'), 'utf8'));
  assert.equal(easy.services.jenny.extends.service, 'jenny');
  assert.equal(easy.services.jenny.extends.file, 'compose.host.yml');
  assert.equal(easy.services.sandbox.profiles, undefined);
  assert.equal(manual.services.jenny.depends_on.sandbox.condition, 'service_healthy');
  assert.equal(manual.services.sandbox.profiles, undefined);
});

const STUB = String.raw`
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.JENNY_DOCKER_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + '\n');
const compose = args[0] === 'compose';
const command = compose ? ['ps', 'build', 'up', 'run', 'logs'].find((candidate) => args.includes(candidate)) || '' : '';
const fail = process.env.JENNY_DOCKER_FAIL;
if (compose && args[1] === 'version') {
  if (fail === 'version') { console.error('fixture version failure'); process.exit(19); }
  console.log(process.env.JENNY_COMPOSE_VERSION || 'v2.24.4');
  process.exit(0);
}
if (!compose && args[0] === 'info') {
  if (fail === 'info') { console.error('fixture daemon failure'); process.exit(20); }
  console.log(process.env.JENNY_DAEMON_OS || 'linux');
  process.exit(0);
}
if (!compose) process.exit(2);
if (command === 'ps') {
  if (fail === 'ps') process.exit(1);
  if (process.env.JENNY_RUNNING === '1') console.log('jenny');
  process.exit(0);
}
if (command === 'up' && args.includes('-')) {
  fs.writeFileSync(log + '.override.yml', fs.readFileSync(0, 'utf8'));
}
const commandIndex = args.indexOf('setup');
const operation = commandIndex >= 0 ? args[commandIndex + 1] : command;
if (args.includes('--entrypoint') && args.includes('-e')) {
  if (fail === 'policy') process.exit(22);
  console.log(process.env.JENNY_EXECUTION_POLICY || '1');
  process.exit(0);
}
if (fail && operation === fail) process.exit(22);
if (operation === 'doctor' || operation === 'status' || operation === 'init' || operation === 'configure') {
  console.log(operation + ' ok');
}
process.exit(0);
`;

function makeFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny docker launcher '));
  fs.copyFileSync(COMPOSE, path.join(fixture, 'compose.host.easy.yml'));
  fs.copyFileSync(SH_LAUNCHER, path.join(fixture, 'docker-setup.sh'));
  fs.copyFileSync(PS_LAUNCHER, path.join(fixture, 'docker-setup.ps1'));
  const stubSource = path.join(fixture, 'docker-stub.js');
  fs.writeFileSync(stubSource, STUB, 'utf8');
  const stub = path.join(fixture, process.platform === 'win32' ? 'docker.cmd' : 'docker');
  if (process.platform === 'win32') {
    fs.writeFileSync(stub, '@echo off\r\nnode "%~dp0docker-stub.js" %*\r\n', 'utf8');
    fs.writeFileSync(path.join(fixture, 'docker'), `#!/bin/bash\nnode '${stubSource.replace(/\\/gu, '/')}' "$@"\n`, 'utf8');
  } else {
    fs.writeFileSync(stub, `#!/usr/bin/env node\nrequire(${JSON.stringify(stubSource)});\n`, 'utf8');
    fs.chmodSync(stub, 0o755);
  }
  const log = path.join(fixture, 'docker-argv.jsonl');
  const env = {
    ...process.env,
    JENNY_DOCKER_LOG: log,
    PATH: `${fixture}${path.delimiter}${process.env.PATH || ''}`,
  };
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  return { fixture, log, env, stub };
}

function readCalls(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function runBash(fixture, args, env) {
  return spawnSync(bashExecutable(), [path.join(fixture, 'docker-setup.sh'), ...args], {
    cwd: fixture, env, encoding: 'utf8', windowsHide: true,
  });
}

function bashExecutable() {
  if (process.env.BASH_EXE) return process.env.BASH_EXE;
  if (process.platform === 'win32') {
    // The Windows fixture and Node stub need native Git Bash, not WSL's
    // bash.exe. Git's cmd directory is normally the only Git entry on PATH.
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      if (!fs.existsSync(path.join(directory, 'git.exe'))) continue;
      for (const candidate of [path.join(directory, 'bash.exe'), path.resolve(directory, '..', 'bin', 'bash.exe')]) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return process.platform === 'win32' ? 'bash' : '/bin/bash';
}

function runPowerShell(fixture, args, env) {
  const executable = powershellExecutable();
  return spawnSync(executable, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixture, 'docker-setup.ps1'), ...args,
  ], { cwd: fixture, env, encoding: 'utf8', windowsHide: true });
}

function powershellExecutable() {
  if (process.env.POWERSHELL_EXE) return process.env.POWERSHELL_EXE;
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  // Resolve before tests remove PATH to simulate a missing Docker installation.
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, 'pwsh');
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return 'pwsh';
}

function runBashInteractive(fixture, args, env) {
  return spawnSync('script', ['-qefc', `${bashExecutable()} ./docker-setup.sh${args.length ? ` ${args.join(' ')}` : ''}`, os.devNull], {
    cwd: fixture, env, encoding: 'utf8', windowsHide: true,
  });
}

function bashAvailable() {
  // Windows bash.exe may launch WSL, where Windows fixture paths and .cmd
  // shims do not apply. Exercise this lane in Linux (including its real PTY).
  if (process.platform === 'win32') return false;
  const result = spawnSync(bashExecutable(), ['-c', 'exit 0'], { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}

function startupBashAvailable() {
  const result = spawnSync(bashExecutable(), ['-c', 'exit 0'], { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}

function runWithTerminal(fixture, label, args, env) {
  // Mock only the console prerequisite; Docker remains a recording stub.
  const filename = path.join(fixture, label === 'Bash' ? 'docker-setup.sh' : 'docker-setup.ps1');
  const source = fs.readFileSync(filename, 'utf8');
  fs.writeFileSync(filename, label === 'Bash'
    ? source.replace('require_interactive() {', 'require_interactive() { return 0;')
    : source.replace('function Test-InteractiveTerminal {', 'function Test-InteractiveTerminal { return $true;'), 'utf8');
  return (label === 'Bash' ? runBash : runPowerShell)(fixture, args, env);
}

for (const label of ['Bash', 'PowerShell']) {
  for (const policy of [1, 2]) {
    test(`${label} startup selects the saved execution policy ${policy}`, {
      skip: label === 'Bash' ? !startupBashAvailable() : !powershellAvailable(),
    }, (t) => {
      const { fixture, log, env } = makeFixture(t);
      const result = runWithTerminal(fixture, label, [], { ...env, JENNY_EXECUTION_POLICY: String(policy) });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      const calls = readCalls(log);
      const probe = calls.find((args) => args.includes('--entrypoint'));
      assert.ok(probe, 'saved policy is read from the configured setup volume before startup');
      const up = calls.find((args) => args.includes('up'));
      assert.ok(up);
      assert.equal(up.includes('--profile'), false);
      assert.equal(up.filter((arg) => arg === '-f').length, policy === 1 ? 2 : 1,
        'only policy 1 removes the mandatory health dependency');
      assert.deepEqual(up.slice(up.indexOf('up')), ['up', '--wait', '--wait-timeout', '120', '-d', 'jenny']);
      assert.ok(calls.indexOf(probe) < calls.indexOf(up));
      if (policy === 1) {
        const reset = new yaml.Type('!reset', { kind: 'mapping', construct: () => ({}) });
        const override = yaml.load(fs.readFileSync(`${log}.override.yml`, 'utf8'), {
          schema: yaml.DEFAULT_SCHEMA.extend([reset]),
        });
        assert.deepEqual(override, {
          services: { jenny: { depends_on: {} }, sandbox: { profiles: ['execution'] } },
        });
      }
    });
  }
  test(`${label} refuses startup when the saved policy probe fails or is invalid`, {
    skip: label === 'Bash' ? !startupBashAvailable() : !powershellAvailable(),
  }, (t) => {
    for (const setting of [{ JENNY_DOCKER_FAIL: 'policy' }, { JENNY_EXECUTION_POLICY: 'unexpected' }]) {
      const { fixture, log, env } = makeFixture(t);
      const result = runWithTerminal(fixture, label, [], { ...env, ...setting });
      assert.notEqual(result.status, 0);
      assert.equal(readCalls(log).some((args) => args.includes('up')), false);
    }
  });
  test(`${label} policy 2 startup preserves a worker health failure`, {
    skip: label === 'Bash' ? !startupBashAvailable() : !powershellAvailable(),
  }, (t) => {
    const { fixture, log, env } = makeFixture(t);
    const result = runWithTerminal(fixture, label, ['configure'], {
      ...env, JENNY_EXECUTION_POLICY: '2', JENNY_DOCKER_FAIL: 'up',
    });
    assert.equal(result.status, 22);
    assert.match(`${result.stdout}${result.stderr}`, /start failed \(exit 22\)/u);
    assert.equal(readCalls(log).some((args) => args.at(-1) === 'status'), false);
  });
}

function powershellAvailable() {
  const executable = powershellExecutable();
  const result = spawnSync(executable, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}

function bashPtyAvailable() {
  if (!bashAvailable()) return false;
  const result = spawnSync('script', ['-qefc', 'exit 0', os.devNull], {
    encoding: 'utf8', windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function assertNoDestructiveLauncherText(source) {
  assert.doesNotMatch(source, /docker\.sock|--privileged|\bdown\b|volume\s+(rm|prune)|tailscale\s+(serve|funnel)/iu);
  assert.doesNotMatch(source, /Invoke-Expression|\beval\s*\(/u);
  assert.match(source, /compose[^\n]+--project-directory/u);
  assert.match(source, /compose\.host\.easy\.yml/u);
}

test('Docker launchers use a fixed, non-destructive command surface', () => {
  assertNoDestructiveLauncherText(fs.readFileSync(SH_LAUNCHER, 'utf8'));
  assertNoDestructiveLauncherText(fs.readFileSync(PS_LAUNCHER, 'utf8'));
});

test('Bash launcher help and unknown flags work when Bash is executable', { skip: !bashAvailable() }, (t) => {
  const { fixture, env } = makeFixture(t);
  const help = runBash(fixture, ['--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Jenny Docker setup/u);
  const unknown = runBash(fixture, ['--not-a-command'], env);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/u);
});

test('PowerShell launcher help and unknown flags work on Windows PowerShell 5.1+', { skip: !powershellAvailable() }, (t) => {
  const { fixture, env } = makeFixture(t);
  const help = runPowerShell(fixture, ['--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Jenny Docker setup/u);
  const unknown = runPowerShell(fixture, ['--not-a-command'], env);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command/u);
});

for (const [label, run] of [
  ['Bash', runBash],
  ['PowerShell', runPowerShell],
]) {
  test(`${label} doctor is read only and preserves Docker preflight failures`, { skip: label === 'Bash' ? !bashAvailable() : !powershellAvailable() }, (t) => {
    const { fixture, log, env, stub } = makeFixture(t);
    const doctor = run(fixture, ['doctor'], env);
    assert.equal(doctor.status, 0, doctor.stderr);
    const calls = readCalls(log);
    const operation = (args) => {
      if (args[0] === 'info') return 'info';
      const fileIndex = args.indexOf('-f');
      if (fileIndex >= 0) {
        return ['ps', 'build', 'up', 'run', 'logs'].find((candidate) => args.includes(candidate)) || '';
      }
      return args[1];
    };
    assert.deepEqual(calls.map(operation), ['version', 'info', 'run']);
    assert.equal(calls[2][2], fixture, 'repo path stays one argv entry even when it contains spaces');
    assert.equal(calls[2][4], path.join(fixture, 'compose.host.easy.yml'));
    assert.deepEqual(calls[2].slice(5, 7), ['--project-name', 'jenny-host']);
    assert.deepEqual(calls[2].slice(7), ['run', '--rm', '--no-deps', '-T', 'setup', 'doctor']);
    assert.equal(calls.some((args) => args.includes('build')), false);
    assert.equal(calls.some((args) => args.includes('up')), false);
    assert.equal(calls.some((args) => args.includes('down')), false);
    assert.match(doctor.stdout, /doctor ok/u);

    const oldCompose = { ...env, JENNY_COMPOSE_VERSION: 'v2.24.3' };
    const unsupported = run(fixture, ['doctor'], oldCompose);
    assert.equal(unsupported.status, 10);
    assert.match(unsupported.stderr, /Compose 2\.24\.4 or newer/u);
    assert.equal(readCalls(log).length, calls.length + 1);
    const newerMajor = run(fixture, ['doctor'], { ...env, JENNY_COMPOSE_VERSION: 'v3.0.0' });
    assert.equal(newerMajor.status, 0, newerMajor.stderr);
    const windowsDaemon = { ...env, JENNY_DAEMON_OS: 'windows' };
    const wrongDaemon = run(fixture, ['doctor'], windowsDaemon);
    assert.equal(wrongDaemon.status, 10);
    assert.match(wrongDaemon.stderr, /Linux Docker daemon/u);
    for (const failedProbe of ['version', 'info']) {
      const failure = run(fixture, ['doctor'], { ...env, JENNY_DOCKER_FAIL: failedProbe });
      assert.equal(failure.status, 10, failure.stderr);
      assert.match(failure.stderr, failedProbe === 'info' ? /Docker daemon is unavailable/u : /Compose 2\.24\.4 or newer/u);
    }
    const hiddenStub = `${stub}.disabled`;
    fs.renameSync(stub, hiddenStub);
    let noDocker;
    try {
      noDocker = run(fixture, ['doctor'], { ...env, PATH: path.join(fixture, 'missing') });
    } finally {
      fs.renameSync(hiddenStub, stub);
    }
    assert.equal(noDocker.status, 10, `${noDocker.error || ''}${noDocker.stderr || ''}`);
    assert.match(noDocker.stderr, /Docker CLI was not found/u);
  });
}

test('Bash PTY exercises stopped, running, configure, and failure paths when script(1) is available', { skip: !bashPtyAvailable() }, (t) => {
  const operation = (args) => {
    if (args[0] === 'info') return 'info';
    const fileIndex = args.indexOf('-f');
    return fileIndex >= 0
      ? ['ps', 'build', 'up', 'run', 'logs'].find((candidate) => args.includes(candidate)) || ''
      : args[1];
  };
  const { fixture, log, env } = makeFixture(t);
  const stopped = runBashInteractive(fixture, [], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  const stoppedCalls = readCalls(log);
  assert.deepEqual(stoppedCalls.map(operation), ['version', 'info', 'ps', 'build', 'run', 'run', 'up', 'run']);
  assert.equal(stoppedCalls[4].at(-1), 'init');
  assert.equal(stoppedCalls[7].at(-1), 'status');

  fs.writeFileSync(log, '', 'utf8');
  const running = runBashInteractive(fixture, [], { ...env, JENNY_RUNNING: '1' });
  assert.equal(running.status, 0, running.stderr);
  const runningCalls = readCalls(log);
  assert.deepEqual(runningCalls.map(operation), ['version', 'info', 'ps', 'run']);
  assert.equal(runningCalls[3].at(-1), 'doctor');
  assert.match(running.stdout, /already running/u);
  assert.doesNotMatch(running.stdout, /build jenny/u);

  fs.writeFileSync(log, '', 'utf8');
  const configured = runBashInteractive(fixture, ['configure'], env);
  assert.equal(configured.status, 0, configured.stderr);
  const configuredCalls = readCalls(log);
  assert.deepEqual(configuredCalls.map(operation), ['version', 'info', 'ps', 'build', 'run', 'run', 'up', 'run']);
  assert.equal(configuredCalls[4].at(-1), 'configure');

  fs.writeFileSync(log, '', 'utf8');
  const busy = runBashInteractive(fixture, ['configure'], { ...env, JENNY_RUNNING: '1' });
  assert.equal(busy.status, 11);
  const busyCalls = readCalls(log);
  assert.deepEqual(busyCalls.map(operation), ['version', 'info', 'ps']);
  assert.match(`${busy.stdout}${busy.stderr}`, /requires a stopped host/u);

  fs.writeFileSync(log, '', 'utf8');
  const failedProbe = runBashInteractive(fixture, [], { ...env, JENNY_DOCKER_FAIL: 'ps' });
  assert.equal(failedProbe.status, 1);
  assert.deepEqual(readCalls(log).map(operation), ['version', 'info', 'ps']);
  fs.writeFileSync(log, '', 'utf8');
  const failed = runBashInteractive(fixture, [], { ...env, JENNY_DOCKER_FAIL: 'build' });
  assert.equal(failed.status, 22);
  const failedCalls = readCalls(log);
  assert.deepEqual(failedCalls.map(operation), ['version', 'info', 'ps', 'build']);
  assert.match(`${failed.stdout}${failed.stderr}`, /Diagnosis:.*doctor/u);
});

test('launchers reject setup without a terminal before invoking Docker', { skip: !bashAvailable() && !powershellAvailable() }, (t) => {
  const { fixture, log, env } = makeFixture(t);
  if (bashAvailable()) {
    const result = runBash(fixture, [], env);
    assert.equal(result.status, 11);
    assert.match(result.stderr, /interactive terminal/u);
  }
  if (powershellAvailable()) {
    const result = runPowerShell(fixture, [], env);
    assert.equal(result.status, 11);
    assert.match(result.stderr, /interactive terminal/u);
  }
  assert.deepEqual(readCalls(log), []);
});

test('launcher source contains explicit setup/configure and running-host no-op paths', () => {
  const bash = fs.readFileSync(SH_LAUNCHER, 'utf8');
  const powershell = fs.readFileSync(PS_LAUNCHER, 'utf8');
  for (const source of [bash, powershell]) {
    assert.match(source, /already running/u);
    assert.match(source, /no build or restart/u);
    assert.match(source, /build[\s'",]+jenny/u);
    assert.match(source, /setup[\s'",]+(?:init|configure)/u);
    assert.match(source, /--wait(?:-timeout)?/u);
    assert.match(source, /--no-deps/u);
  }
});
