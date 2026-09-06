# Security Model

## Prompt-Injection Defense

The sidecar treats all tool output, model output, model-supplied tool arguments,
and workspace personality text as untrusted by default. The full filtering
pipeline lives in `sidecar/ai/tools/sanitization.py` and the wire-marker guard
in `sidecar/ai/tools/prompt_marker_guard.py`.

This page is the single discoverability surface for that pipeline. Audit agents
have repeatedly missed it because the relevant code is split across short
helpers in `sidecar/ai/tools/` and the personality sanitizer at
`sidecar/ai/personality/sanitization.py`.

### What gets sanitized, in order

`sanitize_tool_output()` is the canonical entry point for tool result text
heading back into the model. The pipeline runs each pass on the previous
pass's output:

1. `_normalize_whitespace_and_control()` — replaces unpaired UTF-16
   surrogates with `U+FFFD`, strips ANSI escape sequences, removes the
   ASCII control band (`U+0000`–`U+001F` minus `\t \n`, plus `U+007F`),
   and normalizes `\r\n?` to `\n`.
2. `strip_invisible_chars()` — removes zero-width and direction-control
   codepoints (`U+200B`–`U+200F`, `U+2060`, `U+FEFF`, `U+00AD`) so
   homoglyph and zero-width bypass patterns cannot smuggle directives.
3. `strip_special_tokens()` — replaces ChatML / Llama 3 / Phi / Qwen /
   Gemma role and channel tokens (`<|im_start|>`, `<|tool_call|>`,
   `<end_of_turn>`, `[INST]`, etc.) with the `[TOKEN_REDACTED]` placeholder.
4. `neutralize_prompt_injection()` — applies the rewrite families in
   `PROMPT_INJECTION_PATTERNS` (hidden HTML comments, data exfiltration
   shapes, `ignore_previous`, `reveal_system_prompt`, `bypass_rules`,
   `[SYSTEM]/[USER]/[ASSISTANT]` role markers, etc.). Matches are
   replaced with `[FILTERED_INSTRUCTION]` and the family list is logged
   under event `ai.tools.sanitization.prompt_injection_neutralized`
   along with a SHA-256 prefix and length so operators can audit
   repeated attempts without persisting hostile text.
5. `neutralize_prompt_markers()` (from `prompt_marker_guard.py`) —
   escapes wire-level markers that look like ordinary text:
   the `<!-- CACHE_BOUNDARY -->` marker used by
   `sidecar/ai/context/prompt_cache.py` and the Llama
   `<<SYS>>` / `<</SYS>>` role separators. These are escaped, not
   deleted, so the data remains diagnosable in logs and to the model.
6. `redact_obvious_secrets()` — redacts common credential shapes
   (`sk-…`, `ghp_…`, `AKIA…`, `xox[baprs]-…`, `Bearer …`, generic
   `api_key=…`/`token=…`/`password=…`, JWT triplets) to `[REDACTED]`.
7. `_redact_inline_data_uris()` — replaces large base64 `data:` URIs
   with a `[INLINE_DATA_URI_STRIPPED]` placeholder that records mime
   type and approximate byte size.
8. `_truncate()` — caps the output at `max_chars` (default 4000) with
   a `[truncated]` suffix.

`wrap_untrusted_tool_output()` then wraps the cleaned body in
`<untrusted_tool_output>…</untrusted_tool_output>` boundary tags so the model
sees an explicit trust boundary.

### Pre-dispatch argument scanning

`scan_tool_arguments()` runs the same normalization plus injection-pattern and
secret detection over model-supplied tool arguments **before** the tool is
dispatched. The scan does not mutate the arguments themselves; it returns a
`ToolArgumentScanResult(matched, pattern_families, sanitized_preview)` and
emits `ai.tools.sanitization.tool_arguments_flagged` so the call can be
escalated through the approval pipeline.

### Assistant output sanitization

`sanitize_assistant_output()` is the parallel pipeline applied to assistant
text before it is persisted or shown. It cuts the output at the first leaked
control token, strips `### Tool Call / Analysis / Reasoning / Internal /
Response` post-response analysis blocks, removes leaked
`function_response\n{…}` wrapper scaffolding (logged under
`ai.tools.sanitization.wrapper_scaffolding_stripped`), and finishes with
secret redaction and truncation.

### Personality and workspace text

`sidecar/ai/personality/sanitization.py` applies the same injection-pattern and
marker neutralization, secret redaction, Unicode normalization, and control-
character filtering to the canonical custom flavor and the typed
`context_blocks.kind = "personality"` value. `sidecar/ai/context/messages.py`
sanitizes the latter immediately before trusted-system admission, adds a fixed
user-authored-background wrapper, and omits an empty result. Electron's schema-
v2 compiler caps the complete advanced source block at 4 KiB before transport.

### Wire-marker guarantees

`prompt_marker_guard.py` guarantees:

- **Idempotent.** Running the guard twice produces the same output.
- **Non-destructive.** Markers are escaped, not deleted; the content
  remains diagnosable in logs and to the model.
- **Single-pass O(n).** One linear scan per regex.
- **Strict typing.** Non-`str` input raises `TypeError` so silent drops
  never hide a mismatched pipeline.

### Why this is a defense-in-depth chain, not a single filter

Each pass covers what the previous pass does not:

- Token redaction handles model-specific role tokens.
- Pattern rewrites handle natural-language injection ("ignore previous
  instructions"), HTML-comment-hidden directives, and `[SYSTEM]`-style
  role markers.
- Marker escaping handles wire-level markers that look like ordinary
  text and would slip through both of the above.
- Secret redaction and inline-data-URI stripping reduce the value of
  data exfiltration even if other layers are bypassed.
- The `<untrusted_tool_output>` wrapper sets an explicit trust boundary
  for the model itself.

The model is the last line of defense, not the only one.

### Audit log events

| Event | Source | Triggered when |
|---|---|---|
| `ai.tools.sanitization.prompt_injection_neutralized` | `neutralize_prompt_injection()` | A `PROMPT_INJECTION_PATTERNS` family rewrites tool output |
| `ai.tools.sanitization.tool_arguments_flagged` | `scan_tool_arguments()` | Pre-dispatch scan finds an injection or secret pattern in model-supplied tool arguments |
| `ai.tools.sanitization.wrapper_scaffolding_stripped` | `sanitize_assistant_output()` | A leaked `function_response\n{…}` block is removed from the assistant body |

All three events redact content and emit only family names, content length,
and a 16-char SHA-256 prefix.

### Related code

- `sidecar/ai/tools/sanitization.py` — pipeline entry points, pattern lists, secret regexes.
- `sidecar/ai/tools/prompt_marker_guard.py` — wire-marker escape pass and threat-model docstring.
- `sidecar/ai/context/prompt_cache.py` — `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (the marker the guard protects).
- `sidecar/ai/personality/sanitization.py` — the same defenses for custom flavor and typed advanced personality context.
- `sidecar/runtime/diagnostics.py` — terminal-error and structured-log redaction (key/header-aware) used at the diagnostics edge.
- `SECURITY.md` — supported runtime security policy.

## Python Runtime Threat Model

Last reviewed: 2026-07-12

This document is the ground-truth threat model for the
`python_runtime` tool (`sidecar/ai/tools/builtins/python_runtime/`).
It tells a reviewer what the sandbox is meant to block, what it is
NOT meant to block, and which risks have been explicitly accepted
as out of scope for this layer.

Trust boundary: **the sandbox is a defence-in-depth layer**, not a
primary security perimeter. The primary perimeter is model output
classification plus the user-approval gate: every `python_runtime`
invocation by a non-trusted model path passes through the same tool
approval flow as shell execution. The sandbox is the last line of
defence if the model slips past classification *and* the user
approves a call whose payload turns out to be hostile.

### Layers in play

1. **Tool contract** — `sidecar/ai/tools/builtins/python_runtime/tool.py`
   validates the request (allowed modes, size caps, workspace root
   presence) before dispatch.
2. **Interpreter bootstrap** — `interpreter.py` ensures the venv
   exists under `{userData}/python-runtime/.venv` and is owned
   exclusively by Jenny. No user-writable `PYTHONPATH` injection.
3. **Sandbox** — this document. Enforces resource limits and
   process-group containment on the child process.
4. **Exec wrapper** — `_exec_wrapper.py` runs the user script inside
   a subprocess with minimal env and captures stdout/stderr/result
   payload for reporting.
5. **Output filter** — `output.py` truncates stdout, stderr, and
   matplotlib image output before the result ever reaches the model.

### What the sandbox blocks

#### Resource exhaustion

| Limit | Windows | POSIX |
|---|---|---|
| Max child processes | Job Object `JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 5` | Not directly capped; rlimits mitigate tree escape |
| Memory (resident) | Job Object `JOB_OBJECT_LIMIT_PROCESS_MEMORY` **and** aggregate `JOB_OBJECT_LIMIT_JOB_MEMORY` = `memory_limit_mb × 1MB` | `RLIMIT_AS` = same value |
| CPU time | Parent polling deadline | `RLIMIT_CPU` = `timeout_seconds + 5s` grace |
| Wall-clock timeout | Concurrent bounded stdout/stderr readers plus process polling; Job closes on timeout | Same + `RLIMIT_CPU` backstop |
| File-descriptor count | Windows default | `RLIMIT_NOFILE = 256` |
| Core dumps | N/A | `RLIMIT_CORE = 0` (disabled) |

#### Lifetime containment

- **Windows**: the Job Object flag
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` guarantees every child and
  grandchild is killed when the Job Object handle is released,
  including on sidecar exit via `atexit`.
- **POSIX**: `preexec_fn` calls `os.setsid()` so the child starts a
  fresh session/process-group. If the tool execution is cancelled or
  times out, `killpg(-pgid, SIGKILL)` cleans up the whole tree; the
  parent-death signal on Linux is not used, so Mac/Linux parity holds.

#### stdout/stderr/output filesystem posture

- Work directory is an ephemeral `tempfile.mkdtemp(prefix="jenny-pyexec-")`.
  Cleaned on every exit path (success, exception, timeout).
- `env` is rebuilt from a minimal allowlist: `PATH` (venv + System32
  on Windows), `SYSTEMROOT`, `TEMP`, `TMP`, `JENNY_OUTPUT_DIR`,
  `MPLCONFIGDIR`, `VIRTUAL_ENV`. No inherited parent env.
- Wrapper stdout/stderr pipes are drained concurrently and retain at most
  512 KiB aggregate. Overflow terminates the owned process instead of buffering
  to completion; the versioned result JSON is stat/read/decode bounded to 4 MiB.
- `_exec_wrapper.py` caps child capture at 512 KiB per stdout/stderr stream,
  figures at four / 16 million pixels each, and table materialization at eight
  tables, 50 rows, 32 columns, 512 characters per cell, 100,000 characters per
  table, and 500,000 characters aggregate. Expression, error, and traceback
  fields have separate bounded text limits.
- Parent output admission rechecks image/table counts and bytes before reading
  or parsing artifacts. Scratch-cleanup failure emits a structured degradation
  warning and never replaces an otherwise successful tool result.

### What the sandbox does NOT block

These are **accepted risks** given the trust model: Jenny is a
single-user local app; the approval gate is the primary enforcement
point.

#### Arbitrary Python

- The exec wrapper runs user code with full `__builtins__`. `import
  os`, `import subprocess`, `import socket` all work. AST-level
  denylists are intentionally not attempted (`ast.parse` denylists
  are trivial to bypass with `getattr(__builtins__, '__' + 'import'
  + '__')`).
- Impact: a hostile payload can call `os.system`, spawn
  `subprocess.Popen`, open sockets. The resource limits bound
  the blast radius (CPU, memory, fd count, kill-on-parent-exit).

#### Filesystem read outside workspace

- The subprocess runs with `cwd=work_dir`, but has no jail. It can
  `open('/etc/passwd')` or `open(r'C:\Users\...')`.
- Impact: a hostile payload can exfiltrate files it can read as the
  Jenny user. Mitigation layer: output size cap in `output.py`
  limits what the model sees; tool approval gate limits when the
  payload runs at all.

#### Network

- The subprocess inherits the parent's network namespace. Outbound
  HTTP/DNS/raw sockets work.
- Impact: the model can exfiltrate data by making HTTP requests. No
  URL allowlist; no DNS sinkhole. Acceptable because any approved
  `python_runtime` call implicitly already has equivalent authority
  via `curl` through the shell tool with approval.

#### Encoded payload detection

- The sandbox does not attempt to detect obfuscated payloads
  (e.g. base64-decoded code, AST-rewritten code, dynamically
  imported modules). Detection happens at the shell classifier for
  shell-facing decoders; equivalent payload forms inside
  `python_runtime` pass through.
- Mitigation: the tool approval gate forces a human decision on
  every invocation.

#### AST / bytecode restriction

- No RestrictedPython, no `compile()` filter, no bytecode audit.
  `eval`, `exec`, `compile`, `__import__` all present.

#### chroot / container

- No chroot, no container, no sandboxed interpreter. Windows Job
  Objects provide the closest thing to a container on that
  platform; POSIX relies on rlimits + setsid.

### Deferred / follow-up items

Tracked in `BACKEND_PROMPT_LIFECYCLE_REVIEW.md` Bundle 5B / 5E.

- **Network namespace isolation** — would require launching the
  child inside a Linux network namespace or blocking outbound on
  Windows via firewall rules. Out of scope for this pass; the
  approval gate is the current mitigation.
- **Filesystem jail** — bind-mount or `os.chroot` (POSIX); mandatory
  integrity control (Windows). Neither is cheap for a local app;
  deferred.
- **AST-level allowlist** — requires forking the interpreter
  (RestrictedPython) or a bytecode audit. Adds significant
  complexity for marginal safety gain given the approval gate.
- **atexit sweep on sidecar crash** — Windows Job Object handles
  this already; on POSIX the setsid group is orphaned but Jenny's
  main process exit will not auto-kill it. Tracked in review-doc
  finding O12 (cross-platform orphan sweep).

### When to revisit

- A new execution mode (e.g. a non-interactive batch mode that
  skips approval) lands. The sandbox becomes the *primary*
  perimeter and this document must be revised before that ships.
- A CVE surfaces in any of: the venv interpreter, matplotlib
  (rendering surface via `MPLCONFIGDIR`), or the tempfile path
  cleanup.
- Platform parity drifts (e.g. Ollama or vLLM Electron-side
  Windows Job Object wrapping lands as part of Bundle 5E — a
  similar preexec_fn / setsid pattern may become the right
  POSIX baseline for those managers too).
