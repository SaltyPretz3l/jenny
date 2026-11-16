'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { checkTeam, main, parseArgs, probe } = require('../../server/healthcheck');

test('healthcheck CLI accepts only an absolute config and optional readiness probe', () => {
  assert.deepEqual(parseArgs(['--config', '/etc/jenny/host.json']), {
    configPath: '/etc/jenny/host.json', route: '/healthz',
  });
  assert.deepEqual(parseArgs(['--config', '/etc/jenny/host.json', '--ready']), {
    configPath: '/etc/jenny/host.json', route: '/readyz',
  });
  assert.throws(() => parseArgs(['--config', 'host.json']), /invalid_arguments/);
  assert.throws(() => parseArgs(['--config', '/etc/jenny/host.json', '--unknown']), /invalid_arguments/);
});

test('healthcheck probes loopback with the configured canonical host identity', async () => {
  let options;
  const requestImpl = (value, callback) => {
    options = value;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('end');
    };
    request.destroy = (error) => request.emit('error', error);
    return request;
  };
  await probe({ listenHost: '0.0.0.0', port: 8080,
    canonicalOrigin: 'https://jenny.tailnet.ts.net' }, '/readyz', { requestImpl });
  assert.deepEqual(options, {
    hostname: '127.0.0.1', port: 8080, path: '/readyz', method: 'GET',
    headers: { Host: 'jenny.tailnet.ts.net', Origin: 'https://jenny.tailnet.ts.net' },
  });
});

test('healthcheck rejects a non-200 server response', async () => {
  const requestImpl = (_options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 503;
      response.resume = () => {};
      callback(response);
      response.emit('end');
    };
    return request;
  };
  await assert.rejects(probe({ listenHost: '127.0.0.1', port: 8080,
    canonicalOrigin: 'https://jenny.test' }, '/readyz', { requestImpl }), /host_unhealthy/);
});

test('healthcheck keeps the single-owner probe path for a config without a team block', async () => {
  const paths = [];
  const requestImpl = (options, callback) => {
    paths.push(options.path);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      response.emit('end');
    };
    return request;
  };
  await probe({ listenHost: '127.0.0.1', port: 8080, canonicalOrigin: 'https://jenny.test' }, '/healthz', { requestImpl });
  assert.deepEqual(paths, ['/healthz']);
});

test('healthcheck team variant rejects with host_unhealthy when no live marker exists', async () => {
  const missing = require('node:path').join(require('node:os').tmpdir(), 'jenny-no-such-team-profile');
  await assert.rejects(checkTeam({ userDataPath: missing, team: {} }, { isProcessAlive: () => true }),
    (error) => error.message === 'host_unhealthy');
});

test('3-11: healthcheck main hands the start-time reader to the team check', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { writeReadyMarker } = require('../../server/team/ready-marker');
  const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-team-health-311-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => path.join(root, 'home'));
  fs.mkdirSync(path.join(root, 'profile'));
  const configPath = path.join(root, 'host.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schema_version: 3, host_mode: 'server', host_execution_policy_version: 1, listen_host: '127.0.0.1', port: 0,
    user_data_path: path.join(root, 'profile'), workspace_root: null, secrets_dir: path.join(root, 'secrets'),
    team: { name: 'Core', key_source: 'secret_file', direct_port: null },
  }));
  writeReadyMarker({ userDataPath: fs.realpathSync.native(path.join(root, 'profile')), bootEpoch: 'boot', pid: 1, startTime: '10' });
  const requestImpl = () => { assert.fail('a team host must make no network request'); };
  const alive = (pid) => pid === 1;
  assert.equal(await main(['--config', configPath, '--ready'], { requestImpl, isProcessAlive: alive, readStartTime: () => '10' }), undefined);
  // The container restarted: pid 1 is alive again but started later, so the old marker is not ready.
  await assert.rejects(main(['--config', configPath, '--ready'], { requestImpl, isProcessAlive: alive, readStartTime: () => '11' }),
    /host_unhealthy/);
});
