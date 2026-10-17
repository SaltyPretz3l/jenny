'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CodexAppServerClient } = require('../services/codex-app-server-client');

function fixture(t, onRequest, timeoutMs = 100) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  child.stdin.on('end', () => child.emit('exit', 0));
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const row = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      onRequest(row, child);
    }
  });
  const client = new CodexAppServerClient({ executable: 'native-codex.exe', timeoutMs,
    spawnImpl: (exe, args, options) => {
      assert.equal(exe, 'native-codex.exe');
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      assert.ok(args.includes('mcp_servers={}')); return child;
    } });
  t.after(() => client.dispose());
  return { child, client };
}
test('normal handshake, fragmented UTF-8 framing, notifications-before-response and unexpected request denial', async (t) => {
  const denied = [];
  const { client } = fixture(t, (row, child) => {
    if (row.method === 'initialize') child.stdout.write(JSON.stringify({ id: row.id, result: {} }) + '\n');
    if (row.method === 'thread/read') {
      child.stdout.write('{"id":901,"method":"item/commandExecution/requestApproval","params":{}}\n');
      child.stdout.write('{"method":"externalAgentConfig/import/completed","params":{"importId":"import","itemTypeResults":[]}}\n');
      const bytes = Buffer.from(JSON.stringify({ id: row.id, result: { title: '💛' } }) + '\n');
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    }
    if (row.error) denied.push(row);
  });
  await client.initialize();
  assert.deepEqual(await client.request('thread/read', {}), { title: '💛' });
  assert.equal(denied[0].id, 901);
  assert.equal((await client.importCompleted('import')).importId, 'import');
  assert.throws(() => client.request('turn/start', {}), { reason: 'invalid_request' });
});
test('missing/older API, malformed output and stalled process fail with structured reasons', async (t) => {
  const { client } = fixture(t, () => {}, 15);
  await assert.rejects(client.request('initialize', {}), { reason: 'codex_timeout' });
  const other = fixture(t, (_row, child) => child.stdout.write('not json\n'));
  await assert.rejects(other.client.request('initialize', {}), { reason: 'codex_invalid_output' });
  const older = fixture(t, (row, child) => child.stdout.write(JSON.stringify({ id: row.id, error: { code: -32601, message: 'private detail' } }) + '\n'));
  await assert.rejects(older.client.request('thread/read'), (error) => error.reason === 'codex_api_error' && !error.message.includes('private detail'));
});
test('non-object JSON lines abort with codex_invalid_output without escaping the stdout listener', async (t) => {
  const escaped = [];
  const onUncaught = (error) => escaped.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  for (const line of ['null', '42', '[]', '"x"', 'true']) {
    const { client } = fixture(t, (_row, child) => child.stdout.write(line + '\n'), 500);
    await assert.rejects(client.request('initialize', {}), { reason: 'codex_invalid_output' }, line);
    assert.equal(client.closed, true, line);
  }
  const valid = fixture(t, (row, child) => child.stdout.write(JSON.stringify({ id: row.id, result: { ok: 1 } }) + '\n'));
  assert.deepEqual(await valid.client.request('initialize', {}), { ok: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(escaped, []);
});
