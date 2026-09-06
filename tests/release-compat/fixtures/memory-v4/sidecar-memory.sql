-- Phase 12B / A.B.6 release-compat fixture: pre-v5 memory store at v4.
-- v4 had every table that v5 has; v5's only data change is normalizing
-- empty/NULL provenance to 'unknown_legacy'. The seeded memory has
-- provenance='' so the migration test can verify the UPDATE fires.
CREATE TABLE memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    user_content TEXT NOT NULL,
    assistant_content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

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

CREATE TABLE memory_extraction_runs (
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, request_id)
);

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

INSERT INTO memories (
    session_id,
    title,
    lesson_text,
    lesson_kind,
    confidence,
    source_excerpt,
    content_fingerprint,
    family_key,
    provenance,
    created_at,
    updated_at
) VALUES (
    'session_legacy_v4_a',
    'Project context: electron owns canonical history',
    'Electron owns canonical conversation history and persistence.',
    'project_context',
    0.95,
    'noted during architecture review',
    'project_context:electron-owns-canonical-conversation-history',
    'electron_owns_canonical_history',
    '',
    '2026-03-01T00:00:00+00:00',
    '2026-03-01T00:00:00+00:00'
);

PRAGMA user_version=4;
