-- Phase 12B / A.B.6 release-compat fixture: pre-v4 memory store at v3.
-- v3 had memory_entries + memories with family_key + provenance columns;
-- the v4 tables (memory_extraction_runs, pending_memory_candidates) were
-- not yet introduced. Migration to v5 must create them.
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
    'session_legacy_v3_a',
    'Working preference: diagnose root cause first',
    'Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.',
    'working_preference',
    0.85,
    'asked user to keep digging on the bug',
    'working_preference:diagnose-root-cause-first',
    'diagnose_root_cause_first',
    'structured_user_pin',
    '2026-01-10T00:00:00+00:00',
    '2026-01-10T00:00:00+00:00'
);

PRAGMA user_version=3;
