---
kind: operations-doc
last_reviewed: 2026-11-24
status: active
---

# Strata engine (managed, Windows)

Jenny can run Inkling 2 Mini through the owner's own Strata install (roadmap row 200,
plan). Strata is an optional local engine: off until the owner picks the model,
nothing at startup or in chat when unused, and `JENNY_ENABLE_STRATA=0` turns it off entirely (no probe, no IPC data,
no Settings row). Windows only.

## Install (the owner's, never Jenny's)

Jenny never installs Strata and never downloads its files. Strata's installer pipes a remote script into PowerShell
and its first launch fetches unsigned engine builds, which agents do not run (plan decision D1).

1. Install Strata from its release page (github.com, `Niko1221/Strata`). Jenny was checked with release **v0.2.21**
   (commit `d46f5f268f8ed797e83a5c63a69bffbd7a581cf6`): the Terminal and the `strata-inkling` engine at **0.1.67**.
2. In a terminal, run once: `strata launch --family inkling-2-mini --model SQ-20`. It downloads the packs (about
   20 GB) and writes the setup config Jenny reads.
3. In Jenny: Settings › Models › Engines and providers › Strata › Check again.

Jenny looks in `%LOCALAPPDATA%\Strata`: the Terminal under `terminal\<version>` (the `terminal\current` junction is
read only for its target), the engine under `components\shapes\inkling2\engine\<version>-windows-x86_64-<backend>`,
and Setup's config at `install\strata-inkling-2-mini-sq-20.json`. Any other link or junction is refused. A Terminal
version other than 0.1.67 is a warning, not a refusal.

## Pins

`config/strata-packs.json` pins the release, the Terminal and engine versions, and the packs from
`strata-engine/Inkling-2-Mini-Strata` at revision `04996a1e2c45009b6a04f2af126cb6bdb2ba3587`:

| Pack | Bytes | sha256 |
|---|---|---|
| `Inkling-2-Mini-SQ-20.strata` | 19,346,685,952 | `0bbfd52344f0dd4779a7807b5f73554a812f24c035e6877b63cd0d499f7e1b97` |
| `Inkling-2-Mini-Vision.strata` | 636,526,592 | `6589eff47f9c20bc3a032faa3d449f10bf4f04a84cc6b2ee8a44d51d2b6fc677` |

Each pack is hashed once in a worker thread (byte progress shows on the Models page); a receipt keyed by path, size
and modified time skips the hash on later starts. Check the packs again (Re-verify) forces it. A failed vision pack
turns images off; a failed SQ-20 pack refuses to start.

## How Jenny runs it

- Jenny spawns the Terminal's own Python: `-m serve.server --engine strata --config <Jenny's config> --port 8035
  --parallel <1|2|4> --offline --ready-file <fresh path> --api-key <per-launch key>`, loopback only. Never `--lazy`,
  `--idle-unload`, `--access` or a non-loopback host.
- The engine config keeps only `exe`, `cwd`, `tokenizer` and `model_name` from Setup's config (each validated inside
  the Strata root); `args` are rebuilt from Jenny's allowlist (the verified packs, `--max-context` at or under the
  measured VRAM fit, the KV format, vision, `--vram-experts-gb`/`--ram-experts-gb` from Setup), and drafting is
  `off` unless the Tune drawer turns DSpark on.
- The key is random per launch, last on argv, never in the config, a file, a log or the renderer (decision D4's
  accepted residual: a same-user process can read argv). Every `STRATA_*` variable is removed from the child's
  environment.
- GPU: one managed server at a time, ranked llama-server < NInfer < Strata; the free-VRAM preflight runs before each
  launch (a default 4 x k8v8 start needs about 31.7 GB).
- Stop: `POST /unload?wait=1` (best effort), then the owned PID, then a tree kill of that PID; the record clears only
  on a confirmed exit of both the server and its engine child.

## Logs and files

All under Jenny's userData folder (removed by uninstall):

| What | Where |
|---|---|
| Jenny's events (`strata.runtime.*`, `strata.server.*`, `strata.ipc_*`) | `logs\shell.log` |
| Strata's own server log | `strata\logs\strata-server.log` |
| Engine config and ready file (one per launch, stale ones deleted before a start) | `strata\run\strata-engine.json`, `strata\run\ready-<16 hex>.json` |
| PID record (identity-checked; reaped at the next start if Jenny crashed) | `strata-serve.pid` |
| Pack receipts | `strata\pack-receipts.json` |
| Saved settings (slots, KV, context, vision, drafting, watchdog) | the shell config, `localEngines.strata` |

## Residuals (accepted, recorded in the plan)

- **The page at `/`.** Strata's server serves its own web page at `/` without asking for the key; its chat and model
  routes still require it. Any local process or browser on this PC can load that page while Jenny's Strata runs.
- **The route token.** `X-Jenny-Route-Token` goes to every call of the openai-compatible engine whose base URL is a
  loopback IP literal, so a managed Strata on `127.0.0.1` receives it, as a user-run llama-server does today. It is an
  opaque per-request token meant for the team engine port.
- **Shared Strata state.** Strata has no data-dir switch, so Jenny's server shares the owner's per-user Strata state.
  While it runs, Strata's own `strata update` and `strata calibrate` are refused by its activity lease, and Strata may
  end leftover engines its own install recorded.
- **Parent loss.** Without Strata's owner-fd channel (decision D8 A), a crashed Jenny leaves the server and engine
  holding VRAM until the next Jenny start reaps its own PID record.
- **Smart App Control.** Strata's engine binary is unsigned; Windows may block it. Jenny names the block and points at
  the Windows setting; it never works around it.
