# Security Policy

Jenny is a local-first desktop companion. The active runtime is Electron plus a
Python sidecar connected by JSON-RPC over stdio; cloud engine integrations are
archived unless a new integration plan restores them.

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

- Electron owns persistence and secrets; API keys must not be stored in sidecar
  config or environment variables.
- Electron and Python communicate only through JSON-RPC over stdio.
- Sidecar code under `sidecar/ai/` must not import Electron or renderer code.
- MCP stdio servers run with minimal environment/cwd containment, bounded
  process/memory/file limits, and process-tree cleanup.
- External MCP tool names are namespaced as `mcp__<server>__<tool>`; Jenny
  builtins and synthetic tools keep their existing names and win reserved-name
  collisions.

## Tool Safety

- Shell command classification is fail-closed. Unknown commands, interpreters,
  package managers, compilers, fetchers, `patch`, `tee`, and ambiguous Git
  subcommands require approval.
- `safety_mode` supports `normal`, `strict`, and `paranoid`. `strict` disables
  web/network tool families; `paranoid` requires approval for model-visible
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

## Known Follow-Up Areas

Planned hardening that extends the current posture (tracked, not yet done):

- Server-binary signature verification for external MCP runtimes
  (sigstore / cosign / Authenticode).
- Broader fuzzing for sanitizer and shell-classifier inputs.
- Per-surface threat-model documents (shell, web, filesystem, MCP, approval)
  to complement the existing Python-runtime threat model.
- Authenticode code signing for the Windows installer (releases currently
  ship unsigned with SHA-256 asset manifests published per release).
