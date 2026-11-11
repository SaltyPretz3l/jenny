'use strict';

// Team slice 1c-2a: the team host has no browser surface. Static files, health
// and readiness probes, login, logout, sessions and the cookie bootstrap do not
// exist in team mode, and nothing is answered without a valid preamble.

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { createTeamHttpFixture } = require('./helpers/team-http-fixture');

const ABSENT = [
  ['GET', '/healthz'], ['GET', '/readyz'], ['GET', '/'], ['GET', '/app.js'], ['GET', '/styles.css'],
  ['GET', '/locales/en.json'], ['POST', '/api/v1/auth/login'], ['POST', '/api/v1/auth/logout'],
  ['GET', '/api/v1/auth/sessions'], ['POST', '/api/v1/auth/revoke'], ['GET', '/api/v1/bootstrap'],
];

test('an active member finds none of the single-owner routes', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { member } = await env.seed();
  const client = env.client(member.key);
  assert.equal((await client.hello()).status, 200);
  for (const [method, path] of ABSENT) {
    const body = method === 'POST' ? { password: 'x' } : undefined;
    const response = await client.request(method, path, { body });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(response.json.error.reason, 'route_not_found', `${method} ${path}`);
    assert.equal(response.headers['set-cookie'], undefined, `${method} ${path}`);
  }
});

test('the team host answers nothing at all on the same routes without a valid preamble', async (t) => {
  const env = await createTeamHttpFixture(t);
  await env.seed();
  for (const [method, path] of ABSENT) {
    const socket = net.connect({ host: '127.0.0.1', port: env.port });
    const received = [];
    socket.on('data', (chunk) => received.push(chunk));
    socket.on('error', () => {});
    const closed = new Promise((resolve) => socket.on('close', resolve));
    // Long enough that the 72-byte preamble check decides at once instead of waiting.
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: jenny-team.invalid\r\nContent-Length: 0\r\nX-Pad: ${'a'.repeat(60)}\r\n\r\n`);
    await closed;
    assert.equal(Buffer.concat(received).length, 0, `${method} ${path}`);
  }
});

test('the team host sets no cookie on any answer', async (t) => {
  const env = await createTeamHttpFixture(t);
  const { owner } = await env.seed();
  const client = env.client(owner.key);
  const answers = [await client.hello(), await client.request('POST', '/api/v1/team/status'),
    await client.request('GET', '/api/v1/team/bootstrap'), await client.request('POST', '/api/v1/clients')];
  for (const answer of answers) {
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['set-cookie'], undefined);
  }
});
