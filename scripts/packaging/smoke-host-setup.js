'use strict';

// Explicit Docker integration lane. Every resource belongs to a unique test
// project; no owner profile, model server, VPN or Docker socket is mounted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const image = process.argv[2] || 'jenny-host:ci';
const local = process.argv[3] === '--localhost';
let canonicalOrigin = 'https://jenny.test';
if (process.argv.length > 4 || (process.argv[3] && !local) || !/^[A-Za-z0-9._:/@-]{1,256}$/u.test(image)) throw new Error('Invalid image reference');
const project = 'jenny-setup-smoke-' + randomUUID();
const fixture = project + '-model';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), project + '-'));
const override = path.join(scratch, 'compose.yml');
const composeArgs = ['compose', '--project-directory', root, '-p', project,
  '-f', path.join(root, 'compose.host.easy.yml'), '-f', override];
const password = 'hosted-setup-test-password!';

function docker(args, { allowFailure = false, input, timeout = 120_000 } = {}) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', input,
    timeout, maxBuffer: 1024 * 1024, windowsHide: true });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error('Docker ' + args[0] + ' failed: ' + (result.error?.message || result.stderr || result.stdout).slice(0, 4000));
  }
  return result;
}
const compose = (args, options) => docker([...composeArgs, ...args], options);
const step = (message) => process.stdout.write(message + '\n');
function inspectSecurity(id) {
  const value = JSON.parse(docker(['inspect', id]).stdout)[0];
  assert.equal(value.Config.User, '10001:10001');
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.equal(value.HostConfig.Privileged, false);
  assert.deepEqual(value.HostConfig.CapDrop, ['ALL']);
  assert.ok(value.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  assert.equal(value.HostConfig.PidsLimit, 256);
  assert.ok(value.HostConfig.Memory > 0 && value.HostConfig.NanoCpus > 0);
  for (const target of ['/etc/jenny', '/run/jenny-secrets']) {
    assert.equal(value.Mounts.find((mount) => mount.Destination === target)?.RW, false);
  }
  assert.ok(value.Mounts.every((mount) => !mount.Source.includes('docker.sock')));
}
function api(port, route, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port, path: route, agent: false,
      method: body === undefined ? 'GET' : 'POST', headers: {
        Host: new URL(canonicalOrigin).host, Origin: canonicalOrigin, ...headers,
        ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
        if (text.length > 64 * 1024) request.destroy(new Error('smoke_response_limit'));
      });
      response.once('end', () => {
        try {
          const value = JSON.parse(text);
          assert.equal(response.statusCode, 200, route + ': ' + text);
          assert.equal(value.ok, true, text);
          resolve({ value, headers: response.headers });
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('smoke_request_timeout')));
    request.once('error', reject);
    request.end(payload);
  });
}
async function login(port) {
  const auth = await api(port, '/api/v1/auth/login', { body: { password } });
  const headers = { Cookie: auth.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': auth.value.csrf_token };
  const bootstrap = await api(port, '/api/v1/bootstrap', { headers });
  const client = (await api(port, '/api/v1/clients', { body: null, headers })).value;
  return async (operation, params) => (await api(port, '/api/v1/commands', {
    headers: { ...headers, 'X-Client-Token': client.client_token },
    body: { api_version: 1, operation, request_id: randomUUID(),
      client_id: client.client_id, boot_epoch: bootstrap.value.boot_epoch, params },
  })).value;
}

async function main() {
  let localPort;
  if (local) {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    localPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    canonicalOrigin = 'http://127.0.0.1:' + localPort;
  }
  fs.writeFileSync(override, 'services:\n  jenny:\n    image: ' + image
    + '\n    ports: !override\n      - "127.0.0.1:' + (local ? localPort + ':' + localPort : ':8080') + '"'
    + (local ? '\n    volumes:\n      - "' + path.join(root, 'scripts/packaging').replaceAll('\\', '/') + ':/proof:ro"' : '')
    + '\n  setup:\n    image: ' + image + '\n  sandbox:\n    image: ' + image + '\n');
  try {
    step('Create isolated easy-Compose volumes and model metadata fixture.');
    compose(['--profile', 'setup', 'create', '--no-build', 'setup']);
    docker(['run', '-d', '--name', fixture, '--network', project + '_default', '--network-alias', 'model',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--memory', '128m', '--pids-limit', '32', '--entrypoint', 'node', image, '-e',
      local ? fs.readFileSync(path.join(__dirname, 'fixture-sandbox-model.js'), 'utf8') + '\nmain();' :
      "require('http').createServer((q,s)=>{console.log(q.method,q.url,q.headers.authorization==='Bearer setup-fixture-api-key');if(q.url!='/v1/models'||q.headers.authorization!=='Bearer setup-fixture-api-key'){s.writeHead(401);s.end('{}');return;}s.setHeader('Content-Type','application/json');s.end(JSON.stringify({data:[{id:'setup-fixture-model'}]}))}).listen(8000,'0.0.0.0')"]);
    step('Run the real interactive wizard, including secret and owner password.');
    compose(['run', '--rm', '--no-deps', '-T',
      '-v', path.join(root, 'scripts/packaging/setup-container-tty.py') + ':/tmp/setup-tty.py:ro',
      '--entrypoint', 'python3', 'setup', '/tmp/setup-tty.py', ...(local ? ['--localhost'] : [])]);
    const readAuth = () => compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'setup', '-e',
      "process.stdout.write(require('fs').readFileSync('/data/auth.json','utf8'))"]).stdout;
    const ownerBefore = readAuth();
    // Existing setup must be idempotent even without interactive input.
    compose(['run', '--rm', '--no-deps', '-T', 'setup', 'init']);
    assert.equal(readAuth(), ownerBefore);
    if (local) {
      compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'setup', '-e',
        "const fs=require('fs');const p='/etc/jenny/host.json';const c=JSON.parse(fs.readFileSync(p));if(c.canonical_origin!=='http://127.0.0.1:8080'||c.execution?.mode!=='offline-copy')throw Error('wizard_defaults_invalid');c.port=" + localPort + ";c.canonical_origin='" + canonicalOrigin + "';fs.writeFileSync(p,JSON.stringify(c));"]);
    }
    step('Start the real image, verify read-only mounts, readiness, login and SSE.');
    compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'jenny']);
    const id = compose(['ps', '-q', 'jenny']).stdout.trim();
    inspectSecurity(id);
    const port = Number(compose(['port', 'jenny', String(local ? localPort : 8080)]).stdout.trim().split(':').at(-1));
    if (local) {
      const inspected = JSON.parse(docker(['inspect', id]).stdout)[0];
      assert.deepEqual(Object.keys(inspected.HostConfig.PortBindings), [localPort + '/tcp']);
      assert.deepEqual(inspected.HostConfig.PortBindings[localPort + '/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(localPort) }]);
      assert.equal(inspected.Mounts.find((item) => item.Destination === '/run/jenny-worker').RW, false);
      const sandboxId = compose(['ps', '-q', 'sandbox']).stdout.trim();
      const worker = JSON.parse(docker(['inspect', sandboxId]).stdout)[0];
      assert.equal(worker.Config.User, '0:10003');
      assert.equal(worker.HostConfig.NetworkMode, 'none');
      assert.equal(worker.HostConfig.IpcMode, 'private');
      assert.equal(worker.HostConfig.ReadonlyRootfs, true);
      assert.equal(worker.HostConfig.Privileged, false);
      assert.deepEqual(worker.HostConfig.CapDrop, ['ALL']);
      assert.deepEqual(worker.HostConfig.CapAdd.map((cap) => cap.replace(/^CAP_/u, '')).sort(), ['SETGID', 'SETUID']);
      assert.equal(worker.HostConfig.PidsLimit, 128);
      assert.equal(worker.HostConfig.Memory, 2147483648);
      assert.equal(worker.HostConfig.MemorySwap, 2147483648);
      assert.equal(worker.HostConfig.NanoCpus, 2000000000);
      assert.ok(!worker.HostConfig.PidMode && !worker.HostConfig.Init);
      assert.ok(worker.Mounts.every((item) => ['tmpfs'].includes(item.Type) || ['/inputs', '/run/jenny-worker'].includes(item.Destination)));
      assert.equal(worker.Mounts.find((item) => item.Destination === '/inputs').RW, false);
      step('Exercise real offline command identity, resource limits, cancellation and namespace recycling.');
      const result = compose(['exec', '-T', 'jenny', 'node', '/proof/probe-command-worker.js'], { timeout: 300_000 });
      process.stdout.write(result.stdout);
      step('Verify durable admission recovery after abrupt worker and app restart.');
      process.stdout.write(compose(['exec', '-T', 'jenny', 'node', '/proof/probe-worker-recovery.js', 'admit']).stdout);
      docker(['restart', '--time', '0', sandboxId, id]);
      compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'jenny']);
      process.stdout.write(compose(['exec', '-T', 'jenny', 'node', '/proof/probe-worker-recovery.js', 'recover']).stdout);
      step('Exercise actual browser, model tool calling, approval, denial and cancellation.');
      const browser = spawnSync(process.execPath, [path.join(__dirname, 'probe-localhost-sandbox.js'), String(port), password],
        { encoding: 'utf8', timeout: 240_000, windowsHide: true, env: { ...process.env, JENNY_PROBE_APP_CONTAINER: id } });
      process.stdout.write(browser.stdout || '');
      assert.equal(browser.status, 0, browser.stderr || browser.error?.message);
    } else {
      const probe = spawnSync(process.execPath, [path.join(__dirname, 'probe-host-container.js'), String(port), password],
        { encoding: 'utf8', timeout: 75_000, windowsHide: true });
      assert.equal(probe.status, 0, probe.stderr);
    }
    const blocked = compose(['run', '--rm', '--no-deps', '-T', 'setup', 'configure'], { allowFailure: true });
    assert.notEqual(blocked.status, 0, 'a running profile must exclude configuration');
    assert.doesNotMatch(blocked.stdout, /Private HTTPS address/);
    const firstDevice = await login(port);
    const created = await firstDevice('sessions.create', { title: 'Setup durability across devices' });
    const secondDevice = await login(port);
    const listed = await secondDevice('sessions.list', {});
    assert.ok(listed.sessions.some((session) => session.session_id === created.session.session_id));
    step('Stop/start without deleting volumes and verify the same session and login.');
    compose(['stop', 'jenny']);
    compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'jenny']);
    const restartedPort = Number(compose(['port', 'jenny', String(local ? localPort : 8080)]).stdout.trim().split(':').at(-1));
    const afterRestart = await login(restartedPort);
    const restored = await afterRestart('sessions.list', {});
    assert.ok(restored.sessions.some((session) => session.session_id === created.session.session_id
      && session.title === 'Setup durability across devices'));
    step(local ? 'Doctor verifies localhost service and command worker.' : 'Doctor distinguishes model success from absent private HTTPS.');
    const diagnostic = compose(['run', '--rm', '--no-deps', '-T', 'setup', 'doctor'], { allowFailure: true });
    assert.equal(diagnostic.status, local ? 0 : 1, diagnostic.stdout + diagnostic.stderr);
    assert.match(diagnostic.stdout, /listed by the endpoint/);
    assert.match(diagnostic.stdout, local ? /Localhost service: Jenny health response received/ : /Private HTTPS: not reachable/);
    if (local) assert.match(diagnostic.stdout, /Command sandbox: ready/);
    step(local ? 'Localhost setup and offline sandbox qualification passed.' : 'Private HTTPS setup smoke passed (proxy/device qualification remains separate).');
  } catch (error) {
    process.stderr.write(compose(['logs', '--tail', '30', 'jenny', 'sandbox'], { allowFailure: true }).stdout || '');
    process.stderr.write(docker(['logs', '--tail', '20', fixture], { allowFailure: true }).stdout || '');
    throw error;
  } finally {
    // Exact resources generated by this invocation; never the fixed owner project.
    docker(['rm', '-f', fixture], { allowFailure: true, timeout: 30_000 });
    compose(['--profile', 'setup', 'down', '--volumes', '--remove-orphans'], { timeout: 90_000 });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
