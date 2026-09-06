# Release-Compat Fixtures (Phase 12B / A.B.6)

This corpus is the release-gate net for Jenny's persisted-state migrations.
Every supported legacy schema version of the Electron session store and
sidecar Python memory store, plus current/future terminal-repair schemas,
has a hand-authored fixture pinning the
markers the matching repair / migration step is designed to detect. When
a release would move a schema version, the gate fires here first.

Two test runners consume the corpus:

- [`test_session_store_compat.js`](test_session_store_compat.js) — Node /
  `node:test`. Drives every fixture under `fixtures/userdata-v<N>/`
  through `services/backend/session-store-migrations.js`'s migration
  cascade (`repairSessionForV3` ... `repairSessionForV19`) and split
  session-layout loader.
- [`test_terminal_repair_store_compat.js`](test_terminal_repair_store_compat.js)
  — Node / `node:test`. Pins byte-stable schema-v1 loading and verifies a
  future schema is preserved byte-for-byte while current writes fail closed.
- [`test_plugin_store_compat.js`](test_plugin_store_compat.js) — Node /
  `node:test`. Rehydrates the current Stage-3 plugin store and proves both a
  future generation schema and retained Stage-4 authority state remain
  byte-identical, read-only, unexecuted, and mutation-blocked, including when
  the active pointer is missing. The current fixture also carries pre-W11
  receipts without generation attribution or retention: current code preserves
  those files byte-for-byte, refuses to infer their outcome, and reports status
  as indeterminate.
- [`test_archive_compat.js`](test_archive_compat.js) — Node / `node:test`.
  Pins archive format v1 as immutable by loading the hand-authored plain fixture,
  verifying it, and extracting its portable preference payload.
- [`test_memory_store_compat.py`](test_memory_store_compat.py) — pytest.
  Materializes every `fixtures/memory-v<N>/sidecar-memory.sql` script
  into a temp SQLite database, opens a `MemoryStore`, and verifies the
  migrations in `sidecar/ai/memory/store_migrations.py` complete cleanly.

## Why two runners

The migrations live in two languages and two runtimes. Pushing them
through a single test would either fork a subprocess (testing the
boundary, not the migrations) or duplicate one side's logic in the other
runtime. The Node and Python tests each pin the side they own; the
shared invariant ("legacy data loads at every supported schema version")
is enforced from both ends.

## App-version coupling

`services/backend/schema-version-registry.js` registers schemas with a
`forward_policy`. App-version is `lockstep_release`; API-version is
`lockstep_api_version`. The Node test pins the corpus assumption that
`package.json:version === '1.0.0'` — when the app version bumps, the
gate fails until either:

1. A new `userdata-v<N>/` fixture is added for the new schema dimension,
   or
2. The bump is covered by the current-schema fixtures and
   `EXPECTED_APP_VERSION` is updated in the test. Version 1.0.0 uses the
   current v20 session fixture, the v1-current/v2-future terminal-repair
   guards, and the memory-v6 migration fixture for current schema v7.

The API version (`'2026-08-17'`) is `lockstep_api_version` and already
covered by the JSON-RPC handshake tests in
`tests/sidecar/test_server_core.py` (the JS twin died with the legacy HTTP
client when the external backend path was retired);
no fixture matrix is needed here.

## Fixture layout

```
fixtures/
├── plugin-store-v1-current/   # current Stage-3 generation + pointer
├── plugin-store-v2-future/    # future schema / Stage-4 state; preserve only
├── userdata-v3/             # pre-v3: legacy linked_session_ids (dups + self-ref)
│   └── sessions.json
├── userdata-v4/             # pre-v4: dup message ids + stale pending approvals
│   └── sessions.json
├── userdata-v5/             # pre-v5: partial active_turn snapshot
│   └── sessions.json
├── userdata-v6/             # pre-v6: assistant status="error" rows
│   └── sessions.json
├── userdata-v7/             # pre-v7: messages needing last_model_used fallback
│   └── sessions.json
├── userdata-v9-current/     # last monolithic layout; migrates to split v12
│   └── sessions.json
├── userdata-v11/            # split v11 layout; migrates message reactions to v12
│   └── sessions/
│       ├── _index.json
│       └── sess_v11_reactions.json
├── userdata-v12-current/    # already-current split layout; constructor is a no-op
│   └── sessions/
│       ├── _index.json
│       └── sess_v12_current.json
├── userdata-v18-current/    # pre-v19 research preference + snapshot-v1 migration
│   └── sessions/
├── userdata-v19-current/    # current split layout; constructor is a no-op
│   └── sessions/
├── memory-empty/            # PRAGMA user_version=0 (bare DB)
│   └── sidecar-memory.sql
├── memory-v1/               # legacy memory_entries only
│   └── sidecar-memory.sql
├── memory-v2/               # memories table without family_key/provenance
│   └── sidecar-memory.sql
├── memory-v3/               # v3 memories (with family_key/provenance), no v4 tables
│   └── sidecar-memory.sql
└── memory-v4/               # all v4 tables; rows with empty provenance
    └── sidecar-memory.sql
```

Each fixture's per-marker invariants are documented inline in the test
that consumes it.

The session corpus now includes migration inputs through v18 plus the
byte-stable `userdata-v19-current/` split layout. Terminal recovery uses
`terminal-repair-v1-current/` and `terminal-repair-v2-future/`; the latter is
deliberately unreadable to the current runtime and proves preservation plus
write blocking.

## Adding a fixture when bumping a schema

When `STORE_SCHEMA_VERSION` is bumped in
`services/backend/electron-session-store.js`:

1. Author a new `fixtures/userdata-v<N-1>/` fixture containing a session
   with the markers your new `repairSessionForV<N>` is designed to
   detect.
2. Set `schema_version` in the fixture to `<N> - 1` so the migration
   cascade or split-loader normalization enters the new step (and not the
   steps after it).
3. Add a test in `test_session_store_compat.js` that asserts the
   post-migration repair invariants. Use `createLogCollector` to verify
   no `newer_schema_detected` warnings.
4. Update the `userdata-v<N>-current/` split-layout fixture to match the
   new current schema (the no-op assertion catches missing field defaults).
5. Bump `EXPECTED_APP_VERSION` in the test if the schema bump rides on
   an app-version release.

When `SCHEMA_VERSION` is bumped in
`sidecar/ai/memory/store_migrations.py`:

1. Author a new `fixtures/memory-v<N-1>/sidecar-memory.sql` script
   pinning the pre-migration schema.
2. Add a test in `test_memory_store_compat.py` asserting the
   post-migration data invariants.
3. Add the new version to the parametrized backstop test.

When `TERMINAL_REPAIR_SCHEMA_VERSION` is bumped in
`services/backend/terminal-repair-store.js`, add the prior-version fixture and
test its forward migration, then move the future-schema fixture one version
ahead. Keep a byte-stable current fixture and assert future-schema write
blocking before release.

When `PluginGenerationV1` or the plugin stage-state table changes, update the
current plugin-store fixture and move the future fixture one version/stage
ahead. The compatibility test must continue to compare every future fixture
file byte-for-byte before and after service startup and refused mutation.

The fixtures are hand-authored. There is no regenerator script; the
fixtures must continue to compile against `repairSessionForV<N>` /
`_migrate_v<N>_to_v<M>` even after refactors, which is the point of the
gate.

## Rollback

Removable in one commit: delete `tests/release-compat/`. Zero impact on
Jenny's runtime build. The migration code under
`services/backend/electron-session-store.js` and
`sidecar/ai/memory/store_migrations.py` is unaffected; only this test
corpus is removed.
