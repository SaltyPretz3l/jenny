'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { readinessProbeArgs, readinessProbeLaunch, probeMcpReadiness } = require('../services/mcp-readiness-probe');

const server = { name: 'rea', transport: 'stdio', command: 'C:\\p\\rea-launcher.exe',
  args: ['-y', 'rea-agents@6.4.0', 'mcp'], env: { REA_LOG_LEVEL: 'debug' } };
const checkedAt = '2026-10-14T14:02:00.000Z';
function probe(stdout, error = null, extra = {}) {
  return probeMcpReadiness({ server, now: () => new Date(checkedAt),
    execFile: (_command, _args, _options, callback) => callback(error, stdout, 'private stderr'), ...extra });
}

test('readiness argv supports Route A and Route B only for exact rea stdio commands', () => {
  assert.deepEqual(readinessProbeArgs(server), ['-y', 'rea-agents@6.4.0', 'mcp', 'doctor', '--json']);
  assert.deepEqual(readinessProbeArgs({ ...server, args: ['C:\\p\\rea.mjs', 'mcp'] }),
    ['C:\\p\\rea.mjs', 'mcp', 'doctor', '--json']);
  for (const row of [{ ...server, name: 'REA' }, { ...server, name: 'other' },
    { ...server, args: ['mcp', '--stdio'] }, { ...server, transport: 'sse' },
    { ...server, command: '' }, { ...server, args: null }]) assert.equal(readinessProbeArgs(row), null);
});

test('the Route A npx.cmd shim launches as its own node.exe and npx-cli.js, other shims have no probe', () => {
  const shim = { ...server, command: 'C:\\Program Files\\nodejs\\NPX.CMD' };
  assert.deepEqual(readinessProbeLaunch(shim, 'win32'), { file: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', ...readinessProbeArgs(server)] });
  assert.deepEqual(readinessProbeLaunch(server, 'win32'), { file: server.command, args: readinessProbeArgs(server) });
  assert.equal(readinessProbeLaunch(shim, 'linux'), null);
  assert.equal(readinessProbeLaunch({ ...server, command: 'C:\\p\\other.cmd' }, 'win32'), null);
  assert.equal(readinessProbeLaunch({ ...server, command: 'C:\\p\\npx.bat' }, 'win32'), null);
  assert.equal(readinessProbeLaunch({ ...server, name: 'other' }, 'win32'), null);
});

test('a real doctor process is read without an injected spawn', async () => {
  const script = 'process.stdout.write(JSON.stringify({ healthy: true, inventory: { tools: { observed: 3 }, prompts: { observed: 1 } } }))';
  const result = await probeMcpReadiness({ server: { ...server, command: process.execPath, args: ['-e', script, 'mcp'] },
    now: () => new Date(checkedAt) });
  assert.deepEqual(result, { healthy: true, tools: 3, prompts: 1, checkedAt, reason: '' });
  assert.equal((await probeMcpReadiness({ server: { ...server, command: 'C:\\p\\other.cmd' }, platform: 'win32',
    now: () => new Date(checkedAt) })).reason, 'probe_unavailable');
});

test('a timed-out launcher has its whole process tree killed', async () => {
  const killed = [];
  const result = await probe('', { killed: true, signal: 'SIGTERM' }, {
    killProcessTreeImpl: async (pid) => { killed.push(pid); },
    execFile: (_command, _args, _options, callback) => { setImmediate(() => callback({ killed: true, signal: 'SIGTERM' }, '')); return { pid: 4242 }; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.reason, 'timed_out');
  assert.deepEqual(killed, [4242]);
});

test('healthy doctor fixture returns only bounded readiness facts', async () => {
  const stdout = fs.readFileSync(path.join(__dirname, 'fixtures/mcp-readiness/rea-doctor-6.4.0.json'), 'utf8');
  assert.deepEqual(await probe(stdout), { healthy: true, tools: 170, prompts: 6, checkedAt, reason: '' });
});

test('nonzero unhealthy doctor keeps counts without retaining server text', async () => {
  const stdout = JSON.stringify({ healthy: false, inventory: { tools: { observed: 170 }, prompts: { observed: 6 } },
    checks: [{ name: 'private name', ok: false, detail: 'private stdout detail' }] });
  const result = await probe(stdout, { code: 1 });
  assert.deepEqual(result, { healthy: false, tools: 170, prompts: 6, checkedAt, reason: 'exit_nonzero' });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('timeout, invalid output and synchronous spawn failure resolve sanitized results', async () => {
  assert.equal((await probe('{}', { killed: true })).reason, 'timed_out');
  assert.equal((await probe('{}', { signal: 'SIGTERM' })).reason, 'timed_out');
  for (const stdout of ['private garbage', '[]', 'null', '{"healthy":"yes"}']) {
    assert.deepEqual(await probe(stdout), { healthy: false, tools: 0, prompts: 0, checkedAt, reason: 'invalid_output' });
  }
  assert.equal((await probe('', null, { execFile: () => { throw new Error('private'); } })).reason, 'exit_nonzero');
  assert.equal((await probe('', null, { server: { ...server, name: 'other' } })).reason, 'probe_unavailable');
});

test('invalid inventory counts become zero and unhealthy success has no reason', async () => {
  for (const observed of [-1, 1.5, '6', null]) {
    assert.deepEqual(await probe(JSON.stringify({ healthy: false,
      inventory: { tools: { observed }, prompts: { observed } } })),
    { healthy: false, tools: 0, prompts: 0, checkedAt, reason: '' });
  }
});

test('spawn uses bounded hidden execution with sanitized inherited env and row env', async (t) => {
  const previous = process.env.JENNY_READINESS_TEST;
  process.env.JENNY_READINESS_TEST = 'private';
  t.after(() => { if (previous === undefined) delete process.env.JENNY_READINESS_TEST;
    else process.env.JENNY_READINESS_TEST = previous; });
  await probe('{"healthy":true}', null, { timeoutMs: 1234, execFile: (command, args, options, callback) => {
    assert.equal(command, server.command);
    assert.deepEqual(args, readinessProbeArgs(server));
    assert.equal(options.timeout, 1234);
    assert.equal(options.windowsHide, true);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(options.shell, undefined);
    assert.equal(Object.keys(options.env).some((key) => /^JENNY_/i.test(key)), false);
    assert.equal(options.env.REA_LOG_LEVEL, 'debug');
    callback(null, '{"healthy":true}');
  } });
});
