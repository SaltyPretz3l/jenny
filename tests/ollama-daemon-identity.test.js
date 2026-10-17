'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { identifyOllamaDaemon } = require('../services/backend/ollama-daemon-identity');
const { stopUserOllamaProcess } = require('../services/backend/ollama-daemon-stop');

const table = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
  + '0: 0100007F:2CAA 00000000:0000 0A 0:0 00:0 0 1000 0 42\n';
const stat = '123 (ollama) ' + ['S', ...Array(18).fill('0'), '987'].join(' ');
function fixture({ kind = 'process', sameUser = true, confirmed = true, container = 'local-ollama' } = {}) {
  const commands = [];
  return {
    commands, platform: 'linux', uid: 1000,
    readFileImpl: async (file) => {
      if (file.startsWith('/proc/net/')) return table;
      if (file.endsWith('/cmdline')) return kind === 'docker'
        ? '/usr/bin/docker-proxy\0-host-port\0' + '11434\0'
        : (kind === 'snap' ? '/snap/ollama/1/bin/ollama' : '/usr/bin/ollama') + '\0serve\0';
      if (file.endsWith('/stat')) return stat;
      if (file.endsWith('/cgroup')) return '0::/user.slice/session.scope';
      throw new Error(file);
    },
    readdirImpl: async (file) => file === '/proc' ? ['123'] : ['3'],
    readlinkImpl: async (file) => file.endsWith('/exe')
      ? (kind === 'snap' ? '/snap/ollama/1/bin/ollama' : kind === 'docker' ? '/usr/bin/docker-proxy' : '/usr/bin/ollama')
      : (confirmed ? 'socket:[42]' : 'socket:[999]'),
    statImpl: async () => ({ uid: sameUser ? 1000 : 999 }),
    execFileImpl: (command, args, options, callback) => {
      commands.push({ command, args, options });
      let output = '';
      if (command === 'systemctl'
        && ((kind === 'systemd-user' && args.includes('--user'))
          || (kind === 'systemd-system' && !args.includes('--user')))) {
        output = 'ActiveState=active\nMainPID=123\nUser=ollama\nExecStart={ path=/usr/bin/ollama ; argv[]=/usr/bin/ollama serve ; }';
      }
      if (command === 'docker') output = container + '\tollama/ollama:latest';
      callback(null, output);
    },
  };
}

for (const kind of ['process', 'systemd-system', 'systemd-user', 'snap', 'docker']) {
  test('identifies ' + kind + ' with bounded read-only probes', async () => {
    const deps = fixture({ kind });
    const result = await identifyOllamaDaemon(deps);
    assert.equal(result.kind, kind);
    assert.equal(result.confidence, 'confirmed');
    assert.equal(result.pid, 123);
    assert.equal(result.startTime, '987');
    assert.ok(Object.isFrozen(result));
    for (const { command, args, options } of deps.commands) {
      assert.equal(options.shell, false);
      assert.ok(options.timeout <= 1500);
      assert.ok(command === 'systemctl' ? args.includes('show') : args.includes('ps'));
    }
  });
}

test('unknown, inferred, managed, non-Linux and malicious container cases fail safely', async () => {
  assert.equal(await identifyOllamaDaemon({ platform: 'win32' }), null);
  assert.equal(await identifyOllamaDaemon({ ...fixture(), getOwnedPid: () => 123 }), null);
  assert.equal((await identifyOllamaDaemon({ ...fixture(), readdirImpl: async () => [] })).kind, 'unknown');
  const inferred = await identifyOllamaDaemon(fixture({ confirmed: false, sameUser: false }));
  assert.equal(inferred.confidence, 'inferred');
  assert.equal(inferred.sameUser, false);
  const malicious = await identifyOllamaDaemon(fixture({ kind: 'docker', container: 'a;evil' }));
  assert.equal(malicious.remedy.stopCommand, undefined);
  assert.equal(malicious.container, undefined);
});

function stopFixture() {
  let clock = 0;
  const calls = [];
  return {
    calls, platform: 'linux', expectedPid: 123, expectedStartTime: '987', expectedProgram: '/usr/bin/ollama',
    identifyImpl: async () => ({
      kind: 'process', sameUser: true, confidence: 'confirmed', pid: 123, startTime: '987', program: '/usr/bin/ollama',
    }),
    readListenersImpl: async () => ({ state: 'occupied', inodes: ['42'] }),
    readProcessImpl: async () => ({ ollama: true, sameUser: true, matched: ['42'], startTime: '987', program: '/usr/bin/ollama', cgroup: '0::/user.slice/session.scope' }),
    killImpl: (pid, signal) => {
      calls.push({ pid, signal });
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
    nowImpl: () => clock, delayImpl: async (ms) => { clock += ms; },
  };
}

test('stop signals only the freshly confirmed same-user listener and confirms exit', async () => {
  const deps = stopFixture();
  assert.deepEqual(await stopUserOllamaProcess(deps), { stopped: true, pid: 123 });
  assert.deepEqual(deps.calls, [{ pid: 123, signal: 'SIGTERM' }, { pid: 123, signal: 0 }]);
});

test('stop denies changed PID/start, service, inferred, foreign, managed or lost-listener identity', async () => {
  const overrides = [
    { readListenersImpl: async () => ({ state: 'unknown', inodes: ['42'] }) },
    { readListenersImpl: async () => ({ state: 'occupied', inodes: ['42', '43'] }) },
    { readProcessImpl: async () => ({ ollama: true, sameUser: true, matched: ['42'], startTime: '987', program: '/usr/bin/ollama', cgroup: '0::/system.slice/new.service' }) },
    { expectedPid: 456 }, { expectedProgram: '/changed/ollama' }, { expectedStartTime: '988' }, { getOwnedPid: () => 123 },
    ...[{ kind: 'systemd-user' }, { sameUser: false }, { confidence: 'inferred' }].map((changes) => ({
      identifyImpl: async () => ({
        kind: 'process', sameUser: true, confidence: 'confirmed', pid: 123, startTime: '987', program: '/usr/bin/ollama', ...changes,
      }),
    })),
    { readProcessImpl: async () => ({ ollama: true, sameUser: true, matched: [], startTime: '987' }) },
    { readProcessImpl: async () => ({ ollama: true, sameUser: true, matched: ['42'], startTime: '989' }) },
  ];
  for (const override of overrides) {
    const deps = { ...stopFixture(), ...override };
    assert.equal((await stopUserOllamaProcess(deps)).stopped, false);
    assert.deepEqual(deps.calls, []);
  }
});

test('stop never escalates a surviving listener beyond SIGTERM', async () => {
  const deps = stopFixture();
  deps.killImpl = (pid, signal) => deps.calls.push({ pid, signal });
  const result = await stopUserOllamaProcess(deps);
  assert.equal(result.reason, 'exit_unconfirmed');
  assert.equal(deps.calls.filter((call) => call.signal !== 0).length, 1);
});

test('executable mismatch or unreadable executable cannot confirm a user process', async () => {
  for (const program of ['/usr/bin/python3', null]) {
    const deps = fixture();
    const readlink = deps.readlinkImpl;
    deps.readlinkImpl = async (file) => {
      if (!file.endsWith('/exe')) return readlink(file);
      if (program === null) throw new Error('permission denied');
      return program;
    };
    const result = await identifyOllamaDaemon(deps);
    assert.notEqual(result.confidence, 'confirmed');
    assert.notEqual(result.kind, 'process');
  }
});

test('cgroup service detection reads the systemd leaf, including real trailing newlines', () => {
  const { isServiceCgroup } = require('../services/backend/ollama-daemon-proc');
  assert.equal(isServiceCgroup('0::/system.slice/ollama-gpu.service\n'), true);
  assert.equal(isServiceCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/ollama.service\n'), true);
  assert.equal(isServiceCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope\n'), false);
  assert.equal(isServiceCgroup('12:pids:/user.slice/user-1000.slice/user@1000.service\n1:name=systemd:/user.slice/user-1000.slice/session-2.scope\n'), false);
  assert.equal(isServiceCgroup('3:cpu:/system.slice/ollama.service\n1:name=systemd:/system.slice/ollama.service\n'), true);
});

test('a renamed unit is not stoppable and a terminal session process is', async () => {
  for (const [cgroup, kind] of [['0::/system.slice/ollama-gpu.service\n', 'unknown'],
    ['0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-1.scope\n', 'process']]) {
    const deps = fixture();
    const read = deps.readFileImpl;
    deps.readFileImpl = async (file) => (file.endsWith('/cgroup') ? cgroup : read(file));
    assert.equal((await identifyOllamaDaemon(deps)).kind, kind);
  }
  const deps = { ...stopFixture(), readProcessImpl: async () => ({ ollama: true, sameUser: true, matched: ['42'],
    startTime: '987', program: '/usr/bin/ollama', cgroup: '0::/system.slice/ollama-gpu.service\n' }) };
  assert.equal((await stopUserOllamaProcess(deps)).stopped, false);
  assert.deepEqual(deps.calls, []);
});

test('another user\'s docker-proxy is identified without a readable executable; a replaced binary still counts', async () => {
  const docker = fixture({ kind: 'docker', sameUser: false });
  const read = docker.readlinkImpl;
  docker.readlinkImpl = async (file) => {
    if (file.endsWith('/exe') || file.includes('/fd/')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(file);
  };
  docker.readdirImpl = async (file) => {
    if (file === '/proc') return ['123'];
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  const result = await identifyOllamaDaemon(docker);
  assert.equal(result.kind, 'docker');
  assert.equal(result.confidence, 'inferred');
  const replaced = fixture();
  const link = replaced.readlinkImpl;
  replaced.readlinkImpl = async (file) => (file.endsWith('/exe') ? '/usr/bin/ollama (deleted)' : link(file));
  const upgraded = await identifyOllamaDaemon(replaced);
  assert.equal(upgraded.kind, 'process');
  assert.equal(upgraded.program, '/usr/bin/ollama (deleted)');
});

// Runs stopUserOllamaProcess against the fixture through its accepted seams (identifyImpl,
// readListenersImpl, readProcessImpl) and counts the fixture's own probes.
async function stopThroughFixture(deps, daemon) {
  const { readDaemonProcess } = require('../services/backend/ollama-daemon-proc');
  const { readLinuxListeners } = require('../services/backend/ollama-daemon-port');
  let probes = 0;
  const counted = { ...deps,
    readFileImpl: async (...args) => { probes += 1; return deps.readFileImpl(...args); },
    readlinkImpl: async (...args) => { probes += 1; return deps.readlinkImpl(...args); } };
  const calls = [];
  const stop = await stopUserOllamaProcess({
    platform: 'linux', expectedPid: daemon.pid, expectedStartTime: daemon.startTime, expectedProgram: daemon.program,
    identifyImpl: (options) => identifyOllamaDaemon({ ...counted, ...options }),
    readListenersImpl: () => readLinuxListeners(counted),
    readProcessImpl: (pid, options) => readDaemonProcess(pid, { ...counted, ...options }),
    killImpl: (pid, signal) => {
      calls.push({ pid, signal });
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  });
  return { stop, calls, probes };
}

// Another user's daemon: cmdline, stat and systemctl stay readable, /proc/<pid>/exe is EACCES.
function unreadableExecutable(kind) {
  const deps = fixture({ kind, sameUser: false });
  const read = deps.readlinkImpl;
  deps.readlinkImpl = async (file) => {
    if (file.endsWith('/exe')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(file);
  };
  deps.readFileImpl = ((readFile) => async (file) => (file.endsWith('/cgroup')
    ? '0::/system.slice/' + (kind === 'snap' ? 'snap.ollama.listener.service' : 'ollama.service') + '\n'
    : readFile(file)))(deps.readFileImpl);
  return deps;
}

test('an unreadable executable keeps the systemd ExecStart path for display only', async () => {
  const { facts } = require('../renderer/features/setup-scenes/ollama-daemon-view');
  const result = await identifyOllamaDaemon(unreadableExecutable('systemd-system'));
  assert.equal(result.kind, 'systemd-system');
  assert.equal(result.program, '/usr/bin/ollama');
  assert.notEqual(result.confidence, 'confirmed');
  assert.equal(result.remedy.stopCommand, 'sudo systemctl disable --now ollama');
  assert.match(facts(result), /<dt>Program<\/dt><dd>\/usr\/bin\/ollama<\/dd>/);
  const { stop, calls, probes } = await stopThroughFixture(unreadableExecutable('systemd-system'), result);
  assert.ok(probes > 0, 'the refusal ran against the fixture daemon');
  assert.equal(stop.stopped, false);
  assert.deepEqual(calls, []);
});

test('an unreadable snap executable is inferred as snap from argv0 and still never stopped', async () => {
  const { facts, startedBy } = require('../renderer/features/setup-scenes/ollama-daemon-view');
  const deps = unreadableExecutable('snap');
  const result = await identifyOllamaDaemon(deps);
  assert.equal(result.kind, 'snap');
  assert.equal(result.confidence, 'inferred');
  assert.equal(result.program, '/snap/ollama/1/bin/ollama');
  assert.equal(result.remedy.upgradeCommand, 'sudo snap refresh ollama');
  assert.equal(result.remedy.stopCommand, 'sudo snap stop --disable ollama');
  assert.equal(startedBy(result), 'the snap ollama');
  assert.match(facts(result), /\/snap\/ollama\/1\/bin\/ollama/);
  const { stop, calls, probes } = await stopThroughFixture(deps, result);
  assert.ok(probes > 0, 'the refusal ran against the fixture daemon');
  assert.equal(stop.stopped, false);
  assert.deepEqual(calls, []);
});

test('a same-user ollama with an unreadable executable displays argv0 yet stays unstoppable', async () => {
  const deps = fixture();
  const read = deps.readlinkImpl;
  deps.readlinkImpl = async (file) => {
    if (file.endsWith('/exe')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(file);
  };
  const result = await identifyOllamaDaemon(deps);
  assert.equal(result.kind, 'unknown');
  assert.equal(result.program, '/usr/bin/ollama');
  const { stop, calls, probes } = await stopThroughFixture(deps, result);
  assert.ok(probes > 0, 'the refusal ran against the fixture daemon');
  assert.equal(stop.stopped, false);
  assert.deepEqual(calls, []);
  // Control: the same wiring with a readable executable link does stop the fixture daemon.
  const readable = await stopThroughFixture(fixture(), await identifyOllamaDaemon(fixture()));
  assert.deepEqual(readable.stop, { stopped: true, pid: 123 });
  assert.deepEqual(readable.calls, [{ pid: 123, signal: 'SIGTERM' }, { pid: 123, signal: 0 }]);
});
