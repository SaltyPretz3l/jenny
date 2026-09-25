/* renderer/features/renderer-ide-docx-zip.js - dependency-free ZIP container
 * support for DOCX editing. Untouched entries survive a read/write round trip
 * byte-for-byte at the data level; only the replaced parts are re-encoded. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeDocxZip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ZIP_LIMITS = Object.freeze({
    maxEntries: 4096,
    maxEntryBytes: 64 * 1024 * 1024,
    maxTotalBytes: 192 * 1024 * 1024,
  });
  const CRC_TABLE = new Uint32Array(256);
  const encoder = new TextEncoder();

  for (let index = 0; index < CRC_TABLE.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    CRC_TABLE[index] = value >>> 0;
  }

  function zipError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function crc32(bytes, seed = 0) {
    let value = (seed ^ 0xffffffff) >>> 0;
    for (let index = 0; index < bytes.length; index += 1) {
      value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  }

  function viewAt(bytes, offset, size) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) {
      throw zipError('zip_invalid', 'ZIP data is truncated');
    }
    return new DataView(bytes.buffer, bytes.byteOffset + offset, size);
  }

  function decodeName(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_error) {
      throw zipError('zip_invalid', 'ZIP entry name is not valid UTF-8');
    }
  }

  function validateName(name) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      throw zipError('zip_unsupported', `Unsupported ZIP entry name: ${name}`);
    }
  }

  function resolvedLimits(limits) {
    return {
      maxEntries: limits?.maxEntries ?? ZIP_LIMITS.maxEntries,
      maxEntryBytes: limits?.maxEntryBytes ?? ZIP_LIMITS.maxEntryBytes,
      maxTotalBytes: limits?.maxTotalBytes ?? ZIP_LIMITS.maxTotalBytes,
    };
  }

  function findEocd(bytes) {
    const first = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
      const view = viewAt(bytes, offset, 22);
      if (view.getUint32(0, true) !== 0x06054b50) {
        continue;
      }
      const commentLength = view.getUint16(20, true);
      if (offset + 22 + commentLength === bytes.length) {
        return offset;
      }
    }
    throw zipError('zip_invalid', 'ZIP end record was not found');
  }

  async function readZip(bytes, limits = ZIP_LIMITS) {
    if (!(bytes instanceof Uint8Array)) {
      throw zipError('zip_invalid', 'ZIP input must be a Uint8Array');
    }
    const activeLimits = resolvedLimits(limits);
    const eocdOffset = findEocd(bytes);
    const eocd = viewAt(bytes, eocdOffset, 22);
    const diskNumber = eocd.getUint16(4, true);
    const centralDisk = eocd.getUint16(6, true);
    const diskEntries = eocd.getUint16(8, true);
    const entryCount = eocd.getUint16(10, true);
    const centralSize = eocd.getUint32(12, true);
    const centralOffset = eocd.getUint32(16, true);
    const commentLength = eocd.getUint16(20, true);

    if (diskEntries === 0xffff || entryCount === 0xffff
      || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw zipError('zip_unsupported', 'ZIP64 archives are not supported');
    }
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
      throw zipError('zip_unsupported', 'Multi-disk ZIP archives are not supported');
    }
    if (entryCount > activeLimits.maxEntries) {
      throw zipError('zip_too_large', 'ZIP has too many entries');
    }
    if (centralOffset + centralSize > eocdOffset || centralOffset + centralSize > bytes.length) {
      throw zipError('zip_invalid', 'ZIP central directory is outside the archive');
    }

    const entries = new Map();
    const order = [];
    let cursor = centralOffset;
    let totalBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      const central = viewAt(bytes, cursor, 46);
      if (central.getUint32(0, true) !== 0x02014b50) {
        throw zipError('zip_invalid', 'Invalid ZIP central-directory signature');
      }
      const versionMadeBy = central.getUint16(4, true);
      const versionNeeded = central.getUint16(6, true);
      const flags = central.getUint16(8, true);
      const method = central.getUint16(10, true);
      const lastModTime = central.getUint16(12, true);
      const lastModDate = central.getUint16(14, true);
      const checksum = central.getUint32(16, true);
      const compressedSize = central.getUint32(20, true);
      const uncompressedSize = central.getUint32(24, true);
      const nameLength = central.getUint16(28, true);
      const extraLength = central.getUint16(30, true);
      const entryCommentLength = central.getUint16(32, true);
      const startDisk = central.getUint16(34, true);
      const externalAttributes = central.getUint32(38, true);
      const localOffset = central.getUint32(42, true);
      const centralEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
      viewAt(bytes, cursor, centralEnd - cursor);

      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff) {
        throw zipError('zip_unsupported', 'ZIP64 entries are not supported');
      }
      if (startDisk !== 0) {
        throw zipError('zip_unsupported', 'Multi-disk ZIP entries are not supported');
      }
      if ((flags & 1) !== 0) {
        throw zipError('zip_unsupported', 'Encrypted ZIP entries are not supported');
      }
      if (method !== 0 && method !== 8) {
        throw zipError('zip_unsupported', `Unsupported ZIP compression method: ${method}`);
      }
      if (uncompressedSize > activeLimits.maxEntryBytes) {
        throw zipError('zip_too_large', 'ZIP entry exceeds the size limit');
      }
      totalBytes += uncompressedSize;
      if (totalBytes > activeLimits.maxTotalBytes) {
        throw zipError('zip_too_large', 'ZIP contents exceed the total size limit');
      }

      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = decodeName(nameBytes);
      validateName(name);
      const local = viewAt(bytes, localOffset, 30);
      if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(26, true) !== nameLength) {
        throw zipError('zip_invalid', 'ZIP local header does not match its central entry');
      }
      const localExtraLength = local.getUint16(28, true);
      const localName = bytes.subarray(localOffset + 30, localOffset + 30 + nameLength);
      viewAt(bytes, localOffset + 30, nameLength + localExtraLength);
      for (let byteIndex = 0; byteIndex < nameLength; byteIndex += 1) {
        if (localName[byteIndex] !== nameBytes[byteIndex]) {
          throw zipError('zip_invalid', 'ZIP local entry name does not match');
        }
      }
      const dataOffset = localOffset + 30 + nameLength + localExtraLength;
      viewAt(bytes, dataOffset, compressedSize);
      const extra = bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const localExtra = bytes.subarray(localOffset + 30 + nameLength, dataOffset);
      const raw = bytes.subarray(dataOffset, dataOffset + compressedSize);
      entries.set(name, {
        name,
        method,
        flags,
        crc32: checksum,
        compressedSize,
        uncompressedSize,
        lastModTime,
        lastModDate,
        externalAttributes,
        versionMadeBy,
        versionNeeded,
        extra,
        localExtra,
        raw,
      });
      order.push(name);
      cursor = centralEnd;
    }
    if (cursor !== centralOffset + centralSize) {
      throw zipError('zip_invalid', 'ZIP central-directory size is inconsistent');
    }
    return {
      entries,
      order,
      comment: bytes.subarray(eocdOffset + 22, eocdOffset + 22 + commentLength),
    };
  }

  async function inflateEntry(entry) {
    let reader;
    try {
      const stream = new Blob([entry.raw]).stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      reader = stream.getReader();
      const chunks = [];
      let length = 0;
      const ceiling = Math.min(entry.uncompressedSize, ZIP_LIMITS.maxEntryBytes);
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        length += result.value.length;
        if (length > ceiling) {
          await reader.cancel().catch(() => {});
          throw zipError('zip_too_large', 'Inflated ZIP entry exceeds its declared size');
        }
        chunks.push(result.value);
      }
      const output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
      return output;
    } catch (error) {
      if (error?.code) {
        throw error;
      }
      throw zipError('zip_corrupt', 'ZIP entry could not be inflated');
    } finally {
      reader?.releaseLock?.();
    }
  }

  async function readEntryBytes(zip, name) {
    const entry = zip?.entries?.get(name);
    if (!entry) {
      throw zipError('zip_missing_entry', `ZIP entry is missing: ${name}`);
    }
    if (entry.uncompressedSize > ZIP_LIMITS.maxEntryBytes) {
      throw zipError('zip_too_large', 'ZIP entry exceeds the size limit');
    }
    const output = entry.method === 0 ? entry.raw.slice() : await inflateEntry(entry);
    if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc32) {
      throw zipError('zip_corrupt', `ZIP entry failed validation: ${name}`);
    }
    return output;
  }

  async function readEntryText(zip, name) {
    const bytes = await readEntryBytes(zip, name);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return text.startsWith('\ufeff') ? text.slice(1) : text;
    } catch (_error) {
      throw zipError('zip_corrupt', `ZIP entry is not valid UTF-8: ${name}`);
    }
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function dosNow() {
    const now = new Date();
    const year = Math.min(2107, Math.max(1980, now.getFullYear()));
    return {
      lastModTime: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
      lastModDate: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    };
  }

  async function replacementEntry(name, value, original) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`Replacement for ${name} must be a string or Uint8Array`);
    }
    if (bytes.length > ZIP_LIMITS.maxEntryBytes) {
      throw zipError('zip_too_large', `Replacement exceeds the size limit: ${name}`);
    }
    const compressed = await deflate(bytes);
    const useDeflate = compressed.length < bytes.length;
    const times = original || dosNow();
    let flags = (original?.flags || 0) & ~9;
    if (encoder.encode(name).length !== name.length) {
      flags |= 0x0800;
    }
    return {
      name,
      method: useDeflate ? 8 : 0,
      flags,
      crc32: crc32(bytes),
      compressedSize: useDeflate ? compressed.length : bytes.length,
      uncompressedSize: bytes.length,
      lastModTime: times.lastModTime,
      lastModDate: times.lastModDate,
      externalAttributes: original?.externalAttributes || 0,
      versionMadeBy: original?.versionMadeBy || 20,
      versionNeeded: 20,
      extra: original?.extra || new Uint8Array(),
      localExtra: original?.localExtra || new Uint8Array(),
      raw: useDeflate ? compressed : bytes.slice(),
    };
  }

  function header(size, fill) {
    const bytes = new Uint8Array(size);
    fill(new DataView(bytes.buffer));
    return bytes;
  }

  function join(chunks, length) {
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  async function writeZip(zip, replacements) {
    const replacementMap = replacements instanceof Map ? replacements : new Map();
    for (const name of replacementMap.keys()) {
      validateName(name);
    }
    const outputEntries = [];
    const originalNames = new Set(zip.order);
    for (const name of zip.order) {
      const original = zip.entries.get(name);
      if (!replacementMap.has(name)) {
        outputEntries.push({ ...original, flags: original.flags & ~8 });
      } else if (replacementMap.get(name) !== null) {
        outputEntries.push(await replacementEntry(name, replacementMap.get(name), original));
      }
    }
    for (const [name, value] of replacementMap) {
      if (!originalNames.has(name) && value !== null) {
        outputEntries.push(await replacementEntry(name, value, null));
      }
    }
    if (outputEntries.length > ZIP_LIMITS.maxEntries) {
      throw zipError('zip_too_large', 'ZIP has too many entries');
    }
    const totalBytes = outputEntries.reduce((total, entry) => total + entry.uncompressedSize, 0);
    if (totalBytes > ZIP_LIMITS.maxTotalBytes) {
      throw zipError('zip_too_large', 'ZIP contents exceed the total size limit');
    }

    const chunks = [];
    const centralRecords = [];
    let outputLength = 0;
    for (const entry of outputEntries) {
      const nameBytes = encoder.encode(entry.name);
      if (nameBytes.length > 0xffff || entry.extra.length > 0xffff || entry.localExtra.length > 0xffff) {
        throw zipError('zip_unsupported', 'ZIP entry metadata is too large');
      }
      const localOffset = outputLength;
      const local = header(30, (view) => {
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, entry.versionNeeded, true);
        view.setUint16(6, entry.flags & ~8, true);
        view.setUint16(8, entry.method, true);
        view.setUint16(10, entry.lastModTime, true);
        view.setUint16(12, entry.lastModDate, true);
        view.setUint32(14, entry.crc32, true);
        view.setUint32(18, entry.compressedSize, true);
        view.setUint32(22, entry.uncompressedSize, true);
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, entry.localExtra.length, true);
      });
      chunks.push(local, nameBytes, entry.localExtra, entry.raw);
      outputLength += local.length + nameBytes.length + entry.localExtra.length + entry.raw.length;

      const central = header(46, (view) => {
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, entry.versionMadeBy, true);
        view.setUint16(6, entry.versionNeeded, true);
        view.setUint16(8, entry.flags & ~8, true);
        view.setUint16(10, entry.method, true);
        view.setUint16(12, entry.lastModTime, true);
        view.setUint16(14, entry.lastModDate, true);
        view.setUint32(16, entry.crc32, true);
        view.setUint32(20, entry.compressedSize, true);
        view.setUint32(24, entry.uncompressedSize, true);
        view.setUint16(28, nameBytes.length, true);
        view.setUint16(30, entry.extra.length, true);
        view.setUint32(38, entry.externalAttributes, true);
        view.setUint32(42, localOffset, true);
      });
      centralRecords.push(central, nameBytes, entry.extra);
    }

    const centralOffset = outputLength;
    for (const record of centralRecords) {
      chunks.push(record);
      outputLength += record.length;
    }
    const centralSize = outputLength - centralOffset;
    const comment = zip.comment || new Uint8Array();
    if (comment.length > 0xffff) {
      throw zipError('zip_unsupported', 'ZIP comment is too large');
    }
    const eocd = header(22, (view) => {
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, outputEntries.length, true);
      view.setUint16(10, outputEntries.length, true);
      view.setUint32(12, centralSize, true);
      view.setUint32(16, centralOffset, true);
      view.setUint16(20, comment.length, true);
    });
    chunks.push(eocd, comment);
    outputLength += eocd.length + comment.length;
    return join(chunks, outputLength);
  }

  return {
    ZIP_LIMITS,
    crc32,
    readEntryBytes,
    readEntryText,
    readZip,
    writeZip,
  };
});
