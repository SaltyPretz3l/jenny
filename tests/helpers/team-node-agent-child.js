'use strict';

// The second process of tests/team-two-process.test.js: a member's node agent with
// the real team HTTP client, team session, node link and agent, beside a scripted SSE
// engine on its own loopback port. It holds no device key and no host secret: it
// speaks the member preamble to the test's bridge stand-in, whose per-launch secret
// arrives over the IPC channel (never argv or the environment). The parent drives it
// with { id, type } messages and ends it by its own handle.

const crypto = require('node:crypto');
const http = require('node:http');

const { createTeamHttp } = require('../../services/team/http-client');
const { createTeamSession } = require('../../services/team/team-session');
const { createNodeAgent } = require('../../services/team/node/node-agent');
const { createNodeLink } = require('../../services/team/node/node-link');

const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const engineLog = [];
const held = [];
let script = { mode: 'stream', marker: '' };
let agent = null;
let teamHttp = null;
let engine = null;

function startEngine() {
  return new Promise((resolve) => {
    engine = http.createServer((req, res) => {
      const parts = [];
      req.on('data', (part) => parts.push(part));
      req.on('end', () => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'alpha' }] }));
          return;
        }
        const body = Buffer.concat(parts);
        engineLog.push({ event: 'request', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'),
          marker: script.marker !== '' && body.includes(script.marker) });
        res.on('close', () => { if (!res.writableFinished) engineLog.push({ event: 'aborted' }); });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (script.mode === 'hold') { res.write(sse('first')); held.push(res); return; }
        res.end(`${sse('one ')}${sse('two ')}${sse(`three ${script.marker}`)}data: [DONE]\n\n`);
      });
    });
    engine.listen(0, '127.0.0.1', () => resolve(engine.address().port));
  });
}

async function start({ bridgePort, launchSecret, protocolVersion }) {
  const enginePort = await startEngine();
  teamHttp = createTeamHttp({ port: bridgePort, launchSecret: Buffer.from(launchSecret, 'hex') });
  const session = createTeamSession({ http: teamHttp, appVersion: 'two-process-test' });
  const hello = await session.hello();
  if (hello.ok !== true) return { ok: false, step: 'hello', reason: hello.error?.reason };
  const registered = await session.registerClient();
  const boot = await session.bootstrap();
  if (registered.ok !== true || boot.ok !== true) return { ok: false, step: 'client' };
  const record = { client_id: registered.client_id, client_token: registered.client_token, boot_epoch: boot.boot_epoch };
  const link = createNodeLink({ http: teamHttp, client: () => record, hello: session.hello });
  agent = createNodeAgent({ link, resolveEngineUrl: () => `http://127.0.0.1:${enginePort}`, isBusy: () => false,
    ...(protocolVersion === undefined ? {} : { protocolVersion }) });
  const started = await agent.start();
  return { ok: true, started, status: agent.status() };
}

async function handle(message) {
  switch (message.type) {
    case 'start': return start(message);
    case 'script': script = { ...script, ...message.script }; return { ok: true };
    case 'write': for (const res of held) res.write(sse(message.text)); return { ok: true };
    case 'status': return { ok: true, status: agent ? agent.status() : null, engine: engineLog };
    case 'stop': {
      if (agent) await agent.stop();
      for (const res of held.splice(0)) res.destroy();
      teamHttp?.dispose();
      await new Promise((resolve) => { if (engine) engine.close(() => resolve()); else resolve(); });
      return { ok: true, status: agent ? agent.status() : null };
    }
    default: return { ok: false, reason: 'unknown_message' };
  }
}

process.on('message', (message) => {
  // The node's process ends mid-answer, with nothing sent to the host first.
  if (message.type === 'die') process.exit(0);
  handle(message).then((answer) => process.send({ id: message.id, ...answer }),
    (error) => process.send({ id: message.id, ok: false, reason: String(error?.reason || 'child_error') }));
});
