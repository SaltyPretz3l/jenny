'use strict';

const http = require('node:http');

const port = Number(process.argv[2]);
const password = process.argv[3];
const canonicalOrigin = 'https://jenny.test';
const baseHeaders = { Host: 'jenny.test', Origin: canonicalOrigin };

if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !password) {
  throw new Error('Usage: node probe-host-container.js PORT PASSWORD');
}

function request({ method = 'GET', path, headers = {}, body = null, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, method, path,
      headers: { ...baseHeaders, ...headers, ...(payload ? {
        'Content-Type': 'application/json', 'Content-Length': payload.length,
      } : {}) } }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 64 * 1024) req.destroy(new Error('probe_response_limit'));
        else chunks.push(chunk);
      });
      response.once('end', () => resolve({ status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('probe_timeout')));
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(result, expectedStatus = 200) {
  if (result.status !== expectedStatus) throw new Error(`unexpected_status_${result.status}`);
  try { return JSON.parse(result.body); } catch (_error) {
    throw new Error('invalid_probe_json', { cause: _error });
  }
}

async function waitForReadiness() {
  const deadline = Date.now() + 60_000;
  let lastError = new Error('ready_probe_not_started');
  while (Date.now() < deadline) {
    try {
      const response = await request({ path: '/readyz', timeoutMs: 2_000 });
      const body = parseJson(response);
      if (body.ready === true) return;
      lastError = new Error('ready_false');
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError;
}

function readOneSseFrame(headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/v1/events',
      headers: { ...baseHeaders, ...headers } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`sse_status_${response.statusCode}`)); return;
      }
      let source = '';
      response.on('data', (chunk) => {
        source += chunk.toString('utf8');
        if (source.length > 64 * 1024) req.destroy(new Error('sse_frame_limit'));
        const boundary = source.indexOf('\n\n');
        if (boundary < 0) return;
        const frame = source.slice(0, boundary);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!data) { req.destroy(new Error('sse_data_missing')); return; }
        let payload;
        try { payload = JSON.parse(data.slice(6)); } catch (_error) {
          req.destroy(new Error('sse_json_invalid')); return;
        }
        if (payload.api_version !== 1 || typeof payload.boot_epoch !== 'string'
          || typeof payload.event_type !== 'string') {
          req.destroy(new Error('sse_contract_invalid')); return;
        }
        resolve(payload);
        req.destroy();
      });
    });
    req.setTimeout(5_000, () => req.destroy(new Error('sse_timeout')));
    req.once('error', reject);
  });
}

async function main() {
  await waitForReadiness();
  const login = await request({ method: 'POST', path: '/api/v1/auth/login', body: { password } });
  const loginBody = parseJson(login);
  if (loginBody.ok !== true || typeof loginBody.csrf_token !== 'string') throw new Error('login_contract_invalid');
  const setCookie = Array.isArray(login.headers['set-cookie'])
    ? login.headers['set-cookie'][0] : login.headers['set-cookie'];
  const cookie = String(setCookie || '').split(';', 1)[0];
  if (!cookie.startsWith('__Host-jenny=')) throw new Error('login_cookie_missing');
  const authHeaders = { Cookie: cookie, 'X-CSRF-Token': loginBody.csrf_token };
  const bootstrap = parseJson(await request({ path: '/api/v1/bootstrap', headers: authHeaders }));
  if (bootstrap.ok !== true || bootstrap.ready !== true || bootstrap.tools?.execution !== false) {
    throw new Error('bootstrap_contract_invalid');
  }
  const client = parseJson(await request({ method: 'POST', path: '/api/v1/clients', headers: authHeaders }));
  if (typeof client.client_id !== 'string' || typeof client.client_token !== 'string') {
    throw new Error('client_contract_invalid');
  }
  await readOneSseFrame({ Cookie: cookie, 'X-Client-Id': client.client_id,
    'X-Client-Token': client.client_token });
  process.stdout.write('Fresh-volume hosted container smoke passed.\n');
}

main().catch((error) => {
  process.stderr.write(`Hosted container smoke failed: ${error.message}\n`);
  process.exitCode = 1;
});
