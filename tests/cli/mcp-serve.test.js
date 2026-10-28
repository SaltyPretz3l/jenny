'use strict';

// Jenny CLI S6: `jenny mcp serve` is a stdio MCP server (one JSON-RPC 2.0 object per line) with
// four read-only tools. Through the real process and the replay engine: initialize, tools/list,
// jenny_ask under the launch policy (a tool outside it ends the turn denied, and the policy cannot
// be widened per call), sessions scoped to the workspace, cancellation of an in-flight and of a
// queued ask (no response, server still serving), protocol errors, and a clean shutdown on EOF.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { TOOLS } = require('../../cli/mcp-serve');
const { EXIT_CODES } = require('../../cli/exit-codes');

const ROOT = path.resolve(__dirname, '../..');
const MAIN = path.join(ROOT, 'cli/main.js');
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const LOCK_CHILD = path.join(ROOT, 'tests/helpers/cli-profile-lock-child.js');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cli-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'mcp fixture 9b1d');
  return { root, workspace, profile: path.join(root, 'profile') };
}

function replayScript(root, calls, extra = {}) {
  const file = path.join(root, `replay-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, calls, ...extra }));
  return file;
}

// A tiny MCP client over the child's stdio: requests resolve with their response; everything
// else (notifications, id-less errors) is collected.
function startServer(t, args, { dirs, replay }) {
  const child = spawn(process.execPath, [MAIN, 'mcp', 'serve', ...args], {
    cwd: dirs.workspace,
    env: { ...process.env, JENNY_PROFILE: dirs.profile, JENNY_REPLAY_SCRIPT: replay || '', JENNY_BACKEND_PYTHON: PYTHON, NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    // Ask for a clean stop first so the sidecar is closed by its owner; kill only if that fails.
    try { child.stdin.end(); } catch (_error) { /* closed */ }
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), settle(10_000)]);
    if (child.exitCode === null) child.kill();
  });
  const pending = new Map();
  const others = [];
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && message.id !== null && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      else others.push(message);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    const response = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return Object.assign(response, { id });
  };
  const call = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  };
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, request, call, notify, raw: (text) => child.stdin.write(`${text}\n`), pending, others, exit, stderr: () => stderr };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('mcp serve: initialize, the read-only tools, an ask on replay, sessions of this workspace, clean shutdown', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const replay = replayScript(dirs.root, [
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'fixture.txt' } }] },
    { text: 'The fixture says 9b1d.' },
  ]);
  const server = startServer(t, ['--engine', 'replay', '--allowed-tools', 'read_file'], { dirs, replay });

  const init = await server.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-03-26', 'a supported client version is echoed');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'jenny');
  server.notify('notifications/initialized');
  assert.deepEqual((await server.request('ping')).result, {});

  const listed = await server.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ['jenny_ask', 'jenny_session_read', 'jenny_sessions_list', 'jenny_status']);
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }

  let status = (await server.call('jenny_status', {})).structuredContent;
  assert.deepEqual([status.engine, status.engine_started, status.mode, status.allowed_tools, status.permission_mode], ['replay', false, 'read', ['read_file'], 'ask']);
  assert.equal((await server.call('jenny_sessions_list', {})).structuredContent.total, 0);

  const asked = await server.call('jenny_ask', { prompt: 'Read the fixture.' });
  assert.equal(asked.isError, false, JSON.stringify(asked).slice(0, 400));
  assert.match(asked.content[0].text, /9b1d/u);
  assert.equal(asked.structuredContent.subtype, 'success');
  assert.equal(asked.structuredContent.exit_code, 0);
  assert.deepEqual(asked.structuredContent.permission_denials, []);
  const sessionId = asked.structuredContent.session_id;
  assert.ok(sessionId);
  status = (await server.call('jenny_status', {})).structuredContent;
  assert.equal(status.engine_started, true);

  const sessions = (await server.call('jenny_sessions_list', {})).structuredContent;
  assert.deepEqual([sessions.total, sessions.sessions[0].id, sessions.sessions[0].current_workspace], [1, sessionId, true]);
  const read = (await server.call('jenny_session_read', { session_id: sessionId, limit: 10 })).structuredContent;
  assert.deepEqual(read.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant'], 'the tool call and its result are part of the session');
  assert.match(read.messages.at(-1).content, /9b1d/u);
  const continued = await server.call('jenny_ask', { prompt: 'Again.', continue: true });
  assert.equal(continued.structuredContent.session_id, sessionId, 'continue picks the latest session of this workspace');
  const resumed = await server.call('jenny_ask', { prompt: 'Once more.', session_id: sessionId, max_turns: 3, timeout_seconds: 30 });
  assert.equal(resumed.structuredContent.session_id, sessionId);
  assert.equal((await server.call('jenny_sessions_list', {})).structuredContent.total, 1);

  // The policy is fixed at launch: no per-call widening, no unknown tool, no unknown method.
  const widened = await server.request('tools/call', { name: 'jenny_ask', arguments: { prompt: 'x', allowed_tools: ['write_file'] } });
  assert.equal(widened.error.code, -32602);
  const missing = await server.request('tools/call', { name: 'jenny_session_read', arguments: { session_id: 'sess_nope' } });
  assert.equal(missing.error.code, -32602);
  assert.equal((await server.request('tools/call', { name: 'jenny_delete_everything', arguments: {} })).error.code, -32602);
  assert.equal((await server.request('resources/list')).error.code, -32601);
  server.raw('{not json');
  await settle(100);
  assert.ok(server.others.some((message) => message.error?.code === -32700), JSON.stringify(server.others));

  server.child.stdin.end();
  assert.equal(await server.exit, EXIT_CODES.OK, server.stderr());
  assert.match(server.stderr(), /\[mcp\] jenny .* serving 4 read-only tools/u);
});

test('mcp serve: a tool outside the launch policy ends the ask denied; cancellation drops the response and the server keeps serving', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const denied = replayScript(dirs.root, [
    { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'out.txt', content: 'never' } }] },
    { text: 'Wrote it.' },
  ]);
  const server = startServer(t, ['--engine', 'replay'], { dirs, replay: denied });
  await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const asked = await server.call('jenny_ask', { prompt: 'Write out.txt' });
  assert.equal(asked.isError, true);
  assert.equal(asked.structuredContent.subtype, 'denied');
  assert.equal(asked.structuredContent.exit_code, EXIT_CODES.POLICY_DENIED);
  assert.equal(asked.structuredContent.permission_denials[0].tool_name, 'write_file');
  assert.equal(fs.existsSync(path.join(dirs.workspace, 'out.txt')), false);
  server.child.stdin.end();
  assert.equal(await server.exit, EXIT_CODES.OK, server.stderr());

  // A slow replay (inter-event delay) makes the in-flight cancel deterministic.
  const slow = replayScript(dirs.root, [{ text: 'slow answer' }], { delay_ms: 1500 });
  const second = startServer(t, ['--engine', 'replay'], { dirs, replay: slow });
  await second.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const warm = await second.call('jenny_ask', { prompt: 'warm up' });
  assert.equal(warm.structuredContent.subtype, 'success');
  const before = (await second.call('jenny_sessions_list', {})).structuredContent.total;
  const inFlight = second.request('tools/call', { name: 'jenny_ask', arguments: { prompt: 'cancel me' } });
  await settle(300);
  second.notify('notifications/cancelled', { requestId: inFlight.id, reason: 'test' });
  // A queued ask cancelled before it starts never runs either.
  const queued = second.request('tools/call', { name: 'jenny_ask', arguments: { prompt: 'never runs' } });
  second.notify('notifications/cancelled', { requestId: queued.id });
  const after = await second.call('jenny_ask', { prompt: 'after the cancel' });
  assert.equal(after.structuredContent.subtype, 'success', JSON.stringify(after).slice(0, 300));
  assert.match(after.content[0].text, /slow answer/u);
  assert.ok(second.pending.has(inFlight.id), 'the cancelled in-flight ask got no response');
  assert.ok(second.pending.has(queued.id), 'the cancelled queued ask got no response');
  assert.match(second.stderr(), /\[cancel\] SIGINT/u);
  assert.equal((await second.call('jenny_sessions_list', {})).structuredContent.total, before + 2, 'the cancelled turn and the one after; the queued one never started');
  second.child.stdin.end();
  assert.equal(await second.exit, EXIT_CODES.OK, second.stderr());

  // The profile lock holds for the server too.
  const holder = spawn(process.execPath, [LOCK_CHILD, dirs.profile, PYTHON], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const busy = startServer(t, ['--engine', 'replay'], { dirs, replay: slow });
  assert.equal(await busy.exit, EXIT_CODES.PROFILE_BUSY, busy.stderr());
  holder.stdin.end();
  await new Promise((resolve) => holder.once('exit', resolve));
});
