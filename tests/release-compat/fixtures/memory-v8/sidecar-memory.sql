-- memory-v8 fixture: a real v8 database (the shipped v8 DDL, lesson_text <= 240)
-- dumped with .dump (Python iterdump); user_version appended.
BEGIN TRANSACTION;
CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
            lesson_text TEXT NOT NULL
              CHECK(length(lesson_text) BETWEEN 1 AND 240),
            lesson_kind TEXT NOT NULL CHECK(length(lesson_kind) BETWEEN 1 AND 128),
            confidence REAL NOT NULL
              CHECK(typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0.0 AND 1.0),
            source_excerpt TEXT NOT NULL DEFAULT ''
              CHECK(length(source_excerpt) <= 1000),
            content_fingerprint TEXT NOT NULL CHECK(
                length(content_fingerprint) = 71
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            family_key TEXT NOT NULL DEFAULT '' CHECK(length(family_key) <= 128),
            provenance TEXT NOT NULL DEFAULT 'unknown_legacy'
              CHECK(length(provenance) BETWEEN 1 AND 32),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT 'project_general' CHECK(
        length(project_id) BETWEEN 9 AND 136
        AND substr(project_id, 1, 8) = 'project_'
        AND substr(project_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
            UNIQUE(project_id, content_fingerprint)
        );
INSERT INTO "memories" VALUES(2,'session-v8','Tea','The user prefers green tea.','preference',0.9,'excerpt','sha256:d7cd1ac3549ca6cc8c34d440ffcb6a53e58342d763fa0669b6d5dd14714a5cb9','','user_approved','2026-10-01T00:00:00+00:00','2026-10-01T00:00:00+00:00','project_general');
INSERT INTO "memories" VALUES(4,'session-v8','Tea profile','the user prefers GREEN tea.','profile',0.9,'excerpt','sha256:936ef5b4f66c77a69cdb75157c31ee3c0f0c5aad5621094ccad384ecb6df866f','','automatic','2026-10-02T00:00:00+00:00','2026-10-02T00:00:00+00:00','project_general');
INSERT INTO "memories" VALUES(6,'session-v8','Concise','Use concise answers.','response_style',0.9,'excerpt','sha256:791305c401216a8598917a1c9caacfc333a2224e74808ccf797b3b5e73feae24','','user_approved','2026-10-01T00:00:00+00:00','2026-10-01T00:00:00+00:00','project_general');
INSERT INTO "memories" VALUES(8,'session-v8','Search','Search with ripgrep before reading files.','tool_strategy',0.9,'excerpt','sha256:214c8b30504d0f2a9a5c6949f147da760dc2b58be14198f555a09eaf7748848b','','automatic','2026-10-01T00:00:00+00:00','2026-10-01T00:00:00+00:00','project_alpha');
INSERT INTO "memories" VALUES(10,'session-v8','Reviewer','Alice reviews every release.','important_person',0.9,'excerpt','sha256:ffc03a9f68cffea05795d79b14e02f034d926d09008b5d80c2c587c40bf76d5a','','unknown_legacy','2026-10-01T00:00:00+00:00','2026-10-01T00:00:00+00:00','project_alpha');
CREATE TABLE memory_extraction_runs (
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
            request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 256),
            status TEXT NOT NULL DEFAULT 'completed'
              CHECK(status IN ('in_progress', 'completed', 'failed')),
            attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count BETWEEN 0 AND 3),
            started_at TEXT,
            completed_at TEXT,
            failure_code TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT 'project_general' CHECK(
        length(project_id) BETWEEN 9 AND 136
        AND substr(project_id, 1, 8) = 'project_'
        AND substr(project_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
            PRIMARY KEY (project_id, session_id, request_id)
        );
INSERT INTO "memory_extraction_runs" VALUES('session-v8','request-v8','completed',1,NULL,NULL,'','2026-10-01T00:00:00+00:00','2026-10-01T00:00:00+00:00','project_general');
CREATE TABLE memory_quarantine (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL CHECK(length(source_table) BETWEEN 1 AND 64),
            source_row_id TEXT NOT NULL DEFAULT '' CHECK(length(source_row_id) <= 64),
            reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
            raw_payload TEXT NOT NULL CHECK(length(raw_payload) <= 2000),
            quarantined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
CREATE TABLE memory_suppressions (
            project_id TEXT NOT NULL DEFAULT 'project_general' CHECK(
        length(project_id) BETWEEN 9 AND 136
        AND substr(project_id, 1, 8) = 'project_'
        AND substr(project_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
            content_fingerprint TEXT NOT NULL CHECK(
                length(content_fingerprint) = 71
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            reason TEXT NOT NULL CHECK(reason IN ('forgotten', 'dismissed')),
            created_at TEXT NOT NULL,
            PRIMARY KEY(project_id, content_fingerprint)
        );
INSERT INTO "memory_suppressions" VALUES('project_general','sha256:c03d22df55cfa3ec86e22ccd771c6fc4803201b244f83b45d07641155f7c85f8','forgotten','2026-10-01T00:00:00+00:00');
CREATE TABLE pending_memory_candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
            source_request_id TEXT NOT NULL
              CHECK(length(source_request_id) BETWEEN 1 AND 256),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
            lesson_text TEXT NOT NULL
              CHECK(length(lesson_text) BETWEEN 1 AND 240),
            lesson_kind TEXT NOT NULL CHECK(length(lesson_kind) BETWEEN 1 AND 128),
            confidence REAL NOT NULL
              CHECK(typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0.0 AND 1.0),
            source_excerpt TEXT NOT NULL DEFAULT ''
              CHECK(length(source_excerpt) <= 1000),
            content_fingerprint TEXT NOT NULL CHECK(
                length(content_fingerprint) = 71
                AND substr(content_fingerprint, 1, 7) = 'sha256:'
                AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
            ),
            family_key TEXT NOT NULL DEFAULT '' CHECK(length(family_key) <= 128),
            category TEXT NOT NULL DEFAULT '' CHECK(length(category) <= 128),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT 'project_general' CHECK(
        length(project_id) BETWEEN 9 AND 136
        AND substr(project_id, 1, 8) = 'project_'
        AND substr(project_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
            UNIQUE(project_id, session_id, content_fingerprint)
        );
INSERT INTO "pending_memory_candidates" VALUES(3,'session-v8','request-v8','Jazz','The user likes jazz.','preference',0.7,'','sha256:2236b08f7d22033167de30c0cc9bfbced7a5209b2be9cb15bd313e260e2ca090','','music','2026-10-01T00:00:00+00:00','2026-10-01T00:00:00+00:00','project_general');
CREATE INDEX idx_memories_project_updated
          ON memories(project_id, updated_at DESC, id DESC);
CREATE INDEX idx_memories_project_kind_updated
          ON memories(project_id, lesson_kind, updated_at DESC, id DESC);
CREATE INDEX idx_memories_project_session_updated
          ON memories(project_id, session_id, updated_at DESC, id DESC);
CREATE INDEX idx_memory_extraction_project_created
          ON memory_extraction_runs(project_id, created_at ASC, session_id, request_id);
CREATE INDEX idx_pending_memory_project_session_updated
          ON pending_memory_candidates(project_id, session_id, updated_at DESC, id DESC);
CREATE INDEX idx_pending_memory_project_updated
          ON pending_memory_candidates(project_id, updated_at DESC, id DESC);
CREATE INDEX idx_memory_quarantine_created
          ON memory_quarantine(quarantined_at DESC, id DESC);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('memories',30);
INSERT INTO "sqlite_sequence" VALUES('pending_memory_candidates',3);
COMMIT;
PRAGMA user_version=8;
