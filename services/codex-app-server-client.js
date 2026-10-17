'use strict';

const { StringDecoder } = require('node:string_decoder');
const { spawn } = require('node:child_process');
const { resolveCodexCommandPath } = require('./backend/backend-service');
const { fail } = require('./conversation-transfer-contract');

const METHODS = new Set(['initialize', 'thread/list', 'thread/read', 'thread/resume',
  'thread/name/set', 'thread/inject_items', 'externalAgentConfig/detect',
  'externalAgentConfig/import', 'externalAgentConfig/import/readHistories']);
const MAX_LINE_BYTES = 64 * 1024 * 1024;

class CodexAppServerClient {
  constructor({ env = process.env, cwd, spawnImpl = spawn, timeoutMs = 30000, executable } = {}) {
    this.pending = new Map();
    this.notifications = [];
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.sequence = 0;
    this.receivedBytes = 0;
    this.exited = false;
    this.closed = false;
    this.timeoutMs = timeoutMs;
    try {
      this.child = spawnImpl(executable || resolveCodexCommandPath('codex', env),
        ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}'],
        { env, cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (_error) {
      fail('codex_unavailable', 'The native Codex app server could not start.');
    }
    this.exitPromise = new Promise((resolve) => this.child.once('exit', () => { this.exited = true; resolve(); }));
    this.child.stdin.on('error', () => this.abort('codex_write_failed'));
    this.child.stdout.on('data', (chunk) => this.receive(chunk));
    // Drain diagnostics without exposing provider/config/credential material.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.abort('codex_unavailable'));
    this.child.on('exit', () => this.abort('codex_exited'));
  }
  abort(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error('Codex stopped before the request completed.'), { reason }));
    }
    this.pending.clear();
    this.child?.kill?.();
  }
  receive(chunk) {
    this.receivedBytes += chunk.length;
    if (this.receivedBytes > 96 * 1024 * 1024) return this.abort('codex_output_limit');
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) return this.abort('codex_output_limit');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (_error) { return this.abort('codex_invalid_output'); }
      // A JSON-RPC envelope is always an object; null, primitives and arrays are malformed output.
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.abort('codex_invalid_output');
      if (message.method && message.id != null) {
        this.child.stdin.write(JSON.stringify({ id: message.id,
          error: { code: -32601, message: 'Conversation transfer does not execute server requests.' } }) + '\n');
      } else if (message.id != null) {
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) entry.reject(Object.assign(new Error('Codex refused the transfer request.'), { reason: 'codex_api_error' }));
        else entry.resolve(message.result);
      } else if (message.method === 'externalAgentConfig/import/completed') {
        this.notifications.push(message);
        if (this.notifications.length > 32) this.notifications.shift();
      }
    }
  }
  request(method, params = {}) {
    if (!METHODS.has(method)) fail('invalid_request', 'This Codex operation is unavailable during transfer.');
    if (this.closed) fail('codex_exited', 'The Codex app server is closed.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Codex did not complete the request in time.'), { reason: 'codex_timeout' }));
        this.abort('codex_timeout');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) this.abort('codex_write_failed');
      });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'jenny_conversation_transfer', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return this;
  }
  async importCompleted(importId) {
    const deadline = Date.now() + this.timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      const found = this.notifications.find((item) => item.params?.importId === importId);
      if (found) return found.params;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fail('codex_timeout', 'Codex import completion is unknown. Retry to reconcile it.');
  }
  async dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error('Conversation transfer closed.'), { reason: 'disposed' }));
    }
    this.pending.clear();
    if (this.exited) return;
    this.disposePromise = new Promise((resolve) => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 1500);
      this.exitPromise.then(() => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
    return this.disposePromise;
  }
}
module.exports = { CodexAppServerClient };
