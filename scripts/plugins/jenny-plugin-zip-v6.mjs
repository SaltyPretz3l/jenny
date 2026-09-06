import { Buffer } from 'node:buffer';

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const MAX_V6_ARCHIVE_BYTES = 300 * 1024 * 1024;
const MAX_ENTRIES = 64;
const UTF8_FLAG = 0x0800;
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

function archiveError(code) {
  return Object.assign(new Error('Jenny V6 archive assembly failed.'), { code });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
}));

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function validateEntry(entry) {
  if (!entry || typeof entry.path !== 'string' || !Buffer.isBuffer(entry.bytes)) {
    throw archiveError('invalid_archive_entry');
  }
  if (
    entry.path.length === 0
    || Buffer.byteLength(entry.path, 'utf8') > 240
    || entry.path.normalize('NFC') !== entry.path
    || entry.path.includes('\\')
    || entry.path.startsWith('/')
    || entry.path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw archiveError('invalid_archive_path');
  }
  if (entry.bytes.length > MAX_ENTRY_BYTES) throw archiveError('entry_budget_exceeded');
}

export function assembleStoredV6Zip(inputEntries) {
  if (!Array.isArray(inputEntries) || inputEntries.length < 1
    || inputEntries.length > MAX_ENTRIES) {
    throw archiveError('entry_count_invalid');
  }
  for (const entry of inputEntries) validateEntry(entry);
  const entries = inputEntries
    .map((entry) => ({ path: entry.path, bytes: entry.bytes }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const projectedBytes = projectStoredV6ZipBytes(entries);
  if (!Number.isSafeInteger(projectedBytes) || projectedBytes > MAX_V6_ARCHIVE_BYTES) {
    throw archiveError('archive_budget_exceeded');
  }
  const seen = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    if (seen.has(entry.path)) throw archiveError('duplicate_archive_path');
    seen.add(entry.path);
    const name = Buffer.from(entry.path, 'utf8');
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, entry.bytes);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.bytes.length;
  }

  const centralDirectoryBytes = centralParts.reduce((total, part) => total + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectoryBytes, 12);
  eocd.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...localParts, ...centralParts, eocd], projectedBytes);
  return archive;
}

export function projectStoredV6ZipBytes(entries) {
  return entries.reduce((total, entry) => {
    const nameBytes = Buffer.byteLength(entry.path, 'utf8');
    return total + 30 + nameBytes + entry.bytes.length + 46 + nameBytes;
  }, 22);
}
