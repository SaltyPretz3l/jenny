# Versioning and Migration Policy

Date: 2026-08-17

Single-page operator doc for the versioned surfaces and credential-storage
posture between the Electron shell and the Python sidecar. Updated through
THOTH Phase 5F of
BACKEND_PROMPT_LIFECYCLE_REVIEW.md
and Round-2 findings K6 (corrupt-store signaling) and O4 (API_VERSION policy).

- [Application release version](#application-release-version)
- [API_VERSION handshake](#api_version-handshake)
- [Unified schema-version registry](#unified-schema-version-registry)
- [Credential storage policy](#credential-storage-policy)
- [Diagnostics schema version](#diagnostics-schema-version)
- [Memory store schema (SQLite)](#memory-store-schema-sqlite)
- [Electron session store schema (JSON)](#electron-session-store-schema-json)
- [Jenny data archive schema](#jenny-data-archive-schema)
- [Terminal repair store schema (JSON)](#terminal-repair-store-schema-json)
- [Shell config schema (JSON)](#shell-config-schema-json)
- [Usage history schema (JSON)](#usage-history-schema-json)
- [Personality workspace schema (JSON)](#personality-workspace-schema-json)
- [Tool config schema metadata](#tool-config-schema-metadata)
- [Session export format](#session-export-format)
- [Scheduled task store schema (JSON)](#scheduled-task-store-schema-json)
- [Runtime config schema](#runtime-config-schema)
- [Ollama catalog cache schema (JSON)](#ollama-catalog-cache-schema-json)
- [Plugin catalog source schema (JSON)](#plugin-catalog-source-schema-json)
- [Standalone MCP configuration schema (JSON)](#standalone-mcp-configuration-schema-json)
- [FileJsonStore corruption policy](#filejsonstore-corruption-policy)
- [Cache boundary marker (accepted risk)](#cache-boundary-marker-accepted-risk)

## Application release version

**Source of truth:** `package.json` and `pyproject.toml` share the same app
release version. Electron passes that value to the managed sidecar as
`clientVersion` during `initialize`; `cut_release.py` updates only app-version
sources and does not bump API or schema versions.

`cut_release.py` also *validates* `API_VERSION` (sidecar/protocol.py and
services/backend/sidecar-client.js) and the diagnostics `SCHEMA_VERSION`
(sidecar/runtime/diagnostics.py) against the previous `v*` release tag. If
either constant moved, the `RELEASE_NOTES.md` section for the new version must
mention the change explicitly: either reference the constant by name
(`API_VERSION`, `SCHEMA_VERSION`, `schema_version`) or add a
`### Contract changes` / `### Migration notes` subsection. The script refuses
to run otherwise. The same validator is reachable from
`scripts/checks/check_release_version_policy.py --strict`, which is what the
release-attestation workflow runs on tag push so a missing notes entry blocks
the publish.

Release-version policy is checked by:

```powershell
python scripts/checks/check_release_version_policy.py
```

The default (non-strict) policy requires `electron-updater` to remain a
runtime dependency, release scripts to stay explicit, SBOM metadata to read
the package version, and `RELEASE_NOTES.md` to carry a section for the current
app version. Pre-release dev iteration runs the default mode so contract
constants can move freely while features are still landing. Add `--strict` to
also enforce the contract-version validation; `release-attestation.yml`
invokes the strict variant on tag push.

## API_VERSION handshake

**Source of truth:** `API_VERSION = "2026-08-17"` in
[sidecar/protocol.py](../../sidecar/protocol.py). The paired client constant
lives at [services/backend/sidecar-client.js](../../services/backend/sidecar-client.js).

**Lockstep shipping.** Jenny packages the Electron shell and the Python sidecar
together. There is no independent client/server release. Every packaged build
carries one matched pair; the handshake is a tripwire for mismatched processes
(for example, a dev running an old sidecar against a new shell), not a
negotiation between divergent release trains.

**Handshake shape.** Every JSON-RPC request carries `accept_version` in its
params ([services/backend/sidecar-client.js](../../services/backend/sidecar-client.js)).
The sidecar validates it via `validate_accept_version`
([sidecar/runtime/rpc.py:87-104](../../sidecar/runtime/rpc.py)). A mismatch
produces `CMP_PROTO_VERSION_MISMATCH` wrapped in a JSON-RPC
`INVALID_PARAMS_CODE` (`-32602`) response; the client surfaces this as a hard
startup failure.

**When to bump `API_VERSION`.** Any of:

- Add, remove, or rename a JSON-RPC method in
  [sidecar/protocol.py](../../sidecar/protocol.py).
- Change the request/response shape of an existing method (add required field,
  rename existing field, change a field's type).
- Add, remove, or change a notification method listed in
  `ALLOWED_NOTIFICATION_METHODS`
  ([sidecar/protocol.py:71-87](../../sidecar/protocol.py)).
- Change the payload shape of an existing notification method in a way that
  breaks the renderer's reducers.

**When NOT to bump.**

- Adding an optional field that older clients safely ignore (forward-compat
  additive changes). Document the field's default in the relevant runbook; do
  not rename it later.
- Internal refactors that don't change the wire surface (for example, splitting
  a handler into sub-modules).
- Tolerated extras in `parse_runtime_config` (see
  [Runtime config schema](#runtime-config-schema)). These log
  `ai.config.unknown_keys` at WARN but don't need a version bump.

**Compat window.** None. Mismatched versions fail closed. A user with a stale
sidecar must reinstall or reboot into the paired process.

**2026-07-15 acquisition progress.** `runtime.progress` was added as a
sidecar-to-Electron notification during `initialize`. Its snake-case payload is
correlated by `request_id` and reports the validated model lifecycle state,
engine/model identity, bounded status text, percent, and completed/total bytes.
Electron uses only forward stage/percent/byte movement to refresh the bounded
initialization inactivity watchdog.

**2026-07-12 contraction.** `chat.get_active_turn_state` was removed from the
sidecar JSON-RPC surface. Electron retains the renderer-facing
`chat.getActiveTurnState` IPC method, now projected from Electron-owned persisted
`active_turn` state plus the live `activeStreams` controller registry. Raw callers
of the retired sidecar method receive JSON-RPC `METHOD_NOT_FOUND`.

**Release checklist.**

1. Bump the constant in both files in the same commit:
   - [sidecar/protocol.py:14](../../sidecar/protocol.py) — `API_VERSION`.
   - [services/backend/sidecar-client.js:5](../../services/backend/sidecar-client.js) —
     `const API_VERSION`.
2. Verify there are only these two sites (grep protects the invariant):
   `rg -n "API_VERSION\s*=" sidecar services renderer-send-utils.js preload.js main.js`.
3. Update the dated comment in
   [sidecar/protocol.py](../../sidecar/protocol.py) if the bump records a
   notable shape change.
4. Ship renderer + sidecar together in the same installer.

## Unified schema-version registry

**Source of truth:** Electron owns the combined status registry at
[services/backend/schema-version-registry.js](../../services/backend/schema-version-registry.js)
through `getAllSchemaVersions()`. Sidecar owns its runtime half at
[sidecar/runtime/schema_versions.py](../../sidecar/runtime/schema_versions.py)
through `get_all_schema_versions()`.

Registry rows are display-safe metadata:

```json
{
  "id": "electron.session_store",
  "surface": "Electron session store",
  "owner": "electron",
  "kind": "json_schema",
  "version": 12,
  "forward_policy": "migrate_forward_block_future_write",
  "source": "services/backend/session-store-migrations.js"
}
```

The sidecar publishes its rows as additive `schema_versions` on `initialize`
and `harness.inspect`. Electron normalizes those rows and exposes the combined
view as additive `BackendStatus.schemaVersions`; no new IPC or JSON-RPC method
is required.

When adding or bumping a versioned persisted store, export/import format,
diagnostic schema, notification schema, or lockstep API version, add or update
the corresponding registry row in the same change. Prefer importing the live
constant into the registry over duplicating literals; if the owning runtime
module has startup side effects, keep the constant in a tiny sibling module and
have both the runtime owner and registry import it. Each row must name the
forward policy so Phase 6 status surfaces and release-policy checks can tell
the difference between "migrate forward," "reject future," and "additive
metadata only" surfaces.

The recognized `forward_policy` tokens are:

- `lockstep_release` — version moves with app version (`app.version`).
- `lockstep_api_version` — version moves with the Electron↔sidecar API
  handshake.
- `migrate_forward_block_future_write` — older payloads migrate forward
  in place; readers reject future versions on write.
- `normalize_forward_block_future_write` — older payloads normalize to
  the current shape; future versions block writes but are preserved.
- `reject_future_format` — reader refuses to load a future schema
  outright.
- `normalize_current_schema` — payload always matches the current
  schema; older payloads normalize on load.
- `preserve_future_block_write` — preserves the future file on disk
  while blocking new writes (for forward-compat-aware stores).
- `integer_schema_only` — the version field must be an integer; rejects
  alphanumeric reservations.
- `additive_only` — the schema is a runtime payload envelope (never
  persisted) that is bumped only when a non-additive change ships;
  consumers MUST tolerate unknown fields on the same major version.
  Used for diagnostic facades like `electron.jenny_status`.

## Credential storage policy

**Source of truth:** Electron owns secret persistence through
[services/backend/secure-store.js](../../services/backend/secure-store.js),
backed by Electron `safeStorage` and the app user-data file
`secure-state.json`. Secrets are never stored in environment variables or
plaintext shell config. `secure-state.json` stores encrypted values only; any
legacy plaintext record is rejected and removed on read.

**Sentry DSN placement.** The telemetry DSN uses the SecureStore key
`sentry_dsn`. The encrypted record may carry display-safe audit metadata
(`secretType`, `updatedAt`, and a short SHA-256 fingerprint), and
`BackendStatus.credentialStore.audit.sentryDsn` may expose that metadata
without decrypting or returning the DSN value. The managed sidecar receives the
DSN through `initialize.secrets.telemetry_dsn` only when crash reporting consent
is enabled.

**Readiness contract.** `main.js` passes an `app.isReady()` predicate through
`BackendService` into `SecureStore`. `SecureStore.get()`, `set()`, and
`delete()` throw before Electron safeStorage readiness instead of attempting a
best-effort read/write or plaintext fallback. `BackendStatus.credentialStore`
exposes a display-safe status payload with `status`, `ready`, `source`,
`storageBackend`, `encryptionAvailable`, and recovery copy; it does not read or
fingerprint any secret.

**Failure posture.**

- `status: "not_ready"` means Electron startup has not completed. Treat this
  as a startup-order bug or transient startup state; retry after startup, or
  ask the user to restart Jenny if it persists.
- `status: "unavailable"` means Electron is ready but encrypted storage is not
  available. Writes fail closed. Do not silently store plaintext credentials.
- Deletes remain allowed after Electron readiness even when encryption is
  unavailable, so stale or invalid credential records can still be removed.
- Electron's Linux `basic_text` safeStorage backend is treated as unavailable
  because Electron documents it as unprotected fallback storage.
- Corrupt encrypted records are removed on read, preserving the existing
  fail-closed behavior for unusable secret material.

**Managed-local profile boundary.** The automatic managed-local profile is
non-secret runtime metadata with the fixed identity `usr_local`; it is never
written to `SecureStore` or another file. `auth.getState` uses an existing
encrypted named profile when one can be read, otherwise it returns the
automatic profile and keeps local chat available. Signing out of a named
profile returns to that automatic profile. Named-profile password records and
all actual credentials remain `SecureStore`-only and continue to fail closed
when protected storage is unavailable.

**Sensitive settings.** Sentry DSNs, MCP credentials, OAuth tokens, and future
API keys must either live in `SecureStore` or use a documented encrypted store
that reports the same readiness/status semantics. Shell config may keep
display-safe metadata such as consent, "configured", source labels,
fingerprints, or timestamps, but not the secret value.

**Portability note.** Windows remains the active packaged-release target;
macOS/Linux source runs must surface platform keyring limitations through
status/recovery metadata and the automatic local profile, never through a
plaintext credential fallback. Linux packaging remains a separate release
decision.

## Diagnostics schema version

**Source of truth:** diagnostics schema versions are integer literals. The
active sidecar logging schema is `SCHEMA_VERSION = 1` in
[sidecar/runtime/diagnostics.py](../../sidecar/runtime/diagnostics.py), and
diagnostic payloads use integer `schema_version` fields.

String schema versions are no longer valid for active diagnostics payloads.
Changing a diagnostics payload shape requires a migration note in release docs
and focused tests for the reader that consumes the changed payload.

The Electron-owned `jenny_status` facade is schema v4 in
[services/backend/jenny-status-composer.js](../../services/backend/jenny-status-composer.js).
Version 4 replaces the former optional `cost` facet with always-on `usage`
diagnostics. Its registry policy is `additive_only`; consumers tolerate unknown
fields within the same version, while non-additive facet changes require a bump.

## Memory store schema (SQLite)

**Source of truth:** `SCHEMA_VERSION = 7` in
[sidecar/ai/memory/store_migrations.py](../../sidecar/ai/memory/store_migrations.py).

The memory database is an SQLite file opened by
[sidecar/ai/memory/store.py](../../sidecar/ai/memory/store.py); `MemoryStore`
calls `run_migrations(connection)` on every open so migrations are idempotent
and safe to run on partially-upgraded databases.

**Current migration chain (v0 → v7).** `run_migrations()` advances every
required step during the same open and fails if a migration does not advance
`PRAGMA user_version`. The entire chain is one outer transaction; individual
steps may use savepoints, but no intermediate schema version commits. Failure
reports `preserved: true` only after rollback completes and the original
`user_version` is verified.

| From | To | Function | What changed |
|---|---|---|---|
| 0 (empty) | 3 | `_migrate_to_v3_from_empty` | Fresh install — creates v3 baseline directly. |
| 1 | 3 | `_migrate_v1_to_v3` | v1 → v3 fast-forward for early installs. |
| 2 | 3 | `_migrate_v2_to_v3` | v2 → v3 fast-forward. |
| 3 | 4 | `_migrate_v3_to_v4` | Added approved-memory provenance + family key columns. |
| 4 | 5 | `_migrate_v4_to_v5` | Added pending-memory candidate tracking table. |
| 5 | 6 | `_migrate_v5_to_v6` | Added bounded recall and retention indexes for raw exchanges, approved memories, extraction runs, and pending candidates. |
| 6 | 7 | `_migrate_v6_to_v7` | Rebuilds approved/pending rows with constraints and SHA-256 identities; adds extraction leases, digest-only suppressions, bounded quarantine, and FTS5 recall; purges legacy raw exchanges. |

A fresh database is created with the consolidated
`v7_schema_script()` DDL
([store_migrations.py](../../sidecar/ai/memory/store_migrations.py))
— migration functions only run on upgrades from older `PRAGMA user_version`
values.

**Retention and capacity contract.** Approved memories are user-owned and are
never age-, count-, or pressure-evicted. Maintenance deletes only derived or
rebuildable state (completed extraction receipts and stale pending candidates)
in 500-row batches. Capacity is measured across the main database, WAL, and SHM.
If derived cleanup cannot bring physical storage under the limit, existing
approved rows remain intact and new or growing writes fail with
`CMP-MEM-0007`; delete, doctor, and cleanup operations remain available. Heavy
checkpoint/compaction work is not performed by request-time recall.

**Recall and malformed-row contract.** FTS5 searches title, lesson, and excerpt
across the 10,000-row bound. Hosts without FTS5 use a deterministic bounded
full-table fallback. Individual malformed rows are removed from active tables,
represented in bounded metadata-only quarantine records, and reported through
`memory.status`; no lesson, prompt, fingerprint, or path appears in status.

**Template for a v8 migration.** Bump `SCHEMA_VERSION`, add a complete
`v8_schema_script()` for fresh installs, add one explicitly transactional
`_migrate_v7_to_v8()` step, register it in the ordered migration map, and add
fresh-v8, v7→v8, future-version refusal, schema-parity, and fault-after-each-
stage tests. Every schema bump must add the immediate predecessor fixture.

**Invariants.**

- Migrations MUST be re-runnable. `run_migrations` is called on every
  `MemoryStore.__init__`.
- Migrations MUST NOT delete approved user-authored memory. Derived raw exchange
  and embedding caches may be purged only when the migration explicitly states it.
- `SCHEMA_VERSION` MUST match the latest DDL script. A DDL change without a
  version bump is a silent regression.
- SQLite mutators MUST use the central transaction owner; body, commit, and
  cleanup failures roll back before the next operation.
- Unknown/higher `user_version` remains untouched and raises
  `MemoryStoreError(CMP_MEMORY_SCHEMA_MIGRATION)`.

## Electron session store schema (JSON)

**Source of truth:** `STORE_SCHEMA_VERSION = 15` in
[services/backend/session-store-migrations.js](../../services/backend/session-store-migrations.js).

The current session store is a split layout under `{userData}/sessions/`:
`_index.json` carries the schema and session id list, and each session lives in
`<session_id>.json`. Older monolithic `{userData}/sessions.json` payloads are
still accepted by the migration path. Migrations run on every load via
`migrateStorePayload` -> `normalizeStorePayload`.

### Canonical shape (informal schema)

```jsonc
{
  "schema_version": 15,           // integer; always equals STORE_SCHEMA_VERSION on write
  "sessions": {
    "<session_id>": {
      "id": "<session_id>",
      "title": "...",
      "created_at": "2026-04-20T12:34:56Z",
      "updated_at": "2026-04-20T12:34:56Z",
      "last_model_used": "qwen3:32b",
      "session_incarnation": "<durable incarnation id>",
      "turn_generation": 0,
      "messages": [
        {
          "id": "<turn_id>",
          "role": "user" | "assistant" | "system",
          "content": "...",
          "status": "completed" | "denied" | "cancelled" | "preempted" | "timeout" | "runtime_error" | "question_batch",
          "model": "...",
          "message_reactions": {
            "thumbs_up": { "selected": true, "updated_at": "2026-05-12T12:34:56Z" },
            "saved": { "selected": true, "updated_at": "" },
            "note": { "selected": true, "updated_at": "" }
          }
          // normalized by normalizeMessageFields in message-normalization.js
        }
      ],
      "linked_session_ids": ["<id>", ...],  // deduped, self-excluded
      "active_turn": null | { /* snapshot from managed runtime */ },
      "pending_approval": null | { /* tool-approval state */ }
      // ...any additional normalized session fields
    }
  }
}
```

### Unknown-field policy

`normalizeSession`
([message-normalization.js](../../services/backend/message-normalization.js))
**drops** top-level session fields that aren't in the normalization allowlist.
This is deliberate forward-compat tolerance: an old renderer reading a newer
payload won't crash on extras, and a newer renderer writing to an older store
won't accidentally persist half-normalized state.

Top-level store fields (`schema_version`, `sessions`) follow the same rule:
`normalizeStorePayload` only re-serializes known fields. Unknown top-level
fields are dropped on the next write.

### Migration chain (v1 -> v15)

| From | To | Repair function | What changed |
|---|---|---|---|
| < 3 | 3 | (inline `linked_session_ids` normalization) | Dedupe + self-exclude linked session ids. |
| < 4 | 4 | `repairSessionForV4` | Dedupe duplicate message ids, settle stale pending-approval tool calls, and refresh message counts/previews. |
| < 5 | 5 | `repairSessionForV5` | Normalize the persisted `active_turn` reconnect snapshot. |
| < 6 | 6 | `repairSessionForV6` | Convert legacy assistant `status: "error"` rows to canonical terminal statuses and subcodes. |
| < 7 | 7 | `repairSessionForV7` | Re-run message normalization with `last_model_used` as the fallback model. |
| 7 | 8 | (inline migration chain bump) | Reserved compatibility step for the turn-event storage rollout; no standalone repair helper is required. |
| 8 | 9 | `repairSessionForV9` | Project canonical `target_message_id` while preserving legacy `action_target_message_id` for older payloads. |
| 9 | 10 | (split-layout migration) | Move storage from monolithic `sessions.json` to split `_index.json` plus per-session files. |
| 10 | 11 | `repairSessionForV11` | Normalize additive `branch_origin` lineage metadata for message branching. |
| 11 | 12 | `repairSessionForV12` | Normalize additive marker-only `message_reactions` on persisted messages. |
| 12 | 13 | `repairSessionForV13` | Normalize first-class diagnostic-session metadata used by frontier diagnostics. |
| 13 | 14 | `repairSessionForV14` | Compact legacy per-delta `reasoning_phase` turn events into one bounded event per phase. |
| 14 | 15 | `repairSessionForV15` | Add normalized durable `session_incarnation` and non-negative `turn_generation` lifecycle fences. |

Each upgrade is idempotent and runs on every load. The matching one-line
comments beside each `repairSessionForV*` helper in
[session-store-migrations.js](../../services/backend/session-store-migrations.js)
are part of the migration lifecycle contract: future schema bumps should add the
same short summary next to the new repair helper.

### Template for the next migration

1. Bump the constant:

   ```js
   const STORE_SCHEMA_VERSION = 16;
   ```

2. Add a `repairSessionForV16(session)` helper that takes a single session
   object, does the one-way repair, and returns a new object. Keep it pure —
   no closures over outer state.

3. Extend `migrateStorePayload`
   ([session-store-migrations.js](../../services/backend/session-store-migrations.js))
   with a new branch:

   ```js
   if (version < 16) {
     for (const [sessionId, session] of Object.entries(migrated.sessions)) {
       const repaired = repairSessionForV16(session);
       migrated.sessions[sessionId] = {
         ...repaired,
         linked_session_ids: normalizeLinkedSessionIds(repaired?.linked_session_ids, sessionId),
       };
     }
   }
   ```

4. Add a test to
   [tests/electron-session-store.test.js](../../tests/electron-session-store.test.js)
   covering: v15 -> v16 upgrade, v16 idempotence, unknown-field tolerance.

**Invariants.**

- `schema_version` is always rewritten to `STORE_SCHEMA_VERSION` on normalize
  ([session-store-migrations.js](../../services/backend/session-store-migrations.js)).
- Migrations run linearly with `<` bounds so an upgraded store re-runs later
  repairs even if it came from an earlier intermediate version.
- `normalizeLinkedSessionIds` is reapplied after every per-version repair to
  prevent cross-version drift in the session-link graph.
- If a store declares `schema_version > STORE_SCHEMA_VERSION`, Electron keeps a
  normalized read cache but blocks writes and logs
  `session_store.newer_schema_detected` / `session_store.newer_schema_write_blocked`.

## Jenny data archive schema

**Source of truth:** `services/data-lifecycle/archive-format.js` and the
immutable fixture under
`tests/release-compat/fixtures/jenny-archive-v1-plain/`.

Archive v1 is a directory format identified by `format: jenny-data-archive`
and `format_version: 1`. `archive.json` is the bounded public envelope;
`manifest.enc` plus randomized `payload/*.bin` is the default encrypted shape,
while explicit plain mode uses `manifest.json` plus `data/`. `COMPLETE` is the
last file written and only complete, read-back-verified archives may authorize
live-data cleanup.

Readers accept only known versioned KDF profiles and enforce entry/byte,
metadata, path, collision, device-name, ADS, authentication, and checksum
bounds before writing. Version 1 is immutable: a future writer must bump the
format version for incompatible changes, while future readers may add explicit
migrations without rewriting the v1 fixture. Full profile restore is
fresh-profile only, ignores archive workspace rows, and stages/preserves
rollback state before canonical stores open. Workspace-only restore is a
separate reviewed transaction: it writes and flushes a bounded same-volume
schema-v1 journal under `.jenny/.restore-staging` before plaintext extraction,
keeps originals until verified rollback copies are flushed, flushes each
restored target before advancing its completion journal, and uses that journal
to roll back interrupted mutations when the
workspace owner starts. Invalid or future recovery journals are preserved and
fail closed.

## Terminal repair store schema (JSON)

**Source of truth:** `TERMINAL_REPAIR_SCHEMA_VERSION = 1` in
[services/backend/terminal-repair-store.js](../../services/backend/terminal-repair-store.js).

The standalone `{userData}/terminal-repairs.json` store is recovery provenance,
not canonical conversation history. It exists only when a terminal became
visible but the coordinator could not prove the corresponding canonical write.
Each pending artifact is fenced by session incarnation and turn generation and
contains a bounded terminal snapshot: proposed messages, tool repairs, turn
events, preference patch, title, and renderer terminal payload. A nullable
`message` carries the visible reply when one exists; terminal-only failures are
represented without fabricating canonical content.

Schema v1 has two terminal states: `pending` and `discarded`, plus a durable
`discard_requested` intent used while tool/event cleanup is still incomplete.
Successful retry clears the artifact only after canonical durability is proven.
Discard remains hydratable until cleanup and the tombstone are durable. Session
deletion removes its artifacts through the normal actor-owned cleanup path.

Future schema files are preserved byte-for-byte and expose no pending rows to
the current runtime. All writes fail closed with `newer_schema`; this surface is
registered as `electron.terminal_repair_store` with forward policy
`preserve_future_block_write`. Compatibility fixtures live under
`tests/release-compat/fixtures/terminal-repair-v1-current/` and
`terminal-repair-v2-future/`.

## Shell config schema (JSON)

**Source of truth:** `CONFIG_VERSION = 41` in
[services/shell-config-state.js](../../services/shell-config-state.js), consumed
by [services/shell-config-service.js](../../services/shell-config-service.js).

The persisted file is `{userData}/shell-config.json`. It owns display-safe shell
settings only: workspace root, feature toggles, local-engine defaults, speech
settings, chat UI zoom, telemetry consent, follow-ups, proactive settings,
memory capture suggestions, skills, and tips. Secret values stay out of this file per the
[credential storage policy](#credential-storage-policy).

Schema v36 splits Workspace IDE persistence into global `preferences` and up to
ten LRU root-local buckets keyed by a stable root identity. Open tabs, active
tab, expanded directories, stage surface, and preview target are root-local;
layout and editor preferences remain global. A v35 flat slice is promoted into
the configured root bucket. If no root was configured, path-bearing state is
dropped instead of being attributed to a future root. Schema v14's
`telemetry.crashReportingOptIn` remains consent metadata only; no Sentry DSN is
persisted in shell config.

Schemas v37–v41 normalize the Workspace IDE store, retire superseded
Settings controls. V38 preserves the prior effective workspace auto-save choice
while removing its feature override, moves legacy stream-inactivity tuning into
per-model state, and discards the unimplemented preserve-thinking preference.
V39 removes the memory-extraction, session-memory, and cron-scheduler overrides.
V40 explicitly discards `cost_tracker`; usage diagnostics are no longer a
feature flag and cannot be disabled through persisted overrides.
V41 adds the normalized `memory.captureSuggestions` preference, defaulting to
`true`. The renderer adopts the former localStorage preference through the
feature-settings service and removes the legacy key only after the durable write
succeeds; exact legacy string `"0"` remains the sole false value.

**Forward-version guard.** If a loaded config declares `version > CONFIG_VERSION`,
`ShellConfigService` normalizes a read-only in-memory snapshot for stability but
blocks write paths, including deferred workspace-state writes. The original
future-version file is preserved byte-for-byte from this build's perspective.
Repeated write-block warnings are deduped per loaded future config version.
Structured WARN diagnostics use:

```
shell_config.newer_schema_detected
shell_config.newer_schema_write_blocked
```

Corrupt or unreadable config files route through `FileJsonStore` as
`store.corrupted`; production `main.js` passes the shell logger into
`ShellConfigService` so the event reaches the structured shell log.

## Usage history schema (JSON)

**Source of truth:** `USAGE_HISTORY_SCHEMA_VERSION = 1` in
[services/usage-history-service.js](../../services/usage-history-service.js),
persisted as `{userData}/usage-history.json` and registered as
`electron.usage_history`.

Schema v1 stores normalized per-turn rows only. Session, today, and cumulative
totals are derived on read so aggregates cannot outlive the 30-day/500-turn
retention policy. Rows require a bounded stable `stream_id`, falling back to
`request_id`; malformed rows are isolated and retry identities deduplicate.
Retention keeps timestamps at the exact 30-day cutoff, then retains the newest
500 by timestamp and stable identity.

A missing store is established before the undated legacy `cost-tracker.json` is
retired; legacy aggregates are never synthesized into dated turns. A future
schema is preserved byte-for-byte and all writes fail closed. Clear and
session-removal mutations persist their candidate row set before replacing
in-memory state, so write failure preserves both detail and derived totals.

## Personality workspace schema (JSON)

**Source of truth:** `PERSONALITY_WORKSPACE_SCHEMA_VERSION = 2` in
`services/personality-workspace-service.js`, persisted as
`personality/default-workspace/.personality-state.json` under Electron's
`userData` directory.

The v1-to-v2 migration is exact-content and transactional. It replaces only
IDENTITY, SOUL, USER, and MEMORY files whose SHA-256 matches a frozen app-owned
v1 stock template. Every non-matching file is left byte-identical. Legacy
`BOOTSTRAP.md` is removed only on its exact app-owned hash, and
`.bootstrap-state.json` only when it parses as the bounded v1 app state shape.
The state file is written last; any earlier failure restores every managed file
snapshot and leaves the schema unadvanced.

Missing or malformed state is treated as v1 and safely upgraded. Version 2 is
idempotent and seeds only missing non-injecting placeholders. Versions greater
than 2 reject reads and writes without modifying workspace files. Chat treats
the advanced block as optional, emits a bounded
`chat.personality_compile_failed` warning, and continues with the canonical
runtime profile.

## Tool config schema metadata

**Source of truth:** display-safe per-tool configuration metadata lives in
[services/tools/tool-manifest.json](../../services/tools/tool-manifest.json).
Electron derives the schema through
[services/tool-config-schema.js](../../services/tool-config-schema.js) with
`TOOL_CONFIG_SCHEMA_VERSION = 1`; the Python sidecar validates and exposes the
same manifest metadata through `ConfigField` in
[sidecar/ai/tools/config_utils.py](../../sidecar/ai/tools/config_utils.py) and
the descriptor catalog in
[sidecar/ai/tools/catalog.py](../../sidecar/ai/tools/catalog.py).

The current schema describes display-safe tool toggles for the existing nested
`tools` shell-config object. Adding a new toggle field to `config_schema`
automatically adds the field's default to normalized shell config and to the
existing `features.getState()` payload under additive `toolConfig` metadata.
Feature-settings availability for manifest-backed tool toggles is derived from
the same schema, with explicit platform/workspace overrides kept in the
feature-settings service.
This default merge does not require a shell-config version bump when the stored
shape remains the same nested `tools` object with an optional new key.

Current supported storage/type is config-backed boolean toggles only. Toggle
defaults must be booleans, malformed optional metadata fails manifest
validation, and duplicate field keys are accepted only when the display
definition matches exactly and the duplicate merely contributes additional
`tool_ids`. Password-style fields are rejected until a SecureStore-backed
storage mode exists and is documented here. Sentry DSNs, API keys, OAuth tokens,
and other secret values still follow the
[credential storage policy](#credential-storage-policy).

## Session export format

**Source of truth:** `EXPORT_FORMAT_VERSION = 1` in
[services/backend/session-export-import.js](../../services/backend/session-export-import.js).

Session export payloads carry:

```jsonc
{
  "format": "jenny-session-export",
  "format_version": 1,
  "session": { "...": "..." }
}
```

Import accepts the current format version, treats a missing `format_version` as
legacy v1, and refuses `format_version > EXPORT_FORMAT_VERSION` before creating
a session or restoring attachments. The structured error is
`SessionImportError` with reason `unsupported_format_version` and the existing
format-mismatch code (`CMP-PERSIST-0002`).

## Scheduled task store schema (JSON)

**Source of truth:** `SCHEDULED_TASKS_SCHEMA_VERSION = 4` in
[services/scheduler-schema-version.js](../../services/scheduler-schema-version.js).
The scheduler service imports that lightweight constant so status registry reads
do not load the full scheduler runtime.

The scheduled-task file lives at `<workspaceRoot>/.jenny/scheduled_tasks.json`
when a tools workspace root is configured, otherwise under the app-owned
background runtime directory. The schema stores automation rows only. No task
is seeded by default. Version-2 and version-3 planner/verifier and auto-dream
records are migration inputs: normalization drops them, writes version 4, and
never dispatches them.

Registry task rows use this shape:

```json
{
  "id": "automation:project_health",
  "task": "project_health",
  "kind": "automation",
  "enabled": true,
  "trigger": { "type": "interval", "interval_seconds": 86400 },
  "policy": {
    "requires_feature_flags": ["tools_automations_enabled"],
    "defer_when_chat_active": true
  },
  "input": {
    "task_spec": "Run a read-only project health check.",
    "tool_grants": ["filesystem", "git"],
    "isolation": { "mode": "read_only" }
  },
  "retention": { "max_runs": 20, "max_log_bytes": 20000 },
  "automation_runs": [],
  "last_status": "",
  "last_reason": "",
  "last_started_at": "",
  "last_result_at": "",
  "last_completed_at": "",
  "updated_at": ""
}
```

Unknown and non-automation task ids in current-version payloads are dropped
during normalization and never executed. Automation rows may carry a bounded
interval trigger; malformed, non-positive,
or fractional interval values normalize to the registry fallback before the
payload is written back.

**Forward-version guard.** If the file declares
`version > SCHEDULED_TASKS_SCHEMA_VERSION`, scheduler write paths preserve the
future payload and no-op with structured WARN diagnostics. Repeated warning
pairs are deduped per active task path/version while the future payload remains
loaded:

```
scheduler.tasks_newer_schema_detected
scheduler.tasks_newer_schema_write_blocked
```

The scheduler does not execute tasks from a future-version task store. Generic
read helpers can still return a current-version default view for callers that
need a safe shape, but service write/execute paths must use the guard before
normalizing or persisting.

## Runtime config schema

**Source of truth:** `RuntimeConfig` dataclass at
[sidecar/ai/config.py:47](../../sidecar/ai/config.py); parser
`parse_runtime_config` at
[sidecar/ai/config.py:362](../../sidecar/ai/config.py).

### Policy: tolerant, logged, never rejected

`parse_runtime_config` does not raise on unknown top-level keys. Instead:

- It enumerates `_KNOWN_TOP_LEVEL_KEYS`
  ([sidecar/ai/config.py](../../sidecar/ai/config.py)) — the single source of
  truth for what the parser reads.
- On load, any string key in `raw_config` that isn't in that frozenset produces
  exactly one structured WARN per load:

  ```
  event=ai.config.unknown_keys
  level=WARNING
  data={"keys": [...sorted...], "source": "runtime_config"}
  ```

- Every known key has a validated default. Out-of-range values silently fall
  back to the default; this is intentional — the config layer is a boundary
  that never trusts input.

This policy means:

- Forward-compat: a newer renderer sending extra keys doesn't crash an older
  sidecar. The WARN makes drift visible.
- No rejection means no migration hook is required to land a new config field.
  Add the key to `_KNOWN_TOP_LEVEL_KEYS` **and** `RuntimeConfig` **and** the
  parser in the same change; the WARN will stop firing.

### Adding a new config key

1. Add the field to `RuntimeConfig` with a typed default.
2. Add a parser line inside `parse_runtime_config` that reads `raw_config.get(...)`.
3. Add the key to `_KNOWN_TOP_LEVEL_KEYS`.
4. Pass the parsed value to the `RuntimeConfig(...)` constructor call at the
   bottom of the function.

### Deprecating a config key

1. Keep the key in `_KNOWN_TOP_LEVEL_KEYS` for one release (silences the WARN).
2. Stop reading it in `parse_runtime_config`.
3. Remove the field from `RuntimeConfig`.
4. After one release, remove from `_KNOWN_TOP_LEVEL_KEYS`. Any lingering
   sender will then see the `ai.config.unknown_keys` WARN.

### Renaming a config key

Treat as deprecate + add:

1. Read both the old and new name during the overlap release.
2. Log a WARN if both are present (prefer new).
3. After one release, remove the old-name read.

## Ollama catalog cache schema (JSON)

**Source of truth:** sidecar-owned
[sidecar/ai/engines/ollama_catalog_cache.py](../../sidecar/ai/engines/ollama_catalog_cache.py)
exports `SCHEMA_VERSION = 1` and owns the derived `ollama-catalog.json`
payload. Managed sidecars write the cache below `electron_state_root`; direct
or headless sidecars fall back to `~/.companion/ollama-catalog.json`.

The live Ollama daemon remains authoritative. `models.list` uses live
`GET /api/tags` results when available, records the daemon version from
`GET /api/version` when available, and writes normalized model entries with
`cached_at` / `expires_at` metadata. If live discovery later fails, sidecar may
return a matching cached catalog as additive `source: "cache"` and
`stale: true` model-list metadata. Known daemon-version mismatches are not
reused; when the current daemon version cannot be established, the latest
same-base-url cache may be used. Local Ollama manifest fallback remains after
cache miss.

Future cache schema payloads (`schema_version > SCHEMA_VERSION`) are preserved:
older builds skip reads and block writes instead of downgrading the file.
`schema_version` must be an integer or digit-only string; booleans, decimals,
and other malformed values are ignored. Corrupt or unknown older cache payloads
are ignored and rewritten only after a fresh live discovery succeeds.
Current-schema cache reads and rewrites sanitize model entries to display-safe
Ollama catalog fields only (`id`, known boolean `capabilities`, and
`template_family`); malformed entries are dropped rather than surfaced through
`models.list`. The cache stores display-safe metadata only and is safe to
delete; it is derived state, not a source of truth.

## Plugin catalog source schema (JSON)

Electron registers `electron.plugin_catalog_sources` schema v1. The durable
store binds configured remote catalogs and user-trusted offline mirrors to a
pinned TUF root and monotonically increasing revision. Future schemas are
preserved and mutation-blocking. Invalid sources fail independently during
catalog refresh; public state excludes pinned-root bytes, endpoints, local
paths, and credentials. The versioned public metadata validators live in
`config/plugins/catalog-source-v1.schema.json` and
`config/plugins/catalog-entry-v1.schema.json`; these do not change the frozen
plugin package or generation contract families.

## Standalone MCP configuration schema (JSON)

Electron registers `electron.mcp_servers` schema v1. Each stdio or gated-SSE
row stores an explicit `enabled` value and a trust record binding configuration
digest, advertised-tools digest, review timestamp, and pending/approved status.
Only enabled, approved rows are forwarded during sidecar initialization, along
with the approved tools digest.

A valid unversioned legacy document is atomically migrated with every row
disabled and pending review. Existing `secret_ref` values and safeStorage
ciphertext are unchanged. Plaintext secret fields, unknown lossy fields,
malformed rows, duplicates, and future schemas leave the original file
untouched, expose read-only remediation status, and forward no server. Writes
use staged atomic replacement plus post-write verification and retain the prior
effective configuration on failure. Release compatibility is pinned by
`tests/release-compat/test_mcp_config_compat.js` and its missing, legacy,
current, malformed, plaintext-secret, and future fixtures.

The additive `mcp.inspect` request shares `API_VERSION` negotiation and adds no
notification, turn-event kind, or durable sidecar state. Configuration edits or
`CMP-MCP-0009` tool-surface drift invalidate approval and return the row to
disabled/pending review. See
[PLUGIN_SECURITY.md § Plugin Catalogs and MCP Trust](../PLUGIN_SECURITY.md#plugin-catalogs-and-mcp-trust).

## Plugin contract and generation compatibility

Plugin contracts are generated from `config/plugins/v1/*.schema.json`. W11
irreversibly froze every named V1 contract and `_common` on 2026-08-03 and wrote
`config/plugins/contract-lock.json` with the exact source digest for all 25
files. V1 is immutable: change requires a new versioned contract, validator
support, parity cases, registry entry, and explicit migration/compatibility
intent. Never edit a frozen V1 schema or either generated validator directly.

Electron registers `electron.plugin_contract_set` and
`electron.plugin_generation_store`; Python registers
`sidecar.plugin_contract_set`. Registry constants are literal metadata and do
not import plugin runtime modules on flag-off startup.

Stage-4A generation compatibility is deliberately asymmetric and requires no
schema migration:

- current V1 `installed_disabled` and `active` generations may rehydrate;
- every `active` package is re-read from its exact persisted archive and must
  pass signature, current trust root, manifest, digest, and declarative-content
  verification before the sidecar receives a snapshot;
- committed V1 `preparing` or `disabling` is invalid transitional evidence and
  makes the store mutation-blocking rather than being normalized;
- a newer generation schema is preserved byte-for-byte and makes the entire
  plugin store read-only;
- recovery must inspect retained generations even when the active pointer is
  missing, so it cannot erase or route around future evidence;
- incompatible, corrupt, safe-mode, or failed-rehydration state is core-only;
  no plugin contribution executes; and
- `plugins.getState` reports bounded `read_only`, `store_writable`, and
  incompatibility metadata for Manager explanation.

`PluginOperationReceiptV1.generation_id` is required attribution, not inferred
from an epoch or journal row. The V1 shape requires `retain_until` on every row:
pending rows carry the non-expiring `9999-12-31T23:59:59Z` sentinel and terminal
settlement replaces it with the real 30-day deadline. Terminal receipts are
capped at 4,096. Expired terminals are deleted first, then the oldest terminal
rows. Pending or corrupt evidence is never automatically deleted. Pre-W11 rows
missing generation attribution or retention are preserved byte-for-byte as
corrupt evidence; status lookup returns indeterminate and neither recovery nor
compaction infers an outcome. A lookup after early cap eviction fails closed as
expired/indeterminate and emits bounded structured eviction diagnostics.

Release compatibility is pinned by
`tests/release-compat/test_plugin_store_compat.js` with current disabled,
Stage-4A active, transitional-invalid, and future-schema fixture trees. Any
plugin generation schema or permitted-state change updates that corpus in the
same change.

### Stage 4B V2 plugin state

The V1 contract directory and `contract-lock.json` remain immutable. Stage 4B
adds an independently locked V2 family for manifest, declarative content,
generation, runtime snapshot, settings state, and command invocation. Startup
may read mixed V1/V2 state but never rewrites or downgrades it. The first
Stage-4B mutation normalizes the complete graph into `PluginGenerationV2` while
retaining the V1 active-pointer format and exact V1 package validity.

Settings are content-addressed records beneath the owning plugin data directory.
Generations bind their exact state digest and revision. An update writes and
validates the replacement settings/runtime state before the active-pointer CAS;
stale generation or revision fails closed. Disable retains settings. Uninstall
withdraws authority first and then attempts idempotent contained deletion; a
failure records pending cleanup without re-enabling authority.

`plugin-store-v2-stage4b` is the current V2 compatibility fixture.
`plugin-store-v3-future` proves a future generation remains byte-preserved and
read-only. A future schema is never inferred, normalized, or routed around.

## FileJsonStore corruption policy

**File:** [services/backend/file-json-store.js](../../services/backend/file-json-store.js).

### Before

`read()` caught non-ENOENT errors and logged only via `console.error`
(finding K6). Corrupted stores looked like first-launch to the caller with no
structured log trail.

### After (2026-04-20)

`FileJsonStore(filePath, options?)` accepts an optional `{ logger }` callback
where `logger(level, event, data)` matches the `_emitServiceLog` signature used
across `services/backend/`. On non-ENOENT read failure the constructor-supplied
logger is invoked with:

```
level  = 'WARN'
event  = 'store.corrupted'
data   = { filePath, errorCode, errorMessage }
```

`console.error` is preserved as a defense-in-depth fallback so a missing
logger never silences corruption.

### Consumer guidance

New call sites with a service reference that has `_emitServiceLog` SHOULD pass
a logger:

```js
this.store = new FileJsonStore(filePath, {
  logger: (level, event, data) => service._emitServiceLog(level, event, data),
});
```

Existing single-arg call sites (nine as of 2026-04-20, enumerated in the
Bundle 5C finding) keep working unchanged. A follow-up Bundle 6E pass can
thread loggers through where it's cheap.

## Cache boundary marker (accepted risk)

**Finding:** O15 of the review doc — the cache-split marker
`<!-- CACHE_BOUNDARY -->` at
[sidecar/ai/context/prompt_cache.py:11](../../sidecar/ai/context/prompt_cache.py)
is a literal HTML comment. A tool output containing the exact bytes would
misalign the cache split.

**Status:** accepted risk. Bundle 5B shipped
[sidecar/ai/tools/prompt_marker_guard.py](../../sidecar/ai/tools/prompt_marker_guard.py),
which is wired into `sanitize_tool_output`
([sidecar/ai/tools/sanitization.py](../../sidecar/ai/tools/sanitization.py))
and neutralizes the marker in every tool-originated payload before it can
reach the cache splitter.

No code change for this finding. If a non-tool-originated path is ever added
that writes arbitrary text across the cache boundary without passing through
sanitization, revisit this section and either (a) route that path through
`neutralize_prompt_markers` as well, or (b) switch the marker to a UUID-derived
sentinel (breaking change; would require flushing on-disk caches).
