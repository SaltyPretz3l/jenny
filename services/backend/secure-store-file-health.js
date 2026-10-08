'use strict';

const path = require('path');

const { FileJsonStore } = require('./file-json-store');
const { preserveCorruptFile, readWithRetry } = require('./corrupt-file-preserve');

const CREDENTIAL_FILE_DAMAGED_MESSAGE =
  'SecureStore: the credential file is damaged and was not overwritten.';
const CREDENTIAL_FILE_UNREADABLE_DETAIL =
  'The credential file is unreadable and was left in place so it can be recovered.';
const UNREADABLE_RECHECK_MS = 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function consoleLogger(level, event, data) {
  try {
    console.error(`${level} ${event} ${JSON.stringify(data)}`);
  } catch (logError) {
    void logError;
  }
}

// The credential container file. A missing file reads as an empty store. A file
// that exists but cannot be parsed, or is not a JSON object, is moved aside as
// `<name>.corrupt-<ms>` and the store starts empty. When that move fails the
// damaged bytes stay in place: reads return an empty store and every write
// throws, for the rest of the process. A file that could not be read at all is
// left alone and re-read (at most once a second) until a read succeeds; writes
// throw until then.
class CredentialFileStore extends FileJsonStore {
  constructor(filePath, options = {}) {
    super(filePath, options);
    this._damageLogger = typeof options.logger === 'function' ? options.logger : consoleLogger;
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    this._writeBlocked = false;
    this._unreadableSinceCheckMs = null;
  }

  read(defaultValue) {
    const recheck = this._unreadableSinceCheckMs !== null;
    if (this._writeBlocked && !recheck) {
      return defaultValue;
    }
    if (recheck && this._now() - this._unreadableSinceCheckMs < UNREADABLE_RECHECK_MS) {
      return defaultValue;
    }
    const result = recheck ? this.readWithStatus(defaultValue) : readWithRetry(this, defaultValue);
    if (!result.corrupted && !result.unreadable && (result.missing || isPlainObject(result.value))) {
      this._writeBlocked = false;
      this._unreadableSinceCheckMs = null;
      return result.value;
    }
    if (result.unreadable) {
      this._unreadableSinceCheckMs = this._now();
      if (recheck) return defaultValue;
    } else {
      this._unreadableSinceCheckMs = null;
    }
    this._handleDamagedFile(result);
    return defaultValue;
  }

  write(value) {
    this.assertWritable();
    return super.write(value);
  }

  writeImmediate(value) {
    this.assertWritable();
    return super.writeImmediate(value);
  }

  damagedDetail() {
    return this._writeBlocked ? CREDENTIAL_FILE_UNREADABLE_DETAIL : '';
  }

  assertWritable() {
    if (this._unreadableSinceCheckMs !== null) this.read({});
    if (this._writeBlocked) {
      throw new Error(CREDENTIAL_FILE_DAMAGED_MESSAGE);
    }
  }

  _handleDamagedFile(result) {
    // A read error code means the file could not be read at all and may be
    // healthy, so it is never moved: it stays and writes are blocked.
    const outcome = result.unreadable
      ? { preserved: false, reason: 'unreadable' }
      : preserveCorruptFile(this.filePath, { logger: this._damageLogger });
    this._writeBlocked = !outcome.preserved && outcome.reason !== 'missing';
    try {
      this._damageLogger('ERROR', 'secure_store.corrupt_file_detected', {
        fileName: path.basename(this.filePath),
        preserved: outcome.preserved === true,
        ...(outcome.preserved
          ? { preservedName: path.basename(outcome.preservedPath) }
          : { reason: outcome.reason }),
        errorCode: result.errorCode || (result.corrupted ? 'invalid_json' : 'not_an_object'),
      });
    } catch (logError) {
      void logError;
    }
  }
}

module.exports = {
  CREDENTIAL_FILE_DAMAGED_MESSAGE,
  CREDENTIAL_FILE_UNREADABLE_DETAIL,
  CredentialFileStore,
};
