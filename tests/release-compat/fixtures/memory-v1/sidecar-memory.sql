-- Phase 12B / A.B.6 release-compat fixture: pre-v3 memory store at v1.
-- v1 had only memory_entries (the request/response log); the memories
-- vocabulary tables (memories, memory_extraction_runs,
-- pending_memory_candidates) are absent. Migration to v5 must create them.
CREATE TABLE memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    user_content TEXT NOT NULL,
    assistant_content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

INSERT INTO memory_entries (request_id, user_content, assistant_content, created_at) VALUES
    ('req_legacy_v1_1', 'how do I list files', 'use ls or rg --files for repo searches', '2025-09-15T08:30:00+00:00'),
    ('req_legacy_v1_2', 'what is jenny', 'a local-first chat app with tool use', '2025-09-15T09:15:00+00:00');

PRAGMA user_version=1;
