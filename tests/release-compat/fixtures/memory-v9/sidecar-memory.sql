-- memory-v9 fixture: a real v9 database (the shipped v9 DDL) written through the
-- v9 store API (notes, a forgotten row, a reflection recap) and dumped with
-- Python iterdump; the FTS index is re-declared and rebuilt; user_version appended.
BEGIN TRANSACTION;
CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL DEFAULT 'project_general' CHECK(
        length(project_id) BETWEEN 9 AND 136
        AND substr(project_id, 1, 8) = 'project_'
        AND substr(project_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
            scope_session_id TEXT NOT NULL DEFAULT ''
              CHECK(length(scope_session_id) <= 256),
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
            lesson_text TEXT NOT NULL
              CHECK(length(lesson_text) BETWEEN 1 AND 400),
            lesson_kind TEXT NOT NULL CHECK(lesson_kind IN ('preference', 'fact', 'decision', 'convention', 'person', 'routine', 'lesson')),
            confidence REAL NOT NULL
              CHECK(typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0.0 AND 1.0),
            source_excerpt TEXT NOT NULL DEFAULT ''
              CHECK(length(source_excerpt) <= 1000),
            content_fingerprint TEXT NOT NULL CHECK(
        length(content_fingerprint) = 71
        AND substr(content_fingerprint, 1, 7) = 'sha256:'
        AND substr(content_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
    ),
            provenance TEXT NOT NULL DEFAULT 'unknown_legacy'
              CHECK(length(provenance) BETWEEN 1 AND 32),
            origin TEXT NOT NULL CHECK(origin IN ('user', 'jenny', 'reflection', 'legacy')),
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
            archived_at TEXT,
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0, 1)),
            always_on INTEGER NOT NULL DEFAULT 0 CHECK(always_on IN (0, 1)),
            source_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(
                length(source_message_ids) <= 4096
                AND json_valid(source_message_ids)
                AND json_type(source_message_ids) = 'array'
                AND json_array_length(source_message_ids) <= 16
            ),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK((status = 'archived') = (archived_at IS NOT NULL))
        );
INSERT INTO "memories" VALUES(1,'project_alpha','','session-v9','The release train leaves on Thursdays.','The release train leaves on Thursdays.','routine',1.0,'','sha256:cfcdcb671e4e309d03d621b8d662cc0463f32976fff4dc9f7ea2fb109afa7e82','user_approved','user','active',NULL,1,0,0,'[]','2026-10-14T12:00:00.000000+00:00','2026-10-14T12:00:00.000000+00:00');
INSERT INTO "memories" VALUES(2,'project_general','','session-v9','The user prefers green tea.','The user prefers green tea.','preference',1.0,'','sha256:212c1934a3c8be19e011bb05a88e4224dff8f21bde10df856faa7bdd99f3f0c5','user_approved','user','active',NULL,1,0,0,'[]','2026-10-14T12:00:00.000000+00:00','2026-10-14T12:00:00.000000+00:00');
INSERT INTO "memories" VALUES(3,'project_alpha','chat-v9','session-v9','This chat targets the staging cluster.','This chat targets the staging cluster.','fact',1.0,'','sha256:5b0caf06e674246b9ddce472e4b763c5a9b7df56bfe0aba5afd56150f92b9e3d','user_approved','user','active',NULL,1,0,0,'[]','2026-10-14T12:00:00.000000+00:00','2026-10-14T12:00:00.000000+00:00');
INSERT INTO "memories" VALUES(4,'project_alpha','','session-v9','Use tabs for indentation.','Use tabs for indentation.','convention',1.0,'','sha256:3b1a2062811833b26dc84787fcd21656c405a258a231785b94c2d4a21b98371e','user_approved','user','archived','2026-10-14T12:00:00.000000+00:00',2,0,0,'[]','2026-10-14T12:00:00.000000+00:00','2026-10-14T12:00:00.000000+00:00');
INSERT INTO "memories" VALUES(5,'project_alpha','','chat-v9','Prefers short commit subjects.','Prefers short commit subjects.','preference',1.0,'','sha256:18ddc21adfc5f74d11fd868fd4396a6a7c7bb83afa1fccad5b65756fb4701c33','reflection','reflection','active',NULL,1,0,0,'["m-1"]','2026-10-14T12:00:00.000000+00:00','2026-10-14T12:00:00.000000+00:00');
INSERT INTO "memories" VALUES(6,'project_alpha','chat-v9','chat-v9','A chat about the staging cluster.','A chat about the staging cluster.','fact',1.0,'','sha256:ea232bf0e2f0ec95555fd5183297300b678aaf2a0ad107759132b15a70aeada3','reflection_recap','reflection','active',NULL,1,0,0,'[]','2026-10-14T12:00:00.000000+00:00','2026-10-14T12:00:00.000000+00:00');
CREATE TABLE memory_operations (
            operation_id TEXT PRIMARY KEY
              CHECK(length(operation_id) BETWEEN 1 AND 128),
            action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 32),
            scope_key TEXT NOT NULL CHECK(length(scope_key) <= 512),
            payload_digest TEXT NOT NULL CHECK(
        length(payload_digest) = 71
        AND substr(payload_digest, 1, 7) = 'sha256:'
        AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
            memory_id INTEGER,
            op TEXT NOT NULL CHECK(op IN ('remember', 'update', 'forget', 'restore', 'undo')),
            origin TEXT NOT NULL CHECK(origin IN ('user', 'jenny', 'reflection', 'legacy')),
            prior_json TEXT NOT NULL DEFAULT ''
                CHECK(length(prior_json) <= 4000),
            prior_suppression TEXT
                CHECK(prior_suppression IS NULL OR json_valid(prior_suppression)),
            result_revision INTEGER,
            response_json TEXT NOT NULL DEFAULT ''
              CHECK(length(response_json) <= 4000),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            undone_at TEXT,
            stub INTEGER NOT NULL DEFAULT 0 CHECK(stub IN (0, 1))
        );
INSERT INTO "memory_operations" VALUES('op-v9-1','remember','project_alpha'||char(0)||'','sha256:f9a58617705f6e7f91dabf7329a38837198c3925d9a8baac793b883f6f819208',1,'remember','user','',NULL,1,'{"status":"saved","memory":{"id":1,"session_id":"session-v9","title":"The release train leaves on Thursdays.","lesson_text":"The release train leaves on Thursdays.","lesson_kind":"routine","confidence":1.0,"source_excerpt":"","content_fingerprint":"sha256:cfcdcb671e4e309d03d621b8d662cc0463f32976fff4dc9f7ea2fb109afa7e82","provenance":"user_approved","created_at":"2026-10-14T12:00:00.000000+00:00","updated_at":"2026-10-14T12:00:00.000000+00:00","project_id":"project_alpha","scope_session_id":"","origin":"user","status":"active","archived_at":null,"revision":1,"protected":false,"always_on":false,"source_message_ids":[]},"duplicate":false,"undoable":true,"reason":null,"code":null,"always_on_lines":[]}','2026-10-14T12:00:00.000000+00:00','2026-10-15T12:00:00.000000+00:00',NULL,0);
INSERT INTO "memory_operations" VALUES('op-v9-2','remember','project_general'||char(0)||'','sha256:5e6d37c4f6426d68ce2cad5199a81ea3612d6556818d752283351403d6e718b9',2,'remember','user','',NULL,1,'{"status":"saved","memory":{"id":2,"session_id":"session-v9","title":"The user prefers green tea.","lesson_text":"The user prefers green tea.","lesson_kind":"preference","confidence":1.0,"source_excerpt":"","content_fingerprint":"sha256:212c1934a3c8be19e011bb05a88e4224dff8f21bde10df856faa7bdd99f3f0c5","provenance":"user_approved","created_at":"2026-10-14T12:00:00.000000+00:00","updated_at":"2026-10-14T12:00:00.000000+00:00","project_id":"project_general","scope_session_id":"","origin":"user","status":"active","archived_at":null,"revision":1,"protected":false,"always_on":false,"source_message_ids":[]},"duplicate":false,"undoable":true,"reason":null,"code":null,"always_on_lines":[]}','2026-10-14T12:00:00.000000+00:00','2026-10-15T12:00:00.000000+00:00',NULL,0);
INSERT INTO "memory_operations" VALUES('op-v9-3','remember','project_alpha'||char(0)||'chat-v9','sha256:cf39e226edd5b4125b62dddb126e856e9225a3929fcc8aa1dc548f1f6ecebe4a',3,'remember','user','',NULL,1,'{"status":"saved","memory":{"id":3,"session_id":"session-v9","title":"This chat targets the staging cluster.","lesson_text":"This chat targets the staging cluster.","lesson_kind":"fact","confidence":1.0,"source_excerpt":"","content_fingerprint":"sha256:5b0caf06e674246b9ddce472e4b763c5a9b7df56bfe0aba5afd56150f92b9e3d","provenance":"user_approved","created_at":"2026-10-14T12:00:00.000000+00:00","updated_at":"2026-10-14T12:00:00.000000+00:00","project_id":"project_alpha","scope_session_id":"chat-v9","origin":"user","status":"active","archived_at":null,"revision":1,"protected":false,"always_on":false,"source_message_ids":[]},"duplicate":false,"undoable":true,"reason":null,"code":null,"always_on_lines":[]}','2026-10-14T12:00:00.000000+00:00','2026-10-15T12:00:00.000000+00:00',NULL,0);
INSERT INTO "memory_operations" VALUES('op-v9-4','remember','project_alpha'||char(0)||'','sha256:75def629c6b7227c13f33a25202351cab531f917ae4cf70db4d9403ddb60ad49',4,'remember','user','',NULL,1,'{"status":"saved","memory":{"id":4,"session_id":"session-v9","title":"Use tabs for indentation.","lesson_text":"Use tabs for indentation.","lesson_kind":"convention","confidence":1.0,"source_excerpt":"","content_fingerprint":"sha256:3b1a2062811833b26dc84787fcd21656c405a258a231785b94c2d4a21b98371e","provenance":"user_approved","created_at":"2026-10-14T12:00:00.000000+00:00","updated_at":"2026-10-14T12:00:00.000000+00:00","project_id":"project_alpha","scope_session_id":"","origin":"user","status":"active","archived_at":null,"revision":1,"protected":false,"always_on":false,"source_message_ids":[]},"duplicate":false,"undoable":true,"reason":null,"code":null,"always_on_lines":[]}','2026-10-14T12:00:00.000000+00:00','2026-10-15T12:00:00.000000+00:00',NULL,0);
INSERT INTO "memory_operations" VALUES('op-v9-5','forget','project_alpha'||char(0)||'','sha256:d7c848c56a398656f7c736f7268a24b7f2c8c775662755ff4f13e0911bcec154',4,'forget','user','{"id":4,"session_id":"session-v9","title":"Use tabs for indentation.","lesson_text":"Use tabs for indentation.","lesson_kind":"convention","confidence":1.0,"source_excerpt":"","content_fingerprint":"sha256:3b1a2062811833b26dc84787fcd21656c405a258a231785b94c2d4a21b98371e","provenance":"user_approved","created_at":"2026-10-14T12:00:00.000000+00:00","updated_at":"2026-10-14T12:00:00.000000+00:00","project_id":"project_alpha","scope_session_id":"","origin":"user","status":"active","archived_at":null,"revision":1,"protected":false,"always_on":false,"source_message_ids":[]}',NULL,2,'{"status":"saved","memory":{"id":4,"session_id":"session-v9","title":"Use tabs for indentation.","lesson_text":"Use tabs for indentation.","lesson_kind":"convention","confidence":1.0,"source_excerpt":"","content_fingerprint":"sha256:3b1a2062811833b26dc84787fcd21656c405a258a231785b94c2d4a21b98371e","provenance":"user_approved","created_at":"2026-10-14T12:00:00.000000+00:00","updated_at":"2026-10-14T12:00:00.000000+00:00","project_id":"project_alpha","scope_session_id":"","origin":"user","status":"archived","archived_at":"2026-10-14T12:00:00.000000+00:00","revision":2,"protected":false,"always_on":false,"source_message_ids":[]},"duplicate":false,"undoable":true,"reason":null,"code":null,"always_on_lines":[]}','2026-10-14T12:00:00.000000+00:00','2026-10-15T12:00:00.000000+00:00',NULL,0);
INSERT INTO "memory_operations" VALUES('reflect:chat-v9:aaaaaaaaaaaaaaaa:0','remember','project_alpha'||char(0)||'','sha256:d3031698198b35e4391008f3627b2ef8f623e648aaf2ba15c970b19fa16ceb45',5,'remember','reflection','',NULL,1,'{"status":"saved","memory":{"id":5,"session_id":"chat-v9","title":"Prefers short commit subjects.","lesson_text":"Prefers short commit subjects.","lesson_kind":"preference","confidence":1.0,"source_excerpt":"","content_fingerprint":"sha256:18ddc21adfc5f74d11fd868fd4396a6a7c7bb83afa1fccad5b65756fb4701c33","provenance":"reflection","created_at":"2026-10-14T12:00:00.000000+00:00","updated_at":"2026-10-14T12:00:00.000000+00:00","project_id":"project_alpha","scope_session_id":"","origin":"reflection","status":"active","archived_at":null,"revision":1,"protected":false,"always_on":false,"source_message_ids":["m-1"]},"duplicate":false,"undoable":true,"reason":null,"code":null,"always_on_lines":[]}','2026-10-14T12:00:00.000000+00:00','2026-10-15T12:00:00.000000+00:00',NULL,0);
INSERT INTO "memory_operations" VALUES('reflect-recap:chat-v9:aaaaaaaaaaaaaaaa','remember','project_alpha'||char(0)||'chat-v9','sha256:972c105a2a0e34cf5352b4712d5c9421b61e1d1861ad9d595833e4047220c008',6,'remember','reflection','',NULL,1,'{"status":"saved","memory":{"id":6,"session_id":"chat-v9","title":"A chat about the staging cluster.","lesson_text":"A chat about the staging cluster.","lesson_kind":"fact","confidence":1.0,"source_excerpt":"","content_fingerprint":"sha256:ea232bf0e2f0ec95555fd5183297300b678aaf2a0ad107759132b15a70aeada3","provenance":"reflection_recap","created_at":"2026-10-14T12:00:00.000000+00:00","updated_at":"2026-10-14T12:00:00.000000+00:00","project_id":"project_alpha","scope_session_id":"chat-v9","origin":"reflection","status":"active","archived_at":null,"revision":1,"protected":false,"always_on":false,"source_message_ids":[]},"duplicate":false,"undoable":true,"reason":null,"code":null,"always_on_lines":[]}','2026-10-14T12:00:00.000000+00:00','2026-10-15T12:00:00.000000+00:00',NULL,0);
CREATE TABLE memory_project_state (
            project_id TEXT PRIMARY KEY CHECK(
        length(project_id) BETWEEN 9 AND 136
        AND substr(project_id, 1, 8) = 'project_'
        AND substr(project_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
            archived_at TEXT NOT NULL
        );
CREATE TABLE memory_quarantine (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL CHECK(length(source_table) BETWEEN 1 AND 64),
            source_row_id TEXT NOT NULL DEFAULT '' CHECK(length(source_row_id) <= 64),
            reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
            raw_payload TEXT NOT NULL CHECK(length(raw_payload) <= 2000),
            quarantined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
CREATE TABLE memory_reflection_cursor (
            session_id TEXT PRIMARY KEY
              CHECK(length(session_id) BETWEEN 1 AND 256),
            project_id TEXT NOT NULL CHECK(
        length(project_id) BETWEEN 9 AND 136
        AND substr(project_id, 1, 8) = 'project_'
        AND substr(project_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
            message_count INTEGER NOT NULL,
            last_message_id TEXT NOT NULL,
            window_fingerprint TEXT NOT NULL,
            session_incarnation INTEGER NOT NULL,
            turn_generation INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
INSERT INTO "memory_reflection_cursor" VALUES('chat-v9','project_alpha',4,'m-4','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','inc_v9',1,'2026-10-14T12:00:00.000000+00:00');
CREATE TABLE memory_session_markers (
            session_id TEXT PRIMARY KEY
              CHECK(length(session_id) BETWEEN 1 AND 256),
            purged_at TEXT NOT NULL
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
INSERT INTO "memory_suppressions" VALUES('project_alpha','sha256:3b1a2062811833b26dc84787fcd21656c405a258a231785b94c2d4a21b98371e','forgotten','2026-10-14T12:00:00.000000+00:00');
CREATE TABLE pending_memory_candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
            source_request_id TEXT NOT NULL
              CHECK(length(source_request_id) BETWEEN 1 AND 256),
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
            lesson_text TEXT NOT NULL
              CHECK(length(lesson_text) BETWEEN 1 AND 400),
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
            category TEXT NOT NULL DEFAULT '' CHECK(length(category) <= 128),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT 'project_general' CHECK(
        length(project_id) BETWEEN 9 AND 136
        AND substr(project_id, 1, 8) = 'project_'
        AND substr(project_id, 9) NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
            origin TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ('user', 'jenny', 'reflection', 'legacy')),
            UNIQUE(project_id, session_id, content_fingerprint)
        );
CREATE UNIQUE INDEX idx_memories_active_digest
          ON memories(project_id, scope_session_id, content_fingerprint) WHERE status = 'active';
CREATE INDEX idx_memories_project_status_updated
          ON memories(project_id, status, updated_at DESC, id DESC);
CREATE INDEX idx_memories_project_status_kind_updated
          ON memories(project_id, status, lesson_kind, updated_at DESC, id DESC);
CREATE INDEX idx_memories_project_scope_status
          ON memories(project_id, scope_session_id, status, id);
CREATE INDEX idx_memories_project_status_always_on
          ON memories(project_id, status, always_on, id);
CREATE INDEX idx_pending_memory_project_session_updated
          ON pending_memory_candidates(project_id, session_id, updated_at DESC, id DESC);
CREATE INDEX idx_pending_memory_project_updated
          ON pending_memory_candidates(project_id, updated_at DESC, id DESC);
CREATE INDEX idx_memory_quarantine_created
          ON memory_quarantine(quarantined_at DESC, id DESC);
CREATE INDEX idx_memory_operations_expires ON memory_operations(expires_at);
CREATE INDEX idx_memory_operations_memory ON memory_operations(memory_id);
CREATE INDEX idx_memory_session_markers_purged
          ON memory_session_markers(purged_at ASC, session_id);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('memories',6);
CREATE VIRTUAL TABLE memory_fts USING fts5(
                        title,
                        lesson_text,
                        source_excerpt,
                        content='memories',
                        content_rowid='id'
                    );
CREATE TRIGGER memory_fts_insert
                    AFTER INSERT ON memories BEGIN
                        INSERT INTO memory_fts(rowid, title, lesson_text, source_excerpt)
                        VALUES (new.id, new.title, new.lesson_text, new.source_excerpt);
                    END;
CREATE TRIGGER memory_fts_delete
                    AFTER DELETE ON memories BEGIN
                        INSERT INTO memory_fts(
                            memory_fts, rowid, title, lesson_text, source_excerpt
                        ) VALUES (
                            'delete', old.id, old.title, old.lesson_text, old.source_excerpt
                        );
                    END;
CREATE TRIGGER memory_fts_update
                    AFTER UPDATE ON memories BEGIN
                        INSERT INTO memory_fts(
                            memory_fts, rowid, title, lesson_text, source_excerpt
                        ) VALUES (
                            'delete', old.id, old.title, old.lesson_text, old.source_excerpt
                        );
                        INSERT INTO memory_fts(rowid, title, lesson_text, source_excerpt)
                        VALUES (new.id, new.title, new.lesson_text, new.source_excerpt);
                    END;
INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
COMMIT;
PRAGMA user_version=9;
