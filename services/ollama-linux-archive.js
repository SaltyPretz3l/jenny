'use strict';

const { once } = require('events');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK_SIZE = 512;
const ARCHIVE_ERROR_CODES = Object.freeze([
  'zstd_unavailable', 'archive_corrupt', 'archive_unsupported_entry', 'archive_unsafe_path',
  'archive_unsafe_link', 'archive_too_large', 'archive_too_many_entries', 'cancelled',
]);
const CODE_SET = new Set(ARCHIVE_ERROR_CODES);
function archiveError(code, message, entry, cause) {
  const error = new Error(message);
  error.code = code;
  if (entry !== undefined) error.entry = entry;
  if (cause !== undefined) error.cause = cause;
  return error;
}
function normalizeArchivePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0')) return null;
  let candidate = name.startsWith('./') ? name.slice(2) : name;
  if (!candidate || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) return null;
  if (candidate.endsWith('/')) candidate = candidate.slice(0, -1);
  if (!candidate) return null;
  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}
function fieldString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}
function parseTarNumber(field) {
  if ((field[0] & 0x80) !== 0) {
    if ((field[0] & 0x40) !== 0) throw archiveError('archive_corrupt', 'Negative base-256 tar value.');
    let value = field[0] & 0x3f;
    for (let index = 1; index < field.length; index += 1) value = (value * 256) + field[index];
    if (!Number.isSafeInteger(value)) throw archiveError('archive_corrupt', 'Tar value exceeds the safe range.');
    return value;
  }
  const raw = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw archiveError('archive_corrupt', 'Malformed tar numeric field.');
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw archiveError('archive_corrupt', 'Tar value exceeds the safe range.');
  return value;
}
function parseHeader(block) {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (sum !== parseTarNumber(block.subarray(148, 156))) {
    throw archiveError('archive_corrupt', 'Tar header checksum mismatch.');
  }
  const magic = fieldString(block, 257, 6);
  if (magic !== 'ustar' && magic !== 'ustar ') {
    throw archiveError('archive_corrupt', 'Unsupported tar header format.');
  }
  const name = fieldString(block, 0, 100);
  // Only POSIX ustar carries a path prefix at 345; GNU headers keep atime/ctime there.
  const prefix = magic === 'ustar' ? fieldString(block, 345, 155) : '';
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: parseTarNumber(block.subarray(100, 108)),
    size: parseTarNumber(block.subarray(124, 136)),
    type: String.fromCharCode(block[156] || 0),
    linkName: fieldString(block, 157, 100),
  };
}
class ChunkReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunk = null;
    this.offset = 0;
  }
  async readSome(limit) {
    while (!this.chunk || this.offset === this.chunk.length) {
      const next = await this.iterator.next();
      if (next.done) return null;
      this.chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.offset = 0;
    }
    const end = Math.min(this.offset + limit, this.chunk.length);
    const result = this.chunk.subarray(this.offset, end);
    this.offset = end;
    return result;
  }
  async readBlock() {
    const block = Buffer.allocUnsafe(BLOCK_SIZE);
    let offset = 0;
    while (offset < BLOCK_SIZE) {
      const chunk = await this.readSome(BLOCK_SIZE - offset);
      if (!chunk) {
        if (offset === 0) return null;
        throw archiveError('archive_corrupt', 'Unexpected EOF inside a tar block.');
      }
      chunk.copy(block, offset);
      offset += chunk.length;
    }
    return block;
  }
  async consume(size, consumer = null, padded = true) {
    let remaining = size;
    while (remaining > 0) {
      const chunk = await this.readSome(remaining);
      if (!chunk) throw archiveError('archive_corrupt', 'Unexpected EOF inside a tar entry.');
      if (consumer) await consumer(chunk);
      remaining -= chunk.length;
    }
    const padding = padded ? (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE : 0;
    if (padding > 0) await this.consume(padding, null, false);
  }
  async drain() {
    while (await this.readSome(BLOCK_SIZE)) { /* validate the decompressor through EOF */ }
  }
}
async function readPayload(reader, size) {
  const chunks = [];
  await reader.consume(size, (chunk) => { chunks.push(Buffer.from(chunk)); });
  return Buffer.concat(chunks, size);
}
function parsePax(payload) {
  const values = {};
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) throw archiveError('archive_corrupt', 'Malformed PAX record length.');
    const lengthText = payload.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw archiveError('archive_corrupt', 'Malformed PAX record length.');
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > payload.length || payload[end - 1] !== 0x0a) {
      throw archiveError('archive_corrupt', 'Malformed PAX record boundary.');
    }
    const body = payload.subarray(space + 1, end - 1);
    const equals = body.indexOf(0x3d);
    if (equals < 1) throw archiveError('archive_corrupt', 'Malformed PAX record.');
    values[body.subarray(0, equals).toString('utf8')] = body.subarray(equals + 1).toString('utf8');
    offset = end;
  }
  if (Object.hasOwn(values, 'size')) {
    if (!/^[0-9]+$/.test(values.size)) throw archiveError('archive_corrupt', 'Malformed PAX size.');
    values.size = Number(values.size);
    if (!Number.isSafeInteger(values.size)) throw archiveError('archive_corrupt', 'PAX size exceeds the safe range.');
  }
  return values;
}
function extensionString(payload) {
  const nul = payload.indexOf(0);
  const end = nul < 0 ? payload.length : nul;
  return payload.subarray(0, end).toString('utf8').replace(/\n$/, '');
}
async function writeFile(reader, size, target, fsImpl, isCancelled) {
  const output = fsImpl.createWriteStream(target);
  let outputError = null;
  output.on?.('error', (error) => { outputError = error; });
  try {
    await reader.consume(size, async (chunk) => {
      if (outputError) throw outputError;
      // Checked per chunk, not only per entry: the Ollama archive carries single
      // multi-hundred-MB libraries, and a cancel must land inside them too.
      if (isCancelled()) throw archiveError('cancelled', 'Archive extraction was cancelled.');
      // events.once removes both listeners after drain or error, so long entries do not pile them up.
      if (output.write(chunk) === false) await once(output, 'drain');
    });
    if (outputError) throw outputError;
    await new Promise((resolve, reject) => {
      output.once('error', reject);
      output.end((error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    output.destroy?.();
    throw error;
  }
}
function safeLinkTarget(entry, linkName) {
  if (!linkName || linkName.startsWith('/') || linkName.includes('\\') || path.win32.isAbsolute(linkName)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), linkName));
  return resolved !== '..' && !resolved.startsWith('../') && !path.posix.isAbsolute(resolved);
}
function assertSafeTarget(destinationDir, entry, fsImpl) {
  let current = destinationDir;
  for (const segment of [null, ...entry.split('/')]) {
    if (segment !== null) current = path.join(current, segment);
    try {
      if (fsImpl.lstatSync(current).isSymbolicLink()) {
        throw archiveError('archive_unsafe_path', 'Archive target traverses a symbolic link.', entry);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}
async function runExtraction(options) {
  const {
    archivePath, destinationDir, fsImpl, zlibImpl, maxEntries, maxBytes, onProgress, isCancelled,
  } = options;
  let input;
  let decompressor;
  let compressedBytes = 0;
  try {
    fsImpl.mkdirSync(destinationDir, { recursive: true });
    input = fsImpl.createReadStream(archivePath);
    decompressor = zlibImpl.createZstdDecompress();
    input.on('data', (chunk) => { compressedBytes += chunk.length; });
    input.on('error', (error) => { decompressor.destroy(error); });
    input.pipe(decompressor);
    const reader = new ChunkReader(decompressor);
    const regularFiles = new Set();
    const files = [];
    let entries = 0;
    let extractedBytes = 0;
    let zeroBlocks = 0;
    let pending = {};

    while (true) {
      const block = await reader.readBlock();
      if (!block) break;
      if (block.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) {
          await reader.drain();
          break;
        }
        continue;
      }
      if (zeroBlocks !== 0) throw archiveError('archive_corrupt', 'Non-zero tar header after a zero block.');
      const header = parseHeader(block);
      if (isCancelled()) throw archiveError('cancelled', 'Archive extraction was cancelled.');
      entries += 1;
      if (entries > maxEntries) throw archiveError('archive_too_many_entries', 'Archive contains too many entries.');

      if (header.type === 'x' || header.type === 'L' || header.type === 'K' || header.type === 'g') {
        const payload = await readPayload(reader, header.size);
        if (header.type === 'g' && entries !== 1) {
          throw archiveError('archive_unsupported_entry', 'Global PAX header must lead the archive.', header.name);
        }
        if (header.type === 'x') pending = { ...pending, ...parsePax(payload) };
        if (header.type === 'L') pending.longName = extensionString(payload);
        if (header.type === 'K') pending.longLink = extensionString(payload);
        onProgress?.({ entries, extractedBytes, compressedBytes });
        continue;
      }

      const rawName = pending.path ?? pending.longName ?? header.name;
      const entry = normalizeArchivePath(rawName);
      if (!entry) throw archiveError('archive_unsafe_path', 'Archive entry has an unsafe path.', rawName);
      const linkName = pending.linkpath ?? pending.longLink ?? header.linkName;
      const size = pending.size ?? header.size;
      pending = {};
      const target = path.join(destinationDir, ...entry.split('/'));
      assertSafeTarget(destinationDir, entry, fsImpl);
      if (header.type === '\0' || header.type === '0') {
        if (extractedBytes > maxBytes - size) {
          throw archiveError('archive_too_large', 'Archive exceeds the extracted byte limit.', entry);
        }
        fsImpl.mkdirSync(path.dirname(target), { recursive: true });
        await writeFile(reader, size, target, fsImpl, isCancelled);
        extractedBytes += size;
        fsImpl.chmodSync?.(target, (header.mode & 0o777) | 0o600);
        regularFiles.add(entry);
        files.push(entry);
      } else if (header.type === '5') {
        fsImpl.mkdirSync(target, { recursive: true });
        await reader.consume(size);
      } else if (header.type === '2') {
        if (!safeLinkTarget(entry, linkName)) {
          throw archiveError('archive_unsafe_link', 'Archive symlink escapes the destination.', entry);
        }
        fsImpl.mkdirSync(path.dirname(target), { recursive: true });
        fsImpl.symlinkSync(linkName, target);
        await reader.consume(size);
      } else if (header.type === '1') {
        const sourceEntry = normalizeArchivePath(linkName);
        if (!sourceEntry || !regularFiles.has(sourceEntry)) {
          throw archiveError('archive_unsafe_link', 'Archive hard link has no prior regular-file target.', entry);
        }
        fsImpl.mkdirSync(path.dirname(target), { recursive: true });
        fsImpl.linkSync(path.join(destinationDir, ...sourceEntry.split('/')), target);
        await reader.consume(size);
      } else {
        throw archiveError('archive_unsupported_entry', 'Archive entry type is unsupported.', entry);
      }
      onProgress?.({ entries, extractedBytes, compressedBytes });
    }
    if (Object.keys(pending).length !== 0) {
      throw archiveError('archive_corrupt', 'Archive ended before extended metadata was applied.');
    }
    return { entries, extractedBytes, files: files.sort() };
  } catch (error) {
    input?.destroy?.();
    decompressor?.destroy?.();
    if (CODE_SET.has(error?.code)) throw error;
    throw archiveError('archive_corrupt', 'Archive extraction failed.', undefined, error);
  }
}
function extractTarZst(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const zlibImpl = options.zlibImpl || zlib;
  if (typeof zlibImpl.createZstdDecompress !== 'function') {
    throw archiveError('zstd_unavailable', 'Zstandard decompression is unavailable in this runtime.');
  }
  if (typeof options.archivePath !== 'string' || !options.archivePath
      || typeof options.destinationDir !== 'string' || !options.destinationDir) {
    throw archiveError('archive_corrupt', 'Archive and destination paths are required.');
  }
  const maxEntries = options.maxEntries ?? 20000;
  const maxBytes = options.maxBytes ?? (16 * (1024 ** 3));
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw archiveError('archive_corrupt', 'Archive limits must be non-negative safe integers.');
  }
  return runExtraction({
    ...options,
    fsImpl,
    zlibImpl,
    maxEntries,
    maxBytes,
    onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
    isCancelled: typeof options.isCancelled === 'function' ? options.isCancelled : () => false,
  });
}

module.exports = { extractTarZst, ARCHIVE_ERROR_CODES, normalizeArchivePath };
