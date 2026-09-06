/**
 * Personality workspace service (schema v3).
 *
 * Owns `%APPDATA%/jenny/personality/default-workspace/`: three user-owned
 * markdown files (PERSONALITY.md / USER.md / MEMORY.md), the `legacy/` archive
 * the v3 migration creates, and the single compile path that produces the
 * `## Personality` system block.
 *
 * There is exactly ONE compile function. `getCompiledContext()` returns the
 * wire content (the `### …` sections only) that rides on
 * `context_blocks[kind=personality]`; `getState().compiled.text` is the same
 * content wrapped in the heading + name line so the Settings preview and the
 * sidebar estimate are exact rather than approximate.
 *
 * @module personality-workspace-service
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { PERSONALITY_ERROR_CODES } = require('./backend/error-codes');
const {
  ADVANCED_CONTEXT_MAX_BYTES,
  CLIP_MARKER,
  PERSONALITY_HEADING,
  PERSONALITY_PRECEDENCE_TEMPLATE,
  SECTION_BUDGETS,
  buildPersonalityMessage,
  clipToBudget,
  compilePersonalitySections,
  estimateTokens,
  extractFrontmatterBlock,
  normalizeAgentName,
  normalizeBody,
} = require('./personality-workspace-compile');
const {
  LEGACY_DIRECTORY,
  MAX_ARCHIVED_ENTRIES,
  PRESET_SENTENCES,
  migratePersonalityWorkspaceToV3,
} = require('./personality-workspace-migration');

const WORKSPACE_DIRECTORY = path.join('personality', 'default-workspace');
const MEMORY_DIRECTORY = 'memory';
const PERSONALITY_STATE_FILENAME = '.personality-state.json';
const PERSONALITY_WORKSPACE_SCHEMA_VERSION = 3;
const CONTEXT_FILE_MAX_BYTES = 64 * 1024;
const COMPILED_CONTEXT_DIGEST_MAX_BYTES = 256 * 1024;
const LEGACY_STOCK_FILE_MAX_BYTES = 16 * 1024;
const SHELL_CONFIG_MAX_BYTES = 4 * 1024 * 1024;
const RETIRED_CUSTOM_TEXT_MAX_CHARS = 2000;

const FILE_KEYS = Object.freeze({
  PERSONALITY: 'PERSONALITY',
  USER: 'USER',
  MEMORY: 'MEMORY',
});

const PLACEHOLDER_TEMPLATES = Object.freeze({
  PERSONALITY: `# Personality note

<!-- How Jenny should sound and behave. Tone only — the app handles tools, dates, and formatting. Leave unchanged to add nothing. -->
`,
  USER: `# About you

<!-- Name, how to address you, what you do, how you like to work. Leave unchanged to add nothing. -->
`,
  MEMORY: `# Long-term notes

<!-- Durable facts and preferences Jenny should always know. Leave unchanged to add nothing. -->
`,
});

const FIXED_FILE_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: FILE_KEYS.PERSONALITY, sectionId: 'personality', filename: 'PERSONALITY.md',
  }),
  Object.freeze({ key: FILE_KEYS.USER, sectionId: 'user', filename: 'USER.md' }),
  Object.freeze({ key: FILE_KEYS.MEMORY, sectionId: 'memory', filename: 'MEMORY.md' }),
]);

const DEFINITION_BY_KEY = Object.freeze(Object.fromEntries(
  FIXED_FILE_DEFINITIONS.map((definition) => [definition.key, definition])
));

// Exact SHA-256 values of the app-owned v1 Default, Classic, Meta, USER, and
// MEMORY templates. The retired prompt text intentionally does not remain in
// production code; the v3 migration uses these to tell app-owned stock text
// (discardable) from the user's own bytes (archived, never rewritten).
const LEGACY_STOCK_HASHES = Object.freeze({
  'IDENTITY.md': Object.freeze([
    'e004b6499809115641de6ee9363ffe4201440dd3715c9751ae1c04939c97bc35',
    '79173441588c0cc014613e1cb4bca9cb92d8bc7507aea21bcaac5cebf420ff95',
    '229a3e7580333460567b84e9b235c7b0388b69ecb7c33166eb707975866e4836',
  ]),
  'SOUL.md': Object.freeze([
    'cd73428f2197d88e316baf3fe37e0ced9a0fd1e359e60f1fa986e7e0f40734f2',
    '6ce2e0709aa3f8ecbf0d949c9a59f49571490c73859bf27a1b318c4605980936',
    '336ba076660bc2603c672f375f4b6722a1a23e083d42d23ede77a59cd2028156',
  ]),
  'USER.md': Object.freeze([
    '85148452d0e452d2d9d067a71243b91f60e5ea691a9c10c758ecb1109e0f9fd2',
  ]),
  'MEMORY.md': Object.freeze([
    '5d236ab178e98616135b55c26a10b696083fc067ed63c46dc1b5975d17d24e16',
  ]),
});

const LEGACY_STOCK_SIZES = Object.freeze({
  'IDENTITY.md': Object.freeze([1329, 251, 4900]),
  'SOUL.md': Object.freeze([2686, 261, 9757]),
  'USER.md': Object.freeze([178]),
  'MEMORY.md': Object.freeze([99]),
});

class PersonalityWorkspaceSchemaError extends Error {
  constructor(version) {
    super(`Personality workspace schema ${version} is newer than supported schema ${PERSONALITY_WORKSPACE_SCHEMA_VERSION}.`);
    this.name = 'PersonalityWorkspaceSchemaError';
    this.code = 'PERSONALITY_WORKSPACE_FUTURE_SCHEMA';
    this.version = version;
  }
}

function isValidTimeZone(value) {
  const timeZone = String(value || '').trim();
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getSystemTimeZone() {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(resolved) ? resolved : 'UTC';
}

function extractFrontmatter(content) {
  const text = String(content || '');
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = source.match(
    /^(?:#[^\r\n]*\r?\n\s*)?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/
  );
  if (!match) return {};
  const entries = {};
  for (const line of match[1].split(/\r?\n/)) {
    const divider = line.indexOf(':');
    if (divider < 0) continue;
    const key = line.slice(0, divider).trim();
    if (key) entries[key] = line.slice(divider + 1).trim();
  }
  return entries;
}

function formatDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type, fallback) => parts.find((part) => part.type === type)?.value || fallback;
  return `${read('year', '0000')}-${read('month', '01')}-${read('day', '01')}`;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

class PersonalityWorkspaceService {
  constructor({
    userDataPath,
    openPathImpl,
    nowProvider,
    legacyStockHashes,
    legacyStockSizes,
    logger,
    readRetiredAssistantIdentity,
    maxArchivedEntries,
  } = {}) {
    if (!userDataPath) throw new Error('userDataPath is required for PersonalityWorkspaceService.');
    this.userDataPath = userDataPath;
    this.workspacePath = path.join(userDataPath, WORKSPACE_DIRECTORY);
    this.memoryDirectoryPath = path.join(this.workspacePath, MEMORY_DIRECTORY);
    this.legacyDirectoryPath = path.join(this.workspacePath, LEGACY_DIRECTORY);
    this.personalityStatePath = path.join(this.workspacePath, PERSONALITY_STATE_FILENAME);
    this.openPathImpl = typeof openPathImpl === 'function' ? openPathImpl : null;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.legacyStockHashes = legacyStockHashes || LEGACY_STOCK_HASHES;
    this.legacyStockSizes = legacyStockSizes || (legacyStockHashes ? null : LEGACY_STOCK_SIZES);
    this.logger = typeof logger === 'function' ? logger : null;
    this.readRetiredAssistantIdentity = typeof readRetiredAssistantIdentity === 'function'
      ? readRetiredAssistantIdentity
      : null;
    this.schemaVersion = PERSONALITY_WORKSPACE_SCHEMA_VERSION;
    this.templates = PLACEHOLDER_TEMPLATES;
    this.contextFileMaxBytes = CONTEXT_FILE_MAX_BYTES;
    this.errorCodes = PERSONALITY_ERROR_CODES;
    this.formatDateKey = formatDateKey;
    this.maxArchivedEntries = Number.isSafeInteger(maxArchivedEntries) && maxArchivedEntries > 0
      ? maxArchivedEntries
      : MAX_ARCHIVED_ENTRIES;
    this._seedPromise = null;
    this._createdDirectories = [];
    // Snapshot the retired assistantIdentity eagerly. The shell-config schema
    // 47 bump drops `profile`/`customText` the next time shell-config is
    // written, which can happen before the (lazy) v3 workspace migration runs;
    // reading at construction closes that window. Never rejects.
    this._retiredIdentityPromise = this._loadRetiredAssistantIdentity();
    this._invalidateCompiledContextCache();
  }

  // ---------------------------------------------------------------- seeding

  ensureSeeded() {
    if (!this._seedPromise) {
      this._seedPromise = this._ensureSeeded().finally(() => {
        this._seedPromise = null;
      });
    }
    return this._seedPromise;
  }

  async _ensureSeeded() {
    await fs.mkdir(this.workspacePath, { recursive: true });
    const state = await this._readPersonalityState();
    if (state.version > PERSONALITY_WORKSPACE_SCHEMA_VERSION) {
      throw new PersonalityWorkspaceSchemaError(state.version);
    }
    if (state.version < PERSONALITY_WORKSPACE_SCHEMA_VERSION) {
      await migratePersonalityWorkspaceToV3(this);
      this._invalidateCompiledContextCache();
      return;
    }
    await this._seedMissingPlaceholders();
  }

  async _seedMissingPlaceholders() {
    for (const definition of FIXED_FILE_DEFINITIONS) {
      const filePath = path.join(this.workspacePath, definition.filename);
      if (!(await this.fileExists(filePath))) {
        await fs.writeFile(filePath, PLACEHOLDER_TEMPLATES[definition.key], 'utf8');
      }
    }
  }

  async _readPersonalityState() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.personalityStatePath, 'utf8'));
      const version = Number(parsed?.version);
      return {
        version: Number.isInteger(version) && version >= 1 ? version : 1,
        migratedFiles: Array.isArray(parsed?.migrated_files) ? parsed.migrated_files : [],
        archivedFiles: Array.isArray(parsed?.archived_files) ? parsed.archived_files : [],
        mergedFrom: Array.isArray(parsed?.merged_from) ? parsed.merged_from : [],
      };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.name === 'SyntaxError') {
        return { version: 1, migratedFiles: [], archivedFiles: [], mergedFrom: [] };
      }
      throw error;
    }
  }

  async _writePersonalityState(state) {
    const temporaryPath = `${this.personalityStatePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, this.personalityStatePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  /**
   * The retired `assistantIdentity.profile` / `.customText` pair, read once by
   * the v3 migration so a user's pre-v3 custom text is not lost when the
   * shell-config schema bump drops those keys. Read-only and bounded: a
   * missing, oversized, or malformed shell-config yields `{}` and the
   * migration seeds a placeholder note instead.
   */
  async _readRetiredAssistantIdentity() {
    return this._retiredIdentityPromise;
  }

  async _loadRetiredAssistantIdentity() {
    if (this.readRetiredAssistantIdentity) {
      try {
        return (await this.readRetiredAssistantIdentity()) || {};
      } catch (_error) {
        return {};
      }
    }
    try {
      const filePath = path.join(this.userDataPath, 'shell-config.json');
      const stat = await fs.stat(filePath);
      if (stat.size > SHELL_CONFIG_MAX_BYTES) return {};
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const identity = parsed?.assistantIdentity || parsed?.assistant_identity;
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return {};
      const profile = String(identity.profile || '').trim().toLowerCase();
      return {
        profile: Object.prototype.hasOwnProperty.call(PRESET_SENTENCES, profile) ? profile : '',
        customText: String(identity.customText || identity.custom_text || '')
          .slice(0, RETIRED_CUSTOM_TEXT_MAX_CHARS)
          .trim(),
      };
    } catch (_error) {
      return {};
    }
  }

  /**
   * Directories the in-flight migration created, so a rollback can remove the
   * empty `legacy/` tree it left behind instead of advertising an archive that
   * holds nothing.
   */
  _rememberCreatedDirectory(directoryPath) {
    this._createdDirectories.push(directoryPath);
  }

  _resetCreatedDirectories() {
    this._createdDirectories = [];
  }

  async _removeCreatedDirectories() {
    const directories = [...this._createdDirectories].sort((a, b) => b.length - a.length);
    for (const directoryPath of directories) {
      // rmdir (not rm -r): a directory that still holds anything is left alone.
      await fs.rmdir(directoryPath).catch(() => {});
    }
    this._resetCreatedDirectories();
  }

  // ---------------------------------------------------------------- reading

  /**
   * What the Settings textarea shows: the RAW file text, minus the leading
   * frontmatter block for USER.md only (that block is app-owned -- the save
   * path re-emits it verbatim, so showing it would duplicate it). Everything
   * else -- headings, inline comments, thematic breaks -- round-trips
   * byte-identically through load/edit/save. A file that still equals its
   * placeholder template reads as '' so the editor starts empty.
   *
   * The COMPILED body (`entry.body`) stays normalized; that split is the whole
   * point: the editor shows what you typed, "Show exact text" shows what the
   * model gets.
   */
  _editorBody(definition, raw) {
    const text = String(raw ?? '');
    if (!text.trim() || text.trim() === PLACEHOLDER_TEMPLATES[definition.key].trim()) return '';
    if (definition.key !== FILE_KEYS.USER) return text.trim();
    const frontmatter = extractFrontmatterBlock(text);
    if (!frontmatter) return text.trim();
    return text.replace(frontmatter, '').trim();
  }

  async _readFileEntry(definition) {
    const filePath = path.join(this.workspacePath, definition.filename);
    const empty = {
      key: definition.key,
      sectionId: definition.sectionId,
      filename: definition.filename,
      raw: '',
      body: '',
      editorBody: '',
      chars: 0,
      oversized: false,
    };
    try {
      await this._assertContainedContextPath(filePath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return empty;
      if (stat.size > CONTEXT_FILE_MAX_BYTES) {
        this._logContextFileFailure('read', definition.sectionId, {
          code: PERSONALITY_ERROR_CODES.FILE_TOO_LARGE,
        });
        return { ...empty, oversized: true };
      }
      const raw = await fs.readFile(filePath, 'utf8');
      const body = normalizeBody(raw);
      return {
        ...empty, raw, body, editorBody: this._editorBody(definition, raw), chars: body.length,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return empty;
      if (error?.code === 'CONTEXT_FILE_PATH_UNSAFE') throw error;
      this._logContextFileFailure('read', definition.sectionId, error);
      return empty;
    }
  }

  async _readAllEntries() {
    const entries = {};
    for (const definition of FIXED_FILE_DEFINITIONS) {
      entries[definition.key] = await this._readFileEntry(definition);
    }
    return entries;
  }

  async _compile() {
    const entries = await this._readAllEntries();
    const { content, sections, backstopClipped } = compilePersonalitySections({
      personality: entries[FILE_KEYS.PERSONALITY].body,
      user: entries[FILE_KEYS.USER].body,
      memory: entries[FILE_KEYS.MEMORY].body,
    });
    if (backstopClipped) {
      this._log('WARN', 'personality_workspace.compiled_backstop_clipped', {
        maxBytes: ADVANCED_CONTEXT_MAX_BYTES,
        sections: sections.filter((section) => section.clipped).map((section) => section.id).join(','),
      });
    }
    return { content, sections, backstopClipped, entries };
  }

  async _compiledSnapshot({ fresh = false } = {}) {
    const filePaths = FIXED_FILE_DEFINITIONS.map(
      (definition) => path.join(this.workspacePath, definition.filename)
    );
    const mtimeKey = await this._computeMtimeKey(filePaths);
    if (!fresh && this._compiledCache && this._compiledCacheMtimeKey === mtimeKey) {
      return this._compiledCache;
    }
    const compiled = await this._compile();
    this._compiledCache = compiled;
    this._compiledCacheMtimeKey = mtimeKey;
    return compiled;
  }

  _invalidateCompiledContextCache() {
    this._compiledCache = null;
    this._compiledCacheMtimeKey = null;
  }

  async _computeMtimeKey(filePaths) {
    const parts = [];
    for (const filePath of filePaths) {
      try {
        const stat = await fs.stat(filePath);
        const digest = stat.size <= COMPILED_CONTEXT_DIGEST_MAX_BYTES
          ? await this._hashSmallFile(filePath) : 'large';
        parts.push(`${stat.mtimeMs}:${stat.size}:${digest}`);
      } catch {
        parts.push('0');
      }
    }
    return parts.join(':');
  }

  async _hashSmallFile(filePath) {
    try {
      return sha256(await fs.readFile(filePath)).slice(0, 16);
    } catch {
      return 'missing';
    }
  }

  // ----------------------------------------------------------- public reads

  /**
   * Wire content for `context_blocks[kind=personality]`: the `### …` sections
   * only. The sidecar prepends the heading and name line.
   *
   * @returns {Promise<string>}
   */
  async getCompiledContext() {
    await this.ensureSeeded();
    return (await this._compiledSnapshot()).content;
  }

  /**
   * One call for the whole Settings Personality section.
   *
   * @param {{agentName?: string}} [options]
   */
  async getState({ agentName } = {}) {
    await this.ensureSeeded();
    const state = await this._readPersonalityState();
    const compiled = await this._compiledSnapshot();
    return {
      agentName: normalizeAgentName(agentName),
      files: {
        personality: this._fileView(compiled.entries[FILE_KEYS.PERSONALITY]),
        user: this._fileView(compiled.entries[FILE_KEYS.USER]),
      },
      budgets: { ...SECTION_BUDGETS },
      compiled: this._compiledView(agentName, compiled),
      schemaVersion: state.version,
      migration: { mergedFrom: state.mergedFrom, archivedFiles: state.archivedFiles },
    };
  }

  /**
   * `body` is the editable raw text; `chars` is the NORMALIZED length, i.e.
   * what actually counts against the section budget (the same number
   * `compiled.sections[].chars` reports).
   */
  _fileView(entry) {
    return { body: entry.editorBody, chars: entry.chars, oversized: entry.oversized === true };
  }

  _compiledView(agentName, compiled) {
    const text = buildPersonalityMessage(agentName, compiled.content);
    return {
      text,
      chars: text.length,
      tokensEstimate: estimateTokens(text),
      sections: compiled.sections.map((section) => ({ ...section })),
      backstopClipped: compiled.backstopClipped === true,
    };
  }

  /** MEMORY.md state for the Settings -> Memory "Long-term notes" group. */
  async getNotesState() {
    await this.ensureSeeded();
    const entry = await this._readFileEntry(DEFINITION_BY_KEY[FILE_KEYS.MEMORY]);
    const clipped = clipToBudget(entry.body, SECTION_BUDGETS.memory);
    return {
      // Editable raw text; `chars` is the normalized, budget-relevant length.
      body: entry.editorBody,
      chars: entry.chars,
      budget: SECTION_BUDGETS.memory,
      compiledChars: entry.body ? clipped.text.length : 0,
      oversized: entry.oversized === true,
    };
  }

  /** Bounded MEMORY.md view for the companion morning briefing. */
  async getNotesSnapshot() {
    await this.ensureSeeded();
    const entry = await this._readFileEntry(DEFINITION_BY_KEY[FILE_KEYS.MEMORY]);
    return { available: Boolean(entry.body), notes: entry.body };
  }

  async getResolvedTimeZone(ensure = true) {
    if (ensure) await this.ensureSeeded();
    const entry = await this._readFileEntry(DEFINITION_BY_KEY[FILE_KEYS.USER]);
    const parsed = extractFrontmatter(entry.raw);
    return isValidTimeZone(parsed.timezone) ? parsed.timezone : getSystemTimeZone();
  }

  // ---------------------------------------------------------- public writes

  /**
   * Save the Personality section. `personality` / `user` are normalized bodies;
   * a missing key leaves that file untouched. Each file is written atomically
   * and independently, so a partial failure leaves the other file's last-good
   * content in place.
   *
   * A file whose on-disk copy is over the 64 KiB limit reads back as empty, so
   * a renderer that loaded before the file grew would silently blank it. Such a
   * write is REFUSED with `CMP-PERS-0002` unless the caller passes
   * `force: true` (the explicit "yes, replace it" path).
   *
   * @param {{agentName?: string, personality?: string, user?: string, force?: boolean}} [payload]
   */
  async save(payload = {}) {
    await this.ensureSeeded();
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const targets = [
      [FILE_KEYS.PERSONALITY, source.personality],
      [FILE_KEYS.USER, source.user],
    ].filter(([, body]) => body !== undefined && body !== null);
    return this._applyWrites(targets, source.agentName, source.force === true);
  }

  /**
   * Reset both Personality files to their placeholder templates. Clearing is
   * the one destructive action the user asks for by name (behind a confirm
   * dialog), so it forces past the oversized guard.
   */
  async clear({ agentName } = {}) {
    await this.ensureSeeded();
    return this._applyWrites([[FILE_KEYS.PERSONALITY, ''], [FILE_KEYS.USER, '']], agentName, true, true);
  }

  async _applyWrites(targets, agentName, force = false, reset = false) {
    const failed = [];
    let code = '';
    for (const [key, body] of targets) {
      const result = await this._writeBody(key, body, force, reset);
      if (result.ok) continue;
      failed.push(DEFINITION_BY_KEY[key].sectionId);
      code = code || result.code;
    }
    this._invalidateCompiledContextCache();
    const compiled = await this._compiledSnapshot({ fresh: true });
    const view = this._compiledView(agentName, compiled);
    if (failed.length) {
      return {
        ok: false,
        code,
        failed,
        agentName: normalizeAgentName(agentName),
        compiled: view,
      };
    }
    return { ok: true, agentName: normalizeAgentName(agentName), compiled: view };
  }

  /** Replace MEMORY.md's body. Same oversized guard as `save`. */
  async writeNotes(payload = {}) {
    await this.ensureSeeded();
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const result = await this._writeBody(FILE_KEYS.MEMORY, source.body, source.force === true);
    this._invalidateCompiledContextCache();
    if (!result.ok) return { ok: false, code: result.code, failed: ['memory'] };
    return { ok: true, ...(await this.getNotesState()) };
  }

  /** Reset MEMORY.md to its placeholder template (explicit, so it forces). */
  async resetNotes() {
    await this.ensureSeeded();
    const result = await this._writeBody(FILE_KEYS.MEMORY, '', true);
    this._invalidateCompiledContextCache();
    if (!result.ok) return { ok: false, code: result.code, failed: ['memory'] };
    return { ok: true, ...(await this.getNotesState()) };
  }

  async _writeBody(key, body, force = false, reset = false) {
    const definition = DEFINITION_BY_KEY[key];
    const filePath = path.join(this.workspacePath, definition.filename);
    const entry = await this._readFileEntry(definition);
    if (entry.oversized && !force) {
      // The renderer showed an empty box for this file because it is over the
      // read limit. Writing that box back would destroy it.
      this._logContextFileFailure('write_refused_oversized', definition.sectionId, {
        code: PERSONALITY_ERROR_CODES.FILE_TOO_LARGE,
      });
      return { ok: false, code: PERSONALITY_ERROR_CODES.FILE_TOO_LARGE };
    }
    const normalized = String(body ?? '').replace(/\r\n/g, '\n').trim();
    let content = PLACEHOLDER_TEMPLATES[key];
    const frontmatter = key === FILE_KEYS.USER && !reset ? extractFrontmatterBlock(entry.raw) : '';
    if (normalized || frontmatter) {
      content = frontmatter ? `${frontmatter}\n${normalized ? `${normalized}\n` : ''}` : `${normalized}\n`;
    }
    if (Buffer.byteLength(content, 'utf8') > CONTEXT_FILE_MAX_BYTES) {
      this._logContextFileFailure('write', definition.sectionId, {
        code: PERSONALITY_ERROR_CODES.FILE_TOO_LARGE,
      });
      return { ok: false, code: PERSONALITY_ERROR_CODES.FILE_TOO_LARGE };
    }
    try {
      await this._atomicWriteContextFile(filePath, content);
      return { ok: true };
    } catch (error) {
      this._logContextFileFailure('write', definition.sectionId, error);
      return { ok: false, code: PERSONALITY_ERROR_CODES.SAVE_PARTIAL_FAILURE };
    }
  }

  async openWorkspaceFolder() {
    await this.ensureSeeded();
    if (!this.openPathImpl) return { ok: false, message: 'Workspace folder opening is unavailable.' };
    try {
      const result = await this.openPathImpl(this.workspacePath);
      if (!result) return { ok: true, message: '' };
      this._logContextFileFailure('open_folder', 'workspace', { code: 'launch_failed' });
      return { ok: false, message: 'Unable to open the context-files folder.' };
    } catch (error) {
      this._logContextFileFailure('open_folder', 'workspace', error);
      return { ok: false, message: 'Unable to open the context-files folder.' };
    }
  }

  // ------------------------------------------------------------- file plumbing

  async _assertContainedContextPath(filePath) {
    const rootRealPath = await fs.realpath(this.workspacePath);
    const parentRealPath = await fs.realpath(path.dirname(filePath));
    const relativeParent = path.relative(rootRealPath, parentRealPath);
    if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) {
      const error = new Error('Context file path is outside the managed workspace.');
      error.code = 'CONTEXT_FILE_PATH_UNSAFE';
      throw error;
    }
    try {
      const targetStat = await fs.lstat(filePath);
      if (targetStat.isSymbolicLink()) {
        const error = new Error('Symbolic links are not supported for context files.');
        error.code = 'CONTEXT_FILE_PATH_UNSAFE';
        throw error;
      }
      const targetRealPath = await fs.realpath(filePath);
      const relativeTarget = path.relative(rootRealPath, targetRealPath);
      if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        const error = new Error('Context file path is outside the managed workspace.');
        error.code = 'CONTEXT_FILE_PATH_UNSAFE';
        throw error;
      }
      return targetRealPath;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return filePath;
  }

  async _atomicWriteContextFile(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await this._assertContainedContextPath(filePath);
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
    );
    let handle = null;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, filePath);
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async _matchesKnownStockFile(filePath, hashes, sizes) {
    const knownHashes = Array.isArray(hashes) ? hashes : [];
    if (!knownHashes.length) return false;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > LEGACY_STOCK_FILE_MAX_BYTES) return false;
      if (Array.isArray(sizes) && sizes.length && !sizes.includes(stat.size)) return false;
      return knownHashes.includes(sha256(await fs.readFile(filePath)));
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async captureFileSnapshot(filePath) {
    try {
      return { exists: true, content: await fs.readFile(filePath) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, content: Buffer.alloc(0) };
      throw error;
    }
  }

  async restoreFileSnapshot(filePath, snapshot) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (!snapshot?.exists) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await fs.writeFile(filePath, snapshot.content);
  }

  // ----------------------------------------------------------- observability

  _log(level, event, details) {
    try {
      this.logger?.(level, event, details);
    } catch (_error) { /* diagnostics must not mask the bounded failure */ }
  }

  _logContextFileFailure(operation, scope, error) {
    this._log('WARN', 'personality_workspace.context_file_operation_failed', {
      operation,
      scope,
      reason: String(error?.code || 'io_failure').slice(0, 64),
    });
  }

  /** Migration diagnostics carry workspace-relative names only, never paths. */
  _logMigrationEvent(level, step, details = {}) {
    this._log(level, 'personality_workspace.migration', { step, ...details });
  }
}

module.exports = {
  ADVANCED_CONTEXT_MAX_BYTES,
  CLIP_MARKER,
  CONTEXT_FILE_MAX_BYTES,
  LEGACY_DIRECTORY,
  LEGACY_STOCK_HASHES,
  LEGACY_STOCK_SIZES,
  MEMORY_DIRECTORY,
  PERSONALITY_HEADING,
  PERSONALITY_PRECEDENCE_TEMPLATE,
  PERSONALITY_STATE_FILENAME,
  PERSONALITY_WORKSPACE_SCHEMA_VERSION,
  PLACEHOLDER_TEMPLATES,
  PRESET_SENTENCES,
  SECTION_BUDGETS,
  PersonalityWorkspaceService,
  WORKSPACE_DIRECTORY,
  buildPersonalityMessage,
  compilePersonalitySections,
  estimateTokens,
  extractFrontmatter,
  formatDateKey,
  getSystemTimeZone,
  isValidTimeZone,
  normalizeAgentName,
  normalizeBody,
};
