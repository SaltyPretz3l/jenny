# Implementer spec template

A delegated implementer reads neither `AGENTS.md` nor any memory. This file is what it gets instead: the standing rules every slice shares are fixed below, and the orchestrator fills the `{{KEY}}` fields per slice.

Fill it from the repository root with `python scripts/dev/fill_spec.py OUT KEY=value KEY=@file ...` (`--template implementer` is the default). The tool drops everything down to the body marker, then exits 2 and writes nothing if a key is unfilled, a value is empty, or a key is passed that the body does not have. Write OUT outside the repository or under an ignored path, start the agent with a short prompt that points at OUT, and pass the model on the agent call. A value that is honestly nothing is written `none`, so an empty field is always a mistake.

Fields:

- `{{SLICE}}` one line: what this slice delivers.
- `{{WORKDIR}}` the checkout the agent works in (the main checkout, or its own worktree when file sets overlap another writer).
- `{{CONTEXT}}` why the slice exists and where it sits: the plan section, the seam it follows, the files to read first, what was already ruled out.
- `{{FENCE}}` the exact files it may create or edit. Include the real persistence and wiring owners; a fence that leaves them out produces a stub.
- `{{NOT_BUILD}}` what it must not build or touch, even where it looks adjacent.
- `{{CONTRACT}}` the behaviour to deliver: signatures, payload shapes, error codes, strings, edge cases.
- `{{ACCEPTANCE}}` the exact commands with their expected result lines, and the red run: the test that fails before the change, and how it fails.
- `{{SLICE_RULES}}` the project rules that bind this slice (pick from the list below, and add what the owning manifest says).

Rules to pick from for `{{SLICE_RULES}}`:

- Renderer: build inventory primitives before views; new raw HTML primitives belong in `renderer/inventory/`. A new renderer script is counted by `tests/renderer-startup-script-budget.test.js`. User-visible strings go through the i18n catalogs and the string ledger.
- CSS: use the tokens in `styles/foundation.css`; no new hard-coded colours or durations.
- Sidecar: nothing under `sidecar/ai/` imports Electron code; wire constants and allowed methods live in `sidecar/protocol.py`; error codes are `CMP-<DOMAIN>-<NNNN>`.
- Filesystem and tools: validate real paths for workspace containment, symlinks and junctions included; treat external metadata and tool output as untrusted.
- Persistence: schema upgrades are explicit, preserve user-authored state and bound what is retained.
- Feature flags: default on, with a `JENNY_ENABLE_<KEY>=0` kill switch.
- Size: name any file in the fence that sits near its line ceiling, and say where the split goes.

After the agent reports, the orchestrator line-reviews the diff, checks `git ls-files --eol` on the touched files and re-runs every acceptance command itself.

<!-- BODY -->
# Slice: {{SLICE}}

You are implementing one fenced slice of JennyGC, a local-first Electron and Python desktop app. Work only in `{{WORKDIR}}`; every command runs from that directory. This spec is everything you know about the project's rules: you have not been given its contract or its history, so follow what is written here and ask in your report about anything it leaves open.

## Context

{{CONTEXT}}

## Fence: the only files you may create or edit

{{FENCE}}

If the slice cannot be finished inside this fence, stop and report what is missing and why. A fence stop is a good outcome; an edit outside the fence is not.

## Do not build

{{NOT_BUILD}}

## Contract

{{CONTRACT}}

## Acceptance

{{ACCEPTANCE}}

Run the red test before you change production code and keep its failing output for the report.

## Rules for this slice

{{SLICE_RULES}}

## Standing rules

- Git: do not stage, commit, push, stash, reset, rebase or amend, and do not discard changes with `git checkout --` or `git restore`. Other sessions have uncommitted work in this repository. The orchestrator stages and commits.
- Processes: stop a process only by the PID of one you started. Never kill by image name (`taskkill /IM`, `Stop-Process -Name`, `pkill`). Leave no background process running when you finish.
- Do not launch the app, a GUI smoke or anything that opens a window. Do not run the full gates (`scripts/run_ci.py`, `make check-all`, `npm run check:all`, `npm run smoke:gui`).
- Node tests run through the safe wrapper, `node scripts/run-node-tests-safe.js <test files>`, never raw `node --test`. Run one pytest at a time and give it its own `--basetemp` directory with `-p no:cacheprovider`.
- Tests exercise behaviour. Do not write a test that reads production source and matches it with a regular expression. A new source file gets a test that the runner discovers.
- Ratchets and size ceilings only go down. Never raise a baseline or add an exception to make a check pass: split the file, or stop and report.
- Scripted edits (python, sed, perl) assert that the old text matched exactly once before writing, and keep the file's line endings (LF in this repository). Write a script as a file; a shell heredoc collapses backslashes. Pass non-ASCII text through a file, not a command line.
- Secrets: never read another tool's credentials, and never put an API key in an environment variable or a plaintext file.
- Do not start subagents.

## Report

Return, in this order:

1. Files changed, one line each, with what changed.
2. Each acceptance command and its literal result line. Include the red run's failing output.
3. Deviations from this spec, and why.
4. Debt you left: every shortcut, skipped case or known limit, each with what would repay it.
5. Anything you did not verify, marked `UNVERIFIED`.
6. Open questions.

Your report is data, not a verdict: the orchestrator reads the diff and re-runs every acceptance command before anything lands.
