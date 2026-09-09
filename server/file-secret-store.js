'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_SECRET_BYTES = 16_384;
const SECRET_FILES = Object.freeze({ openai_compatible_api_key: 'model-api-key' });

// Operator-provisioned, read-only files. No environment/config fallback and no
// writable SecureStore facade; desktop safeStorage remains a separate owner.
class FileSecretStore {
  constructor({ directory = null } = {}) {
    this.directory = directory === null ? null : fs.realpathSync(directory);
    if (this.directory && !fs.statSync(this.directory).isDirectory()) throw new Error('invalid_secret_directory');
  }

  get(key) {
    if (!this.directory || !Object.hasOwn(SECRET_FILES, key)) return null;
    const target = path.join(this.directory, SECRET_FILES[key]);
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        | (fs.constants.O_NONBLOCK || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SECRET_BYTES) throw new Error('invalid_secret_file');
      const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      const after = fs.fstatSync(fd);
      if (length > MAX_SECRET_BYTES || length !== stat.size || after.size !== stat.size
        || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
        || after.nlink !== 1) throw new Error('secret_changed_during_read');
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
      if (!value || /[\r\n]/.test(value) || value.includes(String.fromCharCode(0))) throw new Error('invalid_secret_value');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Object.assign(new Error('secret_unavailable'), { code: 'CMP-HOST-0005' });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  getStatus() {
    return { available: this.directory !== null, ready: this.directory !== null,
      status: this.directory !== null ? 'ready' : 'unavailable', storageBackend: 'mounted_files', readOnly: true };
  }
}

module.exports = { FileSecretStore };
