'use strict';

// Strict, allocation-light validation of the ZIP container before yauzl is
// allowed to inflate any entry. V1 deliberately accepts only the small subset
// Jenny's declarative package builder emits: single-disk ZIP32, store/deflate,
// no descriptors/encryption/extras/comments, and contiguous claimed ranges.

const LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 4096,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100,
});

const SIGNATURES = Object.freeze({
  local: 0x04034b50,
  central: 0x02014b50,
  eocd: 0x06054b50,
  zip64Eocd: 0x06064b50,
  zip64Locator: 0x07064b50,
});

function fail(reason, detail = null) {
  return { ok: false, reason, detail };
}

function hasRange(buffer, offset, length) {
  return Number.isSafeInteger(offset)
    && Number.isSafeInteger(length)
    && offset >= 0
    && length >= 0
    && offset + length <= buffer.length;
}

function readUtf8Name(bytes) {
  if (bytes.length === 0) return fail('empty_entry_name');
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(value, 'utf8').equals(bytes)) return fail('entry_name_not_canonical_utf8');
    return { ok: true, value };
  } catch (_error) {
    return fail('entry_name_invalid_utf8');
  }
}

function findEocd(buffer) {
  if (buffer.length < 22) return null;
  const first = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== SIGNATURES.eocd) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  return null;
}

function validateFlagsAndMethod(flags, method) {
  if ((flags & 0x0001) !== 0) return 'encrypted_entry_rejected';
  if ((flags & 0x0008) !== 0) return 'data_descriptor_rejected';
  if ((flags & 0x0040) !== 0) return 'strong_encryption_rejected';
  if (method !== 0 && method !== 8) return 'compression_method_rejected';
  const allowedFlags = 0x0800 | (method === 8 ? 0x0006 : 0);
  if ((flags & ~allowedFlags) !== 0) return 'unsupported_general_purpose_flags';
  return null;
}

function validateDeclaredSize(compressedSize, uncompressedSize, limits) {
  if (uncompressedSize > limits.maxEntryUncompressedBytes) return 'entry_size_budget_exceeded';
  if (compressedSize === 0 && uncompressedSize !== 0) return 'compression_ratio_exceeded';
  if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
    return 'compression_ratio_exceeded';
  }
  return null;
}

function validateZipStructure(bytes, { limits: overrides = {} } = {}) {
  if (!Buffer.isBuffer(bytes)) return fail('archive_not_buffer');
  const limits = { ...LIMITS, ...(overrides || {}) };
  if (bytes.length > limits.maxArchiveBytes) return fail('archive_size_budget_exceeded');

  const eocdOffset = findEocd(bytes);
  if (eocdOffset === null) return fail('eocd_missing_or_trailing_bytes');
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);
  if (commentLength !== 0) return fail('archive_comment_rejected');
  if (eocdOffset >= 20 && bytes.readUInt32LE(eocdOffset - 20) === SIGNATURES.zip64Locator) {
    return fail('zip64_rejected');
  }

  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    return fail('multi_disk_archive_rejected');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return fail('zip64_rejected');
  }
  if (entryCount > limits.maxEntries) return fail('entry_count_budget_exceeded');
  if (!hasRange(bytes, centralOffset, centralSize) || centralOffset + centralSize !== eocdOffset) {
    return fail('central_directory_range_invalid');
  }

  const entries = [];
  let cursor = centralOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (!hasRange(bytes, cursor, 46) || bytes.readUInt32LE(cursor) !== SIGNATURES.central) {
      return fail('central_header_invalid', { index });
    }
    const versionMadeBy = bytes.readUInt16LE(cursor + 4);
    const versionNeeded = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const centralHeaderLength = 46 + nameLength + extraLength + entryCommentLength;
    if (!hasRange(bytes, cursor, centralHeaderLength)) return fail('central_header_truncated', { index });
    if (versionNeeded > 20 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      return fail('zip64_or_unsupported_version_rejected', { index });
    }
    if (diskStart !== 0) return fail('multi_disk_archive_rejected', { index });
    if (extraLength !== 0) return fail('extra_field_rejected', { index });
    if (entryCommentLength !== 0) return fail('entry_comment_rejected', { index });
    const flagReason = validateFlagsAndMethod(flags, method);
    if (flagReason) return fail(flagReason, { index });
    const sizeReason = validateDeclaredSize(compressedSize, uncompressedSize, limits);
    if (sizeReason) return fail(sizeReason, { index });

    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if ((flags & 0x0800) === 0 && rawName.some((byte) => byte > 0x7f)) {
      return fail('non_ascii_name_without_utf8_flag', { index });
    }
    const decoded = readUtf8Name(rawName);
    if (!decoded.ok) return fail(decoded.reason, { index });
    if (decoded.value.endsWith('/') || (externalAttributes & 0x10) !== 0) {
      return fail('directory_entry_rejected', { index });
    }
    // ZIP's low DOS-attribute word carries FILE_ATTRIBUTE_REPARSE_POINT.
    // Reject it independently of Unix mode bits so a Windows-authored link or
    // junction cannot bypass the host=Unix special-file check below.
    if ((externalAttributes & 0x0400) !== 0) {
      return fail('link_or_special_file_rejected', { index });
    }
    const host = versionMadeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0xf000;
    if (host === 3 && unixType !== 0 && unixType !== 0x8000) {
      return fail('link_or_special_file_rejected', { index });
    }

    if (!hasRange(bytes, localHeaderOffset, 30) || bytes.readUInt32LE(localHeaderOffset) !== SIGNATURES.local) {
      return fail('local_header_invalid', { index });
    }
    const localVersionNeeded = bytes.readUInt16LE(localHeaderOffset + 4);
    const localFlags = bytes.readUInt16LE(localHeaderOffset + 6);
    const localMethod = bytes.readUInt16LE(localHeaderOffset + 8);
    const localCrc32 = bytes.readUInt32LE(localHeaderOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localHeaderOffset + 22);
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const localHeaderLength = 30 + localNameLength + localExtraLength;
    if (!hasRange(bytes, localHeaderOffset, localHeaderLength + compressedSize)) {
      return fail('local_entry_range_invalid', { index });
    }
    const localName = bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength);
    if (
      localVersionNeeded !== versionNeeded
      || localFlags !== flags
      || localMethod !== method
      || localCrc32 !== crc32
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize
      || localExtraLength !== 0
      || !localName.equals(rawName)
    ) {
      return fail('central_local_header_mismatch', { index });
    }
    const dataOffset = localHeaderOffset + localHeaderLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > centralOffset) return fail('entry_overlaps_central_directory', { index });
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      return fail('total_uncompressed_budget_exceeded');
    }
    entries.push({
      index,
      path: decoded.value,
      rawName: Buffer.from(rawName),
      flags,
      compressionMethod: method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset,
      dataEnd,
    });
    cursor += centralHeaderLength;
  }
  if (cursor !== centralOffset + centralSize) return fail('central_directory_count_mismatch');

  const orderedRanges = entries
    .map((entry) => ({ start: entry.localHeaderOffset, end: entry.dataEnd, index: entry.index }))
    .sort((a, b) => a.start - b.start);
  let claimedEnd = 0;
  for (const range of orderedRanges) {
    if (range.start < claimedEnd) return fail('overlapping_entry_ranges', { index: range.index });
    if (range.start !== claimedEnd) return fail('unclaimed_archive_bytes', { offset: claimedEnd });
    claimedEnd = range.end;
  }
  if (claimedEnd !== centralOffset) return fail('unclaimed_archive_bytes', { offset: claimedEnd });

  return {
    ok: true,
    entries,
    centralDirectoryOffset: centralOffset,
    eocdOffset,
    totalUncompressedBytes,
    limits,
  };
}

module.exports = {
  LIMITS,
  SIGNATURES,
  validateZipStructure,
};
