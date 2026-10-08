# Persisted-state release compatibility

This corpus pins legacy migrations, current-state loading, and fail-closed preservation of incompatible state. It is a persisted-state gate; it does not qualify a packaged installer or a real app restart. Fixtures are hand-authored and their assertions live in the consuming tests.

## Runners and owners

`npm run test:dist` registers the Node `test_*.js` compatibility files and the Python memory suite through `scripts/tests/run-dist-tests.js`. These Node names are outside ordinary `*.test.js` discovery, so the explicit registration is required; `scripts/checks/check_release_compat_registered.py` checks it. The distribution runner may install `.[dev]` into its selected interpreter if pytest is missing.

For focused verification, use the safe wrapper with exact files and the worktree-local Python interpreter:

```
node scripts/run-node-tests-safe.js tests/release-compat/test_session_store_compat.js
python -m pytest tests/release-compat/test_memory_store_compat.py -q
```

| Test slice | Canonical owner and coverage |
|---|---|
| `test_session_store_compat.js` | `services/backend/session-store-migrations.js` and `session-storage-backend.js`: legacy monolithic/split fixtures through schema 23 migrate to current schema 24 (the schema-22 interrupted image-session fixture also settles an unfinished operation without replay; `userdata-v23-current` migrates to v24 with an empty suggested-changes record and keeps its journals); `userdata-v24-current` pins the un-compacted base + journal layout with a journaled `suggested_changes` record (load, byte-stable read-only open, write-then-reopen, kill switch) and `userdata-v24-journal-recovery` pins recovery from a lost base rename. |
| `test_session_store_v18_stability.js` | Loading an older split layout queues migration without rewriting bytes before the explicit migration runs. A fixture named `current` is current at its recorded version, not necessarily the latest schema. |
| `test_terminal_repair_store_compat.js` | `terminal-repair-store.js`: schema-1 loading and future-schema preservation with writes blocked. |
| `test_mcp_config_compat.js` | `services/mcp-config-store.js`: current/legacy configuration, malformed state, plaintext-secret rejection, and future-schema preservation. |
| `test_shell_config_v*.js` | `services/shell-config-state.js` and migration owners: run mode, tool retirement, i18n/safety, optional command sandbox, session runtime, pane layout, app zoom, and weather retirement. `CONFIG_VERSION` owns the current schema. |
| `test_archive_compat.js` | `services/data-lifecycle/`: immutable archive format v1 and portable preference extraction. |
| `test_memory_store_compat.py` | `sidecar/ai/memory/store_migrations.py`: empty and legacy memory-v1 through memory-v6 SQL fixtures migrate to current schema 8, preserving data and version-specific invariants. |

## App and protocol versions

The session compatibility test pins `EXPECTED_APP_VERSION = '1.2.0'` and `EXPECTED_SCHEMA_VERSION = 24`. A release bump must deliberately update the app expectation and preserve or extend the fixtures for its actual schema changes. App releases do not automatically bump persisted schemas or JSON-RPC.

`sidecar/protocol.py` owns API version `2026-08-17`; the JavaScript client twin and framed initialize tests cover that handshake. `services/backend/schema-version-registry.js` records each schema's forward policy. An incompatible future schema must remain preserved and mutation-blocked; do not normalize it with an older writer.

## Fixture layout

- `fixtures/userdata-v*/` contains monolithic `sessions.json` or split `sessions/_index.json` plus per-session JSON. Version-labelled fixtures are migration inputs and remain useful after later schemas ship.
- `fixtures/userdata-v24-current/sessions/` is the current schema-24 layout: the v23-current chats with schema-24 bases and one more `sess_v23_journaled` journal-2 delta that sets `suggested_changes` (one `to_review` replace with an unsent comment, one `later` create). It was built from the v23-current bytes by rewriting only the base `schema_version` and appending one record through `session-journal.js` `encodeRecord`; the chat ids keep their `sess_v23_` names.
- `fixtures/userdata-v23-current/sessions/` is the schema-23 layout (now a v23 -> v24 migration input) as the app leaves it on disk with UN-COMPACTED journals: chat `sess_v23_journaled` has a base at `journal_epoch` 2 (stale on its own), journal 2 with five delta records (appended messages, an edited message, turn events, a title change) and the retained journal 1; chat `sess_v23_second` is at epoch 1 with one journal; `_index.json` (epoch 1) has a non-empty `_index.1.journal`. Its journals are line-oriented UTF-8 with LF and no CR; the bytes must never be re-encoded, because the loader's byte-stability test fails on any rewrite.
- `fixtures/userdata-v24-journal-recovery/sessions/` (schema 24; renamed from the v23 fixture with only the base schema bumped) is the state after power loss dropped the rename of a newer base: `sess_v23_lost_rename.json` is the epoch-1 base, `.1.journal` holds the deltas up to the base replacement, and `.2.journal` (header `continues: true`) holds the later deltas and the final title. Opening must load the state at the end of journal 2.
- `fixtures/plugin-store-v5-stage7/` is the one retired-plugin store kept: `tests/chatgpt-legacy-plugin-choice.test.js` reads it to prove the old ChatGPT plugin's on/off choice still carries over.
- `fixtures/memory-empty/` and `memory-v*/` contain SQL scripts materialized into temporary SQLite databases.
- Archive, MCP configuration, shell configuration, and terminal-repair fixtures occupy their own owner directories.

## Extending the corpus

When changing a schema, add a fixture for the immediately preceding shape with the exact markers the new migration repairs. Assert the migrated data, schema, diagnostics, and repeat-load behavior through the real owner. For session schemas, change `STORE_SCHEMA_VERSION` in `session-store-migrations.js` and extend the migration cascade test. For memory, extend the SQL fixture and Python parametrized backstop. For generation/repair stores, retain a byte-stable supported case and move the future fixture ahead only with the corresponding contract change.

The v23 fixtures were produced by really running `ElectronSessionStore` (`sessionJournal: true`) in a throwaway child Node process with a fixed clock (`Date`) and deterministic `crypto.randomUUID`, tiny journal thresholds on the backend's journal option (`store._backend._journal`, as `tests/helpers/session-journal-crash-child.js` does), `flushSession` after every mutation, and `process.exit(0)` WITHOUT `dispose()`/`flushAsync()` (those compact). For the recovery fixture the epoch-1 base bytes were captured before the replacement and copied back over `<id>.json` afterwards. The generator is not kept in the repo; rerunning it reproduces the same bytes, but the fixtures are the contract and are never regenerated from a later runtime.

Schema-bump checklist for a session store: add a `userdata-v<new>-current/` fixture and put it in `FIXTURE_DIRS`; turn the previous current coverage into a v<old> -> v<new> migration test (`hasPendingMigrations()`, `runPendingMigrations`, schema, `split_schema_migration_completed`; no `getSession` before the migration runs); bump `EXPECTED_SCHEMA_VERSION`; a current fixture must include un-compacted journals.

Register every new `test_*.js`/`test_*.py` file in the distribution runner. Preserve existing historical fixtures; never regenerate them from the new runtime, which would erase the incompatible inputs they are meant to exercise.

The compatibility corpus is independent of the evaluation harness under `scripts/eval/`; deleting evaluation tooling does not remove or replace these release gates.
