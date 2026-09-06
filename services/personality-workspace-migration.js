/**
 * Personality workspace v2 -> v3 migration.
 *
 * v3 collapses the five-file personality workspace into three user-owned files
 * (PERSONALITY.md / USER.md / MEMORY.md) and archives everything the compiler
 * no longer reads under `legacy/`. The migration is transactional (every
 * mutation is journalled and rolled back on failure), idempotent, and
 * self-healing (a malformed `.personality-state.json` reads as schema 1).
 *
 * "Idempotent" has to survive the self-heal: a lost or corrupted state file
 * makes the migration RE-ENTER on a workspace that is already v3, with no
 * IDENTITY.md/SOUL.md left to merge. `writePersonalityNote` therefore never
 * overwrites an existing non-placeholder PERSONALITY.md -- it records schema 3
 * and leaves the user's note alone.
 *
 * User bytes are never rewritten in place: IDENTITY.md / SOUL.md / memory/**
 * are MOVED byte-identical into `legacy/` (never over an existing file -- a
 * name collision archives as `<name>.1`, `.2`, ...), and the merged
 * PERSONALITY.md is a new file built from their trimmed contents.
 *
 * @module personality-workspace-migration
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  normalizeBody,
  truncateUtf8,
} = require('./personality-workspace-compile');

const LEGACY_DIRECTORY = 'legacy';
const MAX_ARCHIVED_ENTRIES = 1000;
const MAX_ARCHIVE_COLLISIONS = 100;
const MERGE_SOURCE_FILENAMES = Object.freeze(['IDENTITY.md', 'SOUL.md']);
const OVERFLOW_FILENAME = 'PERSONALITY.overflow.md';
// Headroom under the 64 KiB context-file limit so the merged note stays
// editable: a note written exactly at the limit reads back as `oversized` and
// would be refused by the very save that is supposed to trim it down.
const NOTE_HEADROOM_BYTES = 1024;

// Preset starting sentences. The renderer mirrors this table in the shared
// personality form; the migration needs it only to seed a note for a user who
// had picked a non-default profile before v3 retired profiles.
const PRESET_SENTENCES = Object.freeze({
  balanced: "Warm, clear, and direct. Adapt to the moment; don't perform familiarity.",
  concise: 'Shortest complete answer. Keep required caveats, drop everything else.',
  creative: 'Inventive when it helps; always concrete and accurate.',
  mentor: "Explain the key reasoning and tradeoffs; don't bloat simple answers.",
});

function mergeComment(dateKey) {
  return `<!-- Merged from IDENTITY.md and SOUL.md on ${dateKey}. The app now handles tools, dates, and formatting itself — keep only tone and behavior here. -->`;
}

function overflowNotice(filename) {
  return `<!-- The merged note was too large for one file; the remainder is in legacy/${filename}. -->`;
}

async function readTextIfExists(filePath, maxBytes) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { exists: false, text: '', oversized: false };
    if (stat.size > maxBytes) return { exists: true, text: '', oversized: true };
    return { exists: true, text: await fs.readFile(filePath, 'utf8'), oversized: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, text: '', oversized: false };
    throw error;
  }
}

async function remember(service, journal, filePath) {
  journal.push({ filePath, snapshot: await service.captureFileSnapshot(filePath) });
}

async function ensureArchiveDirectory(service, directoryPath) {
  const existed = await service.fileExists(directoryPath);
  await fs.mkdir(directoryPath, { recursive: true });
  if (!existed) service._rememberCreatedDirectory(directoryPath);
}

/**
 * Never archive on top of an existing file: a user who hand-copied a backup
 * into `legacy/` before upgrading would otherwise lose it to a silent rename.
 */
async function resolveArchiveDestination(service, destinationPath) {
  let candidate = destinationPath;
  for (let suffix = 1; suffix <= MAX_ARCHIVE_COLLISIONS; suffix += 1) {
    if (!(await service.fileExists(candidate))) return candidate;
    candidate = `${destinationPath}.${suffix}`;
  }
  const error = new Error('Too many archived copies of the same personality file.');
  error.code = 'PERSONALITY_ARCHIVE_COLLISION';
  throw error;
}

async function moveFile(service, journal, sourcePath, destinationPath) {
  await ensureArchiveDirectory(service, path.dirname(destinationPath));
  const target = await resolveArchiveDestination(service, destinationPath);
  await remember(service, journal, sourcePath);
  await remember(service, journal, target);
  try {
    await fs.rename(sourcePath, target);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await fs.copyFile(sourcePath, target);
    await fs.rm(sourcePath, { force: true });
  }
  return path.basename(target);
}

async function collectRelativeFiles(rootPath, relative = '', collected = [], limit = MAX_ARCHIVED_ENTRIES) {
  let entries;
  try {
    entries = await fs.readdir(path.join(rootPath, relative), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return collected;
    throw error;
  }
  for (const entry of entries) {
    if (collected.length >= limit) break;
    const entryRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await collectRelativeFiles(rootPath, entryRelative, collected, limit);
      continue;
    }
    if (entry.isFile()) collected.push(entryRelative);
  }
  return collected;
}

async function archiveMemoryDirectory(service, journal, archivedFiles) {
  const limit = service.maxArchivedEntries;
  const relativeFiles = await collectRelativeFiles(service.memoryDirectoryPath, '', [], limit);
  if (relativeFiles.length >= limit) {
    service._logMigrationEvent('WARN', 'archive_truncated', { limit, count: relativeFiles.length });
  }
  for (const relative of relativeFiles) {
    const segments = relative.split('/');
    const archivedAs = await moveFile(
      service,
      journal,
      path.join(service.memoryDirectoryPath, ...segments),
      path.join(service.legacyDirectoryPath, 'memory', ...segments)
    );
    const recorded = `memory/${segments.slice(0, -1).concat(archivedAs).join('/')}`;
    archivedFiles.push(recorded);
    service._logMigrationEvent('INFO', 'archived', { file: recorded });
  }
  // Only remove the tree when nothing is left behind. Hitting the archive cap
  // (or an unreadable child) keeps the directory, which is the safe outcome --
  // schema 3 is still recorded so the app is usable.
  const leftover = await collectRelativeFiles(service.memoryDirectoryPath, '', [], 1);
  if (leftover.length === 0) {
    await fs.rm(service.memoryDirectoryPath, { recursive: true, force: true }).catch(() => {});
    return;
  }
  service._logMigrationEvent('WARN', 'archive_incomplete', { remaining: leftover.length });
}

function seedNoteFromRetiredIdentity(mergedBody, identity) {
  const customText = String(identity?.customText || '').trim();
  const profile = String(identity?.profile || '').trim().toLowerCase();
  if (mergedBody) {
    return customText ? `${mergedBody}\n\n${customText}` : mergedBody;
  }
  if (!customText && (!profile || profile === 'balanced')) return '';
  const sentence = PRESET_SENTENCES[profile] || '';
  return [sentence, customText].filter(Boolean).join('\n\n');
}

async function buildMergedNote(service, journal, mergedFrom, archivedFiles) {
  const parts = [];
  for (const filename of MERGE_SOURCE_FILENAMES) {
    const filePath = path.join(service.workspacePath, filename);
    const { exists, text, oversized } = await readTextIfExists(filePath, service.contextFileMaxBytes);
    if (!exists) continue;
    if (oversized) {
      service._logMigrationEvent('WARN', 'merge_source_oversized', { file: filename });
    }
    const isStock = await service._matchesKnownStockFile(
      filePath,
      service.legacyStockHashes[filename],
      service.legacyStockSizes?.[filename]
    );
    const body = oversized || isStock ? '' : normalizeBody(text);
    if (body) {
      parts.push(text.trim());
      mergedFrom.push(filename);
    }
    if (isStock) {
      // Only exact app-owned stock text is safe to discard.
      await remember(service, journal, filePath);
      await fs.rm(filePath, { force: true });
      service._logMigrationEvent('INFO', 'discarded_stock', { file: filename });
      continue;
    }
    const archivedAs = await moveFile(
      service,
      journal,
      filePath,
      path.join(service.legacyDirectoryPath, filename)
    );
    archivedFiles.push(archivedAs);
    service._logMigrationEvent('INFO', 'archived', { file: archivedAs });
  }
  return parts.join('\n\n');
}

/**
 * Cut `text` at the last line boundary that keeps the prefix inside
 * `maxBytes`. Falls back to a character-safe byte cut when a single line is
 * larger than the whole budget.
 */
function splitAtLineBoundary(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { head: text, tail: '' };
  const lines = text.split('\n');
  let head = '';
  let used = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const chunk = index === 0 ? lines[0] : `\n${lines[index]}`;
    const size = Buffer.byteLength(chunk, 'utf8');
    if (used + size > maxBytes) break;
    head += chunk;
    used += size;
  }
  if (!head) head = truncateUtf8(text, maxBytes, '');
  return { head, tail: text.slice(head.length) };
}

async function writeNoteWithOverflow(service, journal, filePath, content, archivedFiles) {
  const limit = Math.max(service.contextFileMaxBytes - NOTE_HEADROOM_BYTES, 0);
  if (Buffer.byteLength(content, 'utf8') <= limit) {
    await remember(service, journal, filePath);
    await fs.writeFile(filePath, content, 'utf8');
    return;
  }
  // A merged note bigger than the editable limit would read back as
  // `oversized`: the editor would show it empty, the compiler would drop it,
  // and one keystroke plus Save would truncate a lifetime of persona to two
  // bytes. Keep the head editable and park the remainder in legacy/.
  await ensureArchiveDirectory(service, service.legacyDirectoryPath);
  const overflowPath = await resolveArchiveDestination(
    service,
    path.join(service.legacyDirectoryPath, OVERFLOW_FILENAME)
  );
  const archivedAs = path.basename(overflowPath);
  const notice = `${overflowNotice(archivedAs)}\n\n`;
  const { head, tail } = splitAtLineBoundary(
    content,
    Math.max(limit - Buffer.byteLength(notice, 'utf8'), 0)
  );
  await remember(service, journal, overflowPath);
  await fs.writeFile(overflowPath, tail.startsWith('\n') ? tail.slice(1) : tail, 'utf8');
  await remember(service, journal, filePath);
  await fs.writeFile(filePath, `${notice}${head}\n`, 'utf8');
  archivedFiles.push(archivedAs);
  service._logMigrationEvent('WARN', 'note_overflow', {
    file: archivedAs,
    keptBytes: Buffer.byteLength(head, 'utf8'),
    overflowBytes: Buffer.byteLength(tail, 'utf8'),
  });
}

async function writePersonalityNote(service, journal, mergedBody, dateKey, archivedFiles) {
  const filePath = path.join(service.workspacePath, 'PERSONALITY.md');
  const existing = await readTextIfExists(filePath, service.contextFileMaxBytes);
  const existingHasContent = existing.exists
    && (existing.oversized || normalizeBody(existing.text) !== '');
  if (existingHasContent) {
    // Re-entry after a lost/corrupted state file. The note on disk is the
    // user's; recording schema 3 is all that is left to do.
    service._logMigrationEvent('INFO', 'note_preserved', { reason: 'existing_content' });
    return false;
  }
  const identity = await service._readRetiredAssistantIdentity();
  const body = seedNoteFromRetiredIdentity(mergedBody, identity);
  if (!body) {
    if (!existing.exists) {
      await remember(service, journal, filePath);
      await fs.writeFile(filePath, service.templates.PERSONALITY, 'utf8');
    }
    return false;
  }
  const prefix = mergedBody ? `${mergeComment(dateKey)}\n\n` : '';
  await writeNoteWithOverflow(service, journal, filePath, `${prefix}${body}\n`, archivedFiles);
  return true;
}

async function resetKnownStockFile(service, journal, filename, key, migratedFiles) {
  const filePath = path.join(service.workspacePath, filename);
  const exists = await service.fileExists(filePath);
  if (!exists) {
    await remember(service, journal, filePath);
    await fs.writeFile(filePath, service.templates[key], 'utf8');
    return;
  }
  const isStock = await service._matchesKnownStockFile(
    filePath,
    service.legacyStockHashes[filename],
    service.legacyStockSizes?.[filename]
  );
  if (!isStock) return;
  await remember(service, journal, filePath);
  await fs.writeFile(filePath, service.templates[key], 'utf8');
  migratedFiles.push(filename);
  service._logMigrationEvent('INFO', 'reset_stock', { file: filename });
}

async function resolveMergeDateKey(service, now) {
  try {
    return service.formatDateKey(now, await service.getResolvedTimeZone(false));
  } catch (_error) {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Run the v2 -> v3 migration against an already-created workspace directory.
 *
 * @param {object} service PersonalityWorkspaceService instance
 * @returns {Promise<void>}
 */
async function migratePersonalityWorkspaceToV3(service) {
  const journal = [{
    filePath: service.personalityStatePath,
    snapshot: await service.captureFileSnapshot(service.personalityStatePath),
  }];
  const migratedFiles = [];
  const archivedFiles = [];
  const mergedFrom = [];
  const now = service.nowProvider();
  const dateKey = await resolveMergeDateKey(service, now);
  service._resetCreatedDirectories();
  try {
    // USER.md / MEMORY.md keep user bytes; only exact v1 stock text is
    // replaced by the v3 placeholder templates.
    await resetKnownStockFile(service, journal, 'USER.md', 'USER', migratedFiles);
    await resetKnownStockFile(service, journal, 'MEMORY.md', 'MEMORY', migratedFiles);
    const mergedBody = await buildMergedNote(service, journal, mergedFrom, archivedFiles);
    const seeded = await writePersonalityNote(service, journal, mergedBody, dateKey, archivedFiles);
    if (seeded && mergedFrom.length) {
      service._logMigrationEvent('INFO', 'merged', { files: mergedFrom.join(',') });
    }
    await archiveMemoryDirectory(service, journal, archivedFiles);
    await service._writePersonalityState({
      version: service.schemaVersion,
      migrated_at: now.toISOString(),
      migrated_files: migratedFiles,
      archived_files: archivedFiles,
      merged_from: mergedFrom,
    });
  } catch (error) {
    const results = await Promise.allSettled(
      [...journal].reverse().map(({ filePath, snapshot }) => service.restoreFileSnapshot(filePath, snapshot))
    );
    const rollbackFailures = results.filter((result) => result.status === 'rejected').length;
    if (rollbackFailures && error && typeof error === 'object') {
      error.rollbackFailureCount = rollbackFailures;
    }
    await service._removeCreatedDirectories();
    service._logMigrationEvent('ERROR', 'rolled_back', {
      code: service.errorCodes.MIGRATION_ROLLED_BACK,
      restored: journal.length - rollbackFailures,
      failed: rollbackFailures,
    });
    throw error;
  }
}

module.exports = {
  LEGACY_DIRECTORY,
  MAX_ARCHIVED_ENTRIES,
  PRESET_SENTENCES,
  migratePersonalityWorkspaceToV3,
};
