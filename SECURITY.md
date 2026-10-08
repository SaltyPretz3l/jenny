# Security Policy

Jenny is a local-first AI harness. Desktop uses Electron plus a Python sidecar
connected by JSON-RPC over stdio. Optional ChatGPT sign-in and Codex CLI routes
send inference requests to cloud providers. Experimental browser hosting uses
an authenticated headless Node host and the same application-service owners.

## Supported Versions

Security hardening applies to the current `main` development line and release
branches cut from it. Older local-only snapshots are not supported unless a
maintainer explicitly marks them as a release branch.

## Reporting

Please report suspected vulnerabilities **privately**, before opening a public
issue, using GitHub's private vulnerability reporting: open the repository's
**Security** tab → **Report a vulnerability**
(<https://github.com/SaltyPretz3l/jenny/security/advisories/new>). If private
reporting is not enabled, contact the maintainer through the repository's GitHub
profile rather than filing a public issue. Include:

- affected commit or release version
- operating system
- reproduction steps
- expected impact
- logs or diagnostic excerpts with secrets removed

Do not include live credentials, private keys, or full user data in reports.

Response expectation: Jenny is solo-maintained. Reports are acknowledged on a
best-effort basis — typically within two weeks — and security reports are
prioritized over ordinary issues. There is no bug bounty.

## Runtime Boundaries

- Electron owns desktop persistence, consent and safeStorage-backed secrets;
  API keys must not be stored in sidecar config or environment variables.
  Conversation JSON files are not encrypted by safeStorage.
- ChatGPT uses Jenny's own OAuth flow. Tokens stay in the secure store and pass
  only to the sidecar and ChatGPT backend, never the renderer or logs. Codex CLI
  uses its own login; Jenny never reads or copies the CLI's credential file.
- Hosted profiles have one exclusive writer. Hosted credentials come from
  explicitly mounted secret files outside profile/workspace roots; see
  [hosting boundaries](docs/operations/HOSTED_EXECUTION.md).
- Application host and sidecar communicate through JSON-RPC over stdio. Browser
  access uses authenticated, schema-validated HTTP/SSE service operations.
- Sidecar code under `sidecar/ai/` must not import Electron or renderer code.
- MCP stdio servers run with minimal environment/cwd containment, bounded
  process/memory/file limits, and process-tree cleanup.
- External MCP tool names are namespaced as `mcp__<server>__<tool>`; Jenny
  builtins and synthetic tools keep their existing names and win reserved-name
  collisions. Third-party MCP is unavailable in hosted and desktop command
  sandbox modes.
- There is no plugin platform: no plugin install, store, signing, or plugin
  views. Extensions are skill folders and standalone MCP servers; MCP servers
  are reviewed and approved per configuration before their tools are used.

## Tool Safety

- Shell command classification is fail-closed. Unknown commands, interpreters,
  package managers, compilers, fetchers, `patch`, `tee`, and ambiguous Git
  subcommands require approval.
- `safety_mode` supports `normal`, `strict`, and `paranoid`. `strict` disables
  web search and browsing; `paranoid` requires approval for model-visible
  tool calls.
- Tool outputs and pre-dispatch tool arguments are scanned for prompt-injection
  directives and common credential shapes before model reuse or diagnostics;
  argument-scan log events use pattern families, length, and content hashes
  rather than persisting argument previews.
- Web search metadata and HTML fallbacks reject private, loopback,
  credentialed, non-http(s), and local-control-plane URLs.

## Defense-In-Depth Checks

Targeted policy checks live under `scripts/checks/`, including
`check_phase3_security_invariants.py`, `check_boundary.py`,
`check_no_os_getenv.py`, `check_no_secrets.py`, and `check_import_fanout.py`.
Full local CI remains a manual maintainer gate.

## Qualification and follow-up

NEXT_STEPS.md owns current release gates and priorities.
Source integration does not establish installed-app, real-device or live-provider
qualification. The following limits are not security guarantees:

- Server-binary signature verification for external MCP runtimes
  (sigstore / cosign / Authenticode).
- Sanitizer and shell-classifier checks have bounded test coverage; they do
  not establish exhaustive fuzzing or prevent every prompt-injection attempt.
- Native desktop commands and third-party MCP subprocess containment is not
  filesystem/network isolation. Optional Docker commands run offline in a
  disposable workspace copy; their file changes are discarded.
- Authenticode code signing for the Windows installer (releases currently
  ship unsigned with SHA-256 asset manifests published per release).
