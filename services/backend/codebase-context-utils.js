/**
 * Codebase grounding utilities for chat context injection ("local RAG-lite").
 *
 * Performs a BOUNDED keyword search over the open workspace root and returns a
 * formatted context block listing up to N real `file:line` snippets, so the
 * model can answer "where is X handled?" style questions citing actual
 * locations the user can click through to.
 *
 * This is deliberately "grounded search", NOT semantic retrieval: plain
 * case-insensitive substring matching with hard caps (files scanned, bytes
 * read, snippets emitted, and a wall-clock budget) so it never stalls the chat
 * critical path or pins a modest at-home machine. No embeddings, no native
 * dependency.
 *
 * Mirrors the shape/return contract of ./git-context-utils.js: returns a string
 * suitable for splicing in as a system message, or null when there is nothing
 * useful to contribute (no root, unreadable root, no usable query keywords, or
 * no matches).
 */

const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

// --- Bounds (keep retrieval cheap + predictable) ---------------------------
const MAX_KEYWORDS = 8;
const MIN_KEYWORD_LENGTH = 3;
const MAX_FILES_SCANNED = 800; // candidate text files actually read
const MAX_FILE_BYTES = 256 * 1024; // skip larger files (likely generated/minified)
const MAX_TOTAL_READ_BYTES = 16 * 1024 * 1024; // overall read budget
const MAX_SNIPPETS = 12; // total file:line snippets in the block
const MAX_SNIPPETS_PER_FILE = 3;
const MAX_LINE_LENGTH = 240; // truncate very long matched lines (matches search preview)
const MAX_BLOCK_CHARS = 4000; // mirror git-context-utils MAX_DIFF_CHARS budget
const TIME_BUDGET_MS = 1500; // stop walking/reading past this wall-clock budget

// The candidate-file WALK (directory traversal) is the same every turn for a
// given root, so we cache the file LIST (paths only — never contents) for a
// short TTL. This keeps grounding off the per-turn critical path: on a cache
// hit the whole time budget is spent on the fresh reads/scoring instead of
// re-walking the tree. Trade-off: a file added within the TTL window is not
// grounded until the entry expires (acceptable for best-effort grounding).
const CANDIDATE_CACHE_TTL_MS = 30_000;
const CANDIDATE_CACHE_MAX_ROOTS = 32; // bound memory; usually a single root in practice
const candidateCache = new Map(); // absRoot -> { expires, files, truncated }

// Directories never worth scanning for grounding.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.jenny', '.hg', '.svn',
  'dist', 'build', 'out', 'coverage', 'artifacts', 'tmp',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo',
  'vendor', 'venv', '.venv', 'env', '__pycache__', '.pytest_cache',
  '.idea', '.vscode-test', 'node-gyp', '.gradle', 'target',
]);

// Only scan source-ish text files; everything else is skipped before reading.
// Deliberately omits `.env`: extname() already drops the dotfile forms
// (.env / .env.local / .env.production), and the only thing the entry caught
// was `name.env` (e.g. prod.env / secrets.env) — exactly the credential-bearing
// files whose lines must never be read into a grounding block. The renderer
// citation linkifier (renderer-chat-codebase-cite-utils.js EXTENSIONS) mirrors
// this set minus `.m`/`.mm`, which it intentionally does not linkify (see the
// note there); keep the two lists in sync for every other extension.
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.json', '.jsonc',
  '.md', '.markdown', '.css', '.scss', '.sass', '.less', '.html', '.htm',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.txt', '.sql', '.graphql', '.gql',
  '.go', '.rs', '.java', '.kt', '.rb', '.php', '.c', '.h', '.cpp', '.hpp',
  '.cc', '.cs', '.swift', '.m', '.mm', '.vue', '.svelte', '.astro', '.xml',
]);

// Stripped from the natural-language query so "where is auth handled?" searches
// for "auth"/"handled", not "where"/"is". Kept intentionally small — generic
// English question/filler words plus a few code-prose connectives.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'with', 'this', 'that',
  'have', 'from', 'they', 'what', 'where', 'when', 'which', 'who', 'whom',
  'how', 'why', 'does', 'did', 'doing', 'done', 'can', 'could', 'would',
  'should', 'will', 'shall', 'into', 'onto', 'about', 'your', 'yours', 'our',
  'their', 'them', 'then', 'than', 'there', 'here', 'these', 'those', 'such',
  'some', 'any', 'all', 'each', 'every', 'its', 'his', 'her', 'has', 'had',
  'was', 'were', 'been', 'being', 'get', 'got', 'let', 'use', 'used', 'using',
  'via', 'per', 'out', 'off', 'over', 'under', 'between', 'within', 'while',
  'show', 'tell', 'find', 'look', 'looking', 'please', 'thanks', 'handled',
  'handle', 'handles', 'work', 'works', 'working', 'code', 'file', 'files',
  'function', 'functions', 'method', 'methods', 'class', 'classes',
]);

function isString(value) {
  return typeof value === 'string';
}

/**
 * Extract a small, de-duplicated set of search keywords from a free-text query.
 * Tokenizes on non-identifier characters, lowercases, and drops stopwords and
 * very short tokens. Caps the result so the per-file scan stays cheap.
 *
 * Tokenization is intentionally ASCII-only ([a-z0-9_]); accented/non-Latin
 * query terms degrade to nearest-ASCII fragments or are dropped, which only
 * affects recall for non-ASCII identifiers (an accepted trade for simplicity).
 */
function extractKeywords(query, max = MAX_KEYWORDS) {
  if (!isString(query)) {
    return [];
  }
  const seen = new Set();
  const keywords = [];
  const tokens = query.toLowerCase().split(/[^a-z0-9_]+/);
  for (const token of tokens) {
    if (token.length < MIN_KEYWORD_LENGTH) {
      continue;
    }
    if (STOPWORDS.has(token)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= max) {
      break;
    }
  }
  return keywords;
}

function hasNullByte(buffer) {
  // Full-buffer native scan. Cheap because candidate files are already capped at
  // maxFileBytes (256 KB), so scanning all of it (vs. only a 4 KB head) is well
  // within budget and prevents a text-headed/binary-tailed file from slipping a
  // partial binary line into a snippet.
  return buffer.indexOf(0) !== -1;
}

/**
 * Recursively collect candidate text-file paths under root (depth-first,
 * deterministic order), honoring the skip-dir and file-count caps. Returns
 * { files, truncated } where truncated indicates the walk hit a cap.
 */
async function collectCandidateFiles(root, deadline) {
  const files = [];
  let truncated = false;
  let deadlineHit = false; // distinguishes a (non-deterministic) time-out from the file cap
  const stack = [root];
  while (stack.length > 0) {
    if (files.length >= MAX_FILES_SCANNED) {
      truncated = true;
      break;
    }
    if (Date.now() > deadline) {
      truncated = true;
      deadlineHit = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip silently
    }
    // Re-check the budget before the O(n log n) sort + per-entry loop so a
    // single very large directory cannot run uninterrupted past the deadline.
    if (Date.now() > deadline) {
      truncated = true;
      deadlineHit = true;
      break;
    }
    // Sort for deterministic traversal (dirs and files interleaved by name).
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subDirs = [];
    for (let e = 0; e < entries.length; e += 1) {
      // Honor the wall-clock budget within a huge directory too (cheap check,
      // sampled so Date.now() isn't called for every single entry).
      if ((e & 1023) === 0 && Date.now() > deadline) {
        truncated = true;
        deadlineHit = true;
        break;
      }
      const entry = entries[e];
      if (entry.isSymbolicLink()) {
        continue; // never follow symlinks (loop / escape safety)
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        subDirs.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) {
        continue;
      }
      files.push(path.join(dir, entry.name));
      if (files.length >= MAX_FILES_SCANNED) {
        truncated = true;
        break;
      }
    }
    // Push sub-directories in reverse so the deterministic sort order is
    // preserved when popped off the stack.
    for (let i = subDirs.length - 1; i >= 0; i -= 1) {
      stack.push(subDirs[i]);
    }
  }
  return { files, truncated, deadlineHit };
}

// --- Candidate-file-list cache (paths only, short TTL) ---------------------
function readCandidateCache(root, now) {
  const entry = candidateCache.get(root);
  if (!entry) {
    return null;
  }
  if (entry.expires <= now) {
    candidateCache.delete(root);
    return null;
  }
  // deadlineHit is only consulted on the fresh-walk branch, so a cache hit
  // (which skips that branch) need not carry it.
  return { files: entry.files, truncated: entry.truncated };
}

function writeCandidateCache(root, candidate, expires) {
  // Evict the oldest entry (Map preserves insertion order) only when adding a
  // genuinely new root at capacity; usually a single, stable root in practice.
  if (!candidateCache.has(root) && candidateCache.size >= CANDIDATE_CACHE_MAX_ROOTS) {
    candidateCache.delete(candidateCache.keys().next().value);
  }
  candidateCache.set(root, {
    expires,
    files: candidate.files,
    truncated: candidate.truncated,
  });
}

function toPosixRelative(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join('/');
}

// Normalize a caller-supplied exclude list (POSIX-relative workspace paths) into
// a Set for O(1) skip lookups during scoring. Backslashes are folded to '/' and
// a leading './' is stripped so the entries line up with toPosixRelative output;
// empty/non-string entries are dropped.
function buildExcludeSet(excludePaths) {
  const set = new Set();
  if (!Array.isArray(excludePaths)) {
    return set;
  }
  for (const raw of excludePaths) {
    if (!isString(raw)) {
      continue;
    }
    const normalized = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized) {
      set.add(normalized);
    }
  }
  return set;
}

function countDistinctKeywordHits(lowerLine, keywords) {
  let count = 0;
  for (const keyword of keywords) {
    if (lowerLine.includes(keyword)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Score a single file's content against the keyword set, collecting the best
 * matching lines (most distinct keyword hits first). Returns null when the
 * file matches nothing.
 */
function scoreFileContent(relPath, content, keywords) {
  const lowerPath = relPath.toLowerCase();
  let pathMatches = 0;
  for (const keyword of keywords) {
    if (lowerPath.includes(keyword)) {
      pathMatches += 1;
    }
  }

  const lines = content.split(/\r\n|\r|\n/);
  const distinctInFile = new Set();
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const lowerLine = rawLine.toLowerCase();
    const hits = countDistinctKeywordHits(lowerLine, keywords);
    if (hits === 0) {
      continue;
    }
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        distinctInFile.add(keyword);
      }
    }
    candidates.push({ line: i + 1, hits, text: rawLine.trim() });
  }

  // Require at least one matching content line: a filename-only match has no
  // `file:line` to cite, and including it (with empty snippets) would both
  // crowd the ranking and spuriously trip the "results truncated" note.
  // pathMatches still boosts the score of files that DO have content matches.
  if (candidates.length === 0) {
    return null;
  }

  // Best lines first: more distinct keyword hits, then earlier in the file.
  candidates.sort((a, b) => (b.hits - a.hits) || (a.line - b.line));
  const snippets = candidates.slice(0, MAX_SNIPPETS_PER_FILE).map((c) => ({
    line: c.line,
    text: c.text.length > MAX_LINE_LENGTH ? `${c.text.slice(0, MAX_LINE_LENGTH)}…` : c.text,
  }));

  // File score rewards path-name matches (a strong "this file is about X"
  // signal) and the breadth of distinct keywords found in the file.
  const score = (pathMatches * 5) + (distinctInFile.size * 2) + Math.min(candidates.length, 5);
  return { relPath, score, snippets, matchedLineCount: candidates.length };
}

/**
 * Retrieve a compact "grounded search" context block for the open workspace,
 * suitable for injection as a system message in chat context assembly.
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root.
 * @param {string} query - The user's prompt / recall query to ground against.
 * @param {object} [options] - Test/tuning overrides (caps + time budget).
 * @returns {Promise<string|null>}
 */
async function getCodebaseContext(workspaceRoot, query, options = {}) {
  if (!workspaceRoot || !isString(workspaceRoot)) {
    return null;
  }

  const maxSnippets = Number.isFinite(options.maxSnippets)
    ? Math.max(1, options.maxSnippets) : MAX_SNIPPETS;
  const maxFileBytes = Number.isFinite(options.maxFileBytes)
    ? Math.max(1, options.maxFileBytes) : MAX_FILE_BYTES;
  const maxTotalReadBytes = Number.isFinite(options.maxTotalReadBytes)
    ? Math.max(1, options.maxTotalReadBytes) : MAX_TOTAL_READ_BYTES;
  const timeBudgetMs = Number.isFinite(options.timeBudgetMs)
    ? Math.max(1, options.timeBudgetMs) : TIME_BUDGET_MS;
  const maxKeywords = Number.isFinite(options.maxKeywords)
    ? Math.max(1, options.maxKeywords) : MAX_KEYWORDS;
  // A non-positive TTL is the single "no cache" switch — it gates BOTH the read
  // and the write, so candidateCacheTtlMs:0 always re-walks fresh.
  const candidateCacheTtlMs = Number.isFinite(options.candidateCacheTtlMs)
    ? Math.max(0, options.candidateCacheTtlMs) : CANDIDATE_CACHE_TTL_MS;
  const cacheEnabled = candidateCacheTtlMs > 0;
  // Cross-source dedupe: paths already carried by another context block (e.g. the
  // active-file slice) are excluded so the same file is never grounded twice.
  const excludeSet = buildExcludeSet(options.excludePaths);
  const startedAt = Date.now();
  const deadline = startedAt + timeBudgetMs;

  const keywords = extractKeywords(query, maxKeywords);
  if (keywords.length === 0) {
    return null;
  }

  // Confirm the root is a readable directory before walking.
  try {
    const rootStat = await fsp.stat(workspaceRoot);
    if (!rootStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  // Reuse a recent candidate-file listing for this root when available; on a
  // miss, walk fresh and cache the result UNLESS the walk timed out (a
  // deadline-truncated list is non-deterministic and likely partial, so we let
  // the next turn retry with a fresh budget rather than pin a degenerate list).
  let candidate = cacheEnabled ? readCandidateCache(workspaceRoot, startedAt) : null;
  if (!candidate) {
    try {
      candidate = await collectCandidateFiles(workspaceRoot, deadline);
    } catch {
      return null;
    }
    if (cacheEnabled && !candidate.deadlineHit) {
      writeCandidateCache(workspaceRoot, candidate, startedAt + candidateCacheTtlMs);
    }
  }
  const { files } = candidate;
  let walkTruncated = candidate.truncated;

  const scored = [];
  let totalRead = 0;
  let readTruncated = false;
  for (const absPath of files) {
    if (Date.now() > deadline || totalRead >= maxTotalReadBytes) {
      readTruncated = true;
      break;
    }
    const relPath = toPosixRelative(workspaceRoot, absPath);
    if (excludeSet.has(relPath)) {
      // Already supplied by a higher-priority context block — never re-emit it,
      // and don't let it count toward the read budget or truncation note.
      continue;
    }
    let stats;
    try {
      stats = await fsp.stat(absPath);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size === 0 || stats.size > maxFileBytes) {
      continue;
    }
    let buffer;
    try {
      buffer = await fsp.readFile(absPath);
    } catch {
      continue;
    }
    totalRead += buffer.length;
    if (hasNullByte(buffer)) {
      continue; // binary file — skip
    }
    const result = scoreFileContent(relPath, buffer.toString('utf8'), keywords);
    if (result) {
      scored.push(result);
    }
  }

  if (scored.length === 0) {
    return null;
  }

  // Rank files by score, then by path for stable ordering.
  scored.sort((a, b) => (b.score - a.score) || (a.relPath < b.relPath ? -1 : 1));

  const snippetLines = [];
  let emitted = 0;
  let matchedFiles = 0;
  for (const file of scored) {
    if (emitted >= maxSnippets) {
      break;
    }
    let fileEmitted = false;
    for (const snippet of file.snippets) {
      if (emitted >= maxSnippets) {
        break;
      }
      const text = snippet.text ? ` — ${snippet.text}` : '';
      snippetLines.push(`- ${file.relPath}:${snippet.line}${text}`);
      emitted += 1;
      fileEmitted = true;
    }
    if (fileEmitted) {
      matchedFiles += 1;
    }
  }

  if (snippetLines.length === 0) {
    return null;
  }

  const truncated = walkTruncated || readTruncated || scored.length > matchedFiles;
  const sections = [
    '[Codebase grounding — keyword search over the open project]',
    'These are real locations in the user\'s open workspace that match their question. '
      + 'When your answer points at one of them, cite it as a `path:line` reference '
      + '(e.g. services/auth/login.js:42) so the user can click straight to it. '
      + 'Only cite locations you have verified are relevant; this is a keyword search, not a guarantee.',
    `Search terms: ${keywords.join(', ')}`,
    'Matches:',
    ...snippetLines,
  ];
  if (truncated) {
    sections.push(
      `(Showing ${emitted} match${emitted === 1 ? '' : 'es'}; retrieval was capped — results may be incomplete.)`
    );
  }

  let block = sections.join('\n');
  if (block.length > MAX_BLOCK_CHARS) {
    const suffix = `\n… (codebase context truncated at ${MAX_BLOCK_CHARS} chars)`;
    block = `${block.slice(0, MAX_BLOCK_CHARS - suffix.length)}${suffix}`;
  }
  return block;
}

module.exports = {
  getCodebaseContext,
  extractKeywords,
};
