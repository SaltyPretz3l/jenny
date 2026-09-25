'use strict';
const path = require('node:path');
const { RuntimeStore } = require('../../services/session-runtime/store');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

class MemoryIO {
  constructor() {
    this.files = new Map();
    this.reads = [];
    this.writes = [];
    this.failWrite = null;
    this.failRemove = false;
  }

  readJson(filePath) {
    this.reads.push(filePath);
    if (!this.files.has(filePath)) return { status: 'missing' };
    const value = this.files.get(filePath);
    if (value === MemoryIO.CORRUPT) return { status: 'corrupt', error: new Error('corrupt') };
    return { status: 'ok', value: clone(value) };
  }

  writeJsonAtomic(filePath, value) {
    this.writes.push(filePath);
    if (this.failWrite?.(filePath, value)) throw new Error('injected write failure');
    this.files.set(filePath, clone(value));
  }

  listJson(directory) {
    const prefix = `${directory}${path.sep}`;
    return [...this.files.keys()].filter((entry) => entry.startsWith(prefix)
      && entry.slice(prefix.length).endsWith('.json'));
  }

  remove(filePath) {
    if (this.failRemove) throw new Error('injected remove failure');
    this.files.delete(filePath);
  }
}
MemoryIO.CORRUPT = Symbol('corrupt');

function harness(io = new MemoryIO(), overrides = {}) {
  let id = 0;
  let time = Date.parse('2026-09-09T00:00:00.000Z');
  const store = new RuntimeStore('RUNTIME', { io,
    createId: (prefix) => `${prefix}_${++id}`,
    now: () => new Date(time += 1000), ...overrides });
  return { io, store };
}

function authority(projectId = 'project_alpha') {
  return { project_id: projectId, root_path: 'G:\\workspace', root_id: 'root_alpha',
    root_revision: 3, device_id: '11', inode: '22' };
}

function submission(overrides = {}) {
  return { idempotencyKey: 'submit_1', projectId: 'project_alpha', sessionId: 'session_alpha',
    purpose: 'chat_turn', input: { prompt: 'hello' }, authority: authority(), ...overrides };
}

function attempt(number) {
  return { attempt_id: `attempt_${number}`, stream_id: `stream_${number}`,
    incarnation: `host_${number}`, authority_revision: `authority_${number}` };
}

module.exports = { clone, MemoryIO, harness, authority, submission, attempt };
