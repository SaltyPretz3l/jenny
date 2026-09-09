'use strict';

// Small, deterministic OpenAI-compatible model used by the localhost sandbox
// packaging probe. It deliberately keeps request handling bounded and never
// prints request bodies, prompts, credentials, or tool output.

const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_PORT = 8000;
const MAX_BODY_BYTES = 1024 * 1024;
const MODEL_ID = 'sandbox-fixture';
const API_KEY = 'setup-fixture-api-key';

function parsePort(value) {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('fixture model port must be an integer between 1 and 65535');
  }
  return port;
}

function bearerAccepted(request) {
  const header = String(request.headers.authorization || '');
  return !header || header === `Bearer ${API_KEY}`;
}

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_error) {
        reject(Object.assign(new Error('request body must be JSON'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return typeof part?.text === 'string' ? part.text : '';
  }).join(' ');
}

function latestUserPrompt(messages) {
  const users = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'user');
  return users.length ? contentText(users[users.length - 1].content) : '';
}

function hasToolResult(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  let latestUserIndex = -1;
  rows.forEach((message, index) => {
    if (message?.role === 'user') latestUserIndex = index;
  });
  return rows.slice(latestUserIndex + 1).some((message) => (
    message?.role === 'tool' && typeof contentText(message.content) === 'string'
  ));
}

function scenarioFor(body) {
  const prompts = latestUserPrompt(body?.messages);
  if (prompts.includes('sandbox approve')) return 'approve';
  if (prompts.includes('sandbox deny')) return 'deny';
  if (prompts.includes('sandbox cancel')) return 'cancel';
  return 'plain';
}

function toolCallFor(scenario) {
  const command = scenario === 'approve'
    ? 'printf sandbox-proof'
    : scenario === 'cancel'
      ? 'sleep 90'
      : 'printf sandbox-denied-marker';
  return {
    id: `sandbox-call-${crypto.randomUUID()}`,
    type: 'function',
    function: {
      name: 'run_command',
      arguments: JSON.stringify({
        command,
        cwd: '.',
        timeout_seconds: 120,
      }),
    },
  };
}

function completionId() {
  return `sandbox-chat-${crypto.randomUUID()}`;
}

function completionPayload(scenario, messages) {
  const id = completionId();
  if (scenario !== 'plain' && !hasToolResult(messages)) {
    return {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [toolCallFor(scenario)] },
        finish_reason: 'tool_calls',
      }],
    };
  }
  const text = scenario === 'approve'
    ? 'Sandbox command completed: sandbox-proof.'
    : scenario === 'deny'
      ? 'Sandbox command was denied; no command result was produced.'
      : scenario === 'cancel'
        ? 'Sandbox command turn was cancelled.'
        : 'Sandbox fixture response.';
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
  };
}

function streamPayload(response, payload) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const choice = payload.choices[0];
  const chunkBase = {
    id: payload.id,
    object: 'chat.completion.chunk',
    created: payload.created,
    model: payload.model,
  };
  const write = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  if (choice.message.tool_calls) {
    write({ ...chunkBase, choices: [{ index: 0, delta: {
      role: 'assistant', tool_calls: choice.message.tool_calls.map((call) => ({
        index: 0, id: call.id, type: call.type, function: call.function,
      })),
    }, finish_reason: null }] });
    write({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    write({ ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    write({ ...chunkBase, choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }] });
    write({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

function handle(request, response) {
  if (!bearerAccepted(request)) {
    json(response, 401, { error: { message: 'invalid fixture credentials', type: 'authentication_error' } });
    return;
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    json(response, 200, {
      object: 'list',
      data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'sandbox-fixture' }],
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    json(response, 404, { error: { message: 'fixture route not found', type: 'invalid_request_error' } });
    return;
  }
  requestBody(request).then((body) => {
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      json(response, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
      return;
    }
    const payload = completionPayload(scenarioFor(body), body.messages);
    if (body.stream === true) streamPayload(response, payload);
    else json(response, 200, payload);
  }).catch((error) => {
    if (response.writableEnded || response.destroyed) return;
    json(response, error.statusCode === 413 ? 413 : 400, {
      error: { message: error.statusCode === 413 ? 'request body too large' : 'invalid fixture request', type: 'invalid_request_error' },
    });
  });
}

function main() {
  const port = parsePort(process.argv[2]);
  const server = http.createServer(handle);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(port, '0.0.0.0');
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = Object.freeze({
  MAX_BODY_BYTES,
  MODEL_ID,
  completionPayload,
  parsePort,
  scenarioFor,
});
