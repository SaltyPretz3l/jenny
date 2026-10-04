# Persisted-state release compatibility

This corpus pins legacy migrations, current-state loading, and fail-closed preservation of incompatible state. It is a persisted-state gate; it does not qualify a packaged installer or a real app restart. Fixtures are hand-authored and their assertions live in the consuming tests.

## Runners and owners

`npm run test:dist` registers the Node `test_*.js` compatibility files and the Python memory suite through `scripts/tests/run-dist-tests.js`. These Node names are outside ordinary `*.test.js` discovery, so the explicit registration is required; `scripts/checks/check_release_compat_registered.py` checks it. The distribution runner may install `.[dev]` into its selected interpreter if pytest is missing.

For focused verification, use the safe wrapper with exact files and the worktree-local Python interpreter:

```
node scripts/run-node-tests-safe.js tests/release-compat/test_session_store_compat.js tests/release-compat/test_plugin_store_compat.js
python -m pytest tests/release-compat/test_memory_store_compat.py -q
```

| Test slice | Canonical owner and coverage |
|---|---|
| `test_session_store_compat.js` | `services/backend/session-store-migrations.js` and `session-storage-backend.js`: legacy monolithic/split fixtures through schema 21 migrate to current schema 22; the schema-22 interrupted image-session fixture settles an unfinished operation without replay. |
| `test_session_store_v18_stability.js` | Loading an older split layout queues migration without rewriting bytes before the explicit migration runs. A fixture named `current` is current at its recorded version, not necessarily the latest schema. |
| `test_terminal_repair_store_compat.js` | `terminal-repair-store.js`: schema-1 loading and future-schema preservation with writes blocked. |
| `test_plugin_store_compat.js` | `services/plugins/`: generation schemas V1–V6 (through Stage 8), future V7 preservation, retained transitional authority, pointer-loss recovery, and un-attributed historical receipts that fail closed. |
| `test_mcp_config_compat.js` | `services/mcp-config-store.js`: current/legacy configuration, malformed state, plaintext-secret rejection, and future-schema preservation. |
| `test_shell_config_v*.js` | `services/shell-config-state.js` and migration owners: run mode, tool retirement, i18n/safety, optional command sandbox, session runtime, pane layout, app zoom, and weather retirement. `CONFIG_VERSION` owns the current schema. |
| `test_archive_compat.js` | `services/data-lifecycle/`: immutable archive format v1 and portable preference extraction. |
| `test_memory_store_compat.py` | `sidecar/ai/memory/store_migrations.py`: empty and legacy memory-v1 through memory-v6 SQL fixtures migrate to current schema 8, preserving data and version-specific invariants. |

## App and protocol versions

The session compatibility test pins `EXPECTED_APP_VERSION = '1.2.0'` and `EXPECTED_SCHEMA_VERSION = 22`. A release bump must deliberately update the app expectation and preserve or extend the fixtures for its actual schema changes. App releases do not automatically bump persisted schemas or JSON-RPC.

`sidecar/protocol.py` owns API version `2026-08-17`; the JavaScript client twin and framed initialize tests cover that handshake. `services/backend/schema-version-registry.js` records each schema's forward policy. An incompatible future schema must remain preserved and mutation-blocked; do not normalize it with an older writer.

## Fixture layout

- `fixtures/userdata-v*/` contains monolithic `sessions.json` or split `sessions/_index.json` plus per-session JSON. Version-labelled fixtures are migration inputs and remain useful after later schemas ship.
- `fixtures/plugin-store-v*/` contains generation pointers, generation records, and selected operation receipts. Current V6 and future V7 are separate cases; older transitional records still test authority preservation.
- `fixtures/memory-empty/` and `memory-v*/` contain SQL scripts materialized into temporary SQLite databases.
- Archive, MCP configuration, shell configuration, and terminal-repair fixtures occupy their own owner directories.

## Extending the corpus

When changing a schema, add a fixture for the immediately preceding shape with the exact markers the new migration repairs. Assert the migrated data, schema, diagnostics, and repeat-load behavior through the real owner. For session schemas, change `STORE_SCHEMA_VERSION` in `session-store-migrations.js` and extend the migration cascade test. For memory, extend the SQL fixture and Python parametrized backstop. For generation/repair stores, retain a byte-stable supported case and move the future fixture ahead only with the corresponding contract change.

Register every new `test_*.js`/`test_*.py` file in the distribution runner. Preserve existing historical fixtures; never regenerate them from the new runtime, which would erase the incompatible inputs they are meant to exercise.

The compatibility corpus is independent of the evaluation harness under `scripts/eval/`; deleting evaluation tooling does not remove or replace these release gates.
