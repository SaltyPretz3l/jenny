-- Phase 12B / A.B.6 release-compat fixture: pre-v3 memory store at v2.
-- v2 had memory_entries + the original memories table without the
-- family_key / provenance columns. The migration to v5 must add both
-- columns and run migrate_v2_family_key against each row, projecting the
-- canonical fingerprint -> family_key mapping documented in
-- sidecar/ai/memory/store_migrations.py.
--
-- The single seeded memory uses the canonical fingerprint for the
-- "prefer ripgrep" tool-strategy lesson so the migration test can verify
-- the fingerprint_map lookup path is exercised end-to-end.
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_memories_fingerprint ON memories(content_fingerprint);

INSERT INTO memories (
    session_id,
    title,
    lesson_text,
    lesson_kind,
    confidence,
    source_excerpt,
    content_fingerprint,
    created_at,
    updated_at
) VALUES (
    'session_legacy_v2_a',
    'Tool strategy: prefer ripgrep',
    'For repository text search tasks, prefer rg (ripgrep) when it is available.',
    'tool_strategy',
    0.9,
    'use rg over grep when scanning the repo',
    'tool_strategy:for-repository-text-search-tasks-prefer-rg-ripgrep-when-it-is-available',
    '2025-12-01T00:00:00+00:00',
    '2025-12-01T00:00:00+00:00'
);

PRAGMA user_version=2;
