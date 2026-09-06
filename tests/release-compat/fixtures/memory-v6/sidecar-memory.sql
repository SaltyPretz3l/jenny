-- Release-compat fixture: complete predecessor schema for the v7 migration.
CREATE TABLE memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    user_content TEXT NOT NULL,
    assistant_content TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_entries_created_at ON memory_entries(created_at DESC);
CREATE INDEX idx_memory_entries_retention ON memory_entries(created_at ASC, id ASC);

CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    lesson_text TEXT NOT NULL,
    lesson_kind TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_excerpt TEXT NOT NULL DEFAULT '',
    content_fingerprint TEXT NOT NULL,
    family_key TEXT NOT NULL DEFAULT '',
    provenance TEXT NOT NULL DEFAULT 'unknown_legacy',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_memories_fingerprint ON memories(content_fingerprint);
CREATE INDEX idx_memories_updated_at ON memories(updated_at DESC);
CREATE INDEX idx_memories_updated_id ON memories(updated_at DESC, id DESC);
CREATE INDEX idx_memories_kind_updated ON memories(lesson_kind, updated_at DESC, id DESC);
CREATE INDEX idx_memories_session_updated ON memories(session_id, updated_at DESC, id DESC);

CREATE TABLE memory_extraction_runs (
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, request_id)
);
CREATE INDEX idx_memory_extraction_runs_created
  ON memory_extraction_runs(created_at ASC, session_id, request_id);

CREATE TABLE pending_memory_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    title TEXT NOT NULL,
    lesson_text TEXT NOT NULL,
    lesson_kind TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_excerpt TEXT NOT NULL DEFAULT '',
    content_fingerprint TEXT NOT NULL,
    family_key TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_pending_memory_session_fingerprint
  ON pending_memory_candidates(session_id, content_fingerprint);
CREATE INDEX idx_pending_memory_session_updated
  ON pending_memory_candidates(session_id, updated_at DESC);
CREATE INDEX idx_pending_memory_updated_id
  ON pending_memory_candidates(updated_at DESC, id DESC);

INSERT INTO memory_entries VALUES (
  1, 'raw-request', 'private user transcript', 'private assistant transcript',
  '2026-01-01T00:00:00+00:00'
);
INSERT INTO memories VALUES (
  1, 'session-v6', 'Concise', 'Use concise answers.', 'response_style', 0.9,
  'be concise', 'response_style:use-concise-answers', '', 'user_approved',
  '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'
);
INSERT INTO memories VALUES (
  2, 'session-v6', 'Duplicate concise', 'Use concise answers.', 'response_style', 0.8,
  'short answers', 'response_style:duplicate-slug', '', 'user_approved',
  '2025-12-31T00:00:00+00:00', '2025-12-31T00:00:00+00:00'
);
INSERT INTO pending_memory_candidates VALUES (
  1, 'session-v6', 'request-v6', 'Tea', 'The user prefers tea.', 'preference', 0.8,
  'tea', 'preference:tea', '', 'user',
  '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00'
);
INSERT INTO memory_extraction_runs VALUES (
  'session-v6', 'request-v6', '2026-01-01T00:00:00+00:00'
);

PRAGMA user_version=6;
