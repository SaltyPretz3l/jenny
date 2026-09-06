# Full-host session providers (V6)

A `session_provider` is a native executable Jenny launches and supervises. It is the highest-trust tier and is reachable only with `runtime.full_host`, the `privileged_plugins` gate enabled, and high-consequence consent. Jenny's official local-image-generation package uses this tier, but its source package is not included in the public repository.

## Host protocol

Authority: `config/plugins/v1/plugin-host-protocol.schema.json` (frozen, version 1).

- Channels: `invocation`, `secret`, `control`.
- Methods: `invoke`, `cancel`, `stream_ack`, `secret_channel_open`, `host_attest`, `host_shutdown`.
- Your host answers `describe` side-effect free, then handles `invoke`, `status`, and `cancel` as quick calls while long work stays asynchronous behind an operation id with progress frames.
- Every frame is fenced by logical-session incarnation and revision, plugin generation, native host session and epoch, and operation id, attempt, and frame sequence. Replaying an old frame is rejected.

## Lifecycle, leases, and cleanup

- Jenny owns the idle timer and a one-hour absolute lease by default; only the official local-image-generation workload receives the five-hour `gpu_image_v1` lease. Each call refreshes idle but never extends the lease. Design the host so that being stopped at any moment is normal: persist what must survive, and make reopen cheap.
- Every terminal path ends with Jenny terminating the supervised process tree. Jenny releases resources only after a `tree_empty` receipt. If tree death cannot be proven, the operation stays `cleanup_pending` and later privileged work is refused until reconciliation. Do not spawn detached grandchildren.
- Containment profile (`windows_job_supervised_v1` on Windows) bounds process count, memory, CPU, and lease. Peak measurements below 80 percent of the profile caps are a release gate.

## Data and files

- Retained data goes under a documented root (the image plugin uses `~/.companion/image-gen`). Uninstall preserves it; a separate explicit action removes it.
- Files cross into Jenny through a scratch directory with resolved-path containment, regular-file checks, size ceilings, format validation, digest verification, and atomic publication.

## Secrets

Only with `secret_delivery: true` and a one-shot, destination-bound grant over the dedicated secret channel. Most hosts should not request it.

## Native MCP alongside a host

A V6 native MCP contribution can expose the same binary as an MCP stdio server so Jenny's agent gets tools. It is generation-owned, never written into user-authored `mcp_servers`, and every tool call re-checks generation, consent, schema, and arguments.

Still thin in this public guide: full framing transcripts, an exact `describe` payload, platform-specific containment guidance, and a complete attestation example.
