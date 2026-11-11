# Explorer brief template

A read-only finder: an anchor map, a listing, a source check. The explorer reads neither `AGENTS.md` nor any memory, so the brief carries its scope, its stop condition and the output format.

Fill it from the repository root with `python scripts/dev/fill_spec.py OUT --template explorer KEY=value KEY=@file ...`. The tool drops everything down to the body marker, then exits 2 and writes nothing if a key is unfilled, a value is empty, or a key is passed that the body does not have.

Fields:

- `{{QUESTION}}` what the orchestrator needs to know, and what it will decide with the answer.
- `{{SCOPE}}` the files, directories or patterns to read, and what is out of scope.
- `{{STOP}}` when to stop: a file count, the first complete answer, or a list fully covered.
- `{{OUTPUT}}` the exact line format of the answer.

The orchestrator checks a claim against source before acting on it. For a map that must be complete before a spec is written, raise the tier and say so.

<!-- BODY -->
# Read-only exploration

You are answering one question about the JennyGC repository. You change nothing: this is a reading task.

## Question

{{QUESTION}}

## Scope

{{SCOPE}}

## Stop when

{{STOP}}

## Output format

{{OUTPUT}}

## Rules

- Read only. Do not create, edit or delete a file, do not change git state, and do not start the app, a test run or any other process.
- Every location is `path:line`, copied from tool output. If you do not have the line, write `path:?`; never estimate one.
- Prefix a line with `UNVERIFIED` when you inferred it and did not read it in the file.
- List every in-scope file you did not read under `NOT READ`, with the reason.
- Report items as you find them. Do not merge two items into one, and do not add an item the files do not state.
- End with `files read: <n> of <N>`.
