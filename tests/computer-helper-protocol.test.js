'use strict';

// The jenny-computer protocol module and the fake helper that speaks it
// (rows 196 and 197, orchestration step F2).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const protocol = require('../services/computer-helper/protocol');

const FAKE = path.join(__dirname, 'fixtures', 'fake-computer-helper.js');

function decodeAll(chunks, opts = {}) {
  const messages = [];
  const errors = [];
  const decoder = protocol.createLineDecoder({
    onMessage: (m) => messages.push(m),
    onError: (e) => errors.push(e),
    ...opts,
  });
  for (const chunk of chunks) decoder.push(chunk);
  decoder.end();
  return { messages, errors };
}

test('encodeRequest writes one line with id, op and the arguments', () => {
  const line = protocol.encodeRequest(7, 'run.stop', { run_id: 'r1', close_timeout_ms: 2000 });
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.deepEqual(JSON.parse(line), { id: 7, op: 'run.stop', run_id: 'r1', close_timeout_ms: 2000 });
});

test('encodeRequest refuses unknown ops, bad ids, id/op in args and oversize lines', () => {
  assert.throws(() => protocol.encodeRequest(1, 'format.disk'), TypeError);
  assert.throws(() => protocol.encodeRequest(-1, 'hello'), TypeError);
  assert.throws(() => protocol.encodeRequest(1.5, 'hello'), TypeError);
  assert.throws(() => protocol.encodeRequest(1, 'hello', { op: 'shutdown' }), TypeError);
  assert.throws(() => protocol.encodeRequest(1, 'hello', []), TypeError);
  assert.throws(() => protocol.encodeRequest(1, 'run.start', { env: { A: 'x'.repeat(70 * 1024) } }), RangeError);
  assert.doesNotThrow(() => protocol.encodeRequest(1, 'input.click'));
});

test('the decoder joins split chunks, skips blanks and tells replies from events', () => {
  const { messages, errors } = decodeAll([
    '{"id":1,"ok":true,"res',
    'ult":{"protocol":1}}\r\n\n{"event":"run.exited","run_id":"r1","exit_code":0}\n',
    Buffer.from('{"id":null,"ok":false,"error":{"code":"bad_request","message":"x"}}'),
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(messages, [
    { kind: 'reply', id: 1, ok: true, result: { protocol: 1 } },
    { kind: 'event', name: 'run.exited', fields: { run_id: 'r1', exit_code: 0 } },
    { kind: 'reply', id: null, ok: false, error: { code: 'bad_request', message: 'x' } },
  ]);
});

test('the decoder drops an overlong line, bad JSON and unknown shapes, and goes on', () => {
  const { messages, errors } = decodeAll(
    ['x'.repeat(40), 'y'.repeat(40), '\nnot json\n[1]\n{"id":2,"ok":false,"error":{"code":"weird"}}\n'],
    { maxLineBytes: 64 },
  );
  assert.deepEqual(errors, ['line_too_long', 'not_json', 'unrecognised']);
  assert.deepEqual(messages, [{ kind: 'reply', id: 2, ok: false, error: { code: 'internal', message: '' } }]);
});

test('a refused reply keeps a known reason; an unknown reason reads as unidentified; other codes carry none', () => {
  const refused = (reason) => protocol.classifyMessage({ id: 3, ok: false, error: { code: 'refused', reason, message: 'm' } });
  assert.deepEqual(refused('elevated').error, { code: 'refused', message: 'm', reason: 'elevated' });
  assert.equal(refused('format_disk').error.reason, 'unidentified');
  assert.equal(refused(undefined).error.reason, 'unidentified');
  const other = protocol.classifyMessage({ id: 4, ok: false, error: { code: 'no_such_run', reason: 'elevated', message: '' } });
  assert.equal(Object.hasOwn(other.error, 'reason'), false);
  assert.ok(protocol.RESERVED_INPUT_OPS.includes('input.focus') && protocol.RESERVED_INPUT_OPS.includes('watch.state'));
  assert.ok(protocol.EVENTS.includes('watch.stop_chord'));
});

test('window handles map to Electron capture source ids; run ids follow the alphabet', () => {
  assert.equal(protocol.sourceIdForHwnd(0x907d0), 'window:591824:0');
  assert.throws(() => protocol.sourceIdForHwnd(0), TypeError);
  assert.equal(protocol.isValidRunId('run_1-A'), true);
  assert.equal(protocol.isValidRunId('r/1'), false);
  assert.equal(protocol.isValidRunId('a'.repeat(65)), false);
});

function startFake(env = {}) {
  const child = spawn(process.execPath, [FAKE, '--serve'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  const messages = [];
  const waiters = [];
  const decoder = protocol.createLineDecoder({
    onMessage: (m) => {
      messages.push(m);
      for (const w of [...waiters]) {
        if (w.match(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    },
  });
  child.stdout.on('data', (chunk) => decoder.push(chunk));
  let nextId = 1;
  const waitFor = (match) => new Promise((resolve) => {
    const seen = messages.find(match);
    if (seen) resolve(seen);
    else waiters.push({ match, resolve });
  });
  const request = (op, args) => {
    const id = nextId++;
    child.stdin.write(protocol.encodeRequest(id, op, args));
    return waitFor((m) => m.kind === 'reply' && m.id === id);
  };
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, request, waitFor, exited };
}

test('the fake helper runs one start, window event, stop and shutdown exchange', async () => {
  const fake = startFake({ FAKE_COMPUTER_HELPER: JSON.stringify({ windowDelayMs: 5 }) });
  try {
    const hello = await fake.request('hello');
    assert.equal(hello.result.protocol, protocol.PROTOCOL);
    assert.equal(hello.result.built.input, false);

    const program = path.resolve(path.sep, 'games', 'client.exe');
    const started = await fake.request('run.start', {
      run_id: 'r1', program, args: [], cwd: path.dirname(program), env: {},
    });
    assert.equal(started.ok, true);
    assert.equal(started.result.run_id, 'r1');

    const windowEvent = await fake.waitFor((m) => m.kind === 'event' && m.name === 'run.window');
    assert.equal(windowEvent.fields.source_id, protocol.sourceIdForHwnd(windowEvent.fields.hwnd));

    const again = await fake.request('run.start', {
      run_id: 'r1', program, args: [], cwd: path.dirname(program), env: {},
    });
    assert.equal(again.error.code, 'run_exists');

    const click = await fake.request('input.click');
    assert.equal(click.error.code, 'not_built');

    const stopped = await fake.request('run.stop', { run_id: 'r1' });
    assert.deepEqual(stopped.result, { run_id: 'r1', how: 'closed', exit_code: 0 });
    const exitedEvent = await fake.waitFor((m) => m.kind === 'event' && m.name === 'run.exited');
    assert.equal(exitedEvent.fields.run_id, 'r1');

    const shutdown = await fake.request('shutdown');
    assert.equal(shutdown.ok, true);
    assert.equal(await fake.exited, 0);
  } finally {
    if (fake.child.exitCode === null) fake.child.kill();
  }
});

test('the fake helper answers like a helper off Windows when told to', async () => {
  const fake = startFake({ FAKE_COMPUTER_HELPER: JSON.stringify({ available: false }) });
  try {
    const hello = await fake.request('hello');
    assert.equal(hello.result.available, false);
    const list = await fake.request('run.list');
    assert.equal(list.error.code, 'not_available');
    fake.child.stdin.end();
    assert.equal(await fake.exited, 0);
  } finally {
    if (fake.child.exitCode === null) fake.child.kill();
  }
});
