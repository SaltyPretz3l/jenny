'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  detectOllama,
  modelExists,
  installPlan,
  ensureServing,
  pullModel,
  ollamaInstallDirs,
  ollamaBinaryPath,
} = require('../../scripts/setup/ollama-step');

function okFetch(version) {
  return async () => ({ ok: true, json: async () => ({ version }) });
}
function downFetch() {
  return async () => ({ ok: false });
}

test('detectOllama reports running when the daemon answers /api/version', async () => {
  const result = await detectOllama({ fetchImpl: okFetch('0.30.10'), run: () => ({ status: 1 }) });
  assert.equal(result.installed, true);
  assert.equal(result.running, true);
  assert.equal(result.version, '0.30.10');
  assert.equal(result.versionSupported, true);
  assert.equal(result.minimumVersion, '0.30.10');
});

test('detectOllama falls back to PATH when the daemon is down but installed', async () => {
  const result = await detectOllama({
    fetchImpl: downFetch(),
    run: (cmd) => ({ status: 0, stdout: cmd === 'where' || cmd === 'which' ? '/usr/local/bin/ollama\n' : '' }),
  });
  assert.equal(result.installed, true);
  assert.equal(result.running, false);
});

test('detectOllama reports not-installed when neither the port nor PATH resolves', async () => {
  // Pin fileExists/env so this is hermetic on machines that happen to have a
  // real Ollama install at the well-known winget path (the absolute-path
  // fallback is exercised separately below).
  const result = await detectOllama({
    fetchImpl: downFetch(),
    run: () => ({ status: 1, stdout: '' }),
    fileExists: () => false,
  });
  assert.equal(result.installed, false);
  assert.equal(result.running, false);
});

test('ollamaInstallDirs lists the LOCALAPPDATA and Program Files candidates on win32', () => {
  const dirs = ollamaInstallDirs('win32', {
    LOCALAPPDATA: 'C:/Users/x/AppData/Local',
    ProgramFiles: 'C:/Program Files',
  });
  assert.ok(dirs.some((dir) => /Programs[\\/]Ollama$/.test(dir)), 'should include the LOCALAPPDATA Programs/Ollama dir');
  assert.ok(dirs.some((dir) => /Program Files[\\/]Ollama$/.test(dir)), 'should include the Program Files/Ollama dir');
});

test('ollamaInstallDirs returns nothing on non-win32 platforms', () => {
  assert.deepEqual(ollamaInstallDirs('darwin', { LOCALAPPDATA: 'C:/Users/x/AppData/Local' }), []);
  assert.deepEqual(ollamaInstallDirs('linux', {}), []);
});

test('ollamaBinaryPath returns the candidate when it exists on disk', () => {
  const env = { LOCALAPPDATA: 'C:/Users/x/AppData/Local', ProgramFiles: 'C:/Program Files' };
  const result = ollamaBinaryPath('win32', env, (candidate) => /Programs[\\/]Ollama[\\/]ollama\.exe$/.test(candidate));
  assert.match(result, /Programs[\\/]Ollama[\\/]ollama\.exe$/);
});

test('ollamaBinaryPath returns empty string when no candidate exists', () => {
  const env = { LOCALAPPDATA: 'C:/Users/x/AppData/Local', ProgramFiles: 'C:/Program Files' };
  const result = ollamaBinaryPath('win32', env, () => false);
  assert.equal(result, '');
});

test('detectOllama falls back to the known absolute install path when PATH probe fails', async () => {
  const result = await detectOllama({
    fetchImpl: downFetch(),
    run: () => ({ status: 1, stdout: '' }),
    fileExists: () => true,
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local', ProgramFiles: 'C:/Program Files' },
  });
  assert.equal(result.installed, true);
  assert.equal(result.running, false);
});

test('detectOllama stays not-installed when the absolute install path also does not exist', async () => {
  const result = await detectOllama({
    fetchImpl: downFetch(),
    run: () => ({ status: 1, stdout: '' }),
    fileExists: () => false,
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local', ProgramFiles: 'C:/Program Files' },
  });
  assert.equal(result.installed, false);
  assert.equal(result.running, false);
});

test('modelExists keys off the ollama show exit code', () => {
  assert.equal(modelExists('ornith:9b', { run: () => ({ status: 0 }) }), true);
  assert.equal(modelExists('ornith:9b', { run: () => ({ status: 1 }) }), false);
});

test('installPlan is platform-specific', () => {
  assert.equal(installPlan('win32').manager, 'winget');
  assert.equal(installPlan('darwin').manager, 'brew');
  assert.match(installPlan('darwin').manualUrl, /ollama\.com/);
  assert.equal(installPlan('linux').command, null);
  assert.equal(installPlan('win32', { upgrade: true }).command[1][0], 'upgrade');
});

test('detectOllama marks an older running server as upgrade-required', async () => {
  const result = await detectOllama({ fetchImpl: okFetch('0.20.4'), run: () => ({ status: 1 }) });
  assert.equal(result.installed, true);
  assert.equal(result.versionSupported, false);
  assert.equal(result.upgradeRequired, true);
  assert.equal(result.versionStatus, 'outdated');
});

test('ensureServing short-circuits when the daemon is already running', async () => {
  let spawned = false;
  const result = await ensureServing({
    fetchImpl: okFetch('x'),
    run: () => ({ status: 1 }),
    spawnImpl: () => {
      spawned = true;
      return { unref() {} };
    },
    sleepImpl: async () => {},
  });
  assert.deepEqual(result, { running: true, started: false });
  assert.equal(spawned, false, 'must not spawn `ollama serve` when already running');
});

test('ensureServing trusts a supplied initialDetect and skips the re-probe', async () => {
  let probes = 0;
  const result = await ensureServing({
    fetchImpl: async () => {
      probes += 1;
      return { ok: true, json: async () => ({ version: 'x' }) };
    },
    run: () => ({ status: 1 }),
    spawnImpl: () => {
      throw new Error('should not spawn when already running');
    },
    sleepImpl: async () => {},
    initialDetect: { installed: true, running: true, version: 'x' },
  });
  assert.deepEqual(result, { running: true, started: false });
  assert.equal(probes, 0, 'must not re-probe /api/version when the caller already detected it');
});

test('ensureServing starts the daemon then succeeds on re-probe', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: calls > 1 }; // down on the first probe, up after `serve`
  };
  let spawned = false;
  const result = await ensureServing({
    fetchImpl,
    run: (cmd) => ({ status: 0, stdout: cmd === 'which' || cmd === 'where' ? 'ollama\n' : '' }),
    spawnImpl: () => {
      spawned = true;
      return { unref() {} };
    },
    sleepImpl: async () => {},
    attempts: 3,
  });
  assert.equal(spawned, true);
  assert.equal(result.running, true);
  assert.equal(result.started, true);
});

test('ensureServing reports not_installed without spawning', async () => {
  // ensureServing's internal detectOllama call doesn't forward fileExists, so it
  // falls back to the real fs.existsSync — pass an initialDetect instead to stay
  // hermetic on machines that happen to have a real Ollama install.
  const result = await ensureServing({
    fetchImpl: downFetch(),
    run: () => ({ status: 1, stdout: '' }),
    spawnImpl: () => {
      throw new Error('should not spawn');
    },
    sleepImpl: async () => {},
    initialDetect: { installed: false, running: false, version: '' },
  });
  assert.equal(result.running, false);
  assert.equal(result.reason, 'not_installed');
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('pullModel parses per-layer progress and resolves ok on exit 0', async () => {
  let captured;
  const seen = [];
  const promise = pullModel('ornith:9b', {
    spawnImpl: () => {
      captured = fakeChild();
      return captured;
    },
    onProgress: (p) => seen.push(p),
  });
  captured.stdout.emit('data', Buffer.from('pulling 8934d96d3f08 50% 1.0 GB/2.0 GB\n'));
  captured.emit('close', 0);
  const result = await promise;
  assert.equal(result.ok, true);
  assert.ok(seen.some((p) => p.percent === 50), 'mid-download layer progress at 50% should fire');
  // On a clean exit the bar is driven to 100% so its in-place line is closed.
  assert.equal(seen[seen.length - 1].percent, 100);
  assert.equal(seen[seen.length - 1].label, 'Complete');
});

test('pullModel resolves not-ok on a non-zero exit', async () => {
  let captured;
  const promise = pullModel('ornith:9b', {
    spawnImpl: () => {
      captured = fakeChild();
      return captured;
    },
  });
  captured.emit('close', 1);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
});

test('pullModel stops an inactive owned process instead of hanging forever', async () => {
  let kills = 0;
  const result = await pullModel('ornith:9b', {
    spawnImpl: () => {
      const child = fakeChild();
      child.pid = 8181;
      return child;
    },
    inactivityMs: 5,
    killProcessTreeImpl: async () => {
      kills += 1;
      return { terminated: true };
    },
  });

  assert.equal(kills, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pull_inactivity');
  assert.equal(result.terminationConfirmed, true);
});

test('pullModel returns a bounded actionable stderr tail and HTTP status', async () => {
  let captured;
  const promise = pullModel('ornith:9b', {
    spawnImpl: () => {
      captured = fakeChild();
      return captured;
    },
  });
  captured.stderr.emit('data', Buffer.from('\u001b[31mError: HTTP 412 requires a newer version of Ollama\u001b[0m\n'));
  captured.emit('close', 1);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 412);
  assert.match(result.error, /newer version of Ollama/);
  assert.equal(result.error.includes('\u001b'), false);
});

test('pullModel redacts paths and secrets from a failed pull stderr tail', async () => {
  let captured;
  const promise = pullModel('ornith:9b', {
    spawnImpl: () => {
      captured = fakeChild();
      return captured;
    },
  });
  captured.stderr.emit('data', Buffer.from(
    'pull failed at C:\\Users\\alice\\models\\weights.bin api_key=supersecret Error: HTTP 401\n'
  ));
  captured.emit('close', 1);

  const result = await promise;

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 401);
  assert.equal(result.error, 'pull failed at [path] api_key=[redacted] Error: HTTP 401');
});

test('pullModel does not misclassify unrelated three-digit values as HTTP status', async () => {
  let captured;
  const promise = pullModel('ornith:9b', {
    spawnImpl: () => {
      captured = fakeChild();
      return captured;
    },
  });
  captured.stderr.emit('data', Buffer.from('download failed after 500 MB\n'));
  captured.emit('close', 1);
  const result = await promise;
  assert.equal(result.httpStatus, undefined);
});

test('pullModel resolves not-ok when the spawn throws', async () => {
  const result = await pullModel('ornith:9b', {
    spawnImpl: () => {
      throw new Error(`ENOENT ${'x'.repeat(5000)}`);
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.length <= 4000);
  assert.match(result.error, /ENOENT/);
});
