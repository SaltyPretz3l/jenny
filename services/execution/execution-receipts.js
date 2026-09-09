'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { sandboxError } = require('./sandbox-errors');
const MAX_BYTES = 8 * 1024 * 1024;
function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(fs.realpathSync(directory)) !== path.resolve(directory)) {
    throw sandboxError('receipt_directory_invalid');
  }
}
function read(file, encoding = 'utf8') {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw sandboxError('receipt_invalid');
    return fs.readFileSync(fd, encoding);
  } finally { fs.closeSync(fd); }
}
class ExecutionReceipts {
  constructor(directory) {
    ensurePrivateDirectory(directory);
    this.directory = directory;
    this.file = path.join(directory, 'execution.jsonl');
    this.records = [];
    this.invalid = false;
    try {
      const text = read(this.file);
      if (text && !text.endsWith('\n')) throw sandboxError('receipt_torn');
      this.records = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      if (this.records.some((item) => item.schema_version !== 1 || !['admitted','terminal','reconciled'].includes(item.kind)
        || typeof item.binding !== 'object' || !item.binding || !item.binding.request_id)) throw sandboxError('receipt_invalid');
    } catch (error) { if (error.code !== 'ENOENT') this.invalid = true; }
    // Resource discovery must survive missing or torn journal/identity files.
    const canonical = fs.realpathSync(directory);
    this.ownerId = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex').slice(0, 32);
  }
  append(kind, binding, result = null) {
    if (this.invalid) throw sandboxError('receipt_recovery_required');
    const item = { schema_version: 1, kind, binding, result, recorded_at: new Date().toISOString() };
    const line = JSON.stringify(item) + '\n';
    const fd = fs.openSync(this.file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size + Buffer.byteLength(line) > MAX_BYTES) throw sandboxError('receipt_limit');
      fs.writeFileSync(fd, line);
      fs.fsyncSync(fd);
      if (process.platform !== 'win32') {
        const dirFd = fs.openSync(this.directory, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
      this.records.push(item);
    } catch (error) { this.invalid = true; throw error; }
    finally { fs.closeSync(fd); }
  }
  compact() {
    if (this.invalid || this.pending().length || this.records.length <= 256) return;
    const retained = this.records.slice(-256);
    const temp = path.join(this.directory, 'execution-next.jsonl');
    if (fs.existsSync(temp)) { read(temp); fs.unlinkSync(temp); }
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, retained.map((item) => JSON.stringify(item)).join('\n') + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    const published = fs.openSync(this.file, 'r+');
    try { fs.fsyncSync(published); } finally { fs.closeSync(published); }
    this.records = retained;
  }
  recoverCorrupt({ cleanupConfirmed }) {
    if (!this.invalid) return;
    if (cleanupConfirmed !== true) throw sandboxError('sandbox_cleanup_unconfirmed');
    // Rotate two bounded forensic copies only after Docker proved all owned
    // namespaces ended; unresolved execution is never evicted here.
    const archive = path.join(this.directory, 'execution-corrupt.jsonl');
    const older = path.join(this.directory, 'execution-corrupt-previous.jsonl');
    if (fs.existsSync(this.file)) {
      read(this.file, null);
      if (fs.existsSync(archive)) {
        read(archive, null);
        if (fs.existsSync(older)) { read(older, null); fs.unlinkSync(older); }
        fs.renameSync(archive, older);
      }
      fs.renameSync(this.file, archive);
      const archived = fs.openSync(archive, 'r+');
      try { fs.fsyncSync(archived); } finally { fs.closeSync(archived); }
    }
    this.records = [];
    this.invalid = false;
    this.append('reconciled', { request_id: 'corrupt-' + randomBytes(16).toString('hex') },
      { status: 'interrupted', cleanup_confirmed: true, outcome: 'unknown' });
  }
  pending() {
    const pending = new Map();
    for (const item of this.records) {
      if (item.kind === 'admitted') pending.set(item.binding.request_id, item);
      else pending.delete(item.binding.request_id);
    }
    return [...pending.values()];
  }
  seen(requestId) { return this.records.some((item) => item.binding.request_id === requestId); }
}
module.exports = { ExecutionReceipts };