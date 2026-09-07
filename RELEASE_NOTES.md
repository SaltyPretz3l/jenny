# Release Notes

## 1.0.0 - 2026-09-06

Jenny 1.0 — the first stable release, and the first release published from
the public repository (`github.com/SaltyPretz3l/jenny`).

### Highlights

- **Local models, properly driven.** A managed `llama-server` engine ships
  alongside Ollama, with per-model engine choice, speculative decoding (MTP)
  where the model supports it, and GGUF discovery that finds your models
  wherever they live — Ollama's own blob store, or folders you nominate.
  Models you already have are recognised without a catalog entry: Jenny
  estimates fit from the model's real size and parameter count and tells you
  what will fit in your VRAM before you load it.
- **A real model library.** Settings gained a grouped model library with a
  per-model tuning drawer: context length, engine, acceleration, and the
  sampler knobs that matter, with a Use button that actually activates the
  model. Tuning fails closed rather than silently ignoring a value it cannot
  apply.
- **Images in chat.** Attach or paste an image and Jenny sends it as a real
  vision turn — on Ollama, on the ChatGPT subscription connector, and on the
  managed `llama-server` with an auto-attached mmproj projector. The composer
  tells you up front when the loaded model cannot see, instead of failing at
  send time.
- **Extensible: skills, plugins, themes, and MCP.** Skills are invocable with
  `/` autocomplete and attach to a single turn as a composer chip; each one can
  be disabled individually. The Plugins & Extensions surface was rebuilt around
  installing a plugin — a file picker and a drop zone — including a
  developer-unsigned path for plugins you are building yourself, clearly
  labelled as such. Privileged plugin kinds are still refused without a
  signature.
- **Reasoning you can actually read.** Thinking streams verbatim: whitespace and
  paragraph breaks survive, numbers are no longer corrupted mid-token, and a
  model that writes HTML inside its reasoning no longer freezes the panel. Long
  reasoning is bounded by a budget that scales with the context window and
  continues across checkpoints rather than stopping silently.
- **Longer conversations.** Mid-turn compaction summarises earlier context
  instead of failing when a turn outgrows the window, with persisted snapshots
  so a reload keeps the thread. The composer's context meter reports usage from
  the sidecar's own numerator rather than an estimate.
- **Plan mode v2.** Plans are first-class documents: an editable pending plan
  card, approval that survives a restart, plan-artifact writes, and a plan
  section in the task list. Approved plans expire rather than lingering.
- **A leaner, sharper tool surface.** The model-facing tool set was
  consolidated from 62 tools to 47 — inspection folded into `read_file`, the
  `lsp_*` family merged into one actioned `lsp` tool, the browser tools
  retired, and `apply_patch` replaced by atomic `edit_file` edits. A durable
  operation ledger makes side-effecting tools idempotent across retries, and a
  new `preview_test` tool renders workspace HTML.
- **Workspace and editor.** The explorer gained multi-select, keyboard parity,
  drag-to-move, cut/copy/paste/duplicate, sort, rename-on-blur, Open in
  Terminal, external OS drop-import, and undo toasts. Every IDE write fails
  closed, and the editor tells the truth about why something could not open.
- **First run, rebuilt.** The linear setup wizard is gone, replaced by a
  checklist hub with its own engine-gate scenes and the model library as the
  model step. Setup counts model routes by provenance, so a cloud engine can
  no longer mask the local models you have installed.
- **Interface polish throughout.** Health moved into the titlebar; the chat
  timeline gained code-block chrome, divider anchoring, a tool-activity row,
  animated reasoning collapse and token fade; previews fill their frame; and
  sandboxed HTML preview renders on all three preview surfaces.
- **Local-first and verifiable.** No accounts, no telemetry (crash reporting is
  opt-in and off by default), per-release SHA-256 asset manifests, and
  `npm run test:dist` plus the full policy suite green on the exact source tree
  that ships.
- **One-click Windows installer** with a guided first run: hardware scan,
  SHA-256-verified Ollama install, hardware-aware model recommendation and
  pull, workspace and personality setup. Downloads stay at the permanent URL
  `releases/latest/download/Jenny-Setup-x64.exe`.
- **Plugin platform in core, no bundled plugins** — the plugin host ships;
  first-party plugins are distributed separately once they clear their own
  release gates. The packaged app carries no plugin bundles and no
  restricted-host/full-host supervisor binaries (nothing consumes them
  without plugins).
- **Best-effort macOS build (experimental)** — an unsigned, untested arm64
  dmg+zip is published with each release; auto-update stays disabled on
  macOS. Because the app is unsigned, Gatekeeper blocks the first launch:
  approve it under **System Settings -> Privacy & Security -> Open Anyway**
  (on older macOS versions, right-click the app -> **Open** also works).
  The macOS build has not been exercised on real hardware, and the sandboxed
  Python tool (`python_execute`) is Windows-only for now.

### Also in 1.0.0 (landed after the 2 September cut)

- **The app is called Jenny.** The product name *Jenny Shell* is retired:
  the executable is `Jenny.exe` (`Jenny.app` on macOS), and the desktop
  shortcut, Start menu entry, and Installed-apps entry all read *Jenny*. A
  leftover *Jenny Shell* desktop shortcut from an earlier install is removed
  on first launch. The application id is unchanged, so installing over
  0.9.0 replaces it in place.
- **Tasks rail.** A Tasks panel is the third chat-rail mode. The model keeps
  a per-session task board through the `task_board` tool, add rows carry a
  spawn chip that opens the task in its own session, and sessions spawned
  that way record the task they came from.
- **Approvals you can read.** The approval card is built around what will
  actually happen and names the specific reason a tool needs approval.
  *Always allow* is scoped to the tool **and** the path it named; every
  saved decision is listed under **Settings > Tools > Approval rules** with a
  Remove action. Destructive shell commands ask for approval even under
  Auto-run, and a dedicated `move_file` tool replaces shell moves and
  renames.
- **Session lockdown and workspace recovery.** A session can be locked down
  offline for the rest of its life. Workspace mutations made by tools are
  journaled, so a change set can be restored or undone, with bounded
  retention.
- **Resume after a budget stop.** When a turn stops on the tool or iteration
  budget, a persisted Resume button continues it instead of leaving a dead
  end.
- **Composer and shell polish.** A themed model picker in the composer, native
  spellcheck with right-click corrections on prose fields, and a tooltip on
  every control.
- **Gemma 4 on the managed `llama-server`.** Thinking rows render, the
  context window is editable per model (with a restart confirmation), and the
  MTP drafter is used where the model supports it.
- **`python_execute` bootstrap reliability.** The runtime bootstrap is bounded
  in wall-clock time, failures are diagnosable and converge instead of
  repeating, and executed code runs in the workspace and says so.
- **Faster startup, faster IDE.** The painted shell is revealed earlier and
  background refreshes are deferred; Quick Open, the diff gutter, and
  gitignore-aware enumeration and search were reworked for large trees.
  Long thinking turns render without the panel growing unbounded.
- **Sidecar responsiveness.** Blocking sidecar RPCs moved off the
  single-threaded dispatch loop, so changing Model Library settings during a
  long generation no longer stalls every other request for minutes.
- **Plugin authoring.** `npm run plugin:validate -- <folder-or-archive>`
  checks a plugin or theme against the same admission rules the installer
  applies.
- **Verification (opt-in, default off).** A `verify` tool that runs your
  saved Test Runner configurations and a turn-finalization verification gate
  ship behind `JENNY_ENABLE_TOOLS_VERIFY=1` and
  `JENNY_ENABLE_VERIFICATION_GATE=1`; the Workspace IDE Test Runner itself is
  on by default.

### Uninstall, archive, and recovery

- Settings now exposes a Data & removal surface for portable archive creation,
  fresh-profile restore, and the dedicated outcome-first uninstall assistant.
- Encrypted archive v1 is the default and is fully authenticated/read-back
  verified before cleanup can begin; explicit plain archives carry a privacy
  warning. Restore stages atomically and retains rollback state through the
  next successful boot.
- Windows NSIS, the macOS DMG helper, and clone wrappers share one allowlisted
  lifecycle policy. App-only and silent removal preserve data; permanent
  removal requires explicit confirmation and never deletes shared models or
  ordinary project files.

### Contract changes

- `API_VERSION` moved from `2026-07-15` (v0.9.0) to `2026-08-17`. The
  Electron shell and packaged sidecar move in lockstep inside one release, so
  no user-facing migration is required. Session store `SCHEMA_VERSION`
  handling is covered by the release-compat fixture corpus
  (`tests/release-compat/`), and `EXPECTED_APP_VERSION` advances with this
  release.
- Adds the renderer-facing `dataLifecycle.*` IPC/preload surface, the narrow
  uninstall preload/exit-code contract, and immutable archive schema v1. No
  sidecar JSON-RPC methods, turn-event kinds, or Electron session-schema
  migration are added.
- The web tools' public-address check is stricter. IPv6 tunnel forms (6to4,
  Teredo, ISATAP) are now also rejected when the IPv4 address they embed is non-public,
  and the NAT64 well-known prefix `64:ff9b::/96` plus the CGNAT shared
  address space `100.64.0.0/10` are rejected explicitly. **Behavior change:**
  destinations in `100.64.0.0/10` — notably tailnet and carrier-grade-NAT hosts
  — were previously fetchable by default and are now blocked. Set
  `tools_web_allow_private_addresses` to `true` to opt back in. The setting is
  honored by the fetch and search paths and by the MCP `sse` transport URL and
  OAuth `token_url`, so a self-hosted MCP server on a LAN, tailnet, or CGNAT
  address stays reachable under the same single opt-in. It relaxes only the
  address-class check — DNS pinning, the redirect refusal, and the
  no-credentials-in-URL rule apply either way.

- Since the 2 September cut: new built-in tools `task_board` (default on),
  `move_file` (default on), and `verify` (default off); a workspace-recovery
  IPC surface backed by `config/workspace-mutation-journal-v1.schema.json`;
  and a `linked_task_id` field on task-derived sessions. `API_VERSION`
  (`2026-08-17`), the shell `CONFIG_VERSION`, and the session-store
  `STORE_SCHEMA_VERSION` did not move, so no migration accompanies these.

### Upgrading from 0.9.0

- The update feed moved with the repository: 0.9.0 installs point at the
  retired private distribution repo and **will not auto-update to 1.0.0**.
  Download the new installer once from the releases page; your data and
  chats are preserved in place (`%APPDATA%\jenny`). Auto-update resumes from
  1.0.0 onward.
- 0.9.1 was an internal version and never published; its changes ship here.

### Release audit

- `npm audit --omit=dev` and the full `npm audit` report zero advisories.
  DOMPurify was updated to 3.4.12 for `GHSA-c2j3-45gr-mqc4`; the existing
  brace-expansion overrides now select 1.1.16/2.1.2 for
  `GHSA-3jxr-9vmj-r5cp`. No `npm audit fix` or new override was used.

## 0.9.0 - Released 2026-07-22

> **Published 2026-07-22** as the first public installer:
> [jenny-dist v0.9.0](https://github.com/SaltyPretz3l/jenny-dist/releases/tag/v0.9.0),
> Windows x64 only, unsigned, built locally from the jenny-dist clone at
> `260d4973` (GitHub Actions blocked on account billing; GitHub Releases
> hosting is unaffected). Renumbered from the unreleased 0.3.0 section (owner
> call: the version should reflect actual maturity). Supersedes the unreleased
> 0.2.0 section below; the Release Evidence fields and SHA256 manifest block at
> the bottom of this file record this candidate.

### Highlights

- Streaming-chat correctness wave: canonical live-segment positioning, no
  earlier-segment blanking, retried turns keyed by their answering stream,
  terminal-error cards render and settle the deck, plan-drift no longer
  preempts approved turns.
- Tool-loop UX: live `run_command` stdout/stderr streamed into the running
  tool card, background-job chips with completion toast and kill, per-tool
  elapsed timers, approval cards quote the exact command, clickable file
  paths in the chat timeline, and Stop kills the in-flight subprocess tree.
- ChatGPT subscription connector (engine, auth service, and setup card) and a
  `load_skill` builtin so advertised skills are loadable.
- The Artifacts studio view is removed; the split review panel is the sole
  artifact surface.
- Performance: sidecar cold start 1118ms -> 683ms via deferred flag-gated tool
  imports, turn-event journal appends no longer deep-clone the turn, and a
  lookup-only session-store view on the tool-call hot path.
- Hardening: JCA 2026-07-20 audit remediation, workspace-root guards
  (including rejecting Jenny's own `.jenny` state dir), Windows
  `run_command` quoted-executable fixes, and case-insensitive workspace
  search anchoring.

### Contract changes

- Session store `schema_version` bumped 15 -> 16: Electron-owned manual
  compaction snapshots (`compaction_snapshot`). The release-compat corpus
  gained `userdata-v16-current`; legacy fixtures v3-v15 still migrate
  cleanly.

## 0.2.0 - Unreleased

> **Not yet released (as of 2026-07-14).** The Release Evidence fields below are a fill-in template, and the empty SHA256 manifest block at the bottom is populated at tag time by the release pipeline.

### Release Foundations

- Added CI and policy gates for the GitHub-ready source stage.
- Added a curated, deterministic `test:dist` verification lane for the generated
  distribution while excluding owner-only GUI, live-provider, and load tests.
- Added the packaged-update service contract, renderer update dialog shell, and release-version policy checks.
- Added release provenance, rollback, packaged-smoke evidence, failure-drill evidence, and SBOM/dependency-audit planning for the P2 Release Trust Baseline.

### Contract changes

- Bumped the lockstep sidecar API to `2026-07-15` and added correlated,
  bounded `runtime.progress` notifications for model acquisition and loading.
  Backend status now additively exposes sidecar and model lifecycle state.
- The prior `2026-07-12` contraction removed the dormant raw
  `chat.get_active_turn_state` JSON-RPC method. The renderer-facing
  `chat.getActiveTurnState` IPC contract remains available and now reads
  Electron-owned persisted `active_turn` state guarded by the live stream-controller
  registry.

### Local model cold-start

- Replaced the fixed initialization race with a single-flight coordinator that
  uses a 15-second inactivity watchdog refreshed only by validated forward
  progress and a 615-second absolute ceiling.
- Added bounded streaming Ollama acquisition, installed-model bypass, and
  explicit `sidecar_spawned`, acquiring, loading, ready, and unavailable UI
  states. Pull failure keeps the shell usable and blocks chat until Retry or a
  model change succeeds; cancellation and shutdown retain bounded cleanup.

### Sidecar hardening

- Removed dormant planner/verifier, parallel-tool, and Python active-turn ownership
  surfaces while preserving request-scoped plan mode and the Electron-facing active-turn API.
- Made container publication transactional and request state isolated; corrupt or
  future memory stores now degrade to a coded unavailable state without modifying bytes.
- Preserved complete semantic tool rounds under compaction and bounded workspace,
  skill, repository, provider-call, vision, HTTP, framing, subprocess-output, and
  diagnostics inputs before accumulation or persistence.
- Propagated one cancellation/deadline lineage through providers, retries, fallback,
  approvals, tools, checkpoints, and sub-agents; fallback engines and owned process
  groups now close deterministically.
- Added bounded auxiliary GPU profiling, child/tree cleanup, provider/MCP/LSP transport
  limits, and redaction before shell, monitor, and background output persistence.
- Reached a zero-warning `ruff check sidecar` source baseline without blanket
  suppressions. The reproducible CPython 3.13.14 bundle is implemented; its packaged,
  clean-profile, network-disabled smoke remains an owner-run release gate.

### Release Evidence

Fill these fields before publishing a release candidate. Use `not run`, `blocked`,
or `not applicable` rather than leaving an evidence row ambiguous.

```text
Release evidence date: 2026-07-22
Release commit/tag: jenny-dist v0.9.0 at 260d49731c2cad159e73e5f758868fd102f020eb (source main 418459db)
GitHub Actions run or local builder: local builder (owner dev box, <dist-checkout> clone) - Actions blocked on account billing; assets uploaded via gh release create
Builder OS / Node / npm / Python: Windows 11 Home 10.0.26200 / v24.16.0 / 11.13.0 / 3.11.7 (clean hash-locked venv, pip check clean)
SOURCE_DATE_EPOCH: 1735689600
Sidecar manifest path: resources/sidecar/manifest.json (built from build/sidecar/manifest.json)
Sidecar manifest api_version / git_commit / git_dirty / sha256: 2026-07-15 / 260d49731c2cad159e73e5f758868fd102f020eb / false / e359a3582391f88fa9e1e3150e2e21e9e6f135f884a8057b473ab3b3bad03257
Signing state: unsigned-dev (no Authenticode; verifyUpdateCodeSignature false for the unsigned update channel per DISTRIBUTION.md; SmartScreen caveat documented)
Notarization state: not applicable (Windows-only release; macOS build deferred - needs a macOS runner)
Packaged smoke log: headless subset PASS 5/5 (artifact validation, --version probe, launch probe, sidecar initialize probe, signing status) - the packaged-app GUI leg of release:smoke remains owner-run
Manual matrix summary: not run (owner-run gate outstanding)
Failure-drill summary: fail-closed launch verified via packaged launch probe; boot-crash drill exercised for real by the Pillow optional-dep regression (caught by the initialize probe, fixed pre-publish)
SBOM/dependency audit: dist/sidecar-sbom.json emitted during pack:release; npm/Python advisory sweep deferred
Bundled asset provenance notes: CPython 3.13.14 embeddable bundle hash-verified against config/python-runtime-bundle-lock.json; wheel closure from requirements-python-runtime-lock.txt; no new third-party bundles
Rollback/reinstall decision: promote; rollback = delete the GitHub release + tag (no auto-update installs exist before this release); user data unaffected (session store schema v16 unchanged)
Known deviations: unsigned installers; Windows-only; published from a local builder instead of CI; owner GUI smoke + manual matrix pending
Release decision: promote (owner instruction to publish, 2026-07-22)
```

<!-- JENNY_RELEASE_SHA256_MANIFEST_START -->
| File | SHA256 |
| --- | --- |
| dist/Jenny-Setup-x64.exe | 308f288dc9b2e5ae690d6858f7b38fac8ba328b814c1f9685bffa3b2fe576582 |
| dist/Jenny-Setup-x64.exe.blockmap | 06426fdd76dafc10aa68ac5b188799b90136a85efe34680bca7033280c975e97 |
| dist/latest.yml | 479ac264661f9973e3d00ab5a6512238cf714060c15ad561488aa396d3f0deb2 |
<!-- JENNY_RELEASE_SHA256_MANIFEST_END -->
