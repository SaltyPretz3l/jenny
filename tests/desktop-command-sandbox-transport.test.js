'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { DockerLauncher, OWNER, VERSION } = require('../services/execution/docker-launcher');
const { DockerWorkerTransport } = require('../services/execution/docker-worker-transport');
const { encodeEnvelope, decodeEnvelope } = require('../services/execution/worker-protocol');

const OWNER_ID = 'a'.repeat(32);
const IMAGE_ID = 'sha256:' + 'b'.repeat(64);
const CONTAINER_ID = 'c'.repeat(64);
const KEY = Buffer.alloc(32, 7);
const INCARNATION = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const ENDPOINT = 'unix:///var/run/docker.sock';

function fakeChild({ stdout = null, code = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; };
  queueMicrotask(() => {
    if (error) child.emit('error', Object.assign(new Error(error), { code: error }));
    else {
      if (stdout !== null) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    }
  });
  return child;
}

function inspectValue(snapshotDirectory = path.resolve('snapshot')) {
  return {
    Id: CONTAINER_ID,
    Name: '/jenny-command-' + OWNER_ID + '-run',
    Image: IMAGE_ID,
    Config: { User: '0:10003', Labels: { [OWNER]: OWNER_ID, [VERSION]: '1' } },
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, NetworkMode: 'none', IpcMode: 'private', PidMode: '', UTSMode: '',
      Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 128, NanoCpus: 2000000000,
      CapDrop: ['ALL'], CapAdd: ['SETUID', 'SETGID'], SecurityOpt: ['no-new-privileges:true'],
      Devices: [], PortBindings: {},
    },
    Mounts: [
      { Type: 'volume', Name: 'jenny-command-' + OWNER_ID, Destination: '/run/jenny-worker', RW: true },
      { Type: 'bind', Source: snapshotDirectory, Destination: '/inputs', RW: false },
      { Type: 'tmpfs', Destination: '/workspace', RW: true },
      { Type: 'tmpfs', Destination: '/tmp', RW: true },
    ],
    State: { Running: false, Restarting: false, Pid: 0, StartedAt: 'before' },
  };
}

function statusResponse(request, { incarnation = INCARNATION, phase = 'ready', jobId = null, previousResult = null } = {}) {
  return {
    schema_version: 1, request_id: request.request_id, ok: true, incarnation,
    phase, job_id: jobId, previous_result: previousResult,
  };
}

function result({ incarnation = INCARNATION, jobId = JOB_ID, status = 'completed' } = {}) {
  return {
    schema_version: 1, incarnation, job_id: jobId, status, exit_code: status === 'completed' ? 0 : null,
    stdout: '', stderr: '', output_truncated: false, reason: status === 'completed' ? null : status,
  };
}

function transportFixture(responseFactory) {
  const calls = [];
  const launcher = {
    calls,
    async verify() {
      calls.push(['verify']);
      return { State: { Running: true, Restarting: false, StartedAt: 'start-1' } };
    },
    async relay(_id, operation, input) {
      calls.push([operation, input]);
      if (operation === 'bootstrap') return Buffer.from(KEY);
      const request = decodeEnvelope(input.toString('utf8').trimEnd(), KEY);
      const response = await responseFactory(request);
      return Buffer.isBuffer(response) ? response : Buffer.from(encodeEnvelope(response, KEY, { response: true }));
    },
  };
  return { launcher, calls, transport: new DockerWorkerTransport({ launcher, containerId: CONTAINER_ID, imageId: IMAGE_ID, snapshotDirectory: path.resolve('snapshot') }) };
}

test('Docker worker transport rejects forged and stale responses', async () => {
  const forged = transportFixture(async (request) => {
    const valid = encodeEnvelope(statusResponse(request), KEY, { response: true });
    const envelope = JSON.parse(valid);
    envelope.mac = (envelope.mac[0] === '0' ? '1' : '0') + envelope.mac.slice(1);
    return Buffer.from(JSON.stringify(envelope) + '\n');
  });
  await assert.rejects(forged.transport.request('status'), (error) => error.reason === 'worker_authentication_failed');

  const stale = transportFixture(async (request) => {
    const response = statusResponse(request);
    response.request_id = '33333333-3333-4333-8333-333333333333';
    return response;
  });
  await assert.rejects(stale.transport.request('status'), (error) => error.reason === 'worker_response_invalid');
});

test('Docker worker transport detects a previous result from the same container incarnation', async () => {
  const setup = transportFixture(async (request) => {
    if (request.operation === 'submit') return { schema_version: 1, request_id: request.request_id, ok: true, accepted: true };
    if (request.operation === 'status' && setup.transport.submittedStartedAt) {
      return statusResponse(request, {
        incarnation: '44444444-4444-4444-8444-444444444444',
        previousResult: result({ incarnation: INCARNATION }),
      });
    }
    return statusResponse(request);
  });
  const submit = await setup.transport.request('submit', { incarnation: INCARNATION, job_id: JOB_ID, command: 'echo ok', cwd: '.', timeout_seconds: 2 });
  assert.equal(submit.accepted, true);
  await assert.rejects(setup.transport.request('status'), (error) => error.reason === 'sandbox_cleanup_unconfirmed');
});

test('Docker launcher uses fixed, non-shell container argv and rejects unsafe inputs', async (t) => {
  const calls = [];
  const snapshotDirectory = path.resolve('snapshot');
  const launcher = new DockerLauncher({
    ownerId: OWNER_ID,
    platform: 'linux',
    env: { PATH: 'safe' },
    spawnImpl: (_command, args, options) => {
      calls.push({ command: _command, args, options });
      if (args.includes('container') && args.includes('create')) return fakeChild({ stdout: CONTAINER_ID + '\n' });
      if (args.includes('container') && args.includes('inspect')) return fakeChild({ stdout: JSON.stringify([inspectValue(snapshotDirectory)]) });
      if (args.includes('container') && args.includes('start')) return fakeChild({ stdout: '' });
      return fakeChild({ stdout: '' });
    },
  });
  launcher.endpoint = ENDPOINT;
  t.after(() => calls.splice(0));
  const created = await launcher.create({ imageId: IMAGE_ID, snapshotDirectory });
  assert.equal(created, CONTAINER_ID);
  const create = calls.find((call) => call.args.includes('container') && call.args.includes('create'));
  assert.equal(create.command, 'docker');
  assert.equal(create.options.shell, false);
  assert.equal(create.options.windowsHide, true);
  assert.deepEqual(create.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(create.args.includes('--privileged'), false);
  assert.equal(create.args.includes('--network') && create.args[create.args.indexOf('--network') + 1], 'none');
  assert.equal(create.args.includes('--read-only'), true);
  assert.equal(create.args.includes('--cap-drop') && create.args[create.args.indexOf('--cap-drop') + 1], 'ALL');
  assert.equal(create.args.includes('--user') && create.args[create.args.indexOf('--user') + 1], '0:10003');
  assert.equal(create.args.includes('--platform') && create.args[create.args.indexOf('--platform') + 1], 'linux/amd64');
  assert.equal(create.args.at(-2), '-c');
  assert.match(create.args.at(-1), /server\.worker\.supervisor/u);
  assert.equal(create.args.includes('tcp://127.0.0.1:2375'), false);
  await assert.rejects(launcher.create({ imageId: 'latest', snapshotDirectory }), /docker_create_arguments_invalid/u);
  await assert.rejects(launcher.create({ imageId: IMAGE_ID, snapshotDirectory: 'relative' }), /docker_create_arguments_invalid/u);
  await assert.rejects(launcher.create({ imageId: IMAGE_ID, snapshotDirectory: snapshotDirectory + ',evil' }), /docker_create_arguments_invalid/u);
});

test('Docker launcher reports missing Docker without an alternate process path', async () => {
  const calls = [];
  const launcher = new DockerLauncher({
    ownerId: OWNER_ID,
    platform: 'linux',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild({ error: 'ENOENT' });
    },
  });
  await assert.rejects(launcher.detect(), (error) => error.reason === 'docker_missing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.equal(calls[0].options.shell, false);
});

test('Docker launcher verifies the security contract before accepting a container', async () => {
  const launcher = new DockerLauncher({ ownerId: OWNER_ID, platform: 'linux' });
  launcher.endpoint = ENDPOINT;
  launcher.inspect = async () => ({
    ...inspectValue(path.resolve('snapshot')),
    HostConfig: { ...inspectValue(path.resolve('snapshot')).HostConfig, ReadonlyRootfs: false },
  });
  await assert.rejects(launcher.verify(CONTAINER_ID, { imageId: IMAGE_ID, snapshotDirectory: path.resolve('snapshot') }), /docker_security_contract_invalid/u);

  launcher.inspect = async () => ({
    ...inspectValue(path.resolve('snapshot')),
    HostConfig: { ...inspectValue(path.resolve('snapshot')).HostConfig, NetworkMode: 'bridge' },
  });
  await assert.rejects(launcher.verify(CONTAINER_ID, { imageId: IMAGE_ID, snapshotDirectory: path.resolve('snapshot') }), /docker_security_contract_invalid/u);
});

test('Docker Desktop bind inspection resolves only the exact staging source', () => {
 const { validBindSource } = require('../services/execution/docker-launcher');
 assert.equal(validBindSource('/run/desktop/mnt/host/c/Users/test/stage', 'C:/Users/test/stage', 'win32'), true);
 assert.equal(validBindSource('/run/desktop/mnt/host/c/Users/test/live', 'C:/Users/test/stage', 'win32'), false);
 assert.equal(validBindSource('/host_mnt/Users/test/stage', '/Users/test/stage', 'darwin'), true);
 assert.equal(validBindSource('/workspace', '/stage', 'linux'), false);
});
