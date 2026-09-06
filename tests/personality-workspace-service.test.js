const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ADVANCED_CONTEXT_MAX_BYTES,
  CONTEXT_FILE_MAX_BYTES,
  LEGACY_STOCK_HASHES,
  LEGACY_STOCK_SIZES,
  PERSONALITY_HEADING,
  PERSONALITY_STATE_FILENAME,
  PERSONALITY_WORKSPACE_SCHEMA_VERSION,
  PLACEHOLDER_TEMPLATES,
  SECTION_BUDGETS,
  PersonalityWorkspaceService,
  extractFrontmatter,
  normalizeBody,
} = require('../services/personality-workspace-service');
const { PERSONALITY_ERROR_CODES } = require('../services/backend/error-codes');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function createWorkspace() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-personality-v3-'));
  trackDirectory(userDataPath);
  const workspacePath = path.join(userDataPath, 'personality', 'default-workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  return { userDataPath, workspacePath };
}

function createService(userDataPath, options = {}) {
  return new PersonalityWorkspaceService({
    userDataPath,
    nowProvider: options.nowProvider,
    openPathImpl: options.openPathImpl,
    legacyStockHashes: options.legacyStockHashes,
    legacyStockSizes: options.legacyStockSizes,
    logger: options.logger,
    readRetiredAssistantIdentity: options.readRetiredAssistantIdentity,
    maxArchivedEntries: options.maxArchivedEntries,
  });
}

async function readWorkspaceFile(workspacePath, filename) {
  return fs.readFile(path.join(workspacePath, filename), 'utf8');
}

test('a fresh workspace seeds v3 placeholders that compile to nothing', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const service = createService(userDataPath);

  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(state.schemaVersion, PERSONALITY_WORKSPACE_SCHEMA_VERSION);
  assert.equal(await service.getCompiledContext(), '');
  assert.deepEqual(state.compiled.sections, []);
  assert.equal(state.compiled.text.startsWith(`${PERSONALITY_HEADING}\nYour name is Jenny.`), true);
  assert.equal(state.files.personality.chars, 0);
  assert.equal(state.files.user.chars, 0);
  assert.deepEqual(state.budgets, { personality: 1500, user: 1000, memory: 1500 });

  for (const [key, filename] of Object.entries({
    PERSONALITY: 'PERSONALITY.md', USER: 'USER.md', MEMORY: 'MEMORY.md',
  })) {
    assert.equal(await readWorkspaceFile(workspacePath, filename), PLACEHOLDER_TEMPLATES[key]);
  }
  assert.rejects(fs.access(path.join(workspacePath, 'IDENTITY.md')));

  // Idempotent: a second seed must not overwrite user content.
  await fs.writeFile(path.join(workspacePath, 'PERSONALITY.md'), '# note\n\nkeep me\n', 'utf8');
  await service.ensureSeeded();
  assert.equal(await readWorkspaceFile(workspacePath, 'PERSONALITY.md'), '# note\n\nkeep me\n');
});

test('the empty and sample compiled messages stay inside the personality token budget', async () => {
  const { userDataPath } = await createWorkspace();
  const service = createService(userDataPath);

  const empty = await service.getState({ agentName: 'Jenny' });
  assert.ok(
    empty.compiled.tokensEstimate <= 80,
    `empty workspace compiled to ${empty.compiled.tokensEstimate} tokens`
  );
  assert.equal(empty.compiled.tokensEstimate, Math.ceil(empty.compiled.text.length / 4));

  const note = "You're a friend, not a help desk: warm, casual, a little playful. Slang and mild swears are fine (damn/hell/wtf/crap — no f-bombs). Have opinions; say \"idk\" when you don't know. No \"great question\", no forced positivity, no emoji spam. When I'm deep in debugging or reviewing code, drop the bubbliness and get clear and useful — same person, lower volume. If I'm venting, be a friend about it; not every \"ugh\" needs a plan.";
  const about = 'Brendan (b, dude are fine). Financial analyst; building Jenny on the side. Casual, scattered, creative. CST.';
  const saved = await service.save({ agentName: 'Jenny', personality: note, user: about });

  assert.equal(saved.ok, true);
  assert.ok(
    saved.compiled.tokensEstimate <= 300,
    `sample workspace compiled to ${saved.compiled.tokensEstimate} tokens`
  );
  assert.match(saved.compiled.text, /^## Personality\nYour name is Jenny\. Personality shapes tone, not facts;/);
  assert.match(saved.compiled.text, /\n\n### Voice\n\n/);
  assert.match(saved.compiled.text, /\n\n### About the user\n\n/);
});

test('compiled sections are ordered, wire content omits the header, and empty sections vanish', async () => {
  const { userDataPath } = await createWorkspace();
  const service = createService(userDataPath);
  await service.save({ personality: 'voice body', user: '' });
  await service.writeNotes({ body: 'notes body' });

  const wire = await service.getCompiledContext();
  assert.equal(wire, '### Voice\n\nvoice body\n\n### Notes\n\nnotes body');
  assert.doesNotMatch(wire, /## Personality/);
  assert.doesNotMatch(wire, /About the user/);

  const state = await service.getState({ agentName: 'Ada' });
  assert.deepEqual(state.compiled.sections.map((section) => section.id), ['personality', 'memory']);
  assert.equal(state.compiled.text, `## Personality\nYour name is Ada. Personality shapes tone, not facts; the current request and the runtime, workspace, and tool instructions take precedence over everything below.\n\n${wire}`);
});

test('over-budget bodies clip per section with a marker, never by truncating the join', async () => {
  const { userDataPath } = await createWorkspace();
  const service = createService(userDataPath);
  await service.save({
    personality: `${'v'.repeat(SECTION_BUDGETS.personality + 500)}`,
    user: 'short about-you',
  });
  await service.writeNotes({ body: 'notes survive the clip' });

  const state = await service.getState({ agentName: 'Jenny' });
  const [voice, about, notes] = state.compiled.sections;
  assert.deepEqual(
    { id: voice.id, clipped: voice.clipped, budget: voice.budget },
    { id: 'personality', clipped: true, budget: SECTION_BUDGETS.personality }
  );
  assert.equal(voice.chars, SECTION_BUDGETS.personality + 500);
  assert.equal(about.clipped, false);
  assert.equal(notes.clipped, false);

  const wire = await service.getCompiledContext();
  const voiceBody = wire.split('\n\n')[1];
  assert.equal(voiceBody.length, SECTION_BUDGETS.personality);
  assert.ok(voiceBody.endsWith(' […]'));
  // The later sections are still whole -- the old bug truncated the join.
  assert.match(wire, /### About the user\n\nshort about-you/);
  assert.match(wire, /### Notes\n\nnotes survive the clip$/);
  assert.ok(Buffer.byteLength(wire, 'utf8') <= ADVANCED_CONTEXT_MAX_BYTES);
});

test('body normalization drops frontmatter, comments and one H1, in either legacy order', () => {
  assert.equal(normalizeBody(PLACEHOLDER_TEMPLATES.PERSONALITY), '');
  assert.equal(normalizeBody(PLACEHOLDER_TEMPLATES.USER), '');
  assert.equal(normalizeBody(PLACEHOLDER_TEMPLATES.MEMORY), '');
  assert.equal(
    normalizeBody('# User Profile\n\n---\ntimezone: CST\n---\n\n- Preferred name: Sam\n'),
    '- Preferred name: Sam'
  );
  assert.equal(
    normalizeBody('---\ntimezone: CST\n---\n# About you\n\n<!-- hint -->\nbody text\n'),
    'body text'
  );
  // Only the FIRST H1 goes; later headings are content the user can see.
  assert.equal(normalizeBody('# One\n\ntext\n\n# Two\n'), 'text\n\n# Two');
});

test('saving About you preserves legacy frontmatter bytes and writes no H1', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await fs.writeFile(
    path.join(workspacePath, 'USER.md'),
    '# User Profile\n\n---\ntimezone: America/Chicago\n---\n\n- Preferred name: Sam\n',
    'utf8'
  );
  const service = createService(userDataPath);

  assert.equal(await service.getResolvedTimeZone(), 'America/Chicago');
  const saved = await service.save({ user: 'Sam. Prefers short answers.' });
  assert.equal(saved.ok, true);

  const raw = await readWorkspaceFile(workspacePath, 'USER.md');
  assert.equal(raw, '---\ntimezone: America/Chicago\n---\n\nSam. Prefers short answers.\n');
  assert.equal(extractFrontmatter(raw).timezone, 'America/Chicago');
  assert.doesNotMatch(raw, /^#/m);
  // The timezone survives the rewrite, which is the whole point of preserving it.
  assert.equal(await service.getResolvedTimeZone(), 'America/Chicago');
});

test('an empty save body restores the placeholder and clear resets both files', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const service = createService(userDataPath);
  await service.save({ personality: 'tone', user: 'about' });
  await service.writeNotes({ body: 'long-term notes stay' });

  const cleared = await service.clear({ agentName: 'Jenny' });
  assert.equal(cleared.ok, true);
  assert.equal(await readWorkspaceFile(workspacePath, 'PERSONALITY.md'), PLACEHOLDER_TEMPLATES.PERSONALITY);
  assert.equal(await readWorkspaceFile(workspacePath, 'USER.md'), PLACEHOLDER_TEMPLATES.USER);
  assert.deepEqual(cleared.compiled.sections.map((section) => section.id), ['memory']);
  assert.equal((await service.getNotesSnapshot()).notes, 'long-term notes stay');
});

test('a missing save key leaves that file untouched', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const service = createService(userDataPath);
  await service.save({ personality: 'tone one', user: 'about one' });

  await service.save({ personality: 'tone two' });
  assert.match(await readWorkspaceFile(workspacePath, 'PERSONALITY.md'), /tone two/);
  assert.match(await readWorkspaceFile(workspacePath, 'USER.md'), /about one/);
});

test('a partial save failure names the failed section and preserves last-good content', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const events = [];
  const service = createService(userDataPath, {
    logger: (level, event, details) => events.push({ level, event, details }),
  });
  await service.save({ personality: 'good tone', user: 'good about' });

  const realWrite = service._atomicWriteContextFile.bind(service);
  service._atomicWriteContextFile = async (filePath, content) => {
    if (filePath.endsWith('USER.md')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return realWrite(filePath, content);
  };

  const result = await service.save({ personality: 'new tone', user: 'new about' });
  assert.equal(result.ok, false);
  assert.equal(result.code, PERSONALITY_ERROR_CODES.SAVE_PARTIAL_FAILURE);
  assert.deepEqual(result.failed, ['user']);
  assert.match(await readWorkspaceFile(workspacePath, 'PERSONALITY.md'), /new tone/);
  assert.match(await readWorkspaceFile(workspacePath, 'USER.md'), /good about/);
  assert.equal(events.at(-1).details.reason, 'ENOSPC');
  assert.equal(events.at(-1).details.scope, 'user');
});

test('a body over 64 KiB is refused with CMP-PERS-0002 and an oversized file reads as empty', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const events = [];
  const service = createService(userDataPath, {
    logger: (level, event, details) => events.push({ level, event, details }),
  });
  await service.save({ personality: 'bounded tone' });

  const rejected = await service.save({ personality: 'x'.repeat(CONTEXT_FILE_MAX_BYTES + 1) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, PERSONALITY_ERROR_CODES.FILE_TOO_LARGE);
  assert.deepEqual(rejected.failed, ['personality']);
  assert.match(await readWorkspaceFile(workspacePath, 'PERSONALITY.md'), /bounded tone/);

  await fs.writeFile(
    path.join(workspacePath, 'PERSONALITY.md'),
    'y'.repeat(CONTEXT_FILE_MAX_BYTES + 1),
    'utf8'
  );
  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(state.files.personality.oversized, true);
  assert.equal(state.files.personality.body, '');
  assert.deepEqual(state.compiled.sections, []);
  assert.ok(events.some((entry) => entry.details.reason === PERSONALITY_ERROR_CODES.FILE_TOO_LARGE));
  assert.deepEqual(
    (await fs.readdir(workspacePath)).filter((name) => name.includes('.tmp-')),
    []
  );
});

// Adversarial review, BLOCKER 2b: an oversized file reads back as empty, so a
// renderer that loaded before the file grew would post an empty draft and blank
// it. The write is refused unless the caller says "yes, replace it".
test('a save over an oversized file is refused unless it explicitly forces', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const events = [];
  const service = createService(userDataPath, {
    logger: (level, event, details) => events.push({ level, event, details }),
  });
  await service.ensureSeeded();
  const huge = "MY LIFE'S WORK. ".concat('x'.repeat(70 * 1024));
  for (const filename of ['PERSONALITY.md', 'MEMORY.md']) {
    await fs.writeFile(path.join(workspacePath, filename), huge, 'utf8');
  }
  service._invalidateCompiledContextCache();

  const refused = await service.save({ personality: 'one keystroke' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, PERSONALITY_ERROR_CODES.FILE_TOO_LARGE);
  assert.deepEqual(refused.failed, ['personality']);
  assert.equal(await readWorkspaceFile(workspacePath, 'PERSONALITY.md'), huge);

  const refusedNotes = await service.writeNotes({ body: 'one keystroke' });
  assert.deepEqual(refusedNotes, {
    ok: false, code: PERSONALITY_ERROR_CODES.FILE_TOO_LARGE, failed: ['memory'],
  });
  assert.equal(await readWorkspaceFile(workspacePath, 'MEMORY.md'), huge);
  assert.ok(events.some((entry) => entry.details.operation === 'write_refused_oversized'));

  // The deliberate paths still work: force on save, and the explicit resets.
  const forced = await service.save({ personality: 'deliberate replacement', force: true });
  assert.equal(forced.ok, true);
  assert.match(await readWorkspaceFile(workspacePath, 'PERSONALITY.md'), /deliberate replacement/);
  assert.equal((await service.resetNotes()).ok, true);
  assert.equal(await readWorkspaceFile(workspacePath, 'MEMORY.md'), PLACEHOLDER_TEMPLATES.MEMORY);
});

// Adversarial review, SHOULD-FIX 5: the editor shows the RAW file so a load /
// edit / save cycle cannot silently eat a heading, an inline comment or a
// thematic break. Only the compiled body is normalized.
test('the editor body round-trips byte-identically while the compiled body stays normalized', async () => {
  const cases = [
    ['leading H1', '# House rules\n\nAlways answer in bullets.', 'Always answer in bullets.'],
    ['thematic break start', '---\nBe terse.\n---\nAlways cite sources.', 'Always cite sources.'],
    ['inline comment', 'Be terse. <!-- never mention this --> Always cite.', 'Be terse.  Always cite.'],
    ['unterminated comment', 'Be terse. <!-- oops', 'Be terse.'],
    ['plain', 'Be terse. Always cite.', 'Be terse. Always cite.'],
    ['thematic break later', 'Intro\n\n---\n\nOutro', 'Intro\n\n---\n\nOutro'],
  ];
  for (const [label, input, expectedCompiled] of cases) {
    const { userDataPath } = await createWorkspace();
    const service = createService(userDataPath);
    await service.save({ personality: input });
    const state = await service.getState({ agentName: 'Jenny' });
    assert.equal(state.files.personality.body, input, `${label} lost bytes on the round trip`);
    assert.equal(state.compiled.sections[0]?.chars ?? 0, expectedCompiled.length, `${label} chars`);
    const wire = await service.getCompiledContext();
    assert.equal(
      wire,
      expectedCompiled ? `### Voice\n\n${expectedCompiled}` : '',
      `${label} compiled body`
    );
    // Saving what the editor showed must be a no-op, not a slow erosion.
    await service.save({ personality: state.files.personality.body });
    assert.equal((await service.getState({})).files.personality.body, input, `${label} second pass`);
  }
});

test('a placeholder file reads as an empty editor body', async () => {
  const { userDataPath } = await createWorkspace();
  const service = createService(userDataPath);
  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(state.files.personality.body, '');
  assert.equal(state.files.user.body, '');
  assert.equal((await service.getNotesState()).body, '');
});

test('the editor body for About you hides only the app-owned frontmatter block', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await fs.writeFile(
    path.join(workspacePath, 'USER.md'),
    '# About you\n---\ntimezone: America/Chicago\n---\n\nBrendan. Analyst.\n',
    'utf8'
  );
  const service = createService(userDataPath);

  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(state.files.user.body, '# About you\n\nBrendan. Analyst.');
  assert.doesNotMatch(state.files.user.body, /timezone/);

  await service.save({ user: state.files.user.body });
  const raw = await readWorkspaceFile(workspacePath, 'USER.md');
  assert.equal(raw, '---\ntimezone: America/Chicago\n---\n\n# About you\n\nBrendan. Analyst.\n');
  assert.equal(await service.getResolvedTimeZone(), 'America/Chicago');
  assert.equal((await service.getState({})).files.user.body, '# About you\n\nBrendan. Analyst.');
});

// Adversarial review, SHOULD-FIX 3: the char budgets sum to 4,000 which is
// ~12 KiB of CJK. Truncating the joined block would have dropped whole sections
// while every counter still read green.
test('the 4 KiB backstop clips every section rather than dropping the later ones', async () => {
  const { userDataPath } = await createWorkspace();
  const service = createService(userDataPath);
  const events = [];
  service.logger = (level, event, details) => events.push({ level, event, details });
  await service.save({ personality: '漢'.repeat(1400), user: '漢'.repeat(900) });
  await service.writeNotes({ body: '漢'.repeat(1400) });

  const wire = await service.getCompiledContext();
  assert.ok(Buffer.byteLength(wire, 'utf8') <= ADVANCED_CONTEXT_MAX_BYTES);
  for (const heading of ['### Voice', '### About the user', '### Notes']) {
    assert.ok(wire.includes(heading), `${heading} must survive the backstop`);
  }

  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(state.compiled.backstopClipped, true);
  assert.deepEqual(
    state.compiled.sections.map((section) => ({ id: section.id, clipped: section.clipped })),
    [
      { id: 'personality', clipped: true },
      { id: 'user', clipped: true },
      { id: 'memory', clipped: true },
    ]
  );
  assert.ok(events.some((entry) => entry.event === 'personality_workspace.compiled_backstop_clipped'));

  // An ASCII workspace never touches the backstop.
  const plain = createService((await createWorkspace()).userDataPath);
  await plain.save({ personality: 'a'.repeat(1400), user: 'b'.repeat(900) });
  assert.equal((await plain.getState({})).compiled.backstopClipped, false);
});

test('the notes surface owns MEMORY.md only and reports its clipped contribution', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const service = createService(userDataPath);

  const seeded = await service.getNotesState();
  assert.deepEqual(seeded, {
    body: '', chars: 0, budget: SECTION_BUDGETS.memory, compiledChars: 0, oversized: false,
  });
  assert.deepEqual(await service.getNotesSnapshot(), { available: false, notes: '' });

  const written = await service.writeNotes({ body: 'z'.repeat(SECTION_BUDGETS.memory + 40) });
  assert.equal(written.ok, true);
  assert.equal(written.chars, SECTION_BUDGETS.memory + 40);
  assert.equal(written.compiledChars, SECTION_BUDGETS.memory);
  assert.match(await service.getCompiledContext(), /### Notes\n\nz+ \[…\]$/);

  const reset = await service.resetNotes();
  assert.equal(reset.ok, true);
  assert.equal(reset.chars, 0);
  assert.equal(await readWorkspaceFile(workspacePath, 'MEMORY.md'), PLACEHOLDER_TEMPLATES.MEMORY);
  assert.equal(await service.getCompiledContext(), '');
});

test('v2 -> v3 merges IDENTITY and SOUL byte-preserving into legacy and archives memory', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const identity = Buffer.from('# Identity\r\n\r\nYou are Jenny, and you like it here.\r\n');
  const soul = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('# Soul\n\nYou are a friend.\n')]);
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), identity);
  await fs.writeFile(path.join(workspacePath, 'SOUL.md'), soul);
  await fs.writeFile(path.join(workspacePath, 'USER.md'), 'custom user bytes\n', 'utf8');
  await fs.mkdir(path.join(workspacePath, 'memory'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'memory', 'auto-dream.md'), 'stale dream\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'memory', '2026-04-05.md'), 'daily note\n', 'utf8');
  await fs.writeFile(
    path.join(workspacePath, PERSONALITY_STATE_FILENAME),
    JSON.stringify({ version: 2, preserved_custom_files: ['IDENTITY.md', 'SOUL.md'] }),
    'utf8'
  );
  const events = [];
  const service = createService(userDataPath, {
    nowProvider: () => new Date('2026-08-21T12:00:00.000Z'),
    logger: (level, event, details) => events.push({ level, event, details }),
  });

  const state = await service.getState({ agentName: 'Jenny' });
  const merged = await readWorkspaceFile(workspacePath, 'PERSONALITY.md');
  assert.ok(merged.startsWith('<!-- Merged from IDENTITY.md and SOUL.md on 2026-08-21.'));
  assert.match(merged, /You are Jenny, and you like it here\./);
  assert.match(merged, /You are a friend\./);

  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'legacy', 'IDENTITY.md')), identity);
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'legacy', 'SOUL.md')), soul);
  await assert.rejects(fs.access(path.join(workspacePath, 'IDENTITY.md')));
  await assert.rejects(fs.access(path.join(workspacePath, 'SOUL.md')));

  assert.equal(
    await fs.readFile(path.join(workspacePath, 'legacy', 'memory', 'auto-dream.md'), 'utf8'),
    'stale dream\n'
  );
  await assert.rejects(fs.access(path.join(workspacePath, 'memory')));
  assert.equal(await readWorkspaceFile(workspacePath, 'USER.md'), 'custom user bytes\n');

  assert.equal(state.schemaVersion, 3);
  assert.deepEqual(state.migration.mergedFrom, ['IDENTITY.md', 'SOUL.md']);
  assert.deepEqual(state.migration.archivedFiles.sort(), [
    'IDENTITY.md', 'SOUL.md', 'memory/2026-04-05.md', 'memory/auto-dream.md',
  ].sort());
  // The merge comment never reaches the MODEL, but it stays visible in the
  // editor: the editor body is the raw file so nothing vanishes on save.
  assert.doesNotMatch(await service.getCompiledContext(), /Merged from IDENTITY\.md/);
  assert.match(state.files.personality.body, /^<!-- Merged from IDENTITY\.md/);
  assert.ok(events.some((entry) => entry.details.step === 'merged'));
});

test('v3 discards app-owned stock halves and seeds a placeholder when nothing is user-authored', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const stockIdentity = Buffer.from('app-owned identity\n');
  const stockSoul = Buffer.from('app-owned soul\n');
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), stockIdentity);
  await fs.writeFile(path.join(workspacePath, 'SOUL.md'), stockSoul);
  const service = createService(userDataPath, {
    legacyStockHashes: {
      'IDENTITY.md': [digest(stockIdentity)],
      'SOUL.md': [digest(stockSoul)],
    },
  });

  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(await readWorkspaceFile(workspacePath, 'PERSONALITY.md'), PLACEHOLDER_TEMPLATES.PERSONALITY);
  assert.deepEqual(state.migration.mergedFrom, []);
  assert.deepEqual(state.migration.archivedFiles, []);
  await assert.rejects(fs.access(path.join(workspacePath, 'legacy', 'IDENTITY.md')));
  assert.equal(await service.getCompiledContext(), '');
});

test('v3 carries a retired profile and custom flavor into an otherwise empty note', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const service = createService(userDataPath, {
    readRetiredAssistantIdentity: async () => ({ profile: 'concise', customText: 'Never use emoji.' }),
  });

  await service.ensureSeeded();
  const body = await readWorkspaceFile(workspacePath, 'PERSONALITY.md');
  assert.equal(
    body,
    'Shortest complete answer. Keep required caveats, drop everything else.\n\nNever use emoji.\n'
  );
  assert.match(await service.getCompiledContext(), /### Voice\n\nShortest complete answer/);
});

test('v3 appends retired custom text after merged content', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await fs.writeFile(path.join(workspacePath, 'SOUL.md'), '# Soul\n\nBe warm.\n', 'utf8');
  const service = createService(userDataPath, {
    readRetiredAssistantIdentity: async () => ({ profile: 'balanced', customText: 'Never use emoji.' }),
  });

  await service.ensureSeeded();
  const body = await readWorkspaceFile(workspacePath, 'PERSONALITY.md');
  assert.match(body, /Be warm\./);
  assert.ok(body.trimEnd().endsWith('Never use emoji.'));
});

test('a failed v3 migration rolls every file back and leaves the schema unadvanced', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const identity = Buffer.from('# Identity\n\nuser identity text\n');
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), identity);
  await fs.mkdir(path.join(workspacePath, 'memory'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'memory', '2026-04-05.md'), 'daily note\n', 'utf8');
  const events = [];
  const service = createService(userDataPath, {
    logger: (level, event, details) => events.push({ level, event, details }),
  });
  const originalWriteState = service._writePersonalityState.bind(service);
  service._writePersonalityState = async () => { throw new Error('disk full'); };

  await assert.rejects(service.ensureSeeded(), /disk full/);
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'IDENTITY.md')), identity);
  assert.equal(await fs.readFile(path.join(workspacePath, 'memory', '2026-04-05.md'), 'utf8'), 'daily note\n');
  await assert.rejects(fs.access(path.join(workspacePath, 'PERSONALITY.md')));
  await assert.rejects(fs.access(path.join(workspacePath, PERSONALITY_STATE_FILENAME)));
  // The rollback also removes the empty legacy/ tree it created: advertising an
  // archive that holds nothing is its own kind of lie.
  await assert.rejects(fs.access(path.join(workspacePath, 'legacy')));
  const rollback = events.find((entry) => entry.details.step === 'rolled_back');
  assert.equal(rollback.level, 'ERROR');
  assert.equal(rollback.details.code, PERSONALITY_ERROR_CODES.MIGRATION_ROLLED_BACK);

  // And the retry after the transient failure clears is clean.
  service._writePersonalityState = originalWriteState;
  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(state.schemaVersion, 3);
  assert.deepEqual(state.migration.mergedFrom, ['IDENTITY.md']);
  assert.match(await service.getCompiledContext(), /user identity text/);
});

// Adversarial review, BLOCKER 1: `_readPersonalityState` self-heals a lost or
// corrupted state file to v1, so the migration RE-ENTERS on a workspace that is
// already v3 with no merge sources left. It must not write a placeholder over
// the user's note.
test('a migration rerun after a lost state file preserves the existing note byte-identically', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), '# Identity\n\nI am a pirate.\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'SOUL.md'), '# Soul\n\nDeeply loyal.\n', 'utf8');
  await fs.mkdir(path.join(workspacePath, 'memory'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'memory', '2026-01-01.md'), 'day one\n', 'utf8');
  await createService(userDataPath).ensureSeeded();
  const merged = await fs.readFile(path.join(workspacePath, 'PERSONALITY.md'));

  for (const corrupted of ['{ this is not json', '']) {
    await fs.writeFile(path.join(workspacePath, PERSONALITY_STATE_FILENAME), corrupted, 'utf8');
    const events = [];
    const service = createService(userDataPath, {
      logger: (level, event, details) => events.push({ level, event, details }),
    });
    const state = await service.getState({ agentName: 'Jenny' });
    assert.deepEqual(
      await fs.readFile(path.join(workspacePath, 'PERSONALITY.md')),
      merged,
      `rerun with ${JSON.stringify(corrupted)} rewrote the note`
    );
    assert.equal(state.schemaVersion, 3);
    assert.match(await service.getCompiledContext(), /I am a pirate\./);
    assert.ok(events.some((entry) => entry.details.step === 'note_preserved'));
  }
});

test('a missing state file on a hand-written note records schema 3 without touching it', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await createService(userDataPath).ensureSeeded();
  await createService(userDataPath).save({ personality: 'Hand written. Do not touch.' });
  const before = await fs.readFile(path.join(workspacePath, 'PERSONALITY.md'));
  await fs.rm(path.join(workspacePath, PERSONALITY_STATE_FILENAME), { force: true });

  const state = await createService(userDataPath).getState({ agentName: 'Jenny' });
  assert.deepEqual(await fs.readFile(path.join(workspacePath, 'PERSONALITY.md')), before);
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.files.personality.body, 'Hand written. Do not touch.');
});

// Adversarial review, BLOCKER 2a: two 40 KB halves merge to ~82 KB, which reads
// back as `oversized` -- absent from every turn, and one keystroke from being
// truncated to two bytes.
test('an over-limit merged note keeps an editable head and parks the rest in legacy', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const identityBody = `IDENTITY LINE ${'i'.repeat(60)}\n`.repeat(600);
  const soulBody = `SOUL LINE ${'s'.repeat(60)}\n`.repeat(600);
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), `# Identity\n\n${identityBody}`, 'utf8');
  await fs.writeFile(path.join(workspacePath, 'SOUL.md'), `# Soul\n\n${soulBody}`, 'utf8');
  const events = [];
  const service = createService(userDataPath, {
    logger: (level, event, details) => events.push({ level, event, details }),
  });

  const state = await service.getState({ agentName: 'Jenny' });
  const noteBytes = (await fs.stat(path.join(workspacePath, 'PERSONALITY.md'))).size;
  assert.ok(
    noteBytes <= CONTEXT_FILE_MAX_BYTES - 1024,
    `merged note kept ${noteBytes} bytes, over the editable limit`
  );
  // The whole point: the note is readable, compiles, and is still writable.
  assert.equal(state.files.personality.oversized, false);
  assert.notEqual(state.files.personality.body, '');
  assert.deepEqual(state.compiled.sections.map((section) => section.id), ['personality']);
  assert.equal((await service.save({ personality: 'Trimmed by hand.' })).ok, true);

  const head = await fs.readFile(path.join(workspacePath, 'legacy', 'PERSONALITY.overflow.md'), 'utf8');
  assert.match(head, /SOUL LINE/);
  const overflow = events.find((entry) => entry.details.step === 'note_overflow');
  assert.equal(overflow.level, 'WARN');
  assert.equal(overflow.details.file, 'PERSONALITY.overflow.md');
  assert.ok(overflow.details.overflowBytes > 0);
  assert.ok(state.migration.archivedFiles.includes('PERSONALITY.overflow.md'));
});

// Adversarial review, SHOULD-FIX 7: a user who copied a backup into legacy/
// before upgrading must not lose it to a silent rename.
test('archiving never overwrites an existing legacy file', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), '# Identity\n\nNew voice.\n', 'utf8');
  await fs.mkdir(path.join(workspacePath, 'legacy'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'legacy', 'IDENTITY.md'), 'PRECIOUS BACKUP\n', 'utf8');
  const service = createService(userDataPath);

  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(
    await fs.readFile(path.join(workspacePath, 'legacy', 'IDENTITY.md'), 'utf8'),
    'PRECIOUS BACKUP\n'
  );
  assert.equal(
    await fs.readFile(path.join(workspacePath, 'legacy', 'IDENTITY.md.1'), 'utf8'),
    '# Identity\n\nNew voice.\n'
  );
  assert.deepEqual(state.migration.archivedFiles, ['IDENTITY.md.1']);
});

test('hitting the memory archive cap keeps the directory and still records schema 3', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, 'memory'), { recursive: true });
  for (const name of ['a.md', 'b.md', 'c.md']) {
    await fs.writeFile(path.join(workspacePath, 'memory', name), `${name}\n`, 'utf8');
  }
  const events = [];
  const service = createService(userDataPath, {
    maxArchivedEntries: 2,
    logger: (level, event, details) => events.push({ level, event, details }),
  });

  const state = await service.getState({ agentName: 'Jenny' });
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.migration.archivedFiles.length, 2);
  assert.equal((await fs.readdir(path.join(workspacePath, 'memory'))).length, 1);
  const steps = events.map((entry) => entry.details.step);
  assert.ok(steps.includes('archive_truncated'));
  assert.ok(steps.includes('archive_incomplete'));
});

test('the merge comment is dated in the workspace timezone, not UTC', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await fs.writeFile(path.join(workspacePath, 'IDENTITY.md'), '# Identity\n\nvoice\n', 'utf8');
  await fs.writeFile(
    path.join(workspacePath, 'USER.md'),
    '---\ntimezone: America/Chicago\n---\n\nBrendan.\n',
    'utf8'
  );
  // 02:00 UTC on the 22nd is still the 21st in America/Chicago.
  const service = createService(userDataPath, {
    nowProvider: () => new Date('2026-08-22T02:00:00.000Z'),
  });

  await service.ensureSeeded();
  const note = await readWorkspaceFile(workspacePath, 'PERSONALITY.md');
  assert.match(note, /^<!-- Merged from IDENTITY\.md and SOUL\.md on 2026-08-21\./);
});

test('a malformed state file self-heals and an idempotent rerun does not rewrite it', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  await fs.writeFile(path.join(workspacePath, PERSONALITY_STATE_FILENAME), '{ malformed', 'utf8');
  const service = createService(userDataPath);

  await service.ensureSeeded();
  const first = await fs.readFile(path.join(workspacePath, PERSONALITY_STATE_FILENAME));
  await service.ensureSeeded();
  const second = await fs.readFile(path.join(workspacePath, PERSONALITY_STATE_FILENAME));
  assert.deepEqual(second, first);
  assert.equal(JSON.parse(first).version, PERSONALITY_WORKSPACE_SCHEMA_VERSION);
});

test('a future schema rejects reads and writes without modifying workspace files', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const future = Buffer.from('{"version":99,"owner":"future"}\n');
  await fs.writeFile(path.join(workspacePath, PERSONALITY_STATE_FILENAME), future);
  const before = (await fs.readdir(workspacePath)).sort();
  const service = createService(userDataPath);

  await assert.rejects(service.getCompiledContext(), { code: 'PERSONALITY_WORKSPACE_FUTURE_SCHEMA' });
  await assert.rejects(service.getState(), { code: 'PERSONALITY_WORKSPACE_FUTURE_SCHEMA' });
  await assert.rejects(service.save({ personality: 'changed' }), { code: 'PERSONALITY_WORKSPACE_FUTURE_SCHEMA' });
  await assert.rejects(service.writeNotes({ body: 'changed' }), { code: 'PERSONALITY_WORKSPACE_FUTURE_SCHEMA' });
  assert.deepEqual((await fs.readdir(workspacePath)).sort(), before);
  assert.deepEqual(await fs.readFile(path.join(workspacePath, PERSONALITY_STATE_FILENAME)), future);
});

test('a realpath escape through a workspace file is refused', async (t) => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-personality-escape-'));
  trackDirectory(outside);
  const service = createService(userDataPath);
  await service.ensureSeeded();
  const target = path.join(workspacePath, 'MEMORY.md');
  await fs.rm(target, { force: true });
  try {
    await fs.symlink(path.join(outside, 'MEMORY.md'), target, 'file');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('Creating a containment-test link is not permitted on this host.');
      return;
    }
    throw error;
  }

  await assert.rejects(service.getNotesState(), { code: 'CONTEXT_FILE_PATH_UNSAFE' });
  await assert.rejects(fs.access(path.join(outside, 'MEMORY.md')));
});

test('the compiled cache invalidates on a same-size out-of-band write', async () => {
  const { userDataPath, workspacePath } = await createWorkspace();
  const service = createService(userDataPath);
  await service.save({ personality: 'ABCD' });
  assert.match(await service.getCompiledContext(), /ABCD/);

  await fs.writeFile(path.join(workspacePath, 'PERSONALITY.md'), 'WXYZ\n', 'utf8');
  assert.match(await service.getCompiledContext(), /WXYZ/);
});

test('opening the workspace folder never surfaces a raw path', async () => {
  const { userDataPath } = await createWorkspace();
  const opened = [];
  const okService = createService(userDataPath, {
    openPathImpl: async (target) => { opened.push(target); return ''; },
  });
  assert.deepEqual(await okService.openWorkspaceFolder(), { ok: true, message: '' });
  assert.equal(opened.length, 1);

  const failService = createService(userDataPath, {
    openPathImpl: async () => 'shell refused',
  });
  const failure = await failService.openWorkspaceFolder();
  assert.equal(failure.ok, false);
  assert.equal(failure.message, 'Unable to open the context-files folder.');
  assert.doesNotMatch(failure.message, /personality/);
});

test('the frozen v1 hash catalog still matches the migration fixture', async () => {
  const fixture = JSON.parse(await fs.readFile(
    path.join(__dirname, 'fixtures', 'personality-workspace-v1', 'presets.json'),
    'utf8'
  ));
  assert.deepEqual(LEGACY_STOCK_HASHES, fixture.file_hashes);
  assert.deepEqual(LEGACY_STOCK_SIZES, fixture.file_sizes);
});
