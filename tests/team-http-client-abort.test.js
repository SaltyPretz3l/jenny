'use strict';

// new-test-file: row 123 slice 6-5 http client, part calls with a signal already aborted (tests/team-http-client.test.js
// is at its line cap): putPart and getPart refuse at once as team_request_aborted and leave no uncaught socket error
// behind (before the fix the destroyed request's "socket hang up" ended the process). The request object is made
// before the abort check, so a loopback dial may start and is destroyed at once.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const test = require('node:test');

const { createTeamHttp } = require('../services/team/http-client');

const launchSecret = new Uint8Array(crypto.randomBytes(32));
const PART_PATH = `/api/v1/team/models/transfers/mxfer_${'a'.repeat(22)}/files/0/parts/0`;

test('a model part PUT or GET with a signal already aborted refuses at once and leaves no uncaught error', async (t) => {
  const server = net.createServer((socket) => { socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  const http = createTeamHttp({ port: server.address().port, launchSecret });
  t.after(() => http.dispose());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(http.putPart(PART_PATH, Buffer.alloc(16), { signal: controller.signal }),
    (error) => error.reason === 'team_request_aborted');
  await assert.rejects(http.getPart(PART_PATH, { signal: controller.signal }), (error) => error.reason === 'team_request_aborted');
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.deepEqual(uncaught, []);
});
